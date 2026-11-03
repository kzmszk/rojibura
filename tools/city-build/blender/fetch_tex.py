"""Fetch the CC0 texture sets the town is made with (Poly Haven, 1k jpg: diff, nor_gl, rough) into tex/<id>/.

    python3 tools/city-build/blender/fetch_tex.py            # every set in SETS that is not there yet

tex/ is not committed (gitignored): the textures end up inside the glb, resized. All sets are CC0
(https://polyhaven.com/license), so the glb needs no credit for them.
"""
import json, os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'tex')
UA = {'User-Agent': 'rojibura-asset-fetcher/1.0 (personal project; CC0 assets only)'}

# id: what it is for
SETS = {
    'cobblestone_floor_08': 'streets',
    'patterned_cobblestone': 'the church plaza',
    'clay_roof_tiles_02': 'terracotta roofs',
    'roof_slates_02': 'slate roofs',
    'white_plaster_rough_01': 'house walls (tinted per house)',
    'medieval_wood': 'half-timbering, doors, shutters',
    'medieval_blocks_02': 'stone ground floors, town gate',
    'castle_wall_slates': 'stone walls, retaining walls',
    'wood_floor_deck': 'decks, the onsen veranda',
    'stone_tiles_02': 'onsen paving',
    'wooden_planks': 'benches, fences, stalls',
    'rock_wall_13': 'onsen rocks, mountain outcrops',
    'forest_floor': 'woods on the mountain',
    'aerial_grass_rock': 'lawns',
    'gravel_floor_02': 'park paths',
    'brown_mud_leaves_01': 'the mountain trail',
    'white_sandstone_bricks': 'the college: ashlar of pale stone',
    # Venetian houses (issue 42)
    'painted_plaster_wall': 'house walls: weathered plaster, tinted per house',
    'red_plaster_weathered': 'house walls: Venetian red plaster',
    'yellow_plaster': 'house walls: ochre plaster',
    'rough_plaster_brick_04': 'house walls: plaster fallen off the brick',
    'red_bricks_04': 'house walls: bare brick',
    'marble_01': 'Istrian stone: window and door frames, string courses, balconies, the walls\' feet',
    'worn_shutter': 'shutters (persiane): the slats (normal map)',
    'wood_peeling_paint_weathered': 'shutters: paint peeling off (colour), tinted',
    'weathered_planks': 'altane (roof terraces), doors',
    'clay_roof_tiles_03': 'old coppi roofs',
    # the onsen
    'hinoki_planks': 'the onsen: cypress walls and baths',
    'japanese_cedar_planks': 'the onsen: cedar boards',
    'tatami_mat': 'the changing rooms',
    'mossy_rock': 'the open-air baths: boulders round the pools',
    'river_small_rocks': 'the open-air baths: pebbles on the bottom',
    'japanese_stone_wall': 'the open-air baths: stone walls',
    'bamboo_wall': 'the open-air baths: bamboo screens',
    'stone_pathway': 'the open-air baths: stepping stones',
    # the college
    'large_sandstone_blocks': 'the college: weathered pale stone',
    'roof_slates_03': 'the college: slate roofs',
}


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA)).read()


def main():
    for sid in SETS:
        d = os.path.join(OUT, sid)
        if os.path.exists(os.path.join(d, 'diff.jpg')):
            continue
        files = json.loads(get('https://api.polyhaven.com/files/%s' % sid))
        os.makedirs(d, exist_ok=True)
        for key, short in [('Diffuse', 'diff'), ('nor_gl', 'nor'), ('Rough', 'rough')]:
            if key in files:
                with open(os.path.join(d, short + '.jpg'), 'wb') as f:
                    f.write(get(files[key]['1k']['jpg']['url']))
        print('fetched', sid)


def shutters():
    """tex/shutter_venice: the shutters' paint, light where it has chalked and chipped (wood_peeling_paint_weathered),
    with the slats' lines (worn_shutter), grey to be tinted green by the vertex colours; the slats' normal map."""
    d = os.path.join(OUT, 'shutter_venice')
    if os.path.exists(os.path.join(d, 'diff.jpg')):
        return
    from PIL import Image, ImageChops, ImageOps
    os.makedirs(d, exist_ok=True)
    peel = Image.open(os.path.join(OUT, 'wood_peeling_paint_weathered', 'diff.jpg')).convert('RGB').resize((1024, 1024))
    slats = ImageOps.autocontrast(Image.open(os.path.join(OUT, 'worn_shutter', 'diff.jpg')).convert('L').resize((1024, 1024)))
    r, g, b = peel.split()
    # where the wood shows (warmer than the blue-grey paint): chips
    chips = ImageOps.autocontrast(ImageChops.subtract(r, b)).point(lambda v: 255 if v > 90 else int(v * 2.2))
    paint = Image.new('L', (1024, 1024), 178)
    out = Image.composite(Image.new('L', (1024, 1024), 245), paint, chips)
    out = ImageChops.multiply(out, slats.point(lambda v: 150 + v * 105 // 255))
    out.convert('RGB').save(os.path.join(d, 'diff.jpg'), quality=90)
    with open(os.path.join(OUT, 'worn_shutter', 'nor.jpg'), 'rb') as f, open(os.path.join(d, 'nor.jpg'), 'wb') as g:
        g.write(f.read())
    print('made shutter_venice')


if __name__ == '__main__':
    main()
    shutters()
