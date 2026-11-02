"""The park: the fountain where the ginkgo avenue ends, the pond, lamps and benches along the paths, signposts at
the trailheads, and the summit: a lookout with railings, benches and a stone marker."""
import math

import numpy as np

from . import geom, plan, walk
from .ground import SNOW
from .town import bench, fountain, street_lamp


def gh(x, y):
    return float(plan.ground_height(x, y))


def pond(W):
    poly = np.array(plan.POND, float)
    edge = [gh(x, y) for x, y in poly]
    zw = min(edge) - 0.3
    c = poly.mean(0)
    # water, as a fan from the middle (the outline is star-shaped from it), facing up
    ccw = np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1]) > 0
    pts = [(x, y, zw) for x, y in (poly if ccw else poly[::-1])]
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        W.face([(c[0], c[1], zw), a, b], 'water_pond', name='water_pond')
    # stones round the edge
    rs = geom.resample(np.vstack([poly, poly[:1]]), 0.9)
    for i, (x, y) in enumerate(rs[:-1]):
        o = np.array([x, y]) - c
        o /= np.linalg.norm(o)
        r = 0.35 + 0.15 * math.sin(i * 2.3)
        z = gh(x + o[0] * 0.4, y + o[1] * 0.4)
        f = geom.Frame((x + o[0] * 0.2, y + o[1] * 0.2, 0), (o[1], -o[0]))
        geom.box(W, f, -r, r, -r * 0.8, r * 0.8, zw - 0.4, z + 0.12 + 0.08 * math.sin(i * 1.7), 'rock',
                 (0.9, 0.88, 0.84), 'pond_edge')
    # a little jetty-like viewing platform at the pond's west (on the bank, not over the water)
    return zw


def summit(W):
    mx, my = plan.MOUNT
    z = plan.MOUNT_H
    R = plan.SUMMIT_R + 1.0
    # a deck of planks over the top, flush with the ground
    seg = 36
    for i in range(seg):
        a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
        p0 = (mx + math.cos(a0) * (R - 0.5), my + math.sin(a0) * (R - 0.5))
        p1 = (mx + math.cos(a1) * (R - 0.5), my + math.sin(a1) * (R - 0.5))
        W.face([(mx, my, z + 0.04), (p0[0], p0[1], z + 0.04), (p1[0], p1[1], z + 0.04)], 'wood_deck', (0.9, 0.85, 0.8),
               'summit')
        W.face([(p0[0], p0[1], z - 0.2), (p1[0], p1[1], z - 0.2), (p1[0], p1[1], z + 0.04), (p0[0], p0[1], z + 0.04)],
               'wood_deck', (0.7, 0.62, 0.55), 'summit')
        W.face([(mx, my, z + 0.04 + 0.04), (p0[0], p0[1], z + 0.08), (p1[0], p1[1], z + 0.08)], 'snow_trod',
               name='snow_trod_summit')
    # railing round the edge, open where the trails arrive
    for (x, y, x1, y1) in plan.summit_railing():
        for (px, py) in ((x, y), (x1, y1)):
            geom.cylinder(W, px, py, z - 0.1, z + 1.1, 0.06, 'timber', (0.75, 0.62, 0.5), 'summit', seg=6)
        f = geom.Frame((x, y, 0), (x1 - x, y1 - y))
        L = math.hypot(x1 - x, y1 - y)
        for zz in (z + 0.55, z + 1.05):
            geom.box(W, f, 0, L, -0.04, 0.04, zz, zz + 0.08, 'timber', (0.8, 0.68, 0.55), 'summit')
        geom.box(W, f, 0, L, -0.04, 0.04, z + 1.13, z + 1.13 + SNOW * 0.4, 'snow_soft', (1, 1, 1), 'snow_soft_things')
    # a stone marker and a panorama board
    f = geom.Frame((mx + 2.5, my + 2.0, z), (1, 0.3))
    geom.box(W, f, -0.25, 0.25, -0.25, 0.25, 0, 1.3, 'stone', (0.9, 0.9, 0.88), 'summit')
    geom.box(W, f, -0.27, 0.27, -0.27, 0.27, 1.3, 1.3 + SNOW * 0.5, 'snow_soft', (1, 1, 1), 'snow_soft_things')
    for (x, y, a) in walk.benches():
        if math.hypot(x - mx, y - my) < R:
            bench(W, x, y, a, z + 0.04)


def signpost(W, x, y, a, z):
    geom.cylinder(W, x, y, z, z + 2.2, 0.06, 'timber', (0.7, 0.58, 0.45), 'park_things', seg=6)
    f = geom.Frame((x, y, z), (math.cos(a), math.sin(a)))
    for k, d in enumerate((0, 1.2)):
        g = f.sub(0, 0, 0, d * 40)
        geom.box(W, g, 0.05, 0.95, -0.03, 0.03, 1.6 - k * 0.32, 1.84 - k * 0.32, 'wood', (0.85, 0.72, 0.55),
                 'park_things')


def build(W):
    px, py, pr = plan.PARK_FOUNTAIN
    fountain(W, px, py, pr, gh(px, py) + 0.05, tiers=1)
    pond(W)
    summit(W)
    for name, w, pts in plan.PARK_PATHS:
        if name in ('avenue', 'loop_w', 'loop_e', 'onsen_way', 'pond_walk', 'foot'):
            p = geom.resample(geom.smooth_corners(pts, 6.0), 26.0 if name != 'avenue' else 13.0)
            for i in range(1, len(p) - 1):
                t = p[i + 1] - p[i - 1]
                t /= np.linalg.norm(t)
                n = np.array([-t[1], t[0]])
                q = p[i] + n * (1 if i % 2 else -1) * (w / 2 + 0.4)
                street_lamp(W, q[0], q[1], gh(q[0], q[1]))
    for (x, y, a) in walk.benches():
        if x > 0 and math.hypot(x - plan.MOUNT[0], y - plan.MOUNT[1]) > plan.SUMMIT_R + 2:
            bench(W, x, y, a, gh(x, y) + 0.04)
    for name, (x, y) in plan.TRAILHEADS.items():
        signpost(W, x - 2.2, y + 1.5, 0.3, gh(x - 2.2, y + 1.5))
