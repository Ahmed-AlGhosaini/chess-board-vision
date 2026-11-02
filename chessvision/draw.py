"""Draw candidate moves as numbered arrows on the original screenshot."""
from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageDraw

from .board_detect import BoardGeometry
from .engine import Candidate
from .recognize import square_to_image
from .synth import _font

# Lichess brush colours: green, blue, orange
ARROW_RGB = [(21, 120, 27), (0, 48, 136), (230, 143, 0)]
WIDTH_FRAC = [0.20, 0.16, 0.14]  # shaft width relative to square size


def _arrow_points(p0, p1, d, w_frac):
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    v = p1 - p0
    L = float(np.hypot(*v))
    u = v / L
    n = np.array([-u[1], u[0]])
    tip = p1 - u * d * 0.05
    head_len = min(d * 0.45, L * 0.6)
    base = tip - u * head_len
    w, hw = d * w_frac / 2, d * 0.27
    return np.array([p0 + n * w, base + n * w, base + n * hw, tip,
                     base - n * hw, base - n * w, p0 - n * w])


def _blend_poly(img: np.ndarray, pts: np.ndarray, rgb, alpha: float):
    mask = np.zeros(img.shape[:2], np.uint8)
    cv2.fillPoly(mask, [np.round(pts * 16).astype(np.int32)], 255, cv2.LINE_AA, shift=4)
    m = (mask.astype(np.float32) / 255.0 * alpha)[..., None]
    img[:] = (img * (1 - m) + np.array(rgb, np.float32) * m)


def annotate(img: Image.Image, geom: BoardGeometry, white_at_bottom: bool,
             cands: list[Candidate], legend: bool = True) -> Image.Image:
    arr = np.asarray(img.convert("RGB"), np.float32).copy()
    d = (geom.dx + geom.dy) / 2

    def centre(sq):
        r, c = square_to_image(sq, white_at_bottom)
        return geom.square_center(r, c)

    r = max(7, int(d * 0.17))
    badges = []
    for i in range(min(len(cands), len(ARROW_RGB))):  # place badges best-first
        mv = cands[i].move
        p0, p1 = centre(mv.from_square), centre(mv.to_square)
        spots = [(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t) for t in (0.38, 0.6, 0.2, 0.75)]
        free = [s for s in spots if all(np.hypot(s[0] - b[0], s[1] - b[1]) > 2.3 * r for _, b in badges)]
        badges.append((i, (free or spots)[0]))
    for i in reversed(range(len(badges))):  # draw arrows worst-first so #1 is on top
        mv = cands[i].move
        _blend_poly(arr, _arrow_points(centre(mv.from_square), centre(mv.to_square), d, WIDTH_FRAC[i]),
                    ARROW_RGB[i], 0.82)

    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(out)
    font = _font(max(9, int(r * 1.3)))
    for i, (x, y) in badges:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=ARROW_RGB[i], outline=(255, 255, 255),
                     width=max(1, r // 6))
        draw.text((x, y), str(i + 1), fill=(255, 255, 255), font=font, anchor="mm")

    if not legend or not cands:
        return out
    W = out.width
    fs = max(13, min(26, int(d * 0.32)))
    lf = _font(fs)
    line_h = int(fs * 1.7)
    band = Image.new("RGB", (W, line_h * len(cands[:3]) + fs), (30, 30, 30))
    bd = ImageDraw.Draw(band)
    for i, c in enumerate(cands[:3]):
        y = fs // 2 + i * line_h
        bd.rounded_rectangle([fs // 2, y, fs // 2 + fs * 1.4, y + fs * 1.4], radius=fs // 3,
                             fill=ARROW_RGB[i])
        bd.text((fs // 2 + fs * 0.7, y + fs * 0.7), str(i + 1), fill="white", font=lf, anchor="mm")
        text = f"{c.san:<8} {c.eval_text():>7}    " + " ".join(c.pv_san[1:6])
        bd.text((fs * 2.6, y + fs * 0.1), text, fill=(235, 235, 235), font=lf)
    final = Image.new("RGB", (W, out.height + band.height))
    final.paste(out, (0, 0))
    final.paste(band, (0, out.height))
    return final
