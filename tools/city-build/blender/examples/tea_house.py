"""茶屋 — an example model: a small tea house on a raised wooden floor (engawa) with steps up to it.

    node tools/city-build/src/model-cli.ts make tools/city-build/blender/examples/tea_house.py \
        -o /tmp/tea_house.glb --preview --upload --name 茶屋

The floor is 0.45 m up (3 steps of 0.15 m): people can walk onto the veranda at the front; the room
behind it is closed (walls), so it blocks walking.
"""
import rj

rj.reset()
wood = rj.paint('#8a5a3a', 'paint_wood')
plaster = rj.material('plaster', '#efe6d2')
roof = rj.material('roof_tile', '#4d5257', roughness=0.6)
floor = rj.material('floor', '#b48a5f')
paper = rj.material('shoji', '#f6f1e4', roughness=0.9)
cloth = rj.material('noren', '#2f4f7a')

FH = 0.45  # floor height
W, D = 5.0, 4.6  # whole floor; the room takes the back 3 m, the veranda the front
# floor and its supports (solid, so nothing walks underneath)
rj.box('floor', (W, D, FH), (0, 0, 0), floor)
rj.stairs('steps', 1.6, FH, (0, -D / 2 - 0.9, 0), 'back', 0.15, 0.3, wood)
# the room
RD = 3.0
ry = D / 2 - RD / 2  # centre of the room in y
rj.box('room', (W - 0.4, RD - 0.2, 2.2), (0, ry, FH), plaster)
for i, x in enumerate((-W / 2 + 0.2, W / 2 - 0.2)):
    for j, y in enumerate((ry - RD / 2 + 0.1, ry + RD / 2 - 0.1)):
        rj.box('pillar_%d_%d' % (i, j), (0.18, 0.18, 2.3), (x, y, FH), wood)
for i in range(3):
    rj.box('shoji_%d' % i, (1.2, 0.05, 1.8), (-1.4 + i * 1.4, ry - RD / 2 + 0.06, FH + 0.1), paper)
rj.box('noren', (1.3, 0.04, 0.6), (0, ry - RD / 2 - 0.02, FH + 1.6), cloth)
# veranda posts and the roof over everything
for i, x in enumerate((-W / 2 + 0.15, W / 2 - 0.15)):
    rj.box('veranda_post_%d' % i, (0.16, 0.16, 2.3), (x, -D / 2 + 0.15, FH), wood)
rj.box('beam_front', (W, 0.16, 0.2), (0, -D / 2 + 0.15, FH + 2.3), wood)
rj.gable_roof('roof', W, D, 1.2, (0, 0, FH + 2.5), 0.45, roof)
rj.gable_wall('gable_l', D, 1.2, (-W / 2 + 0.25, 0, FH + 2.5), plaster)
rj.gable_wall('gable_r', D, 1.2, (W / 2 - 0.25, 0, FH + 2.5), plaster)
rj.export()
