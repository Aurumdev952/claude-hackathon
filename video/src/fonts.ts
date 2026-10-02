/** Urbanist (variable, latin) from the local fontsource file. While rendering, frames wait for the face to load
 * (delayRender) so every frame uses the real metrics; in the frontend Player it just loads (the app usually has it). */
import { continueRender, delayRender, getRemotionEnvironment } from "remotion";
import urbanistUrl from "@fontsource-variable/urbanist/files/urbanist-latin-wght-normal.woff2";

let started = false;
export function ensureFonts() {
  if (started || typeof document === "undefined" || typeof FontFace === "undefined") return;
  started = true;
  const rendering = getRemotionEnvironment().isRendering;
  const handle = rendering ? delayRender("Loading Urbanist") : null;
  const done = () => { if (handle !== null) continueRender(handle); };
  const face = new FontFace("Urbanist Variable", `url(${urbanistUrl}) format("woff2")`, { weight: "100 900", style: "normal" });
  face.load()
    .then((f) => { document.fonts.add(f); return document.fonts.ready; })
    .then(done)
    .catch(done); // fall back to the system stack rather than failing the render
}
