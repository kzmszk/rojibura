"""The walk raster of はじまりの街: the height of the walkable surface per 0.25 m cell, NaN where blocked.

Made from the plan (no bpy), so it matches the geometry by construction. tools/city-build/src/build-grid.ts
turns it into navmesh.json.
"""
import json, math, os

import numpy as np

from . import lots, plan

RES = 0.25


class Raster:
    def __init__(self):
        self.x0, self.y0 = plan.X0, plan.Y0
        self.nx = int((plan.X1 - plan.X0) / RES)
        self.ny = int((plan.Y1 - plan.Y0) / RES)
        self.xs = self.x0 + (np.arange(self.nx) + 0.5) * RES
        self.ys = self.y0 + (np.arange(self.ny) + 0.5) * RES
        self.h = np.zeros((self.ny, self.nx), dtype=np.float32)
        self.ok = np.ones((self.ny, self.nx), dtype=bool)

    def cells(self, poly):
        return lots.poly_cells(poly, self.x0, self.y0, RES, self.ok.shape)

    def block(self, poly):
        r = self.cells(poly)
        if r:
            s, m = r
            self.ok[s] &= ~m

    def set(self, poly, h, ok=True):
        r = self.cells(poly)
        if r:
            s, m = r
            if callable(h):
                gx, gy = np.meshgrid(self.xs[s[1]], self.ys[s[0]])
                hv = h(gx, gy)
                self.h[s] = np.where(m, hv, self.h[s])
            else:
                self.h[s] = np.where(m, h, self.h[s])
            if ok:
                self.ok[s] |= m
            else:
                self.ok[s] &= ~m

    def disc(self, x, y, r):
        return [(x + math.cos(a) * r, y + math.sin(a) * r) for a in np.linspace(0, 2 * math.pi, 20, endpoint=False)]


def circle(x, y, r, n=24):
    return [(x + math.cos(a) * r, y + math.sin(a) * r) for a in np.linspace(0, 2 * math.pi, n, endpoint=False)]


def build():
    R = Raster()
    # ground: the town is flat, the park follows the terrain (trails cut in)
    gx, gy = np.meshgrid(R.xs, R.ys)
    park = gx >= 0
    hp = np.zeros_like(gx)
    for j0 in range(0, R.ny, 160):
        sl = slice(j0, j0 + 160)
        m = park[sl]
        hp[sl][m] = plan.ground_height(gx[sl][m], gy[sl][m])
    R.h[:] = hp.astype(np.float32)

    # too steep away from the trails (> 33 degrees)
    gyy, gxx = np.gradient(R.h.astype(np.float64), RES)
    steep = np.hypot(gxx, gyy) > math.tan(math.radians(33))
    R.ok &= ~steep

    # the edge of the area
    big = 1000
    m = 1.5
    for poly in [[(-big, -big), (plan.X0 + m, -big), (plan.X0 + m, big), (-big, big)],
                 [(plan.X1 - m, -big), (big, -big), (big, big), (plan.X1 - m, big)],
                 [(-big, plan.Y1 - m), (big, plan.Y1 - m), (big, big), (-big, big)],
                 [(-big, -big), (big, -big), (big, plan.Y0 + m), (-big, plan.Y0 + m)]]:
        R.block(poly)
    # town walls (outside them is countryside you only see), gates are gaps
    t = plan.WALL_T / 2
    W, N, S, E = plan.WALL_W, plan.WALL_N, plan.WALL_S, plan.WALL_E
    R.block([(-big, -big), (W + t, -big), (W + t, big), (-big, big)])
    R.block([(-big, N - t), (E + t, N - t), (E + t, big), (-big, big)])
    R.block([(-big, -big), (E + t, -big), (E + t, S + t), (-big, S + t)])
    # east wall with its two gates
    ys = sorted([(c - hw, c + hw) for (side, c, hw) in plan.GATES.values() if side == 'E'])
    y = S
    for a, b in ys:
        R.block([(E - t, y), (E + t, y), (E + t, a), (E - t, a)])
        y = b
    R.block([(E - t, y), (E + t, y), (E + t, N), (E - t, N)])
    # the west gate leads to Venice: open in the wall, the land beyond is closed off by the portal's ground
    for (side, c, hw) in plan.GATES.values():
        if side == 'W':
            R.set([(W - t - 6, c - hw), (W + t, c - hw), (W + t, c + hw), (W - t - 6, c + hw)], 0.0, ok=True)
    # gatehouse towers beside each gate
    for (side, c, hw) in plan.GATES.values():
        x = E if side == 'E' else W
        for s in (-1, 1):
            R.block(circle(x, c + s * (hw + 2.2), 2.6))

    # the church
    for poly in plan.church_polys():
        R.block(poly)
    # houses
    for hs in lots.houses():
        ox, oy = hs['o']
        tx, ty = hs['t']
        R.block(lots.rect(ox, oy, tx, ty, -hs['w'] / 2, hs['w'] / 2, 0.0, hs['d']))
    # shops: walls blocked, inside walkable, shelves and counters blocked
    for sh in plan.SHOPS:
        a, b, c, d = sh['lot']
        R.block([(a, b), (c, b), (c, d), (a, d)])
        wt = 0.35
        R.set([(a + wt, b + wt), (c - wt, b + wt), (c - wt, d - wt), (a + wt, d - wt)], 0.0)
        fy = d if sh['front'] == 'N' else b
        dx = sh['door']
        R.set([(dx - 1.1, fy - 0.5), (dx + 1.1, fy - 0.5), (dx + 1.1, fy + 0.5), (dx - 1.1, fy + 0.5)], 0.0)
        for poly in shop_furniture(sh):
            R.block(poly)
    # the college: the ranges and the chapel block; the court (not its lawns: keep off the grass), the gate
    # passage, the library and the common room are walkable
    co = plan.COLLEGE
    R.block(box2(*co['precinct']))
    R.set(box2(*co['court']), 0.0)
    for q in college_lawns():
        R.block(box2(*q))
    gx, ghw = co['gate']
    R.set(box2(gx - ghw, co['south'][0] - 0.6, gx + ghw, co['south'][1] + 0.1), 0.0)
    R.set(box2(*co['reading']), 0.0)
    py = co['paths'][1]
    R.set(box2(co['library'][0] - 0.2, py - 1.4, co['reading'][0] + 0.1, py + 1.4), 0.0)
    R.set(box2(*co['common']), 0.0)
    cm = (co['common'][1] + co['common'][3]) / 2
    R.set(box2(co['common'][2] - 0.1, cm - 1.0, co['dorm'][2] + 0.2, cm + 1.0), 0.0)
    for _, poly in library_furniture() + common_furniture():
        R.block(poly)
    # fountains, stalls
    fx, fy, fr = plan.FOUNTAIN
    R.block(circle(fx, fy, fr + 0.2))
    for (x, y, rot) in plan.STALLS:
        R.block(lots.rect(x, y, 1, 0, -1.7, 1.7, -1.1, 1.1))
    for (x, y) in lots.wells():
        R.block(circle(x, y, 1.4))
    px, py, pr = plan.PARK_FOUNTAIN
    R.block(circle(px, py, pr + 0.2))
    R.block(plan.POND)
    # benches and lamps are small; trees block their trunks
    for (sp, x, y, s, r) in plan.trees():
        R.block(circle(x, y, 0.3 + 0.12 * s, 10))
    # the railing blocks a band wider than itself: a thinner one falls between the cells' centres (holes)
    for (x0, y0, x1, y1) in plan.summit_railing():
        t = np.array([x1 - x0, y1 - y0])
        L = float(np.linalg.norm(t))
        R.block(lots.rect(x0, y0, t[0] / L, t[1] / L, -0.1, L + 0.1, -0.3, 0.3))
    for b in benches():
        R.block(lots.rect(b[0], b[1], math.cos(b[2]), math.sin(b[2]), -0.95, 0.95, -0.35, 0.35))

    # the onsen inn
    on = plan.ONSEN
    a, b, c, d = on['inn']
    R.block([(a, b), (c, b), (c, d), (a, d)])
    a, b, c, d = on['lobby']
    R.set([(a, b), (c, b), (c, d), (a, d)], 0.15)
    dx = on['door_x']
    R.set([(dx - 1.6, on['lobby'][3] - 0.2), (dx + 1.6, on['lobby'][3] - 0.2), (dx + 1.6, on['inn'][3] + 0.5),
           (dx - 1.6, on['inn'][3] + 0.5)], 0.15)
    for poly in inn_furniture():
        R.block(poly)
    # the changing rooms, each with a doorway from the lobby (a short passage) and one onto the baths
    for sex in ('m', 'w'):
        a, b, c, d = on['changing_' + sex]
        R.block([(a - 0.3, b - 0.3), (c + 0.3, b - 0.3), (c + 0.3, d), (a - 0.3, d)])
        R.set([(a, b), (c, b), (c, d), (a, d)], 0.15)
        cx = plan.changing_door(sex)
        R.set([(cx - 1.0, d - 0.2), (cx + 1.0, d - 0.2), (cx + 1.0, on['lobby'][1] + 0.2),
               (cx - 1.0, on['lobby'][1] + 0.2)], 0.15)
        for poly in changing_furniture(sex):
            R.block(poly)
    # the baths' garden, fenced
    a, b, c, d = on['deck']
    R.block([(a - 2.0, b - 2.0), (c + 2.0, b - 2.0), (c + 2.0, d + 0.3), (a - 2.0, d + 0.3)])
    R.set([(a, b), (c, b), (c, d), (a, d)], on['deck_h'])
    # each changing room's door onto it
    for sex in ('m', 'w'):
        cx = plan.changing_door(sex)
        R.set([(cx - 1.0, d - 0.3), (cx + 1.0, d - 0.3), (cx + 1.0, d + 0.2), (cx - 1.0, d + 0.2)], 0.15)
    # the baths: a rim of rocks, the floor inside, steps down on the north side
    for pool in on['pools']:
        P = np.array(pool['outline'], float)
        R.block(offset_poly(P, 0.7))
        R.set(offset_poly(P, -0.55), on['floor'])
        sx0, sx1 = pool['steps']
        for (y0, y1, h) in bath_steps(pool):
            R.set([(sx0, y0), (sx1, y0), (sx1, y1), (sx0, y1)], h)
    for (x, y, r) in bath_rocks():
        R.block(circle(x, y, r))
    for (x, y, r) in plan.ONSEN_GARDEN_ROCKS:
        R.block(circle(x, y, r))
    for (x, y) in plan.ONSEN_LANTERNS:
        R.block(circle(x, y, 0.45))
    for (x, y) in plan.ONSEN_POSTS:
        R.block(circle(x, y, 0.2))
    bx, by = plan.ONSEN_BUCKETS
    R.block([(bx - 0.25, by - 0.25), (bx + 0.7, by - 0.25), (bx + 0.7, by + 0.25), (bx - 0.25, by + 0.25)])
    for sp in SPOUTS:                    # the rocks and stones the hot water comes out of
        x, y, r = sp['rock']
        R.block(circle(x, y, r + 0.05))
    for s in (-1, 1):                    # the entrance porch's posts
        R.block(circle(on['door_x'] + s * 1.9, on['inn'][3] + 1.2, 0.2))
    return R


# かけ流し: hot water runs into every bath all the time. 'rock': (x, y, radius) of the rock or stone it comes out of
# (blocked); 'from', 'to': (x, y, z) of the bamboo pipe or the stone channel, the water leaving at 'to' and falling
# into the bath; 'kind': 'bamboo' (a pipe, a round stream) or 'stone' (a carved stone lip, a wide thin sheet).
SPOUTS = [
    {'kind': 'bamboo', 'rock': (12.2, -150.6, 0.95), 'from': (12.4, -150.6, 1.08), 'to': (14.1, -150.6, 1.0)},
    {'kind': 'stone', 'rock': (47.2, -154.6, 0.7), 'from': (47.2, -154.4, 0.8), 'to': (47.2, -153.25, 0.74)},
    {'kind': 'bamboo', 'rock': (61.7, -151.2, 0.7), 'from': (61.5, -151.2, 1.0), 'to': (60.0, -151.2, 0.94)},
]


def bath_steps(pool):
    """(y0, y1, height) of the steps from the garden down into a bath, on its north side: from the rim (the
    outline's northernmost point within the steps' x range) inwards."""
    on = plan.ONSEN
    P = np.array(pool['outline'], float)
    sx0, sx1 = pool['steps']
    near = P[(P[:, 0] > sx0 - 2.0) & (P[:, 0] < sx1 + 2.0)]
    y = float(near[:, 1].max()) + 0.75
    top = on['deck_h']
    out = []
    for i in range(4):
        h = top - 0.16 * (i + 1)
        out.append((y - 0.5, y, h))
        y -= 0.5
    return out


def bath_rocks():
    """Big rocks set in the baths (x, y, radius): somewhere to lean on, and they shape the pools."""
    return [(23.5, -153.6, 0.9), (15.8, -148.0, 0.7), (47.5, -152.6, 0.8)]


def offset_poly(poly, d):
    """A polygon pushed out (d > 0) or in by d along its vertex normals (fine for gently convex shapes)."""
    poly = np.asarray(poly, float)
    n = len(poly)
    area = 0.5 * np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])
    sgn = 1 if area > 0 else -1
    out = []
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        e1 = (b - a) / np.linalg.norm(b - a)
        e2 = (c - b) / np.linalg.norm(c - b)
        n1 = np.array([e1[1], -e1[0]]) * sgn
        n2 = np.array([e2[1], -e2[0]]) * sgn
        nn = n1 + n2
        nn /= np.linalg.norm(nn)
        k = d / max(np.dot(nn, n1), 0.3)
        out.append(tuple(b + nn * k))
    return out


def shop_furniture(sh):
    """Shelves and the counter of a shop, as polygons (shared with the geometry)."""
    a, b, c, d = sh['lot']
    front_n = sh['front'] == 'N'
    out = []
    # counter beside the door, along the side wall nearest it
    dx = sh['door']
    if dx - a < c - dx:
        cx0, cx1 = a + 0.35, a + 1.15
    else:
        cx0, cx1 = c - 1.15, c - 0.35
    yb = d - 4.8 if front_n else b + 1.6
    out.append([(cx0, yb), (cx1, yb), (cx1, yb + 3.2), (cx0, yb + 3.2)])
    # shelves: along the back wall and two islands
    back = b + 0.35 if front_n else d - 0.95
    out.append([(a + 0.4, back), (c - 0.4, back), (c - 0.4, back + 0.6), (a + 0.4, back + 0.6)])
    mid = (b + d) / 2 + (-1.0 if front_n else 1.0)
    for x in np.arange(a + 3.0, c - 2.5, 3.2):
        if abs(x + 0.6 - dx) < 1.8 or x + 1.2 > cx0 - 0.8 and x < cx1 + 0.8:
            continue
        out.append([(x, mid - 1.6), (x + 1.2, mid - 1.6), (x + 1.2, mid + 1.6), (x, mid + 1.6)])
    return out


def box2(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def college_lawns():
    """The four lawns of the court, between the cross paths: (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = plan.COLLEGE['lawn']
    px, py, w = plan.COLLEGE['paths']
    return [(x0, y0, px - w / 2, py - w / 2), (px + w / 2, y0, x1, py - w / 2),
            (x0, py + w / 2, px - w / 2, y1), (px + w / 2, py + w / 2, x1, y1)]


def library_furniture():
    """The college library (like Wren's at Trinity): bookcases along the east wall and in bays out from it, long
    reading tables with benches down the middle, clear in front of the door. ('case'|'table', rectangle)"""
    a, b, c, d = plan.COLLEGE['reading']
    out = [('case', box2(c - 0.6, b, c, d))]
    for y in np.arange(b + 2.0, d - 1.0, 4.0):
        out.append(('case', box2(c - 3.0, y - 0.3, c - 0.6, y + 0.3)))
    for (y0, y1) in ((b + 1.5, b + 5.5), (b + 7.0, b + 11.0), (d - 11.0, d - 7.0), (d - 5.5, d - 1.5)):
        out.append(('table', box2(a + 1.1, y0, a + 3.3, y1)))
    return out


def common_furniture():
    """The hall of residence's common room: a fireplace on the west wall, a sofa and armchairs round a low
    table, a bookcase, writing desks. ('fire'|'sofa'|'chair'|'table'|'case'|'desk', rectangle)"""
    a, b, c, d = plan.COLLEGE['common']
    m = (b + d) / 2
    return [
        ('fire', box2(a, m - 1.6, a + 0.7, m + 1.6)),
        ('sofa', box2(a + 3.0, m - 2.4, a + 3.9, m + 2.4)),
        ('table', box2(a + 1.6, m - 1.2, a + 2.4, m + 1.2)),
        ('chair', box2(a + 1.0, m - 4.4, a + 2.0, m - 3.4)),
        ('chair', box2(a + 1.0, m + 3.4, a + 2.0, m + 4.4)),
        ('case', box2(a + 0.3, b, a + 4.8, b + 0.6)),
        ('desk', box2(a + 0.5, d - 0.8, a + 3.0, d)),
        ('desk', box2(a + 4.0, d - 0.8, a + 6.5, d)),
    ]


def inn_furniture():
    """The inn lobby's front desk and a bench."""
    return [[(14.5, -124.0), (16.0, -124.0), (16.0, -119.0), (14.5, -119.0)],
            [(38.5, -126.0), (41.5, -126.0), (41.5, -125.2), (38.5, -125.2)]]


def changing_furniture(sex):
    """Shelves with baskets along a changing room's side walls."""
    a, b, c, d = plan.ONSEN['changing_' + sex]
    return [[(a + 0.3, b + 1.0), (a + 0.9, b + 1.0), (a + 0.9, d - 1.0), (a + 0.3, d - 1.0)],
            [(c - 0.9, b + 1.0), (c - 0.3, b + 1.0), (c - 0.3, d - 1.0), (c - 0.9, d - 1.0)]]


def benches():
    """(x, y, angle) of benches: along the park paths, round the lawn, on the summit and the square."""
    out = []
    for name, w, pts in plan.PARK_PATHS:
        if name in ('avenue', 'loop_w', 'loop_e', 'pond_walk'):
            p = np.array(pts, float)
            for i in range(len(p) - 1):
                a, b = p[i], p[i + 1]
                L = np.linalg.norm(b - a)
                if L < 20:
                    continue
                t = (b - a) / L
                m = (a + b) / 2
                n = np.array([-t[1], t[0]])
                q = m + n * (w / 2 + 0.9)
                out.append((float(q[0]), float(q[1]), math.atan2(t[1], t[0])))
    mx, my = plan.MOUNT
    for a in (math.radians(200), math.radians(250), math.radians(300)):
        out.append((mx + math.cos(a) * 7.5, my + math.sin(a) * 7.5, a + math.pi / 2))
    # round the square inside the ring of plane trees, facing the church; and in the small parks
    cx, cy = plan.TOWN_C
    r = plan.SQUARE_R - 8.0
    trees = plan.square_trees()
    for k in range(24):
        a = 2 * math.pi * (k + 0.25) / 24
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        if min(abs(x - cx), abs(y - cy)) < 9.0 or any(math.hypot(x - sx, y - sy) < 6 for (sx, sy, _) in plan.STALLS):
            continue
        if math.cos(a) > 0.8:      # the plaza in front of the door stays open
            continue
        if any(plan._inside_poly(np.array([x]), np.array([y]), offset_poly(p, 3.0))[0] for p in plan.church_polys()):
            continue
        if any(math.hypot(x - tx, y - ty) < 2.0 for (tx, ty) in trees):
            continue
        out.append((x, y, a + math.pi / 2))
    out += lots.park_benches()
    return out


def write(R, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    h = np.where(R.ok, R.h, np.nan).astype(np.float32)
    h.tofile(os.path.join(out_dir, 'walk.f32'))
    meta = {'x0': R.x0, 'y0': R.y0, 'res': RES, 'nx': R.nx, 'ny': R.ny,
            'frame': 'Blender xy: row j is y = y0 + (j + 0.5) * res; glTF X = x, Z = -y'}
    json.dump(meta, open(os.path.join(out_dir, 'walk.json'), 'w'))


def preview(R, path, scale=1):
    from PIL import Image
    h = R.h
    lo, hi = -1.0, plan.MOUNT_H
    v = np.clip((h - lo) / (hi - lo), 0, 1)
    rgb = np.zeros(h.shape + (3,), np.uint8)
    rgb[..., 0] = (90 + 150 * v).astype(np.uint8)
    rgb[..., 1] = (150 + 90 * v).astype(np.uint8)
    rgb[..., 2] = (90 + 60 * v).astype(np.uint8)
    rgb[~R.ok] = (40, 40, 48)
    im = Image.fromarray(rgb[::-1])
    if scale != 1:
        im = im.resize((int(R.nx * scale), int(R.ny * scale)))
    im.save(path)
