"""はじまりの街 (the main area): builds the 3D, the walk raster and the area's data files.

    python3 tools/city-build/blender/fetch_tex.py                                  # once: the CC0 textures
    blender -b --python tools/city-build/blender/hajimari_city.py [-- --preview] [-- --only ground,houses]
    node tools/city-build/src/build-grid.ts tools/city-build/blender/out/hajimari assets/areas/hajimari
    node tools/city-build/src/compress-glb.ts tools/city-build/blender/out/hajimari/hajimari_raw.glb \
        assets/areas/hajimari/hajimari_town_w.glb --drop snow_ --cols 0
    node tools/city-build/src/compress-glb.ts tools/city-build/blender/out/hajimari/hajimari_raw.glb \
        assets/areas/hajimari/hajimari_town_e.glb --drop snow_ --cols 1
    node tools/city-build/src/compress-glb.ts tools/city-build/blender/out/hajimari/hajimari_raw.glb \
        assets/areas/hajimari/hajimari_park.glb --drop snow_ --cols 2,3
    node tools/city-build/src/compress-glb.ts tools/city-build/blender/out/hajimari/hajimari_raw.glb \
        assets/areas/hajimari/hajimari_snow.glb --only snow_

(pnpm build:hajimari does all of it.) Writes assets/areas/hajimari: hajimari_town_w.glb and hajimari_town_e.glb (the
walled town's west and east halves; the half where one arrives is loaded first, areas.json "bounds"),
hajimari_park.glb (the park, mountain, college and onsen: loaded once in), hajimari_snow.glb
(the winter snow, loaded only in winter), trees.json, zones.json, shops.json, and the navmesh and landmarks. The Sagrada Família's exterior is its own file, sagrada_exterior.glb, made from
~/work/demos/sagrada-familia (its tools/rj_export.mjs). The layout is in hajimari/plan.py.
"""
import math, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from hajimari import bl, geom, ground, houses, meta, plan, walk  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.join(HERE, 'out', 'hajimari')
GLB = os.path.join(OUT, 'hajimari_raw.glb')   # compress-glb.ts makes the area's files from it


def arg(name):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else None


def main():
    only = set((arg('--only') or 'ground,houses,town,park,onsen,shops,college').split(','))
    t = time.time()
    if '--no-data' not in ARGS:
        R = walk.build()
        walk.write(R, OUT)
        walk.preview(R, os.path.join(OUT, 'walk_preview.png'), 0.5)
        meta.write(OUT)
        print('walk raster and data: %.1f s' % (time.time() - t))
    bl.reset()
    from hajimari import signs
    signs.make()
    W = geom.World()
    if 'ground' in only:
        ground.park(W)
        ground.town(W)
        ground.paths(W)
        ground.far(W)
    if 'houses' in only:
        print('houses:', houses.build(W))
    if 'town' in only:
        from hajimari import town
        town.build(W)
    if 'park' in only:
        from hajimari import park
        park.build(W)
    if 'onsen' in only:
        from hajimari import onsen
        onsen.build(W)
    if 'shops' in only:
        from hajimari import shops
        shops.build(W)
    if 'college' in only:
        from hajimari import college
        college.build(W)
    faces = bl.to_objects(W)
    print('faces: %d, objects: %d, %.1f s' % (faces, len(W.b), time.time() - t))
    bl.export(GLB)
    if '--preview' in ARGS:
        import bpy
        winter = '--winter' in ARGS
        for ob in bpy.data.objects:
            if ob.name.startswith('snow_'):
                ob.hide_render = not winter
        ext = os.path.join(plan.AREA_DIR, 'sagrada_exterior.glb')
        if os.path.exists(ext):
            bpy.ops.import_scene.gltf(filepath=ext)
        shots = {
            'oblique': ((40, -250, 170), (58, 0, -8), 22),
            'rings': ((-120, -215, 190), (48, 0, 0), 24),
            'ringroad': ((-84.2, 62.1, 1.7), (88, 0, 60), 20),
            'town': ((-20, -70, 35), (70, 0, -40), 24),
            'street': ((-8, -1, 1.7), (88, 0, 92), 22),
            'plaza': ((-38, -12, 1.7), (86, 0, 105), 20),
            'onsen': ((19, -140.8, 2.4), (80, 0, 245), 18),
            'inn': ((28, -100, 4), (82, 0, 180), 22),
            'summit': (tuple(map(float, (plan.MOUNT[0] + 6, plan.MOUNT[1] + 6, plan.MOUNT_H + 1.8))), (84, 0, 125), 20),
            'shop': ((-27, -6.5, 1.6), (88, 0, 200), 18),
            'college': ((34, 60, 6), (82, 0, 0), 22),
            'court': ((22, 99, 1.7), (86, 0, -35), 20),
            'library': ((52.5, 103, 1.6), (88, 0, 0), 18),
        }
        # along a few streets, from the far side, looking at the houses (Venetian look, issue 42)
        from hajimari import lots
        H = lots.houses()
        for i in (5, 60, 140, 230, 320):
            if i >= len(H):
                continue
            h = H[i]
            tx, ty = h['t']
            nx, ny = -ty, tx
            o = h['o']
            p = (o[0] - nx * 5.0 - tx * 9.0, o[1] - ny * 5.0 - ty * 9.0, 1.7)
            look = (tx * 0.8 + nx * 0.6, ty * 0.8 + ny * 0.6)
            shots['house%d' % i] = (p, (84, 0, math.degrees(math.atan2(-look[0], look[1]))), 18)
        for name in (arg('--shots') or ','.join(shots)).split(','):
            loc, rot, lens = shots[name]
            bl.preview(os.path.join(OUT, 'preview_%s%s.png' % (name, '_winter' if winter else '')), loc, rot,
                       lens=lens)
    print('done in %.1f s' % (time.time() - t))


main()
