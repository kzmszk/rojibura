"""The shops on the main street, which you walk into: the ground storey with its shop window, fascia and hanging
sign, and inside a counter and shelves (as in walk.shop_furniture); half-timbered storeys above."""
import math, random

import numpy as np

from . import geom, houses, plan, walk
from .houses import H0

WT = 0.35   # wall thickness

STYLE = {
    'seven': {'plaster': (0.95, 0.93, 0.86), 'shelf': 'sign_goods', 'fascia': 'sign_seven', 'hang': 'sign_seven_hanging',
              'floors': 3, 'timber': (0.42, 0.33, 0.27), 'floor': (0.92, 0.9, 0.86)},
    'books': {'plaster': (0.86, 0.82, 0.7), 'shelf': 'sign_spines', 'fascia': 'sign_books', 'hang': 'sign_books_hanging',
              'floors': 3, 'timber': (0.5, 0.36, 0.28), 'floor': (0.8, 0.68, 0.55)},
    'bakery': {'plaster': (0.95, 0.85, 0.66), 'shelf': 'sign_breads', 'fascia': 'sign_bakery',
               'hang': 'sign_bakery_hanging', 'floors': 2, 'timber': (0.6, 0.42, 0.3), 'floor': (0.85, 0.75, 0.62)},
}


def frame_of(sh):
    a, b, c, d = sh['lot']
    cx = (a + c) / 2
    if sh['front'] == 'N':
        return geom.Frame((cx, d, 0), (-1, 0)), c - a, d - b, -(sh['door'] - cx)
    return geom.Frame((cx, b, 0), (1, 0)), c - a, d - b, sh['door'] - cx


def textured(W, f, u0, u1, n, z0, z1, mat, facing):
    """A quad showing a whole texture (signs, shelf contents) on a plane at depth n facing -n or +n."""
    uv = [(0, 0), (1, 0), (1, 1), (0, 1)]
    if facing < 0:
        W.face([f.p(u0, n, z0), f.p(u1, n, z0), f.p(u1, n, z1), f.p(u0, n, z1)], mat, name='shops', uv=uv)
    else:
        W.face([f.p(u1, n, z0), f.p(u0, n, z0), f.p(u0, n, z1), f.p(u1, n, z1)], mat, name='shops', uv=uv)


def shell(W, sh, st):
    f, w, d, ud = frame_of(sh)
    u0, u1 = -w / 2, w / 2
    pc = st['plaster']
    # back and sides
    geom.box(W, f, u0, u1, d - WT, d, 0, H0, 'wall_plaster', pc, 'shops')
    geom.box(W, f, u0, u0 + WT, 0, d, 0, H0, 'wall_plaster', pc, 'shops')
    geom.box(W, f, u1 - WT, u1, 0, d, 0, H0, 'wall_plaster', pc, 'shops')
    # front: piers, the door, two shop windows
    zt = 2.75
    door = (ud - 1.1, ud + 1.1)
    left = (u0 + WT + 0.5, door[0] - 0.5)
    right = (door[1] + 0.5, u1 - WT - 0.5)
    spans = [(u0, left[0]), (left[1], door[0]), (door[1], right[0]), (right[1], u1)]
    for a, b in spans:
        if b - a > 0.01:
            geom.box(W, f, a, b, 0, WT, 0, H0, 'stone_blocks', (0.95, 0.92, 0.88), 'shops')
    for a, b in (left, right):
        if b - a < 0.6:
            continue
        geom.box(W, f, a, b, 0, WT, 0, 0.55, 'stone_blocks', (0.9, 0.88, 0.84), 'shops')
        geom.box(W, f, a, b, 0, WT, zt, H0, 'stone_blocks', (0.95, 0.92, 0.88), 'shops')
        # glass with glazing bars
        W.face([f.p(a, WT / 2, 0.55), f.p(b, WT / 2, 0.55), f.p(b, WT / 2, zt), f.p(a, WT / 2, zt)], 'glass_shop',
               name='shop_glass')
        k = max(2, int((b - a) / 0.7))
        for i in range(1, k):
            uu = a + (b - a) * i / k
            geom.box(W, f, uu - 0.03, uu + 0.03, WT / 2 - 0.04, WT / 2 + 0.04, 0.55, zt, 'timber', st['timber'],
                     'shops')
        geom.box(W, f, a, b, WT / 2 - 0.04, WT / 2 + 0.04, 2.1, 2.16, 'timber', st['timber'], 'shops')
        geom.box(W, f, a - 0.05, b + 0.05, -0.25, 0.0, 0.5, 0.58, 'stone', (1, 1, 1), 'shops')
    geom.box(W, f, door[0], door[1], 0, WT, 2.6, H0, 'stone_blocks', (0.95, 0.92, 0.88), 'shops')
    # an open door leaf, swung in
    df = f.sub(door[0] + 0.05, WT, 0, 70)
    geom.box(W, df, 0, 1.05, 0, 0.06, 0.0, 2.55, 'timber', st['timber'], 'shops')
    # fascia sign
    textured(W, f, u0 + 0.6, u1 - 0.6, -0.06, zt + 0.08, H0 - 0.04, st['fascia'], -1)
    geom.box(W, f, u0 + 0.5, u1 - 0.5, -0.06, 0.0, zt, zt + 0.08, 'timber', st['timber'], 'shops')
    geom.box(W, f, u0 + 0.5, u1 - 0.5, -0.06, 0.0, H0 - 0.04, H0 + 0.04, 'timber', st['timber'], 'shops')
    # hanging sign on an iron bracket by the door, both faces painted
    hu = door[1] + 0.35 if right[1] - right[0] > 0.6 else door[0] - 0.35
    geom.box(W, f, hu - 0.03, hu + 0.03, -1.3, 0.0, 3.55, 3.6, 'metal', (1, 1, 1), 'shops')
    geom.box(W, f, hu - 0.02, hu + 0.02, -0.6, 0.0, 3.0, 3.55, 'metal', (1, 1, 1), 'shops')
    sf = f.sub(hu, -0.75, 0, 90)
    for side, n in ((-1, -0.02), (1, 0.02)):
        textured(W, sf, -0.45, 0.45, n, 2.55, 3.45, st['hang'], side)
    # inside: floor, ceiling, lights
    W.face([f.p(u0, 0, 0.02), f.p(u1, 0, 0.02), f.p(u1, d, 0.02), f.p(u0, d, 0.02)][::-1], 'wood_deck',
           st['floor'], 'shops')
    W.face([f.p(u0, 0, H0 - 0.01), f.p(u1, 0, H0 - 0.01), f.p(u1, d, H0 - 0.01), f.p(u0, d, H0 - 0.01)], 'wall_plaster',
           (0.95, 0.94, 0.9), 'shops')
    for uu in np.arange(u0 + 2.0, u1 - 1.0, 3.0):
        for nn in np.arange(2.5, d - 1.0, 3.5):
            geom.box(W, f, uu - 0.5, uu + 0.5, nn - 0.25, nn + 0.25, H0 - 0.08, H0 - 0.01, 'light_panel', (1, 1, 1),
                     'shops')
    return f, w, d


def furniture(W, sh, st, rnd):
    polys = walk.shop_furniture(sh)
    counter, back, islands = polys[0], polys[1], polys[2:]

    def box_of(poly, z0, z1, mat, col, name='shops'):
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        f = geom.Frame((0, 0, 0), (1, 0))
        geom.box(W, f, min(xs), max(xs), min(ys), max(ys), z0, z1, mat, col, name)
        return min(xs), max(xs), min(ys), max(ys)

    # counter: wood with a darker top, a till, and for the shop of the day something on it
    x0, x1, y0, y1 = box_of(counter, 0, 0.95, 'wood', (0.75, 0.55, 0.38))
    box_of([(x0 - 0.05, y0 - 0.05), (x1 + 0.05, y0 - 0.05), (x1 + 0.05, y1 + 0.05), (x0 - 0.05, y1 + 0.05)], 0.95, 1.0,
           'timber', (0.5, 0.38, 0.3))
    f = geom.Frame(((x0 + x1) / 2, (y0 + y1) / 2, 1.0), (0, 1))
    geom.box(W, f, -0.3, 0.0, -0.2, 0.2, 0, 0.25, 'metal', (1, 1, 1), 'shops')                       # till
    geom.box(W, f, -0.28, -0.05, -0.18, 0.18, 0.25, 0.3, 'paint', (0.75, 0.6, 0.2), 'shops')
    if sh['id'] == 'seven':
        # a warm cabinet for nikuman and coffee
        geom.box(W, f, 0.6, 1.2, -0.3, 0.3, 0, 0.55, 'glass_shop', (1, 1, 1), 'shop_glass')
        geom.box(W, f, 0.62, 1.18, -0.28, 0.28, 0.02, 0.5, 'lamp', (1, 0.8, 0.6), 'shops')
        geom.box(W, f, -1.2, -0.8, -0.2, 0.2, 0, 0.6, 'metal', (1, 1, 1), 'shops')
    if sh['id'] == 'bakery':
        for k in range(3):
            geom.box(W, f, -1.3 + k * 0.6, -0.9 + k * 0.6, -0.25, 0.25, 0.0, 0.12, 'wood', (0.8, 0.6, 0.4), 'shops')
            for m in range(4):
                geom.box(W, f, -1.25 + k * 0.6 + m * 0.08, -1.17 + k * 0.6 + m * 0.08, -0.15, 0.1, 0.12, 0.2,
                         'flowers', (0.82, 0.58, 0.3), 'shops')
    # the back wall shelf with its contents painted on
    x0, x1, y0, y1 = box_of(back, 0, 2.2, 'wood', (0.7, 0.55, 0.42))
    front_n = sh['front'] == 'N'
    bf = geom.Frame((0, 0, 0), (1, 0))
    yface = y1 + 0.01 if front_n else y0 - 0.01
    textured(W, bf, x0 + 0.05, x1 - 0.05, yface, 0.15, 2.1, st['shelf'], 1 if front_n else -1)
    if sh['id'] == 'seven':
        # glass doors in front: a fridge
        yg = yface + (0.03 if front_n else -0.03)
        q = [bf.p(x0, yg, 0.1), bf.p(x1, yg, 0.1), bf.p(x1, yg, 2.15), bf.p(x0, yg, 2.15)]
        W.face(q[::-1] if front_n else q, 'glass_shop', name='shop_glass')
    if sh['id'] == 'bakery':
        # a brick oven in the corner with fire inside
        ox = x1 - 1.4
        oy = y1 + 0.2 if front_n else y0 - 1.6
        geom.box(W, geom.Frame((0, 0, 0), (1, 0)), ox, ox + 1.3, oy, oy + 1.4, 0, 1.6, 'stone_blocks', (0.8, 0.5, 0.4),
                 'shops')
        geom.box(W, geom.Frame((0, 0, 0), (1, 0)), ox + 0.35, ox + 0.95, oy - 0.01 if not front_n else oy + 1.41,
                 oy + 0.0 if not front_n else oy + 1.42, 0.6, 1.0, 'lamp', (1.0, 0.5, 0.2), 'shops')
    # islands: shelves with contents on both long sides
    for poly in islands:
        x0, x1, y0, y1 = box_of(poly, 0, 1.55, 'wood', (0.72, 0.58, 0.45))
        sf = geom.Frame((0, 0, 0), (0, 1))     # u along y, n = (-1, 0): faces west at n<0
        textured(W, sf, y0 + 0.05, y1 - 0.05, -(x0 - 0.01), 0.1, 1.5, st['shelf'], 1)
        textured(W, sf, y0 + 0.05, y1 - 0.05, -(x1 + 0.01), 0.1, 1.5, st['shelf'], -1)
    # bookshop: a table of books by the window, a library ladder
    if sh['id'] == 'books':
        a, b, c, d = sh['lot']
        tx, ty = sh['door'] + 2.3, (b + d) / 2 + (1.4 if sh['front'] == 'S' else -1.4)
        tf = geom.Frame((tx, ty, 0), (1, 0))
        geom.box(W, tf, -0.7, 0.7, -0.45, 0.45, 0.72, 0.78, 'wood', (0.7, 0.5, 0.35), 'shops')
        for u in (-0.6, 0.6):
            for n in (-0.35, 0.35):
                geom.box(W, tf, u - 0.04, u + 0.04, n - 0.04, n + 0.04, 0, 0.72, 'wood', (0.6, 0.45, 0.32), 'shops')
        for k in range(6):
            u = -0.5 + (k % 3) * 0.5
            n = -0.2 + (k // 3) * 0.4
            for m in range(rnd.randrange(1, 4)):
                col = rnd.choice([(0.6, 0.15, 0.15), (0.15, 0.3, 0.55), (0.2, 0.45, 0.3), (0.8, 0.7, 0.4)])
                geom.box(W, tf, u - 0.17, u + 0.17, n - 0.12, n + 0.12, 0.78 + m * 0.05, 0.82 + m * 0.05, 'paint', col,
                         'shops')


def build(W):
    rnd = random.Random(2)
    for sh in plan.SHOPS:
        st = STYLE[sh['style']]
        f, w, d = shell(W, sh, st)
        furniture(W, sh, st, rnd)
        hs = {'o': (float(f.o[0]), float(f.o[1])), 't': (float(f.t[0]), float(f.t[1])), 'w': w, 'd': d,
              'floors': st['floors'], 'style': 'timber', 'gable': True, 'colour': st['plaster'], 'roof': 'clay',
              'seed': rnd.randrange(1 << 30), 'shop_ground': True}
        houses.house(W, hs)
