"""Draws Vera's app icon, resources/windows/assistant.ico, in Hex's style: the
dark rounded tile of hex.ico with Vera's mark (three nested, rounded,
downward triangles, a "V" built the way Hex's nested hexagons are) in
white. Small sizes keep two levels so the mark stays legible. The tray
draws the same mark at runtime (src/assistant/icon.rs).

    python scripts/assistant-icon.py
"""

import math
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent


def sd_polygon(x, y, vertices):
    d = (x - vertices[0][0]) ** 2 + (y - vertices[0][1]) ** 2
    s = np.ones_like(x)
    j = len(vertices) - 1
    for i in range(len(vertices)):
        ex, ey = vertices[j][0] - vertices[i][0], vertices[j][1] - vertices[i][1]
        wx, wy = x - vertices[i][0], y - vertices[i][1]
        t = np.clip((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1)
        bx, by = wx - ex * t, wy - ey * t
        d = np.minimum(d, bx * bx + by * by)
        c1 = y >= vertices[i][1]
        c2 = y < vertices[j][1]
        c3 = ex * wy > ey * wx
        s = np.where((c1 & c2 & c3) | (~c1 & ~c2 & ~c3), -s, s)
        j = i
    return s * np.sqrt(d)


def triangle(radius, cy):
    """Points down, circumradius `radius`, centroid (0, cy), y down."""
    c = math.cos(math.radians(30))
    return [(0, cy + radius), (radius * c, cy - radius / 2), (-radius * c, cy - radius / 2)]


def mark_alpha(size, scale=1.0):
    """The mark's coverage over a size x size square, filling `scale` of it."""
    small = size <= 20
    radius, width, round_ = 1.04, (0.2 if small else 0.11), (0.12 if small else 0.08)
    levels, dot = ((1.0,), 0.46) if small else ((1.0, 0.6), 0.27)
    ss = 6
    n = size * ss
    c = ((np.arange(n) + 0.5) / n * 2 - 1) / scale
    x, y = np.meshgrid(c, c)
    px = 2 / n / scale
    cy = -radius / 4
    ring = lambda d: np.clip(0.5 - (np.abs(d) - width / 2) / px, 0, 1)
    fill = lambda d: np.clip(0.5 - d / px, 0, 1)
    layers = [ring(sd_polygon(x, y, triangle(radius * l - 2 * round_, cy)) - round_) for l in levels]
    layers.append(fill(sd_polygon(x, y, triangle(radius * dot - round_ * 0.6, cy)) - round_ * 0.6))
    return np.maximum.reduce(layers).reshape(size, ss, size, ss).mean(axis=(1, 3))


def rounded_square(size, inset, radius):
    ss = 6
    n = size * ss
    c = (np.arange(n) + 0.5) / ss
    x, y = np.meshgrid(c, c)
    half = size / 2 - inset
    qx = np.abs(x - size / 2) - (half - radius)
    qy = np.abs(y - size / 2) - (half - radius)
    d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius
    return d.reshape(size, ss, size, ss).mean(axis=(1, 3))


def tile(size):
    inset = size * 0.035
    radius = size * 0.2
    d = rounded_square(size, inset, radius)
    edge = max(1.0, size / 90)
    inside = np.clip(0.5 - d, 0, 1)
    border = np.clip(0.5 - np.abs(d + edge / 2) + edge / 2 - 0.5, 0, 1) * inside
    rows = np.linspace(0, 1, size)[:, None]
    base = 22 + 4 * (1 - rows)  # #1a1a1a at the top to #161616
    rim = 50 + 12 * (1 - rows)
    rgb = base * (1 - border) + rim * border
    mark = mark_alpha(size, scale=0.66 if size > 20 else 0.74)
    rgb = rgb * (1 - mark) + 250 * mark
    out = np.zeros((size, size, 4), np.uint8)
    out[..., 0] = out[..., 1] = out[..., 2] = np.clip(rgb, 0, 255).round()
    out[..., 3] = (inside * 255).round()
    return Image.fromarray(out, "RGBA")


def main():
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    images = [tile(s) for s in sizes]
    path = ROOT / "resources" / "windows" / "assistant.ico"
    images[-1].save(path, sizes=[(s, s) for s in sizes], append_images=images[:-1])
    tile(256).save(ROOT / "resources" / "windows" / "assistant-256.png")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
