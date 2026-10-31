"""展望台 — a wooden deck 1.2 m up, reached by stairs at the front; people can walk on it (`deck`)."""
import rj

rj.reset()
wood = rj.paint('#a97c55', 'paint_wood')
post = rj.material('post', '#6f5139')
rail = rj.material('rail', '#5b4130')

H = 1.2  # floor height: 8 steps of 0.15 m
# the deck is 4 x 4 m on y = -0.8 .. 3.2; the stairs come down to y = -3.2 (the front)
rj.box('floor', (4.0, 4.0, 0.2), (0, 1.2, H - 0.2), wood)
for i, (x, y) in enumerate(((-1.85, -0.65), (1.85, -0.65), (-1.85, 3.05), (1.85, 3.05), (-1.85, 1.2), (1.85, 1.2))):
    rj.box('post_%d' % i, (0.2, 0.2, H - 0.2), (x, y, 0), post)
rj.stairs('stairs', 1.4, H, (0, -3.2, 0), 'back', 0.15, 0.3, wood)
rj.railing('rail_left', (-1.95, -0.75, H), (-1.95, 3.15, H), 1.0, rail)
rj.railing('rail_right', (1.95, -0.75, H), (1.95, 3.15, H), 1.0, rail)
rj.railing('rail_back', (-1.95, 3.15, H), (1.95, 3.15, H), 1.0, rail)
rj.railing('rail_front_l', (-1.95, -0.75, H), (-0.8, -0.75, H), 1.0, rail)
rj.railing('rail_front_r', (0.8, -0.75, H), (1.95, -0.75, H), 1.0, rail)
rj.railing('rail_stairs_l', (-0.8, -3.2, 0.15), (-0.8, -0.75, H), 0.9, rail)
rj.railing('rail_stairs_r', (0.8, -3.2, 0.15), (0.8, -0.75, H), 0.9, rail)
rj.export()
