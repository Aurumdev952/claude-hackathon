// Verify body.glb: node names, triangle counts, bounds, file size, required nodes present.
// Usage: node verify_body.mjs ../../frontend/public/models/body.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { statSync } from 'node:fs';

const REQUIRED = ['skin', 'muscles', 'skeleton', 'oesophagus', 'stomach', 'duodenum', 'small_intestine',
  'large_intestine', 'liver', 'gallbladder', 'spleen', 'pancreas', 'kidney_l', 'kidney_r', 'heart',
  'lung_l', 'lung_r'];
const OPTIONAL = ['brain', 'vessels', 'lymph_nodes'];

const file = process.argv[2] ?? '../../frontend/public/models/body.glb';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(file);
const root = doc.getRoot();
console.log(`file: ${file}  size: ${(statSync(file).size / 1048576).toFixed(2)} MB`);
console.log(`extensions used: ${root.listExtensionsUsed().map((e) => e.extensionName).join(', ') || 'none'}`);

let total = 0;
const names = new Set();
const gmin = [Infinity, Infinity, Infinity], gmax = [-Infinity, -Infinity, -Infinity];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  names.add(node.getName());
  let tris = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    const pos = prim.getAttribute('POSITION');
    tris += (idx ? idx.getCount() : pos.getCount()) / 3;
    const hasNormals = !!prim.getAttribute('NORMAL');
    if (!hasNormals) console.warn(`  !! ${node.getName()} has no NORMAL`);
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      const w = [0, 1, 2].map((r) => M[r] * v[0] + M[4 + r] * v[1] + M[8 + r] * v[2] + M[12 + r]);
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); }
    }
  }
  for (let k = 0; k < 3; k++) { gmin[k] = Math.min(gmin[k], mn[k]); gmax[k] = Math.max(gmax[k], mx[k]); }
  total += tris;
  const f = (a) => a.map((x) => x.toFixed(3)).join(',');
  console.log(`${node.getName().padEnd(16)} ${String(tris).padStart(7)} tris   min[${f(mn)}] max[${f(mx)}]`);
}
console.log(`TOTAL ${total} tris; scene bounds min[${gmin.map((x) => x.toFixed(3))}] max[${gmax.map((x) => x.toFixed(3))}]`);
const missing = REQUIRED.filter((n) => !names.has(n));
const missingOpt = OPTIONAL.filter((n) => !names.has(n));
if (missingOpt.length) console.log(`optional nodes missing: ${missingOpt.join(', ')}`);
if (missing.length) { console.error(`REQUIRED nodes missing: ${missing.join(', ')}`); process.exit(1); }
console.log('OK: all required nodes present');
