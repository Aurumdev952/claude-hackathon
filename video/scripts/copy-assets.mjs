// Copy the 3D body model from the frontend into video/public (Remotion staticFile) without committing a duplicate.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "frontend", "public", "models", "body.meshopt.glb");
const dst = join(here, "..", "public", "models", "body.meshopt.glb");
if (!existsSync(src)) {
  console.warn(`[video] ${src} not found: the 3D intro will fall back to the 2D body`);
} else if (!existsSync(dst) || statSync(dst).size !== statSync(src).size || statSync(dst).mtimeMs < statSync(src).mtimeMs) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`[video] copied body model -> ${dst}`);
}
