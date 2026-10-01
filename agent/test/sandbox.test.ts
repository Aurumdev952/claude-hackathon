/** Python sandbox: PNG produced, socket / file escape blocked, infinite loop killed, no network under unshare. */
import { describe, expect, it } from "vitest";
import { runPython, sandboxCaps, spawnSandboxed } from "../src/sandbox/runner.js";

const caps = sandboxCaps();
const rows = Array.from({ length: 12 }, (_, i) => ({ year: 2014 + i, asr: 5 + 0.3 * i }));

describe.skipIf(!caps.ready)("run_python sandbox", () => {
  it("renders a matplotlib PNG from df and returns stdout", async () => {
    const r = await runPython({ code: "plt.plot(df.year, df.asr)\nplt.title('ASR')\nprint(len(df), df.asr.max())", columns: ["year", "asr"], rows });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.name)).toEqual(["figure_1.png"]);
    expect(r.files[0]).toMatchObject({ kind: "image", mime: "image/png" });
    expect(r.files[0].bytes).toBeGreaterThan(1000);
    expect(r.stdout.trim()).toBe("12 8.3");
    expect(r.rows_in).toBe(12);
  });

  it("blocks import socket", async () => {
    const r = await runPython({ code: "import socket\nprint('connected')", columns: [], rows: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/socket.*blocked/);
    expect(r.stdout).not.toContain("connected");
  });

  it("blocks reading /etc/passwd and writing outside the run dir", async () => {
    const r1 = await runPython({ code: "print(open('/etc/passwd').read())", columns: [], rows: [] });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/reading \/etc\/passwd is blocked/);
    expect(r1.stdout).not.toContain("root:");
    const r2 = await runPython({ code: "open('/tmp/es-escape.txt', 'w').write('x')", columns: [], rows: [] });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/writing .* is blocked/);
  });

  it("blocks subprocess and os.system", async () => {
    for (const code of ["import subprocess\nsubprocess.run(['id'])", "import os\nos.system('id')"]) {
      const r = await runPython({ code, columns: [], rows: [] });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/blocked/);
    }
  });

  it("kills an infinite loop at the timeout", async () => {
    const t0 = Date.now();
    const r = await runPython({ code: "while True:\n    pass", columns: [], rows: [], timeoutS: 3 });
    expect(r.ok).toBe(false);
    expect(r.timed_out).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it.skipIf(!caps.unshare)("has no network even without the audit hook (unshare -n)", async () => {
    const r = await spawnSandboxed(["/usr/bin/env", "python3", "-c", "import socket; socket.create_connection(('1.1.1.1', 443), 3); print('CONNECTED')"], { cwd: "/tmp", timeoutS: 10 });
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("CONNECTED");
    expect(r.stderr).toMatch(/unreachable|Errno/i);
  });

  it("does not leak API keys or proxy settings into the environment", async () => {
    const r = await spawnSandboxed(["/usr/bin/env"], { cwd: "/tmp", timeoutS: 5 });
    expect(r.stdout).not.toMatch(/OPENROUTER|API_KEY|HTTPS_PROXY|https_proxy/);
  });

  it("writes plotly figures as HTML", async () => {
    const r = await runPython({ code: "fig = px.line(df, x='year', y='asr')", columns: ["year", "asr"], rows });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.kind)).toEqual(["html"]);
  });
});
