"""Textures for the city's nature (apps/city-client/src/nature): python3 nature-tex.py SRC OUT
SRC: the CC0 texture sets (kyoto-assets/textures: Poly Haven / ambientCG, 2K), OUT: assets/tex/nature.
Needs only Pillow.

bark.jpg / bark_nrm.jpg: 4 x 2 cells of 512 px (the order of BARK in src/nature/species.ts):
  0 sakura_bark  1 pine_bark  2 japanese_cedar_bark  3 Bark005 (smooth grey)  4 birch (drawn)  5 plane (drawn)
  6 furrowed grey (cedar, greyed)  7 keyaki (Bark005, flakes drawn)
snow.jpg / snow_nrm.jpg: fresh powder (snow_02), trod.jpg / trod_nrm.jpg: trampled snow (Snow006),
slush.jpg: melting dirty snow (Snow012)."""
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

C = 512


def load(src, name, kind, box=None):
    im = Image.open(os.path.join(src, name, f"{kind}.jpg")).convert("RGB")
    if box:
        im = im.crop(box)
    return im.resize((C, C), Image.LANCZOS)


def flat_normal():
    return Image.new("RGB", (C, C), (128, 128, 255))


def normal_from_height(h, strength=3.0):
    """an OpenGL normal map (+Y up) from a height image (L, white high), wrapping at the edges"""
    w, hh = h.size
    px = h.load()
    out = Image.new("RGB", (w, hh))
    po = out.load()
    for y in range(hh):
        for x in range(w):
            dx = (px[(x + 1) % w, y] - px[(x - 1) % w, y]) / 255.0 * strength
            dy = (px[x, (y - 1) % hh] - px[x, (y + 1) % hh]) / 255.0 * strength
            n = math.sqrt(dx * dx + dy * dy + 1)
            po[x, y] = (int((-dx / n * 0.5 + 0.5) * 255), int((-dy / n * 0.5 + 0.5) * 255), int((1 / n * 0.5 + 0.5) * 255))
    return out


def wrap_blobs(draw, r, n, size, fill, rx=(0.02, 0.06), ry=(0.005, 0.015)):
    """ellipses that wrap around the cell edges (so the texture tiles)"""
    for _ in range(n):
        x, y = r.random() * size, r.random() * size
        a, b = r.uniform(*rx) * size, r.uniform(*ry) * size
        f = fill(r) if callable(fill) else fill
        for ox in (-size, 0, size):
            for oy in (-size, 0, size):
                draw.ellipse((x + ox - a, y + oy - b, x + ox + a, y + oy + b), fill=f)


def birch():
    """white birch bark: chalky white with grey-pink tones, dark horizontal lenticels and a few black chevrons"""
    r = random.Random(7)
    im = Image.new("RGB", (C, C), (226, 223, 214))
    h = Image.new("L", (C, C), 200)
    d, dh = ImageDraw.Draw(im), ImageDraw.Draw(h)
    def chalk(r):
        g = r.uniform(200, 232)
        return (int(g), int(g - r.uniform(0, 4)), int(g - r.uniform(2, 9)))

    wrap_blobs(d, r, 120, C, chalk, (0.05, 0.2), (0.008, 0.03))
    wrap_blobs(d, r, 30, C, lambda r: (int(r.uniform(206, 220)), int(r.uniform(198, 208)), int(r.uniform(192, 200))), (0.04, 0.12), (0.008, 0.02))
    for _ in range(260):  # lenticels: thin dark dashes across the stem
        x, y = r.random() * C, r.random() * C
        a, b = r.uniform(0.006, 0.045) * C, r.uniform(0.0012, 0.0035) * C
        g = int(r.uniform(45, 120))
        for ox in (-C, 0, C):
            for oy in (-C, 0, C):
                d.ellipse((x + ox - a, y + oy - b, x + ox + a, y + oy + b), fill=(g, g - 4, g - 6))
                dh.ellipse((x + ox - a, y + oy - b, x + ox + a, y + oy + b), fill=120)
    for _ in range(6):  # black chevrons where twigs fell
        x, y = r.random() * C, r.random() * C
        w = r.uniform(0.05, 0.1) * C
        for ox in (-C, 0, C):
            for oy in (-C, 0, C):
                pts = [(x + ox - w, y + oy - w * 0.4), (x + ox, y + oy + w * 0.15), (x + ox + w, y + oy - w * 0.4)]
                d.line(pts, fill=(40, 37, 36), width=int(w * 0.18))
                dh.line(pts, fill=90, width=int(w * 0.18))
    im = im.filter(ImageFilter.GaussianBlur(1.1))
    return im, normal_from_height(h.filter(ImageFilter.GaussianBlur(1.5)), 2.0)


def plane():
    """plane tree bark: camouflage patches of olive, cream and grey (the bark flakes off in plates)"""
    r = random.Random(11)
    im = Image.new("RGB", (C, C), (150, 146, 118))
    h = Image.new("L", (C, C), 128)
    d, dh = ImageDraw.Draw(im), ImageDraw.Draw(h)
    cols = [(196, 190, 150), (120, 122, 92), (170, 160, 120), (210, 205, 170), (105, 104, 84), (150, 150, 130)]
    for k in range(260):
        x, y = r.random() * C, r.random() * C
        rad = r.uniform(0.03, 0.09) * C
        npt = 9
        pts = [(math.cos(i / npt * 6.283) * rad * r.uniform(0.6, 1.3), math.sin(i / npt * 6.283) * rad * r.uniform(0.5, 1.4)) for i in range(npt)]
        c = r.choice(cols)
        hv = int(r.uniform(100, 170))
        for ox in (-C, 0, C):
            for oy in (-C, 0, C):
                q = [(x + ox + px, y + oy + py) for px, py in pts]
                d.polygon(q, fill=c)
                dh.polygon(q, fill=hv)
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    return im, normal_from_height(h.filter(ImageFilter.GaussianBlur(2.0)), 2.5)


def keyaki(base, base_n):
    """zelkova: smooth grey-brown bark that flakes in round scales showing orange-brown beneath"""
    r = random.Random(5)
    im = ImageEnhance.Color(base).enhance(0.35)
    im = ImageEnhance.Brightness(im).enhance(1.35)
    d = ImageDraw.Draw(im)
    def scale(r):
        k = r.uniform(0.0, 1.0)
        return (int(118 + 18 * k), int(108 + 8 * k), int(96 - 2 * k))

    wrap_blobs(d, r, 45, C, scale, (0.015, 0.04), (0.012, 0.03))
    return im.filter(ImageFilter.GaussianBlur(1.6)), base_n


def main(src, out):
    os.makedirs(out, exist_ok=True)
    cells, nrms = [], []
    cells.append(load(src, "sakura_bark", "diff"))
    nrms.append(load(src, "sakura_bark", "nor"))
    cells.append(load(src, "pine_bark", "diff"))
    nrms.append(load(src, "pine_bark", "nor"))
    cells.append(load(src, "japanese_cedar_bark", "diff"))
    nrms.append(load(src, "japanese_cedar_bark", "nor"))
    smooth, smooth_n = load(src, "Bark005", "diff"), load(src, "Bark005", "nor")
    cells.append(smooth)
    nrms.append(smooth_n)
    b, bn = birch()
    cells.append(b)
    nrms.append(bn)
    p, pn = plane()
    cells.append(p)
    nrms.append(pn)
    grey = ImageEnhance.Color(cells[2]).enhance(0.25)
    cells.append(ImageEnhance.Brightness(grey).enhance(1.25))
    nrms.append(nrms[2])
    k, kn = keyaki(smooth, smooth_n)
    cells.append(k)
    nrms.append(kn)
    atlas, atlas_n = Image.new("RGB", (C * 4, C * 2)), Image.new("RGB", (C * 4, C * 2))
    for i, (c, n) in enumerate(zip(cells, nrms)):
        atlas.paste(c, ((i % 4) * C, (i // 4) * C))
        atlas_n.paste(n, ((i % 4) * C, (i // 4) * C))
    atlas.save(os.path.join(out, "bark.jpg"), quality=86)
    atlas_n.save(os.path.join(out, "bark_nrm.jpg"), quality=90)
    for name, src_name, size in (("snow", "snow_02", 1024), ("trod", "Snow006", 1024)):
        for kind, suffix in (("diff", ""), ("nor", "_nrm")):
            im = Image.open(os.path.join(src, src_name, f"{kind}.jpg")).convert("RGB").resize((size, size), Image.LANCZOS)
            im.save(os.path.join(out, f"{name}{suffix}.jpg"), quality=88)
    Image.open(os.path.join(src, "Snow012", "diff.jpg")).convert("RGB").resize((512, 512), Image.LANCZOS).save(
        os.path.join(out, "slush.jpg"), quality=86
    )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
