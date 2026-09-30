"""
Blender (>= 4.0) headless build script: Z-Anatomy FBX exports -> body_raw.glb + body_anchors.json

Usage:
  blender -b -P build_body.py -- <fbx_dir> <out_raw_glb> <out_anchors_json>

<fbx_dir> is Z-Anatomy's `Resources/Models/FBX` folder (github.com/LluisV/Z-Anatomy).
The output GLB is unoptimised; build_body.sh post-processes it with gltf-transform.

Coordinates: Z-Anatomy/Blender is Z-up, metres, anterior = -Y, patient's left = +X.
The glTF exporter converts to Y-up with anterior = +Z (patient faces +Z, patient's left at +X).
"""
import bpy, bmesh, sys, os, re, json, math
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
FBX_DIR, OUT_GLB, OUT_ANCHORS = argv[0], argv[1], argv[2]

TARGET_HEIGHT = 1.75  # metres

# ----------------------------------------------------------------------------------------------
# Output groups: name -> (fbx file, selector, target triangle count or None to keep)
# selector: ("names", [...exact object names...]) | ("desc", [group roots], exclude_regex)
#           | ("regex", pattern)
# ----------------------------------------------------------------------------------------------
VESSEL_RE = (r"^(Ascending aorta|Aortic arch|Thoracic aorta|Abdominal aorta|Brachiocephalic trunk|"
             r"(Left|Right) common carotid artery|Internal carotid artery\.[lr]|External carotid artery\.[lr]|"
             r"(Left|Right) subclavian (artery|vein)|Axillary (artery|vein)\.[lr]|Brachial artery\.[lr]|"
             r"Radial artery\.[lr]|Ulnar artery\.[lr]|Common iliac (artery|vein)\.[lr]|"
             r"External iliac (artery|vein)\.[lr]|Internal iliac (artery|vein)\.[lr]|Femoral (artery|vein)\.[lr]|"
             r"Popliteal (artery|vein)\.[lr]|Anterior tibial artery\.[lr]|Posterior tibial artery\.[lr]|"
             r"Coeliac trunk|Common hepatic artery|Proper hepatic artery|Splenic (artery|vein)|"
             r"Left gastric (artery|vein)|Right gastric (artery|vein)|Gastroduodenal artery|"
             r"(Left|Right) gastro-omental (artery|vein)|Superior mesenteric (artery|vein)|"
             r"Inferior mesenteric (artery|vein)|(Left|Right) renal (artery|vein)|Superior vena cava|"
             r"Inferior vena cava.*|Hepatic portal vein|Hepatic veins|Internal jugular vein\.[lr]|"
             r"(Left|Right) brachiocephalic vein|Pulmonary trunk|(Left|Right) pulmonary artery|"
             r"(Left|Right) (superior|inferior) pulmonary vein|Vertebral artery\.[lr]|Great saphenous vein\.[lr])$")

MUSCLE_EXCLUDE_RE = r"(fascia|bursa|sheath|retinacul|septum|tarsus|ligament|tendinous arch|aponeuros)"

FILES = [
    # order matters: skeleton first (used as occluder for the superficial-muscle test)
    ("SkeletalSystem100.fbx", {
        "skeleton": (("desc", None, r"(Auditory ossicles|Laryngeal cartilages)"), 160000),
    }),
    ("MuscularSystem100.fbx", {
        "muscles": (("superficial", MUSCLE_EXCLUDE_RE), 130000),
    }),
    ("Regions of human body100.fbx", {
        "skin": (("desc", None, r"^(Hairs\.g|Hairs of head|Pubic hairs)"), 70000),
    }),
    ("NervousSystem100.fbx", {
        "brain": (("remesh", ["Brain.g"], 0.0025), 40000),
    }),
    ("VisceralSystem100.fbx", {
        "oesophagus": (("names", ["Oesophagus"]), 6000),
        "stomach": (("names", ["Stomach"]), None),
        "duodenum": (("names", ["Duodenum"]), None),
        "small_intestine": (("names", ["Jejunum", "Ileum"]), 20000),
        "large_intestine": (("names", ["Caecum", "Ascending colon", "Transverse colon", "Descending colon",
                                       "Sigmoid colon", "Rectum", "Vermiform appendix"]), 24000),
        "liver": (("names", ["Liver"]), None),
        "gallbladder": (("names", ["Gallbladder"]), None),
        "pancreas": (("names", ["Pancreas"]), None),
        "kidney_l": (("names", ["Kidney.l"]), None),
        "kidney_r": (("names", ["Kidney.r"]), None),
        "lung_l": (("names", ["Superior lobe of left lung", "Inferior lobe of left lung"]), 14000),
        "lung_r": (("names", ["Superior lobe of right lung", "Middle lobe of right lung",
                              "Inferior lobe of right lung"]), 16000),
        # helpers for anchors only (not exported)
        "_greater_omentum": (("names", ["Greater omentum"]), 8000),
        "_liver_seg8": (("names", ["Posterior medial segment of liver (VIII)"]), None),
    }),
    ("LymphoidOrgans100.fbx", {
        "spleen": (("names", ["Spleen"]), None),
        "lymph_nodes": (("desc", ["Visceral abdominal lymph nodes.g", "Parietal abdominal lymph nodes.g"], None), 12000),
    }),
    ("CardioVascular41.fbx", {
        "heart": (("desc", ["Heart.g"], None), 30000),
        "vessels": (("regex", VESSEL_RE), 60000),
    }),
]

COLORS = {
    "skin": (0.85, 0.66, 0.55, 1), "muscles": (0.62, 0.16, 0.14, 1), "skeleton": (0.9, 0.87, 0.78, 1),
    "brain": (0.86, 0.6, 0.6, 1), "oesophagus": (0.8, 0.45, 0.4, 1), "stomach": (0.85, 0.5, 0.45, 1),
    "duodenum": (0.85, 0.6, 0.45, 1), "small_intestine": (0.88, 0.62, 0.52, 1),
    "large_intestine": (0.75, 0.55, 0.45, 1), "liver": (0.45, 0.13, 0.1, 1), "gallbladder": (0.3, 0.55, 0.2, 1),
    "spleen": (0.45, 0.15, 0.25, 1), "pancreas": (0.9, 0.75, 0.5, 1), "kidney_l": (0.55, 0.2, 0.15, 1),
    "kidney_r": (0.55, 0.2, 0.15, 1), "heart": (0.7, 0.12, 0.12, 1), "lung_l": (0.85, 0.55, 0.6, 1),
    "lung_r": (0.85, 0.55, 0.6, 1), "vessels": (0.7, 0.1, 0.1, 1), "lymph_nodes": (0.6, 0.8, 0.4, 1),
}


def log(*a):
    print("[build]", *a, flush=True)


def tri_count(me):
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def clear_scene_except(keep):
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.armatures, bpy.data.images):
        for d in list(coll):
            if d.users == 0:
                coll.remove(d)


def is_label(o):
    # Z-Anatomy naming: ".j"/".i" = label pins/lines, ".t" = label text, ".g" = group,
    # ".ol/.or/.el/.er" = muscle origin/insertion patches drawn on bones, "Cross Section *" = UI planes
    return (re.search(r"\.(j|i|t|g|ol|or|el|er)(\.\d{3})?$", o.name) is not None
            or o.name.startswith("Cross Section"))


def meshes_of_file(new_objs):
    return [o for o in new_objs if o.type == 'MESH' and not is_label(o) and len(o.data.polygons) > 0]


def ancestors(o):
    p = o.parent
    while p is not None:
        yield p
        p = p.parent


def base(name):
    return re.sub(r"\.\d{3}$", "", name)


def merge(objs, name):
    """Merge meshes (world space) into one new object `name`."""
    bm = bmesh.new()
    for o in objs:
        me = o.data.copy()
        mw = o.matrix_world.copy()
        me.transform(mw)
        if mw.determinant() < 0:
            me.flip_normals()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-14], context='FACES')
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def apply_modifier(ob, mod):
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob],
                                   selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def cleanup(ob):
    """Remove degenerate/loose geometry left by decimation and make the mesh valid for export."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-7, edges=bm.edges)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.validate(clean_customdata=True)
    ob.data.update()


FILL_HOLES = {"stomach", "duodenum", "oesophagus", "liver", "lung_l", "lung_r", "small_intestine",
              "gallbladder", "pancreas", "spleen", "kidney_l", "kidney_r"}


def fill_holes(ob):
    """Close open boundary loops (BodyParts3D stomach has a hole in its anterior wall; tube ends at
    cardia/pylorus are open). Each hole is capped with a fan around a centre vertex, which is then
    relaxed slightly so caps follow the organ's curvature."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    res = bmesh.ops.holes_fill(bm, edges=bm.edges, sides=0)
    faces = res["faces"]
    if faces:
        poked = bmesh.ops.poke(bm, faces=faces)
        centres = poked["verts"]
        for _ in range(4):
            bmesh.ops.smooth_vert(bm, verts=centres, factor=0.5, use_axis_x=True, use_axis_y=True,
                                  use_axis_z=True)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    if faces:
        log(f"  filled {len(faces)} hole(s) in {ob.name}")


def decimate(ob, target):
    n = tri_count(ob.data)
    if target is None or n <= target:
        return
    m = ob.modifiers.new("dec", 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = target / n
    m.use_collapse_triangulate = True
    apply_modifier(ob, m)
    cleanup(ob)
    log(f"  decimated {ob.name}: {n} -> {tri_count(ob.data)}")


def voxel_remesh(ob, voxel):
    m = ob.modifiers.new("rem", 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    m.adaptivity = 0.0
    apply_modifier(ob, m)
    log(f"  remeshed {ob.name}: {tri_count(ob.data)} tris")


def world_tris(objs):
    """Concatenate world-space triangles of objs -> (verts list, tris list, owner index per tri)."""
    V, T, owner = [], [], []
    off = 0
    for i, o in enumerate(objs):
        me = o.data
        me.calc_loop_triangles()
        nv = len(me.vertices)
        co = np.empty(nv * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3).astype(np.float64)
        mw = np.array(o.matrix_world)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        tv = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("vertices", tv)
        if len(tv) and (tv.min() < 0 or tv.max() >= nv):
            log(f"  !! bad tri indices in {o.name}: {tv.min()} {tv.max()} nv={nv}")
        V.append(co)
        T.append(tv.reshape(-1, 3).astype(np.int64) + off)
        owner.append(np.full(len(me.loop_triangles), i, dtype=np.int64))
        off += nv
    return np.concatenate(V), np.concatenate(T), np.concatenate(owner)


def superficial_muscles(cands, occluders, spacing=0.004, min_hits=20):
    """Keep muscles that are the first surface hit by rays cast from outside the body (8 horizontal
    directions + from above + from below). Bones are included as occluders so rays passing
    between muscles onto bone do not count deep muscles as visible."""
    V, T, owner = world_tris(cands + occluders)
    ncand = len(cands)
    log(f"  BVH over {len(T)} tris ({ncand} muscle candidates)")
    bvh = BVHTree.FromPolygons(V.tolist(), T.tolist(), all_triangles=True)
    mn, mx = V.min(0), V.max(0)
    ctr = (mn + mx) / 2
    R = float(np.linalg.norm(mx - mn)) / 2 + 0.05
    hits = np.zeros(ncand + len(occluders), dtype=np.int64)
    dirs = [Vector((math.cos(a), math.sin(a), 0.0)) for a in np.radians(np.arange(0, 360, 45))]
    dirs += [Vector((0, 0, -1.0)), Vector((0, 0, 1.0))]
    for d in dirs:
        # orthonormal basis for the ray plane
        u = d.cross(Vector((0, 0, 1))) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        u.normalize()
        w = d.cross(u)
        w.normalize()
        c = Vector(ctr)
        steps = np.arange(-R, R, spacing)
        for a in steps:
            for b in steps:
                o = c + u * a + w * b - d * R
                loc, nrm, idx, dist = bvh.ray_cast(o, d, 2 * R)
                if idx is not None:
                    hits[owner[idx]] += 1
    keep = [o for i, o in enumerate(cands) if hits[i] >= min_hits]
    log(f"  superficial muscles: {len(keep)}/{ncand}")
    return keep


def select(sel, meshes, occluders):
    kind = sel[0]
    if kind == "names":
        wanted = set(sel[1])
        return [o for o in meshes if base(o.name) in wanted]
    if kind == "regex":
        r = re.compile(sel[1])
        return [o for o in meshes if r.match(base(o.name))]
    if kind in ("desc", "remesh"):
        roots = sel[1]
        excl = re.compile(sel[2]) if (kind == "desc" and sel[2]) else None
        out = []
        for o in meshes:
            chain = [o] + list(ancestors(o))
            names = [base(a.name) for a in chain]
            if roots is not None and not any(n in roots for n in names):
                continue
            if excl is not None and any(excl.search(n) for n in names):
                continue
            out.append(o)
        return out
    if kind == "superficial":
        excl = re.compile(sel[1], re.I)
        cands = [o for o in meshes if not any(excl.search(base(a.name)) for a in [o] + list(ancestors(o)))]
        return superficial_muscles(cands, occluders)
    raise ValueError(kind)


# ----------------------------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
results = {}
for fname, groups in FILES:
    path = os.path.join(FBX_DIR, fname)
    log("importing", fname)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = meshes_of_file(new)
    log(f"  {len(meshes)} meshes")
    for gname, (sel, target) in groups.items():
        objs = select(sel, meshes, [results["skeleton"]] if "skeleton" in results else [])
        if not objs:
            log(f"  !! no meshes for {gname}")
            continue
        ob = merge(objs, gname)
        log(f"  {gname}: {len(objs)} parts, {tri_count(ob.data)} tris")
        if gname in FILL_HOLES:
            fill_holes(ob)
        if sel[0] == "remesh":
            voxel_remesh(ob, sel[2])
        decimate(ob, target)
        results[gname] = ob
    clear_scene_except(set(results.values()))

# ----------------------------------------------------------------------------------------------
# Normalise: feet at z=0, height 1.75 m, centred on x=0,y=0 (Blender space) using the skin bbox
skin = results["skin"]
co = np.array([v.co[:] for v in skin.data.vertices])
mn, mx = co.min(0), co.max(0)
s = TARGET_HEIGHT / (mx[2] - mn[2])
T = Matrix.Translation(Vector((0, 0, 0))) @ Matrix.Scale(s, 4)
off = Vector((-(mn[0] + mx[0]) / 2 * s, -(mn[1] + mx[1]) / 2 * s, -mn[2] * s))
M = Matrix.Translation(off) @ Matrix.Scale(s, 4)
log(f"normalise: scale {s:.4f}, offset {tuple(round(x, 4) for x in off)}")
for ob in results.values():
    ob.data.transform(M)
    ob.data.update()


# ----------------------------------------------------------------------------------------------
# Anchors (converted to glTF space: x, z, -y)
def g(v):
    return [round(float(v[0]), 4), round(float(v[2]), 4), round(float(-v[1]), 4)]


def verts(ob):
    return np.array([v.co[:] for v in ob.data.vertices])


def area_centroid(ob):
    me = ob.data
    me.calc_loop_triangles()
    P = verts(ob)
    tv = np.array([t.vertices[:] for t in me.loop_triangles])
    a, b, c = P[tv[:, 0]], P[tv[:, 1]], P[tv[:, 2]]
    ar = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    return ((a + b + c) / 3 * ar[:, None]).sum(0) / ar.sum()


organs = {}
for name, ob in results.items():
    if name.startswith("_"):
        continue
    P = verts(ob)
    lo, hi = P.min(0), P.max(0)
    # glTF bbox: y<-z, z<- -y (so min/max swap on that axis)
    organs[name] = {
        "centroid": g(area_centroid(ob)),
        "min": [round(float(lo[0]), 4), round(float(lo[2]), 4), round(float(-hi[1]), 4)],
        "max": [round(float(hi[0]), 4), round(float(hi[2]), 4), round(float(-lo[1]), 4)],
        "triangles": tri_count(ob.data),
    }

anchors = {}
S = verts(results["stomach"])
oes = verts(results["oesophagus"])
duo = verts(results["duodenum"])
# oesophago-gastric junction: lowest oesophagus vertices
ogj = oes[oes[:, 2] <= oes[:, 2].min() + 0.01].mean(0)
# pylorus: stomach vertices closest to the duodenum
dmin = np.array([np.min(np.linalg.norm(duo - p, axis=1)) for p in S])
pyl = S[dmin <= np.percentile(dmin, 3)].mean(0)
d_c = np.linalg.norm(S - ogj, axis=1)
d_p = np.linalg.norm(S - pyl, axis=1)
cardia = S[d_c <= np.percentile(d_c, 8)].mean(0)
antrum = S[(d_p <= np.percentile(d_p, 15))].mean(0)
ratio = d_c / (d_c + d_p)
body = S[(ratio > 0.35) & (ratio < 0.6)].mean(0)
anchors["stomach_cardia"] = g(cardia)
anchors["stomach_body"] = g(body)
anchors["stomach_antrum"] = g(antrum)
anchors["stomach_pylorus"] = g(pyl)
anchors["oesophagogastric_junction"] = g(ogj)
if "_greater_omentum" in results:
    anchors["peritoneum"] = g(area_centroid(results["_greater_omentum"]))
if "_liver_seg8" in results:
    anchors["liver_metastasis"] = g(area_centroid(results["_liver_seg8"]))
for name in [n for n in results if n.startswith("_")]:
    bpy.data.objects.remove(results.pop(name), do_unlink=True)

with open(OUT_ANCHORS, "w") as f:
    json.dump({
        "units": "metres", "up": "+Y", "facing": "+Z", "patient_left": "+X",
        "height": TARGET_HEIGHT,
        "organs": organs, "anchors": anchors,
        "notes": {
            "stomach_cardia": "stomach verts nearest the oesophago-gastric junction",
            "stomach_antrum": "stomach verts nearest the pylorus/duodenum",
            "stomach_body": "stomach verts midway between cardia and pylorus",
            "peritoneum": "area centroid of the greater omentum (anterior peritoneal apron)",
            "liver_metastasis": "centroid of liver segment VIII (right lobe)",
        },
    }, f, indent=1)
log("anchors written", OUT_ANCHORS)

# ----------------------------------------------------------------------------------------------
# Materials, smoothing, export
for name, ob in results.items():
    if ob.data.validate(verbose=False, clean_customdata=True):
        log(f"  fixed invalid geometry in {name}")
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = COLORS.get(name, (0.8, 0.8, 0.8, 1))
    bsdf.inputs["Roughness"].default_value = 0.6
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    ob.data.use_auto_smooth = True
    ob.data.auto_smooth_angle = math.radians(70)
    ob.data.name = name
    ob.name = name

bpy.ops.object.select_all(action='DESELECT')
for ob in results.values():
    ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True,
                          export_apply=True, export_normals=True, export_texcoords=False,
                          export_tangents=False, export_materials='EXPORT', export_cameras=False,
                          export_lights=False, export_draco_mesh_compression_enable=False)
log("exported", OUT_GLB)
for name, ob in results.items():
    log(f"  {name:16s} {tri_count(ob.data):7d} tris")
