"""Build the ripped 5's card faces (the 5 of diamonds, torn across the middle).

    python tools/design/make_ripped_five.py

Each ripped face starts from the ordinary face image of the same color, so its
outer corners and border are exactly that face's. The tear comes from
ripped-five.svg (88 x 123 units, the card's own proportions): its two halves'
inner edges are cut out of the face, and a border is laid along each torn
edge. That border is not drawn: it is the face's own left border, copied pixel
for pixel and bent along the tear, so it has the same paper texture, the same
ragged edge and the same width as the rest of the card.

It also writes the masks for the card's two halves, which the flip-over
tearing animation moves apart (ripped-five-top.svg, ripped-five-bottom.svg).

Rerun it whenever the card faces change (a new corner radius, new colors).
"""
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'web' / 'assets'
SOURCE = Path(__file__).with_name('ripped-five.svg')
UNITS = (88, 123)
FACES = ['red', 'red-dark', 'red-night', 'orange', 'orange-dark', 'orange-night']
BAND = 14  # px: how deep the copied border runs in from a torn edge (border is ~8px, plus some fill)


def path_points(d, step=0.05):
    """Flatten an absolute SVG path (M, L, H, V, C) to points, in SVG units."""
    tokens = re.findall(r'[MLHVCZ]|-?\d*\.?\d+(?:e-?\d+)?', d)
    points, i, cmd, pos = [], 0, None, np.zeros(2)
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]; i += 1
            if cmd == 'Z':
                continue
        nums = lambda n: [float(t) for t in tokens[i:i + n]]
        if cmd in 'ML':
            x, y = nums(2); i += 2
            target = np.array([x, y])
            if cmd == 'L' and points:
                n = max(2, int(np.linalg.norm(target - pos) / step))
                points += list(pos + (target - pos) * t for t in np.linspace(0, 1, n)[1:])
            else:
                points.append(target)
            pos = target
        elif cmd in 'HV':
            v = nums(1)[0]; i += 1
            target = np.array([v, pos[1]]) if cmd == 'H' else np.array([pos[0], v])
            n = max(2, int(np.linalg.norm(target - pos) / step))
            points += list(pos + (target - pos) * t for t in np.linspace(0, 1, n)[1:])
            pos = target
        elif cmd == 'C':
            c = np.array(nums(6)).reshape(3, 2); i += 6
            p0, p1, p2, p3 = pos, c[0], c[1], c[2]
            n = max(4, int((np.linalg.norm(p1 - p0) + np.linalg.norm(p2 - p1) + np.linalg.norm(p3 - p2)) / step))
            for t in np.linspace(0, 1, n)[1:]:
                points.append((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3)
            pos = p3
    return np.array(points)


def tear_edges():
    """The top half's torn bottom edge and the bottom half's torn top edge, in SVG units."""
    svg = SOURCE.read_text()
    top = re.search(r'id="stroke0_137_23" d="([^"]+)"', svg).group(1)
    bottom = re.search(r'id="stroke1_137_23" d="([^"]+)"', svg).group(1)
    # top half: from its left side (0, 64.09) along the tear to its right side (88, 40.00)
    t = 'M0 64.0917' + top[top.index('V64.0917') + len('V64.0917'):top.index('V16C88')]
    # bottom half: from its right side (88, 59.84) along the tear to its left side (0, 90.05)
    b = 'M88 59.8353' + bottom[bottom.index('V59.8353') + len('V59.8353'):bottom.index('V107C0')]
    return path_points(t), path_points(b)


def nearest(points, pixels):
    """Distance from each pixel to a polyline, and how far along the line the nearest point is."""
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))])
    best_d = np.full(len(pixels), np.inf); best_s = np.zeros(len(pixels))
    for start in range(0, len(points), 512):
        chunk = points[start:start + 512]
        dist = np.linalg.norm(pixels[:, None, :] - chunk[None, :, :], axis=2)
        j = dist.argmin(axis=1); d = dist[np.arange(len(pixels)), j]
        better = d < best_d
        best_d[better] = d[better]; best_s[better] = along[start + j[better]]
    return best_d, best_s


def bilinear(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001); y = np.clip(y, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int); fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def make(name, top, bottom):
    face = np.asarray(Image.open(ASSETS / f'card-face-{name}.png').convert('RGBA')).astype(float)
    h, w = face.shape[:2]
    scale = np.array([w / UNITS[0], h / UNITS[1]])
    top_px, bottom_px = top * scale, bottom * scale
    # the gap between the halves, drawn 4x over for a smooth edge
    big = Image.new('L', (w * 4, h * 4), 0)
    ImageDraw.Draw(big).polygon([tuple(p * 4) for p in np.concatenate([top_px, bottom_px])], fill=255)
    gap = np.asarray(big.resize((w, h), Image.LANCZOS)).astype(float) / 255
    # the face's own left border, straight between its rounded corners: the strip to copy
    corner = int(16 * scale[1]) + 4
    strip = face[corner:h - corner, :BAND + 4]
    length = strip.shape[0]
    ys, xs = np.mgrid[0:h, 0:w]
    pixels = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], axis=1)
    d_top, s_top = nearest(top_px, pixels)
    d_bottom, s_bottom = nearest(bottom_px, pixels)
    use_top = d_top <= d_bottom
    d = np.where(use_top, d_top, d_bottom)
    s = np.where(use_top, s_top, s_bottom + length / 2)  # the two edges start at different points of the strip
    out = face.reshape(-1, 4).copy()
    near = d < BAND
    border = bilinear(strip, d[near], np.mod(s[near], length - 1))
    # ease into the face beyond the copied band, so there is no seam
    blend = np.clip((BAND - d[near]) / 3, 0, 1)[:, None]
    border = border * blend + out[near] * (1 - blend)
    # where a torn edge meets the card's own border (at its sides), keep
    # whichever is more border, so the copied fill never paints over it
    fill = face[h // 2, w // 2, :3]
    borderness = lambda px: np.linalg.norm(px[:, :3] - fill, axis=1)
    keep_face = borderness(out[near]) > borderness(border)
    alpha = np.minimum(border[:, 3], out[near, 3])
    out[near] = np.where(keep_face[:, None], out[near], border)
    out[near, 3] = alpha
    out[:, 3] *= 1 - gap.ravel()
    Image.fromarray(out.reshape(h, w, 4).round().astype('uint8'), 'RGBA').save(
        ASSETS / f'card-face-{name}-ripped.png', optimize=True)
    print('wrote', f'card-face-{name}-ripped.png')


def write_halves(top, bottom):
    """Masks for the two halves (for the tearing animation): each is everything on
    its side of the tear, running well past the card, so the card's own corners
    never come from here."""
    def svg(points, name):
        d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in points) + 'Z'
        (ASSETS / name).write_text(
            '<svg width="88" height="123" viewBox="0 0 88 123" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">\n'
            f'<!-- made by tools/design/make_ripped_five.py -->\n<path fill="black" d="{d}"/>\n</svg>\n')
        print('wrote', name)
    thin = lambda pts: pts[::6].tolist() + [pts[-1].tolist()]
    t, b = thin(top), thin(bottom)
    svg(t + [[120, t[-1][1]], [120, -30], [-30, -30], [-30, t[0][1]]], 'ripped-five-top.svg')
    svg(b + [[-30, b[-1][1]], [-30, 160], [120, 160], [120, b[0][1]]], 'ripped-five-bottom.svg')


if __name__ == '__main__':
    top, bottom = tear_edges()
    for name in FACES:
        make(name, top, bottom)
    write_halves(top, bottom)
