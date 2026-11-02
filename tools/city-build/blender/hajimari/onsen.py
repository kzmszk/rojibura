"""The onsen inn 「ゆのはな」 at the edge of town: a two-storey wooden inn with a tiled hip roof, noren and
lanterns at the entrance, a lobby, the changing room (脱衣所) with shelves of baskets, and the open-air bath: a
large rock-edged pool in stone paving, an arbour over one end, bamboo fences, stone lanterns and a spout."""
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
    geom.box(W, f, 0, L, -0.03, 0.0, z0, z0 + 1.0, 'wood', DARK, 'onsen')
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
    cx = (ON['changing'][0] + ON['changing'][2]) / 2
    sides = [((BX0, BY1), (BX1, BY1), [(dx - 1.6, dx + 1.6)]),     # north, facing north
             ((BX1, BY0), (BX0, BY0), [(cx - 1.0, cx + 1.0)]),     # south
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


def changing_room(W, rnd):
    a, b, c, d = ON['changing']
    f0 = geom.Frame((0, 0, 0), (1, 0))
    t = 0.25
    cx = (a + c) / 2
    H = 3.0
    W.face([(a, b, FLOOR - 0.01), (c, b, FLOOR - 0.01), (c, d, FLOOR - 0.01), (a, d, FLOOR - 0.01)], 'tatami',
           (1, 1, 1), 'onsen')
    # walls: west, east, south (door to the bath), north (door to the passage)
    geom.box(W, f0, a - t, a, b - t, d + t, 0, H, 'plaster', (0.96, 0.95, 0.92), 'onsen')
    geom.box(W, f0, c, c + t, b - t, d + t, 0, H, 'plaster', (0.96, 0.95, 0.92), 'onsen')
    for (y0, y1) in ((b - t, b), (d, d + t)):
        geom.box(W, f0, a, cx - 1.0, y0, y1, 0, H, 'plaster', (0.96, 0.95, 0.92), 'onsen')
        geom.box(W, f0, cx + 1.0, c, y0, y1, 0, H, 'plaster', (0.96, 0.95, 0.92), 'onsen')
        geom.box(W, f0, cx - 1.0, cx + 1.0, y0, y1, 2.4, H, 'plaster', (0.96, 0.95, 0.92), 'onsen')
    # the passage from the lobby
    for x in (cx - 1.25, cx + 1.0):
        geom.box(W, f0, x, x + 0.25, d + t, BY0, 0, H1, 'plaster', (0.96, 0.95, 0.92), 'onsen')
    W.face([(cx - 1.0, d, H1 - 0.4), (cx - 1.0, BY0, H1 - 0.4), (cx + 1.0, BY0, H1 - 0.4), (cx + 1.0, d, H1 - 0.4)],
           'wood', (0.8, 0.7, 0.6), 'onsen')
    # skirting boards and posts
    for (x0, x1, y0, y1) in ((a, c, b, b + 0.03), (a, c, d - 0.03, d), (a, a + 0.03, b, d), (c - 0.03, c, b, d)):
        geom.box(W, f0, x0, x1, y0, y1, 0, FLOOR + 0.9, 'wood', (0.6, 0.45, 0.33), 'onsen')
    W.face([(a, b, H), (a, d, H), (c, d, H), (c, b, H)], 'wood', (0.85, 0.75, 0.62), 'onsen')
    for y in (b + 2.5, d - 2.5):
        geom.box(W, f0, cx - 0.5, cx + 0.5, y - 0.5, y + 0.5, H - 0.25, H - 0.01, 'shoji', (1, 1, 1), 'onsen')
    hip_roof(W, a - t, b - t, c + t, d + t, H, 25, 0.8, name='roofs')
    # shelves with baskets
    for poly in walk.changing_furniture():
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        for z in (FLOOR, FLOOR + 0.6, FLOOR + 1.2, FLOOR + 1.8):
            geom.box(W, f0, x0, x1, y0, y1, z, z + 0.04, 'wood', (0.75, 0.6, 0.45), 'onsen')
        for y in np.arange(y0, y1 + 0.01, (y1 - y0) / 4):
            geom.box(W, f0, x0, x1, y - 0.02, y + 0.02, FLOOR, FLOOR + 1.84, 'wood', (0.7, 0.55, 0.4), 'onsen')
        for z in (FLOOR + 0.04, FLOOR + 0.64, FLOOR + 1.24):
            for y in np.arange(y0 + (y1 - y0) / 8, y1, (y1 - y0) / 4):
                col = (0.82, 0.68, 0.45) if rnd.random() < 0.8 else (0.85, 0.85, 0.9)
                geom.box(W, f0, x0 + 0.06, x1 - 0.06, y - 0.32, y + 0.32, z, z + 0.32, 'wood', col, 'onsen',
                         skip=('top',))
                if rnd.random() < 0.35:   # a folded towel in the basket
                    geom.box(W, f0, x0 + 0.12, x1 - 0.12, y - 0.22, y + 0.22, z + 0.12, z + 0.24, 'cloth',
                             (0.97, 0.97, 0.95), 'onsen')
    # noren at the bath door and a vertical sign beside it
    nf = geom.Frame((cx, b - t - 0.05, 0), (1, 0))
    from .shops import textured
    for side in (-1, 1):
        textured(W, nf, -1.0, 1.0, side * 0.01, 1.4, 2.35, 'sign_noren', side)
    textured(W, geom.Frame((0, 0, 0), (1, 0)), cx + 1.3, cx + 1.9, b - t - 0.02, 1.0, 2.2, 'sign_onsen_board', -1)


def deck(W):
    a, b, c, d = ON['deck']
    z = ON['deck_h']
    pool = np.array(ON['pool'], float)
    hole = walk.offset_poly(pool, 0.35)
    step = 0.5
    xs = np.arange(a, c, step)
    ys = np.arange(b, d, step)
    X, Y = np.meshgrid(xs + step / 2, ys + step / 2)
    inside = plan._inside_poly(X, Y, hole)
    for j in range(len(ys)):
        for i in range(len(xs)):
            if inside[j, i]:
                continue
            x0, y0 = xs[i], ys[j]
            q = [(x0, y0, z), (x0 + step, y0, z), (x0 + step, y0 + step, z), (x0, y0 + step, z)]
            W.face(q, 'stone_onsen', (1, 1, 1), 'onsen_deck')
            W.face([(p[0], p[1], z + TROD * 0.6) for p in q], 'snow_trod', name='snow_trod_onsen')
    f0 = geom.Frame((0, 0, 0), (1, 0))
    # the deck's raised edge
    for (x0, x1, y0, y1) in ((a - 0.2, c + 0.2, b - 0.2, b), (a - 0.2, c + 0.2, d, d + 0.2), (a - 0.2, a, b, d),
                             (c, c + 0.2, b, d)):
        geom.box(W, f0, x0, x1, y0, y1, 0, z + 0.03, 'stone', (0.85, 0.83, 0.8), 'onsen_deck')


def bath(W, rnd):
    pool = np.array(ON['pool'], float)
    zw, zf = ON['water'], ON['floor']
    c = pool.mean(0)
    inner = np.array(walk.offset_poly(pool, 0.1))
    # counter-clockwise, so the water and the floor face up and the walls face into the bath
    area = np.sum(inner[:, 0] * np.roll(inner[:, 1], -1) - np.roll(inner[:, 0], -1) * inner[:, 1])
    if area < 0:
        inner = inner[::-1]
    for i in range(len(inner)):
        p, q = inner[i], inner[(i + 1) % len(inner)]
        W.face([(c[0], c[1], zw), (p[0], p[1], zw), (q[0], q[1], zw)], 'water_onsen', name='water_onsen')
        W.face([(c[0], c[1], zf), (p[0], p[1], zf), (q[0], q[1], zf)], 'stone_onsen', (0.7, 0.72, 0.7), 'onsen_bath')
        W.face([(q[0], q[1], zf), (p[0], p[1], zf), (p[0], p[1], ON['deck_h']), (q[0], q[1], ON['deck_h'])],
               'rock', (0.75, 0.73, 0.7), 'onsen_bath')
    # steps down on the north side
    f0 = geom.Frame((0, 0, 0), (1, 0))
    sx0, sx1 = walk.BATH_STEP_X
    for (y0, y1, h) in walk.bath_steps():
        geom.box(W, f0, sx0, sx1, y0, y1 + 0.5, zf, h, 'stone_onsen', (0.9, 0.9, 0.88), 'onsen_bath')
    # rocks round the rim (not at the steps)
    rs = geom.resample(np.vstack([pool, pool[:1]]), 0.85)
    for i, (x, y) in enumerate(rs[:-1]):
        if sx0 - 0.4 < x < sx1 + 0.4 and y > -144:
            continue
        o = np.array([x, y]) - c
        o /= np.linalg.norm(o)
        rock(W, x + o[0] * 0.15, y + o[1] * 0.15, rnd.uniform(0.35, 0.55), -0.35,
             ON['deck_h'] + rnd.uniform(0.15, 0.45), rnd, math.atan2(o[1], o[0]))
    for (x, y, r) in walk.bath_rocks():
        rock(W, x, y, r, zf, 0.45 + r * 0.3, rnd, rnd.uniform(0, 3))
    # the spout: a bamboo pipe out of a rock at the west end, its water falling into the bath
    sx, sy = 12.2, -149.0
    rock(W, sx - 1.0, sy, 0.9, -0.3, 1.1, rnd, 0)
    pf = geom.Frame((sx - 0.8, sy, 0), (1, 0))
    geom.box(W, pf, 0, 1.3, -0.06, 0.06, 0.95, 1.07, 'wood', BAMBOO, 'onsen_bath')
    W.face([pf.p(1.25, -0.05, 0.95), pf.p(1.3, -0.05, 0.0), pf.p(1.3, 0.05, 0.0), pf.p(1.25, 0.05, 0.95)],
           'water_onsen', name='water_onsen_spout')
    W.face([pf.p(1.25, 0.05, 0.95), pf.p(1.3, 0.05, 0.0), pf.p(1.3, -0.05, 0.0), pf.p(1.25, -0.05, 0.95)],
           'water_onsen', name='water_onsen_spout')


def rock(W, x, y, r, z0, z1, rnd, a):
    """A rough rock: three jittered rings of eight (the foot, a bulging middle, a smaller sloping top), a little
    longer than wide; its own material, rock, slightly varied in colour."""
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
            W.face([lo[i], lo[j], hi[j]], 'rock', col, 'rocks')
            W.face([lo[i], hi[j], hi[i]], 'rock', col, 'rocks')
    top = rings[-1]
    c = sum(top) / n + np.array([0, 0, rnd.uniform(0.0, 0.08)])
    for i in range(n):
        W.face([c, top[i], top[(i + 1) % n]], 'rock', col, 'rocks')
        W.face([c + (0, 0, SNOW * 0.7), top[i] + (c - top[i]) * 0.15 + (0, 0, SNOW * 0.35),
                top[(i + 1) % n] + (c - top[(i + 1) % n]) * 0.15 + (0, 0, SNOW * 0.35)], 'snow_soft',
               name='snow_soft_things')


def fence(W, a, b, h=2.2):
    """A bamboo fence from a to b (xy): posts, rails and close vertical canes."""
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
    # canes as one panel with a striped look: thin boxes every 6 cm would be heavy; every 12 cm, two faces each
    for k in range(int(L / 0.06)):
        u = k * 0.06 + 0.03
        col = tuple(cc * (0.92 + 0.08 * ((k * 7) % 3) / 2) for cc in BAMBOO)
        for side in (-1, 1):
            q = [f.p(u - 0.028, side * 0.03, 0.05), f.p(u + 0.028, side * 0.03, 0.05), f.p(u + 0.028, side * 0.03, h),
                 f.p(u - 0.028, side * 0.03, h)]
            W.face(q if side < 0 else q[::-1], 'wood', col, 'fences')
    geom.box(W, f, 0, L, -0.05, 0.05, h, h + SNOW * 0.5, 'snow_soft', (1, 1, 1), 'snow_soft_things')


def arbour(W):
    """An arbour (東屋) over the west end of the bath."""
    posts = plan.ONSEN_POSTS
    for (x, y) in posts:
        geom.cylinder(W, x, y, 0, 3.0, 0.13, 'wood', POST, 'arbour', seg=8)
    f0 = geom.Frame((0, 0, 0), (1, 0))
    geom.box(W, f0, 8.8, 22.7, -141.15, -140.85, 2.85, 3.1, 'wood', DARK, 'arbour')
    geom.box(W, f0, 8.8, 22.7, -157.75, -157.45, 2.85, 3.1, 'wood', DARK, 'arbour')
    geom.box(W, f0, 8.85, 9.15, -157.6, -141.0, 2.85, 3.1, 'wood', DARK, 'arbour')
    geom.box(W, f0, 22.35, 22.65, -157.6, -141.0, 2.85, 3.1, 'wood', DARK, 'arbour')
    hip_roof(W, 9.0, -157.6, 22.5, -141.0, 3.1, 28, 1.0, name='roofs')


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
    changing_room(W, rnd)
    deck(W)
    bath(W, rnd)
    a, b, c, d = ON['deck']
    fence(W, (a - 1.0, d + 0.2), (a - 1.0, b - 1.0))
    fence(W, (a - 1.0, b - 1.0), (c + 1.0, b - 1.0))
    # low stone wall to the east (the view of the mountain) and hedges to the north
    f0 = geom.Frame((0, 0, 0), (1, 0))
    geom.box(W, f0, c + 0.4, c + 1.4, b - 1.0, d + 0.3, 0, 0.75, 'stone_wall', (0.95, 0.92, 0.86), 'onsen')
    geom.box(W, f0, c + 0.4, c + 1.4, b - 1.0, d + 0.3, 0.75, 0.75 + SNOW, 'snow_soft', (1, 1, 1), 'snow_soft_things')
    for (x0, x1) in ((a - 1.0, ON['changing'][0] - 0.3), (ON['changing'][2] + 0.3, c + 1.4)):
        geom.box(W, f0, x0, x1, d + 0.3, d + 1.3, 0, 1.15, 'hedge', (1, 1, 1), 'hedges')
        geom.box(W, f0, x0 + 0.1, x1 - 0.1, d + 0.4, d + 1.2, 1.15, 1.15 + SNOW, 'snow_soft', (1, 1, 1),
                 'snow_soft_things')
    arbour(W)
    for (x, y) in plan.ONSEN_LANTERNS:
        toro(W, x, y)
    bx, by = plan.ONSEN_BUCKETS
    buckets(W, bx, by)
