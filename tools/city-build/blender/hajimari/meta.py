"""The area's data files besides the 3D, from the plan (rojibura's frame: pos = [X, Z] = [x, -y]).

  out/hajimari/meta.json            landmarks and spawn without heights (build-grid.ts adds them)
  assets/areas/hajimari/trees.json  every tree for the browser (species, position, scale, rotation)
  assets/areas/hajimari/zones.json  places with a rule: the onsen, where avatars wear a towel
  assets/areas/hajimari/shops.json  the shops, their counters and what they sell
"""
import json, os

import numpy as np

from . import plan, walk

G = plan.to_gltf


def write(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(plan.AREA_DIR, exist_ok=True)
    sx, sy = plan.spawn()
    meta = {
        'landmarks': [{'id': i, 'name': n, 'pos': G(x, y), 'y': 0, **({'major': True} if i in plan.MAJOR else {})}
                      for (i, n, x, y) in plan.landmarks()],
        'spawn': {'pos': G(sx, sy), 'y': 0},
    }
    json.dump(meta, open(os.path.join(out_dir, 'meta.json'), 'w'), ensure_ascii=False, indent='\t')

    trees = [[sp, *G(x, y), round(s, 2), round(r, 2)] for (sp, x, y, s, r) in plan.trees()]
    with open(os.path.join(plan.AREA_DIR, 'trees.json'), 'w') as f:
        f.write('{\n\t"format": ["species", "X", "Z", "scale", "rotation"],\n\t"trees": [\n')
        f.write(',\n'.join('\t\t' + json.dumps(t, ensure_ascii=False) for t in trees))
        f.write('\n\t]\n}\n')

    zones = {'zones': [
        {'id': 'onsen', 'kind': 'bath', 'name': '温泉宿「ゆのはな」の脱衣所と露天風呂',
         'poly': [G(x, y) for (x, y) in plan.onsen_zone()]},
        {'id': 'onsen_water', 'kind': 'water', 'name': '露天風呂のお湯', 'y': plan.ONSEN['water'],
         'poly': [G(x, y) for (x, y) in plan.ONSEN['pool']]},
    ]}
    # indoors: the camera looks from your eyes there (it would be above the ceiling)
    rects = [('shop_' + s['id'], s['name'], s['lot']) for s in plan.SHOPS]
    rects += [('inn_lobby', '温泉宿のロビー', plan.ONSEN['lobby']), ('inn_changing', '温泉宿の脱衣所', plan.ONSEN['changing'])]
    cx = (plan.ONSEN['changing'][0] + plan.ONSEN['changing'][2]) / 2
    rects += [('inn_passage', '脱衣所への廊下', (cx - 1.2, plan.ONSEN['changing'][3] - 0.5, cx + 1.2, plan.ONSEN['lobby'][1] + 0.5))]
    co = plan.COLLEGE
    rects += [('college_library', 'カレッジの図書館', co['reading']), ('college_common', '寮の談話室', co['common'])]
    rect = lambda a, b, c, d: [G(a, b), G(c, b), G(c, d), G(a, d)]
    for (i, n, (a, b, c, d)) in rects:
        zones['zones'].append({'id': i, 'kind': 'indoor', 'name': n, 'poly': rect(a, b, c, d)})
    # where one earns coins (docs/prd.md 3.8.6): working in the shops, at the inn's desk and the market stalls;
    # studying in the college library, the common room and the bookshop
    work = [('work_' + s['id'], s['name'], s['lot']) for s in plan.SHOPS]
    work += [('work_inn', '温泉宿「ゆのはな」の帳場', plan.ONSEN['lobby'])]
    work += [('work_market_%d' % k, '広場の市場の屋台', r) for k, r in enumerate(plan.STALL_WORK)]
    for (i, n, r) in work:
        zones['zones'].append({'id': i, 'kind': 'work', 'name': n, 'poly': rect(*r)})
    books = next(s for s in plan.SHOPS if s['id'] == 'books')
    study = [('study_library', 'カレッジの図書館', co['reading']), ('study_common', '寮の談話室', co['common']),
             ('study_books', books['name'], books['lot'])]
    for (i, n, r) in study:
        zones['zones'].append({'id': i, 'kind': 'study', 'name': n, 'poly': rect(*r)})
    json.dump(zones, open(os.path.join(plan.AREA_DIR, 'zones.json'), 'w'), ensure_ascii=False, indent='\t')

    write_ground()
    shops = {'shops': [shop_entry(s) for s in plan.SHOPS]}
    json.dump(shops, open(os.path.join(plan.AREA_DIR, 'shops.json'), 'w'), ensure_ascii=False, indent='\t')


GOODS = {
    'seven': [
        ('onigiri', 'おにぎり（鮭）', 3, '#f4f1e8'), ('sandwich', 'たまごサンド', 4, '#f3d77a'),
        ('coffee', 'ホットコーヒー', 2, '#6b4a33'), ('tea', 'お茶のペットボトル', 2, '#7fb069'),
        ('nikuman', '肉まん', 3, '#f6efe2'), ('icecream', 'アイスクリーム', 3, '#f7c8d8'),
        ('bread', 'メロンパン', 2, '#e9c46a'), ('umbrella', 'ビニール傘', 6, '#d9e6ee'),
    ],
    'books': [
        ('novel', '小説『はじまりの街』', 8, '#2a6f97'), ('poems', '詩集『春の路地』', 6, '#c44536'),
        ('map', '街の地図', 3, '#e9d8a6'), ('picturebook', '絵本『くまの温泉』', 7, '#f4a261'),
        ('notebook', 'ノートと鉛筆', 3, '#8ab17d'), ('cookbook', '料理の本', 9, '#e76f51'),
    ],
    'bakery': [
        ('baguette', 'バゲット', 3, '#d4a056'), ('croissant', 'クロワッサン', 2, '#e0a84f'),
        ('pretzel', 'プレッツェル', 2, '#9c5b2e'), ('anpan', 'あんぱん', 2, '#b5733a'),
    ],
}


GROUND_STEP = 2.0


def write_ground():
    """ground.bin + ground.json: the terrain's height every 2 m (rojibura's frame, rows along Z), for the browser
    to stand trees and fallen leaves on without casting rays. Unsigned 16-bit millimetres above -2 m."""
    xs = np.arange(plan.X0, plan.X1 + 0.01, GROUND_STEP)
    zs = np.arange(-plan.Y1, -plan.Y0 + 0.01, GROUND_STEP)
    X, Z = np.meshgrid(xs, zs)
    from .ground import pond_depth
    H = plan.ground_height(X.ravel(), -Z.ravel()).reshape(X.shape) - pond_depth(X, -Z)
    q = np.clip(np.round((H + 2.0) * 1000), 0, 65535).astype('<u2')
    q.tofile(os.path.join(plan.AREA_DIR, 'ground.bin'))
    json.dump({'x0': float(xs[0]), 'z0': float(zs[0]), 'step': GROUND_STEP, 'nx': len(xs), 'nz': len(zs),
               'scale': 0.001, 'offset': -2.0, 'format': 'uint16 little-endian, row-major (z, x)'},
              open(os.path.join(plan.AREA_DIR, 'ground.json'), 'w'))


FOOD = {'onigiri', 'sandwich', 'coffee', 'tea', 'nikuman', 'icecream', 'bread', 'baguette', 'croissant',
        'pretzel', 'anpan'}


def shop_entry(s):
    a, b, c, d = s['lot']
    sx = s['door']
    # the counter's customer side
    fur = walk.shop_furniture(s)[0]
    cx = (fur[0][0] + fur[1][0]) / 2
    cy = (fur[0][1] + fur[2][1]) / 2
    side = 1 if cx < (a + c) / 2 else -1
    return {
        'id': s['id'], 'name': s['name'], 'currency': '銅貨',
        'counter': G(cx + side * 1.4, cy),
        'door': G(sx, d if s['front'] == 'N' else b),
        'inside': [G(a, b), G(c, b), G(c, d), G(a, d)],
        'goods': [{'id': g, 'name': n, 'price': p, 'color': col, **({'food': True} if g in FOOD else {})}
                  for (g, n, p, col) in GOODS[s['id']]],
    }
