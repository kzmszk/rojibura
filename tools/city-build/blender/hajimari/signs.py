"""Painted signs, the noren and the shelves' contents as small textures (Pillow), written to tex/signs/.
Fonts: Noto Serif / Sans CJK (SIL Open Font License), as installed on the build machine."""
import math, os, random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import bl

OUT = os.path.join(bl.TEX, 'signs')
SERIF = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'
SANS = '/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc'
DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'


def font(path, size):
    return ImageFont.truetype(path, size, index=0) if path.endswith('.ttc') else ImageFont.truetype(path, size)


def wood_board(w, h, base=(92, 60, 38), seed=1):
    rnd = random.Random(seed)
    im = Image.new('RGB', (w, h), base)
    d = ImageDraw.Draw(im)
    for y in range(0, h, 2):
        k = rnd.uniform(-14, 14) + 10 * math.sin(y * 0.07)
        d.line([(0, y), (w, y)], fill=tuple(int(max(0, min(255, c + k))) for c in base), width=2)
    for _ in range(int(w * h / 900)):
        x, y = rnd.randrange(w), rnd.randrange(h)
        d.line([(x, y), (x + rnd.randrange(20, 80), y)], fill=tuple(int(c * 0.8) for c in base), width=1)
    return im


def centered(d, box, text, f, fill, stroke=0, stroke_fill=None):
    x0, y0, x1, y1 = box
    bb = d.textbbox((0, 0), text, font=f, stroke_width=stroke)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    d.text(((x0 + x1 - tw) / 2 - bb[0], (y0 + y1 - th) / 2 - bb[1]), text, font=f, fill=fill, stroke_width=stroke,
           stroke_fill=stroke_fill)


def border(d, w, h, col, inset=10, width=6):
    d.rectangle([inset, inset, w - inset, h - inset], outline=col, width=width)


def seven():
    """The fascia: a dark oak board with the three stripes painted on, "7" in a roundel and the name."""
    w, h = 1024, 256
    im = wood_board(w, h, (70, 46, 30), 7)
    d = ImageDraw.Draw(im)
    # stripes along the bottom: orange, green, red
    for i, c in enumerate([(232, 120, 32), (24, 128, 72), (196, 32, 40)]):
        d.rectangle([0, h - 64 + i * 18, w, h - 64 + i * 18 + 14], fill=c)
    # roundel
    cx, cy, r = 128, 96, 78
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(240, 230, 205), outline=(176, 140, 60), width=8)
    centered(d, (cx - r, cy - r - 6, cx + r, cy + r - 6), '7', font(DEJAVU, 120), (24, 128, 72), 3, (196, 32, 40))
    centered(d, (230, 18, w - 20, 140), 'セブン‐イレブン', font(SERIF, 92), (236, 212, 150), 2, (60, 36, 20))
    centered(d, (230, 128, w - 20, 186), '〜 夜明けから夜更けまで 〜', font(SERIF, 34), (220, 196, 140))
    border(d, w, h, (176, 140, 60), 6, 5)
    return im


def seven_hanging():
    w, h = 512, 512
    im = wood_board(w, h, (240, 228, 200), 8)
    d = ImageDraw.Draw(im)
    for i, c in enumerate([(232, 120, 32), (24, 128, 72), (196, 32, 40)]):
        d.rectangle([0, 360 + i * 34, w, 360 + i * 34 + 26], fill=c)
    centered(d, (0, 20, w, 330), '7', font(DEJAVU, 300), (24, 128, 72), 8, (196, 32, 40))
    border(d, w, h, (120, 80, 40), 8, 14)
    return im


def books():
    w, h = 1024, 256
    im = wood_board(w, h, (38, 58, 84), 3)
    d = ImageDraw.Draw(im)
    centered(d, (20, 10, w - 20, 170), '本屋 ひなた書房', font(SERIF, 104), (240, 214, 140), 2, (20, 30, 50))
    centered(d, (20, 168, w - 20, 236), '古書・新刊・絵本・地図', font(SERIF, 40), (220, 200, 150))
    border(d, w, h, (200, 170, 100), 6, 5)
    return im


def books_hanging():
    w, h = 512, 512
    im = wood_board(w, h, (38, 58, 84), 4)
    d = ImageDraw.Draw(im)
    # an open book
    d.polygon([(70, 300), (250, 340), (250, 150), (70, 110)], fill=(245, 236, 210), outline=(200, 170, 100))
    d.polygon([(440, 300), (260, 340), (260, 150), (440, 110)], fill=(245, 236, 210), outline=(200, 170, 100))
    for k in range(6):
        y = 150 + k * 25
        d.line([(95, y), (230, y + 18)], fill=(120, 110, 90), width=4)
        d.line([(415, y), (280, y + 18)], fill=(120, 110, 90), width=4)
    centered(d, (0, 360, w, 470), '書', font(SERIF, 110), (240, 214, 140))
    border(d, w, h, (200, 170, 100), 8, 12)
    return im


def bakery():
    w, h = 1024, 256
    im = wood_board(w, h, (120, 70, 36), 5)
    d = ImageDraw.Draw(im)
    centered(d, (20, 10, w - 20, 170), 'パン屋 こむぎ', font(SERIF, 110), (250, 232, 190), 2, (70, 36, 16))
    centered(d, (20, 168, w - 20, 236), '焼きたて 毎朝六時から', font(SERIF, 40), (240, 220, 170))
    border(d, w, h, (230, 200, 140), 6, 5)
    return im


def bakery_hanging():
    w, h = 512, 512
    im = Image.new('RGB', (w, h), (230, 210, 170))
    d = ImageDraw.Draw(im)
    # a pretzel
    c = (176, 102, 40)
    d.arc([96, 120, 296, 360], 120, 420, fill=c, width=40)
    d.arc([216, 120, 416, 360], 120, 420, fill=c, width=40)
    d.arc([136, 230, 376, 430], 200, 340, fill=c, width=40)
    for (x, y) in [(150, 190), (300, 170), (360, 260), (230, 300), (180, 330), (320, 330)]:
        d.ellipse([x, y, x + 10, y + 7], fill=(250, 250, 245))
    border(d, w, h, (120, 70, 36), 8, 16)
    return im


def onsen():
    w, h = 1024, 256
    im = wood_board(w, h, (64, 42, 28), 9)
    d = ImageDraw.Draw(im)
    centered(d, (20, 6, w - 20, 180), '温泉宿 ゆのはな', font(SERIF, 112), (240, 228, 200), 2, (30, 20, 10))
    centered(d, (20, 170, w - 20, 240), '♨ 露天風呂 日帰り入浴できます', font(SANS, 40), (230, 210, 170))
    return im


def noren():
    """Indigo noren with a big white ゆ and the hot-spring mark; split into three panels by darker seams."""
    w, h = 512, 512
    im = Image.new('RGB', (w, h), (34, 52, 98))
    d = ImageDraw.Draw(im)
    centered(d, (0, 40, w, 400), 'ゆ', font(SERIF, 330), (245, 242, 235))
    centered(d, (0, 380, w, 500), '♨', font(SANS, 90), (245, 242, 235))
    for x in (w // 3, 2 * w // 3):
        d.line([(x, 0), (x, h)], fill=(20, 30, 60), width=6)
    return im.filter(ImageFilter.GaussianBlur(0.6))


def noren_sex(sex):
    """The changing rooms' noren: indigo with 男 for the men's, deep red with 女 for the women's, and a small ゆ."""
    def make():
        w, h = 512, 512
        im = Image.new('RGB', (w, h), (34, 52, 98) if sex == 'm' else (150, 34, 40))
        d = ImageDraw.Draw(im)
        centered(d, (0, 30, w, 380), '男' if sex == 'm' else '女', font(SERIF, 300), (245, 242, 235))
        centered(d, (0, 370, w, 500), 'ゆ', font(SERIF, 100), (245, 242, 235))
        for x in (w // 3, 2 * w // 3):
            d.line([(x, 0), (x, h)], fill=(20, 30, 60) if sex == 'm' else (90, 18, 22), width=6)
        return im.filter(ImageFilter.GaussianBlur(0.6))
    return make


def onsen_board_sex(sex):
    """A board by a changing room's doors: 男湯 or 女湯, the character in indigo or red."""
    def make():
        w, h = 512, 1024
        im = wood_board(w, h, (205, 180, 140), 10).rotate(90, expand=True).resize((w, h))
        d = ImageDraw.Draw(im)
        f = font(SERIF, 200)
        col = (30, 44, 96) if sex == 'm' else (150, 30, 36)
        for i, ch in enumerate('男湯' if sex == 'm' else '女湯'):
            centered(d, (0, 140 + i * 380, w, 460 + i * 380), ch, f, col)
        border(d, w, h, (90, 60, 36), 8, 12)
        return im
    return make


def onsen_board():
    w, h = 512, 1024
    im = wood_board(w, h, (205, 180, 140), 10).rotate(90, expand=True).resize((w, h))
    d = ImageDraw.Draw(im)
    f = font(SERIF, 120)
    for i, ch in enumerate('露天風呂'):
        centered(d, (0, 80 + i * 200, w, 260 + i * 200), ch, f, (40, 26, 16))
    border(d, w, h, (90, 60, 36), 8, 12)
    return im


def crest():
    """The college's arms over the great gate: a shield quartered blue and red with an open book and a key,
    gold lions in the corners, the name on a scroll below."""
    w, h = 512, 640
    im = Image.new('RGB', (w, h), (214, 196, 160))
    d = ImageDraw.Draw(im)
    gold = (226, 182, 72)
    shield = [(96, 60), (416, 60), (416, 300), (380, 400), (256, 470), (132, 400), (96, 300)]
    d.polygon(shield, fill=(36, 62, 126), outline=gold, width=10)
    d.polygon([(256, 60), (416, 60), (416, 300), (380, 400), (256, 470)], fill=(160, 36, 40))
    d.polygon([(256, 60), (416, 60), (416, 260), (256, 260)], fill=(36, 62, 126))
    d.polygon([(96, 260), (256, 260), (256, 470), (132, 400), (96, 300)], fill=(160, 36, 40))
    # an open book in the middle
    d.polygon([(170, 200), (252, 220), (252, 320), (170, 300)], fill=(244, 238, 220), outline=gold)
    d.polygon([(342, 200), (260, 220), (260, 320), (342, 300)], fill=(244, 238, 220), outline=gold)
    for k in range(4):
        d.line([(184, 226 + k * 18), (240, 240 + k * 18)], fill=(120, 110, 90), width=4)
        d.line([(328, 226 + k * 18), (272, 240 + k * 18)], fill=(120, 110, 90), width=4)
    for (x, y) in [(150, 120), (362, 120), (150, 360), (300, 400)]:
        d.ellipse([x - 22, y - 22, x + 22, y + 22], fill=gold)
    d.rounded_rectangle([40, 500, 472, 600], 24, fill=(236, 226, 200), outline=gold, width=6)
    centered(d, (40, 500, 472, 600), 'はじまりカレッジ', font(SERIF, 54), (60, 40, 30))
    return im


def college_sign(text, sub):
    def make():
        w, h = 1024, 256
        im = Image.new('RGB', (w, h), (222, 206, 172))
        d = ImageDraw.Draw(im)
        centered(d, (20, 10, w - 20, 170), text, font(SERIF, 96), (52, 40, 30))
        centered(d, (20, 160, w - 20, 240), sub, font(DEJAVU, 46), (90, 70, 50))
        border(d, w, h, (150, 120, 70), 8, 6)
        return im
    return make


def lawn_sign():
    w, h = 512, 256
    im = Image.new('RGB', (w, h), (250, 248, 240))
    d = ImageDraw.Draw(im)
    centered(d, (10, 20, w - 10, 140), '芝生に入らないでください', font(SANS, 40), (40, 70, 40))
    centered(d, (10, 140, w - 10, 230), 'KEEP OFF THE GRASS', font(DEJAVU, 40), (40, 70, 40))
    border(d, w, h, (40, 70, 40), 8, 6)
    return im


def spines():
    """Shelves of books: rows of coloured spines with gold bands and titles."""
    rnd = random.Random(4)
    w, h = 1024, 512
    im = Image.new('RGB', (w, h), (60, 40, 26))
    d = ImageDraw.Draw(im)
    rows = 4
    for r in range(rows):
        y0 = r * h // rows + 8
        y1 = (r + 1) * h // rows - 6
        x = 4
        while x < w - 10:
            bw = rnd.randrange(14, 34)
            top = y0 + rnd.randrange(0, 22)
            col = rnd.choice([(140, 30, 34), (30, 60, 110), (40, 90, 60), (160, 120, 50), (90, 50, 90),
                              (200, 190, 160), (60, 60, 60), (170, 80, 40), (110, 30, 30), (30, 90, 100)])
            col = tuple(max(0, min(255, c + rnd.randrange(-20, 20))) for c in col)
            d.rectangle([x, top, x + bw - 2, y1], fill=col)
            for k in range(rnd.randrange(1, 3)):
                yy = top + 8 + k * 10
                d.rectangle([x + 1, yy, x + bw - 3, yy + 2], fill=(210, 180, 90))
            if bw > 20:
                d.rectangle([x + 4, top + 30, x + bw - 6, y1 - 20], fill=tuple(int(c * 0.85) for c in col))
            x += bw
        d.rectangle([0, y1, w, y1 + 6], fill=(90, 62, 40))
    return im


def goods():
    """Convenience-store shelves: packets, bottles, boxes in bright colours with labels."""
    rnd = random.Random(6)
    w, h = 1024, 512
    im = Image.new('RGB', (w, h), (235, 232, 225))
    d = ImageDraw.Draw(im)
    rows = 4
    for r in range(rows):
        y0 = r * h // rows + 6
        y1 = (r + 1) * h // rows - 10
        x = 6
        while x < w - 12:
            kind = rnd.random()
            col = rnd.choice([(230, 60, 50), (250, 200, 40), (60, 140, 220), (60, 170, 90), (240, 130, 40),
                              (250, 250, 250), (150, 80, 180), (240, 120, 160), (90, 60, 40)])
            if kind < 0.4:     # bottles
                bw = 26
                d.rectangle([x + 4, y0 + 30, x + bw - 4, y1], fill=(200, 225, 235))
                d.rectangle([x + 4, y0 + 52, x + bw - 4, y0 + 80], fill=col)
                d.rectangle([x + 9, y0 + 18, x + bw - 9, y0 + 30], fill=(250, 250, 250))
            else:              # packets and boxes
                bw = rnd.randrange(34, 70)
                top = y0 + rnd.randrange(8, 40)
                d.rectangle([x + 2, top, x + bw - 2, y1], fill=col)
                d.rectangle([x + 8, top + 12, x + bw - 8, top + 30], fill=(255, 255, 255))
                d.ellipse([x + bw / 2 - 10, top + 40, x + bw / 2 + 10, top + 60], fill=tuple(255 - c for c in col))
            x += bw + 3
        d.rectangle([0, y1, w, y1 + 10], fill=(170, 170, 175))
    return im


def breads():
    rnd = random.Random(8)
    w, h = 1024, 512
    im = Image.new('RGB', (w, h), (120, 80, 50))
    d = ImageDraw.Draw(im)
    for r in range(3):
        y0 = r * h // 3 + 10
        y1 = (r + 1) * h // 3 - 12
        x = 8
        while x < w - 40:
            bw = rnd.randrange(50, 110)
            col = rnd.choice([(214, 160, 86), (190, 120, 60), (230, 190, 120), (160, 96, 50)])
            d.ellipse([x, y1 - rnd.randrange(40, 70), x + bw, y1], fill=col)
            d.arc([x + 10, y1 - 50, x + bw - 10, y1 - 10], 200, 340, fill=tuple(int(c * 0.7) for c in col), width=4)
            x += bw + 6
        d.rectangle([0, y1, w, y1 + 10], fill=(90, 60, 38))
    return im


def make():
    os.makedirs(OUT, exist_ok=True)
    for name, fn in [('seven', seven), ('seven_hanging', seven_hanging), ('books', books),
                     ('books_hanging', books_hanging), ('bakery', bakery), ('bakery_hanging', bakery_hanging),
                     ('onsen', onsen), ('noren', noren), ('onsen_board', onsen_board), ('spines', spines),
                     ('noren_m', noren_sex('m')), ('noren_w', noren_sex('w')),
                     ('onsen_board_m', onsen_board_sex('m')), ('onsen_board_w', onsen_board_sex('w')),
                     ('goods', goods), ('breads', breads), ('crest', crest),
                     ('library', college_sign('図書館', 'THE LIBRARY')),
                     ('dorm', college_sign('寮', 'HALL OF RESIDENCE')), ('lawn', lawn_sign)]:
        p = os.path.join(OUT, name + '.png')
        fn().save(p)
        bl.SIGNS['sign_' + name] = p
