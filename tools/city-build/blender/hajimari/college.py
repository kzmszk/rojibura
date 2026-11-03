"""The college (学校「はじまりカレッジ」), in the manner of Cambridge: a great gate with four octagonal turrets and
the college arms, a court of striped lawns crossed by stone paths (keep off the grass), a chapel like King's
(tall pointed windows between buttresses, pinnacles, a turret at each corner), the library (long reading tables,
bookcases in bays) on the east and the hall of residence (寮) on the west, its common room with a fire."""
import math, random

import numpy as np

from . import geom, houses, plan, walk
from .ground import SNOW, TROD
from .houses import window
from .shops import textured

CO = plan.COLLEGE
ASH = 'stone_college'   # pale stone, weathered (issue 42)
ASHC = (1.0, 1.0, 1.0)
TRIM = (0.92, 0.88, 0.8)          # dressings: mullions, string courses, copings
F0 = geom.Frame((0, 0, 0), (1, 0))


def wall_box(W, x0, y0, x1, y1, z0, z1, mat=ASH, col=ASHC, name='college', skip=()):
    geom.box(W, F0, x0, x1, y0, y1, z0, z1, mat, col, name, skip=skip)


def crenels(W, x0, y0, x1, y1, z, t=0.5, h=0.9, step=1.4):
    """A battlemented parapet round a rectangle (merlons on a low wall), snow on top."""
    for (a, b, horizontal) in (((x0, y0), (x1, y0), True), ((x0, y1), (x1, y1), True), ((x0, y0), (x0, y1), False),
                               ((x1, y0), (x1, y1), False)):
        if horizontal:
            wall_box(W, a[0], a[1] - t / 2, b[0], a[1] + t / 2, z, z + 0.5, ASH, TRIM)
            for u in np.arange(a[0] + 0.2, b[0] - 0.5, step):
                wall_box(W, u, a[1] - t / 2, u + step * 0.5, a[1] + t / 2, z + 0.5, z + h, ASH, TRIM)
                wall_box(W, u, a[1] - t / 2, u + step * 0.5, a[1] + t / 2, z + h, z + h + SNOW * 0.5, 'snow_soft',
                         (1, 1, 1), 'snow_soft_college')
        else:
            wall_box(W, a[0] - t / 2, a[1], a[0] + t / 2, b[1], z, z + 0.5, ASH, TRIM)
            for v in np.arange(a[1] + 0.2, b[1] - 0.5, step):
                wall_box(W, a[0] - t / 2, v, a[0] + t / 2, v + step * 0.5, z + 0.5, z + h, ASH, TRIM)
                wall_box(W, a[0] - t / 2, v, a[0] + t / 2, v + step * 0.5, z + h, z + h + SNOW * 0.5, 'snow_soft',
                         (1, 1, 1), 'snow_soft_college')


def turret(W, x, y, r, h, cap=4.0, pinnacles=True):
    """An octagonal turret with a string course, a battlement-like crown and a pointed cap."""
    geom.cylinder(W, x, y, 0, h, r, ASH, ASHC, 'college', seg=8, top=False, tile=2.0)
    for z in (h * 0.4, h * 0.75):
        geom.cylinder(W, x, y, z, z + 0.2, r + 0.12, ASH, TRIM, 'college', seg=8, top=False)
    geom.cylinder(W, x, y, h, h + 0.6, r + 0.25, ASH, TRIM, 'college', seg=8)
    geom.cylinder(W, x, y, h + 0.6, h + 0.6 + cap, r * 0.85, ASH, TRIM, 'college', seg=8, r1=0.05)
    geom.cylinder(W, x, y, h + 0.62, h + 0.6 + cap * 0.7, r * 0.9, 'snow_soft', (1, 1, 1), 'snow_soft_college',
                  seg=8, top=False, r1=0.25)
    if pinnacles:
        for k in range(8):
            a = 2 * math.pi * (k + 0.5) / 8
            px, py = x + math.cos(a) * (r + 0.1), y + math.sin(a) * (r + 0.1)
            geom.cylinder(W, px, py, h + 0.6, h + 1.6, 0.1, ASH, TRIM, 'college', seg=4, r1=0.02)
    # slit windows
    for k in range(4):
        a = 2 * math.pi * k / 4 + math.pi / 8
        f = geom.Frame((x + math.cos(a) * r * 0.93, y + math.sin(a) * r * 0.93, 0), (-math.sin(a), math.cos(a)))
        for z in (h * 0.3, h * 0.6):
            geom.box(W, f, -0.12, 0.12, -0.03, 0.0, z, z + 1.0, 'glass', (1, 1, 1), 'college')


def tudor_windows(W, f, n, u0, u1, zs, facing, every=3.2, ww=1.4, wh=1.8, skip=()):
    """Rows of mullioned windows in stone dressings along a wall (frame f, wall at depth n)."""
    rnd = random.Random(int(abs(u0 * 7 + n * 13)))
    k = max(1, int((u1 - u0) / every))
    for z in zs:
        for i in range(k):
            u = u0 + (i + 0.5) * (u1 - u0) / k
            if any(abs(u - s) < ww for s in skip) and z < 3:
                continue
            window(W, f, u, n, z, ww, wh, facing, rnd, None, False, TRIM)
            # a hood mould over it
            a0, a1 = sorted((n, n + facing * 0.18))
            geom.box(W, f, u - ww / 2 - 0.25, u + ww / 2 + 0.25, a0, a1, z + wh + 0.12, z + wh + 0.28, ASH, TRIM,
                     'college')


def wall_x(W, x, y0, y1, z0, z1, east, mat=ASH, col=ASHC, hole=None, name='college'):
    """A wall in the plane x = const facing east (or west), with a doorway `hole` = (y centre, width, height)."""
    def quad(ya, yb, za, zb):
        q = [(x, ya, za), (x, yb, za), (x, yb, zb), (x, ya, zb)]
        W.face(q if east else q[::-1], mat, col, name)
    if not hole:
        quad(y0, y1, z0, z1)
        return
    yc, w, h = hole
    quad(y0, yc - w / 2, z0, z1)
    quad(yc + w / 2, y1, z0, z1)
    quad(yc - w / 2, yc + w / 2, h, z1)


def doorway(W, xa, xb, yc, w, h, mat=ASH, col=TRIM):
    """The reveals of a doorway through a thick wall between the planes x = xa and x = xb."""
    xa, xb = sorted((xa, xb))
    W.face([(xa, yc - w / 2, 0), (xb, yc - w / 2, 0), (xb, yc - w / 2, h), (xa, yc - w / 2, h)], mat, col, 'college')
    W.face([(xb, yc + w / 2, 0), (xa, yc + w / 2, 0), (xa, yc + w / 2, h), (xb, yc + w / 2, h)], mat, col, 'college')
    W.face([(xa, yc - w / 2, h), (xb, yc - w / 2, h), (xb, yc + w / 2, h), (xa, yc + w / 2, h)][::-1], mat, col,
           'college')


def range_block(W, x0, y0, x1, y1, h, ridge_x, roof=True, door=None):
    """A college range: ashlar walls, a plinth, a string course, a battlemented parapet and a slate roof.
    `door` = ('x0' or 'x1', y centre, width, height): a doorway through that wall."""
    if door:
        side, yc, w, dh = door
        wall_box(W, x0, y0, x1, y1, 0, h, skip=('top', 'u0' if side == 'x0' else 'u1'))
        wall_x(W, x0 if side == 'x0' else x1, y0, y1, 0, h, side == 'x1', hole=(yc, w, dh))
    else:
        wall_box(W, x0, y0, x1, y1, 0, h, skip=('top',))
    if not door:
        wall_box(W, x0 - 0.15, y0 - 0.15, x1 + 0.15, y1 + 0.15, 0, 0.6, ASH, TRIM, skip=('top',))
    wall_box(W, x0 - 0.1, y0 - 0.1, x1 + 0.1, y1 + 0.1, h * 0.48, h * 0.48 + 0.25, ASH, TRIM)
    crenels(W, x0, y0, x1, y1, h)
    if roof:
        if ridge_x:
            f = geom.Frame(((x0 + x1) / 2, y0, 0), (1, 0))
            houses.roof(W, f, -(x1 - x0) / 2 + 0.4, (x1 - x0) / 2 - 0.4, 0.4, (y1 - y0) - 0.4, h, 32, False,
                        'roof_college', ov=-0.1, ovg=-0.1)
        else:
            f = geom.Frame((x0, (y0 + y1) / 2, 0), (0, 1))
            houses.roof(W, f, -(y1 - y0) / 2 + 0.4, (y1 - y0) / 2 - 0.4, -(x1 - x0) + 0.4, -0.4, h, 32, False,
                        'roof_college', ov=-0.1, ovg=-0.1)


def chimneys(W, xs, ys, z0, z1):
    for x in xs:
        for y in ys:
            wall_box(W, x - 0.5, y - 0.35, x + 0.5, y + 0.35, z0, z1, 'stone_blocks', (0.8, 0.72, 0.62))
            for dx in (-0.25, 0.25):
                geom.cylinder(W, x + dx, y, z1, z1 + 0.6, 0.14, 'stone_blocks', (0.7, 0.55, 0.45), 'college', seg=6)


def gate_range(W):
    x0, y0, x1, y1 = CO['precinct'][0], CO['south'][0], CO['precinct'][2], CO['south'][1]
    gx, ghw = CO['gate']
    h = 8.0
    # the ranges either side of the gate tower
    for (a, b) in ((x0, gx - 6.0), (gx + 6.0, x1)):
        range_block(W, a, y0, b, y1, h, True)
        for (n, out) in ((y0, -1), (y1, 1)):
            f = geom.Frame((0, n, 0), (1, 0))
            tudor_windows(W, f, 0.0, a + 0.8, b - 0.8, (1.2, 4.9), out)
        chimneys(W, [(a + b) / 2], [y0 + 3, y1 - 3], h, h + 3.5)
    # the great gate: a tower of three storeys with a turret at each corner and an arch through
    tx0, tx1, ty0, ty1 = gx - 6.0, gx + 6.0, y0 - 1.0, y1 + 1.0
    th = 13.0
    ah = 5.2
    wall_box(W, tx0, ty0, gx - ghw, ty1, 0, ah, skip=('top',))
    wall_box(W, gx + ghw, ty0, tx1, ty1, 0, ah, skip=('top',))
    wall_box(W, tx0, ty0, tx1, ty1, ah, th, skip=('top',))
    # the arch (segments) under the tower
    f = geom.Frame((gx, ty0, 0), (1, 0))
    seg = 10
    for i in range(seg):
        a0, a1 = math.pi * i / seg, math.pi * (i + 1) / seg
        u0, z0 = -math.cos(a0) * ghw, ah - 1.8 + math.sin(a0) * 1.8
        u1, z1 = -math.cos(a1) * ghw, ah - 1.8 + math.sin(a1) * 1.8
        W.face([f.p(u1, 0, z1), f.p(u0, 0, z0), f.p(u0, ty1 - ty0, z0), f.p(u1, ty1 - ty0, z1)], ASH, TRIM, 'college')
        for (n, out) in ((0.0, -1), (ty1 - ty0, 1)):
            q = [f.p(u0, n, z0), f.p(u1, n, z1), f.p(u1, n, ah + 0.01), f.p(u0, n, ah + 0.01)]
            W.face(q if out < 0 else q[::-1], ASH, ASHC, 'college')
    # wooden gates swung open against the passage walls
    for s in (-1, 1):
        ga, gb = sorted((gx + s * ghw, gx + s * (ghw - 0.12)))
        wall_box(W, ga, ty0 + 0.6, gb, ty0 + 3.4, 0, 3.6, 'timber', (0.55, 0.38, 0.25))
    crenels(W, tx0, ty0, tx1, ty1, th)
    for (cx, cy) in ((tx0, ty0), (tx1, ty0), (tx0, ty1), (tx1, ty1)):
        turret(W, cx, cy, 1.4, th + 3.0)
    # the arms over the arch, and windows above on both faces
    textured(W, geom.Frame((gx, ty0, 0), (1, 0)), -1.2, 1.2, -0.04, ah + 0.5, ah + 3.5, 'sign_crest', -1)
    for (n, out) in ((ty0, -1), (ty1, 1)):
        fr = geom.Frame((0, n, 0), (1, 0))
        tudor_windows(W, fr, 0.0, tx0 + 0.8, tx1 - 0.8, (9.4,), out, every=3.5, ww=1.6, wh=2.0)
        if out > 0:
            tudor_windows(W, fr, 0.0, tx0 + 0.8, tx1 - 0.8, (5.9,), out, every=3.5, ww=1.6, wh=2.0)
    # the passage's paving
    W.face([(gx - ghw, ty0 - 0.5, 0.06), (gx + ghw, ty0 - 0.5, 0.06), (gx + ghw, ty1, 0.06), (gx - ghw, ty1, 0.06)],
           'stone', (0.9, 0.88, 0.84), 'college')


def dorm(W):
    x0, y0, x1, y1 = CO['dorm']
    h = 11.0
    cm = (CO['common'][1] + CO['common'][3]) / 2
    range_block(W, x0, y0, x1, y1, h, False, door=('x1', cm, 1.6, 2.8))
    doorway(W, x1, CO['common'][2], cm, 1.6, 2.8)
    # windows on the court side (east) and outside (west); the common room's door on the east
    fe = geom.Frame((x1, 0, 0), (0, 1))     # n = (-1, 0): the east wall faces -n (facing = -1)
    tudor_windows(W, fe, 0.0, y0 + 1.0, y1 - 1.0, (1.1, 4.7, 8.1), -1, skip=(cm,))
    fw = geom.Frame((x0, 0, 0), (0, 1))
    tudor_windows(W, fw, 0.0, y0 + 1.0, y1 - 1.0, (1.1, 4.7, 8.1), 1)
    door_arch(W, fe, cm, -1)
    textured(W, fe, cm - 1.6, cm + 1.6, -0.05, 2.9, 3.7, 'sign_dorm', -1)
    chimneys(W, [x0 + 2.5, x1 - 2.5], [y0 + 6, (y0 + y1) / 2, y1 - 6], h, h + 4.5)
    common_room(W)


def door_arch(W, f, u, facing, w=1.6, h=2.8):
    """A Tudor doorway: stone jambs and a four-centred head round an open dark doorway."""
    n0, n1 = sorted((0.0, facing * 0.25))
    geom.box(W, f, u - w / 2 - 0.3, u - w / 2, n0, n1, 0, h + 0.5, ASH, TRIM, 'college')
    geom.box(W, f, u + w / 2, u + w / 2 + 0.3, n0, n1, 0, h + 0.5, ASH, TRIM, 'college')
    geom.box(W, f, u - w / 2, u + w / 2, n0, n1, h, h + 0.5, ASH, TRIM, 'college')


def common_room(W):
    a, b, c, d = CO['common']
    z = 3.6
    W.face([(a, b, 0.03), (c, b, 0.03), (c, d, 0.03), (a, d, 0.03)], 'wood_deck', (0.75, 0.6, 0.48), 'college_in')
    W.face([(a, b, z), (a, d, z), (c, d, z), (c, b, z)], 'plaster', (0.95, 0.92, 0.85), 'college_in')
    # panelled walls inside (the range is solid: these faces face in)
    cm = (b + d) / 2
    for (p, q) in (((a, b), (c, b)), ((c, d), (a, d))):
        W.face([(p[0], p[1], 0), (q[0], q[1], 0), (q[0], q[1], z), (p[0], p[1], z)][::-1], 'wood', (0.55, 0.4, 0.3),
               'college_in')
    wall_x(W, a, b, d, 0, z, True, 'wood', (0.55, 0.4, 0.3), name='college_in')
    wall_x(W, c, b, d, 0, z, False, 'wood', (0.55, 0.4, 0.3), hole=(cm, 1.6, 2.8), name='college_in')
    W.face([(a, d - 0.01, 0.6), (c, d - 0.01, 0.6), (c, d - 0.01, 0.65), (a, d - 0.01, 0.65)][::-1], 'timber',
           (0.6, 0.45, 0.32), 'college_in')
    # a rug, lamps
    W.face([(a + 1.2, b + 3.0, 0.05), (a + 5.0, b + 3.0, 0.05), (a + 5.0, d - 3.0, 0.05), (a + 1.2, d - 3.0, 0.05)],
           'cloth', (0.55, 0.16, 0.16), 'college_in')
    for y in (b + 3.5, d - 3.5):
        geom.box(W, F0, (a + c) / 2 - 0.3, (a + c) / 2 + 0.3, y - 0.3, y + 0.3, z - 0.5, z - 0.2, 'lamp', (1, 1, 1),
                 'college_in')
    for kind, poly in walk.common_furniture():
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        if kind == 'fire':
            geom.box(W, F0, x0, x1, y0, y1, 0, 1.4, 'stone', (0.85, 0.82, 0.78), 'college_in')
            geom.box(W, F0, x1 - 0.02, x1 + 0.01, y0 + 0.6, y1 - 0.6, 0.15, 0.9, 'lamp', (1.0, 0.5, 0.2), 'college_in')
            geom.box(W, F0, x0 - 0.1, x1 + 0.15, y0 - 0.1, y1 + 0.1, 1.4, 1.55, 'wood', (0.5, 0.36, 0.26), 'college_in')
            geom.box(W, F0, x0, x0 + 0.5, y0 + 0.3, y1 - 0.3, 1.55, z, 'stone', (0.85, 0.82, 0.78), 'college_in')
        elif kind in ('sofa', 'chair'):
            geom.box(W, F0, x0, x1, y0, y1, 0, 0.45, 'cloth', (0.35, 0.22, 0.16), 'college_in')
            # the back away from the fire (east side)
            geom.box(W, F0, x1 - 0.25, x1, y0, y1, 0.45, 0.95, 'cloth', (0.32, 0.2, 0.15), 'college_in')
            geom.seats((x0 + x1 - 0.25) / 2, (y0 + y1) / 2, 0.45, 0, 1, y1 - y0, -1, 0)
        elif kind == 'table':
            geom.box(W, F0, x0, x1, y0, y1, 0.38, 0.45, 'wood', (0.5, 0.35, 0.25), 'college_in')
            geom.box(W, F0, x0 + 0.1, x1 - 0.1, y0 + 0.1, y1 - 0.1, 0, 0.38, 'wood', (0.4, 0.28, 0.2), 'college_in')
        elif kind == 'case':
            geom.box(W, F0, x0, x1, y0, y1, 0, 2.2, 'wood', (0.5, 0.36, 0.26), 'college_in')
            textured(W, F0, x0 + 0.05, x1 - 0.05, y1 + 0.01, 0.1, 2.1, 'sign_spines', 1)
        elif kind == 'desk':
            geom.box(W, F0, x0, x1, y0, y1, 0.72, 0.78, 'wood', (0.5, 0.35, 0.25), 'college_in')
            for xx in (x0 + 0.1, x1 - 0.15):
                geom.box(W, F0, xx, xx + 0.05, y0 + 0.1, y1 - 0.1, 0, 0.72, 'wood', (0.4, 0.28, 0.2), 'college_in')
            geom.box(W, F0, (x0 + x1) / 2 - 0.15, (x0 + x1) / 2 + 0.15, y0 + 0.2, y0 + 0.45, 0.78, 1.1, 'lamp',
                     (1, 0.9, 0.7), 'college_in')


def library(W):
    x0, y0, x1, y1 = CO['library']
    h = 10.0
    py = CO['paths'][1]
    range_block(W, x0, y0, x1, y1, h, False, door=('x0', py, 2.2, 3.2))
    doorway(W, x0, CO['reading'][0], py, 2.2, 3.2)
    fw = geom.Frame((x0, 0, 0), (0, 1))     # court side: the wall faces -x, facing = 1 in this frame
    tudor_windows(W, fw, 0.0, y0 + 1.0, y1 - 1.0, (1.4, 6.0), 1, every=3.0, ww=1.6, wh=3.6, skip=(py,))
    fe = geom.Frame((x1, 0, 0), (0, 1))
    tudor_windows(W, fe, 0.0, y0 + 1.0, y1 - 1.0, (1.4, 6.0), -1, every=3.0, ww=1.6, wh=3.6)
    door_arch(W, fw, py, 1, w=2.2, h=3.2)
    textured(W, fw, py - 1.6, py + 1.6, 0.05, 3.9, 4.7, 'sign_library', 1)
    # inside: a high room with a wooden floor and a coffered ceiling, chandeliers
    a, b, c, d = CO['reading']
    z = 5.6
    W.face([(a, b, 0.03), (c, b, 0.03), (c, d, 0.03), (a, d, 0.03)], 'wood_deck', (0.8, 0.66, 0.5), 'college_in')
    W.face([(a, b, z), (a, d, z), (c, d, z), (c, b, z)], 'plaster', (0.96, 0.94, 0.88), 'college_in')
    for (p, q) in (((a, b), (c, b)), ((c, d), (a, d))):
        W.face([(p[0], p[1], 0), (q[0], q[1], 0), (q[0], q[1], z), (p[0], p[1], z)][::-1], 'plaster',
               (0.95, 0.93, 0.88), 'college_in')
    wall_x(W, a, b, d, 0, z, True, 'plaster', (0.95, 0.93, 0.88), hole=(py, 2.2, 3.2), name='college_in')
    wall_x(W, c, b, d, 0, z, False, 'plaster', (0.95, 0.93, 0.88), name='college_in')
    for y in np.arange(b + 3.0, d - 1.0, 4.0):
        geom.box(W, F0, a, c, y - 0.1, y + 0.1, z - 0.4, z, 'wood', (0.6, 0.45, 0.32), 'college_in')
        geom.box(W, F0, (a + c) / 2 - 0.35, (a + c) / 2 + 0.35, y + 1.9, y + 2.1 + 0.4, z - 1.6, z - 1.3, 'lamp',
                 (1, 0.9, 0.7), 'college_in')
    for kind, poly in walk.library_furniture():
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
        if kind == 'case':
            geom.box(W, F0, bx0, bx1, by0, by1, 0, 3.4, 'wood', (0.55, 0.4, 0.28), 'college_in')
            # books on each long face
            if by1 - by0 > bx1 - bx0:
                sf = geom.Frame((0, 0, 0), (0, 1))
                textured(W, sf, by0 + 0.05, by1 - 0.05, -(bx0 - 0.01), 0.1, 3.3, 'sign_spines', 1)
            else:
                textured(W, F0, bx0 + 0.05, bx1 - 0.05, by0 - 0.01, 0.1, 3.3, 'sign_spines', -1)
                textured(W, F0, bx0 + 0.05, bx1 - 0.05, by1 + 0.01, 0.1, 3.3, 'sign_spines', 1)
        else:
            # a long reading table between two benches, books and a lamp on it
            m = (bx0 + bx1) / 2
            geom.box(W, F0, m - 0.5, m + 0.5, by0, by1, 0.74, 0.8, 'wood', (0.45, 0.3, 0.2), 'college_in')
            geom.box(W, F0, m - 0.4, m + 0.4, by0 + 0.1, by1 - 0.1, 0, 0.74, 'wood', (0.38, 0.26, 0.18), 'college_in',
                     skip=('top',))
            for s in (-1, 1):
                geom.box(W, F0, m + s * 0.85 - 0.2, m + s * 0.85 + 0.2, by0, by1, 0.42, 0.47, 'wood', (0.5, 0.36, 0.26),
                         'college_in')
                geom.box(W, F0, m + s * 0.85 - 0.15, m + s * 0.85 + 0.15, by0 + 0.2, by1 - 0.2, 0, 0.42, 'wood',
                         (0.42, 0.3, 0.22), 'college_in', skip=('top',))
                # facing the table
                geom.seats(m + s * 0.85, (by0 + by1) / 2, 0.47, 0, 1, by1 - by0, -s, 0)
            geom.box(W, F0, m - 0.12, m + 0.12, (by0 + by1) / 2 - 0.12, (by0 + by1) / 2 + 0.12, 0.8, 1.2, 'lamp',
                     (1, 0.9, 0.7), 'college_in')


def pointed_window(W, f, u, n, z0, w, h, facing):
    """A tall window with a pointed head: glass, stone mullions and transoms, a hood."""
    g = n + facing * 0.03
    rise = w * 0.55
    seg = 6
    pts = [(u - w / 2, z0), (u + w / 2, z0), (u + w / 2, z0 + h)]
    for i in range(1, seg):
        t = i / seg
        a = math.pi / 2 * t
        pts.append((u + w / 2 - (w / 2) * math.sin(a) ** 0.8 * 1.0, z0 + h + rise * math.sin(math.pi / 2 * t) ** 0.6))
    pts.append((u, z0 + h + rise))
    for i in range(seg - 1, 0, -1):
        t = i / seg
        a = math.pi / 2 * t
        pts.append((u - w / 2 + (w / 2) * math.sin(a) ** 0.8, z0 + h + rise * math.sin(math.pi / 2 * t) ** 0.6))
    pts.append((u - w / 2, z0 + h))
    q = [f.p(pu, g, pz) for (pu, pz) in pts]
    geom.tri_fan(W, q if facing < 0 else q[::-1], 'glass', (0.75, 0.82, 0.95), 'college')
    a0, a1 = sorted((n, n + facing * 0.15))
    for k in range(1, 5):
        uu = u - w / 2 + w * k / 5
        geom.box(W, f, uu - 0.05, uu + 0.05, a0, a1, z0, z0 + h + rise * 0.8, ASH, TRIM, 'college')
    for zz in (z0 + h * 0.33, z0 + h * 0.66):
        geom.box(W, f, u - w / 2, u + w / 2, a0, a1, zz, zz + 0.12, ASH, TRIM, 'college')
    geom.box(W, f, u - w / 2 - 0.2, u - w / 2, a0, a1, z0, z0 + h, ASH, TRIM, 'college')
    geom.box(W, f, u + w / 2, u + w / 2 + 0.2, a0, a1, z0, z0 + h, ASH, TRIM, 'college')


def chapel(W):
    """A chapel like King's: long and tall, buttresses with pinnacles between pointed windows, a battlemented
    parapet, a low lead roof, an octagonal turret with a cap at each corner, great windows at the ends."""
    x0, y0, x1, y1 = CO['chapel']
    x0, x1 = x0 + 2.0, x1 - 2.0
    y0, y1 = y0 + 1.5, y1 - 1.5
    h = 19.0
    wall_box(W, x0, y0, x1, y1, 0, h, skip=('top',))
    wall_box(W, x0 - 0.2, y0 - 0.2, x1 + 0.2, y1 + 0.2, 0, 1.0, ASH, TRIM, skip=('top',))
    crenels(W, x0, y0, x1, y1, h, t=0.6, h=1.2, step=1.2)
    # low lead roof behind the parapet, with snow
    f = geom.Frame((x0, (y0 + y1) / 2, 0), (1, 0))
    for q in ([f.p(0.3, -(y1 - y0) / 2 + 0.3, h), f.p(x1 - x0 - 0.3, -(y1 - y0) / 2 + 0.3, h),
               f.p(x1 - x0 - 0.3, 0, h + 2.4), f.p(0.3, 0, h + 2.4)],
              [f.p(0.3, 0, h + 2.4), f.p(x1 - x0 - 0.3, 0, h + 2.4), f.p(x1 - x0 - 0.3, (y1 - y0) / 2 - 0.3, h),
               f.p(0.3, (y1 - y0) / 2 - 0.3, h)]):
        q = [np.array(p) for p in q]
        if np.cross(q[1] - q[0], q[2] - q[0])[2] < 0:
            q = q[::-1]
        W.face(q, 'lead', (1, 1, 1), 'roofs')
        W.face([p + (0, 0, SNOW * 0.9) for p in q], 'snow_soft', name='snow_soft_roofs')
    # bays: buttresses and windows along both long sides
    bays = 9
    bw = (x1 - x0) / bays
    for side, n, out in ((-1, y0, -1), (1, y1, 1)):
        fr = geom.Frame((0, n, 0), (1, 0))
        for i in range(bays + 1):
            u = x0 + i * bw
            b0, b1 = sorted((0.0, out * 1.3))
            geom.box(W, fr, u - 0.45, u + 0.45, b0, b1, 0, h - 1.5, ASH, ASHC, 'college')
            geom.box(W, fr, u - 0.3, u + 0.3, b0 * 0.6, b1 * 0.6, h - 1.5, h + 1.2, ASH, ASHC, 'college')
            px, py = fr.p(u, out * 0.4, 0)[:2]
            geom.cylinder(W, px, py, h + 1.2, h + 4.2, 0.28, ASH, TRIM, 'college', seg=4, r1=0.03)
            geom.cylinder(W, px, py, h + 1.2, h + 1.2 + SNOW * 0.6, 0.32, 'snow_soft', (1, 1, 1), 'snow_soft_college',
                          seg=4, top=True)
        for i in range(bays):
            u = x0 + (i + 0.5) * bw
            if out < 0 and i == bays // 2:
                # the south door in the middle bay, a smaller window over it
                door_arch(W, fr, u, -1, w=2.0, h=3.6)
                geom.box(W, fr, u - 1.0, u + 1.0, -0.06, 0.0, 0, 3.6, 'timber', (0.5, 0.34, 0.22), 'college')
                pointed_window(W, fr, u, 0.0, 7.0, bw - 1.6, 6.0, -1)
                continue
            pointed_window(W, fr, u, 0.0, 3.2, bw - 1.4, 11.0, out)
    # the great windows at the ends
    for x, out in ((x0, -1), (x1, 1)):
        fr = geom.Frame((x, 0, 0), (0, 1))
        pointed_window(W, fr, (y0 + y1) / 2, 0.0, 4.0, (y1 - y0) - 3.0, 10.0, -out)
    # a turret at each corner
    for (cx, cy) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        turret(W, cx, cy, 1.7, h + 5.0, cap=6.0)


def court(W):
    """Stone paving round and across the court, striped lawns in four squares edged in stone, signs."""
    x0, y0, x1, y1 = CO['court']
    z = 0.05
    lawns = walk.college_lawns()
    # paving: the court as a grid of 1 m slabs, not under the lawns
    for x in np.arange(x0, x1, 1.0):
        for y in np.arange(y0, y1, 1.0):
            cx, cy = x + 0.5, y + 0.5
            if any(a < cx < c and b < cy < d for (a, b, c, d) in lawns):
                continue
            q = [(x, y, z), (x + 1, y, z), (x + 1, y + 1, z), (x, y + 1, z)]
            W.face(q, 'stone', (0.95, 0.93, 0.88), 'college_court')
            W.face([(p[0], p[1], z + TROD) for p in q], 'snow_trod', name='snow_trod_college')
    for (a, b, c, d) in lawns:
        zl = z + 0.04
        # mown stripes: alternate shades every 1.5 m
        k = 0
        for x in np.arange(a, c - 1e-6, 1.5):
            xe = min(x + 1.5, c)
            col = (0.82, 1.0, 0.82) if k % 2 else (0.66, 0.86, 0.62)
            W.face([(x, b, zl), (xe, b, zl), (xe, d, zl), (x, d, zl)], 'grass', col, 'college_lawn', tile=2.5)
            k += 1
        W.face([(a, b, zl + SNOW), (c, b, zl + SNOW), (c, d, zl + SNOW), (a, d, zl + SNOW)], 'snow_soft',
               name='snow_soft_college')
        # stone edging
        for (p, q) in (((a, b), (c, b)), ((c, b), (c, d)), ((c, d), (a, d)), ((a, d), (a, b))):
            W.face([(p[0], p[1], 0.0), (q[0], q[1], 0.0), (q[0], q[1], zl + 0.02), (p[0], p[1], zl + 0.02)][::-1],
                   'stone', (0.9, 0.9, 0.86), 'college_court')
        # keep off the grass
        for (sx, sy) in ((a + 0.6, b + 0.6), (c - 0.6, d - 0.6)):
            geom.box(W, F0, sx - 0.03, sx + 0.03, sy - 0.03, sy + 0.03, 0, 0.6, 'metal', (1, 1, 1), 'college')
            sf = geom.Frame((sx, sy, 0), (1, 0))
            for s in (-1, 1):
                textured(W, sf, -0.3, 0.3, s * 0.015, 0.6, 0.9, 'sign_lawn', s)


def build(W):
    gate_range(W)
    dorm(W)
    library(W)
    chapel(W)
    court(W)
    # the precinct's paving outside the gate
    gx, ghw = CO['gate']
    y0 = CO['precinct'][1]
    W.face([(gx - 5, y0 - 4, 0.05), (gx + 5, y0 - 4, 0.05), (gx + 5, y0 - 1, 0.05), (gx - 5, y0 - 1, 0.05)], 'stone',
           (0.92, 0.9, 0.86), 'college_court')
