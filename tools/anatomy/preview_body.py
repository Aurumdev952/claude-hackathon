"""
Optional: render quick PNG previews of a body GLB with Cycles (CPU, headless).
  blender -b -P preview_body.py -- <in.glb> <out_prefix> [hide_csv]
Writes <out_prefix>_front.png and <out_prefix>_side.png.
"""
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, prefix = argv[0], argv[1]
hide = set(argv[2].split(",")) if len(argv) > 2 and argv[2] else set()

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.name in hide:
        o.hide_render = True

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 16
sc.cycles.use_denoising = False
sc.render.resolution_x, sc.render.resolution_y = 400, 800
sc.world = bpy.data.worlds.new("w")
sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN'))
sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
sc.collection.objects.link(sun)

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 1.95
sc.collection.objects.link(cam)
sc.camera = cam
# Blender space after glTF import: Z-up, patient faces -Y
for tag, loc, rot in [("front", (0, -4, 0.9), (math.radians(90), 0, 0)),
                      ("side", (4, 0, 0.9), (math.radians(90), 0, math.radians(90)))]:
    cam.location = loc
    cam.rotation_euler = rot
    sc.render.filepath = f"{prefix}_{tag}.png"
    bpy.ops.render.render(write_still=True)
