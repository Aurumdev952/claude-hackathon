# Anatomy model build (`frontend/public/models/body.glb`)

This build turns the open-licence **Z-Anatomy** FBX exports into one named-node GLB and an anchor file for
the React-Three-Fiber body viewer. Z-Anatomy is CC BY-SA 4.0 and is derived from BodyParts3D
(CC BY-SA 2.1 JP). See `frontend/public/models/CREDITS.md` for the full credits.

## Run

```bash
apt-get install -y blender python3-numpy   # Blender 4.0.x tested
cd tools/anatomy && npm install            # @gltf-transform/cli, three, meshoptimizer
WORK=/some/scratch/dir ./build_body.sh     # takes about 3 min; downloads about 230 MB of FBX
```

The build writes three files to `frontend/public/models/`:

| file | what it is |
|---|---|
| `body.glb` | About 10.5 MiB. Uses KHR_mesh_quantization, so no decoder is needed. **Use this one.** |
| `body.meshopt.glb` | About 2.7 MiB. The same content with EXT_meshopt_compression. It needs a MeshoptDecoder, which drei's `useGLTF` sets up by default. |
| `body_anchors.json` | The centroid and bounding box of each organ, plus anchor points. All values are in world space (glTF space). |

Set `KEEP_RAW=1` to keep the downloaded FBX files and `body_raw.glb` in `$WORK`.

## Files

- `build_body.sh`: the whole pipeline. It sparse-clones only `Resources/Models/FBX`, runs Blender, then runs gltf-transform and verification.
- `build_body.py`: the headless Blender script. It selects, merges, fills holes, decimates, normalises, computes anchors and exports. The mapping from Z-Anatomy objects to output nodes is the `FILES` table at the top.
- `verify_body.mjs`: prints each node with its triangle count and bounds, plus the file size. It fails if a required node is missing.
- `preview_body.py`: optional. Renders front and side PNGs with Cycles on the CPU: `blender -b -P preview_body.py -- in.glb out_prefix [hide,csv]`.

## Output conventions

- **Units and orientation:** metres, Y-up, 1.75 m tall, feet at y=0, centred on x=0 and z=0. The patient faces **+Z**, so the patient's left is **+X**.
- **Node transforms:** each node has its own translation and scale, which undo the quantization. Use world positions. The values in `body_anchors.json` are already world-space.
- **Nodes:** `skin`, `muscles`, `skeleton`, `brain`, `oesophagus`, `stomach`, `duodenum`,
  `small_intestine`, `large_intestine`, `liver`, `gallbladder`, `spleen`, `pancreas`, `kidney_l`,
  `kidney_r`, `heart`, `lung_l`, `lung_r`, `vessels`, `lymph_nodes`. Each node has one mesh with one
  primitive and a simple material, and each mesh has normals.
- **Anchors:**
  - `stomach_cardia`: stomach vertices nearest the lowest part of the oesophagus.
  - `stomach_antrum`: stomach vertices nearest the duodenum.
  - `stomach_body`: stomach vertices midway between the cardia and the pylorus.
  - `stomach_pylorus` and `oesophagogastric_junction`.
  - `peritoneum`: the centroid of the greater omentum.
  - `liver_metastasis`: the centroid of liver segment VIII.

## What each node contains

| node | Z-Anatomy source |
|---|---|
| `skin` | *Regions of human body*: all surface regions except hair |
| `muscles` | *Muscular system*. Muscles that rays from 10 outside directions hit first, with bones as occluders. That gives 264 of 471. Fasciae, bursae, sheaths, retinacula and septa are excluded. |
| `skeleton` | *Skeletal system*, without the auditory ossicles or laryngeal cartilages |
| `brain` | *Nervous system*, `Brain.g`, voxel-remeshed at 2.5 mm into a single outer surface |
| `small_intestine` | `Jejunum`. Z-Anatomy has no separate ileum. |
| `large_intestine` | Ascending, transverse, descending and sigmoid colon, plus the appendix. There is no separate caecum or rectum mesh. |
| `lung_l`, `lung_r` | The lung lobes |
| `heart` | All of `Heart.g`: atria, ventricles, valves and papillary muscles |
| `vessels` | Aorta and its main branches: carotid, subclavian, coeliac, SMA/IMA, renal, iliac and femoral. Also the caval, portal, splenic, gastric, pulmonary and jugular vessels. |
| `lymph_nodes` | Visceral and parietal abdominal lymph node groups: gastric, gastro-omental, pyloric, pancreatic, coeliac, mesenteric and lumbar |
