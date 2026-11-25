//! Barge-in: is the user talking over Vera?
//!
//! Two signals come out of the echo canceller. AEC3's *suppressed* output
//! sits at the room's noise floor while only Vera's echo is in the room and
//! rises 25 to 45 dB within ~60 ms of the user starting to talk (AEC3's own
//! near-end detection lets the user through). The *linear* output holds the
//! user's voice intact plus a residual of Vera's that follows her level;
//! it catches the user where AEC3's suppressor is still holding back (a
//! headset, a cold start). A 4 ms block is a *candidate* when the
//! suppressed output clears its floor by `SUPPRESSED_MARGIN_DB`, or the
//! linear output clears both its floor and the residual Vera's recent
//! playback explains (her reference envelope plus the leak this room has
//! shown, learned from echo-only stretches). Enough candidates in a row
//! make a *suspicion*: Vera ducks by 20 dB at once.
//!
//! The duck is also the test. Echo falls with it once the ducked audio has
//! come back through the room (the canceller's delay estimate says when);
//! the user doesn't. A suspicion is confirmed when, after the duck took
//! effect, the bands still show the user (their bounds hold Vera's level
//! through her reverberation, then fall, so a quiet user shows up as they
//! do), the loudest 20 ms since the duck has not fallen with Vera, and the
//! speech detector hears speech in the cleanest audio there is (the
//! suppressed output before the duck took effect, the linear one after).
//! AEC3's suppressed output only ever triggers a duck: it can let Vera's
//! ducked echo through, so it never confirms one. A confirmation is a barge-in: playback stops.
//! Anything else restores the volume and teaches the detector what it just
//! saw (Vera's leak, or the room's noise), so the same thing doesn't duck
//! twice.
//!
//! Timing in the simulator: the duck lands about 100 ms after the user
//! starts, the barge-in about 250 to 300 ms after.

use std::collections::VecDeque;

use super::align::{BLOCK, RATE};
use super::bands::Bands;
use super::mixer::DUCK_GAIN;

/// Blocks per 20 ms smoothing window.
const SMOOTH: usize = 5;
/// The trigger window and how many of its blocks must be candidates.
const TRIGGER_WINDOW: usize = 15;
const TRIGGER_COUNT: usize = 10;
/// The suppressed output must clear its floor by this much.
const SUPPRESSED_MARGIN_DB: f32 = 15.0;
/// The linear output must clear its noise floor by this much...
const FLOOR_MARGIN_DB: f32 = 9.0;
/// ...and the explained residual by this much.
const LEAK_MARGIN_DB: f32 = 10.0;
/// How long after Vera's audio its echo can still be heard, in blocks
/// (300 ms), on top of the canceller's delay.
const TAIL_BLOCKS: usize = 75;
/// Program envelope above which output counts as active.
const ACTIVE_DB: f32 = -80.0;
/// Blocks after the duck shows in the reference before the probe starts,
/// on top of the canceller's delay: the ramp and the room's early echo.
const PROBE_SETTLE: usize = 6;
/// Blocks with the user in the bands the probe needs, and the most blocks
/// it may take: long enough for the bands' bounds to fall after the duck
/// (160 ms of hold, then 75 dB/s) under a user quieter than Vera's echo.
const PROBE_COUNT: usize = 10;
/// Up to 800 ms: a short first word ("Wait,") and the pause after it keep
/// Vera ducked until the user's next word confirms.
const PROBE_LIMIT: usize = 200;
/// The speech detector saying no this many times ends the probe.
const REFUSALS: usize = 3;
/// Blocks into the probe after which plain echo ends it.
const PROBE_EARLY: usize = 20;
/// How long the bands hold Vera's level after a duck, in blocks.
const HOLD_BLOCKS: usize = 40;
/// A confirmation this soon after a rejected suspicion means the user had
/// already started then (blocks, 600 ms).
const CHAIN_BLOCKS: u64 = 150;
/// Echo falls by the duck's 20 dB; the loudest 20 ms of the user's voice
/// since the duck falls by less than this.
const PROBE_MAX_DROP_DB: f32 = 12.0;
/// If the duck never shows in the reference (nothing was playing), the
/// probe starts this many blocks after the suspicion anyway.
const DUCK_SEEN_TIMEOUT: usize = 50;
/// The leak starts conservative (10 dB louder than Vera's own level: a
/// cold canceller next to loud speakers) and is the 95th percentile of what
/// echo-only blocks showed over the last 2 s.
const LEAK_INITIAL_DB: f32 = 10.0;
const LEAK_HISTORY: usize = 100;
const LEAK_EVERY: usize = 5;
/// The canceller counts as converged once its delay estimate has held
/// (within 8 ms) for 1 s of Vera's audio. Until then (her first second
/// ever, or after the echo path changed) nothing is confirmed and nothing
/// is learned: an unconverged canceller hasn't removed her echo at all.
const CONVERGED_BLOCKS: usize = 250;
/// The canceller counts as cancelling when its linear output is this much
/// (give or take 2 dB of hysteresis) under the raw microphone where Vera
/// alone is audible, averaged over ~1 s. With no audible echo at all (a
/// headset) it stays as it starts: cancelling.
const LOCKED_ERLE_DB: f32 = 6.0;
const ECHO_AVERAGE: f32 = 1.0 / 250.0;
const DELAY_TOLERANCE_MS: i32 = 8;
/// After a rejected suspicion, this long before the next.
const REFRACTORY_BLOCKS: usize = 25;
/// Audio kept for the speech check (2 s).
const KEEP_BLOCKS: usize = 500;
/// The speech check reaches this far before the suspicion's first block.
const CHECK_LEAD_BLOCKS: usize = 25;
/// Noise floors: the 10th percentile of the last 2 s of 20 ms levels,
/// recomputed every 100 ms, never below digital silence's -96 dBFS.
const FLOOR_HISTORY: usize = 500;
const FLOOR_EVERY: u64 = 25;
const FLOOR_INITIAL_DB: f32 = -70.0;
const FLOOR_LOWEST_DB: f32 = -96.0;
/// A floor raised under steady noise falls back 3 dB/s.
const FLOOR_RAISE_DECAY_DB: f32 = 3.0 * BLOCK as f32 / RATE as f32;
/// While the energy says "user", the speech detector is asked again this
/// often until the probe ends.
const CHECK_EVERY: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    /// Duck Vera now: the user may be talking.
    Duck,
    /// A false alarm: restore Vera's volume.
    Restore,
    /// The user is talking: a barge-in. Its speech began around `onset`
    /// (a block index): the first block of this suspicion, or of a false
    /// alarm just before it that the user's voice had already started.
    Confirm { onset: u64 },
}

/// What one block looked like, for logs and the simulator.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Probe {
    pub linear_db: f32,
    pub suppressed_db: f32,
    /// What the linear output had to clear.
    pub bound_db: f32,
    pub suppressed_hit: bool,
    pub linear_hit: bool,
    /// Bands of the linear output that cleared their bounds.
    pub band_hits: usize,
    pub active: bool,
}

impl Probe {
    pub(crate) fn candidate(&self) -> bool {
        self.suppressed_hit || self.linear_hit
    }
}

#[derive(Clone, Copy, Debug)]
enum State {
    Idle,
    Watching { refractory: usize },
    Suspect(Suspicion),
    Confirmed { quiet: usize },
}

#[derive(Clone, Copy, Debug)]
struct Suspicion {
    first: u64,
    ducked_at: u64,
    /// The linear output against Vera's reference envelope when it
    /// triggered, dB.
    ratio: f32,
    /// Whether the suppressed output triggered it (else the linear did):
    /// the drop test then reads that output.
    by_suppressed: bool,
    /// Mean level of that output over the trigger window, dB.
    before_db: f32,
    duck_seen: Option<u64>,
    probed: usize,
    hits: usize,
    /// The loudest and quietest 20 ms of that output since the probe
    /// began, dB.
    after_db: f32,
    after_min_db: f32,
    /// When (in probe blocks) the speech detector was last asked, and
    /// whether it ever said no.
    checked_at: Option<usize>,
    speech_refused: bool,
    refusals: usize,
}

pub(crate) struct Detector {
    block: u64,
    state: State,
    /// Per-block energies.
    linear: VecDeque<f32>,
    suppressed: VecDeque<f32>,
    reference: VecDeque<f32>,
    program: VecDeque<f32>,
    hits: VecDeque<(bool, bool)>,
    /// Audio for the speech check.
    linear_audio: VecDeque<f32>,
    suppressed_audio: VecDeque<f32>,
    floor: Floor,
    suppressed_floor: Floor,
    bands: Bands,
    leak: VecDeque<f32>,
    leak_db: f32,
    /// Ratios seen while watching, kept until it is known they were echo.
    recent_ratios: VecDeque<f32>,
    /// The canceller's last delay estimate, and how many active blocks it
    /// has held.
    delay_ms: i32,
    delay_held: usize,
    /// The first block of the last rejected suspicion, and when it ended:
    /// if the user's voice is confirmed soon after, it began there.
    rejected: Option<(u64, u64)>,
    /// Raw microphone and linear output, averaged over the blocks where
    /// Vera's echo is audible: whether the canceller is cancelling.
    echo_microphone: f32,
    echo_linear: f32,
    microphone_floor: Floor,
    /// Whether the canceller is cancelling (with 4 dB of hysteresis).
    locked: bool,
    enabled: bool,
}

/// The canceller's view of one block.
pub(crate) struct Block<'a> {
    /// The raw microphone, before cancellation.
    pub microphone: &'a [f32],
    pub linear: &'a [f32],
    pub suppressed: &'a [f32],
    pub reference: &'a [f32],
    /// The duck gain the reference carried (1 when not ducked).
    pub duck: f32,
    /// The canceller's delay estimate, in ms.
    pub delay_ms: i32,
}

fn energy(samples: &[f32]) -> f32 {
    samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32
}

fn db(energy: f32) -> f32 {
    10.0 * (energy + 1e-12).log10()
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector {
    pub(crate) fn new() -> Self {
        Self {
            block: 0,
            state: State::Idle,
            linear: VecDeque::new(),
            suppressed: VecDeque::new(),
            reference: VecDeque::new(),
            program: VecDeque::new(),
            hits: VecDeque::new(),
            linear_audio: VecDeque::new(),
            suppressed_audio: VecDeque::new(),
            floor: Floor::default(),
            suppressed_floor: Floor::default(),
            bands: Bands::new(),
            leak: VecDeque::new(),
            leak_db: LEAK_INITIAL_DB,
            recent_ratios: VecDeque::new(),
            delay_ms: -1_000,
            delay_held: 0,
            rejected: None,
            echo_microphone: 0.0,
            echo_linear: 0.0,
            microphone_floor: Floor::default(),
            locked: true,
            enabled: true,
        }
    }

    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Whether Vera's audio is (still) in the room, echo tail included.
    pub(crate) fn active(&self) -> bool {
        !matches!(self.state, State::Idle)
    }

    /// Whether a suspicion is being probed.
    pub(crate) fn suspecting(&self) -> bool {
        matches!(self.state, State::Suspect(_))
    }

    /// Whether the echo canceller has settled (see `CONVERGED_BLOCKS`).
    pub(crate) fn converged(&self) -> bool {
        self.delay_held >= CONVERGED_BLOCKS
    }

    /// Whether the current stretch of output was barged into.
    pub(crate) fn confirmed(&self) -> bool {
        matches!(self.state, State::Confirmed { .. })
    }

    /// The block index the next [`push`](Self::push) gets.
    pub(crate) fn position(&self) -> u64 {
        self.block
    }

    /// Mean of the last `count` entries of `values`.
    fn mean(values: &VecDeque<f32>, count: usize) -> f32 {
        let len = values.len();
        let start = len.saturating_sub(count);
        if len == start {
            return 0.0;
        }
        values.range(start..len).sum::<f32>() / (len - start) as f32
    }

    /// The loudest 20 ms of `values` between `delay` and `delay + TAIL`
    /// blocks ago: the playback the current block's echo can come from.
    fn envelope(values: &VecDeque<f32>, delay: usize) -> f32 {
        let len = values.len();
        let newest = len.saturating_sub(delay.saturating_sub(2));
        let oldest = len.saturating_sub(delay + TAIL_BLOCKS);
        let mut peak = 0.0f32;
        let mut index = oldest;
        while index < newest {
            let end = (index + SMOOTH).min(newest);
            let mean = values.range(index..end).sum::<f32>() / (end - index) as f32;
            peak = peak.max(mean);
            index += 1;
        }
        peak
    }

    /// One block; returns what to do, and what it saw. `speech` asks the
    /// speech detector about 16 kHz audio (`None`: unknown).
    pub(crate) fn push(
        &mut self,
        block: &Block<'_>,
        speech: &mut dyn FnMut(&[f32]) -> Option<bool>,
    ) -> (Option<Action>, Probe) {
        let reference = energy(block.reference);
        let duck = block.duck.clamp(DUCK_GAIN * 0.5, 1.0);
        push_capped(&mut self.linear, energy(block.linear), KEEP_BLOCKS);
        push_capped(&mut self.suppressed, energy(block.suppressed), KEEP_BLOCKS);
        push_capped(&mut self.reference, reference, KEEP_BLOCKS);
        push_capped(&mut self.program, reference / (duck * duck), KEEP_BLOCKS);
        for (ring, audio) in [
            (&mut self.linear_audio, block.linear),
            (&mut self.suppressed_audio, block.suppressed),
        ] {
            ring.extend(audio);
            let excess = ring.len().saturating_sub(KEEP_BLOCKS * BLOCK);
            ring.drain(..excess);
        }
        let index = self.block;
        self.block += 1;

        let delay = (block.delay_ms.max(0) as usize * RATE as usize / 1_000) / BLOCK;
        let linear_db = db(Self::mean(&self.linear, SMOOTH));
        let suppressed_db = db(Self::mean(&self.suppressed, SMOOTH));
        let reference_db = db(Self::envelope(&self.reference, delay));
        let program_db = db(Self::envelope(&self.program, delay));
        let active = program_db > ACTIVE_DB;
        if (block.delay_ms - self.delay_ms).abs() > DELAY_TOLERANCE_MS {
            self.delay_ms = block.delay_ms;
            self.delay_held = 0;
        } else if active {
            self.delay_held += 1;
        }
        self.floor.push(linear_db, index);
        self.suppressed_floor.push(suppressed_db, index);
        // Is the canceller cancelling? Over blocks where the raw
        // microphone is well above its own floor while Vera plays.
        let microphone = energy(block.microphone);
        let microphone_db = db(microphone);
        self.microphone_floor.push(microphone_db, index);
        // Only while nobody is suspected of talking: the user's voice
        // isn't Vera's echo, and the canceller can't remove it.
        if active
            && matches!(self.state, State::Watching { .. })
            && microphone_db > self.microphone_floor.db() + 10.0
        {
            self.echo_microphone += (microphone - self.echo_microphone) * ECHO_AVERAGE;
            self.echo_linear += (energy(block.linear) - self.echo_linear) * ECHO_AVERAGE;
            let erle = db(self.echo_microphone) - db(self.echo_linear);
            if erle >= LOCKED_ERLE_DB + 2.0 {
                self.locked = true;
            } else if erle < LOCKED_ERLE_DB - 2.0 {
                self.locked = false;
            }
        }

        let echo_only = matches!(self.state, State::Watching { .. })
            && reference_db > self.floor.db() + 6.0
            && self.converged();
        self.bands
            .push(block.linear, block.reference, delay * BLOCK, echo_only);
        let bands = self.bands.latest();
        let bound_db =
            (self.floor.db() + FLOOR_MARGIN_DB).max(reference_db + self.leak_db + LEAK_MARGIN_DB);
        let probe = Probe {
            linear_db,
            suppressed_db,
            bound_db,
            suppressed_hit: suppressed_db > self.suppressed_floor.db() + SUPPRESSED_MARGIN_DB,
            linear_hit: bands.user(),
            band_hits: bands.hits,
            active,
        };
        push_capped(
            &mut self.hits,
            // An unlocked canceller's linear output still holds Vera's echo:
            // only the suppressed output may raise a suspicion then.
            (probe.suppressed_hit, probe.linear_hit && self.locked),
            TRIGGER_WINDOW,
        );

        if !self.enabled {
            self.state = if active {
                State::Watching { refractory: 0 }
            } else {
                State::Idle
            };
            return (None, probe);
        }

        let action = match self.state {
            State::Idle | State::Watching { .. } if !active => {
                self.state = State::Idle;
                self.recent_ratios.clear();
                None
            }
            State::Idle => {
                self.state = State::Watching { refractory: 0 };
                None
            }
            State::Watching { refractory } => self.watch(index, refractory, &probe, reference_db),
            State::Suspect(suspicion) => self.probe(
                suspicion,
                index,
                delay,
                block.duck,
                reference_db,
                &probe,
                speech,
            ),
            State::Confirmed { quiet } => {
                self.recent_ratios.clear();
                let quiet = if active { 0 } else { quiet + 1 };
                self.state = if quiet > TAIL_BLOCKS {
                    State::Idle
                } else {
                    State::Confirmed { quiet }
                };
                None
            }
        };
        (action, probe)
    }

    fn watch(
        &mut self,
        index: u64,
        refractory: usize,
        probe: &Probe,
        reference_db: f32,
    ) -> Option<Action> {
        self.state = State::Watching {
            refractory: refractory.saturating_sub(1),
        };
        // Echo-only stretches teach the leak, once it is clear they were
        // not the start of the user's voice.
        if index.is_multiple_of(LEAK_EVERY as u64)
            && reference_db > self.floor.db() + 6.0
            && self.converged()
        {
            push_capped(&mut self.recent_ratios, probe.linear_db - reference_db, 8);
            if !probe.candidate() && self.recent_ratios.len() == 8 {
                let settled = self.recent_ratios.pop_front().expect("full");
                self.learn(settled);
            }
        }
        let count = self.hits.iter().filter(|(a, b)| *a || *b).count();
        if refractory > 0 || count < TRIGGER_COUNT {
            return None;
        }
        let by_suppressed = self.hits.iter().filter(|(a, _)| *a).count() >= TRIGGER_COUNT / 2;
        let window = if by_suppressed {
            &self.suppressed
        } else {
            &self.linear
        };
        self.state = State::Suspect(Suspicion {
            first: (index + 1).saturating_sub(TRIGGER_WINDOW as u64),
            ducked_at: index,
            ratio: probe.linear_db - reference_db,
            by_suppressed,
            before_db: db(Self::mean(window, TRIGGER_WINDOW)),
            duck_seen: None,
            probed: 0,
            hits: 0,
            after_db: -120.0,
            after_min_db: 0.0,
            checked_at: None,
            speech_refused: false,
            refusals: 0,
        });
        Some(Action::Duck)
    }

    #[allow(clippy::too_many_arguments)]
    fn probe(
        &mut self,
        mut suspicion: Suspicion,
        index: u64,
        delay: usize,
        duck: f32,
        reference_db: f32,
        probe: &Probe,
        speech: &mut dyn FnMut(&[f32]) -> Option<bool>,
    ) -> Option<Action> {
        if suspicion.duck_seen.is_none()
            && (duck < 0.5
                || reference_db < self.floor.db() + 6.0
                || index >= suspicion.ducked_at + DUCK_SEEN_TIMEOUT as u64)
        {
            suspicion.duck_seen = Some(index);
        }
        let Some(seen) = suspicion
            .duck_seen
            .filter(|seen| index >= seen + (delay + PROBE_SETTLE) as u64)
        else {
            self.state = State::Suspect(suspicion);
            return None;
        };
        suspicion.probed += 1;
        // Only the bands confirm: AEC3's suppressor can let Vera's ducked
        // echo through, the bands' bounds never fall under it. While the
        // canceller isn't cancelling (it hasn't found a weak, late echo),
        // its linear output still holds Vera's echo, so the suppressed
        // output must agree.
        if probe.linear_hit && (self.locked || probe.suppressed_hit) {
            suspicion.hits += 1;
        }
        let level = if suspicion.by_suppressed {
            probe.suppressed_db
        } else {
            probe.linear_db
        };
        suspicion.after_db = suspicion.after_db.max(level);
        suspicion.after_min_db = suspicion.after_min_db.min(level);
        let fell_with_vera = suspicion.before_db - suspicion.after_db >= PROBE_MAX_DROP_DB;
        let check_due = suspicion
            .checked_at
            .is_none_or(|at| suspicion.probed >= at + CHECK_EVERY);
        if suspicion.hits >= PROBE_COUNT && !fell_with_vera && check_due && self.converged() {
            suspicion.checked_at = Some(suspicion.probed);
            // Before the duck took effect only the suppressed output is free
            // of Vera's voice; after it, her residual is 20 dB down in the
            // linear output, which also has the user intact. Where AEC3
            // still held the user back (a headset, a cold start), the checks
            // repeat as the ducked audio grows.
            let heard = speech(&self.check_audio(suspicion.first, seen + delay as u64));
            if heard != Some(false) {
                self.bands.forget_pending();
                self.state = State::Confirmed { quiet: 0 };
                let onset = match self.rejected.take() {
                    Some((first, ended)) if suspicion.first <= ended + CHAIN_BLOCKS => first,
                    _ => suspicion.first,
                };
                return Some(Action::Confirm { onset });
            }
            suspicion.speech_refused = true;
            suspicion.refusals += 1;
        }
        // Done early once it is plain: the output fell with Vera and the
        // bands never showed the user, or nothing showed up at all.
        let plainly_echo =
            suspicion.probed >= PROBE_EARLY && fell_with_vera && suspicion.hits < PROBE_COUNT;
        // The bands' bounds hold Vera's level for 160 ms after the duck
        // reaches them: a quiet user can't show before that.
        let nothing = suspicion.probed >= HOLD_BLOCKS + PROBE_EARLY && suspicion.hits == 0;
        let refused = suspicion.refusals >= REFUSALS;
        if suspicion.probed >= PROBE_LIMIT || plainly_echo || nothing || refused {
            // Energy that stayed but was never speech is noise; anything
            // else fell with Vera.
            let echo = !suspicion.speech_refused;
            return Some(self.reject(&suspicion, echo));
        }
        self.state = State::Suspect(suspicion);
        None
    }

    fn learn(&mut self, ratio: f32) {
        push_capped(&mut self.leak, ratio, LEAK_HISTORY);
        if self.leak.len() >= 10 {
            let mut sorted: Vec<f32> = self.leak.iter().copied().collect();
            sorted.sort_by(f32::total_cmp);
            self.leak_db = sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)];
        }
    }

    /// A false alarm: restore, and learn from it. When the output fell
    /// with the duck (`echo`), what triggered was Vera's leak; when it
    /// didn't and still wasn't speech, it was the room's noise.
    fn reject(&mut self, suspicion: &Suspicion, echo: bool) -> Action {
        tracing::debug!(
            echo,
            by_suppressed = suspicion.by_suppressed,
            probed = suspicion.probed,
            band_hits = suspicion.hits,
            before_db = suspicion.before_db,
            after_db = suspicion.after_db,
            refusals = suspicion.refusals,
            converged = self.converged(),
            "assistant audio: suspicion rejected"
        );
        let ratios: Vec<f32> = self.recent_ratios.drain(..).collect();
        for ratio in ratios {
            self.learn(ratio);
        }
        if echo && !suspicion.by_suppressed {
            self.bands.learn_false_alarm();
        }
        if echo && suspicion.by_suppressed {
            // AEC3 let Vera's echo through at that level: ask for a little
            // more next time (the raise decays at 3 dB/s).
            self.suppressed_floor
                .raise(suspicion.before_db - SUPPRESSED_MARGIN_DB + 3.0);
        }
        if echo && !suspicion.by_suppressed && suspicion.ratio.is_finite() {
            // Echo louder than the leak allowed: allow it at once (a tenth
            // of the history, so the percentile holds it a while).
            for _ in 0..LEAK_HISTORY / 10 {
                self.learn(suspicion.ratio);
            }
            self.leak_db = self.leak_db.max(suspicion.ratio);
        }
        if !echo && suspicion.probed > 0 && suspicion.after_db - suspicion.after_min_db < 6.0 {
            // Steady noise (a fan, running water) that didn't fall with the
            // duck is the room's: raise the floor under it. Speech, which
            // comes and goes, never moves the floor.
            let floor = if suspicion.by_suppressed {
                &mut self.suppressed_floor
            } else {
                &mut self.floor
            };
            floor.raise(suspicion.after_min_db - 3.0);
        }
        self.rejected = Some((suspicion.first, self.block));
        self.state = State::Watching {
            refractory: REFRACTORY_BLOCKS,
        };
        Action::Restore
    }

    /// The audio the speech detector hears for a suspicion: suppressed
    /// output before block `linear_from`, linear from it on.
    fn check_audio(&self, first: u64, linear_from: u64) -> Vec<f32> {
        let newest = self.block;
        let oldest = newest - (self.linear_audio.len() / BLOCK) as u64;
        let from = first.saturating_sub(CHECK_LEAD_BLOCKS as u64).max(oldest);
        let mut audio = Vec::with_capacity(((newest - from) as usize) * BLOCK);
        for block in from..newest {
            let ring = if block < linear_from {
                &self.suppressed_audio
            } else {
                &self.linear_audio
            };
            let at = ((block - oldest) as usize) * BLOCK;
            audio.extend(ring.range(at..at + BLOCK));
        }
        audio
    }
}

/// A noise floor: a low percentile of recent 20 ms levels, so neither a
/// dip to digital silence nor a burst of speech moves it much; steady noise
/// that keeps triggering can raise it at once.
struct Floor {
    history: VecDeque<f32>,
    percentile_db: f32,
    raised_db: f32,
}

impl Default for Floor {
    fn default() -> Self {
        Self {
            history: VecDeque::new(),
            percentile_db: FLOOR_INITIAL_DB,
            raised_db: FLOOR_LOWEST_DB,
        }
    }
}

impl Floor {
    fn push(&mut self, level_db: f32, index: u64) {
        push_capped(
            &mut self.history,
            level_db.max(FLOOR_LOWEST_DB),
            FLOOR_HISTORY,
        );
        self.raised_db = (self.raised_db - FLOOR_RAISE_DECAY_DB).max(FLOOR_LOWEST_DB);
        if index.is_multiple_of(FLOOR_EVERY) && self.history.len() >= 50 {
            let mut sorted: Vec<f32> = self.history.iter().copied().collect();
            sorted.sort_by(f32::total_cmp);
            self.percentile_db = sorted[sorted.len() / 10];
        }
    }

    fn db(&self) -> f32 {
        self.percentile_db.max(self.raised_db)
    }

    fn raise(&mut self, to_db: f32) {
        self.raised_db = self.raised_db.max(to_db);
    }
}

fn push_capped<T>(ring: &mut VecDeque<T>, value: T, cap: usize) {
    ring.push_back(value);
    while ring.len() > cap {
        ring.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A loop of reference → echo → detector, with an optional user, run
    /// block by block. The duck reaches the reference two blocks after it
    /// is asked for and the echo `delay_blocks` after that. The linear
    /// output carries Vera's residual at `leak`; the suppressed output
    /// carries `suppressed_leak` of it.
    struct Room {
        detector: Detector,
        leak: f32,
        suppressed_leak: f32,
        delay_blocks: usize,
        ducked: bool,
        duck_history: VecDeque<f32>,
        played: VecDeque<f32>,
        seed: u32,
        actions: Vec<(u64, Action)>,
        speech: Option<bool>,
    }

    impl Room {
        fn new(leak_db: f32) -> Self {
            Self {
                detector: Detector::new(),
                leak: 10f32.powf(leak_db / 20.0),
                suppressed_leak: 10f32.powf(-30.0 / 20.0),
                delay_blocks: 12,
                ducked: false,
                duck_history: VecDeque::from(vec![1.0; 64]),
                played: VecDeque::from(vec![0.0; 64]),
                seed: 1,
                actions: Vec::new(),
                speech: Some(true),
            }
        }

        fn noise(&mut self) -> f32 {
            self.seed ^= self.seed << 13;
            self.seed ^= self.seed >> 17;
            self.seed ^= self.seed << 5;
            (self.seed as f32 / u32::MAX as f32) * 2.0 - 1.0
        }

        /// One block with Vera at `vera` (amplitude, before the duck) and
        /// the user at `user`.
        fn block(&mut self, vera: f32, user: f32) {
            let target = if self.ducked { DUCK_GAIN } else { 1.0 };
            self.duck_history.push_back(target);
            let duck_now = self.duck_history[self.duck_history.len() - 3];
            self.played.push_back(vera * duck_now);
            let echo = self.played[self.played.len() - 1 - self.delay_blocks];
            let reference: Vec<f32> = (0..BLOCK).map(|_| self.noise() * vera * duck_now).collect();
            let (mut microphone, mut linear, mut suppressed) = (Vec::new(), Vec::new(), Vec::new());
            for _ in 0..BLOCK {
                // The canceller takes the echo down to `leak` of itself.
                let raw = self.noise() * echo;
                let near = self.noise() * user + self.noise() * 1e-4;
                microphone.push(raw + near);
                linear.push(raw * self.leak + near);
                suppressed.push(raw * self.leak * self.suppressed_leak + near);
            }
            let block = Block {
                microphone: &microphone,
                linear: &linear,
                suppressed: &suppressed,
                reference: &reference,
                duck: duck_now,
                delay_ms: (self.delay_blocks * 4) as i32,
            };
            let speech = self.speech;
            let (action, _) = self.detector.push(&block, &mut |_| speech);
            if let Some(action) = action {
                self.actions.push((self.detector.position() - 1, action));
                match action {
                    Action::Duck => self.ducked = true,
                    Action::Restore | Action::Confirm { .. } => self.ducked = false,
                }
            }
        }

        fn confirmed(&self) -> bool {
            self.actions
                .iter()
                .any(|(_, action)| matches!(action, Action::Confirm { .. }))
        }
    }

    #[test]
    fn echo_alone_never_confirms_and_settles_without_ducking() {
        let mut room = Room::new(-6.0);
        // 20 s of Vera with syllable-like level changes.
        for block in 0..5_000 {
            let vera = 0.05 * (1.0 + ((block / 40) % 3) as f32);
            room.block(vera, 0.0);
        }
        assert!(!room.confirmed(), "{:?}", room.actions);
        let late = room.actions.iter().filter(|(at, _)| *at > 1_000).count();
        assert_eq!(late, 0, "{:?}", room.actions);
    }

    #[test]
    fn a_user_quieter_than_the_echo_barges_in_within_300_ms() {
        let mut room = Room::new(-15.0);
        for _ in 0..1_500 {
            room.block(0.1, 0.0);
        }
        let onset = room.detector.position();
        // The user 6 dB under Vera's echo, well over the cancelled residual.
        for _ in 0..200 {
            room.block(0.1, 0.05);
        }
        let duck = room
            .actions
            .iter()
            .find(|(at, action)| *at >= onset && *action == Action::Duck)
            .expect("a duck");
        let confirm = room
            .actions
            .iter()
            .find(|(_, action)| matches!(action, Action::Confirm { .. }))
            .expect("a barge-in");
        let duck_ms = (duck.0 - onset) * 4;
        let confirm_ms = (confirm.0 - onset) * 4;
        assert!(duck_ms <= 100, "duck after {duck_ms} ms");
        assert!(confirm_ms <= 300, "barge-in after {confirm_ms} ms");
    }

    #[test]
    fn a_leak_that_jumps_is_probed_by_the_duck_and_restored() {
        let mut room = Room::new(-20.0);
        for _ in 0..1_500 {
            room.block(0.1, 0.0);
        }
        // The echo path changes: the residual is suddenly 14 dB louder,
        // and AEC3's suppressor lets some of it through.
        room.leak = 10f32.powf(-6.0 / 20.0);
        room.suppressed_leak = 10f32.powf(-10.0 / 20.0);
        for _ in 0..1_500 {
            room.block(0.1, 0.0);
        }
        let kinds: Vec<Action> = room.actions.iter().map(|(_, action)| *action).collect();
        assert!(!room.confirmed(), "{kinds:?}");
        assert!(kinds.contains(&Action::Restore), "{kinds:?}");
    }

    #[test]
    fn noise_the_speech_detector_rejects_restores() {
        let mut room = Room::new(-15.0);
        for _ in 0..1_500 {
            room.block(0.1, 0.0);
        }
        room.speech = Some(false);
        for _ in 0..300 {
            room.block(0.1, 0.05);
        }
        let kinds: Vec<Action> = room.actions.iter().map(|(_, action)| *action).collect();
        assert!(kinds.contains(&Action::Restore), "{kinds:?}");
        assert!(!room.confirmed(), "{kinds:?}");
    }

    #[test]
    fn with_no_echo_at_all_the_user_still_barges_in() {
        // A headset: nothing of Vera reaches the microphone, and AEC3's
        // suppressor still holds the user back early on.
        let mut room = Room::new(-80.0);
        room.suppressed_leak = 0.0;
        for _ in 0..1_000 {
            room.block(0.1, 0.0);
        }
        for _ in 0..200 {
            room.block(0.1, 0.02);
        }
        assert!(room.confirmed(), "{:?}", room.actions);
    }
}
