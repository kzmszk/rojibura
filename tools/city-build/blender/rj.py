"""rojibura model kit for Blender (docs/prd.md 3.7): shortcuts for making things to build in the city.

A model script is plain Blender Python. Import this module, build with it (or with bpy directly), then call
export(). The model CLI runs it headless and then checks and registers the result:

    node tools/city-build/src/model-cli.ts make my_house.py -o my_house.glb --preview --upload --name ハルの家

Conventions (the CLI checks them):
  * 1 unit = 1 metre. Blender's Z is up; the glTF export turns it into Y up.
  * The origin is the centre of the model's base, on the ground (z = 0).
  * The front faces -Y in Blender (+Z in glTF). In the city, BUILD's `rot` turns the front.
  * Materials whose name starts with "paint" take the colour a builder chooses (paint() makes one).
  * Objects whose name starts with "collider" are not drawn: they say where the model blocks walking,
    when the automatic footprint (everything below 2 m) is not right, e.g. an L-shaped building.
  * People can walk on any surface reachable from the ground by steps of at most 0.2 m and slopes of at
    most 45 degrees, with 1.8 m of headroom (stairs(), ramp()). They cannot walk under a walkable surface.
  * At most 40 x 40 m on the ground, 60 m high, 200,000 triangles and 16 MB; textures embedded.

Everything takes positions as (x, y, z) in Blender coordinates, z being the bottom of the part.
"""
import bmesh, bpy, math, os, sys
from mathutils import Vector

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

FRONT = (0, -1)  # Blender XY direction of the model's front


def _arg(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        if i + 1 < len(ARGS) and not ARGS[i + 1].startswith('--'):
            return ARGS[i + 1]
        return True
    return default


def reset():
    """Starts from an empty scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials.clear()


# ---- materials ----

_materials = {}


def _rgb(color):
    if isinstance(color, str):
        s = color.lstrip('#')
        if len(s) == 3:
            s = ''.join(c * 2 for c in s)
        srgb = [int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        # glTF base colours are linear
        return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)
    return tuple(color[:3])


def material(name, color, roughness=0.8, metallic=0.0, emission=0.0):
    """A material by name (made once). `color` is "#rrggbb" or linear (r, g, b). `emission` makes it glow."""
    if name in _materials:
        return _materials[name]
    rgb = _rgb(color)
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission > 0:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission
    m.diffuse_color = (*rgb, 1.0)  # Workbench colour, used by the preview
    _materials[name] = m
    return m


def paint(color='#dbc8a6', name='paint'):
    """The model's main colour: in the city, the builder's chosen colour replaces `color`."""
    if not name.startswith('paint'):
        name = 'paint_' + name
    return material(name, color, roughness=0.75)


# ---- parts ----

def _finish(o, name, mat):
    o.name = name
    if mat is not None:
        o.data.materials.clear()
        o.data.materials.append(mat)
    return o


def _mesh(name, verts, faces, mat=None):
    """A closed mesh from vertices and faces; normals are made to point outwards (Recast needs floors up)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return _finish(o, name, mat)


def box(name, size, at=(0, 0, 0), material=None, rotate=0.0, bevel=0.0):
    """A box `size` = (x, y, z) metres; `at` is the centre of its bottom. `rotate` turns it about Z (degrees)."""
    sx, sy, sz = size
    bpy.ops.mesh.primitive_cube_add(size=1, location=(at[0], at[1], at[2] + sz / 2))
    o = bpy.context.active_object
    o.scale = (sx, sy, sz)
    o.rotation_euler = (0, 0, math.radians(rotate))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if bevel > 0:
        mod = o.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
    return _finish(o, name, material)


def cylinder(name, radius, height, at=(0, 0, 0), material=None, verts=24, radius_top=None):
    """An upright cylinder (or a cone frustum with `radius_top`); `at` is the centre of its bottom."""
    if radius_top is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=height,
                                            location=(at[0], at[1], at[2] + height / 2))
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius, radius2=radius_top, depth=height,
                                        location=(at[0], at[1], at[2] + height / 2))
    return _finish(bpy.context.active_object, name, material)


def cone(name, radius, height, at=(0, 0, 0), material=None, verts=24):
    """An upright cone; `at` is the centre of its base."""
    return cylinder(name, radius, height, at, material, verts, radius_top=0.0)


def sphere(name, radius, at=(0, 0, 0), material=None, detail=2, squash=1.0):
    """A ball centred at `at` (not its bottom). `squash` < 1 flattens it."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=detail, radius=radius, location=at)
    o = bpy.context.active_object
    o.scale = (1, 1, squash)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.shade_smooth()
    return _finish(o, name, material)


def gable_roof(name, width, depth, height, at=(0, 0, 0), overhang=0.3, material=None):
    """A pitched roof whose ridge runs along X; `at` is the centre of its eaves. width (X) x depth (Y)."""
    x = width / 2 + overhang
    y = depth / 2 + overhang
    z0 = at[2]
    t = 0.12  # thickness of the roof boards
    v = [(-x, -y, z0), (x, -y, z0), (x, y, z0), (-x, y, z0), (-x, 0, z0 + height), (x, 0, z0 + height),
         (-x, -y, z0 + t), (x, -y, z0 + t), (x, y, z0 + t), (-x, y, z0 + t), (-x, 0, z0 + height + t),
         (x, 0, z0 + height + t)]
    v = [(px + at[0], py + at[1], pz) for px, py, pz in v]
    faces = [
        (6, 7, 11, 10), (8, 9, 10, 11),  # top of the slopes
        (0, 4, 5, 1), (2, 5, 4, 3),  # underside
        (0, 1, 7, 6), (2, 3, 9, 8),  # eaves
        (0, 6, 10, 4), (3, 4, 10, 9), (1, 5, 11, 7), (2, 8, 11, 5),  # gable ends
    ]
    return _mesh(name, v, faces, material)


def gable_wall(name, width, height, at=(0, 0, 0), material=None, thickness=0.2):
    """The triangle that fills a gable under gable_roof(): `width` along Y, facing X, on top of a wall."""
    y = width / 2
    z0 = at[2]
    h = thickness / 2
    v = [(-h, -y, z0), (-h, y, z0), (-h, 0, z0 + height), (h, -y, z0), (h, y, z0), (h, 0, z0 + height)]
    v = [(px + at[0], py + at[1], pz) for px, py, pz in v]
    return _mesh(name, v, [(0, 2, 1), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)], material)


def pyramid_roof(name, width, depth, height, at=(0, 0, 0), overhang=0.3, material=None):
    """A four-sided roof; `at` is the centre of its eaves."""
    x = width / 2 + overhang
    y = depth / 2 + overhang
    v = [(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0), (0, 0, height)]
    v = [(px + at[0], py + at[1], pz + at[2]) for px, py, pz in v]
    return _mesh(name, v, [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (3, 2, 1, 0)], material)


def _direction(direction):
    return {'back': (0, 1), 'front': (0, -1), 'right': (1, 0), 'left': (-1, 0)}[direction]


def stairs(name, width, rise, at=(0, 0, 0), direction='back', step_rise=0.15, step_depth=0.3, material=None):
    """
    Steps people can climb (each at most 0.2 m). `at` is the centre of the bottom step's front edge; they go
    up `rise` metres towards `direction` ('back' = +Y, 'front', 'left', 'right'). Returns the objects.
    """
    dx, dy = _direction(direction)
    n = max(1, math.ceil(rise / step_rise - 1e-6))
    h = rise / n
    parts = []
    for i in range(n):
        d = step_depth * (i + 0.5)
        cx = at[0] + dx * d
        cy = at[1] + dy * d
        # each step is a block from the ground up, so the stairs have no gaps underneath
        sx, sy = (width, step_depth) if dx == 0 else (step_depth, width)
        parts.append(box('%s_%d' % (name, i + 1), (sx, sy, h * (i + 1)), (cx, cy, at[2]), material))
    return parts


def ramp(name, width, length, rise, at=(0, 0, 0), direction='back', material=None):
    """A slope (keep it under 45 degrees; 1:8 is comfortable). `at` is the centre of its low edge."""
    dx, dy = _direction(direction)
    px, py = -dy, dx  # sideways
    w = width / 2
    z = at[2]
    base = Vector((at[0], at[1], 0))
    fwd = Vector((dx, dy, 0)) * length
    side = Vector((px, py, 0)) * w
    lo_l, lo_r = base - side, base + side
    hi_l, hi_r = lo_l + fwd, lo_r + fwd
    v = [(*lo_l.xy, z), (*lo_r.xy, z), (*hi_r.xy, z), (*hi_l.xy, z), (*hi_r.xy, z + rise), (*hi_l.xy, z + rise)]
    faces = [(0, 1, 4, 5), (3, 2, 1, 0), (5, 4, 2, 3), (0, 5, 3), (1, 2, 4)]
    return _mesh(name, v, faces, material)


def beam(name, start, end, thickness=0.06, material=None):
    """A square bar from `start` to `end` ((x, y, z) points), e.g. a sloping handrail."""
    a = Vector(start)
    b = Vector(end)
    d = b - a
    bpy.ops.mesh.primitive_cube_add(size=1, location=(a + b) / 2)
    o = bpy.context.active_object
    o.scale = (thickness, thickness, d.length)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _finish(o, name, material)


def railing(name, start, end, height=1.0, material=None, post_every=1.2):
    """Posts and a top rail from `start` to `end`: (x, y) on the ground or (x, y, z) on a floor or slope."""
    sx, sy, sz = (*start, 0.0)[:3]
    ex, ey, ez = (*end, 0.0)[:3]
    parts = [beam(name + '_rail', (sx, sy, sz + height), (ex, ey, ez + height), 0.06, material)]
    n = max(1, round(math.hypot(ex - sx, ey - sy) / post_every))
    for i in range(n + 1):
        t = i / n
        parts.append(box('%s_post%d' % (name, i), (0.06, 0.06, height),
                         (sx + (ex - sx) * t, sy + (ey - sy) * t, sz + (ez - sz) * t), material))
    return parts


def window(name, width, height, at, facing='front', frame=None, glass=None):
    """A framed window on a wall face. `at` is the centre of its bottom edge on the wall's surface."""
    frame = frame or material('window_frame', '#f4f1ea', roughness=0.6)
    glass = glass or material('window_glass', '#9fc4dc', roughness=0.15, metallic=0.1)
    dx, dy = _direction(facing)
    out = 0.04
    thick = 0.08
    sx, sy = (width, thick) if dx == 0 else (thick, width)
    fx, fy = at[0] + dx * out / 2, at[1] + dy * out / 2
    f = box(name + '_frame', (sx + 0.12 * (dx == 0), sy + 0.12 * (dy == 0), height + 0.12), (fx, fy, at[2] - 0.06), frame)
    g = box(name + '_glass', (sx, sy, height), (fx + dx * 0.02, fy + dy * 0.02, at[2]), glass)
    return [f, g]


def collider_box(name, size, at=(0, 0, 0), rotate=0.0):
    """An invisible box that says where the model blocks walking (instead of the automatic footprint)."""
    o = box(name if name.startswith('collider') else 'collider_' + name, size, at, None, rotate)
    o.display_type = 'WIRE'
    o.hide_render = True
    return o


# ---- output ----

def export(out=None):
    """Writes the glb (`--out` from the CLI) and, with `--preview <png>`, a picture of it."""
    out = out or _arg('--out') or os.path.splitext(os.path.abspath(sys.argv[-1]))[0] + '.glb'
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_yup=True, export_apply=True,
        export_materials='EXPORT', export_extras=False, export_animations=False,
        export_lights=False, export_cameras=False)
    print('exported %s (%.0f KB)' % (out, os.path.getsize(out) / 1024))
    shot = _arg('--preview')
    if isinstance(shot, str):
        preview(shot)
    return out


def preview(path, size=512):
    """Renders the model from the front right, above, on a transparent background (Workbench)."""
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == 'MESH' and not o.hide_render]
    if not meshes:
        return
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for o in meshes:
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.color_type = 'MATERIAL'
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.render.film_transparent = True
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    cam_data = bpy.data.cameras.new('preview_cam')
    cam_data.lens = 50
    cam = bpy.data.objects.new('preview_cam', cam_data)
    scene.collection.objects.link(cam)
    direction = Vector((0.75, -1.0, 0.65)).normalized()
    cam.location = centre + direction * radius * 3.2
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    print('rendered', scene.render.filepath)
