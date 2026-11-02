"""The ground: park terrain and the mountain, the town's cobbles, the church square, paths, trails, the land
beyond the area, and the winter snow lying on all of it (snow_soft_* / snow_trod_*, shown only in winter)."""
import math

import numpy as np

from . import geom, plan

SNOW = 0.2        # fresh snow depth on lawns and roofs
TROD = 0.05       # trampled snow on streets and paths


def _grid_faces(nx, ny, keep=None):
    """Quads of an (ny, nx) vertex grid; `keep` (ny-1, nx-1) bool chooses cells."""
    F = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            if keep is not None and not keep[j, i]:
                continue
            a = j * nx + i
            F.append((a, a + 1, a + nx + 1, a + nx))
    return F


def _noise2(x, y, s):
    return (np.sin(x * 0.11 * s + 1.3) * np.sin(y * 0.13 * s + 0.4) + 0.5 * np.sin(x * 0.37 * s + y * 0.29 * s)) / 1.5


def _paths():
    """Every park path and trail as (points, half width, heights or None)."""
    out = []
    for name, w, pts in plan.PARK_PATHS:
        out.append((geom.resample(geom.smooth_corners(pts, 6.0), 1.0), w / 2, None))
    for name, pts, h in plan.trails():
        out.append((pts, plan.TRAIL_W / 2, h))
    return out


def _path_dist(X, Y):
    """Distance from points to the nearest path or trail edge (negative inside), and to the fountain plaza."""
    d = np.full(X.shape, 1e9)
    for pts, hw, _ in _paths():
        dd, _, _ = plan._seg_dist(X, Y, pts)
        d = np.minimum(d, dd - hw)
    px, py, _ = plan.PARK_FOUNTAIN
    d = np.minimum(d, np.hypot(X - px, Y - py) - plan.PARK_PLAZA_R)
    return d


def pond_depth(X, Y):
    """How far the pond's bed is below the ground: 1.2 m inside, sloping in over 3 m."""
    inside = plan._inside_poly(X, Y, plan.POND)
    c = np.array(plan.POND, float).mean(0)
    r = np.hypot(X - c[0], Y - c[1])
    k = np.clip((24.0 - r) / 6.0, 0, 1)
    return np.where(inside, 1.2 * np.maximum(k, 0.35), 0.0)


def park(W):
    step = 1.0
    xs = np.arange(-4.0, plan.X1 + 0.01, step)
    ys = np.arange(plan.Y0, plan.Y1 + 0.01, step)
    X, Y = np.meshgrid(xs, ys)
    H = plan.ground_height(X.ravel(), Y.ravel()).reshape(X.shape)
    H = H - pond_depth(X, Y)
    # under the onsen's bath the ground goes down below its floor (it would show through the water)
    from .walk import offset_poly
    pool = plan._inside_poly(X, Y, offset_poly(np.array(plan.ONSEN['pool'], float), 1.0))
    H = np.where(pool, plan.ONSEN['floor'] - 0.1, H)
    ny, nx = X.shape
    V = np.stack([X.ravel(), Y.ravel(), H.ravel()], 1)
    # colour: lawns fresh, woods and the mountain browner and darker, a little mottled
    md = np.hypot((X - plan.MOUNT[0]) / plan.MOUNT_R[0], (Y - plan.MOUNT[1]) / plan.MOUNT_R[1])
    wood = np.clip((1.08 - md) / 0.1, 0, 1)
    wood = np.maximum(wood, ((X > 8) & (X < 58) & (Y > 30) & (Y < 150)).astype(float) * 0.8)
    wood = np.maximum(wood, ((X > 222) | (Y > 146)).astype(float) * 0.8)
    n = _noise2(X, Y, 1.0) * 0.07 + _noise2(X, Y, 3.1) * 0.04
    lawn = np.array([1.0, 1.0, 0.92])
    woods = np.array([0.66, 0.6, 0.42])
    C = lawn[None, None, :] * (1 - wood[..., None]) + woods[None, None, :] * wood[..., None]
    C = C * (1 + n[..., None])
    dpath = _path_dist(X, Y)
    worn = np.clip(1 - (dpath - 0.2) / 1.2, 0, 1)
    C = C * (1 - 0.18 * worn[..., None]) + np.array([0.75, 0.68, 0.55]) * 0.18 * worn[..., None]
    W.tri_mesh(V, _grid_faces(nx, ny), 'grass', C.reshape(-1, 3).clip(0, 1), name='ground_park')

    # winter: 20 cm of snow everywhere except the paths, banked up at their edges; not on the pond
    k = np.clip((dpath - 0.1) / 1.4, 0, 1)
    k = k * k * (3 - 2 * k)
    S = H + SNOW * k + 0.015 - 0.04 * (1 - k)
    inside_pond = plan._inside_poly(X, Y, plan.POND)
    keep = ~(inside_pond[:-1, :-1] | inside_pond[1:, 1:])
    # nor inside the onsen deck (it has its own)
    a, b, c, d = plan.ONSEN['deck']
    on = (X > a - 2) & (X < c + 2) & (Y > b - 2) & (Y < d + 0.3)
    keep &= ~(on[:-1, :-1] & on[1:, 1:])
    # nor inside the college (it has its own, on the lawns and the court)
    cx0, cy0, cx1, cy1 = plan.COLLEGE['precinct']
    co = (X > cx0) & (X < cx1) & (Y > cy0) & (Y < cy1)
    keep &= ~(co[:-1, :-1] | co[1:, 1:])
    VS = np.stack([X.ravel(), Y.ravel(), S.ravel()], 1)
    W.tri_mesh(VS, _grid_faces(nx, ny, keep), 'snow_soft', None, name='snow_soft_park', tile=3.0)
    return X, Y, H


def town(W):
    """Cobbles everywhere inside the walls (streets and yards alike), the church square on top."""
    step = 4.0
    xs = np.arange(plan.X0, -3.9, step)
    xs = np.append(xs, -4.0)
    ys = np.arange(plan.Y0, plan.Y1 + 0.01, step)
    X, Y = np.meshgrid(xs, ys)
    ny, nx = X.shape
    V = np.stack([X.ravel(), Y.ravel(), np.zeros(X.size)], 1)
    n = _noise2(X, Y, 0.7) * 0.08
    C = np.stack([0.95 + n, 0.93 + n, 0.9 + n], -1)
    W.tri_mesh(V, _grid_faces(nx, ny), 'cobble', C.reshape(-1, 3), name='ground_town')
    VS = V.copy()
    VS[:, 2] = TROD
    W.tri_mesh(VS, _grid_faces(nx, ny), 'snow_trod', None, name='snow_trod_town', tile=2.0)
    # the church square and the plaza in front of the door (one outline), with a kerb
    x0, y0, x1, y1 = plan.SQUARE
    px0, py0, px1, py1 = plan.PLAZA
    outline = [(x0, y0), (x1, y0), (x1, py0), (px1, py0), (px1, py1), (x1, py1), (x1, y1), (x0, y1)]
    z = 0.08
    pts = [(x, y, z) for x, y in outline]
    # split into the two rectangles (the outline is not convex)
    W.face([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], 'cobble_square', name='square')
    W.face([(px0, py0, z), (px1, py0, z), (px1, py1, z), (px0, py1, z)], 'cobble_square', name='square')
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        if (a[0] == x1 and b[0] == x1 and abs(a[1]) < py1 + 0.1 and abs(b[1]) < py1 + 0.1):
            continue   # the plaza continues there
        W.face([(a[0], a[1], 0), (b[0], b[1], 0), (b[0], b[1], z), (a[0], a[1], z)], 'stone', name='square')
    W.face([(x0, y0, z + 0.12), (x1, y0, z + 0.12), (x1, y1, z + 0.12), (x0, y1, z + 0.12)], 'snow_trod',
           name='snow_trod_square', tile=2.0)
    W.face([(px0, py0, z + 0.12), (px1, py0, z + 0.12), (px1, py1, z + 0.12), (px0, py1, z + 0.12)], 'snow_trod',
           name='snow_trod_square', tile=2.0)


def paths(W):
    """Gravel paths in the park, the earth trails up the mountain with log steps where steep, the fountain
    plaza; trampled snow on all of them."""
    for pts, hw, h in _paths():
        z = plan.ground_height(pts[:, 0], pts[:, 1]) if h is None else h
        mat = 'gravel' if h is None else 'trail'
        geom.ribbon(W, pts, hw * 2, z, mat, None, name='paths', lift=0.04, sides=0.08)
        geom.ribbon(W, pts, hw * 2 - 0.1, z, 'snow_trod', None, name='snow_trod_paths', lift=0.04 + TROD)
        if h is not None:
            # log steps across the trail where it climbs more than 1 in 9
            last = -10.0
            s = 0.0
            for i in range(1, len(pts) - 1):
                s += float(np.hypot(*(pts[i] - pts[i - 1])))
                g = (h[i + 1] - h[i - 1]) / 2.0
                if g > 0.11 and s - last > 1.6:
                    last = s
                    t = pts[i + 1] - pts[i - 1]
                    t /= np.linalg.norm(t)
                    f = geom.Frame((pts[i][0], pts[i][1], h[i] + 0.04), t)
                    geom.box(W, f, -0.09, 0.09, -hw + 0.1, hw - 0.1, -0.02, 0.09, 'timber', (0.7, 0.62, 0.52),
                             name='trail_logs')
    px, py, _ = plan.PARK_FOUNTAIN
    r = plan.PARK_PLAZA_R
    seg = 48
    ring = [(px + math.cos(2 * math.pi * i / seg) * r, py + math.sin(2 * math.pi * i / seg) * r) for i in range(seg)]
    hz = float(plan.ground_height(px, py)) + 0.05
    for i in range(seg):
        a, b = ring[i], ring[(i + 1) % seg]
        W.face([(px, py, hz), (a[0], a[1], hz), (b[0], b[1], hz)], 'stone', name='paths')
        W.face([(a[0], a[1], hz - 0.12), (b[0], b[1], hz - 0.12), (b[0], b[1], hz), (a[0], a[1], hz)], 'stone',
               name='paths')
        W.face([(px, py, hz + TROD), (a[0], a[1], hz + TROD), (b[0], b[1], hz + TROD)], 'snow_trod',
               name='snow_trod_paths', tile=2.0)


def far(W):
    """The land beyond the area out to ~900 m: fields round the town, wooded hills behind the park."""
    step = 10.0
    xs = np.arange(-1000.0, 1000.01, step)
    ys = np.arange(-900.0, 900.01, step)
    X, Y = np.meshgrid(xs, ys)
    # distance outside the area
    dx = np.maximum(np.maximum(plan.X0 - X, X - plan.X1), 0)
    dy = np.maximum(np.maximum(plan.Y0 - Y, Y - plan.Y1), 0)
    dout = np.hypot(dx, dy)
    hills = 85.0 * np.clip((dout - 60) / 500, 0, 1) ** 1.5 * (0.6 + 0.4 * np.sin(X * 0.006 + 1) * np.sin(Y * 0.007))
    hills += 6.0 * np.clip(dout / 200, 0, 1) * _noise2(X, Y, 0.15)
    # the east and north rise sooner (wooded hills behind the park), the town's side stays open fields
    east = np.clip((X + 50) / 300, 0, 1)
    hills += 35.0 * east * np.clip(dout / 220, 0, 1) ** 1.2
    H = np.maximum(plan.natural_height(X, Y), 0) + np.maximum(hills, 0)
    inside = (X > plan.X0 + 3) & (X < plan.X1 - 3) & (Y > plan.Y0 + 3) & (Y < plan.Y1 - 3)
    keep = ~(inside[:-1, :-1] & inside[1:, 1:] & inside[:-1, 1:] & inside[1:, :-1])
    H = np.where(inside, H - 0.15, H)
    ny, nx = X.shape
    V = np.stack([X.ravel(), Y.ravel(), H.ravel()], 1)
    # fields: a patchwork of greens and straw; forests dark on the hills
    fx = np.floor(X / 70.0)
    fy = np.floor(Y / 50.0)
    pick = (np.sin(fx * 12.9898 + fy * 78.233) * 43758.5453) % 1.0
    field = np.stack([0.75 + 0.25 * pick, 0.8 + 0.1 * pick, 0.5 + 0.2 * (1 - pick)], -1)
    forest = np.array([0.42, 0.5, 0.36])
    fk = np.clip((H - 8) / 25, 0, 1)[..., None]
    fk = np.maximum(fk, (east * np.clip(dout / 80, 0, 1))[..., None] * 0.9)
    C = field * (1 - fk) + forest * fk
    W.tri_mesh(V, _grid_faces(nx, ny, keep), 'grass', C.reshape(-1, 3), name='ground_far', uv=V[:, :2] / 6.0)
    VS = V.copy()
    VS[:, 2] += 0.35
    W.tri_mesh(VS, _grid_faces(nx, ny, keep), 'snow_soft', None, name='snow_soft_far', uv=V[:, :2] / 8.0)
