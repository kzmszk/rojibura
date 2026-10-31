"""ベンチ — a park bench with wooden slats and iron legs (built-in model `bench`)."""
import rj

rj.reset()
wood = rj.paint('#9b6c45', 'paint_wood')
iron = rj.material('iron', '#2f3134', roughness=0.5, metallic=0.6)

for side, x in (('l', -0.68), ('r', 0.68)):
    rj.box('leg_%s' % side, (0.06, 0.5, 0.42), (x, 0, 0), iron)
    rj.box('arm_%s' % side, (0.06, 0.5, 0.05), (x, -0.02, 0.62), iron)
    rj.box('back_%s' % side, (0.06, 0.06, 0.5), (x, 0.24, 0.42), iron)
    rj.box('armpost_%s' % side, (0.05, 0.05, 0.2), (x, -0.22, 0.42), iron)
for i in range(4):
    rj.box('seat_%d' % i, (1.6, 0.11, 0.04), (0, -0.2 + i * 0.13, 0.42), wood)
for i in range(2):
    rj.box('back_slat_%d' % i, (1.6, 0.04, 0.11), (0, 0.27, 0.56 + i * 0.16), wood)
rj.export()
