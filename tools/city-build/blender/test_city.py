"""Test city for rojibura — simple geometric blocks for Phase 0/1.

    blender -b --python tools/city-build/blender/test_city.py                # build and export
    blender -b --python tools/city-build/blender/test_city.py -- --preview   # also render a top/oblique preview

Layout (Blender Z up, metres; glTF export turns it into Y up):
  * 80 x 80 m ground centred on the origin
  * a fountain in the middle (basin = obstacle)
  * buildings as boxes (cafe, station, library, two blocks)
  * a raised deck (1.2 m) reached by stairs (8 x 0.15 m) and a ramp (1:8)
  * a small park with trees and benches
  * landmarks as empties named LM_<id> with custom props lm_id / lm_name (exported as glTF extras)
  * a spawn point empty named SPAWN

There are no overlapping walkable surfaces (design constraint in docs/prd.md 1.8).

Output: assets/test-city/test_city.glb (and assets/test-city/preview_*.png with --preview).
"""
import bpy, os, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT_DIR = os.path.join(ROOT, 'assets', 'test-city')
OUT_GLB = os.path.join(OUT_DIR, 'test_city.glb')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mats = {}
def mat(name, rgb):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.85
    m.diffuse_color = (*rgb, 1.0)  # viewport / Workbench colour (used by the preview)
    _mats[name] = m
    return m


def box(name, cx, cy, sx, sy, sz, z0=0.0, material=None):
    """Axis-aligned box: centre (cx, cy) on the ground plane, size (sx, sy, sz), bottom at z0."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, z0 + sz / 2))
    o = bpy.context.active_object
    o.name = name
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material:
        o.data.materials.append(material)
    return o


def cylinder(name, cx, cy, r, h, z0=0.0, material=None, verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=(cx, cy, z0 + h / 2))
    o = bpy.context.active_object
    o.name = name
    if material:
        o.data.materials.append(material)
    return o


def landmark(lm_id, name, x, y, z=0.0):
    e = bpy.data.objects.new('LM_' + lm_id, None)
    e.empty_display_type = 'CONE'
    e.empty_display_size = 0.8
    e.location = (x, y, z)
    e['lm_id'] = lm_id
    e['lm_name'] = name
    bpy.context.scene.collection.objects.link(e)
    return e


def build():
    ground = mat('ground', (0.42, 0.45, 0.40))
    stone = mat('stone', (0.70, 0.68, 0.63))
    water = mat('water', (0.25, 0.45, 0.65))
    brick = mat('brick', (0.62, 0.36, 0.28))
    concrete = mat('concrete', (0.55, 0.56, 0.58))
    wood = mat('wood', (0.48, 0.33, 0.20))
    leaf = mat('leaf', (0.22, 0.48, 0.24))
    deck = mat('deck', (0.66, 0.58, 0.45))

    # ground
    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = 'ground'
    g.data.materials.append(ground)

    # fountain (basin is an obstacle; you walk around it)
    cylinder('fountain_basin', 0, 0, 3.0, 0.5, material=stone, verts=32)
    cylinder('fountain_water', 0, 0, 2.7, 0.05, z0=0.45, material=water, verts=32)
    cylinder('fountain_pillar', 0, 0, 0.4, 2.2, material=stone)

    # buildings
    box('cafe', 18, 14, 8, 6, 4, material=brick)
    box('station', -20, 27, 14, 6, 6, material=concrete)
    box('library', -24, -14, 10, 10, 8, material=stone)
    box('block_a', 26, 32, 10, 8, 10, material=concrete)
    box('block_b', -30, 8, 6, 12, 5, material=brick)

    # raised deck: 12 x 10 x 1.2 m at (22, -20)
    dx, dy, dw, dd, dh = 22.0, -20.0, 12.0, 10.0, 1.2
    box('deck', dx, dy, dw, dd, dh, material=deck)
    # stairs on the west side: 8 steps, 0.15 m rise, 0.35 m run, 3 m wide
    steps, rise, run, width = 8, 0.15, 0.35, 3.0
    west = dx - dw / 2
    for i in range(steps):
        h = rise * (i + 1)
        # step i is a block from the ground up to h, placed further from the deck for lower steps
        cx = west - run * (steps - i) + run / 2
        box('deck_stair_%d' % i, cx, dy - 2.0, run, width, h, material=deck)
    # ramp on the north side, slope 1:8 (9.6 m long), 3 m wide
    ramp_len = dh * 8
    bpy.ops.mesh.primitive_cube_add(size=1)
    r = bpy.context.active_object
    r.name = 'deck_ramp'
    me = r.data
    north = dy + dd / 2
    x0, x1 = dx + 1.0, dx + 4.0
    # rebuild as a wedge: high edge at the deck, low edge on the ground
    import bmesh
    bm = bmesh.new()
    v = [bm.verts.new(p) for p in [
        (x0, north, 0), (x1, north, 0), (x1, north + ramp_len, 0), (x0, north + ramp_len, 0),
        (x0, north, dh), (x1, north, dh)]]
    bm.faces.new([v[0], v[3], v[2], v[1]])          # bottom
    bm.faces.new([v[4], v[5], v[2], v[3]])          # slope
    bm.faces.new([v[0], v[1], v[5], v[4]])          # back (against the deck)
    bm.faces.new([v[0], v[4], v[3]])                # west side
    bm.faces.new([v[1], v[2], v[5]])                # east side
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    r.location = (0, 0, 0)
    r.data.materials.append(deck)

    # park: trees and benches around (-4, -26)
    for i, (tx, ty) in enumerate([(-10, -24), (-4, -30), (2, -24), (-8, -33), (4, -32)]):
        cylinder('tree_trunk_%d' % i, tx, ty, 0.25, 3.0, material=wood, verts=12)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.8, location=(tx, ty, 4.2))
        c = bpy.context.active_object
        c.name = 'tree_crown_%d' % i
        c.data.materials.append(leaf)
    for i, (bx, by, rot) in enumerate([(-4, -21, 0), (6, -28, 90), (-13, -29, 90)]):
        b = box('bench_%d' % i, bx, by, 2.0, 0.5, 0.45, material=wood)
        b.rotation_euler = (0, 0, math.radians(rot))

    # landmarks (on walkable ground, in front of things)
    landmark('fountain', '中央噴水', 0, 5)
    landmark('cafe', 'オープンカフェ', 18, 9)
    landmark('station', '駅前', -20, 22)
    landmark('library', '図書館の入口', -18, -14)
    landmark('deck', '展望デッキ', 22, -20, 1.2)
    landmark('park', '小さな公園', -3, -27)

    spawn = bpy.data.objects.new('SPAWN', None)
    spawn.empty_display_type = 'ARROWS'
    spawn.location = (0, 8, 0)
    bpy.context.scene.collection.objects.link(spawn)


def export():
    os.makedirs(OUT_DIR, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format='GLB', export_yup=True, export_apply=True,
        export_materials='EXPORT', export_extras=True, export_animations=False,
        export_lights=False, export_cameras=False)
    print('exported %s (%.0f KB)' % (OUT_GLB, os.path.getsize(OUT_GLB) / 1024))


def preview():
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 1000
    cam_data = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    for name, loc, rot, ortho in [
            ('top', (0, 0, 120), (0, 0, 0), 84),
            ('oblique', (55, -60, 45), (math.radians(60), 0, math.radians(42)), None)]:
        cam.location = loc
        cam.rotation_euler = rot
        if ortho:
            cam_data.type = 'ORTHO'
            cam_data.ortho_scale = ortho
        else:
            cam_data.type = 'PERSP'
            cam_data.lens = 28
        scene.render.filepath = os.path.join(OUT_DIR, 'preview_%s.png' % name)
        bpy.ops.render.render(write_still=True)
        print('rendered', scene.render.filepath)
    bpy.data.objects.remove(cam)


reset()
build()
export()
if '--preview' in ARGS:
    preview()
