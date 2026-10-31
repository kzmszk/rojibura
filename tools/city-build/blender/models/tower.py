"""塔 — a round stone tower with a pointed roof and a flag (built-in model `tower`)."""
import math
import rj

rj.reset()
stone = rj.paint('#e7e2d7')
trim = rj.material('trim', '#b8ad9b')
roof = rj.material('roof_blue', '#3f5f90', roughness=0.6)
dark = rj.material('dark', '#3a3531')
glass = rj.material('window_glass', '#9fc4dc', roughness=0.15, metallic=0.1)
flag = rj.material('flag', '#c8473d')

R = 1.6
rj.cylinder('base', R + 0.25, 0.6, (0, 0, 0), trim, verts=32)
rj.cylinder('body', R, 7.0, (0, 0, 0.6), stone, verts=32)
rj.cylinder('band', R + 0.12, 0.3, (0, 0, 4.0), trim, verts=32)
rj.cylinder('top', R + 0.25, 0.5, (0, 0, 7.6), trim, verts=32)
rj.cone('roof', R + 0.5, 3.2, (0, 0, 8.1), roof, verts=32)
rj.cylinder('pole', 0.04, 1.3, (0, 0, 11.1), dark, verts=8)
rj.box('flag', (0.03, 0.7, 0.45), (0, 0.37, 11.9), flag)
rj.box('door', (1.0, 0.2, 1.9), (0, -R + 0.05, 0.6), dark)
for i, a in enumerate((45, 135, 225, 315)):
    for j, z in enumerate((2.6, 5.2)):
        x = math.sin(math.radians(a)) * (R - 0.02)
        y = -math.cos(math.radians(a)) * (R - 0.02)
        rj.box('win_%d_%d' % (i, j), (0.55, 0.12, 1.0), (x, y, z), glass, rotate=a)
rj.export()
