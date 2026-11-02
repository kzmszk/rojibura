"""Mesh building without bpy: faces with UVs and colours collected per (material, chunk), turned into Blender
meshes at the end (bl.py). Positions in Blender's frame (x east, y north, z up), metres.

UVs are projected per face from world positions (so textures tile at their real size and line up across
faces): horizontal faces take (x, y); others take (along the face horizontally, up the face).
"""
import math

import numpy as np

# texture tile size per material (metres per repeat); materials not listed get 1 m
TILE = {}
CHUNK = 120.0


class Bucket:
    __slots__ = ('v', 'f', 'uv', 'col')

    def __init__(self):
        self.v = []
        self.f = []
        self.uv = []
        self.col = []


class World:
    """All geometry, by (object name prefix, material, chunk)."""

    def __init__(self):
        self.b = {}

    def bucket(self, name, mat, cx, cy):
        key = (name, mat, int(math.floor((cx + 240) / CHUNK)), int(math.floor((cy + 160) / CHUNK)))
        b = self.b.get(key)
        if b is None:
            b = self.b[key] = Bucket()
        return b

    def face(self, pts, mat, col=(1, 1, 1), name=None, uv=None, tile=None):
        """A planar convex polygon (counter-clockwise seen from the side it faces)."""
        pts = [tuple(map(float, p)) for p in pts]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        b = self.bucket(name or mat, mat, cx, cy)
        if uv is None:
            uv = project_uv(pts, tile or TILE.get(mat, 1.0))
        i0 = len(b.v)
        b.v.extend(pts)
        b.uv.extend(uv)
        c = tuple(col) + (1.0,) if len(col) == 3 else tuple(col)
        b.col.extend([c] * len(pts))
        b.f.append(tuple(range(i0, i0 + len(pts))))

    def tri_mesh(self, V, F, mat, col=None, name=None, uv=None, tile=None):
        """Many triangles/quads sharing vertices (terrain, ribbons). V (n, 3), F list of index tuples,
        col (n, 3|4) per vertex, uv (n, 2) or None for planar (x, y) / tile."""
        V = np.asarray(V, float)
        cx, cy = V[:, 0].mean(), V[:, 1].mean()
        b = self.bucket(name or mat, mat, cx, cy)
        i0 = len(b.v)
        b.v.extend(map(tuple, V))
        t = tile or TILE.get(mat, 1.0)
        if uv is None:
            uv = V[:, :2] / t
        b.uv.extend(map(tuple, np.asarray(uv, float)))
        if col is None:
            col = np.ones((len(V), 4))
        col = np.asarray(col, float)
        if col.shape[1] == 3:
            col = np.hstack([col, np.ones((len(col), 1))])
        b.col.extend(map(tuple, col))
        b.f.extend(tuple(i0 + int(k) for k in f) for f in F)


def project_uv(pts, tile):
    p = np.array(pts)
    n = np.cross(p[1] - p[0], p[2] - p[0])
    if np.linalg.norm(n) < 1e-12 and len(p) > 3:
        n = np.cross(p[2] - p[0], p[3] - p[0])
    ln = np.linalg.norm(n)
    n = n / ln if ln > 1e-12 else np.array([0, 0, 1.0])
    if abs(n[2]) > 0.75:
        return [(q[0] / tile, q[1] / tile) for q in p]
    t = np.array([-n[1], n[0], 0.0])
    t /= np.linalg.norm(t)
    bvec = np.cross(n, t)
    return [(float(np.dot(q, t)) / tile, float(np.dot(q, bvec)) / tile) for q in p]


class Frame:
    """A local frame: origin o (x, y, z), tangent t (unit, horizontal); n = (-ty, tx) to its left; z up."""

    def __init__(self, o, t):
        self.o = np.array([o[0], o[1], o[2] if len(o) > 2 else 0.0], float)
        tt = np.array([t[0], t[1], 0.0], float)
        self.t = tt / np.linalg.norm(tt)
        self.n = np.array([-self.t[1], self.t[0], 0.0])

    def p(self, u, n, z):
        return self.o + self.t * u + self.n * n + np.array([0, 0, z])

    def sub(self, u, n, z=0.0, turn=0.0):
        """A frame moved and turned (degrees, counter-clockwise) within this one."""
        c, s = math.cos(math.radians(turn)), math.sin(math.radians(turn))
        t = self.t * c + self.n * s
        return Frame(self.p(u, n, z), t[:2])


def box(W, f, u0, u1, n0, n1, z0, z1, mat, col=(1, 1, 1), name=None, bottom=False, tile=None, skip=()):
    """An axis-aligned box in frame f. `skip` names faces to leave out: 'u0', 'u1', 'n0', 'n1', 'top'."""
    P = lambda u, n, z: f.p(u, n, z)
    faces = {
        'n0': [P(u0, n0, z0), P(u1, n0, z0), P(u1, n0, z1), P(u0, n0, z1)],
        'n1': [P(u1, n1, z0), P(u0, n1, z0), P(u0, n1, z1), P(u1, n1, z1)],
        'u0': [P(u0, n1, z0), P(u0, n0, z0), P(u0, n0, z1), P(u0, n1, z1)],
        'u1': [P(u1, n0, z0), P(u1, n1, z0), P(u1, n1, z1), P(u1, n0, z1)],
        'top': [P(u0, n0, z1), P(u1, n0, z1), P(u1, n1, z1), P(u0, n1, z1)],
    }
    if bottom:
        faces['bottom'] = [P(u0, n0, z0), P(u0, n1, z0), P(u1, n1, z0), P(u1, n0, z0)]
    for k, q in faces.items():
        if k not in skip:
            W.face(q, mat, col, name, tile=tile)


def prism(W, f, poly, z0, z1, mat, col=(1, 1, 1), name=None, top=True, bottom=False, tile=None, top_mat=None):
    """A vertical prism over a polygon given in (u, n) of frame f (counter-clockwise)."""
    m = len(poly)
    for i in range(m):
        a, b = poly[i], poly[(i + 1) % m]
        W.face([f.p(a[0], a[1], z0), f.p(b[0], b[1], z0), f.p(b[0], b[1], z1), f.p(a[0], a[1], z1)], mat, col, name,
               tile=tile)
    if top:
        tri_fan(W, [f.p(u, n, z1) for (u, n) in poly], top_mat or mat, col, name, tile=tile)
    if bottom:
        tri_fan(W, [f.p(u, n, z0) for (u, n) in reversed(poly)], mat, col, name, tile=tile)


def tri_fan(W, pts, mat, col=(1, 1, 1), name=None, tile=None):
    """A polygon that may not be convex but is star-shaped from its centroid."""
    if len(pts) <= 4:
        W.face(pts, mat, col, name, tile=tile)
        return
    c = np.mean(np.array(pts), axis=0)
    for i in range(len(pts)):
        W.face([c, pts[i], pts[(i + 1) % len(pts)]], mat, col, name, tile=tile)


def cylinder(W, x, y, z0, z1, r, mat, col=(1, 1, 1), name=None, seg=12, top=True, r1=None, tile=None):
    r1 = r if r1 is None else r1
    for i in range(seg):
        a0 = 2 * math.pi * i / seg
        a1 = 2 * math.pi * (i + 1) / seg
        p = [(x + math.cos(a0) * r, y + math.sin(a0) * r, z0), (x + math.cos(a1) * r, y + math.sin(a1) * r, z0),
             (x + math.cos(a1) * r1, y + math.sin(a1) * r1, z1), (x + math.cos(a0) * r1, y + math.sin(a0) * r1, z1)]
        L = 2 * math.pi * r / seg
        W.face(p, mat, col, name, uv=[(i * L, z0), ((i + 1) * L, z0), ((i + 1) * L, z1), (i * L, z1)]
               if tile is None else None, tile=tile)
    if top and r1 > 0:
        tri_fan(W, [(x + math.cos(2 * math.pi * i / seg) * r1, y + math.sin(2 * math.pi * i / seg) * r1, z1)
                    for i in range(seg)], mat, col, name)


def ribbon(W, pts, w, heights, mat, col=None, name=None, lift=0.03, tile=None, sides=0.0):
    """A strip of width w along a polyline (n, 2) at the given heights (n,) + lift; UV u across, v along.
    `sides` > 0 adds kerbs: the strip's edges drop by that much."""
    pts = np.asarray(pts, float)
    n = len(pts)
    tan = np.zeros_like(pts)
    tan[1:-1] = pts[2:] - pts[:-2]
    tan[0] = pts[1] - pts[0]
    tan[-1] = pts[-1] - pts[-2]
    tan /= np.linalg.norm(tan, axis=1)[:, None]
    nor = np.stack([-tan[:, 1], tan[:, 0]], 1)
    s = np.concatenate([[0], np.cumsum(np.hypot(*(pts[1:] - pts[:-1]).T))])
    t = tile or TILE.get(mat, 1.0)
    V, UV, F = [], [], []
    cols = []
    for i in range(n):
        for k, side in enumerate((-1, 1)):
            p = pts[i] + nor[i] * side * w / 2
            V.append((p[0], p[1], heights[i] + lift))
            UV.append((p[0] / t, p[1] / t))
    for i in range(n - 1):
        a = 2 * i
        F.append((a, a + 1, a + 3, a + 2))
    if sides > 0:
        base = len(V)
        for i in range(n):
            for side in (-1, 1):
                p = pts[i] + nor[i] * side * (w / 2 + 0.02)
                V.append((p[0], p[1], heights[i] + lift - sides))
                UV.append((s[i] / t, 0))
        for i in range(n - 1):
            l0, r0 = 2 * i, 2 * i + 1
            F.append((base + l0 + 2, base + l0, l0, l0 + 2))
            F.append((base + r0, base + r0 + 2, r0 + 2, r0))
    W.tri_mesh(V, F, mat, col, name, uv=UV)


def resample(pts, step):
    pts = np.asarray(pts, float)
    seg = np.hypot(*(pts[1:] - pts[:-1]).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, s[-1], step)
    t = np.append(t, s[-1])
    return np.stack([np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])], 1)


def smooth_corners(pts, r=4.0, n=5):
    """A polyline with its corners rounded (each corner replaced by a little arc of radius about r)."""
    pts = [np.array(p, float) for p in pts]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i - 1], pts[i], pts[i + 1]
        d1 = (b - a) / np.linalg.norm(b - a)
        d2 = (c - b) / np.linalg.norm(c - b)
        k = min(r, np.linalg.norm(b - a) / 2.2, np.linalg.norm(c - b) / 2.2)
        p0 = b - d1 * k
        p1 = b + d2 * k
        for j in range(n + 1):
            t = j / n
            out.append((1 - t) ** 2 * p0 + 2 * (1 - t) * t * b + t * t * p1)
    out.append(pts[-1])
    return np.array(out)
