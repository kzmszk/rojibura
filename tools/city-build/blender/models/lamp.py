"""街灯 — a street lamp with a glowing lantern (built-in model `lamp`)."""
import rj

rj.reset()
iron = rj.paint('#2c2e31', 'paint_iron')
light = rj.material('lamp_light', '#ffe1a6', roughness=0.3, emission=4.0)

rj.cylinder('base', 0.2, 0.3, (0, 0, 0), iron, verts=12)
rj.cylinder('pole', 0.06, 3.0, (0, 0, 0.3), iron, verts=12, radius_top=0.045)
rj.box('arm', (0.06, 0.62, 0.06), (0, -0.28, 3.2), iron)
rj.box('lantern_cap', (0.36, 0.36, 0.06), (0, -0.55, 3.08), iron)
rj.pyramid_roof('lantern_roof', 0.36, 0.36, 0.16, (0, -0.55, 3.14), 0.0, iron)
rj.box('lantern', (0.24, 0.24, 0.34), (0, -0.55, 2.74), light)
rj.box('lantern_bottom', (0.3, 0.3, 0.04), (0, -0.55, 2.7), iron)
rj.export()
