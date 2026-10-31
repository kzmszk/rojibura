"""家 — a small house with a pitched roof, a door at the front and windows (built-in model `house`)."""
import rj

rj.reset()
wall = rj.paint('#ecdcc0')
roof = rj.material('roof', '#9b4b3b', roughness=0.7)
stone = rj.material('stone', '#a59d91')
wood = rj.material('wood_dark', '#5c3e2b')

W, D, H, F = 4.4, 3.6, 2.6, 0.25  # width, depth, wall height, foundation
rj.box('foundation', (W + 0.2, D + 0.2, F), (0, 0, 0), stone)
rj.box('walls', (W, D, H), (0, 0, F), wall)
rj.gable_wall('gable_left', D, 1.3, (-W / 2 + 0.1, 0, F + H), wall)
rj.gable_wall('gable_right', D, 1.3, (W / 2 - 0.1, 0, F + H), wall)
rj.gable_roof('roof', W, D, 1.3, (0, 0, F + H), 0.35, roof)
rj.box('chimney', (0.45, 0.45, 1.7), (1.3, 0.8, F + H + 0.2), stone)
rj.box('door', (0.9, 0.08, 1.9), (0.9, -D / 2 - 0.02, F), wood)
rj.box('door_step', (1.3, 0.45, 0.15), (0.9, -D / 2 - 0.3, 0), stone)
rj.window('win_front', 1.0, 0.9, (-0.9, -D / 2, F + 1.0), 'front')
rj.window('win_back', 1.4, 0.9, (0, D / 2, F + 1.0), 'back')
rj.window('win_left', 0.8, 0.9, (-W / 2, 0, F + 1.0), 'left')
rj.window('win_right', 0.8, 0.9, (W / 2, 0, F + 1.0), 'right')
rj.export()
