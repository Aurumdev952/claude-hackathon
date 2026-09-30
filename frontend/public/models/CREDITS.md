# 3D anatomy model credits

Files: `body.glb`, `body.meshopt.glb`, `body_anchors.json`

## Source

- **Z-Anatomy: the open-source atlas of anatomy.** Author: Lluís Vinent (LluisV) and Z-Anatomy contributors.
  Repository: https://github.com/LluisV/Z-Anatomy (branch `PC-Version`, commit
  `6c7f9016bd5899ac8edafd31b9900c151df42ed6`), files `Resources/Models/FBX/*.fbx`.
  Website: https://www.z-anatomy.com. **Licence: CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/)
- **BodyParts3D.** © The Database Center for Life Science (DBCLS), Japan. Z-Anatomy's meshes are
  derived from it. **Licence: CC BY-SA 2.1 Japan** (https://creativecommons.org/licenses/by-sa/2.1/jp/)

Required attribution (from Z-Anatomy's `License.txt`):

> "BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan"
> "Z-Anatomy - The open source atlas of anatomy - CC-BY-SA 4.0"

Z-Anatomy's licence file also says that other models were "included and adapted": "Brainder" and "White
matter" from the University of Washington; "Cranial Nerves and Foramina" from the University of Dundee
(CC BY 4.0); "Anatomy of the Inner Ear" from the University of Dundee (CC BY-NC-SA 4.0); and "Kidney" by
lissiecowley (CC BY-NC 4.0). The file does not say which meshes these are.
- We did not use any inner-ear, cranial-nerve or foramina meshes.
- The `brain` node is built from Z-Anatomy's `Brain.g` hierarchy. It may come partly from the Brainder or
  University of Washington brain models, and the licence file gives no licence for those.
- `kidney_l` and `kidney_r` are Z-Anatomy's `Kidney.l` and `Kidney.r` meshes in the urinary system. Their
  shapes are asymmetric, as in BodyParts3D, which suggests they come from BodyParts3D rather than the
  CC BY-NC kidney. We have not confirmed this.

If the project needs to be strictly free of non-commercial licences, check these two points or drop
those nodes.

## Licence of these files

`body.glb`, `body.meshopt.glb` and `body_anchors.json` are derivative works. They are distributed under
**CC BY-SA 4.0** (ShareAlike), with the attributions above.

## Modifications

The build is `tools/anatomy/build_body.sh` (Blender 4.0 + gltf-transform). It makes these changes:
- **Removed:** label pins and lines, muscle origin/insertion patches, UI cross-section planes and hair.
- **Merged meshes:** the Z-Anatomy structures are merged into 20 named meshes: `skin`, `muscles`,
  `skeleton`, `brain`, `oesophagus`, `stomach`, `duodenum`, `small_intestine`, `large_intestine`,
  `liver`, `gallbladder`, `spleen`, `pancreas`, `kidney_l`, `kidney_r`, `heart`, `lung_l`, `lung_r`,
  `vessels` and `lymph_nodes`.
- **Superficial muscles:** the `muscles` mesh keeps only superficial muscles. They were found by casting
  rays from outside the body. Fasciae, bursae, sheaths and retinacula are excluded.
- **Brain:** voxel-remeshed at 2.5 mm, which gives a single outer surface.
- **Holes filled:** open boundary loops in some organs were closed. These include the stomach's
  anterior-wall hole and the tube ends at the cardia and pylorus.
- **Decimated:** meshes were decimated with quadric collapse, to about 618k triangles in total.
- **Rescaled:** to 1.75 m tall, with the feet at y=0, centred on x/z, Y-up, and the patient facing +Z.
- **Materials:** replaced with plain colours.
- **Compressed:** quantized with KHR_mesh_quantization. The meshopt variant uses EXT_meshopt_compression.
