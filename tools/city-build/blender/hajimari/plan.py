"""The plan of はじまりの街: where everything is, as data (no bpy, so the walk raster can be made from it too).

Blender frame: x east, y north, z up, metres. glTF / rojibura: X = x, Y = z, Z = -y.

    x -240 ........ -6 | 0 .............................. 240
      town inside its walls | park; its south-east half is a low mountain
      the Sagrada Família at (-120, 0), Nativity façade facing east onto the plaza
      the main gate (-3, 0) opens on the ginkgo avenue; the south gate (-3, -120) on the way to the onsen
"""
import json, math, os, random

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
AREA_DIR = os.path.join(ROOT, 'assets', 'areas', 'hajimari')

X0, X1, Y0, Y1 = -240.0, 240.0, -160.0, 160.0

# ---------------------------------------------------------------- the church

CHURCH = (-120.0, 0.0)
# what the exterior blocks (Blender xy), replaced by sagrada_exterior.json when it exists
_church_poly = [(-160.0, -62.0), (-80.0, -62.0), (-80.0, 62.0), (-160.0, 62.0)]
CHURCH_DOOR = (-78.0, 0.0)
CHURCH_FACING = (1.0, 0.0)
CHURCH_DOOR_WIDTH = 8.0


def _load_church():
    global _church_poly, CHURCH_DOOR, CHURCH_FACING, CHURCH_DOOR_WIDTH
    f = os.path.join(AREA_DIR, 'sagrada_exterior.json')
    if not os.path.exists(f):
        return
    d = json.load(open(f))
    fp = d['footprint']
    polys = fp if isinstance(fp[0][0], (list, tuple)) else [fp]
    _church_poly = [[(p[0], -p[1]) for p in poly] for poly in polys]
    CHURCH_DOOR = (d['door']['pos'][0], -d['door']['pos'][1])
    CHURCH_FACING = (d['door']['facing'][0], -d['door']['facing'][1])
    CHURCH_DOOR_WIDTH = d['door'].get('width', 8.0)


_load_church()


def church_polys():
    p = _church_poly
    return p if isinstance(p[0][0], (list, tuple)) else [p]


# ---------------------------------------------------------------- walls and gates

WALL_T = 2.2          # thickness
WALL_H = 7.5
WALL_W, WALL_N, WALL_S, WALL_E = -232.0, 152.0, -152.0, -4.0   # centre lines
GATES = {             # gaps in the wall (centre, half width): the arch above is a gatehouse
    'main': ('E', 0.0, 4.0),
    'south': ('E', -120.0, 3.0),
    'west': ('W', 0.0, 3.5),
    'north': ('E', 108.0, 3.0),   # out to the college in the park
}

# ---------------------------------------------------------------- the town's layout

# The church stands in a round square. Round it the town goes in rings: a ring road, a ring of houses facing the
# church, a second ring road with houses on both sides; four main streets go out from the church's doors and
# ends (east to the main gate, west to the Venice gate, north and south to towers on the wall), with lanes
# through the ring between them. Beyond the second ring the streets are a grid of blocks, houses round each
# block; what is left between the rings and the blocks is small parks (lots.parks).
TOWN_C = (-120.0, 0.0)            # the centre of the rings (the church's crossing)
SQUARE_R = 68.0                   # the square, paved
RING1 = (71.7, 7.4)               # ring roads: radius of the centre line, width
RING2 = (100.0, 6.8)
RING_OUT = RING2[0] + RING2[1] / 2    # beyond this the grid
LANE_W = 5.0                      # the lane inside the walls


def ring_pts(r, n=180):
    """A ring road's centre line, anticlockwise, closed."""
    cx, cy = TOWN_C
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]


def _clip_out(a, b, R):
    """The parts of segment ab outside the circle of radius R round TOWN_C."""
    a = np.array(a, float)
    b = np.array(b, float)
    c = np.array(TOWN_C)
    d = b - a
    f = a - c
    A, B, C = d @ d, 2 * f @ d, f @ f - R * R
    disc = B * B - 4 * A * C
    if disc <= 0:
        return [(tuple(a), tuple(b))]
    t0, t1 = (-B - math.sqrt(disc)) / (2 * A), (-B + math.sqrt(disc)) / (2 * A)
    out = []
    if t0 > 0:
        out.append((tuple(a), tuple(a + d * min(t0, 1))))
    if t1 < 1:
        out.append((tuple(a + d * max(t1, 0)), tuple(b)))
    return [(p, q) for p, q in out if math.dist(p, q) > 1.0]


def _streets():
    cx, cy = TOWN_C
    r0 = SQUARE_R - 0.5
    wl = LANE_W / 2 + 0.05
    lx0, lx1 = WALL_W + WALL_T / 2 + wl, WALL_E - WALL_T / 2 - wl     # the lanes' centre lines
    ly0, ly1 = WALL_S + WALL_T / 2 + wl, WALL_N - WALL_T / 2 - wl
    out = [
        # (name, width, points); the main streets first
        ('main', 10.0, [(cx + r0, 0.0), (-1.0, 0.0)]),
        ('west', 8.0, [(cx - r0, 0.0), (-236.0, 0.0)]),
        ('north', 8.0, [(cx, r0), (cx, ly1)]),
        ('south', 8.0, [(cx, -r0), (cx, ly0)]),
        ('ring1', RING1[1], ring_pts(RING1[0])),
        ('ring2', RING2[1], ring_pts(RING2[0])),
    ]
    for k, a in enumerate((45, 135, 225, 315)):   # lanes through the ring between the main streets
        u = (math.cos(math.radians(a)), math.sin(math.radians(a)))
        out.append(('lane%d' % k, 4.0, [(cx + u[0] * r0, cy + u[1] * r0), (cx + u[0] * (RING_OUT + 0.5),
                                                                            cy + u[1] * (RING_OUT + 0.5))]))
    # the grid beyond the rings (north-east and south-east ones run out to the college and onsen gates)
    grid = [('gy%d' % i, 6.0, (lx0, y), (lx1 + 6.0 if y in (108.0, -120.0) else lx1, y))
            for i, y in enumerate((-120.0, -62.0, 62.0, 108.0))]
    grid += [('gx%d' % i, 6.0, (x, ly0), (x, ly1)) for i, x in enumerate((-195.0, -158.0, -82.0, -45.0))]
    for name, w, a, b in grid:
        for k, (p, q) in enumerate(_clip_out(a, b, RING_OUT - 0.5)):
            out.append(('%s_%d' % (name, k), w, [p, q]))
    # the lane inside the walls
    out += [('lane_w', LANE_W, [(lx0, ly0), (lx0, ly1)]), ('lane_e', LANE_W, [(lx1, ly0), (lx1, ly1)]),
            ('lane_n', LANE_W, [(lx0, ly1), (lx1, ly1)]), ('lane_s', LANE_W, [(lx0, ly0), (lx1, ly0)])]
    return out


STREETS = _streets()

# ---------------------------------------------------------------- shops (front on the main street)

# lot: (x0, y0, x1, y1) of the building; door: x of the door centre on the front; front: 'N' or 'S'. In the ring of
# houses where the main street crosses it, a few steps from the square.
SHOPS = [
    {'id': 'seven', 'name': 'セブンイレブン', 'lot': (-44.5, -18.0, -30.5, -5.5), 'front': 'N', 'door': -34.5,
     'style': 'seven'},
    {'id': 'books', 'name': '本屋「ひなた書房」', 'lot': (-44.5, 5.5, -34.5, 17.5), 'front': 'S', 'door': -39.5,
     'style': 'books'},
    {'id': 'bakery', 'name': 'パン屋「こむぎ」', 'lot': (-34.0, 5.5, -25.5, 15.5), 'front': 'S', 'door': -29.75,
     'style': 'bakery'},
]

# the school: a college in the manner of Cambridge, in the park beside the town (out of the north-east gate). A great gate on the south
# with four turrets, a court of striped lawns crossed by paths, a chapel like King's along the north, the
# library on the east (study there), the hall of residence (寮) on the west with its common room (study there too).
COLLEGE = {
    'precinct': (8.0, 86.0, 60.0, 150.0),
    'court': (18.0, 96.0, 50.0, 134.0),               # open court between the ranges
    'lawn': (22.0, 100.0, 46.0, 130.0),               # cut into four by the paths
    'paths': (34.0, 115.0, 3.0),                      # the cross paths: x of the north-south one, y of the other, width
    'gate': (34.0, 3.2),                              # the gate passage: centre x, half width (through the south range)
    'south': (86.0, 96.0),                            # the gate range (y0, y1)
    'dorm': (8.0, 96.0, 18.0, 134.0),                 # west range: the hall of residence
    'common': (9.0, 100.0, 17.0, 116.0),              # its common room (walkable), door on the east
    'library': (50.0, 96.0, 60.0, 134.0),             # east range
    'reading': (51.0, 99.0, 59.0, 131.0),             # inside the library (walkable), door on the west
    'chapel': (14.0, 134.0, 54.0, 148.0),             # north range
    'name': '学校「はじまりカレッジ」',
}
# the market stalls are a workplace too: this rectangle round them (x0, y0, x1, y1), north and south rows
STALL_WORK = [(-80.0, 21.0, -56.0, 28.0), (-80.0, -28.0, -56.0, -21.0)]

# market stalls on the square (x, y, rot degrees), either side of the way from the door to the main street
STALLS = [(-76.0, 24.0, 180), (-68.0, 24.0, 180), (-60.0, 24.0, 180), (-76.0, -24.0, 0), (-68.0, -24.0, 0),
          (-60.0, -24.0, 0)]
FOUNTAIN = (-64.0, 0.0, 5.0)     # x, y, radius (in front of the church door)

# ---------------------------------------------------------------- terrain

MOUNT = (158.0, -66.0)           # summit
MOUNT_R = (92.0, 98.0)
MOUNT_H = 46.0
SUMMIT_R = 10.0                  # flat top


def _noise(x, y):
    """Smooth pseudo-noise from a few rotated sines (deterministic, vectorised)."""
    n = np.zeros_like(x, dtype=np.float64)
    for (fx, fy, ph, a) in [(0.031, 0.017, 1.3, 1.0), (-0.021, 0.043, 4.1, 0.7), (0.067, -0.051, 2.2, 0.35),
                            (0.11, 0.09, 0.7, 0.18), (-0.15, 0.13, 5.5, 0.1)]:
        n += a * np.sin(x * fx + y * fy + ph)
    return n


def mountain_height(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    dx = (x - MOUNT[0]) / MOUNT_R[0]
    dy = (y - MOUNT[1]) / MOUNT_R[1]
    d = np.sqrt(dx * dx + dy * dy)
    # a little irregular in outline and profile
    d = d * (1.0 + 0.06 * _noise(x * 1.3, y * 1.3))
    f = np.clip(1.0 - d * d, 0.0, 1.0) ** 1.8
    h = MOUNT_H * f + 2.5 * _noise(x, y) * f * (1.0 - f)
    # flat summit
    ds = np.hypot(x - MOUNT[0], y - MOUNT[1])
    top = MOUNT_H
    k = np.clip((ds - SUMMIT_R) / 6.0, 0.0, 1.0)
    return np.where(ds < SUMMIT_R + 6.0, top * (1 - k) + np.minimum(h, top) * k, np.minimum(h, top))


def park_height(x, y):
    """Gentle undulation of the park lawns (0 at the town wall and the onsen)."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    fade = np.clip((x - 6.0) / 30.0, 0.0, 1.0) * (1 - _flat(x, y))
    return 0.7 * fade * (0.5 + 0.5 * np.sin(x * 0.045 + 0.6) * np.sin(y * 0.038 + 1.7))


def _flat(x, y):
    """1 where the ground is kept level (the onsen, the fountain plaza), fading out over 12 m."""
    dx = np.maximum(np.maximum(0.0 - x, x - 70.0), 0.0)
    dy = np.maximum(np.maximum(-164.0 - y, y + 104.0), 0.0)
    on = np.clip(1 - np.hypot(dx, dy) / 12.0, 0, 1)
    dp = np.hypot(x - 58.0, y - 18.0)
    fp = np.clip(1 - (dp - 14.0) / 12.0, 0, 1)
    x0, y0, x1, y1 = COLLEGE['precinct']
    dx = np.maximum(np.maximum(x0 - 6 - x, x - x1 - 4), 0.0)
    dy = np.maximum(np.maximum(y0 - 8 - y, y - y1 - 4), 0.0)
    co = np.clip(1 - np.hypot(dx, dy) / 12.0, 0, 1)
    return np.maximum(np.maximum(on, fp), co)


def natural_height(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    h = np.maximum(mountain_height(x, y), park_height(x, y))
    return np.where(x < 0.0, 0.0, h)


# ---------------------------------------------------------------- the mountain trails

TRAIL_W = 2.6


def _trail(start, sign, grade, step=1.0):
    """Climbs from `start` at a constant grade, turning round the mountain (`sign` = +1 anticlockwise)."""
    p = np.array(start, dtype=np.float64)
    pts = [p.copy()]
    for _ in range(2000):
        h = float(natural_height(p[0], p[1]))
        if np.hypot(p[0] - MOUNT[0], p[1] - MOUNT[1]) < SUMMIT_R - 2.0:
            break
        e = 0.5
        gx = (float(natural_height(p[0] + e, p[1])) - float(natural_height(p[0] - e, p[1]))) / (2 * e)
        gy = (float(natural_height(p[0], p[1] + e)) - float(natural_height(p[0], p[1] - e))) / (2 * e)
        g = math.hypot(gx, gy)
        if g < grade * 1.05:
            u = np.array([MOUNT[0] - p[0], MOUNT[1] - p[1]])
            u /= np.linalg.norm(u)
        else:
            up = np.array([gx, gy]) / g
            t = np.array([-up[1], up[0]]) * sign
            s = grade / g
            u = t * math.sqrt(1 - s * s) + up * s
        p = p + u * step
        pts.append(p.copy())
        if h > MOUNT_H - 0.05:
            break
    pts.append(np.array(MOUNT))
    return _smooth(np.array(pts), 3)


def _smooth(pts, n):
    for _ in range(n):
        q = pts.copy()
        q[1:-1] = (pts[:-2] + 2 * pts[1:-1] + pts[2:]) / 4
        pts = q
    return pts


def _resample(pts, step):
    seg = np.hypot(*(pts[1:] - pts[:-1]).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, s[-1], step)
    t = np.append(t, s[-1])
    return np.stack([np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])], 1)


TRAILHEADS = {'north': (82.0, 14.0), 'onsen': (70.0, -122.0)}
_trails = None


def trails():
    """[(name, points (n, 2), heights (n,))]: the north trail from the park, the onsen trail from the inn."""
    global _trails
    if _trails is None:
        out = []
        for name, start, sign, grade in [('north', TRAILHEADS['north'], 1, 0.125),
                                         ('onsen', TRAILHEADS['onsen'], -1, 0.15)]:
            pts = _resample(_trail(start, sign, grade), 1.0)
            h = natural_height(pts[:, 0], pts[:, 1])
            # heights along the trail never go down, smoothed: steps where it is steep
            h = np.maximum.accumulate(h)
            k = np.ones(9) / 9
            hp = np.pad(h, 4, mode='edge')
            h = np.convolve(hp, k, mode='valid')
            out.append((name, pts, h))
        # the onsen trail ends where it first meets the north trail (a junction, not a crossing)
        (_, a, ah), (bn, b, bh) = out
        d = np.hypot(b[:, None, 0] - a[None, :, 0], b[:, None, 1] - a[None, :, 1])
        hit = np.where((d.min(1) < 2.0) & (np.arange(len(b)) > 20))[0]
        if len(hit):
            j = hit[0]
            i = int(np.argmin(d[j]))
            out[1] = (bn, np.vstack([b[:j], a[i:i + 1]]), np.concatenate([bh[:j], ah[i:i + 1]]))
        _trails = out
    return _trails


def _seg_dist(px, py, pts):
    """Distance from points (px, py) to a polyline, and the index/parameter of the nearest segment."""
    best = np.full(px.shape, 1e9)
    bi = np.zeros(px.shape, dtype=np.int32)
    bt = np.zeros(px.shape)
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy or 1e-9
        t = np.clip(((px - ax) * vx + (py - ay) * vy) / L2, 0, 1)
        d = np.hypot(px - (ax + t * vx), py - (ay + t * vy))
        m = d < best
        best = np.where(m, d, best)
        bi = np.where(m, i, bi)
        bt = np.where(m, t, bt)
    return best, bi, bt


def summit_railing():
    """Segments (x0, y0, x1, y1) of the railing round the summit lookout, open where the trails arrive."""
    gaps = []
    for _, pts, _ in trails():
        d = np.hypot(pts[:, 0] - MOUNT[0], pts[:, 1] - MOUNT[1])
        i = int(np.argmin(np.abs(d - (SUMMIT_R + 2.0))))
        gaps.append(math.atan2(pts[i, 1] - MOUNT[1], pts[i, 0] - MOUNT[0]))
    R = SUMMIT_R + 1.0
    n = 48
    near = lambda a: any(abs((a - g + math.pi) % (2 * math.pi) - math.pi) < 0.22 for g in gaps)
    out = []
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        if near(a0) or near(a1):
            continue
        out.append((MOUNT[0] + math.cos(a0) * R, MOUNT[1] + math.sin(a0) * R,
                    MOUNT[0] + math.cos(a1) * R, MOUNT[1] + math.sin(a1) * R))
    return out


def ground_height(x, y):
    """The terrain with the trails cut into it (what people walk on, outside buildings and water)."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    h = natural_height(x, y)
    on = (x > 40) & (np.hypot((x - MOUNT[0]) / MOUNT_R[0], (y - MOUNT[1]) / MOUNT_R[1]) < 1.15)
    if not on.any():
        return h
    hx, hy, hh = x[on], y[on], h[on]
    for _, pts, th in trails():
        d, i, t = _seg_dist(hx, hy, pts)
        ht = th[i] * (1 - t) + th[np.minimum(i + 1, len(th) - 1)] * t
        w = np.clip((d - TRAIL_W / 2 - 0.3) / 3.5, 0, 1)
        w = w * w * (3 - 2 * w)
        hh = np.where(d < TRAIL_W / 2 + 3.8, ht * (1 - w) + hh * w, hh)
    h = h.copy()
    h[on] = hh
    return h


# ---------------------------------------------------------------- park paths

PARK_PATHS = [
    # (name, width, points); heights follow the ground
    ('avenue', 9.0, [(0, 0), (20, 2), (40, 8), (58, 18)]),                          # ginkgo avenue
    ('loop_w', 5.0, [(58, 18), (60, 50), (68, 80), (80, 112), (100, 132), (130, 138), (160, 132)]),
    ('loop_e', 5.0, [(58, 18), (90, 30), (120, 40), (150, 44), (176, 60), (186, 90), (178, 116), (160, 132)]),
    ('to_trail', 4.0, [(58, 18), (72, 14), (82, 14)]),
    ('pond_walk', 4.0, [(186, 90), (206, 76), (228, 86), (232, 112), (220, 140), (196, 146), (178, 136), (160, 132)]),
    ('woods', 3.5, [(20, 2), (18, 40), (24, 72), (34, 80)]),
    ('woods2', 3.0, [(18, 40), (36, 52), (60, 50)]),
    ('college_way', 5.0, [(-1, 108), (3, 96), (10, 82), (34, 79), (34, 85.5)]),       # north-east gate to the college
    ('college_east', 4.0, [(34, 79), (52, 78), (68, 80)]),
    ('north_walk', 3.5, [(68, 80), (66, 120), (72, 146), (100, 150), (100, 132)]),
    ('foot', 4.0, [(40, 8), (36, -30), (40, -70), (50, -100), (52, -110)]),     # along the mountain foot
    ('onsen_way', 5.0, [(-1, -120), (14, -112), (36, -110), (52, -110), (68, -116), (70, -122)]),
]
PARK_FOUNTAIN = (58.0, 18.0, 4.0)   # round plaza where the avenue ends (radius of the basin)
PARK_PLAZA_R = 13.0
LAWN = ((122.0, 86.0), (52.0, 34.0))         # ellipse centre, radii: the big lawn (原っぱ)
POND = [(186, 100), (196, 92), (212, 88), (224, 96), (226, 112), (218, 128), (202, 136), (188, 130),
        (182, 116)]

# ---------------------------------------------------------------- the onsen inn

ONSEN = {
    'inn': (12.0, -132.0, 44.0, -114.0),       # building, entrance on the north side
    'door_x': 28.0,
    'lobby': (14.0, -130.0, 42.0, -116.0),     # inside, walkable
    'changing': (30.0, -140.0, 42.0, -132.0),  # changing room (脱衣所), off the lobby to the south
    'deck': (8.0, -158.0, 64.0, -140.0),       # stone paving round the bath
    'pool': [(14, -144), (24, -142.5), (40, -143), (54, -142), (60, -146), (61, -152), (54, -156.5), (38, -156),
             (24, -156.5), (14, -154), (11, -149)],
    'water': 0.0,      # water surface
    'floor': -0.52,    # bath floor: sitting, the water comes up to the shoulders
    'deck_h': 0.12,
}


ONSEN_LANTERNS = [(62.0, -141.6), (62.0, -156.8), (45.0, -141.4), (26.0, -141.4)]
ONSEN_BUCKETS = (39.0, -141.3)
ONSEN_POSTS = [(9.0, -141.0), (22.5, -141.0), (22.5, -157.6), (9.0, -157.6)]   # the arbour


def onsen_zone():
    """Where an avatar is in its towel: the changing room, the deck and the bath."""
    c = ONSEN['changing']
    d = ONSEN['deck']
    return [(c[0], c[3]), (c[2], c[3]), (c[2], d[3]), (d[2], d[3]), (d[2], d[1]), (d[0], d[1]), (d[0], d[3]),
            (c[0], d[3])]


# ---------------------------------------------------------------- landmarks

def landmarks():
    """(id, name, x, y) in Blender xy; heights come from the walk raster."""
    dx, dy = CHURCH_DOOR
    fx, fy = CHURCH_FACING
    return [
        ('plaza', '教会前の広場', dx + fx * 22, dy + fy * 22 - 8),
        ('fountain', '広場の噴水', FOUNTAIN[0] + 7.5, FOUNTAIN[1] - 2),
        ('market', '広場の市場', -68.0, 19.5),
        ('square_north', '教会の北の並木', -120.0, 58.0),
        ('square_south', '教会の南の並木', -120.0, -62.0),
        ('seven', 'セブンイレブン', -34.5, -8.5),
        ('books', '本屋「ひなた書房」', -39.5, 8.5),
        ('bakery', 'パン屋「こむぎ」', -29.75, 8.5),
        ('north_gate', '北東の門', 4.0, 106.0),
        ('college_gate', '学校「はじまりカレッジ」の門', 34.0, 83.0),
        ('college_court', 'カレッジの中庭', 34.0, 113.0),
        ('library', 'カレッジの図書館', 55.0, 115.0),
        ('dorm', '寮の談話室', 15.0, 108.0),
        ('chapel', 'カレッジの礼拝堂の前', 34.0, 132.0),
        ('main_gate', '東の門', 4.0, 0.0),
        ('south_gate', '南の門', 4.0, -120.0),
        ('old_lane', '北の路地', -158.0, 126.0),
        ('west_gate', '西の門', -224.0, 0.0),
        ('avenue', 'イチョウ並木', 28.0, 4.0),
        ('park_fountain', '公園の噴水広場', 58.0, 8.0),
        ('lawn', '原っぱ', 122.0, 86.0),
        ('pond', '池のほとり', 182.0, 92.0),
        ('woods', '雑木林の小道', 20.0, 60.0),
        ('trailhead', '登山口', 80.0, 14.0),
        ('summit', '山頂の展望台', MOUNT[0] - 4.0, MOUNT[1] + 4.0),
        ('onsen', '温泉宿「ゆのはな」の玄関', ONSEN['door_x'], -110.0),
        ('changing', '温泉の脱衣所', 36.0, -136.0),
        ('bath', '露天風呂', 34.0, -150.0),
    ]


# the main places: named on the map and listed there to warp to (docs/prd.md 3.4.14)
MAJOR = {'plaza', 'market', 'square_north', 'square_south', 'seven', 'books', 'bakery', 'main_gate', 'west_gate',
         'park_fountain', 'lawn', 'pond', 'summit', 'onsen', 'college_court', 'library'}

SPAWN = None   # set from the landmarks: on the plaza


def spawn():
    lm = {l[0]: l for l in landmarks()}
    return lm['plaza'][2], lm['plaza'][3] - 3.0


# the Passion façade's door, on the west, opposite the Nativity's (it opens on the west main street)
PASSION_DOOR = (-156.5, 0.0)


# portals (assets/areas.json): (id, name, x, y, to, at). Both church doors lead inside, to the crossing (the roomiest
# place there); they stand just outside the doors, quiet (no arch).
def portals():
    dx, dy = CHURCH_DOOR
    fx, fy = CHURCH_FACING
    return [
        ('gate_sagrada', 'サグラダ・ファミリアの入口（生誕の門）', dx + fx * 1.5, dy + fy * 1.5, 'sagrada', 'crossing'),
        ('gate_sagrada_passion', 'サグラダ・ファミリアの入口（受難の門）', PASSION_DOOR[0] - 1.5, PASSION_DOOR[1], 'sagrada',
         'crossing'),
        ('gate_venezia', 'ヴェネツィアへの門', -236.0, 0.0, 'venezia', 'gate_main'),
    ]


def square_trees():
    """Plane trees in a ring round the square, clear of the streets coming in, the church and the stalls."""
    cx, cy = TOWN_C
    r = SQUARE_R - 4.5
    out = []
    n = int(2 * math.pi * r / 10.5)
    for k in range(n):
        a = 2 * math.pi * (k + 0.5) / n
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        if min(abs(x - cx), abs(y - cy)) < 9.0:                       # the main streets
            continue
        if any(abs(math.sin(a - math.radians(d))) < 0.09 and math.cos(a - math.radians(d)) > 0
               for d in (45, 135, 225, 315)):                         # the lanes
            continue
        if any(math.hypot(x - sx, y - sy) < 4.5 for (sx, sy, _) in STALLS):
            continue
        if any(_inside_poly(np.array([x]), np.array([y]), p)[0] for p in church_polys()):
            continue
        out.append((x, y))
    return out


def to_gltf(x, y):
    return [round(float(x), 2), round(float(-y), 2)]


# ---------------------------------------------------------------- trees

def _inside_poly(x, y, poly):
    poly = np.asarray(poly, dtype=np.float64)
    inside = np.zeros(np.shape(x), dtype=bool)
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        c = ((ay > y) != (by > y)) & (x < (bx - ax) * (y - ay) / ((by - ay) or 1e-12) + ax)
        inside ^= c
    return inside


def trees():
    """[(species, x, y, scale, rot)] in Blender xy. Deterministic."""
    rnd = random.Random(7)
    out = []

    def add(sp, x, y, s=1.0):
        out.append((sp, float(x), float(y), s * rnd.uniform(0.85, 1.15), rnd.uniform(0, 2 * math.pi)))

    # ginkgo avenue, both sides
    pts = _resample(np.array(PARK_PATHS[0][2], dtype=float), 9.0)
    for i in range(1, len(pts) - 1):
        a, b = pts[i - 1], pts[i + 1]
        t = (b - a) / np.linalg.norm(b - a)
        n = np.array([-t[1], t[0]])
        for side in (-1, 1):
            p = pts[i] + n * side * 6.3
            add('ichou', p[0], p[1], 1.05)
    # cherries round the lawn and along the pond
    (lx, ly), (rx, ry) = LAWN
    for k in range(34):
        a = k / 34 * 2 * math.pi + rnd.uniform(-0.04, 0.04)
        r = 1.0 + rnd.uniform(0.05, 0.16)
        add('sakura', lx + math.cos(a) * rx * r, ly + math.sin(a) * ry * r, 1.15)
    for i in range(len(POND)):
        a = np.array(POND[i], float)
        b = np.array(POND[(i + 1) % len(POND)], float)
        c = (a + b) / 2
        o = c - np.array([206.0, 112.0])
        o /= np.linalg.norm(o)
        p = c + o * 6.5
        add('sakura' if i % 3 else 'momiji', p[0], p[1], 1.0)
    # town: plane trees in a ring round the church square, and in the small parks (lots.parks)
    for (x, y) in square_trees():
        add('platanus', x, y, 1.0)
    from . import lots
    for (sp, x, y, s) in lots.park_trees():
        add(sp, x, y, s)
    # onsen: maples round the bath, a pine by the gate
    for (x, y) in [(10, -140), (62, -139), (66, -150), (6, -154), (66, -158), (48, -110), (20, -110)]:
        add('momiji', x, y, 0.9)
    add('matsu', 44, -111, 0.9)
    # the woods in the park's north-west, the mountain forest, scattered park trees
    def free(x, y, r):
        """Not on a path, a trail, the lawn, the pond or the onsen."""
        for _, w, p in PARK_PATHS:
            d, _, _ = _seg_dist(np.array([x]), np.array([y]), np.array(p, float))
            if d[0] < w / 2 + r:
                return False
        for _, p, _ in trails():
            d, _, _ = _seg_dist(np.array([x]), np.array([y]), p)
            if d[0] < TRAIL_W / 2 + r + 0.5:
                return False
        if ((x - lx) / (rx + 2)) ** 2 + ((y - ly) / (ry + 2)) ** 2 < 1:
            return False
        if _inside_poly(np.array([x]), np.array([y]), POND)[0] or math.hypot(x - 206, y - 112) < 30:
            return False
        if 2 < x < 70 and -162 < y < -106:
            return False
        if math.hypot(x - PARK_FOUNTAIN[0], y - PARK_FOUNTAIN[1]) < PARK_PLAZA_R + 4:
            return False
        if math.hypot(x - MOUNT[0], y - MOUNT[1]) < SUMMIT_R + 5:
            return False
        cx0, cy0, cx1, cy1 = COLLEGE['precinct']
        if cx0 - 4 < x < cx1 + 4 and cy0 - 4 < y < cy1 + 4:
            return False
        for (_, _, tx, ty, _, _) in [(0, 0, *t[1:3], 0, 0) for t in out[-200:]]:
            if (tx - x) ** 2 + (ty - y) ** 2 < 16:
                return False
        return True

    mix_low = ['keyaki', 'nara', 'momiji', 'kaede', 'momiji', 'ichou', 'shirakaba', 'sakura']
    mix_high = ['nara', 'kaede', 'momiji', 'sugi', 'matsu', 'matsu', 'shirakaba', 'keyaki']
    for _ in range(6000):
        x = rnd.uniform(6, 238)
        y = rnd.uniform(-158, 158)
        mh = float(mountain_height(x, y))
        md = math.hypot((x - MOUNT[0]) / MOUNT_R[0], (y - MOUNT[1]) / MOUNT_R[1])
        if md < 1.02:
            dens = 0.55
            pool = mix_high if mh > MOUNT_H * 0.55 else mix_low
            # the top is an open meadow with a few pines: the view from the summit
            if mh > MOUNT_H * 0.72:
                dens = 0.04 if math.hypot(x - MOUNT[0], y - MOUNT[1]) > 25 else 0.0
                pool = ['matsu']
            # and the slope below it towards the town is meadow too, so nothing stands in front of the view
            a = math.atan2(y - MOUNT[1], x - MOUNT[0])
            toward = math.atan2(CHURCH[1] - MOUNT[1], CHURCH[0] - MOUNT[0])
            if mh > MOUNT_H * 0.4 and abs((a - toward + math.pi) % (2 * math.pi) - math.pi) < math.radians(55):
                dens = 0.0
        elif 8 < x < 58 and 30 < y < 150:
            dens = 0.5
            pool = ['keyaki', 'nara', 'kaede', 'momiji', 'ichou', 'shirakaba']
        elif x > 225 or y > 148 or (x > 200 and y < 60):
            dens = 0.6
            pool = ['sugi', 'keyaki', 'nara', 'matsu']
        else:
            dens = 0.035
            pool = ['keyaki', 'momiji', 'platanus', 'sakura', 'ichou']
        if rnd.random() > dens:
            continue
        if not free(x, y, 2.5):
            continue
        add(rnd.choice(pool), x, y, rnd.uniform(0.8, 1.2))
    return out
