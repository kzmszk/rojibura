"""Town lots: houses lined up along the streets and round the church square, as data (no bpy)."""
import random

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


def houses():
    """Dicts: front centre `o`, tangent `t` along the street (the house is on the side of (-ty, tx)), width `w`,
    depth `d`, and style."""
    global _houses
    if _houses is not None:
        return _houses
    rnd = random.Random(11)
    gx0, gy0 = -240.0, -160.0
    shape = (int(320 / OCC_RES), int(240 / OCC_RES))
    occ = np.zeros(shape, dtype=bool)

    def mark(poly):
        r = poly_cells(poly, gx0, gy0, OCC_RES, shape)
        if r:
            s, m = r
            occ[s] |= m

    def free(poly):
        r = poly_cells(poly, gx0, gy0, OCC_RES, shape)
        if not r:
            return False
        s, m = r
        return m.any() and not (occ[s] & m).any()

    # houses keep off the streets, the square, the shops and 2.5 m inside the walls
    for _, w, pts in plan.STREETS:
        for q in street_quads(pts, w + 0.4):
            mark(q)
    x0, y0, x1, y1 = plan.SQUARE
    mark([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
    x0, y0, x1, y1 = plan.PLAZA
    mark([(x0, y0), (x1 + 1, y0), (x1 + 1, y1), (x0, y1)])
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
    x0, y0, x1, y1 = plan.SQUARE
    # (name, street width, polyline, sides). The square's edges come first, with houses on their outer side
    # only, fronts to the square; then the streets (houses on both sides, fronts to the street).
    fronts = [('sq_n', 0.0, [(x0, y1), (x1, y1)], (1,)), ('sq_s', 0.0, [(x1, y0), (x0, y0)], (1,)),
              ('sq_w', 0.0, [(x0, y0), (x0, y1)], (1,)), ('sq_e1', 0.0, [(x1, y1), (x1, 26)], (1,)),
              ('sq_e2', 0.0, [(x1, -26), (x1, y0)], (1,)),
              ('pl_n', 0.0, [(-62, 26), (-38, 26)], (1,)), ('pl_s', 0.0, [(-38, -26), (-62, -26)], (1,))]
    fronts += [(name, w, pts, (-1, 1)) for name, w, pts in plan.STREETS]
    for name, w, pts, sides in fronts:
        pts = np.array(pts, float)
        seg = np.hypot(*(pts[1:] - pts[:-1]).T)
        cum = np.concatenate([[0], np.cumsum(seg)])
        for side in sides:
            s = 0.5
            while s < cum[-1] - 4:
                fw = rnd.uniform(6.0, 9.5)
                sm = min(s + fw / 2, cum[-1])
                i = min(int(np.searchsorted(cum, sm, side='right') - 1), len(pts) - 2)
                t = (pts[i + 1] - pts[i]) / seg[i]
                p = pts[i] + t * (sm - cum[i])
                tt = t * side   # the house lies on the side of (-tt.y, tt.x)
                ox = p[0] - tt[1] * (w / 2 + 0.25)
                oy = p[1] + tt[0] * (w / 2 + 0.25)
                placed = False
                for depth in (rnd.uniform(9.5, 13.0), 8.0, 6.5):
                    if free(rect(ox, oy, tt[0], tt[1], -fw / 2, fw / 2, 0.0, depth)):
                        mark(rect(ox, oy, tt[0], tt[1], -fw / 2 - 0.1, fw / 2 + 0.1, -0.1, depth + 0.1))
                        busy = name.startswith(('sq', 'pl', 'main'))
                        out.append({
                            'o': (float(ox), float(oy)), 't': (float(tt[0]), float(tt[1])), 'w': fw, 'd': depth,
                            'floors': rnd.choice([3, 3, 3, 4, 2] if busy else [2, 2, 3, 3, 4]),
                            'style': rnd.choice(['timber', 'timber', 'timber', 'plaster', 'stone']),
                            'gable': rnd.random() < 0.6,          # gable end towards the street
                            'colour': rnd.choice(PALETTE),
                            'roof': rnd.choice(['clay', 'clay', 'clay', 'slate']),
                            'seed': rnd.randrange(1 << 30),
                        })
                        placed = True
                        break
                s += fw if placed else 1.5
    # back houses fill the blocks, turned like the nearest street; a few yards stay open
    segs = []
    for _, _, pts in plan.STREETS:
        for a, b in zip(pts[:-1], pts[1:]):
            segs.append((np.array(a, float), np.array(b, float)))
    for _ in range(2500):
        x = rnd.uniform(plan.WALL_W + 3, plan.WALL_E - 3)
        y = rnd.uniform(plan.WALL_S + 3, plan.WALL_N - 3)
        best = None
        for a, b in segs:
            v = b - a
            t = np.clip(np.dot((x, y) - a, v) / np.dot(v, v), 0, 1)
            d = np.hypot(*(a + t * v - (x, y)))
            if best is None or d < best[0]:
                best = (d, v / np.linalg.norm(v))
        if best[0] < 8:
            continue
        tt = best[1]
        fw = rnd.uniform(6.5, 10.0)
        depth = rnd.uniform(7.0, 11.0)
        poly = rect(x, y, tt[0], tt[1], -fw / 2, fw / 2, -depth / 2, depth / 2)
        if not free(poly):
            continue
        mark(rect(x, y, tt[0], tt[1], -fw / 2 - 0.1, fw / 2 + 0.1, -depth / 2 - 0.1, depth / 2 + 0.1))
        # its front is the side facing the street
        out.append({
            'o': (float(x + tt[1] * depth / 2), float(y - tt[0] * depth / 2)), 't': (float(tt[0]), float(tt[1])),
            'w': fw, 'd': depth, 'floors': rnd.choice([2, 2, 3, 3]),
            'style': rnd.choice(['timber', 'timber', 'plaster', 'stone']), 'gable': rnd.random() < 0.5,
            'colour': rnd.choice(PALETTE), 'roof': rnd.choice(['clay', 'clay', 'slate']),
            'seed': rnd.randrange(1 << 30), 'back': True,
        })
    _houses = out
    return out
