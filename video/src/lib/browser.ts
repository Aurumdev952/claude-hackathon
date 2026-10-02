/** Locate a local Chromium headless shell (Playwright's) so Remotion never downloads a browser. Node only. */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function browserExecutable(): string | null {
  const env = process.env.REMOTION_BROWSER ?? process.env.BROWSER_EXECUTABLE;
  if (env && existsSync(env)) return env;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(process.env.HOME ?? "", ".cache/ms-playwright")]
    .filter((x): x is string => !!x && existsSync(x));
  for (const root of roots) {
    const dirs = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const d of dirs) {
      for (const rel of ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/headless_shell"]) {
        const p = join(root, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}
