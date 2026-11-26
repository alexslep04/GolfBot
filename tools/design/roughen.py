"""Bake the stickers' rough paper edge into the icons and the fonts.

The look used to come from an SVG filter (Figma's "texture" effect: fractal noise,
displacing each edge by up to about 0.8px), applied to every sticker while the page
was drawn. Safari draws that filter slowly, on the processor, and on a phone the
stickers flickered as a page scrolled. Here the same wobble is put into the shapes
themselves, once, so the browser only ever draws plain outlines:

  - every outline is walked at a fine, even spacing, and each point is pushed a
    little along x and y by two smooth noise fields (as the filter's red and green
    channels did), giving an edge that wanders like torn paper;
  - icons: roughened in the browser instead (web/ui.js, roughPath), for the size each
    is drawn at; web/icons.js is a copy of the smooth tools/design/icons-smooth.js;
  - the logo's golf club: tools/design/club-smooth.svg -> LOGO_CLUB in web/ui.js;
  - fonts: each web/fonts/*.woff2 used by stickers -> "-rough-<size>" cuts, one for
    each step of a ladder of sizes (FONTS), so the grain is the same on screen at
    every size.

Run it with: uv run --with fonttools --with brotli python tools/design/roughen.py
"""
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESIGN = ROOT / "tools" / "design"

# The wobble, in screen pixels: how far an edge strays at most, and the length of one
# wave along it. (The old filter, Figma's noise size 2 and radius 0.5, came to about
# 0.75 and 2.2: this is a finer, denser grain.)
# (keep these, and the noise below, in step with GRAIN and roughPath in web/ui.js,
# which roughens the icons the same way, so letters and icons have the same grain)
AMPLITUDE_PX = 0.5
WAVELENGTH_PX = 1.3
STEP_PX = 0.42  # how finely an outline is walked (a few points to every wave)


# ---------- noise ----------
def _hash(ix, iy, seed):
    n = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 0xFFFF  # 0..1


def _smooth(t):
    return t * t * (3 - 2 * t)


def noise(x, y, seed):
    """Smooth value noise in -1..1, one wave per unit."""
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = _smooth(x - ix), _smooth(y - iy)
    a, b = _hash(ix, iy, seed), _hash(ix + 1, iy, seed)
    c, d = _hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed)
    top, bottom = a + (b - a) * fx, c + (d - c) * fx
    return (top + (bottom - top) * fy) * 2 - 1


def displace(x, y, amplitude, wavelength):
    """Where the point (x, y) lands once roughened (all in the shape's own units)."""
    u, v = x / wavelength, y / wavelength
    # two octaves, like fractal noise: the second finer and fainter
    dx = noise(u, v, 11) * 0.72 + noise(u * 2.1, v * 2.1, 13) * 0.28
    dy = noise(u, v, 17) * 0.72 + noise(u * 2.1, v * 2.1, 19) * 0.28
    return x + dx * amplitude, y + dy * amplitude


# ---------- walking outlines ----------
def _cubic(p0, p1, p2, p3, t):
    s = 1 - t
    return (s ** 3 * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t ** 3 * p3[0],
            s ** 3 * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t ** 3 * p3[1])


def _quad(p0, p1, p2, t):
    s = 1 - t
    return (s * s * p0[0] + 2 * s * t * p1[0] + t * t * p2[0], s * s * p0[1] + 2 * s * t * p1[1] + t * t * p2[1])


def _fine(segment, start):
    """A segment as many short straight pieces (its end points, not its start)."""
    kind, pts = segment
    if kind == "L":
        return [pts[0]]
    curve = (lambda t: _cubic(start, pts[0], pts[1], pts[2], t)) if kind == "C" else (lambda t: _quad(start, pts[0], pts[1], t))
    return [curve(i / 24) for i in range(1, 25)]


def resample(start, segments, step):
    """A closed outline as points an even `step` apart (the corners kept)."""
    dense = [start]
    for segment in segments:
        dense.extend(_fine(segment, dense[-1]))
    if math.dist(dense[-1], start) > 1e-6:
        dense.append(start)
    out, carry = [start], 0.0
    for a, b in zip(dense, dense[1:]):
        length = math.dist(a, b)
        if length == 0:
            continue
        travelled = step - carry
        while travelled <= length:
            t = travelled / length
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            travelled += step
        carry = length - (travelled - step)
    if len(out) > 1 and math.dist(out[-1], start) < step * 0.5:
        out.pop()
    return out


def roughen_contour(start, segments, amplitude, wavelength, step):
    points = resample(start, segments, step)
    if len(points) < 3:  # (too small to walk: kept as it was, only nudged)
        points = [start] + [s[1][-1] for s in segments]
    return [displace(x, y, amplitude, wavelength) for x, y in points]


# ---------- SVG paths ----------
_TOKEN = re.compile(r"[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?")


def parse_path(d):
    """Contours of an absolute SVG path (M, L, H, V, C, Q, Z): [(start, [(kind, points)])]."""
    tokens, i = _TOKEN.findall(d), 0
    contours, current, point, start, command = [], None, (0.0, 0.0), (0.0, 0.0), None

    def number():
        nonlocal i
        value = float(tokens[i])
        i += 1
        return value

    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
            if command in "Zz":
                if current:
                    contours.append(current)
                current, point = None, start
                continue
        if command.islower():
            raise ValueError("relative path commands are not handled: " + command)
        if command == "M":
            if current:
                contours.append(current)
            point = start = (number(), number())
            current = (start, [])
            command = "L"  # (more pairs after a move are lines)
        elif command == "L":
            point = (number(), number())
            current[1].append(("L", [point]))
        elif command == "H":
            point = (number(), point[1])
            current[1].append(("L", [point]))
        elif command == "V":
            point = (point[0], number())
            current[1].append(("L", [point]))
        elif command == "C":
            pts = [(number(), number()), (number(), number()), (number(), number())]
            current[1].append(("C", pts))
            point = pts[-1]
        elif command == "Q":
            pts = [(number(), number()), (number(), number())]
            current[1].append(("Q", pts))
            point = pts[-1]
    if current:
        contours.append(current)
    return contours


def _num(value, digits):
    text = f"{value:.{digits}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        text = "0"
    return text.replace("0.", ".", 1) if text.startswith("0.") else text.replace("-0.", "-.", 1)


def roughen_path(d, amplitude, wavelength, step, digits=1):
    """The path roughened, written compactly: a start point, then each next point as a
    step from the last (relative lines), which keeps the file small."""
    out = []
    for start, segments in parse_path(d):
        points = roughen_contour(start, segments, amplitude, wavelength, step)
        scale = 10 ** digits
        snapped = [(round(x * scale), round(y * scale)) for x, y in points]
        parts = [f"M{_num(snapped[0][0] / scale, digits)} {_num(snapped[0][1] / scale, digits)}l"]
        steps = []
        for (ax, ay), (bx, by) in zip(snapped, snapped[1:]):
            dx, dy = _num((bx - ax) / scale, digits), _num((by - ay) / scale, digits)
            steps.append(dx + ("" if dy.startswith("-") else " ") + dy)
        parts.append(" ".join(steps).replace(" -", "-"))
        out.append("".join(parts) + "z")
    return "".join(out)


# ---------- icons ----------
def roughen_icons():
    """Icons are drawn at size/100 px per unit; tuned for the usual 30px sticker."""
    per_px = 100 / 30
    amplitude, wavelength, step = AMPLITUDE_PX * per_px, WAVELENGTH_PX * per_px, STEP_PX * per_px
    source = (DESIGN / "icons-smooth.js").read_text()
    icons = json.loads(source[source.index("{"):source.rindex("}") + 1])
    for icon in icons.values():
        if "d" in icon:
            icon["d"] = roughen_path(icon["d"], amplitude, wavelength, step)
        for layer in icon.get("l", []):
            layer[1] = roughen_path(layer[1], amplitude, wavelength, step)
    out = ROOT / "web" / "icons.js"
    out.write_text('"use strict";\n// Generated by tools/design/build_icons.py from SF Symbols (bold, rounded, 100pt),\n'
                   '// with the paper edge baked in by tools/design/roughen.py (from icons-smooth.js).\n'
                   '// b = glyph bounds [x, y, w, h]; d = single path; l = ordered layers [isCutOut, path].\n'
                   'const ICONS = ' + json.dumps(icons, separators=(",", ":")) + ';\n')
    print("icons:", len(icons), out.stat().st_size, "bytes")


def roughen_club():
    """The club is drawn 83px tall from a 138-unit-tall drawing."""
    per_px = 138 / 83
    amplitude, wavelength, step = AMPLITUDE_PX * per_px, WAVELENGTH_PX * per_px, STEP_PX * per_px
    svg = (DESIGN / "club-smooth.svg").read_text()
    svg = re.sub(r'(<path[^>]*?\sd=")([^"]+)(")', lambda m: m.group(1) + roughen_path(m.group(2), amplitude, wavelength, step, 2) + m.group(3), svg)
    ui = ROOT / "web" / "ui.js"
    text = ui.read_text()
    start = text.index("const LOGO_CLUB = `")
    end = text.index("`;", start) + 2
    ui.write_text(text[:start] + "const LOGO_CLUB = `" + svg.strip() + "`;" + text[end:])
    print("club: done")


# ---------- fonts ----------
# Each font is cut for a ladder of sizes (in screen pixels), each step about 1.4 times
# the last; the app gives every piece of sticker text the cut nearest its own size
# (web/ui.js, roughCuts), so the grain is the same on screen at every size. Keep the
# ladders in step with ROUGH_CUTS there and the @font-face rules in web/style.css.
FONTS = {
    "seurat-pro-b": [14, 20, 28, 40, 56, 80],
    "sf-pro-rounded-bold": [14, 20, 28, 40, 56, 80],
}


class RoughPen:
    """Draws a glyph's outlines, roughened, onto another pen (as straight lines)."""

    def __init__(self, other, amplitude, wavelength, step):
        self.other, self.args = other, (amplitude, wavelength, step)
        self.start, self.segments, self.point = None, [], None

    def moveTo(self, pt):
        self.start, self.segments, self.point = pt, [], pt

    def lineTo(self, pt):
        self.segments.append(("L", [pt]))
        self.point = pt

    def curveTo(self, *pts):
        if len(pts) == 3:
            self.segments.append(("C", list(pts)))
        else:  # (several in a row: split as a quadratic spline would be, kept simple)
            for i in range(0, len(pts) - 2, 3):
                self.segments.append(("C", list(pts[i:i + 3])))
        self.point = pts[-1]

    def qCurveTo(self, *pts):
        on = list(pts)
        if on[-1] is None:
            raise ValueError("closed quadratic contours are not handled")
        off, end = on[:-1], on[-1]
        for i, ctrl in enumerate(off):
            nxt = end if i == len(off) - 1 else ((ctrl[0] + off[i + 1][0]) / 2, (ctrl[1] + off[i + 1][1]) / 2)
            self.segments.append(("Q", [ctrl, nxt]))
        self.point = end

    def closePath(self):
        if self.start is None:
            return
        points = roughen_contour(self.start, self.segments, *self.args)
        # The roughened points are the control points of one smooth closed curve, not
        # the corners of a polygon: a polygon's many small corners each threw a spike out
        # of a thick text outline (an outline joins its corners with long points, and
        # text has no way to ask for bevelled joins). The curve wanders the same, without
        # a single corner.
        unique = []
        for p in map(_round, points):
            if not unique or p != unique[-1]:
                unique.append(p)
        if len(unique) > 1 and unique[0] == unique[-1]:
            unique.pop()
        if len(unique) >= 3:
            self.other.qCurveTo(*unique, None)
            self.other.closePath()
        self.start = None

    endPath = closePath

    def addComponent(self, name, transform):
        raise ValueError("components are decomposed first")


def _round(p):
    return (round(p[0]), round(p[1]))


def roughen_font(name, size_px):
    from fontTools.pens.recordingPen import DecomposingRecordingPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import TTFont, newTable

    from fontTools import subset

    font = TTFont(ROOT / "web" / "fonts" / f"{name}.woff2")
    # only the characters it has (not the alternates and vertical forms behind them)
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk"]
    options.name_IDs, options.name_languages, options.notdef_outline = ["*"], ["*"], True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=font.getBestCmap().keys())
    subsetter.subset(font)
    upm = font["head"].unitsPerEm
    per_px = upm / size_px
    args = (AMPLITUDE_PX * per_px, WAVELENGTH_PX * per_px, STEP_PX * per_px)
    order = font.getGlyphOrder()
    glyph_set = font.getGlyphSet()
    glyphs = {}
    for glyph_name in order:
        record = DecomposingRecordingPen(glyph_set)
        glyph_set[glyph_name].draw(record)
        pen = TTGlyphPen(None)
        record.replay(RoughPen(pen, *args))
        glyphs[glyph_name] = pen.glyph()
    # the outlines become TrueType ones (straight lines need no curves)
    for table in ("CFF ", "VORG"):
        if table in font:
            del font[table]
    glyf = font["glyf"] = newTable("glyf")
    glyf.glyphOrder, glyf.glyphs = order, glyphs
    font["loca"] = newTable("loca")
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for field in ("maxZones", "maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
                  "maxStackElements", "maxSizeOfInstructions", "maxComponentElements", "maxComponentDepth"):
        setattr(maxp, field, 0)
    maxp.maxZones = 1
    font["head"].glyphDataFormat = 0
    font["head"].indexToLocFormat = 0
    font.sfntVersion = "\x00\x01\x00\x00"
    if font["post"].formatType != 2:
        font["post"].formatType = 2.0
        font["post"].extraNames, font["post"].mapping = [], {}
    # the left side bearings follow the new outlines
    hmtx = font["hmtx"]
    for glyph_name, glyph in glyphs.items():
        glyph.recalcBounds(glyf)
        advance, _ = hmtx[glyph_name]
        hmtx[glyph_name] = (advance, getattr(glyph, "xMin", 0))
    # a family of its own, so it is never mistaken for the font installed on a computer
    for record in font["name"].names:
        if record.nameID in (1, 4, 6, 16):
            record.string = f"Golf Rough {name} {size_px}" if record.nameID != 6 else f"GolfRough-{name}-{size_px}"
    font.flavor = "woff2"
    out = ROOT / "web" / "fonts" / f"{name}-rough-{size_px}.woff2"
    font.save(out)
    print("font:", out.name, out.stat().st_size, "bytes")


if __name__ == "__main__":
    # (the icons are roughened in the browser, for the size each is drawn at: web/ui.js;
    # web/icons.js is the smooth set, as build_icons.py makes it)
    (ROOT / "web" / "icons.js").write_text((DESIGN / "icons-smooth.js").read_text())
    roughen_club()
    for name, sizes in FONTS.items():
        for size in sizes:
            roughen_font(name, size)
