"""木 — a leafy tree; only its trunk blocks walking (built-in model `tree`)."""
import rj

rj.reset()
bark = rj.material('bark', '#6b4a33')
leaves = rj.paint('#5e9b52', 'paint_leaves')

rj.cylinder('trunk', 0.2, 2.7, (0, 0, 0), bark, verts=12, radius_top=0.13)
rj.sphere('crown_1', 1.35, (0, 0, 3.2), leaves, squash=0.85)
rj.sphere('crown_2', 1.0, (0.75, 0.3, 2.9), leaves, squash=0.85)
rj.sphere('crown_3', 0.95, (-0.65, -0.4, 3.0), leaves, squash=0.9)
rj.sphere('crown_4', 0.8, (0.1, 0.55, 4.0), leaves)
rj.collider_box('collider_trunk', (0.5, 0.5, 2.0))
rj.export()
