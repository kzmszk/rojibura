"""Town houses in the manner of old Venice (issue 42): three to five storeys of weathered plaster in ochre, Venetian
red, apricot and cream (some of bare brick, some with the plaster fallen off the ground floor), Istrian stone
round the windows and doors, along the storeys and at the foot; round-headed or pointed Gothic windows with green
shutters, a piano nobile with a trifora and a stone balcony on the wider houses, iron balconies and flower boxes,
low hipped roofs of old coppi with a stone cornice, bell-topped chimneys, wooden altane on some roofs, shop fronts
with awnings, and a cap of snow for winter. Walls are wall_* materials, tinted by vertex colour and weathered in
the browser (apps/city-client/src/weathering.ts)."""
import math, random

import numpy as np

from . import geom, lots
from .ground import SNOW

H0 = 3.4      # ground storey
HF = 3.0      # upper storeys

# Venetian plaster (sRGB, as the vertex colours are): ochre, apricot, terracotta, Venetian red, salmon, cream, pale
# yellow, grey-white, rose (after the VENEZIA demo's gen/materials.py)
PALETTE = [(214, 160, 102), (226, 176, 124), (199, 120, 82), (176, 84, 62), (222, 150, 120), (232, 214, 178),
           (226, 196, 128), (205, 200, 190), (214, 168, 150), (190, 110, 70), (236, 190, 140), (168, 96, 74),
           (220, 205, 170), (200, 150, 96)]
PALETTE = [tuple(min(1.0, c / 255 * 1.06) for c in p) for p in PALETTE]
# shutter greens (and a few browns), doors
SHUTTER = [(0.42, 0.62, 0.45), (0.36, 0.55, 0.42), (0.48, 0.68, 0.52), (0.55, 0.45, 0.33), (0.55, 0.6, 0.52),
           (0.32, 0.5, 0.44)]
DOOR = [(0.36, 0.5, 0.38), (0.5, 0.38, 0.28), (0.42, 0.3, 0.22), (0.3, 0.4, 0.42)]
ISTRIAN = (0.97, 0.95, 0.9)
AWNING = [((0.75, 0.2, 0.18), (0.95, 0.92, 0.85)), ((0.2, 0.42, 0.3), (0.95, 0.92, 0.85)),
          ((0.2, 0.32, 0.6), (0.95, 0.92, 0.85)), ((0.85, 0.55, 0.15), (0.45, 0.25, 0.15))]
FLOWERS = [(0.86, 0.15, 0.2), (0.95, 0.45, 0.6), (0.98, 0.85, 0.3), (0.7, 0.3, 0.75), (0.95, 0.95, 0.95)]


def wall_face(W, f, n, u0, u1, z0, z1, mat, col, facing):
    """A wall quad at depth n, facing -n (facing=-1, the street side) or +n (facing=+1)."""
    if facing < 0:
        W.face([f.p(u0, n, z0), f.p(u1, n, z0), f.p(u1, n, z1), f.p(u0, n, z1)], mat, col, 'houses')
    else:
        W.face([f.p(u1, n, z0), f.p(u0, n, z0), f.p(u0, n, z1), f.p(u1, n, z1)], mat, col, 'houses')


def side_face(W, f, u, n0, n1, z0, z1, mat, col, facing):
    """A wall quad at u, facing -u (facing=-1) or +u."""
    if facing < 0:
        W.face([f.p(u, n1, z0), f.p(u, n0, z0), f.p(u, n0, z1), f.p(u, n1, z1)], mat, col, 'houses')
    else:
        W.face([f.p(u, n0, z0), f.p(u, n1, z0), f.p(u, n1, z1), f.p(u, n0, z1)], mat, col, 'houses')


def window(W, f, u, n, z, ww, wh, facing, rnd, shutters, flowers, frame_col=(0.92, 0.9, 0.85)):
    """A window on a wall at depth n (the wall faces -n if facing < 0): glass a little behind its frame."""
    out = facing   # +1: outward is +n, -1: outward is -n
    g = n + out * 0.02
    fr = 0.09
    pr = 0.07
    # glass
    if out < 0:
        W.face([f.p(u - ww / 2, g, z), f.p(u + ww / 2, g, z), f.p(u + ww / 2, g, z + wh), f.p(u - ww / 2, g, z + wh)],
               'glass', name='houses')
    else:
        W.face([f.p(u + ww / 2, g, z), f.p(u - ww / 2, g, z), f.p(u - ww / 2, g, z + wh), f.p(u + ww / 2, g, z + wh)],
               'glass', name='houses')
    n0, n1 = sorted((n, n + out * pr))
    # frame and a cross
    geom.box(W, f, u - ww / 2 - fr, u - ww / 2, n0, n1, z - fr, z + wh + fr, 'paint', frame_col, 'houses')
    geom.box(W, f, u + ww / 2, u + ww / 2 + fr, n0, n1, z - fr, z + wh + fr, 'paint', frame_col, 'houses')
    geom.box(W, f, u - ww / 2, u + ww / 2, n0, n1, z + wh, z + wh + fr, 'paint', frame_col, 'houses')
    geom.box(W, f, u - 0.03, u + 0.03, n0, n1, z, z + wh, 'paint', frame_col, 'houses')
    geom.box(W, f, u - ww / 2, u + ww / 2, n0, n1, z + wh * 0.62, z + wh * 0.62 + 0.05, 'paint', frame_col, 'houses')
    # sill
    s0, s1 = sorted((n, n + out * 0.16))
    geom.box(W, f, u - ww / 2 - 0.12, u + ww / 2 + 0.12, s0, s1, z - fr - 0.06, z - fr, 'stone', (1, 1, 1), 'houses')
    if shutters is not None:
        for side in (-1, 1):
            a = u + side * (ww / 2 + fr + 0.02)
            b = a + side * ww / 2
            ua, ub = sorted((a, b))
            h0, h1 = sorted((n + out * 0.02, n + out * 0.06))
            geom.box(W, f, ua, ub, h0, h1, z - 0.02, z + wh + 0.02, 'paint', shutters, 'houses')
            # slats
            for k in range(1, 5):
                zz = z + wh * k / 5
                geom.box(W, f, ua + 0.03, ub - 0.03, h1 - 0.005, h1 + 0.01, zz - 0.012, zz + 0.012, 'paint',
                         tuple(c * 0.82 for c in shutters), 'houses')
    if flowers:
        b0, b1 = sorted((n + out * 0.02, n + out * 0.32))
        geom.box(W, f, u - ww / 2 - 0.05, u + ww / 2 + 0.05, b0, b1, z - fr - 0.3, z - fr - 0.06, 'wood',
                 (0.7, 0.55, 0.4), 'houses')
        for k in range(7):
            uu = u - ww / 2 + (k + 0.5) * ww / 7 + rnd.uniform(-0.04, 0.04)
            nn = (b0 + b1) / 2 + rnd.uniform(-0.06, 0.06)
            r = rnd.uniform(0.08, 0.13)
            col = rnd.choice(FLOWERS) if rnd.random() < 0.7 else (0.25, 0.5, 0.2)
            geom.box(W, f, uu - r, uu + r, nn - r, nn + r, z - fr - 0.08, z - fr - 0.08 + r * 1.6, 'flowers', col,
                     'flowers')


def roof(W, f, u0, u1, n0, n1, zb, pitch, along_n, mat, ov=0.45, ovg=0.35, snow=True):
    """A gable roof over the box u0..u1 x n0..n1 whose walls end at zb. along_n: the ridge runs along n."""
    tp = math.tan(math.radians(pitch))
    if along_n:
        half = (u1 - u0) / 2
        um = (u0 + u1) / 2
        zr = zb + half * tp
        ze = zb - ov * tp
        A, B = n0 - ovg, n1 + ovg
        slopes = [
            [f.p(u0 - ov, A, ze), f.p(um, A, zr), f.p(um, B, zr), f.p(u0 - ov, B, ze)][::-1],
            [f.p(um, A, zr), f.p(u1 + ov, A, ze), f.p(u1 + ov, B, ze), f.p(um, B, zr)][::-1],
        ]
        gables = [((u0, n0), (u1, n0), (um, n0), -1), ((u0, n1), (u1, n1), (um, n1), 1)]
    else:
        half = (n1 - n0) / 2
        nm = (n0 + n1) / 2
        zr = zb + half * tp
        ze = zb - ov * tp
        A, B = u0 - ovg, u1 + ovg
        slopes = [
            [f.p(A, n0 - ov, ze), f.p(B, n0 - ov, ze), f.p(B, nm, zr), f.p(A, nm, zr)],
            [f.p(A, nm, zr), f.p(B, nm, zr), f.p(B, n1 + ov, ze), f.p(A, n1 + ov, ze)],
        ]
        gables = None
    for s in slopes:
        _orient_up(s)
        W.face(s, mat, (1, 1, 1), 'roofs')
        # underside (eaves seen from the street) and the fascia
        under = [np.array(p) - np.array([0, 0, 0.14]) for p in s[::-1]]
        W.face(under, 'timber', (0.75, 0.65, 0.55), 'roofs')
        for i in range(4):
            a, b = np.array(s[i]), np.array(s[(i + 1) % 4])
            W.face([a, b, b - (0, 0, 0.14), a - (0, 0, 0.14)][::-1], 'timber', (0.6, 0.5, 0.4), 'roofs')
        if snow:
            _snow_slab(W, s, pitch)
    return zr


def _orient_up(q):
    v = np.cross(np.array(q[1]) - q[0], np.array(q[2]) - q[0])
    if v[2] < 0:
        q.reverse()


def _snow_slab(W, s, pitch):
    """20 cm of snow on a roof slope (a polygon), a little short of the eaves, with rounded-looking edges."""
    s = [np.array(p, float) for p in s]
    c = sum(s) / len(s)
    nrm = np.cross(s[1] - s[0], s[2] - s[0])
    nrm /= np.linalg.norm(nrm)
    shrink = [c + (p - c) * 0.97 for p in s]
    # thinner on steep roofs (snow slides)
    t = SNOW * max(0.35, math.cos(math.radians(pitch)) * 1.3)
    top = [p + nrm * t for p in shrink]
    W.face(top, 'snow_soft', name='snow_soft_roofs')
    for i in range(len(s)):
        a, b = shrink[i], shrink[(i + 1) % len(s)]
        at, bt = top[i], top[(i + 1) % len(s)]
        W.face([a, b, bt, at][::-1] if np.dot(np.cross(b - a, at - a), (a + b) / 2 - c) < 0 else [a, b, bt, at],
               'snow_soft', name='snow_soft_roofs')


class Facade:
    """Drawing on one wall of a house: the wall plane at depth n of frame f, its outside towards -n (out = -1) or
    +n (out = +1). Shapes are given in (u, z) on the wall, counter-clockwise as seen from outside, and put `d`
    metres out from the wall."""

    def __init__(self, W, f, n, out):
        self.W, self.f, self.n, self.out = W, f, n, out

    def p(self, u, z, d=0.0):
        return self.f.p(u, self.n + self.out * d, z)

    def poly(self, uz, d, mat, col=(1, 1, 1), name='houses'):
        pts = [self.p(u, z, d) for (u, z) in uz]
        self.W.face(pts if self.out < 0 else pts[::-1], mat, col, name)

    def _outward(self, pts, ref):
        v = np.cross(np.array(pts[1]) - pts[0], np.array(pts[2]) - pts[0])
        return pts if np.dot(v, ref) >= 0 else pts[::-1]

    def edge(self, a, b, d0, d1, mat, col, toward, name='houses'):
        """The face from depth d0 to d1 along a -> b (u, z), facing `toward` (+1: away from the shape's middle
        `self.mid`, -1: towards it)."""
        pts = [self.p(a[0], a[1], d0), self.p(b[0], b[1], d0), self.p(b[0], b[1], d1), self.p(a[0], a[1], d1)]
        mu, mz = (a[0] + b[0]) / 2 - self.mid[0], (a[1] + b[1]) / 2 - self.mid[1]
        ref = (self.f.t * mu + np.array([0, 0, mz])) * toward
        self.W.face(self._outward(pts, ref), mat, col, name)

    def block(self, u0, u1, z0, z1, d, mat, col=(1, 1, 1), d0=0.0, name='houses', sides=True):
        """A slab on the wall, from d0 out to d (no back): a frame's jamb, a string course, a sill."""
        self.poly([(u0, z0), (u1, z0), (u1, z1), (u0, z1)], d, mat, col, name)
        if sides:
            self.mid = ((u0 + u1) / 2, (z0 + z1) / 2)
            for a, b in (((u0, z0), (u1, z0)), ((u1, z0), (u1, z1)), ((u1, z1), (u0, z1)), ((u0, z1), (u0, z0))):
                self.edge(a, b, d0, d, mat, col, 1, name)


def arch_height(w, kind):
    return w / 2 if kind == 'round' else w * math.sqrt(0.64 - 0.09) if kind == 'pointed' else 0.0


def arch(u, zs, w, kind, seg=6):
    """The head of an opening of width w springing at zs: points from the left spring to the right one, over the
    top. kind: 'round' (a half circle), 'pointed' (Venetian Gothic: two arcs meeting in a point), 'flat'."""
    if kind == 'flat':
        return [(u - w / 2, zs), (u + w / 2, zs)]
    if kind == 'round':
        return [(u - math.cos(math.pi * i / seg) * w / 2, zs + math.sin(math.pi * i / seg) * w / 2)
                for i in range(seg + 1)]
    # pointed: each side an arc of radius 0.8 w round a centre on the springing line, inside the opposite jamb
    r = 0.8 * w
    cl = u - w / 2 + r          # centre of the left side's arc
    top = math.sqrt(r * r - (u - cl) ** 2)
    a1 = math.atan2(top, u - cl)
    left = [(cl + r * math.cos(math.pi + (a1 - math.pi) * i / (seg // 2)),
             zs + r * math.sin(math.pi + (a1 - math.pi) * i / (seg // 2))) for i in range(seg // 2 + 1)]
    right = [(2 * u - x, z) for (x, z) in reversed(left[:-1])]
    return left + right


def plain_window(F, u, z0, w, h, rnd, shutters=None, fr=0.11):
    """A window at the back or on a side wall (seen from afar, if at all): glass in a flat stone frame, a sill,
    flat shutters."""
    zs = z0 + h
    F.poly([(u - w / 2, z0), (u + w / 2, z0), (u + w / 2, zs), (u - w / 2, zs)], 0.02, 'glass')
    for (a, b, c, d) in ((u - w / 2 - fr, u - w / 2, z0, zs), (u + w / 2, u + w / 2 + fr, z0, zs),
                         (u - w / 2 - fr, u + w / 2 + fr, zs, zs + fr), (u - w / 2 - fr - 0.05, u + w / 2 + fr + 0.05,
                                                                         z0 - 0.09, z0)):
        F.block(a, b, c, d, 0.04, 'trim_istrian', ISTRIAN, sides=False)
    if shutters is not None:
        for side in (-1, 1):
            a = u + side * (w / 2 + fr + 0.02)
            ua, ub = sorted((a, a + side * w / 2))
            F.block(ua, ub, z0, zs, 0.05, 'shutter', shutters, sides=False)


def opening(F, u, z0, w, h, kind, rnd, shutters=None, fr=0.13, deep=0.1, sill=True, glass='glass'):
    """A window or a door of Istrian stone: the glass (or door) set back, a stone frame round it standing out
    `deep`, a sill, and green shutters folded back against the wall (or, now and then, closed)."""
    zs = z0 + h - arch_height(w, kind)
    head = arch(u, zs, w, kind)
    # head is left -> right over the top; the opening's outline counter-clockwise: bottom left, bottom right, up
    # the right jamb, over the head right to left
    inner = [(u - w / 2, z0), (u + w / 2, z0)] + list(reversed(head))
    closed = shutters is not None and rnd.random() < 0.18
    # the glass (or the closed shutters) in the opening, a little in front of the wall
    if closed:
        F.poly(inner, 0.02, 'shutter', shutters)
    else:
        F.poly(inner, 0.02, glass)
        if glass == 'glass':
            # glazing bars: a cross
            F.block(u - 0.025, u + 0.025, z0, zs, 0.035, 'paint', (0.92, 0.9, 0.85), d0=0.02, sides=False)
            F.block(u - w / 2, u + w / 2, z0 + (zs - z0) * 0.6, z0 + (zs - z0) * 0.6 + 0.05, 0.035, 'paint',
                    (0.92, 0.9, 0.85), d0=0.02, sides=False)
    # the frame: jambs, and a band round the head (its own outline a frame's width out)
    F.block(u - w / 2 - fr, u - w / 2, z0, zs, deep, 'trim_istrian', ISTRIAN)
    F.block(u + w / 2, u + w / 2 + fr, z0, zs, deep, 'trim_istrian', ISTRIAN)
    if kind == 'flat':
        F.block(u - w / 2 - fr, u + w / 2 + fr, zs, zs + fr * 1.3, deep + 0.03, 'trim_istrian', ISTRIAN)
        # a little cornice over it
        F.block(u - w / 2 - fr - 0.08, u + w / 2 + fr + 0.08, zs + fr * 1.3, zs + fr * 1.3 + 0.07, deep + 0.09,
                'trim_istrian', ISTRIAN)
    else:
        outer = arch(u, zs, w + 2 * fr, kind)
        F.mid = (u, zs)
        for i in range(len(head) - 1):
            a, b = head[i], head[i + 1]
            A, B = outer[i], outer[i + 1]
            F.poly([a, b, B, A], deep, 'trim_istrian', ISTRIAN)
            F.edge(a, b, 0.02, deep, 'trim_istrian', ISTRIAN, -1)
        if kind == 'pointed':
            # a little keystone flame at the point
            tu, tz = outer[len(outer) // 2]
            F.poly([(tu - 0.07, tz - 0.02), (tu + 0.07, tz - 0.02), (tu, tz + 0.22)], deep + 0.01, 'trim_istrian',
                   ISTRIAN)
    if sill:
        F.block(u - w / 2 - fr - 0.06, u + w / 2 + fr + 0.06, z0 - 0.1, z0, deep + 0.08, 'trim_istrian', ISTRIAN)
    if shutters is not None and not closed:
        # folded back flat against the wall either side, as tall as the opening up to its springing
        for side in (-1, 1):
            a = u + side * (w / 2 + fr + 0.02)
            b = a + side * w / 2
            ua, ub = sorted((a, b))
            F.block(ua, ub, z0, zs, 0.06, 'shutter', shutters, sides=False)


def balcony_stone(F, u0, u1, z, depth=0.75):
    """A stone balcony on brackets with a balustrade."""
    F.block(u0, u1, z - 0.16, z, depth, 'trim_istrian', ISTRIAN)
    for uu in np.linspace(u0 + 0.2, u1 - 0.2, max(2, int((u1 - u0) / 0.9) + 1)):
        F.block(uu - 0.08, uu + 0.08, z - 0.5, z - 0.16, 0.4, 'trim_istrian', ISTRIAN)
    # rail and plinth, front and ends
    W, f, n, out = F.W, F.f, F.n, F.out
    dn = lambda d: n + out * d
    n0, n1 = sorted((dn(depth - 0.12), dn(depth)))
    geom.box(W, f, u0, u1, n0, n1, z + 0.86, z + 0.98, 'trim_istrian', ISTRIAN, 'houses')
    geom.box(W, f, u0, u1, n0, n1, z, z + 0.1, 'trim_istrian', ISTRIAN, 'houses')
    for uu in np.arange(u0 + 0.12, u1 - 0.05, 0.19):
        geom.box(W, f, uu - 0.045, uu + 0.045, n0 + 0.01, n1 - 0.01, z + 0.1, z + 0.86, 'trim_istrian', ISTRIAN,
                 'houses', skip=('top',))
    for uu in (u0, u1 - 0.12):
        m0, m1 = sorted((dn(0.0), dn(depth)))
        geom.box(W, f, uu, uu + 0.12, m0, m1, z + 0.86, z + 0.98, 'trim_istrian', ISTRIAN, 'houses')
        geom.box(W, f, uu, uu + 0.12, m0, m1, z, z + 0.1, 'trim_istrian', ISTRIAN, 'houses')
        geom.box(W, f, uu + 0.02, uu + 0.1, m0, m1, z + 0.1, z + 0.86, 'trim_istrian', ISTRIAN, 'houses',
                 skip=('top',))


def balcony_iron(F, u0, u1, z, depth=0.45):
    """A small iron balcony: a stone slab and a railing of bars."""
    F.block(u0, u1, z - 0.1, z, depth, 'trim_istrian', ISTRIAN)
    W, f, n, out = F.W, F.f, F.n, F.out
    n0, n1 = sorted((n + out * (depth - 0.05), n + out * depth))
    geom.box(W, f, u0, u1, n0, n1, z + 0.92, z + 0.96, 'metal', (1, 1, 1), 'houses')
    for uu in np.arange(u0 + 0.05, u1, 0.13):
        geom.box(W, f, uu - 0.012, uu + 0.012, n0, n1, z, z + 0.92, 'metal', (1, 1, 1), 'houses', skip=('top',))
    for uu in (u0, u1):
        m0, m1 = sorted((n, n + out * depth))
        geom.box(W, f, uu - 0.015, uu + 0.015, m0, m1, z + 0.92, z + 0.96, 'metal', (1, 1, 1), 'houses')


def flower_box(F, u, z, w, rnd):
    F.block(u - w / 2, u + w / 2, z - 0.24, z, 0.3, 'wood', (0.6, 0.45, 0.32))
    W, f, n, out = F.W, F.f, F.n, F.out
    k = max(3, int(w / 0.22))
    for i in range(k):
        uu = u - w / 2 + (i + 0.5) * w / k + rnd.uniform(-0.03, 0.03)
        nn = n + out * (0.15 + rnd.uniform(-0.05, 0.05))
        r = rnd.uniform(0.1, 0.15)
        col = rnd.choice(FLOWERS) if rnd.random() < 0.65 else (0.25, 0.5, 0.2)
        geom.box(W, f, uu - r, uu + r, nn - r, nn + r, z - 0.02, z - 0.02 + r * 1.5, 'flowers', col, 'flowers')


def portal(F, u, w, h, kind, door_col):
    """The front door: wooden leaves in a stone portal, a step."""
    zs = h - (w / 2 if kind == 'round' else 0)
    head = arch(u, zs, w, 'round' if kind == 'round' else 'flat')
    inner = [(u - w / 2, 0.0), (u + w / 2, 0.0)] + list(reversed(head))
    F.poly(inner, 0.03, 'wood_door', door_col)
    F.block(u - 0.02, u + 0.02, 0.0, zs, 0.045, 'wood_door', tuple(c * 0.7 for c in door_col), d0=0.03,
            sides=False)
    fr = 0.22
    F.block(u - w / 2 - fr, u - w / 2, 0.0, zs, 0.14, 'trim_istrian', ISTRIAN)
    F.block(u + w / 2, u + w / 2 + fr, 0.0, zs, 0.14, 'trim_istrian', ISTRIAN)
    if kind == 'round':
        outer = arch(u, zs, w + 2 * fr, 'round')
        F.mid = (u, zs)
        for i in range(len(head) - 1):
            F.poly([head[i], head[i + 1], outer[i + 1], outer[i]], 0.14, 'trim_istrian', ISTRIAN)
            F.edge(outer[i], outer[i + 1], 0.0, 0.14, 'trim_istrian', ISTRIAN, 1)
            F.edge(head[i], head[i + 1], 0.03, 0.14, 'trim_istrian', ISTRIAN, -1)
        # keystone
        F.block(u - 0.12, u + 0.12, zs + w / 2 - 0.05, zs + w / 2 + fr + 0.08, 0.18, 'trim_istrian', ISTRIAN)
    else:
        F.block(u - w / 2 - fr, u + w / 2 + fr, zs, zs + 0.3, 0.16, 'trim_istrian', ISTRIAN)
    F.mid = (u, zs / 2)
    F.edge((u - w / 2, 0.0), (u - w / 2, zs), 0.03, 0.14, 'trim_istrian', ISTRIAN, -1)
    F.edge((u + w / 2, zs), (u + w / 2, 0.0), 0.03, 0.14, 'trim_istrian', ISTRIAN, -1)
    F.block(u - w / 2 - 0.15, u + w / 2 + 0.15, 0.0, 0.14, 0.42, 'trim_istrian', (0.9, 0.89, 0.86))
    # a brass handle
    F.block(u + 0.12, u + 0.18, 1.0, 1.08, 0.08, 'metal', (1, 1, 1), d0=0.03)


def hip_roof(W, f, u0, u1, n0, n1, zb, pitch, mat, ov=0.55):
    """A low hipped roof over u0..u1 x n0..n1 (walls ending at zb), its eaves `ov` out, with a cap of snow.
    Returns the ridge height."""
    a0, a1, b0, b1 = u0 - ov, u1 + ov, n0 - ov, n1 + ov
    tp = math.tan(math.radians(pitch))
    ze = zb - ov * tp
    w, d = a1 - a0, b1 - b0
    h = min(w, d) / 2
    zr = ze + h * tp
    A, B, C, D = f.p(a0, b0, ze), f.p(a1, b0, ze), f.p(a1, b1, ze), f.p(a0, b1, ze)
    if w >= d:
        R0, R1 = f.p(a0 + h, (b0 + b1) / 2, zr), f.p(a1 - h, (b0 + b1) / 2, zr)
        faces = [[A, B, R1, R0], [C, D, R0, R1], [D, A, R0], [B, C, R1]]
    else:
        R0, R1 = f.p((a0 + a1) / 2, b0 + h, zr), f.p((a0 + a1) / 2, b1 - h, zr)
        faces = [[B, C, R1, R0], [D, A, R0, R1], [A, B, R0], [C, D, R1]]
    for q in faces:
        q = [np.array(p, float) for p in q]
        _orient_up(q)
        W.face(q, mat, (1, 1, 1), 'roofs')
        W.face([p - (0, 0, 0.12) for p in q[::-1]], 'wood_altana', (0.7, 0.6, 0.5), 'roofs')
        _snow_slab(W, q, pitch)
    for a, b in ((A, B), (B, C), (C, D), (D, A)):
        a, b = np.array(a), np.array(b)
        q = [b, a, a - (0, 0, 0.12), b - (0, 0, 0.12)]
        c = (a + b) / 2
        mid = np.array(f.p((u0 + u1) / 2, (n0 + n1) / 2, ze))
        v = np.cross(q[1] - q[0], q[2] - q[0])
        W.face(q if np.dot(v, c - mid) >= 0 else q[::-1], 'wood_altana', (0.55, 0.45, 0.36), 'roofs')
    return zr


def chimney(W, x, y, z0, z1, col, rnd):
    """A Venetian chimney: a plastered stack and a bell (campana) opening upwards, capped."""
    f = geom.Frame((x, y, 0), (1, 0))
    s = 0.24
    geom.box(W, f, -s, s, -s, s, z0, z1, 'wall_plaster', col, 'houses')
    geom.box(W, f, -s - 0.04, s + 0.04, -s - 0.04, s + 0.04, z1, z1 + 0.08, 'trim_istrian', ISTRIAN, 'houses')
    kind = rnd.random()
    if kind < 0.6:
        # the bell: wider at the top
        geom.cylinder(W, x, y, z1 + 0.08, z1 + 0.85, 0.24, 'wall_plaster', col, 'houses', seg=8, r1=0.5, top=False,
                      tile=2.2)
        geom.cylinder(W, x, y, z1 + 0.85, z1 + 0.95, 0.53, 'trim_istrian', ISTRIAN, 'houses', seg=8, tile=1.2)
        geom.cylinder(W, x, y, z1 + 0.95, z1 + 1.05, 0.53, 'snow_soft', (1, 1, 1), 'snow_soft_roofs', seg=8)
    elif kind < 0.85:
        # a square box with a little roof
        geom.box(W, f, -0.34, 0.34, -0.34, 0.34, z1 + 0.08, z1 + 0.6, 'wall_plaster', col, 'houses')
        geom.cylinder(W, x, y, z1 + 0.6, z1 + 0.85, 0.5, 'roof_coppi', (1, 1, 1), 'roofs', seg=4, r1=0.05)
    else:
        # a plain stack with a cap on two little piers
        for u in (-s, s - 0.08):
            geom.box(W, f, u, u + 0.08, -s, s, z1 + 0.08, z1 + 0.35, 'wall_brick', (0.9, 0.85, 0.8), 'houses')
        geom.box(W, f, -s - 0.06, s + 0.06, -s - 0.06, s + 0.06, z1 + 0.35, z1 + 0.43, 'trim_istrian', ISTRIAN,
                 'houses')


def altana(W, f, u0, u1, n0, n1, z):
    """A wooden roof terrace on posts above the roof, with a railing."""
    for (u, n) in ((u0, n0), (u1, n0), (u1, n1), (u0, n1)):
        geom.box(W, f, u - 0.07, u + 0.07, n - 0.07, n + 0.07, z - 2.2, z, 'wood_altana', (1, 1, 1), 'houses')
    geom.box(W, f, u0 - 0.1, u1 + 0.1, n0 - 0.1, n1 + 0.1, z, z + 0.1, 'wood_altana', (1, 1, 1), 'houses',
             bottom=True)
    geom.box(W, f, u0, u1, n0, n1, z + 0.1, z + 0.1 + SNOW * 0.8, 'snow_soft', (1, 1, 1), 'snow_soft_roofs')
    for (a, b, c, d) in ((u0, u1, n0, n0 + 0.06), (u0, u1, n1 - 0.06, n1), (u0, u0 + 0.06, n0, n1),
                         (u1 - 0.06, u1, n0, n1)):
        geom.box(W, f, a, b, c, d, z + 0.95, z + 1.02, 'wood_altana', (1, 1, 1), 'houses')
    for uu in np.arange(u0, u1 + 0.01, 0.5):
        for nn in (n0 + 0.03, n1 - 0.03):
            geom.box(W, f, uu - 0.025, uu + 0.025, nn - 0.025, nn + 0.025, z + 0.1, z + 0.95, 'wood_altana',
                     (1, 1, 1), 'houses', skip=('top',))
    for nn in np.arange(n0, n1 + 0.01, 0.5):
        for uu in (u0 + 0.03, u1 - 0.03):
            geom.box(W, f, uu - 0.025, uu + 0.025, nn - 0.025, nn + 0.025, z + 0.1, z + 0.95, 'wood_altana',
                     (1, 1, 1), 'houses', skip=('top',))


def look(hs):
    """A house's Venetian look, from its seed (lots.py places the houses; what they look like is up to here)."""
    rnd = random.Random(hs['seed'] ^ 0x5eed)
    r = rnd.random()
    wall = ('wall_plaster' if r < 0.6 else 'wall_red' if r < 0.75 else 'wall_ochre' if r < 0.89 else 'wall_brick')
    col = rnd.choice(PALETTE)
    if wall == 'wall_red':
        col = tuple(min(1, c * rnd.uniform(0.95, 1.08)) for c in (1.0, 0.92, 0.88))
    elif wall == 'wall_ochre':
        col = tuple(min(1, c * rnd.uniform(0.95, 1.05)) for c in (1.0, 0.86, 0.66))
    elif wall == 'wall_brick':
        col = tuple(c * rnd.uniform(0.92, 1.05) for c in (1.0, 0.95, 0.92))
    k = rnd.random()
    return {
        'wall': wall, 'col': col,
        # the ground floor: the same plaster, or the plaster fallen off its brick
        'ground': 'wall_peel' if wall != 'wall_brick' and rnd.random() < 0.35 else wall,
        'kind': 'round' if k < 0.42 else 'pointed' if k < 0.68 else 'flat',
        'shutters': rnd.choice(SHUTTER) if rnd.random() < 0.85 else None,
        'door': rnd.choice(DOOR),
        'nobile': rnd.random() < 0.55,
        'altana': rnd.random() < 0.16,
        'roof': 'roof_coppi',
        'rnd': rnd,
    }


def house(W, hs):
    """A Venetian house on its lot (lots.py): front centre o, the street along t, w wide, d deep."""
    L = look(hs)
    rnd = L['rnd']
    ox, oy = hs['o']
    f = geom.Frame((ox, oy, 0.0), hs['t'])
    w, d = hs['w'], hs['d']
    F_ = max(3, hs['floors'] + (1 if hs['floors'] < 4 and rnd.random() < 0.45 else 0))
    if hs.get('shop_ground'):
        F_ = hs['floors']
    u0, u1 = -w / 2, w / 2
    wall, col = L['wall'], L['col']
    # storeys: a tall ground floor, the piano nobile taller than those above
    zs = [0.0, H0]
    for k in range(1, F_):
        zs.append(zs[-1] + (HF + 0.5 if k == 1 else HF))
    top = zs[-1] + 0.5      # the attic under the cornice
    front = Facade(W, f, 0.0, -1)
    back = Facade(W, f, d, 1)
    # walls: front and back by storey (so the ground floor can be other), the ends whole
    for k in range(F_):
        z0, z1 = zs[k], zs[k + 1] if k + 1 < F_ else top
        if k == 0 and hs.get('shop_ground'):
            continue   # shops.py builds the ground storey, with its inside
        m = L['ground'] if k == 0 else wall
        wall_face(W, f, 0.0, u0, u1, z0, z1, m, col, -1)
        wall_face(W, f, d, u0, u1, z0, z1, m, col, 1)
    zb = H0 if hs.get('shop_ground') else 0.0
    side_face(W, f, u0, 0.0, d, zb, top, wall, col, -1)
    side_face(W, f, u1, 0.0, d, zb, top, wall, col, 1)
    if not hs.get('shop_ground'):
        # the foot of Istrian stone and the corners' quoins
        for F in (front, back):
            F.block(u0, u1, 0.0, 0.45, 0.05, 'trim_istrian', (0.86, 0.85, 0.82))
    # string courses at each floor, and the cornice
    for F in (front, back):
        for k in range(1, F_):
            F.block(u0, u1, zs[k] - 0.08, zs[k] + 0.08, 0.07, 'trim_istrian', ISTRIAN)
        F.block(u0 - 0.02, u1 + 0.02, top - 0.32, top - 0.18, 0.12, 'trim_istrian', ISTRIAN)
        F.block(u0 - 0.04, u1 + 0.04, top - 0.18, top, 0.24, 'trim_istrian', ISTRIAN)
    # windows in bays
    m = max(1, int((w - 0.8) // 2.0))
    us = [u0 + (i + 0.5) * w / m for i in range(m)]
    kind, shut = L['kind'], L['shutters']
    door_u = None
    if not hs.get('shop_ground'):
        door_u = us[rnd.randrange(m)] if m > 1 else 0.0
        portal(front, door_u, 1.2, 2.65, 'round' if kind != 'flat' else 'flat', L['door'])
        shopfront = hs.get('shopfront')
        for uu in us:
            if abs(uu - door_u) < 1.5:
                continue
            if shopfront:
                opening(front, uu, 0.6, min(1.6, w / m - 0.6), 2.3, 'round' if kind != 'flat' else 'flat', rnd,
                        None, glass='glass_shop', sill=True)
            else:
                # small barred windows on the ground floor
                opening(front, uu, 1.3, 0.75, 1.15, 'flat', rnd, None)
                for k in range(4):
                    bu = uu - 0.3 + k * 0.2
                    front.block(bu - 0.012, bu + 0.012, 1.3, 2.45, 0.08, 'metal', (1, 1, 1), d0=0.02, sides=False)
        if shopfront:
            awning(W, f, u0 + 0.2, u1 - 0.2, 0.0, 3.0, rnd.choice(AWNING))
        # a back door to the garden
        portal(back, us[0] if m > 1 else 0.0, 1.0, 2.3, 'flat', L['door'])
    trifora = L['nobile'] and w >= 6.8 and m >= 3
    for k in range(1, F_):
        z0 = zs[k]
        nob = k == 1
        wh = 2.15 if nob else 1.6 if k < F_ - 1 else 1.35
        ww = 0.95 if nob else 0.85
        flowers = rnd.random() < 0.35
        for i, uu in enumerate(us):
            if nob and trifora and i == m // 2:
                # the trifora: three arched lights between stone columns, onto a stone balcony
                tw = 0.62
                for j in (-1, 0, 1):
                    opening(front, uu + j * (tw + 0.16), z0 + 0.15, tw, wh + 0.2, 'pointed' if kind == 'pointed'
                            else 'round', rnd, None, fr=0.08, sill=False)
                balcony_stone(front, uu - 1.45, uu + 1.45, z0 + 0.15)
                continue
            opening(front, uu, z0 + 0.95 if not nob else z0 + 0.55, ww, wh, kind, rnd, shut)
            if nob and rnd.random() < 0.3:
                balcony_iron(front, uu - ww / 2 - 0.25, uu + ww / 2 + 0.25, z0 + 0.55)
            elif flowers and rnd.random() < 0.8:
                flower_box(front, uu, z0 + (0.95 if not nob else 0.55) - 0.1, ww + 0.15, rnd)
        # the back: plainer windows, every other bay
        for uu in us[::2]:
            plain_window(back, uu, z0 + 0.95, 0.8, 1.4, rnd, shut if rnd.random() < 0.5 else None)
        # the ends: one window each (seen at corners and lanes; hidden where the neighbour stands)
        for u_side, out in ((u0, -1), (u1, 1)):
            sf = geom.Frame(f.p(u_side, 0, 0), -f.n[:2] if out < 0 else f.n[:2])
            side = Facade(W, sf, 0.0, -1)
            nm = d / 2 + rnd.uniform(-1.0, 1.0)
            side.mid = (0, 0)
            plain_window(side, -nm if out < 0 else nm, z0 + 0.95, 0.75, 1.3, rnd)
    # the roof
    zr = hip_roof(W, f, u0, u1, 0.0, d, top, rnd.uniform(18, 24), L['roof'])
    # chimneys, one to three, near the walls
    for _ in range(rnd.choice([1, 2, 2, 3])):
        cu = rnd.uniform(u0 + 0.6, u1 - 0.6)
        cn = rnd.choice([rnd.uniform(0.6, 1.4), rnd.uniform(d - 1.4, d - 0.6)])
        p = f.p(cu, cn, 0)
        chimney(W, p[0], p[1], top - 0.3, zr + rnd.uniform(0.4, 1.0), col if wall != 'wall_brick'
                else (0.95, 0.9, 0.85), rnd)
    if L['altana'] and d > 6:
        a, b = rnd.uniform(u0 + 0.8, max(u0 + 0.9, u1 - 4.3)), rnd.uniform(1.2, 2.0)
        altana(W, f, a, min(u1 - 0.8, a + 3.4), b, min(d - 1.0, b + 3.0), zr + 0.35)
    # a hanging sign on some busy-street houses
    if hs.get('sign') is not None:
        hanging_sign(W, f, u1 - 0.6, 0.0, H0 + 0.4, hs['sign'])


def awning(W, f, u0, u1, n, z, cols):
    """A striped awning over a shop window, sloping down to the street."""
    depth = 1.3
    drop = 0.55
    k = int((u1 - u0) / 0.45)
    for i in range(k):
        a = u0 + (u1 - u0) * i / k
        b = u0 + (u1 - u0) * (i + 1) / k
        col = cols[i % 2]
        q = [f.p(a, n - depth, z - drop), f.p(b, n - depth, z - drop), f.p(b, n, z), f.p(a, n, z)]
        W.face(q, 'cloth', col, 'houses')
        W.face(q[::-1], 'cloth', tuple(c * 0.8 for c in col), 'houses')
        # valance
        W.face([f.p(a, n - depth, z - drop - 0.25), f.p(b, n - depth, z - drop - 0.25), f.p(b, n - depth, z - drop),
                f.p(a, n - depth, z - drop)], 'cloth', col, 'houses')
    W.face([f.p(u0, n - depth, z - drop + 0.1), f.p(u1, n - depth, z - drop + 0.1), f.p(u1, n - depth - 0.01, z - drop + 0.1 + SNOW * 0.6),
            f.p(u0, n - depth - 0.01, z - drop + 0.1 + SNOW * 0.6)], 'snow_soft', name='snow_soft_roofs')


def hanging_sign(W, f, u, n, z, col):
    """An iron bracket with a painted board hanging from it, out over the street."""
    geom.box(W, f, u - 0.03, u + 0.03, n - 1.1, n, z + 0.9, z + 0.95, 'metal', (1, 1, 1), 'houses')
    geom.box(W, f, u - 0.02, u + 0.02, n - 0.5, n, z + 0.5, z + 0.9, 'metal', (1, 1, 1), 'houses')
    geom.box(W, f, u - 0.03, u + 0.03, n - 1.0, n - 0.3, z, z + 0.62, 'paint', col, 'houses')
    geom.box(W, f, u - 0.035, u + 0.035, n - 0.95, n - 0.35, z + 0.08, z + 0.54, 'paint',
             tuple(min(1, c * 1.4 + 0.2) for c in col), 'houses')


def build(W):
    houses = lots.houses()
    rnd = random.Random(5)
    for hs in houses:
        busy = not hs.get('back')
        if busy and rnd.random() < 0.22:
            hs['shopfront'] = True
        if busy and rnd.random() < 0.18:
            hs['sign'] = rnd.choice([(0.6, 0.2, 0.15), (0.2, 0.35, 0.55), (0.75, 0.6, 0.2), (0.25, 0.45, 0.3)])
        house(W, hs)
    return len(houses)
