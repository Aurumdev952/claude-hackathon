"""run_python sandbox prelude (executed by agent/src/sandbox/runner.ts).

    python -I -B prelude.py <run_dir>

<run_dir> holds script.py (model-written code), data.json ({"columns": [...], "rows": [...]}) and out/ for artifacts.
Layers of isolation (the runner adds the OS ones: `unshare -n` = no network namespace, prlimit memory/CPU, timeout -s KILL,
scrubbed environment):

1. heavy libraries are imported and warmed up first, then network modules are dropped from sys.modules;
2. a PEP 578 audit hook blocks sockets, subprocesses, fork/exec, ctypes, network-module imports, file writes outside the run
   directory and file reads outside the run directory + the Python installation;
3. the script runs with `df` (pandas DataFrame of the guarded query result), `pd`, `np`, `plt`, `px`, `go` and `OUT_DIR`.
Open matplotlib figures are saved to out/figure_<n>.png and plotly figures found in the namespace to out/plotly_<n>.html.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import traceback

RUN_DIR = os.path.realpath(sys.argv[1])
OUT_DIR = os.path.join(RUN_DIR, "out")
os.makedirs(OUT_DIR, exist_ok=True)
os.chdir(RUN_DIR)
os.environ.setdefault("MPLCONFIGDIR", os.path.join(RUN_DIR, ".mpl"))

# ------------------------------------------------------------------------------------------- 1. warm imports
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

try:
    import plotly.express as px  # noqa: E402
    import plotly.graph_objects as go  # noqa: E402
    import plotly.io as pio  # noqa: E402
except Exception:  # plotly is optional
    px = go = pio = None
try:
    import scipy.stats  # noqa: F401,E402
except Exception:
    pass

# warm the font cache and the PNG writer while file access is unrestricted
_f = plt.figure()
plt.plot([0, 1], [0, 1])
_f.savefig(io.BytesIO(), format="png")
plt.close("all")
if pio is not None:
    try:
        pio.to_html(go.Figure(), include_plotlyjs="cdn", full_html=True)
    except Exception:
        pass

with open(os.path.join(RUN_DIR, "data.json")) as fh:
    payload = json.load(fh)
df = pd.DataFrame(payload.get("rows") or [], columns=payload.get("columns") or None)
for c in df.columns:
    if df[c].dtype == object and (c in ("ts", "date", "as_of", "created_at") or c.endswith(("_date", "_at", "_ts"))):
        try:
            df[c] = pd.to_datetime(df[c])
        except Exception:
            pass
with open(os.path.join(RUN_DIR, "script.py")) as fh:
    SOURCE = fh.read()

# ------------------------------------------------------------------------------------------- 2. audit hook
NET_MODULES = ("socket", "_socket", "ssl", "_ssl", "select", "selectors", "asyncio", "urllib.request", "http.client",
               "http.server", "ftplib", "smtplib", "poplib", "imaplib", "telnetlib", "xmlrpc.client", "socketserver",
               "requests", "httpx", "urllib3", "aiohttp", "websocket", "websockets", "paramiko", "subprocess", "multiprocessing",
               "ctypes", "_ctypes", "cffi", "pty", "webbrowser")
for _m in list(sys.modules):
    if _m in NET_MODULES or _m.split(".")[0] in ("socket", "ssl", "requests", "httpx", "urllib3", "ctypes"):
        sys.modules.pop(_m, None)

_READ_ROOTS = tuple({os.path.realpath(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, os.path.dirname(os.__file__),
                                                     os.path.dirname(np.__file__), os.path.dirname(pd.__file__),
                                                     os.path.dirname(matplotlib.__file__))} | {RUN_DIR})
_DEV_OK = {"/dev/null", "/dev/urandom", "/dev/random"}
_BLOCK_PREFIXES = ("socket.", "subprocess.", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty",
                   "os.kill", "os.killpg", "ctypes.", "pty.", "webbrowser.", "urllib.Request", "http.client.", "ftplib.",
                   "smtplib.", "poplib.", "imaplib.", "nntplib.", "telnetlib.", "signal.pthread_kill", "sys.remote_exec",
                   "os.putenv", "os.unsetenv", "winreg.", "msvcrt.", "shutil.chown", "os.chroot", "resource.setrlimit")


class SandboxViolation(PermissionError):
    pass


def _inside(path: str, roots) -> bool:
    try:
        p = os.path.realpath(path)
    except Exception:
        return False
    return any(p == r or p.startswith(r + os.sep) for r in roots)


def _hook(event: str, args: tuple):
    if event == "import":
        name = str(args[0]) if args else ""
        if name in NET_MODULES or name.split(".")[0] in ("socket", "ssl", "requests", "httpx", "urllib3", "aiohttp", "ctypes",
                                                          "subprocess", "multiprocessing", "asyncio", "cffi", "pty"):
            raise SandboxViolation(f"import of '{name}' is blocked in the sandbox")
        return
    if event.startswith(_BLOCK_PREFIXES):
        raise SandboxViolation(f"{event} is blocked in the sandbox (no network, processes or native calls)")
    if event == "open":
        path, mode = args[0], args[1] if len(args) > 1 else "r"
        if isinstance(path, int) or path is None:
            return
        path = os.fsdecode(path)
        writing = isinstance(mode, str) and any(c in mode for c in "wax+")
        if isinstance(mode, int):  # os.open flags
            writing = bool(mode & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC))
        if writing:
            if not _inside(path, (RUN_DIR,)):
                raise SandboxViolation(f"writing {path} is blocked: write files to OUT_DIR")
        elif path not in _DEV_OK and not _inside(path, _READ_ROOTS):
            raise SandboxViolation(f"reading {path} is blocked: only the provided data is available")
        return
    if event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.symlink", "os.link", "os.chmod", "os.chown",
                 "os.truncate", "os.utime", "shutil.rmtree", "shutil.move", "shutil.copyfile", "shutil.copytree"):
        for a in args[:2]:
            if isinstance(a, (str, bytes, os.PathLike)) and not _inside(os.fsdecode(a), (RUN_DIR,)):
                raise SandboxViolation(f"{event} outside the run directory is blocked")
        return
    if event in ("os.listdir", "os.scandir", "glob.glob", "os.chdir"):
        a = args[0] if args else "."
        if isinstance(a, (str, bytes, os.PathLike)) and not _inside(os.fsdecode(a) or ".", _READ_ROOTS):
            raise SandboxViolation(f"{event} outside the sandbox is blocked")


sys.addaudithook(_hook)

# ------------------------------------------------------------------------------------------- 3. run the script
ns = {"__name__": "__main__", "df": df, "pd": pd, "np": np, "plt": plt, "px": px, "go": go, "OUT_DIR": OUT_DIR}
result = {"ok": True, "error": None, "files": []}
t0 = time.time()
try:
    exec(compile(SOURCE, "analysis.py", "exec"), ns)
except BaseException as e:  # noqa: BLE001 - report everything, including SystemExit
    if isinstance(e, SystemExit) and not e.code:
        pass
    else:
        result["ok"] = False
        tb = traceback.format_exception(type(e), e, e.__traceback__)
        tb = [x for x in tb if "prelude.py" not in x]
        result["error"] = f"{type(e).__name__}: {e}"
        sys.stderr.write("".join(tb[-6:]))

# save figures even after an error (partial output helps the model repair)
try:
    for n, num in enumerate(plt.get_fignums(), 1):
        fig = plt.figure(num)
        if not fig.axes:
            continue
        fig.savefig(os.path.join(OUT_DIR, f"figure_{n}.png"), dpi=144, bbox_inches="tight")
    plt.close("all")
    if go is not None:
        k = 0
        for name, v in list(ns.items()):
            if isinstance(v, go.Figure) and not name.startswith("_"):
                k += 1
                v.write_html(os.path.join(OUT_DIR, f"plotly_{k}.html"), include_plotlyjs="cdn", full_html=True)
except Exception as e:  # noqa: BLE001
    result["ok"] = False
    result["error"] = result["error"] or f"saving figures failed: {e}"
result["files"] = sorted(f for f in os.listdir(OUT_DIR) if not f.startswith("."))
result["seconds"] = round(time.time() - t0, 3)
with open(os.path.join(RUN_DIR, "result.json"), "w") as fh:
    json.dump(result, fh)
sys.stdout.flush()
os._exit(0 if result["ok"] else 1)
