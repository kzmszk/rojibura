"""Town lots: houses lined up along the streets and round the church square, as data (no bpy)."""
import math, random

import numpy as np

from . import plan

OCC_RES = 0.5
_houses = None

# plaster tints (sRGB 0..1): cream, ochre, salmon, sage, pale blue, white, rose, straw
PALETTE = [(0.93, 0.88, 0.76), (0.90, 0.74, 0.48), (0.88, 0.66, 0.56), (0.74, 0.80, 0.66), (0.72, 0.80, 0.86),
           (0.95, 0.94, 0.90), (0.90, 0.72, 0.72), (0.86, 0.82, 0.62)]


def poly_cells(poly, x0, y0, res, shape):
    """(slices, mask) of the grid cells whose centres are inside `poly`, or None if it is off the grid."""
    poly = np.asarray(poly, float)
    ix0 = max(int((poly[:, 0].min() - x0) / res) - 1, 0)
    ix1 = min(int((poly[:, 0].max() - x0) / res) + 2, shape[1])
    iy0 = max(int((poly[:, 1].min() - y0) / res) - 1, 0)
    iy1 = min(int((poly[:, 1].max() - y0) / res) + 2, shape[0])
    if ix1 <= ix0 or iy1 <= iy0:
        return None
    gx, gy = np.meshgrid(x0 + (np.arange(ix0, ix1) + 0.5) * res, y0 + (np.arange(iy0, iy1) + 0.5) * res)
    return (slice(iy0, iy1), slice(ix0, ix1)), plan._inside_poly(gx, gy, poly)


def rect(cx, cy, tx, ty, u0, u1, n0, n1):
    """Corners of a rectangle in the frame at (cx, cy) with tangent t and normal (-ty, tx)."""
    nx, ny = -ty, tx
    return [(cx + tx * u + nx * n, cy + ty * u + ny * n) for (u, n) in [(u0, n0), (u1, n0), (u1, n1), (u0, n1)]]


def street_quads(pts, w, ext=0.3):
    """A street polyline as one quad per segment (overlapping a little at the joints)."""
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        a = np.array(a, float)
        b = np.array(b, float)
        L = float(np.linalg.norm(b - a))
        t = (b - a) / L
        out.append(rect(a[0], a[1], t[0], t[1], -w * ext, L + w * ext, -w / 2, w / 2))
    return out


def _ring_of(name):
    """(radius of the street's centre line) for the ring roads, else None."""
    return {'ring1': plan.RING1[0], 'ring2': plan.RING2[0]}.get(name)


_occ = None


def _grid():
    gx, gy = np.meshgrid(GX0 + (np.arange(SHAPE[1]) + 0.5) * OCC_RES, GY0 + (np.arange(SHAPE[0]) + 0.5) * OCC_RES)
    return gx, gy


GX0, GY0 = -240.0, -160.0
SHAPE = (int(320 / OCC_RES), int(240 / OCC_RES))


def houses():
    """Dicts: front centre `o`, tangent `t` along the street (the house is on the side of (-ty, tx)), width `w`,
    depth `d`, and style. Houses front the streets: the ring roads (facing the church on the inner one), the main
    streets, the grid; nothing is put behind them, so every block is a ring of houses round a garden."""
    global _houses, _occ
    if _houses is not None:
        return _houses
    rnd = random.Random(11)
    occ = np.zeros(SHAPE, dtype=bool)
    gx, gy = _grid()
    out_ring = np.hypot(gx - plan.TOWN_C[0], gy - plan.TOWN_C[1]) > plan.RING_OUT - 0.6

    def mark(poly, where=None):
        r = poly_cells(poly, GX0, GY0, OCC_RES, SHAPE)
        if r:
            s, m = r
            occ[s] |= m if where is None else (m & where[s])

    def free(poly):
        r = poly_cells(poly, GX0, GY0, OCC_RES, SHAPE)
        if not r:
            return False
        s, m = r
        return m.any() and not (occ[s] & m).any()

    # houses keep off the streets, the square, the shops and 2.5 m inside the walls
    for name, w, pts in plan.STREETS:
        for q in street_quads(pts, w + 0.4, 0.0 if _ring_of(name) else 0.3):
            mark(q)
    cx, cy = plan.TOWN_C
    mark([(cx + math.cos(a) * (plan.SQUARE_R + 0.2), cy + math.sin(a) * (plan.SQUARE_R + 0.2))
          for a in np.linspace(0, 2 * math.pi, 96, endpoint=False)])
    for s in plan.SHOPS:
        a, b, c, d = s['lot']
        mark([(a - 0.6, b - 0.6), (c + 0.6, b - 0.6), (c + 0.6, d + 0.6), (a - 0.6, d + 0.6)])
    m = plan.WALL_T / 2 + 2.5
    big = 1000
    for poly in [[(-big, -big), (plan.WALL_W + m, -big), (plan.WALL_W + m, big), (-big, big)],
                 [(plan.WALL_E - m, -big), (big, -big), (big, big), (plan.WALL_E - m, big)],
                 [(-big, plan.WALL_N - m), (big, plan.WALL_N - m), (big, big), (-big, big)],
                 [(-big, -big), (big, -big), (big, plan.WALL_S + m), (-big, plan.WALL_S + m)]]:
        mark(poly)

    out = []
    # (street, sides): the inner ring has houses on its outer side only, facing the church; then the outer ring,
    # the main streets and lanes, the grid
    order = lambda n: 0 if n == 'ring1' else 1 if n == 'ring2' else 2
    fronts = [(name, w, pts, (-1,) if name == 'ring1' else (-1, 1))
              for name, w, pts in sorted(plan.STREETS, key=lambda st: order(st[0]))]
    for name, w, pts, sides in fronts:
        ring = _ring_of(name)
        inner = name.startswith(('ring1', 'main', 'west', 'north', 'south', 'lane0', 'lane1', 'lane2', 'lane3'))
        pts = np.array(pts, float)
        seg = np.hypot(*(pts[1:] - pts[:-1]).T)
        cum = np.concatenate([[0], np.cumsum(seg)])
        for side in sides:
            s = 0.5
            # the same kind of house all along one side of a street, so it reads as a row
            floors = rnd.choice([3, 4] if inner else [2, 3])
            while s < cum[-1] - 4:
                fw = rnd.uniform(6.5, 8.5)
                sm = min(s + fw / 2, cum[-1])
                i = min(int(np.searchsorted(cum, sm, side='right') - 1), len(pts) - 2)
                t = (pts[i + 1] - pts[i]) / seg[i]
                p = pts[i] + t * (sm - cum[i])
                tt = t * side   # the house lies on the side of (-tt.y, tt.x)
                ox = p[0] - tt[1] * (w / 2 + 0.25)
                oy = p[1] + tt[0] * (w / 2 + 0.25)
                placed = None
                for depth in (rnd.uniform(9.5, 10.2), 8.0, 6.5):
                    if free(rect(ox, oy, tt[0], tt[1], -fw / 2, fw / 2, 0.0, depth)):
                        mark(rect(ox, oy, tt[0], tt[1], -fw / 2 - 0.1, fw / 2 + 0.1, -0.1, depth + 0.1))
                        out.append({
                            'o': (float(ox), float(oy)), 't': (float(tt[0]), float(tt[1])), 'w': fw, 'd': depth,
                            'floors': floors if rnd.random() < 0.8 else max(2, floors + rnd.choice([-1, 1])),
                            'style': rnd.choice(['timber', 'timber', 'timber', 'plaster', 'stone']),
                            'gable': rnd.random() < 0.6,          # gable end towards the street
                            'colour': rnd.choice(PALETTE),
                            'roof': rnd.choice(['clay', 'clay', 'clay', 'slate']),
                            'seed': rnd.randrange(1 << 30),
                        })
                        placed = depth
                        break
                step = fw if placed is not None else 1.5
                if ring and placed is not None:
                    # round a ring the fronts (outer side) or the backs (inner side) are what touch
                    r_front = ring + side * -1 * (w / 2 + 0.25)
                    r_touch = r_front if side < 0 else r_front - placed
                    step = fw * ring / r_touch + 0.05
                s += step
    _houses = out
    _occ = occ
    return out


_parks = None


def parks():
    """The small parks: what is left between the houses beyond the outer ring (and in the blocks' gardens), as
    [(mask (ny, nx) bool over the 0.5 m grid, area m², centroid)], biggest first. Walkable lawns."""
    global _parks
    if _parks is not None:
        return _parks
    houses()
    gx, gy = _grid()
    r = np.hypot(gx - plan.TOWN_C[0], gy - plan.TOWN_C[1])
    t = plan.WALL_T / 2 + plan.LANE_W + 0.4
    inside = ((gx > plan.WALL_W + t) & (gx < plan.WALL_E - t) & (gy > plan.WALL_S + t) & (gy < plan.WALL_N - t))
    # the streets themselves (without the margin the houses keep) are not lawn either
    street = np.zeros(SHAPE, dtype=bool)
    for name, w, pts in plan.STREETS:
        for q in street_quads(pts, w, 0.0 if _ring_of(name) else 0.3):
            rr = poly_cells(q, GX0, GY0, OCC_RES, SHAPE)
            if rr:
                s, m = rr
                street[s] |= m
    lawn = inside & (r > plan.RING_OUT + 0.3) & ~_occ & ~street
    # the 0.2 m the houses keep round themselves: lawn up to their walls
    lab = _label(lawn)
    out = []
    for k in range(1, lab.max() + 1):
        mk = lab == k
        n = int(mk.sum())
        area = n * OCC_RES * OCC_RES
        if area < 20:
            continue
        out.append((mk, area, (float(gx[mk].mean()), float(gy[mk].mean()))))
    out.sort(key=lambda p: -p[1])
    _parks = out
    return out


def _label(mask):
    """4-connected components of a bool grid (1..n, 0 outside)."""
    lab = np.zeros(mask.shape, dtype=np.int32)
    n = 0
    ny, nx = mask.shape
    for j0, i0 in zip(*np.nonzero(mask)):
        if lab[j0, i0]:
            continue
        n += 1
        stack = [(j0, i0)]
        lab[j0, i0] = n
        while stack:
            j, i = stack.pop()
            for jj, ii in ((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)):
                if 0 <= jj < ny and 0 <= ii < nx and mask[jj, ii] and not lab[jj, ii]:
                    lab[jj, ii] = n
                    stack.append((jj, ii))
    return lab


def _erode(mask, k):
    m = mask.copy()
    for _ in range(k):
        e = m.copy()
        e[1:, :] &= m[:-1, :]
        e[:-1, :] &= m[1:, :]
        e[:, 1:] &= m[:, :-1]
        e[:, :-1] &= m[:, 1:]
        m = e
    return m


_furniture = None


def _park_furniture():
    """(trees [(species, x, y, scale)], benches [(x, y, angle)], wells [(x, y)]) in the parks."""
    global _furniture
    if _furniture is not None:
        return _furniture
    rnd = random.Random(23)
    gx, gy = _grid()
    trees, benches, wells = [], [], []
    for idx, (mk, area, (mx, my)) in enumerate(parks()):
        # a well in the two biggest, near the middle
        deep = _erode(mk, 6)
        if idx < 2 and deep.any():
            j, i = _nearest(deep, gx, gy, mx, my)
            wells.append((float(gx[j, i]), float(gy[j, i])))
        # trees 3 m clear of the houses, 7 m apart
        ok = _erode(mk, 6)
        cand = list(zip(*np.nonzero(ok)))
        rnd.shuffle(cand)
        want = max(1, int(area / 90))
        placed = []
        for (j, i) in cand:
            if len(placed) >= want:
                break
            x, y = float(gx[j, i]), float(gy[j, i])
            if any(math.hypot(x - a, y - b) < 7.0 for (a, b) in placed + wells):
                continue
            placed.append((x, y))
            trees.append((rnd.choice(['platanus', 'sakura', 'keyaki', 'momiji', 'kaede', 'sakura']), x, y,
                          rnd.uniform(0.75, 0.95)))
        # a bench or two in the bigger ones, by a tree, facing the middle
        if area > 150:
            for (x, y) in placed[:1 if area < 500 else 2]:
                a = math.atan2(my - y, mx - x)
                bx, by = x + math.cos(a) * 1.8, y + math.sin(a) * 1.8
                j, i = int((by - GY0) / OCC_RES), int((bx - GX0) / OCC_RES)
                if 0 <= j < SHAPE[0] and 0 <= i < SHAPE[1] and _erode(mk, 3)[j, i]:
                    benches.append((bx, by, a + math.pi / 2))
    _furniture = (trees, benches, wells)
    return _furniture


def _nearest(mask, gx, gy, x, y):
    js, is_ = np.nonzero(mask)
    k = int(np.argmin((gx[js, is_] - x) ** 2 + (gy[js, is_] - y) ** 2))
    return js[k], is_[k]


def park_trees():
    return _park_furniture()[0]


def park_benches():
    return _park_furniture()[1]


def wells():
    return _park_furniture()[2]
