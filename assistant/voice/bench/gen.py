"""Render the bench lines with one engine and many voices, timing each call (warm).

usage: python gen.py <engine> <outdir> voice1 [voice2 ...]
engines: kokoro, pocket, qwen-custom, qwen-design, qwen-clone, chatterbox, chatterbox-turbo
Writes <outdir>/<engine>-<voice>/<voice>__<i>.wav and timing.json there.
"""
import json, os, sys, time, pathlib
import numpy as np, soundfile as sf

HERE = pathlib.Path(__file__).parent
LINES = json.loads((HERE / "lines.json").read_text())
MODELS = pathlib.Path.home() / ".vera" / "models"
os.environ.setdefault("HF_HOME", str(MODELS / "hf"))

def kokoro():
    from kokoro_onnx import Kokoro
    d = MODELS / "kokoro-onnx"
    k = Kokoro(str(d / "kokoro-v1.0.onnx"), str(d / "voices-v1.0.bin"))
    def synth(text, voice):
        lang = "en-gb" if voice[0] == "b" else "en-us"
        a, sr = k.create(text, voice=voice, speed=1.0, lang=lang)
        return a, sr
    return synth

def pocket():
    from pocket_tts import TTSModel
    m = TTSModel.load_model()
    states = {}
    def synth(text, voice):
        if voice not in states: states[voice] = m.get_state_for_audio_prompt(voice)
        a = m.generate_audio(states[voice], text)
        return a.squeeze().float().cpu().numpy(), m.sample_rate
    return synth

def qwen(kind):
    import torch
    from qwen_tts import Qwen3TTSModel
    repo = {"custom": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "design": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
            "clone": os.environ.get("QWEN_BASE", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")}[kind]
    m = Qwen3TTSModel.from_pretrained(repo, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")
    instruct = os.environ.get("QWEN_INSTRUCT", "Speak calmly and evenly, with a relaxed, steady, low-key delivery.")
    prompts = {}
    def synth(text, voice):
        if kind == "custom":
            w, sr = m.generate_custom_voice(text=text, speaker=voice, language="English", instruct=instruct)
        elif kind == "design":
            w, sr = m.generate_voice_design(text=text, instruct=pathlib.Path(voice).read_text().strip(), language="English")
        else:
            if voice not in prompts:
                ref = pathlib.Path(voice)
                prompts[voice] = m.create_voice_clone_prompt(ref_audio=str(ref), ref_text=ref.with_suffix(".txt").read_text().strip())
            w, sr = m.generate_voice_clone(text=text, language="English", voice_clone_prompt=prompts[voice])
        return np.asarray(w[0], dtype=np.float32), sr
    return synth

def fqwen(kind):
    import torch
    from faster_qwen3_tts import FasterQwen3TTS
    repo = {"custom": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
            "clone": os.environ.get("QWEN_BASE", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")}[kind]
    m = FasterQwen3TTS.from_pretrained(repo)
    instruct = os.environ.get("QWEN_INSTRUCT") or None
    temp = float(os.environ.get("QWEN_TEMP", "0.9"))
    def synth(text, voice):
        torch.manual_seed(0)
        if kind == "custom":
            w, sr = m.generate_custom_voice(text=text, speaker=voice, language="English",
                                            instruct=instruct or "Speak calmly and evenly.", temperature=temp)
        else:
            ref = pathlib.Path(voice)
            w, sr = m.generate_voice_clone(text=text, language="English", ref_audio=str(ref),
                                           ref_text=ref.with_suffix(".txt").read_text().strip(), temperature=temp)
        return np.asarray(w[0], dtype=np.float32), sr
    return synth

def chatterbox(turbo):
    import torch
    if turbo:
        from chatterbox.tts_turbo import ChatterboxTurboTTS as C
    else:
        from chatterbox.tts import ChatterboxTTS as C
    m = C.from_pretrained(device="cuda")
    ex = float(os.environ.get("CB_EXAG", "0.3")); cfg = float(os.environ.get("CB_CFG", "0.5"))
    def synth(text, voice):
        kw = {} if voice == "default" else {"audio_prompt_path": voice}
        if not turbo: kw.update(exaggeration=ex, cfg_weight=cfg)
        w = m.generate(text, **kw)
        return w.squeeze().float().cpu().numpy(), m.sr
    return synth

def main():
    engine, out, voices = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3:]
    t0 = time.perf_counter()
    synth = {"kokoro": kokoro, "pocket": pocket, "qwen-custom": lambda: qwen("custom"),
             "qwen-design": lambda: qwen("design"), "qwen-clone": lambda: qwen("clone"),
             "fqwen-custom": lambda: fqwen("custom"), "fqwen-clone": lambda: fqwen("clone"),
             "chatterbox": lambda: chatterbox(False), "chatterbox-turbo": lambda: chatterbox(True)}[engine]()
    print(f"load {time.perf_counter()-t0:.1f}s", flush=True)
    for v in voices:
        name = pathlib.Path(v).stem if os.sep in v or "/" in v else v
        d = out / f"{engine}-{name}"; d.mkdir(parents=True, exist_ok=True)
        synth("Warming up the voice.", v)
        timing = {}
        t = time.perf_counter(); synth("On it.", v); timing["on_it_ms"] = 1000 * (time.perf_counter() - t)
        t = time.perf_counter(); synth("Your T3 thread on the hex fork needs an answer.", v); timing["sentence_ms"] = 1000 * (time.perf_counter() - t)
        tot_audio = tot_time = 0.0
        for i, line in enumerate(LINES):
            t = time.perf_counter(); a, sr = synth(line, v); dt = time.perf_counter() - t
            tot_time += dt; tot_audio += len(a) / sr
            sf.write(d / f"{name}__{i}.wav", a, sr)
        timing["rtf"] = tot_time / tot_audio
        (d / "timing.json").write_text(json.dumps(timing))
        print(f"{engine}-{name}: on_it {timing['on_it_ms']:.0f} ms, sentence {timing['sentence_ms']:.0f} ms, RTF {timing['rtf']:.2f}", flush=True)

if __name__ == "__main__":
    main()
