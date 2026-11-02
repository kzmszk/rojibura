"""Town houses: half-timbered, plastered or stone, two to four storeys, the upper storeys of timber houses jutting
out over the street, steep gabled roofs of clay tiles or slate, windows with shutters and flower boxes, some
shop fronts with awnings, chimneys, and a cap of snow for winter."""
import math, random

import numpy as np

from . import geom, lots
from .ground import SNOW

H0 = 3.4      # ground storey
HF = 3.0      # upper storeys
JETTY = 0.32  # how far each upper storey of a timber house juts out

TIMBER = [(0.62, 0.5, 0.4), (0.42, 0.33, 0.27), (0.7, 0.42, 0.3), (0.5, 0.45, 0.42)]
SHUTTER = [(0.28, 0.48, 0.33), (0.27, 0.42, 0.62), (0.66, 0.24, 0.2), (0.55, 0.42, 0.28), (0.3, 0.5, 0.5),
           (0.85, 0.82, 0.74)]
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


def door(W, f, u, n, facing, col, stone=True):
    out = facing
    dw, dh = 1.15, 2.3
    g = n + out * 0.03
    if out < 0:
        W.face([f.p(u - dw / 2, g, 0.0), f.p(u + dw / 2, g, 0.0), f.p(u + dw / 2, g, dh), f.p(u - dw / 2, g, dh)],
               'timber', col, 'houses')
    else:
        W.face([f.p(u + dw / 2, g, 0.0), f.p(u - dw / 2, g, 0.0), f.p(u - dw / 2, g, dh), f.p(u + dw / 2, g, dh)],
               'timber', col, 'houses')
    n0, n1 = sorted((n, n + out * 0.12))
    m = 'stone' if stone else 'timber'
    c = (1, 1, 1) if stone else (0.7, 0.6, 0.5)
    geom.box(W, f, u - dw / 2 - 0.22, u - dw / 2, n0, n1, 0, dh + 0.22, m, c, 'houses')
    geom.box(W, f, u + dw / 2, u + dw / 2 + 0.22, n0, n1, 0, dh + 0.22, m, c, 'houses')
    geom.box(W, f, u - dw / 2 - 0.22, u + dw / 2 + 0.22, n0, n1, dh, dh + 0.3, m, c, 'houses')
    # a step
    s0, s1 = sorted((n, n + out * 0.45))
    geom.box(W, f, u - dw / 2 - 0.1, u + dw / 2 + 0.1, s0, s1, 0, 0.12, 'stone', (0.9, 0.9, 0.9), 'houses')
    # handle
    h0, h1 = sorted((g, g + out * 0.05))
    geom.box(W, f, u + dw / 2 - 0.2, u + dw / 2 - 0.14, h0, h1, 1.0, 1.08, 'metal', (1, 1, 1), 'houses')


def timber_frame(W, f, n, u0, u1, z0, z1, facing, col, posts):
    """Posts, rails and braces of a half-timbered storey on the wall at depth n."""
    out = facing
    a0, a1 = sorted((n, n + out * 0.05))
    tw = 0.2
    # rails: sill and head
    geom.box(W, f, u0, u1, a0, a1, z0, z0 + tw, 'timber', col, 'houses')
    geom.box(W, f, u0, u1, a0, a1, z1 - tw, z1, 'timber', col, 'houses')
    # mid rail below the windows
    zm = z0 + 0.85
    geom.box(W, f, u0, u1, a0, a1, zm - 0.08, zm + 0.08, 'timber', col, 'houses')
    for p in posts:
        geom.box(W, f, p - tw / 2, p + tw / 2, a0, a1, z0 + tw, z1 - tw, 'timber', col, 'houses')
    # braces in the panels below the mid rail and in the end panels: "Mann" figure diagonals
    b0 = a1
    for i in range(len(posts) - 1):
        pa, pb = posts[i] + tw / 2, posts[i + 1] - tw / 2
        if pb - pa < 0.5:
            continue
        for (ua, za, ub, zb) in [(pa, z0 + tw, pb, zm - 0.08), (pa, zm - 0.08, pb, z0 + tw)]:
            _brace(W, f, b0 - out * 0.05, ua, za, ub, zb, out, col)


def _brace(W, f, n, ua, za, ub, zb, out, col):
    w = 0.09
    du, dz = ub - ua, zb - za
    L = math.hypot(du, dz)
    pu, pz = -dz / L * w, du / L * w
    q = [(ua + pu, za + pz), (ub + pu, zb + pz), (ub - pu, zb - pz), (ua - pu, za - pz)]
    nn = n + out * 0.05
    pts = [f.p(u, nn, z) for (u, z) in q]
    # face outward
    v = np.cross(np.array(pts[1]) - pts[0], np.array(pts[2]) - pts[0])
    if np.dot(v, f.n * out) < 0:
        pts = pts[::-1]
    W.face(pts, 'timber', col, 'houses')


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
    """20 cm of snow on a roof slope, a little short of the eaves, with rounded-looking edges."""
    s = [np.array(p, float) for p in s]
    c = sum(s) / 4
    nrm = np.cross(s[1] - s[0], s[2] - s[0])
    nrm /= np.linalg.norm(nrm)
    shrink = [c + (p - c) * 0.97 for p in s]
    # thinner on steep roofs (snow slides)
    t = SNOW * max(0.35, math.cos(math.radians(pitch)) * 1.3)
    top = [p + nrm * t for p in shrink]
    W.face(top, 'snow_soft', name='snow_soft_roofs')
    for i in range(4):
        a, b = shrink[i], shrink[(i + 1) % 4]
        at, bt = top[i], top[(i + 1) % 4]
        W.face([a, b, bt, at][::-1] if np.dot(np.cross(b - a, at - a), (a + b) / 2 - c) < 0 else [a, b, bt, at],
               'snow_soft', name='snow_soft_roofs')


def house(W, hs):
    rnd = random.Random(hs['seed'])
    ox, oy = hs['o']
    f = geom.Frame((ox, oy, 0.0), hs['t'])
    w, d, F = hs['w'], hs['d'], hs['floors']
    style = hs['style']
    plaster = tuple(hs['colour'])
    tcol = rnd.choice(TIMBER)
    shut = rnd.choice(SHUTTER) if rnd.random() < 0.75 else None
    u0, u1 = -w / 2, w / 2
    jet = JETTY if style == 'timber' else 0.0
    # storeys
    zs = [0.0, H0] + [H0 + HF * k for k in range(1, F)]
    for k in range(F):
        z0, z1 = zs[k], zs[k + 1]
        j = jet * k
        n0, n1 = -j, d + j * 0.5
        if k == 0:
            mat = 'plaster' if style == 'plaster' else 'stone_blocks'
            col = plaster if style == 'plaster' else (0.95, 0.92, 0.88)
        else:
            mat = 'stone_blocks' if style == 'stone' else 'plaster'
            col = (0.98, 0.95, 0.9) if style == 'stone' else plaster
        if k == 0 and hs.get('shop_ground'):
            continue   # shops.py builds the ground storey, with its inside
        wall_face(W, f, n0, u0, u1, z0, z1, mat, col, -1)
        wall_face(W, f, n1, u0, u1, z0, z1, mat, col, 1)
        side_face(W, f, u0, n0, n1, z0, z1, mat, col, -1)
        side_face(W, f, u1, n0, n1, z0, z1, mat, col, 1)
        if j > 0:
            # the underside of the jetty and its joist ends
            W.face([f.p(u0, n0, z0), f.p(u0, n0 + jet, z0), f.p(u1, n0 + jet, z0), f.p(u1, n0, z0)], 'timber', tcol,
                   'houses')
            for uu in np.arange(u0 + 0.3, u1, 0.6):
                geom.box(W, f, uu - 0.07, uu + 0.07, n0 - 0.0, n0 + jet, z0 - 0.16, z0, 'timber', tcol, 'houses')
        # windows
        m = max(1, int((w - 1.0) // 2.1))
        us = [u0 + (i + 0.5) * w / m for i in range(m)]
        if k == 0:
            door_u = us[rnd.randrange(m)] if m > 1 else 0.0
            if m == 1:
                us = []
            dcol = rnd.choice([(0.55, 0.38, 0.25), (0.35, 0.45, 0.32), (0.6, 0.25, 0.2), (0.4, 0.3, 0.25)])
            door(W, f, door_u, n0, -1, dcol)
            shopfront = hs.get('shopfront')
            for uu in us:
                if abs(uu - door_u) < 1.4:
                    continue
                if shopfront:
                    window(W, f, uu, n0, 0.75, min(1.7, w / m - 0.5), 1.9, -1, rnd, None, False, (0.35, 0.25, 0.18))
                else:
                    window(W, f, uu, n0, 1.0, 0.95, 1.4, -1, rnd, shut, False)
            if shopfront:
                awning(W, f, u0 + 0.2, u1 - 0.2, n0, 2.75, rnd.choice(AWNING))
        else:
            fl = rnd.random() < 0.45
            for uu in us:
                window(W, f, uu, n0, z0 + 0.95, 0.85, 1.35, -1, rnd, shut, fl and rnd.random() < 0.8)
            # fewer at the back
            for uu in us[::2]:
                window(W, f, uu, n1, z0 + 0.95, 0.85, 1.35, 1, rnd, None, False)
            # one on each side (hidden where the neighbour's wall is, seen at corners and lanes)
            side = geom.Frame(f.p(0, 0, 0), -f.n[:2])
            nm = (n0 + n1) / 2 + rnd.uniform(-1.0, 1.0)
            for u_side, out in ((u0, -1), (u1, 1)):
                sf = geom.Frame(f.p(u_side, 0, 0), side.t[:2])
                window(W, sf, -nm, 0.0, z0 + 0.95, 0.8, 1.3, out, rnd, shut, False)
            if style == 'timber':
                posts = sorted(set([u0 + 0.1, u1 - 0.1] + [uu + s * 0.62 for uu in us for s in (-1, 1)]))
                timber_frame(W, f, n0, u0, u1, z0, z1, -1, tcol, posts)
                timber_frame(W, f, n1, u0, u1, z0, z1, 1, tcol, [u0 + 0.1, (u0 + u1) / 2, u1 - 0.1])
        # string course between storeys
        if k > 0 and style != 'timber':
            a0, a1 = sorted((n0, n0 - 0.08))
            geom.box(W, f, u0 - 0.04, u1 + 0.04, a0, a1, z0 - 0.12, z0 + 0.05, 'stone', (0.95, 0.93, 0.9), 'houses')
    # roof
    top = zs[-1]
    jtop = jet * (F - 1)
    n0, n1 = -jtop, d + jtop * 0.5
    along_n = hs['gable']
    if not along_n and (n1 - n0) > 12:
        along_n = True
    pitch = rnd.uniform(48, 56) if along_n else rnd.uniform(42, 50)
    mat = 'roof_clay' if hs['roof'] == 'clay' else 'roof_slate'
    zr = roof(W, f, u0, u1, n0, n1, top, pitch, along_n, mat)
    # gable walls (and a little window in the street-side gable)
    gmat = 'stone_blocks' if style == 'stone' else 'plaster'
    gcol = (0.98, 0.95, 0.9) if style == 'stone' else plaster
    if along_n:
        for n, out in ((n0, -1), (n1, 1)):
            pts = [f.p(u0, n, top), f.p(u1, n, top), f.p(0.0, n, zr)]
            W.face(pts if out < 0 else pts[::-1], gmat, gcol, 'houses')
            if style == 'timber':
                a0, a1 = sorted((n, n + out * 0.05))
                geom.box(W, f, -0.1, 0.1, a0, a1, top, zr - 0.3, 'timber', tcol, 'houses')
                _brace(W, f, n, u0 + 0.2, top + 0.1, -0.1, zr - 0.6, out, tcol)
                _brace(W, f, n, u1 - 0.2, top + 0.1, 0.1, zr - 0.6, out, tcol)
        if zr - top > 2.6:
            window(W, f, 0.0, n0, top + 0.7, 0.6, 0.9, -1, rnd, None, False)
    else:
        for u, out in ((u0, -1), (u1, 1)):
            nm = (n0 + n1) / 2
            pts = [f.p(u, n1, top), f.p(u, n0, top), f.p(u, nm, zr)]
            W.face(pts if out < 0 else pts[::-1], gmat, gcol, 'houses')
    # chimney
    if rnd.random() < 0.7:
        cu = rnd.uniform(u0 + 1.0, u1 - 1.0)
        cn = rnd.uniform(n0 + 1.5, n1 - 1.5)
        z1 = zr + 0.8
        geom.box(W, f, cu - 0.35, cu + 0.35, cn - 0.35, cn + 0.35, top, z1, 'stone_blocks', (0.85, 0.75, 0.68),
                 'houses')
        geom.box(W, f, cu - 0.45, cu + 0.45, cn - 0.45, cn + 0.45, z1, z1 + 0.12, 'stone', (0.8, 0.8, 0.8), 'houses')
        geom.box(W, f, cu - 0.45, cu + 0.45, cn - 0.45, cn + 0.45, z1 + 0.12, z1 + 0.12 + SNOW * 0.8, 'snow_soft',
                 (1, 1, 1), 'snow_soft_roofs')
    # a hanging sign on some busy-street houses
    if hs.get('sign') is not None:
        hanging_sign(W, f, u1 - 0.6, n0, H0 + 0.4, hs['sign'])


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
