//! Vera's mark for the tray, drawn at the exact pixel size the notification
//! area asks for: three nested, rounded, downward triangles (a "V", built
//! the way Hex's mark nests hexagons), white on a dark taskbar and black on
//! a light one. 20 pixels and under keep two levels so it stays legible.
//! `scripts/vera-icon.py` draws the same mark into `vera.ico`.

/// The mark as straight RGBA, `size` pixels square. `badge` adds a dot in
/// the top right corner (inbox items), cut clear of the mark; `dim` fades
/// the mark (microphone muted).
pub(crate) fn tray_rgba(size: u32, light_taskbar: bool, badge: bool, dim: bool) -> Vec<u8> {
    let n = size as usize;
    let ink = if light_taskbar { 0u8 } else { 255u8 };
    let coverage = mark_coverage(size);
    let mut pixels = vec![0u8; n * n * 4];
    let dot = badge.then(|| {
        let radius = size as f32 * 0.17;
        let center = (size as f32 - radius - 0.5, radius + 0.5);
        (center, radius)
    });
    for y in 0..n {
        for x in 0..n {
            let mut alpha = coverage[y * n + x] * if dim { 0.45 } else { 1.0 };
            let mut rgb = [ink; 3];
            if let Some(((cx, cy), radius)) = dot {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                // A clear ring around the dot keeps it apart from the mark.
                let gap = (d - radius - size as f32 * 0.06).clamp(0.0, 1.0);
                alpha *= gap;
                let fill = (radius - d + 0.5).clamp(0.0, 1.0);
                if fill > 0.0 {
                    rgb = BADGE;
                    alpha = alpha * (1.0 - fill) + fill;
                }
            }
            let i = (y * n + x) * 4;
            pixels[i..i + 3].copy_from_slice(&rgb);
            pixels[i + 3] = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    pixels
}

/// The badge's colour: the agent blue Dot scope cools to, brightened.
const BADGE: [u8; 3] = [0x5b, 0x9c, 0xff];

/// The mark's coverage, 0–1 per pixel, row by row.
fn mark_coverage(size: u32) -> Vec<f32> {
    let small = size <= 20;
    let (width, round) = if small { (0.2, 0.12) } else { (0.11, 0.08) };
    let levels: &[f32] = if small { &[1.0] } else { &[1.0, 0.6] };
    let dot = if small { 0.46 } else { 0.27 };
    let radius = 1.04_f32;
    let cy = -radius / 4.0;
    let ss = 5usize;
    let n = size as usize;
    let samples = n * ss;
    let px = 2.0 / samples as f32;
    let mut out = vec![0.0f32; n * n];
    for sy in 0..samples {
        for sx in 0..samples {
            let x = (sx as f32 + 0.5) / samples as f32 * 2.0 - 1.0;
            let y = (sy as f32 + 0.5) / samples as f32 * 2.0 - 1.0;
            let mut a = 0.0f32;
            for level in levels {
                let d = sd_triangle(x, y, radius * level - 2.0 * round, cy) - round;
                a = a.max((0.5 - (d.abs() - width / 2.0) / px).clamp(0.0, 1.0));
            }
            let d = sd_triangle(x, y, radius * dot - round * 0.6, cy) - round * 0.6;
            a = a.max((0.5 - d / px).clamp(0.0, 1.0));
            out[(sy / ss) * n + sx / ss] += a / (ss * ss) as f32;
        }
    }
    out
}

/// Signed distance to a triangle pointing down, circumradius `r`, centroid
/// `(0, cy)`, y down.
fn sd_triangle(x: f32, y: f32, r: f32, cy: f32) -> f32 {
    let c = 30f32.to_radians().cos();
    let v = [(0.0, cy + r), (r * c, cy - r / 2.0), (-r * c, cy - r / 2.0)];
    let mut d = f32::MAX;
    let mut inside = true;
    for i in 0..3 {
        let (ax, ay) = v[i];
        let (bx, by) = v[(i + 1) % 3];
        let (ex, ey) = (bx - ax, by - ay);
        let (wx, wy) = (x - ax, y - ay);
        let t = ((wx * ex + wy * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
        let (qx, qy) = (wx - ex * t, wy - ey * t);
        d = d.min(qx * qx + qy * qy);
        // Inside is on the same (negative cross product) side of every edge.
        if ex * wy - ey * wx > 0.0 {
            inside = false;
        }
    }
    let d = d.sqrt();
    if inside { -d } else { d }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_is_inked_and_the_badge_shows() {
        for size in [16, 20, 24, 32] {
            let plain = tray_rgba(size, false, false, false);
            assert_eq!(plain.len(), (size * size * 4) as usize);
            let inked = plain.chunks(4).filter(|p| p[3] > 128).count();
            assert!(inked > (size * size / 10) as usize, "{size}: {inked}");
            let badged = tray_rgba(size, false, true, false);
            let blue = badged
                .chunks(4)
                .filter(|p| p[..3] == BADGE && p[3] > 200)
                .count();
            assert!(blue > 4, "{size}: {blue}");
            let light = tray_rgba(size, true, false, false);
            assert!(light.chunks(4).all(|p| p[..3] == [0, 0, 0]));
        }
        // The centre of the field is inside the bottom triangle's solid core.
        assert!(sd_triangle(0.0, 0.0, 1.0, -0.25) < 0.0);
        assert!(sd_triangle(0.0, -0.95, 1.0, -0.25) > 0.0);
    }
}
