"""The onsen inn 「ゆのはな」 at the edge of town: a two-storey wooden inn with a tiled hip roof, noren and
lanterns at the entrance, a lobby, two changing rooms (脱衣所, the men's with an indigo 男 noren, the women's with a
red 女 one) with shelves of baskets, and the open-air baths in a garden (issue 42): three pools edged with mossy
boulders (a big milky one, a clear one whose pebbly bottom shows through, a small milky one under an arbour),
pebbles and stepping stones, maples and pines, bamboo screens, a low stone wall towards the mountain, stone
lanterns and a spout."""
import math, random

import numpy as np

from . import geom, plan, walk
from .ground import SNOW, TROD
from .houses import window

ON = plan.ONSEN
DARK = (0.42, 0.3, 0.22)      # stained wood
POST = (0.5, 0.36, 0.26)
BAMBOO = (0.78, 0.74, 0.5)

# the building's walls sit 0.3 m outside the walkable lobby; the rest of the inn's lot is a veranda under the eaves
LX0, LY0, LX1, LY1 = ON['lobby']
BX0, BY0, BX1, BY1 = LX0 - 0.3, LY0 - 0.3, LX1 + 0.3, LY1 + 0.3
H1, H2 = 3.4, 3.0
FLOOR = 0.15


def hip_roof(W, x0, y0, x1, y1, zb, pitch, ov, mat='roof_kawara', snow=True, name='roofs'):
    """A hipped roof over a rectangle, eaves `ov` out, the ridge along the longer side."""
    x0, y0, x1, y1 = x0 - ov, y0 - ov, x1 + ov, y1 + ov
    tp = math.tan(math.radians(pitch))
    ze = zb - ov * tp
    w, d = x1 - x0, y1 - y0
    h = min(w, d) / 2
    zr = ze + h * tp
    if w >= d:
        r0, r1 = (x0 + h, (y0 + y1) / 2), (x1 - h, (y0 + y1) / 2)
    else:
        r0, r1 = ((x0 + x1) / 2, y0 + h), ((x0 + x1) / 2, y1 - h)
    A, B, C, D = (x0, y0, ze), (x1, y0, ze), (x1, y1, ze), (x0, y1, ze)
    R0, R1 = (r0[0], r0[1], zr), (r1[0], r1[1], zr)
    if w >= d:
        faces = [[A, B, R1, R0], [C, D, R0, R1], [D, A, R0], [B, C, R1]]
    else:
        faces = [[B, C, R1, R0], [D, A, R0, R1], [A, B, R0], [C, D, R1]]
    for q in faces:
        q = [np.array(p, float) for p in q]
        if np.cross(q[1] - q[0], q[2] - q[0])[2] < 0:
            q = q[::-1]
        W.face(q, mat, (1, 1, 1), name)
        W.face([p - (0, 0, 0.18) for p in q[::-1]], 'wood', (0.55, 0.45, 0.36), name)
        if snow:
            c = sum(q) / len(q)
            nrm = np.cross(q[1] - q[0], q[2] - q[0])
            nrm /= np.linalg.norm(nrm)
            W.face([c + (p - c) * 0.97 + nrm * SNOW * 0.9 for p in q], 'snow_soft', name='snow_soft_roofs')
    # eaves fascia
    for a, b in ((A, B), (B, C), (C, D), (D, A)):
        a, b = np.array(a), np.array(b)
        W.face([b, a, a - (0, 0, 0.18), b - (0, 0, 0.18)], 'wood', DARK, name)
    return zr


def japanese_wall(W, f, L, z0, z1, rnd, windows=True, shoji=True):
    """A wall of frame f from u=0 to L facing -n: posts, dark boards below, white plaster above, lattice windows."""
    geom.box(W, f, 0, L, 0, 0.2, z0, z1, 'plaster', (0.96, 0.95, 0.92), 'onsen')
    geom.box(W, f, 0, L, -0.03, 0.0, z0, z0 + 1.0, 'wood_cedar', (0.55, 0.45, 0.38), 'onsen')
    n = max(1, int(round(L / 1.8)))
    for i in range(n + 1):
        u = L * i / n
        geom.box(W, f, u - 0.1, u + 0.1, -0.08, 0.0, z0, z1, 'wood', POST, 'onsen')
    geom.box(W, f, 0, L, -0.08, 0.0, z1 - 0.2, z1, 'wood', POST, 'onsen')
    if windows:
        for i in range(n):
            if rnd.random() < 0.3:
                continue
            u0, u1 = L * i / n + 0.35, L * (i + 1) / n - 0.35
            if shoji:
                W.face([f.p(u0, -0.01, z0 + 1.15), f.p(u1, -0.01, z0 + 1.15), f.p(u1, -0.01, z1 - 0.45),
                        f.p(u0, -0.01, z1 - 0.45)], 'shoji', (1, 1, 1), 'onsen')
            for k in range(int((u1 - u0) / 0.12) + 1):
                uu = u0 + k * 0.12
                geom.box(W, f, uu - 0.015, uu + 0.015, -0.06, -0.01, z0 + 1.15, z1 - 0.45, 'wood', DARK, 'onsen')
            geom.box(W, f, u0, u1, -0.06, -0.01, z0 + 1.1, z0 + 1.15, 'wood', DARK, 'onsen')
            geom.box(W, f, u0, u1, -0.06, -0.01, z1 - 0.45, z1 - 0.4, 'wood', DARK, 'onsen')


def inn(W, rnd):
    # plinth and veranda
    x0, y0, x1, y1 = ON['inn']
    f0 = geom.Frame((0, 0, 0), (1, 0))
    geom.box(W, f0, x0, x1, y0, y1, 0, FLOOR - 0.02, 'stone', (0.85, 0.83, 0.8), 'onsen')
    W.face([(x0, y0, FLOOR - 0.01), (x1, y0, FLOOR - 0.01), (x1, y1, FLOOR - 0.01), (x0, y1, FLOOR - 0.01)], 'wood_deck',
           (0.75, 0.62, 0.5), 'onsen')
    # walls of both storeys on the four sides (the door gap on the north, the passage to the changing room south)
    dx = ON['door_x']
    cm, cw = plan.changing_door('m'), plan.changing_door('w')
    sides = [((BX0, BY1), (BX1, BY1), [(dx - 1.6, dx + 1.6)]),     # north, facing north
             ((BX1, BY0), (BX0, BY0), [(cm - 1.0, cm + 1.0), (cw - 1.0, cw + 1.0)]),     # south
             ((BX1, BY1), (BX1, BY0), []), ((BX0, BY0), (BX0, BY1), [])]
    for (a, b, gaps) in sides:
        a, b = np.array(a, float), np.array(b, float)
        L = float(np.linalg.norm(b - a))
        t = (b - a) / L
        f = geom.Frame((a[0], a[1], 0), t)
        if np.dot(f.n[:2], (a + b) / 2 - ((BX0 + BX1) / 2, (BY0 + BY1) / 2)) > 0:
            f = geom.Frame((b[0], b[1], 0), -t)
        # pieces between the gaps along this frame's u
        cuts = []
        for g0, g1 in gaps:
            us = sorted([float(np.dot(np.array(p) - f.o[:2], f.t[:2])) for p in
                         ((g0, a[1]) if abs(t[0]) > 0.5 else (a[0], g0), (g1, a[1]) if abs(t[0]) > 0.5 else (a[0], g1))])
            cuts.append(us)
        u = 0.0
        for c0, c1 in sorted(cuts) + [(L, L)]:
            if c0 - u > 0.05:
                japanese_wall(W, f.sub(u, 0, FLOOR), c0 - u, 0, H1 - FLOOR, rnd)
            if c1 > c0:
                geom.box(W, f, c0, c1, 0, 0.2, 2.5, H1, 'plaster', (0.96, 0.95, 0.92), 'onsen')
                geom.box(W, f, c0 - 0.12, c0 + 0.0, -0.1, 0.2, FLOOR, H1, 'wood', POST, 'onsen')
                geom.box(W, f, c1, c1 + 0.12, -0.1, 0.2, FLOOR, H1, 'wood', POST, 'onsen')
            u = c1
        japanese_wall(W, f.sub(0, 0, H1 + 0.6), L, 0, H2, rnd)
    # the lower roof between the storeys and the hipped roof on top
    hip_roof(W, BX0, BY0, BX1, BY1, H1 + 0.6, 26, 1.3, name='roofs')
    zr = hip_roof(W, BX0 + 0.6, BY0 + 0.6, BX1 - 0.6, BY1 - 0.6, H1 + 0.6 + H2, 30, 1.4, name='roofs')
    # inside: ceiling and lights
    W.face([(BX0, BY0, H1), (BX0, BY1, H1), (BX1, BY1, H1), (BX1, BY0, H1)], 'wood', (0.85, 0.75, 0.62), 'onsen')
    for x in np.arange(LX0 + 3, LX1 - 1, 5.0):
        for y in (LY0 + 4, LY1 - 4):
            geom.box(W, f0, x - 0.4, x + 0.4, y - 0.4, y + 0.4, H1 - 0.35, H1 - 0.01, 'shoji', (1, 1, 1), 'onsen')
    # front desk with a bell and a vase, a bench, tatami by the window
    desk, benchp = walk.inn_furniture()
    xs, ys = [p[0] for p in desk], [p[1] for p in desk]
    geom.box(W, f0, min(xs), max(xs), min(ys), max(ys), FLOOR, FLOOR + 1.0, 'wood', (0.6, 0.42, 0.3), 'onsen')
    geom.box(W, f0, min(xs) - 0.05, max(xs) + 0.05, min(ys) - 0.05, max(ys) + 0.05, FLOOR + 1.0, FLOOR + 1.05,
             'wood', DARK, 'onsen')
    geom.cylinder(W, (min(xs) + max(xs)) / 2, min(ys) + 1.0, FLOOR + 1.05, FLOOR + 1.45, 0.1, 'paint',
                  (0.3, 0.35, 0.5), 'onsen', seg=8, r1=0.06)
    xs, ys = [p[0] for p in benchp], [p[1] for p in benchp]
    geom.box(W, f0, min(xs), max(xs), min(ys), max(ys), FLOOR + 0.4, FLOOR + 0.46, 'wood', (0.7, 0.55, 0.4), 'onsen')
    for x in (min(xs) + 0.1, max(xs) - 0.1):
        geom.box(W, f0, x - 0.05, x + 0.05, min(ys) + 0.05, max(ys) - 0.05, FLOOR, FLOOR + 0.4, 'wood', DARK, 'onsen')
    # entrance porch with a curved-looking gable roof, the noren, lanterns and the sign
    pz = 3.0
    for s in (-1, 1):
        geom.cylinder(W, dx + s * 1.9, y1 + 1.2, FLOOR, pz, 0.12, 'wood', POST, 'onsen', seg=8)
    # its gable roof runs out from the wall over the posts, the ridge along y
    ya, yb = BY1 - 0.2, y1 + 2.0
    for side in (-1, 1):
        xe = dx + side * 2.6
        q = [np.array(p, float) for p in
             ((xe, ya, pz + 0.1), (xe, yb, pz + 0.1), (dx, yb, pz + 1.3), (dx, ya, pz + 1.3))]
        if np.cross(q[1] - q[0], q[2] - q[0])[2] < 0:
            q = q[::-1]
        W.face(q, 'roof_kawara', (1, 1, 1), 'roofs')
        W.face([p - (0, 0, 0.15) for p in q[::-1]], 'wood', (0.6, 0.5, 0.4), 'roofs')
        c = sum(q) / 4
        W.face([c + (p - c) * 0.96 + (0, 0, SNOW * 0.9) for p in q], 'snow_soft', name='snow_soft_roofs')
    # the sign under the porch gable, facing north
    from .shops import textured
    sf = geom.Frame((dx, y1 + 0.2, 0), (-1, 0))
    textured(W, sf, -1.5, 1.5, -0.32, pz - 0.65, pz + 0.1, 'sign_onsen', -1)
    # noren across the door
    nf = geom.Frame((dx, BY1 + 0.25, 0), (-1, 0))
    for side in (-1, 1):
        textured(W, nf, -1.5, 1.5, side * 0.01, 1.35, 2.45, 'sign_noren', side)
    geom.box(W, nf, -1.6, 1.6, -0.03, 0.03, 2.45, 2.5, 'wood', DARK, 'onsen')
    # paper lanterns either side
    for s in (-1, 1):
        x, y = dx + s * 2.4, y1 + 0.6
        geom.cylinder(W, x, y, 1.6, 2.3, 0.26, 'lamp', (1, 1, 1), 'lamps', seg=10, r1=0.26)
        geom.cylinder(W, x, y, 2.3, 2.38, 0.18, 'wood', DARK, 'lamps', seg=10)
        geom.cylinder(W, x, y, 1.52, 1.6, 0.18, 'wood', DARK, 'lamps', seg=10)
    return zr


def changing_room(W, rnd, sex):
    """A changing room (脱衣所) off the lobby: tatami, cypress walls, shelves of baskets, a noren at each door (男 in
    indigo for the men's, 女 in red for the women's) and a board saying which it is."""
    a, b, c, d = ON['changing_' + sex]
    f0 = geom.Frame((0, 0, 0), (1, 0))
    t = 0.25
    cx = plan.changing_door(sex)
    H = 3.0
    WALL = (0.96, 0.95, 0.92)
    W.face([(a, b, FLOOR - 0.01), (c, b, FLOOR - 0.01), (c, d, FLOOR - 0.01), (a, d, FLOOR - 0.01)], 'tatami_mat',
           (1, 1, 1), 'onsen', tile=1.82)
    # walls: west, east, south (door onto the baths), north (door to the passage)
    geom.box(W, f0, a - t, a, b - t, d + t, 0, H, 'plaster', WALL, 'onsen')
    geom.box(W, f0, c, c + t, b - t, d + t, 0, H, 'plaster', WALL, 'onsen')
    for (y0, y1) in ((b - t, b), (d, d + t)):
        geom.box(W, f0, a, cx - 1.0, y0, y1, 0, H, 'plaster', WALL, 'onsen')
        geom.box(W, f0, cx + 1.0, c, y0, y1, 0, H, 'plaster', WALL, 'onsen')
        geom.box(W, f0, cx - 1.0, cx + 1.0, y0, y1, 2.4, H, 'plaster', WALL, 'onsen')
    # cypress wainscot inside
    for (x0, x1, y0, y1) in ((a, c, b, b + 0.03), (a, c, d - 0.03, d), (a, a + 0.03, b, d), (c - 0.03, c, b, d)):
        geom.box(W, f0, x0, x1, y0, y1, 0, FLOOR + 1.1, 'wood_hinoki', (1, 1, 1), 'onsen')
    # the passage from the lobby
    for x in (cx - 1.25, cx + 1.0):
        geom.box(W, f0, x, x + 0.25, d + t, BY0, 0, H1, 'plaster', WALL, 'onsen')
    W.face([(cx - 1.0, d, H1 - 0.4), (cx - 1.0, BY0, H1 - 0.4), (cx + 1.0, BY0, H1 - 0.4), (cx + 1.0, d, H1 - 0.4)],
           'wood_hinoki', (0.9, 0.85, 0.8), 'onsen')
    W.face([(cx - 1.0, d, FLOOR - 0.01), (cx + 1.0, d, FLOOR - 0.01), (cx + 1.0, BY0, FLOOR - 0.01),
            (cx - 1.0, BY0, FLOOR - 0.01)], 'wood_hinoki', (0.85, 0.78, 0.7), 'onsen')
    W.face([(a, b, H), (a, d, H), (c, d, H), (c, b, H)], 'wood_hinoki', (0.95, 0.9, 0.85), 'onsen')
    for y in (b + 2.5, d - 2.5):
        geom.box(W, f0, cx - 0.5, cx + 0.5, y - 0.5, y + 0.5, H - 0.25, H - 0.01, 'shoji', (1, 1, 1), 'onsen')
    hip_roof(W, a - t, b - t, c + t, d + t, H, 25, 0.8, name='roofs')
    # shelves with baskets
    for poly in walk.changing_furniture(sex):
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        for z in (FLOOR, FLOOR + 0.6, FLOOR + 1.2, FLOOR + 1.8):
            geom.box(W, f0, x0, x1, y0, y1, z, z + 0.04, 'wood_hinoki', (1, 1, 1), 'onsen')
        for y in np.arange(y0, y1 + 0.01, (y1 - y0) / 4):
            geom.box(W, f0, x0, x1, y - 0.02, y + 0.02, FLOOR, FLOOR + 1.84, 'wood_hinoki', (0.9, 0.85, 0.8), 'onsen')
        for z in (FLOOR + 0.04, FLOOR + 0.64, FLOOR + 1.24):
            for y in np.arange(y0 + (y1 - y0) / 8, y1, (y1 - y0) / 4):
                col = (0.82, 0.68, 0.45) if rnd.random() < 0.8 else (0.85, 0.85, 0.9)
                geom.box(W, f0, x0 + 0.06, x1 - 0.06, y - 0.32, y + 0.32, z, z + 0.32, 'wood', col, 'onsen',
                         skip=('top',))
                if rnd.random() < 0.35:   # a folded towel in the basket
                    geom.box(W, f0, x0 + 0.12, x1 - 0.12, y - 0.22, y + 0.22, z + 0.12, z + 0.24, 'cloth',
                             (0.97, 0.97, 0.95), 'onsen')
    # a bench down the middle
    geom.box(W, f0, cx - 2.2, cx + 2.2, (b + d) / 2 - 0.25, (b + d) / 2 + 0.25, FLOOR + 0.38, FLOOR + 0.44,
             'wood_hinoki', (1, 1, 1), 'onsen')
    for x in (cx - 2.0, cx + 2.0):
        geom.box(W, f0, x - 0.05, x + 0.05, (b + d) / 2 - 0.2, (b + d) / 2 + 0.2, FLOOR, FLOOR + 0.38, 'wood', DARK,
                 'onsen')
    from .shops import textured
    noren_mat = 'sign_noren_' + sex
    # noren at both doors, and boards beside them
    for (yy, out) in ((b - t - 0.05, -1), (BY0 + 0.06, 1)):
        nf = geom.Frame((cx, yy, 0), (1, 0))
        for side in (-1, 1):
            textured(W, nf, -1.0, 1.0, side * 0.01, 1.4, 2.35, noren_mat, side)
        geom.box(W, nf, -1.1, 1.1, -0.03, 0.03, 2.35, 2.4, 'wood', DARK, 'onsen')
    textured(W, f0, cx + 1.3, cx + 1.9, b - t - 0.02, 1.0, 2.2, 'sign_onsen_board_' + sex, -1)
    textured(W, f0, cx + 1.2, cx + 1.8, BY0 - 0.04, 1.0, 2.2, 'sign_onsen_board_' + sex, 1)
    # a hinoki low table with a jug of water and cups, and a fan (seen through the doors)
    geom.box(W, f0, c - 2.2, c - 1.0, d - 1.0, d - 0.4, FLOOR, FLOOR + 0.7, 'wood_hinoki', (1, 1, 1), 'onsen')
    geom.cylinder(W, c - 1.6, d - 0.7, FLOOR + 0.7, FLOOR + 0.95, 0.08, 'glass_shop', (1, 1, 1), 'onsen', seg=8)


def garden(W, rnd):
    """The ground of the baths' garden: pebbles everywhere but the pools, stepping stones from both doors along
    the north and down to each bath's steps, moss under the trees; trodden snow in winter."""
    a, b, c, d = ON['deck']
    z = ON['deck_h']
    holes = [walk.offset_poly(np.array(p['outline'], float), 0.3) for p in ON['pools']]
    step = 1.0
    xs = np.arange(a, c, step)
    ys = np.arange(b, d, step)
    X, Y = np.meshgrid(xs + step / 2, ys + step / 2)
    inside = np.zeros(X.shape, bool)
    for h in holes:
        inside |= plan._inside_poly(X, Y, h)
    for j in range(len(ys)):
        for i in range(len(xs)):
            if inside[j, i]:
                continue
            x0, y0 = xs[i], ys[j]
            q = [(x0, y0, z), (x0 + step, y0, z), (x0 + step, y0 + step, z), (x0, y0 + step, z)]
            W.face(q, 'pebbles', (1, 1, 1), 'onsen_garden')
            W.face([(p[0], p[1], z + TROD * 0.6) for p in q], 'snow_trod', name='snow_trod_onsen')
    # stepping stones
    path = [(10.5, -142.3), (62.0, -142.3)]
    stones = []
    for x in np.arange(path[0][0], path[1][0], 0.95):
        stones.append((x + rnd.uniform(-0.1, 0.1), path[0][1] + rnd.uniform(-0.15, 0.15)))
    for sex in ('m', 'w'):
        cx = plan.changing_door(sex)
        stones += [(cx + rnd.uniform(-0.15, 0.15), -140.6), (cx + rnd.uniform(-0.15, 0.15), -141.45)]
    for p in ON['pools']:
        sx0, sx1 = p['steps']
        top = walk.bath_steps(p)[0][1]
        for y in np.arange(-143.25, top, -0.9):
            stones.append(((sx0 + sx1) / 2 + rnd.uniform(-0.2, 0.2), y))
    for (x, y) in stones:
        r = rnd.uniform(0.34, 0.46)
        n = 7
        ang0 = rnd.uniform(0, 1)
        pts = [(x + math.cos(2 * math.pi * (k + ang0) / n) * r * rnd.uniform(0.85, 1.1),
                y + math.sin(2 * math.pi * (k + ang0) / n) * r * rnd.uniform(0.85, 1.1)) for k in range(n)]
        g = rnd.uniform(0.72, 0.9)
        geom.prism(W, geom.Frame((0, 0, 0), (1, 0)), pts, z - 0.02, z + 0.05, 'stone_onsen', (g, g, g * 0.97),
                   'onsen_garden', tile=3.0)
    # moss under the garden's trees
    for (x, y) in [(9.6, -144.5), (31.2, -146.2), (63.0, -144.2), (36.5, -156.6), (9.4, -147.8), (31.0, -155.2),
                   (27.5, -156.8)]:
        pts = [(x + math.cos(t) * 1.6 * rnd.uniform(0.8, 1.15), y + math.sin(t) * 1.6 * rnd.uniform(0.8, 1.15),
                z + 0.015) for t in np.linspace(0, 2 * math.pi, 12, endpoint=False)]
        geom.tri_fan(W, pts, 'grass', (0.75, 0.85, 0.6), 'onsen_moss')
    # low shrubs (azaleas) along the fences and between the baths
    for (x, y, r) in [(8.8, -151.5, 0.8), (8.9, -153.6, 0.7), (33.0, -150.5, 0.9), (34.5, -147.8, 0.7),
                      (63.0, -147.3, 0.7), (25.0, -157.2, 0.8), (40.0, -157.3, 0.8), (47.0, -157.2, 0.7)]:
        shrub(W, x, y, r, z, rnd)


def shrub(W, x, y, r, z, rnd):
    """A clipped round shrub: a squat dome of hedge."""
    rings = [(r, z), (r * 1.05, z + r * 0.45), (r * 0.8, z + r * 0.85), (r * 0.35, z + r * 1.05)]
    n = 10
    pts = [[(x + math.cos(2 * math.pi * k / n) * rr, y + math.sin(2 * math.pi * k / n) * rr, zz) for k in range(n)]
           for (rr, zz) in rings]
    col = (0.62 + rnd.uniform(-0.08, 0.08), 0.72, 0.6)
    for lo, hi in zip(pts[:-1], pts[1:]):
        for k in range(n):
            j = (k + 1) % n
            W.face([lo[k], lo[j], hi[j], hi[k]], 'hedge', col, 'hedges')
    W.face(pts[-1], 'hedge', col, 'hedges')


def bath(W, rnd, pool):
    """One open-air bath: the water (milky or clear), its floor (pale stone, or pebbles that show through the clear
    water), walls of stacked stone, mossy boulders round the rim but at the steps, and stone steps down."""
    P = np.array(pool['outline'], float)
    zw, zf = ON['water'], ON['floor']
    c = P.mean(0)
    inner = np.array(walk.offset_poly(P, 0.1))
    area = np.sum(inner[:, 0] * np.roll(inner[:, 1], -1) - np.roll(inner[:, 0], -1) * inner[:, 1])
    if area < 0:
        inner = inner[::-1]
    clear = pool['kind'] == 'clear'
    water = 'water_onsen_clear' if clear else 'water_onsen'
    for i in range(len(inner)):
        p, q = inner[i], inner[(i + 1) % len(inner)]
        W.face([(c[0], c[1], zw), (p[0], p[1], zw), (q[0], q[1], zw)], water, name='water_onsen_' + pool['id'])
        W.face([(c[0], c[1], zf), (p[0], p[1], zf), (q[0], q[1], zf)], 'pebbles' if clear else 'stone_onsen',
               (0.9, 0.9, 0.88) if clear else (0.5, 0.52, 0.5), 'onsen_bath')
        W.face([(q[0], q[1], zf), (p[0], p[1], zf), (p[0], p[1], ON['deck_h']), (q[0], q[1], ON['deck_h'])],
               'stone_wall_jp', (0.85, 0.85, 0.82), 'onsen_bath')
    # stone steps down on the north side
    f0 = geom.Frame((0, 0, 0), (1, 0))
    sx0, sx1 = pool['steps']
    for (y0, y1, h) in walk.bath_steps(pool):
        geom.box(W, f0, sx0, sx1, y0, y1 + 0.5, zf, h, 'stone_path', (0.95, 0.93, 0.9), 'onsen_bath')
    # boulders round the rim (not at the steps), now and then a big one
    rs = geom.resample(np.vstack([P, P[:1]]), 0.8)
    for i, (x, y) in enumerate(rs[:-1]):
        if sx0 - 0.5 < x < sx1 + 0.5 and y > c[1]:
            continue
        o = np.array([x, y]) - c
        o /= np.linalg.norm(o)
        big = rnd.random() < 0.18
        r = rnd.uniform(0.55, 0.8) if big else rnd.uniform(0.35, 0.55)
        h = rnd.uniform(0.45, 0.85) if big else rnd.uniform(0.12, 0.42)
        rock(W, x + o[0] * (0.2 + r * 0.3), y + o[1] * (0.2 + r * 0.3), r, -0.35, ON['deck_h'] + h, rnd,
             math.atan2(o[1], o[0]))


def spout(W, rnd, sp):
    """かけ流し: hot water from a bamboo pipe out of a rock, or over the lip of a carved stone channel, falling into
    a bath all the time. The falling water is its own mesh (water_onsen_fall, flowing in the browser: nature/city.ts),
    its v coordinate the distance along the stream."""
    x, y, r = sp['rock']
    a = np.array(sp['from'], float)
    b = np.array(sp['to'], float)
    d = (b - a)[:2]
    d /= np.linalg.norm(d)
    if sp['kind'] == 'bamboo':
        rock(W, x, y, r, -0.3, a[2] + 0.15, rnd, math.atan2(d[1], d[0]))
        L = float(np.linalg.norm((b - a)[:2]))
        pf = geom.Frame((a[0], a[1], 0), d)
        # the pipe, sloping a little down to its mouth, and a joint
        for k in range(8):
            u0, u1 = L * k / 8, L * (k + 1) / 8
            z0 = a[2] + (b[2] - a[2]) * k / 8
            z1 = a[2] + (b[2] - a[2]) * (k + 1) / 8
            for j in range(6):
                t0, t1 = 2 * math.pi * j / 6, 2 * math.pi * (j + 1) / 6
                q = [pf.p(u0, math.cos(t0) * 0.06, z0 + math.sin(t0) * 0.06),
                     pf.p(u1, math.cos(t0) * 0.06, z1 + math.sin(t0) * 0.06),
                     pf.p(u1, math.cos(t1) * 0.06, z1 + math.sin(t1) * 0.06),
                     pf.p(u0, math.cos(t1) * 0.06, z0 + math.sin(t1) * 0.06)]
                W.face(q[::-1], 'wood', BAMBOO, 'onsen_bath')
        geom.box(W, pf, L * 0.45, L * 0.45 + 0.05, -0.07, 0.07, (a[2] + b[2]) / 2 - 0.07, (a[2] + b[2]) / 2 + 0.07,
                 'wood', tuple(c * 0.85 for c in BAMBOO), 'onsen_bath')
        # a post holding it up
        geom.box(W, pf, L * 0.7, L * 0.7 + 0.08, -0.04, 0.04, 0.0, a[2] + (b[2] - a[2]) * 0.7 - 0.06, 'wood',
                 (0.55, 0.42, 0.3), 'onsen_bath')
        fall(W, b + np.array([d[0] * 0.02, d[1] * 0.02, 0]), d, 0.9, 0.05, round_=True)
    else:
        # a block of stone with a channel cut in its top; the water spills over its lip in a thin sheet
        f = geom.Frame((a[0], a[1], 0), d)
        L = float(np.linalg.norm((b - a)[:2]))
        rock(W, x - d[0] * 0.3, y - d[1] * 0.3, r, -0.3, a[2] + 0.35, rnd, math.atan2(d[1], d[0]))
        geom.box(W, f, -0.1, L, -0.32, 0.32, -0.3, b[2] - 0.04, 'stone_wall_jp', (0.8, 0.8, 0.78), 'onsen_bath')
        for side in (-1, 1):
            geom.box(W, f, -0.1, L, side * 0.32 - 0.1 * (side > 0), side * 0.32 + 0.1 * (side < 0), b[2] - 0.04,
                     b[2] + 0.1, 'stone_wall_jp', (0.8, 0.8, 0.78), 'onsen_bath')
        # the water running along the channel, then falling
        W.face([f.p(-0.1, -0.22, b[2] - 0.02), f.p(L, -0.22, b[2] - 0.02), f.p(L, 0.22, b[2] - 0.02),
                f.p(-0.1, 0.22, b[2] - 0.02)], 'water_onsen_fall', name='water_onsen_fall',
               uv=[(0, -L - 0.1), (0, 0), (1, 0), (1, -L - 0.1)])
        fall(W, b + np.array([0, 0, -0.02]), d, 0.6, 0.22)


def fall(W, mouth, d, speed, half, round_=False):
    """Water leaving `mouth` (x, y, z) at `speed` m/s along d (xy) and falling to the bath's surface: a sheet
    `half` wide either side (and a second, crossing one for a round stream). UV: u across, v metres along."""
    zw = ON['water']
    g = 9.8
    T = (-0.0 + math.sqrt(2 * g * (mouth[2] - zw))) / g
    n = 10
    pts, vs = [], []
    s = 0.0
    for i in range(n + 1):
        t = T * i / n
        p = np.array([mouth[0] + d[0] * speed * t, mouth[1] + d[1] * speed * t, mouth[2] - 0.5 * g * t * t])
        if pts:
            s += float(np.linalg.norm(p - pts[-1]))
        pts.append(p)
        vs.append(s)
    nrm = np.array([-d[1], d[0], 0.0])
    sides = [nrm] if not round_ else [nrm, None]
    for side in sides:
        for i in range(n):
            p0, p1 = pts[i], pts[i + 1]
            if side is None:
                # across the stream, perpendicular to it and to nrm
                tan = (p1 - p0) / max(1e-6, np.linalg.norm(p1 - p0))
                w = np.cross(tan, nrm)
            else:
                w = side
            spread = 1.0 + 0.6 * i / n     # the stream widens a little as it falls
            q = [p0 - w * half * spread, p0 + w * half * spread, p1 + w * half * (spread + 0.06),
                 p1 - w * half * (spread + 0.06)]
            uv = [(0, vs[i]), (1, vs[i]), (1, vs[i + 1]), (0, vs[i + 1])]
            W.face(q, 'water_onsen_fall', name='water_onsen_fall', uv=uv)   # seen from both sides


def rock(W, x, y, r, z0, z1, rnd, a, mat='rock_mossy'):
    """A rough rock: three jittered rings of eight (the foot, a bulging middle, a smaller sloping top), a little
    longer than wide, slightly varied in colour."""
    f = geom.Frame((x, y, 0), (math.cos(a), math.sin(a)))
    n = 8
    stretch = rnd.uniform(1.0, 1.35)
    tilt = rnd.uniform(-0.12, 0.12)
    col = tuple(c * rnd.uniform(0.85, 1.05) for c in (0.95, 0.92, 0.88))

    def ring(scale, z, jit):
        out = []
        for i in range(n):
            ang = 2 * math.pi * (i + rnd.uniform(-0.2, 0.2)) / n
            rr = r * scale * rnd.uniform(1 - jit, 1 + jit)
            u, v = math.cos(ang) * rr * stretch, math.sin(ang) * rr
            out.append(np.array(f.p(u, v, z + tilt * u + rnd.uniform(-0.05, 0.05)), float))
        return out

    zm = z0 + (z1 - z0) * rnd.uniform(0.5, 0.65)
    rings = [ring(0.95, z0, 0.12), ring(1.08, zm, 0.14), ring(0.62, z1, 0.18)]
    for lo, hi in zip(rings[:-1], rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            W.face([lo[i], lo[j], hi[j]], mat, col, 'rocks')
            W.face([lo[i], hi[j], hi[i]], mat, col, 'rocks')
    top = rings[-1]
    c = sum(top) / n + np.array([0, 0, rnd.uniform(0.0, 0.08)])
    for i in range(n):
        W.face([c, top[i], top[(i + 1) % n]], mat, col, 'rocks')
        W.face([c + (0, 0, SNOW * 0.7), top[i] + (c - top[i]) * 0.15 + (0, 0, SNOW * 0.35),
                top[(i + 1) % n] + (c - top[(i + 1) % n]) * 0.15 + (0, 0, SNOW * 0.35)], 'snow_soft',
               name='snow_soft_things')


def fence(W, a, b, h=2.2):
    """A bamboo screen from a to b (xy): posts, rails and a panel of close canes (bamboo_wall) on both sides."""
    a, b = np.array(a, float), np.array(b, float)
    L = float(np.linalg.norm(b - a))
    f = geom.Frame((a[0], a[1], 0), b - a)
    n = max(1, int(L / 1.8))
    for i in range(n + 1):
        u = L * i / n
        geom.cylinder(W, *f.p(u, 0, 0)[:2], 0, h + 0.1, 0.07, 'wood', (0.55, 0.42, 0.3), 'fences', seg=6)
    for z in (0.4, h - 0.3):
        geom.box(W, f, 0, L, -0.09, -0.05, z, z + 0.05, 'wood', BAMBOO, 'fences')
        geom.box(W, f, 0, L, 0.05, 0.09, z, z + 0.05, 'wood', BAMBOO, 'fences')
    for side in (-1, 1):
        q = [f.p(0, side * 0.03, 0.05), f.p(L, side * 0.03, 0.05), f.p(L, side * 0.03, h), f.p(0, side * 0.03, h)]
        W.face(q if side < 0 else q[::-1], 'bamboo', (1, 1, 1), 'fences')
    geom.box(W, f, 0, L, -0.05, 0.05, h, h + SNOW * 0.5, 'snow_soft', (1, 1, 1), 'snow_soft_things')


def arbour(W):
    """An arbour (東屋) over the small bath."""
    posts = plan.ONSEN_POSTS
    for (x, y) in posts:
        geom.cylinder(W, x, y, 0, 3.0, 0.13, 'wood_cedar', POST, 'arbour', seg=8)
    xs = [p[0] for p in posts]
    ys = [p[1] for p in posts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    f0 = geom.Frame((0, 0, 0), (1, 0))
    geom.box(W, f0, x0 - 0.2, x1 + 0.2, y1 - 0.15, y1 + 0.15, 2.85, 3.1, 'wood_cedar', DARK, 'arbour')
    geom.box(W, f0, x0 - 0.2, x1 + 0.2, y0 - 0.15, y0 + 0.15, 2.85, 3.1, 'wood_cedar', DARK, 'arbour')
    geom.box(W, f0, x0 - 0.15, x0 + 0.15, y0, y1, 2.85, 3.1, 'wood_cedar', DARK, 'arbour')
    geom.box(W, f0, x1 - 0.15, x1 + 0.15, y0, y1, 2.85, 3.1, 'wood_cedar', DARK, 'arbour')
    hip_roof(W, x0, y0, x1, y1, 3.1, 28, 1.0, name='roofs')


def toro(W, x, y, z=0.12):
    """A stone lantern (灯籠) with a light inside."""
    geom.cylinder(W, x, y, z, z + 0.25, 0.32, 'stone', (0.8, 0.8, 0.78), 'lanterns', seg=6)
    geom.cylinder(W, x, y, z + 0.25, z + 1.0, 0.12, 'stone', (0.8, 0.8, 0.78), 'lanterns', seg=6)
    geom.cylinder(W, x, y, z + 1.0, z + 1.12, 0.3, 'stone', (0.8, 0.8, 0.78), 'lanterns', seg=6)
    geom.cylinder(W, x, y, z + 1.12, z + 1.45, 0.2, 'lamp', (1, 1, 1), 'lanterns', seg=6)
    geom.cylinder(W, x, y, z + 1.45, z + 1.75, 0.42, 'stone', (0.8, 0.8, 0.78), 'lanterns', seg=6, r1=0.08)
    geom.cylinder(W, x, y, z + 1.5, z + 1.72, 0.44, 'snow_soft', (1, 1, 1), 'snow_soft_things', seg=6, r1=0.15)


def buckets(W, x, y):
    """Wooden buckets stacked on stools, by the changing room door."""
    for k, (dx, dy) in enumerate([(0, 0), (0.45, 0.0)]):
        geom.cylinder(W, x + dx, y + dy, 0.12, 0.42, 0.18, 'wood', (0.85, 0.7, 0.5), 'onsen', seg=10)
        for m in range(3):
            geom.cylinder(W, x + dx, y + dy, 0.42 + m * 0.2, 0.62 + m * 0.2, 0.17, 'wood', (0.9, 0.75, 0.55),
                          'onsen', seg=10, r1=0.2, top=False)


def build(W):
    rnd = random.Random(9)
    inn(W, rnd)
    for sex in ('m', 'w'):
        changing_room(W, rnd, sex)
    garden(W, rnd)
    for pool in ON['pools']:
        bath(W, rnd, pool)
    for (x, y, r) in walk.bath_rocks():
        rock(W, x, y, r, ON['floor'], 0.4 + r * 0.3, rnd, rnd.uniform(0, 3))
    for (x, y, r) in plan.ONSEN_GARDEN_ROCKS:
        rock(W, x, y, r, 0.0, ON['deck_h'] + r * 1.1, rnd, rnd.uniform(0, 3))
    for sp in walk.SPOUTS:
        spout(W, rnd, sp)
    a, b, c, d = ON['deck']
    fence(W, (a - 1.0, d + 0.2), (a - 1.0, b - 1.0))
    fence(W, (a - 1.0, b - 1.0), (c + 1.0, b - 1.0))
    # a low wall of stacked stone to the east (the view of the mountain), hedges to the north
    f0 = geom.Frame((0, 0, 0), (1, 0))
    geom.box(W, f0, c + 0.4, c + 1.4, b - 1.0, d + 0.3, 0, 0.85, 'stone_wall_jp', (0.95, 0.95, 0.92), 'onsen')
    geom.box(W, f0, c + 0.4, c + 1.4, b - 1.0, d + 0.3, 0.85, 0.85 + SNOW, 'snow_soft', (1, 1, 1), 'snow_soft_things')
    m, w = ON['changing_m'], ON['changing_w']
    for (x0, x1) in ((a - 1.0, m[0] - 0.3), (m[2] + 0.3, w[0] - 0.3), (w[2] + 0.3, c + 1.4)):
        geom.box(W, f0, x0, x1, d + 0.3, d + 1.3, 0, 1.15, 'hedge', (1, 1, 1), 'hedges')
        geom.box(W, f0, x0 + 0.1, x1 - 0.1, d + 0.4, d + 1.2, 1.15, 1.15 + SNOW, 'snow_soft', (1, 1, 1),
                 'snow_soft_things')
    arbour(W)
    for (x, y) in plan.ONSEN_LANTERNS:
        toro(W, x, y)
    bx, by = plan.ONSEN_BUCKETS
    buckets(W, bx, by)
