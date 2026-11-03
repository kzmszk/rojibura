"""Blender side: materials, meshes from geom.World, the glb export and previews."""
import math, os

import bpy
import numpy as np

from . import geom

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, '..', 'tex')

# name: (texture set or None, tint, roughness, metallic, tile metres, extra)
# Materials are named for what they are; nature.ts (the browser) keys its seasonal looks on the prefixes
# grass, hedge, moss, water_pond, water_onsen, snow_soft, snow_trod, roof_, stone, timber, wood.
MATS = {
    'grass': ('Grass004', (1, 1, 1), 0.95, 0, 2.5, {}),
    'cobble': ('cobblestone_floor_08', (1, 1, 1), 0.85, 0, 2.0, {}),
    'cobble_square': ('patterned_cobblestone', (1.05, 1.0, 0.95), 0.85, 0, 2.6, {}),
    'gravel': ('gravel_floor_02', (0.95, 0.92, 0.86), 0.95, 0, 2.0, {}),
    'trail': ('Ground016', (0.85, 0.78, 0.68), 0.95, 0, 2.0, {}),
    'plaster': ('Plaster003', (1, 1, 1), 0.9, 0, 1.6, {}),
    'stone_blocks': ('medieval_blocks_02', (1, 1, 1), 0.85, 0, 1.8, {}),
    'stone_wall': ('castle_wall_slates', (1, 1, 1), 0.9, 0, 2.5, {}),
    'stone_ashlar': ('white_sandstone_bricks', (1.0, 0.94, 0.8), 0.85, 0, 2.0, {}),   # the college
    'lead': (None, (0.42, 0.45, 0.48), 0.55, 0.4, 1, {}),                              # the chapel's roof
    'timber': ('medieval_wood', (0.55, 0.42, 0.32), 0.8, 0, 1.0, {}),
    'roof_clay': ('clay_roof_tiles_02', (1, 1, 1), 0.8, 0, 2.2, {}),
    'roof_slate': ('roof_slates_02', (0.8, 0.82, 0.88), 0.7, 0, 2.2, {}),
    'roof_kawara': ('RoofingTiles013A', (0.9, 0.9, 0.95), 0.6, 0, 2.4, {}),
    'wood': ('wooden_planks', (1, 1, 1), 0.85, 0, 1.4, {}),
    'wood_deck': ('wood_floor_deck', (0.9, 0.85, 0.8), 0.8, 0, 2.0, {}),
    'stone': ('PavingStones109', (1, 1, 1), 0.85, 0, 1.6, {}),
    'stone_onsen': ('stone_tiles_02', (0.95, 0.93, 0.9), 0.8, 0, 2.2, {}),
    'rock': ('rock_wall_13', (0.95, 0.92, 0.88), 0.9, 0, 2.0, {}),
    'glass': (None, (0.06, 0.075, 0.085), 0.1, 0.5, 1, {}),
    'glass_shop': (None, (0.55, 0.62, 0.66), 0.08, 0.1, 1, {'alpha': 0.35}),
    'metal': (None, (0.08, 0.08, 0.09), 0.55, 0.8, 1, {}),
    'paint': (None, (1, 1, 1), 0.7, 0, 1, {}),                 # vertex colours: shutters, doors, goods
    'cloth': (None, (1, 1, 1), 0.95, 0, 1, {}),                # awnings, noren
    'lamp': (None, (1.0, 0.86, 0.6), 0.5, 0, 1, {'emit': 2.5}),
    'light_panel': (None, (1.0, 0.97, 0.9), 0.5, 0, 1, {'emit': 1.6}),
    'shoji': (None, (0.96, 0.94, 0.88), 0.9, 0, 1, {'emit': 0.25}),
    'tatami': (None, (0.78, 0.76, 0.52), 0.95, 0, 1, {}),
    'water_pond': (None, (0.18, 0.30, 0.30), 0.08, 0, 1, {}),
    'water_onsen': (None, (0.62, 0.78, 0.74), 0.1, 0, 1, {}),
    'snow_soft': (None, (0.95, 0.97, 1.0), 0.75, 0, 1, {}),
    'snow_trod': (None, (0.82, 0.84, 0.88), 0.8, 0, 1, {}),
    'flowers': (None, (1, 1, 1), 0.9, 0, 1, {}),
    'hedge': (None, (0.22, 0.36, 0.16), 0.95, 0, 1, {}),
    'far_land': (None, (1, 1, 1), 1.0, 0, 1, {}),
    # Venetian houses (houses.py): walls tinted by vertex colour; the browser weathers every wall_* (weathering.ts)
    'wall_plaster': ('painted_plaster_wall', (1, 1, 1), 0.92, 0, 2.2, {'gain': 1.3}),
    'wall_red': ('red_plaster_weathered', (1, 1, 1), 0.92, 0, 2.4, {'gain': 1.15}),
    'wall_ochre': ('yellow_plaster', (1, 1, 1), 0.92, 0, 2.2, {'gain': 1.3}),
    'wall_peel': ('rough_plaster_brick_04', (1, 1, 1), 0.92, 0, 2.2, {'gain': 1.2}),
    'wall_brick': ('red_bricks_04', (1, 1, 1), 0.9, 0, 2.0, {'gain': 1.1}),
    'trim_istrian': ('marble_01', (0.96, 0.94, 0.9), 0.6, 0, 1.2, {}),
    'shutter': ('worn_shutter', (1, 1, 1), 0.7, 0, 1.0, {'gain': 2.6}),
    'wood_door': ('weathered_planks', (1, 1, 1), 0.8, 0, 1.2, {'gain': 1.4}),
    'wood_altana': ('weathered_planks', (0.85, 0.8, 0.74), 0.85, 0, 1.6, {'gain': 1.4}),
    'roof_coppi': ('clay_roof_tiles_03', (1, 1, 1), 0.8, 0, 2.4, {}),
    # the onsen (onsen.py) and the college (college.py)
    'wood_hinoki': ('hinoki_planks', (1, 1, 1), 0.7, 0, 1.6, {}),
    'wood_cedar': ('japanese_cedar_planks', (0.8, 0.72, 0.65), 0.75, 0, 1.4, {}),
    'tatami_mat': ('tatami_mat', (1, 1, 1), 0.95, 0, 1.82, {}),
    'rock_mossy': ('mossy_rock', (1, 1, 1), 0.9, 0, 1.8, {}),
    'stone_wall_jp': ('japanese_stone_wall', (1, 1, 1), 0.85, 0, 2.4, {}),
    'bamboo': ('bamboo_wall', (1, 1, 1), 0.8, 0, 1.6, {}),
    'stone_path': ('stone_pathway', (1, 1, 1), 0.85, 0, 2.6, {}),
    'pebbles': ('river_small_rocks', (1, 1, 1), 0.9, 0, 1.4, {'gain': 1.25}),
    'water_onsen_clear': (None, (0.55, 0.72, 0.7), 0.05, 0, 1, {}),
    'stone_college': ('large_sandstone_blocks', (1.0, 0.95, 0.84), 0.85, 0, 2.6, {'gain': 1.5}),
    'roof_college': ('roof_slates_03', (0.85, 0.87, 0.92), 0.7, 0, 2.2, {}),
}
SIGNS = {}   # sign_<id>: image path, set by signs.py

for k, v in MATS.items():
    geom.TILE[k] = v[4]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_made = {}


def _image(path, colour, gain=1.0):
    img = bpy.data.images.load(path, check_existing=True)
    if not colour:
        img.colorspace_settings.name = 'Non-Color'
    if gain != 1.0:
        # lighter: a copy with its pixels scaled (the vertex colours, at most 1, tint it down from there)
        name = '%s_x%.2f' % (os.path.basename(os.path.dirname(path)), gain)
        made = bpy.data.images.get(name)
        if made is None:
            w, h = img.size
            px = np.empty(w * h * 4, np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(-1, 4)
            px[:, :3] = np.clip(px[:, :3] * gain, 0, 1)
            made = bpy.data.images.new(name, w, h)
            made.pixels.foreach_set(px.ravel())
            made.pack()
        img = made
    return img


def material(name):
    if name in _made:
        return _made[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    if name.startswith('sign_'):
        tex, tint, rough, metal, extra = SIGNS[name], (1, 1, 1), 0.7, 0, {}
        img_path = tex
    else:
        tex, tint, rough, metal, _, extra = MATS[name]
        img_path = os.path.join(TEX, tex, 'diff.jpg') if tex else None
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Color'
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    nt.links.new(vc.outputs['Color'], mix.inputs['B'])
    if img_path:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = _image(img_path, True, extra.get('gain', 1.0))
        if tint != (1, 1, 1):
            tm = nt.nodes.new('ShaderNodeMix')
            tm.data_type = 'RGBA'
            tm.blend_type = 'MULTIPLY'
            tm.inputs['Factor'].default_value = 1.0
            nt.links.new(t.outputs['Color'], tm.inputs['A'])
            tm.inputs['B'].default_value = (*tint, 1)
            nt.links.new(tm.outputs['Result'], mix.inputs['A'])
        else:
            nt.links.new(t.outputs['Color'], mix.inputs['A'])
        if not name.startswith('sign_'):
            nrm = os.path.join(TEX, tex, 'nor.jpg')
            if os.path.exists(nrm):
                nt_ = nt.nodes.new('ShaderNodeTexImage')
                nt_.image = _image(nrm, False)
                nm = nt.nodes.new('ShaderNodeNormalMap')
                nt.links.new(nt_.outputs['Color'], nm.inputs['Color'])
                nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    else:
        mix.inputs['A'].default_value = (*tint, 1)
    nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if 'emit' in extra:
        bsdf.inputs['Emission Color'].default_value = (*tint, 1)
        bsdf.inputs['Emission Strength'].default_value = extra['emit']
    if 'alpha' in extra:
        bsdf.inputs['Alpha'].default_value = extra['alpha']
        m.surface_render_method = 'BLENDED'
    m.diffuse_color = (*tint, 1)
    _made[name] = m
    return m


def to_objects(W):
    """One object per bucket: <name>_<chunk i>_<chunk j>."""
    count = 0
    for (name, mat, ci, cj), b in sorted(W.b.items(), key=lambda kv: kv[0]):
        if not b.f:
            continue
        me = bpy.data.meshes.new('%s_%d_%d' % (name, ci, cj))
        V = np.asarray(b.v, dtype=np.float32)
        me.vertices.add(len(V))
        me.vertices.foreach_set('co', V.ravel())
        sizes = np.array([len(f) for f in b.f], dtype=np.int32)
        me.loops.add(int(sizes.sum()))
        me.loops.foreach_set('vertex_index', np.concatenate([np.array(f, dtype=np.int32) for f in b.f]))
        me.polygons.add(len(b.f))
        starts = np.concatenate([[0], np.cumsum(sizes)[:-1]]).astype(np.int32)
        me.polygons.foreach_set('loop_start', starts)
        loops = np.concatenate([np.array(f, dtype=np.int64) for f in b.f])
        uvl = me.uv_layers.new(name='UVMap')
        UV = np.asarray(b.uv, dtype=np.float32)
        uvl.data.foreach_set('uv', UV[loops].ravel())
        ca = me.color_attributes.new('Color', 'BYTE_COLOR', 'CORNER')
        C = np.asarray(b.col, dtype=np.float32)
        ca.data.foreach_set('color_srgb', C[loops].ravel())
        me.update(calc_edges=True)
        me.validate(clean_customdata=False)
        me.materials.append(material(mat))
        ob = bpy.data.objects.new(me.name, me)
        bpy.context.scene.collection.objects.link(ob)
        count += len(b.f)
    return count


def export(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_materials='EXPORT',
        export_extras=False, export_animations=False, export_lights=False, export_cameras=False,
        export_vertex_color='ACTIVE', export_image_format='WEBP', export_image_quality=82,
        export_normals=True, export_texcoords=True)
    print('exported %s (%.1f MB)' % (path, os.path.getsize(path) / 1e6))


def preview(path, cam_loc, cam_rot, ortho=None, res=(1600, 1000), lens=24):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = res
    world = bpy.data.worlds.new('w') if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.62, 0.74, 0.88, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    if 'sun' not in bpy.data.objects:
        sd = bpy.data.lights.new('sun', 'SUN')
        sd.energy = 3.5
        sun = bpy.data.objects.new('sun', sd)
        sun.rotation_euler = (math.radians(50), 0, math.radians(35))
        scene.collection.objects.link(sun)
    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = cam_loc
    cam.rotation_euler = [math.radians(a) for a in cam_rot]
    cd.clip_end = 3000
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    else:
        cd.lens = lens
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
