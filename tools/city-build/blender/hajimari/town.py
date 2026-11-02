"""The town's walls and gates, the fountain on the plaza, the market stalls, street lamps and benches."""
import math, random

import numpy as np

from . import geom, lots, plan, walk
from .ground import SNOW

MERLON = 0.9


def wall_run(W, a, b, h=plan.WALL_H, t=plan.WALL_T):
    """A stretch of town wall from a to b (xy), crenellated, with a walkway ledge you only see."""
    a = np.array(a, float)
    b = np.array(b, float)
    L = float(np.linalg.norm(b - a))
    if L < 0.1:
        return
    f = geom.Frame((a[0], a[1], 0), b - a)
    geom.box(W, f, 0, L, -t / 2, t / 2, 0, h, 'stone_wall', (0.95, 0.92, 0.86), 'walls')
    # a plinth and the crenellations
    geom.box(W, f, 0, L, -t / 2 - 0.25, t / 2 + 0.25, 0, 0.8, 'stone_blocks', (0.85, 0.82, 0.78), 'walls')
    k = int(L / (MERLON * 2))
    for i in range(k):
        u = i * MERLON * 2 + MERLON * 0.5
        geom.box(W, f, u, u + MERLON, -t / 2, -t / 2 + 0.5, h, h + 1.0, 'stone_wall', (0.95, 0.92, 0.86), 'walls')
        geom.box(W, f, u, u + MERLON, t / 2 - 0.5, t / 2, h, h + 1.0, 'stone_wall', (0.95, 0.92, 0.86), 'walls')
        geom.box(W, f, u, u + MERLON, -t / 2, -t / 2 + 0.5, h + 1.0, h + 1.0 + SNOW * 0.7, 'snow_soft', (1, 1, 1),
                 'snow_soft_walls')
    geom.box(W, f, 0, L, -t / 2 + 0.5, t / 2 - 0.5, h, h + SNOW, 'snow_soft', (1, 1, 1), 'snow_soft_walls')


def tower(W, x, y, r=2.6, h=11.0, roof='roof_slate'):
    """A round wall tower with a conical roof."""
    geom.cylinder(W, x, y, 0, h, r, 'stone_wall', (0.93, 0.9, 0.84), 'walls', seg=16, top=False, tile=2.5)
    geom.cylinder(W, x, y, h, h + 0.4, r + 0.25, 'stone_blocks', (0.85, 0.82, 0.78), 'walls', seg=16, top=False)
    geom.cylinder(W, x, y, h + 0.4, h + 6.5, r + 0.5, roof, (1, 1, 1), 'roofs', seg=16, top=True, r1=0.05, tile=2.2)
    geom.cylinder(W, x, y, h + 0.45, h + 4.8, r + 0.62, 'snow_soft', (1, 1, 1), 'snow_soft_roofs', seg=16, top=False,
                  r1=0.9)
    # a few arrow slits
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        cx, cy = x + math.cos(a) * (r + 0.01), y + math.sin(a) * (r + 0.01)
        f = geom.Frame((cx, cy, 0), (-math.sin(a), math.cos(a)))
        geom.box(W, f, -0.1, 0.1, -0.02, 0.0, h * 0.55, h * 0.55 + 1.2, 'glass', (1, 1, 1), 'walls')


def gatehouse(W, side, c, hw):
    """A gatehouse astride the wall: an arched passage, a room above with a hipped roof, towers either side."""
    x = plan.WALL_E if side == 'E' else plan.WALL_W
    t = plan.WALL_T + 1.2
    f = geom.Frame((x, c, 0), (0, 1))     # u along the wall (y), n across (x)
    hp = 4.6                               # passage height
    H = plan.WALL_H + 4.0
    # piers
    for s in (-1, 1):
        u0, u1 = sorted((s * hw, s * (hw + 1.4)))
        geom.box(W, f, u0, u1, -t / 2, t / 2, 0, hp, 'stone_blocks', (0.95, 0.92, 0.86), 'walls')
    # the arch (segments) and the wall above it
    seg = 10
    for i in range(seg):
        a0 = math.pi * i / seg
        a1 = math.pi * (i + 1) / seg
        u0, z0 = -math.cos(a0) * hw, hp - 1.6 + math.sin(a0) * 1.6
        u1, z1 = -math.cos(a1) * hw, hp - 1.6 + math.sin(a1) * 1.6
        # soffit
        W.face([f.p(u0, -t / 2, z0), f.p(u0, t / 2, z0), f.p(u1, t / 2, z1), f.p(u1, -t / 2, z1)], 'stone_blocks',
               (0.9, 0.88, 0.84), 'walls')
        for n, out in ((-t / 2, -1), (t / 2, 1)):
            q = [f.p(u0, n, z0), f.p(u1, n, z1), f.p(u1, n, hp + 0.01), f.p(u0, n, hp + 0.01)]
            W.face(q if out < 0 else q[::-1], 'stone_blocks', (0.95, 0.92, 0.86), 'walls')
    geom.box(W, f, -hw - 1.4, hw + 1.4, -t / 2, t / 2, hp, H, 'stone_blocks', (0.95, 0.92, 0.86), 'walls')
    # windows of the room above, a coat of arms
    for n, out in ((-t / 2, -1), (t / 2, 1)):
        for u in (-hw * 0.5, hw * 0.5):
            from .houses import window
            window(W, f, u, n, hp + 2.0, 0.7, 1.2, out, random.Random(1), None, False)
    # hipped roof
    zb = H
    ov = 0.5
    u0, u1, n0, n1 = -hw - 1.4 - ov, hw + 1.4 + ov, -t / 2 - ov, t / 2 + ov
    zr = zb + 4.5
    um0, um1 = u0 + (n1 - n0) / 2, u1 - (n1 - n0) / 2
    nm = 0.0
    for q in ([(u0, n0), (u1, n0), (um1, nm), (um0, nm)], [(u1, n1), (u0, n1), (um0, nm), (um1, nm)]):
        pts = [f.p(q[0][0], q[0][1], zb), f.p(q[1][0], q[1][1], zb), f.p(q[2][0], q[2][1], zr),
               f.p(q[3][0], q[3][1], zr)]
        if np.cross(np.array(pts[1]) - pts[0], np.array(pts[2]) - pts[0])[2] < 0:
            pts = pts[::-1]
        W.face(pts, 'roof_slate', (1, 1, 1), 'roofs')
        W.face([np.array(p) + (0, 0, SNOW * 0.8) for p in pts], 'snow_soft', name='snow_soft_roofs')
    for q in ([(u0, n1), (u0, n0), (um0, nm)], [(u1, n0), (u1, n1), (um1, nm)]):
        pts = [f.p(q[0][0], q[0][1], zb), f.p(q[1][0], q[1][1], zb), f.p(q[2][0], q[2][1], zr)]
        if np.cross(np.array(pts[1]) - pts[0], np.array(pts[2]) - pts[0])[2] < 0:
            pts = pts[::-1]
        W.face(pts, 'roof_slate', (1, 1, 1), 'roofs')
        W.face([np.array(p) + (0, 0, SNOW * 0.8) for p in pts], 'snow_soft', name='snow_soft_roofs')
    for s in (-1, 1):
        tower(W, x, c + s * (hw + 2.2), 2.6, plan.WALL_H + 5.5)
    # lanterns either side of the passage, on the town side
    for s in (-1, 1):
        lantern(W, x - t / 2 - 0.15, c + s * (hw + 0.4), 3.0, wall=(-1, 0))


def walls(W):
    t = plan.WALL_T / 2
    Wx, N, S, E = plan.WALL_W, plan.WALL_N, plan.WALL_S, plan.WALL_E
    # west wall with its gate
    wg = [(c, hw) for (side, c, hw) in plan.GATES.values() if side == 'W']
    y = S
    for c, hw in sorted(wg):
        wall_run(W, (Wx, y), (Wx, c - hw - 1.4))
        y = c + hw + 1.4
    wall_run(W, (Wx, y), (Wx, N))
    wall_run(W, (Wx, N), (E, N))
    wall_run(W, (E, S), (Wx, S))
    eg = sorted([(c, hw) for (side, c, hw) in plan.GATES.values() if side == 'E'])
    y = S
    for c, hw in eg:
        wall_run(W, (E, y), (E, c - hw - 1.4))
        y = c + hw + 1.4
    wall_run(W, (E, y), (E, N))
    for (x, y) in [(Wx, N), (Wx, S), (E, N), (E, S), (Wx, 60), (Wx, -60), (-120, N), (-120, S), (-60, N), (-180, N),
                   (-60, S), (-180, S), (E, 60), (E, -60)]:
        tower(W, x, y, 3.0, plan.WALL_H + 4.0, 'roof_clay' if (x + y) % 3 else 'roof_slate')
    for (side, c, hw) in plan.GATES.values():
        gatehouse(W, side, c, hw)


def lantern(W, x, y, z, wall=None):
    """A lantern: on a wall bracket (wall = direction into the wall) or on top of a post at height z."""
    if wall is not None:
        wx, wy = wall
        f = geom.Frame((x, y, 0), (-wy, wx))
        geom.box(W, f, -0.03, 0.03, -0.6, 0.0, z + 0.5, z + 0.56, 'metal', (1, 1, 1), 'lamps')
        x, y = x - wx * 0.55, y - wy * 0.55
    f = geom.Frame((x, y, 0), (1, 0))
    geom.box(W, f, -0.16, 0.16, -0.16, 0.16, z, z + 0.05, 'metal', (1, 1, 1), 'lamps')
    geom.box(W, f, -0.13, 0.13, -0.13, 0.13, z + 0.05, z + 0.45, 'lamp', (1, 1, 1), 'lamps')
    geom.cylinder(W, x, y, z + 0.45, z + 0.7, 0.22, 'metal', (1, 1, 1), 'lamps', seg=4, r1=0.02)


def street_lamp(W, x, y, ground=0.0):
    geom.cylinder(W, x, y, ground, ground + 0.3, 0.14, 'metal', (1, 1, 1), 'lamps', seg=8)
    geom.cylinder(W, x, y, ground + 0.3, ground + 3.1, 0.06, 'metal', (1, 1, 1), 'lamps', seg=6)
    lantern(W, x, y, ground + 3.1)
    geom.cylinder(W, x, y, ground + 3.72, ground + 3.72 + SNOW * 0.6, 0.12, 'snow_soft', (1, 1, 1),
                  'snow_soft_things', seg=6, r1=0.03)


def bench(W, x, y, a, ground=0.0):
    f = geom.Frame((x, y, ground), (math.cos(a), math.sin(a)))
    for u in (-0.75, 0.75):
        geom.box(W, f, u - 0.05, u + 0.05, -0.25, 0.25, 0, 0.42, 'metal', (1, 1, 1), 'benches')
        geom.box(W, f, u - 0.05, u + 0.05, 0.2, 0.28, 0.42, 0.85, 'metal', (1, 1, 1), 'benches')
    for k in range(4):
        n = -0.24 + k * 0.12
        geom.box(W, f, -0.95, 0.95, n, n + 0.1, 0.42, 0.46, 'wood', (0.9, 0.75, 0.6), 'benches')
    for k in range(2):
        z = 0.58 + k * 0.15
        geom.box(W, f, -0.95, 0.95, 0.22, 0.26, z, z + 0.1, 'wood', (0.9, 0.75, 0.6), 'benches')
    geom.box(W, f, -0.92, 0.92, -0.24, 0.2, 0.46, 0.46 + SNOW * 0.6, 'snow_soft', (1, 1, 1), 'snow_soft_things')


def fountain(W, x, y, r, ground=0.0, tiers=2):
    """A round stone fountain: basin with a rim, a column with one or two bowls; water in it."""
    g = ground
    geom.cylinder(W, x, y, g, g + 0.55, r, 'stone', (0.95, 0.93, 0.9), 'fountains', seg=40, top=False, tile=1.6)
    geom.cylinder(W, x, y, g + 0.55, g + 0.7, r + 0.12, 'stone', (0.92, 0.9, 0.86), 'fountains', seg=40, top=False,
                  tile=1.6)
    # rim top as a ring
    seg = 40
    for i in range(seg):
        a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
        po = [(x + math.cos(a) * (r + 0.12), y + math.sin(a) * (r + 0.12), g + 0.7) for a in (a0, a1)]
        pi = [(x + math.cos(a) * (r - 0.3), y + math.sin(a) * (r - 0.3), g + 0.7) for a in (a0, a1)]
        W.face([pi[0], po[0], po[1], pi[1]], 'stone', (0.95, 0.93, 0.9), 'fountains')
        pin = [(x + math.cos(a) * (r - 0.3), y + math.sin(a) * (r - 0.3)) for a in (a0, a1)]
        W.face([(pin[1][0], pin[1][1], g + 0.1), (pin[0][0], pin[0][1], g + 0.1), (pin[0][0], pin[0][1], g + 0.7),
                (pin[1][0], pin[1][1], g + 0.7)], 'stone', (0.85, 0.85, 0.82), 'fountains')
    geom.cylinder(W, x, y, g + 0.45, g + 0.46, r - 0.3, 'water_pond', (1, 1, 1), 'water_pond_fountain', seg=40)
    geom.cylinder(W, x, y, g + 0.1, g + 2.2, 0.35, 'stone', (0.95, 0.93, 0.9), 'fountains', seg=12)
    geom.cylinder(W, x, y, g + 2.2, g + 2.55, 1.4, 'stone', (0.95, 0.93, 0.9), 'fountains', seg=24, r1=1.6)
    geom.cylinder(W, x, y, g + 2.5, g + 2.51, 1.45, 'water_pond', (1, 1, 1), 'water_pond_fountain', seg=24)
    if tiers > 1:
        geom.cylinder(W, x, y, g + 2.55, g + 3.6, 0.2, 'stone', (0.95, 0.93, 0.9), 'fountains', seg=10)
        geom.cylinder(W, x, y, g + 3.6, g + 3.8, 0.6, 'stone', (0.95, 0.93, 0.9), 'fountains', seg=16, r1=0.75)
        geom.cylinder(W, x, y, g + 3.8, g + 4.3, 0.12, 'stone', (0.95, 0.93, 0.9), 'fountains', seg=8, r1=0.05)
    # snow on the rim and the bowls (the water freezes under it: drawn white)
    geom.cylinder(W, x, y, g + 0.7, g + 0.7 + SNOW * 0.5, r + 0.1, 'snow_soft', (1, 1, 1), 'snow_soft_things',
                  seg=40, top=True)
    geom.cylinder(W, x, y, g + 2.55, g + 2.55 + SNOW * 0.5, 1.55, 'snow_soft', (1, 1, 1), 'snow_soft_things', seg=24)


def stall(W, x, y, rot, rnd):
    """A market stall: a wooden table with crates of fruit and vegetables, a striped canopy on poles."""
    f = geom.Frame((x, y, 0.08), (math.cos(math.radians(rot)), math.sin(math.radians(rot))))
    for u in (-1.6, 1.6):
        for n in (-1.0, 1.0):
            geom.box(W, f, u - 0.05, u + 0.05, n - 0.05, n + 0.05, 0, 2.5 if n < 0 else 2.2, 'wood', (0.8, 0.65, 0.5),
                     'stalls')
    geom.box(W, f, -1.6, 1.6, -1.0, 0.3, 0.85, 0.92, 'wood', (0.9, 0.75, 0.6), 'stalls')
    geom.box(W, f, -1.55, 1.55, -0.95, 0.25, 0.1, 0.85, 'wood', (0.6, 0.48, 0.38), 'stalls', skip=('top',))
    # crates with produce
    goods = [(0.85, 0.15, 0.1), (0.95, 0.6, 0.1), (0.95, 0.85, 0.2), (0.35, 0.6, 0.2), (0.55, 0.2, 0.5),
             (0.9, 0.35, 0.25)]
    for k in range(5):
        u = -1.3 + k * 0.65
        geom.box(W, f, u - 0.28, u + 0.28, -0.85, -0.3, 0.92, 1.1, 'wood', (0.75, 0.6, 0.45), 'stalls')
        col = rnd.choice(goods)
        for m in range(6):
            uu = u - 0.18 + (m % 3) * 0.18
            nn = -0.72 + (m // 3) * 0.22
            geom.box(W, f, uu - 0.07, uu + 0.07, nn - 0.07, nn + 0.07, 1.1, 1.22, 'flowers', col, 'stalls')
    a, b = rnd.choice([((0.75, 0.2, 0.18), (0.95, 0.92, 0.85)), ((0.2, 0.42, 0.3), (0.95, 0.92, 0.85)),
                       ((0.85, 0.55, 0.15), (0.95, 0.92, 0.85))])
    k = 8
    for i in range(k):
        u0 = -1.75 + 3.5 * i / k
        u1 = -1.75 + 3.5 * (i + 1) / k
        q = [f.p(u0, -1.3, 2.55), f.p(u1, -1.3, 2.55), f.p(u1, 1.25, 2.2), f.p(u0, 1.25, 2.2)]
        W.face(q, 'cloth', a if i % 2 else b, 'stalls')
        W.face(q[::-1], 'cloth', tuple(c * 0.8 for c in (a if i % 2 else b)), 'stalls')
    q = [f.p(-1.7, -1.25, 2.6), f.p(1.7, -1.25, 2.6), f.p(1.7, 1.2, 2.26), f.p(-1.7, 1.2, 2.26)]
    W.face(q, 'snow_soft', name='snow_soft_things')


def well(W, x, y):
    geom.cylinder(W, x, y, 0.08, 0.9, 1.0, 'stone_blocks', (0.9, 0.88, 0.84), 'fountains', seg=16, top=False)
    geom.cylinder(W, x, y, 0.85, 0.86, 0.85, 'water_pond', (0.4, 0.4, 0.4), 'water_pond_well', seg=16)
    for s in (-1, 1):
        geom.box(W, geom.Frame((x, y, 0), (1, 0)), s * 0.85 - 0.06, s * 0.85 + 0.06, -0.06, 0.06, 0.9, 2.6, 'timber',
                 (0.7, 0.6, 0.5), 'fountains')
    f = geom.Frame((x, y, 0), (1, 0))
    geom.box(W, f, -1.1, 1.1, -0.06, 0.06, 2.55, 2.65, 'timber', (0.7, 0.6, 0.5), 'fountains')
    for q in ([f.p(-1.2, -0.8, 2.5), f.p(1.2, -0.8, 2.5), f.p(1.2, 0, 3.1), f.p(-1.2, 0, 3.1)],
              [f.p(1.2, 0.8, 2.5), f.p(-1.2, 0.8, 2.5), f.p(-1.2, 0, 3.1), f.p(1.2, 0, 3.1)]):
        W.face(q, 'roof_clay', (1, 1, 1), 'roofs')
        W.face(q[::-1], 'timber', (0.6, 0.5, 0.4), 'roofs')
        W.face([np.array(p) + (0, 0, SNOW * 0.7) for p in q], 'snow_soft', name='snow_soft_roofs')


def lamps_along(W, pts, w, every=22.0, side_alternate=True, ground=None):
    p = geom.resample(geom.smooth_corners(pts, 5.0), every)
    for i in range(1, len(p) - 1):
        t = p[i + 1] - p[i - 1]
        t /= np.linalg.norm(t)
        n = np.array([-t[1], t[0]])
        s = 1 if (i % 2 or not side_alternate) else -1
        q = p[i] + n * s * (w / 2 - 0.5)
        street_lamp(W, q[0], q[1], 0.0 if ground is None else float(ground(q[0], q[1])))


def build(W):
    walls(W)
    fx, fy, fr = plan.FOUNTAIN
    fountain(W, fx, fy, fr, 0.08)
    rnd = random.Random(3)
    for (x, y, rot) in plan.STALLS:
        stall(W, x, y, rot, rnd)
    for (x, y) in plan.WELLS:
        well(W, x, y)
    # lamps on the square's edges and along the streets
    x0, y0, x1, y1 = plan.SQUARE
    for x in np.arange(x0 + 2.5, x1, 16.0):
        street_lamp(W, x, y0 + 2.5, 0.08)
        street_lamp(W, x, y1 - 2.5, 0.08)
    for y in np.arange(y0 + 14, y1 - 8, 16.0):
        street_lamp(W, x0 + 2.5, y, 0.08)
    for (x, y) in [(-40, 24), (-40, -24), (-60, 24), (-60, -24)]:
        street_lamp(W, x, y, 0.08)
    for name, w, pts in plan.STREETS:
        if w >= 6 and name not in ('main',):
            lamps_along(W, pts, w, 24.0)
    lamps_along(W, plan.STREETS[0][2], 10.0, 12.0, True)
    for (x, y, a) in walk.benches():
        if x < 0:
            bench(W, x, y, a, 0.08)
