"""橋 — a footbridge with slopes at both ends; people walk over it, not under it (built-in model `bridge`)."""
import rj

rj.reset()
stone = rj.paint('#c9bfae', 'paint_stone')
rail = rj.material('rail', '#5b4130')
dark = rj.material('stone_dark', '#8e8576')

H = 0.9  # height of the middle
W = 2.4  # width
L = 3.0  # length of each slope
rj.ramp('ramp_left', W, L, H, (-2.0 - L, 0, 0), 'right', stone)
rj.ramp('ramp_right', W, L, H, (2.0 + L, 0, 0), 'left', stone)
rj.box('span', (4.0, W, 0.3), (0, 0, H - 0.3), stone)
rj.box('pier_left', (0.5, W, H - 0.3), (-1.9, 0, 0), dark)
rj.box('pier_right', (0.5, W, H - 0.3), (1.9, 0, 0), dark)
for side, y in (('n', W / 2 - 0.05), ('s', -W / 2 + 0.05)):
    rj.railing('rail_%s_left' % side, (-2.0 - L, y, 0.0), (-2.0, y, H), 0.9, rail)
    rj.railing('rail_%s_mid' % side, (-2.0, y, H), (2.0, y, H), 0.9, rail)
    rj.railing('rail_%s_right' % side, (2.0, y, H), (2.0 + L, y, 0.0), 0.9, rail)
rj.export()
