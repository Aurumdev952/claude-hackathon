"""One-page daily PDF brief (used by the /daily-report skill and the daily Routine).

    PYTHONPATH=. uv run python scripts/daily_report.py --check                 # live serve DB if present, else snapshot
    PYTHONPATH=. uv run python scripts/daily_report.py --from-snapshot --check # fresh cloud session: committed snapshot only
    PYTHONPATH=. uv run python scripts/daily_report.py --snapshot-only         # refresh reports/snapshots/latest.json, no PDF
    PYTHONPATH=. uv run python scripts/daily_report.py --observations obs.md   # print Claude's bullets in the Highlights strip

Writes reports/daily/<date>.pdf (A4, fixed grid: always exactly one page) and a companion reports/daily/<date>.json used
for day-over-day diffs. Data: reports/snapshots/latest.json (compact, de-identified, committed) or the live serve DuckDB,
plus Claude's validation log reports/risk_validation.jsonl. Patients appear by display_id only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]  # works without PYTHONPATH=.

import report_data as RD  # noqa: E402

# ---------------------------------------------------------------------------------------------- design tokens
# Product design system (frontend/src/styles.css, light theme). Status text uses the darker steps for contrast on white.
INK, MUTED, FAINT = "#0F172A", "#64748B", "#94A3B8"
BORDER, SURFACE2, WHITE = "#E6EAF2", "#F7F8FB", "#FFFFFF"
ACCENT, ACCENT_SOFT, NAVY = "#3F6FE8", "#E8EFFF", "#1E3A8A"
GOOD, WARN, BAD = "#22C55E", "#F59E0B", "#EF4444"
GOOD_TXT, WARN_TXT, BAD_TXT = "#15803D", "#B45309", "#B91C1C"
GOOD_SOFT, WARN_SOFT, BAD_SOFT, NEUTRAL_SOFT = "#DCFCE7", "#FEF3C7", "#FEE2E2", "#F1F5F9"
SERIES = ["#3F6FE8", "#eb6834"]  # categorical slots 1-2 (frontend/src/lib/viz.ts SERIES.light; dataviz validator: PASS)

PAGE_W, PAGE_H = 595.27, 841.89  # A4 in points
M = 28.0                         # page margin
CW = PAGE_W - 2 * M              # content width
GAP = 10.0

FONT_PATHS = [("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
               "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
              ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")]
F, FB = "Helvetica", "Helvetica-Bold"
MPL_FONT = ["Liberation Sans", "Arial", "Helvetica", "DejaVu Sans"]


def _register_fonts():
    global F, FB
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for reg, bold in FONT_PATHS:
        if Path(reg).exists() and Path(bold).exists():
            try:
                pdfmetrics.registerFont(TTFont("Sans", reg))
                pdfmetrics.registerFont(TTFont("Sans-Bold", bold))
                F, FB = "Sans", "Sans-Bold"
                return
            except Exception:
                continue


# ---------------------------------------------------------------------------------------------- data
def load_inputs(args) -> tuple[dict, str]:
    con, cur = (None, None) if args.from_snapshot else RD.connect()
    if args.live and con is None:
        sys.exit("error: --live needs a published serve DB (data/analytics/current.json); run `make dev-data` or use --from-snapshot")
    if con is not None:
        try:
            snap = RD.build_snapshot(con, cur)
        finally:
            con.close()
        RD.write_snapshot(snap)
        return snap, "live"
    snap = RD.load_snapshot()
    if snap is None:
        sys.exit("error: no serve DB and no reports/snapshots/latest.json; run `make dev-data` once and commit the snapshot")
    return snap, "snapshot"


def previous_report(date: dt.date) -> dict | None:
    best = None
    for p in sorted(RD.DAILY_DIR.glob("*.json")):
        try:
            d = dt.date.fromisoformat(p.stem)
        except ValueError:
            continue
        if d < date:
            best = p
    try:
        return json.load(open(best)) if best else None
    except json.JSONDecodeError:
        return None


def read_observations(path: str | None) -> list[str]:
    if not path:
        return []
    out = []
    for line in Path(path).read_text().splitlines():
        line = line.strip().lstrip("-*•").strip()
        if line:
            out.append(line)
    return out[:4]


def _fmt_int(v) -> str:
    return "—" if v is None else f"{int(round(v)):,}"


FEATURE_SHORT = {"days_since_last_gi_visit": "days since last GI visit", "n_gi_visits_6m": "GI visits (6 m)",
                 "n_gi_visits_12m": "GI visits (12 m)", "n_gi_visits_24m": "GI visits (24 m)", "gi_visit_accel": "GI visit acceleration",
                 "hb_min_12m": "lowest Hb (12 m)", "hb_drop_12m": "Hb drop (12 m)", "hb_last": "latest Hb", "hb_slope_12m": "Hb trend",
                 "district_asr_prior": "district rate", "sx_early_satiety": "early satiety", "sx_epigastric": "epigastric pain",
                 "n_alarm_features_12m": "alarm features", "hp_pos_untreated": "untreated H. pylori", "sex_male": "male sex",
                 "n_visits_12m": "clinic visits (12 m)", "weight_change_pct_6m": "weight change (6 m)",
                 "weight_change_pct_12m": "weight change (12 m)", "n_ppi_courses_12m": "PPI courses (12 m)"}


def _pretty_feature(f: str) -> str:
    f = f or ""
    return FEATURE_SHORT.get(f) or f.replace("sx_", "").replace("_", " ").replace(" gi ", " GI ").replace("hb ", "Hb ")


def _delta(cur, prev) -> float | None:
    if cur is None or prev is None:
        return None
    return cur - prev


def build_model(snap: dict, mode: str, date: dt.date, prev: dict | None, obs: list[str]) -> dict:
    """Everything the page shows, in one dict (also the companion JSON)."""
    recs = RD.read_jsonl()
    val = RD.validation_summary(recs)
    latest = RD.latest_verdicts(recs)
    k = dict(snap.get("kpis") or {})
    k["agreement_pct"] = val["agreement_pct"]
    k["validated"] = val["n"]
    pk = (prev or {}).get("kpis") or {}
    deltas = {key: _delta(k.get(key), pk.get(key)) for key in
              ("high_patients", "high_awaiting_endoscopy", "new_high_alerts", "agreement_pct", "national_asr")} if prev else {}
    cases = []
    for c in snap.get("top_cases") or []:
        v = latest.get(c["patient_id"])
        cases.append({**c, "verdict": v.get("verdict") if v else None, "confidence": v.get("confidence") if v else None})
    high = (snap.get("bands") or {}).get("HIGH", 0)
    reviewed_high = sum(1 for c in cases if c["verdict"])
    # deterministic highlights, replaced by Claude's observations when given
    auto = []
    scored = sum((snap.get("bands") or {}).values())
    d = deltas.get("high_patients")
    auto.append(f"{high} patient{'s' if high != 1 else ''} in the HIGH band out of {scored:,} scored"
                + (f" ({d:+.0f} vs previous report)" if d is not None else "")
                + f"; {_fmt_int(k.get('high_awaiting_endoscopy'))} not yet scoped.")
    trig = sorted(snap.get("alerts_by_trigger") or [], key=lambda t: -t["open"])
    if trig:
        auto.append(f"{_fmt_int(k.get('new_high_alerts'))} new HIGH-severity alerts in the last {RD.NEW_ALERT_DAYS} sim days; "
                    f"largest open queue: {trig[0]['label']} ({trig[0]['open']:,}).")
    if val["n"]:
        dis = f"; most disputed reason: {_pretty_feature(val['most_disputed'][0]['feature'])}" if val["most_disputed"] else ""
        auto.append(f"Claude reviewed {reviewed_high} of {high} HIGH cases: {val['agree']} agree, {val['disagree']} disagree, "
                    f"{val['uncertain']} uncertain{dis}.")
    else:
        auto.append("No Claude validations yet: run /validate-risk (or /loop 30m /validate-risk 5) to review the HIGH list.")
    if k.get("national_asr") is not None:
        part = " (partial year)" if k.get("asr_partial_year") else ""
        ref = (f" vs {k['last_full_year_asr']:.1f} in {k['last_full_year']}" if k.get("last_full_year_asr") is not None
               and k.get("last_full_year") != k.get("asr_year") else "")
        auto.append(f"National age-standardised rate {k['national_asr']:.1f} per 100,000 in {k['asr_year']}{part}{ref}.")
    return {"date": date.isoformat(), "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": mode, "run_id": snap.get("run_id"), "sim_time": snap.get("sim_time"),
            "published_at": snap.get("published_at"), "snapshot_generated_at": snap.get("generated_at"),
            "models": snap.get("models"), "risk_model_id": snap.get("risk_model_id"), "kpis": k, "deltas": deltas,
            "previous_report": (prev or {}).get("date"), "bands": snap.get("bands"),
            "cases_by_year": snap.get("cases_by_year") or [], "high_history": snap.get("high_history") or [],
            "alerts_by_trigger": snap.get("alerts_by_trigger") or [], "top_cases": cases, "validation": val,
            "data_quality": snap.get("data_quality") or {}, "highlights": obs or auto,
            "highlights_source": "claude" if obs else "auto"}


# ---------------------------------------------------------------------------------------------- charts
def _mpl():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    names = {f.name for f in font_manager.fontManager.ttflist}
    plt.rcParams.update({"font.family": [n for n in MPL_FONT if n in names] or ["DejaVu Sans"], "font.size": 6.5,
                         "axes.edgecolor": BORDER, "axes.labelcolor": MUTED, "xtick.color": MUTED, "ytick.color": MUTED,
                         "axes.linewidth": 0.6, "xtick.major.width": 0, "ytick.major.width": 0,
                         "xtick.major.pad": 3, "ytick.major.pad": 3, "svg.fonttype": "none"})
    return plt


def _png(fig) -> io.BytesIO:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=300, facecolor=WHITE)
    buf.seek(0)
    return buf


def chart_trend(model: dict, w: float, h: float) -> tuple[io.BytesIO, str, str]:
    """Single-series change over time: HIGH count per scoring date once there are enough points, else cases per year."""
    plt = _mpl()
    hist = model["high_history"]
    fig = plt.figure(figsize=(w / 72, h / 72))
    ax = fig.add_axes([0.085, 0.14, 0.86, 0.80])
    if len(hist) >= 5:
        xs = [dt.date.fromisoformat(x["date"]) for x in hist]
        ys = [x["high"] for x in hist]
        title, sub = "HIGH-risk patients over time", "Patients in the HIGH band at each scoring run"
        ax.plot(xs, ys, color=ACCENT, lw=1.4, solid_capstyle="round", solid_joinstyle="round", zorder=3)
        ax.fill_between(xs, ys, color=ACCENT, alpha=0.10, lw=0, zorder=2)
        ax.scatter([xs[-1]], [ys[-1]], s=22, color=ACCENT, edgecolor=WHITE, linewidth=1.2, zorder=4)
        ax.annotate(f"{ys[-1]:,}", (xs[-1], ys[-1]), xytext=(0, 6), textcoords="offset points", ha="center",
                    fontsize=7, color=INK, fontweight="bold")
        import matplotlib.dates as mdates

        ax.xaxis.set_major_locator(mdates.AutoDateLocator(maxticks=6))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
        ax.set_ylim(0, max(ys) * 1.25 + 1)
    else:
        rows = [r for r in model["cases_by_year"] if r.get("cases_annualised") is not None]
        xs = [r["year"] for r in rows]
        ys = [r["cases_annualised"] for r in rows]
        title = "Gastric cancer cases per year"
        sub = "Confirmed + probable incident cases, national" + (" (current year annualised)" if rows and rows[-1]["partial"] else "")
        full = [i for i, r in enumerate(rows) if not r["partial"]]
        ax.fill_between(xs, ys, color=ACCENT, alpha=0.10, lw=0, zorder=2)
        if full:
            ax.plot([xs[i] for i in full], [ys[i] for i in full], color=ACCENT, lw=1.4, solid_capstyle="round",
                    solid_joinstyle="round", zorder=3)
        if rows and rows[-1]["partial"] and len(rows) > 1:  # the partial year is an estimate: thinner segment, hollow end-dot
            ax.plot(xs[-2:], ys[-2:], color=ACCENT, lw=0.9, alpha=0.7, zorder=3)
            ax.scatter([xs[-1]], [ys[-1]], s=22, facecolor=WHITE, edgecolor=ACCENT, linewidth=1.2, zorder=4)
            lab = f"{ys[-1]:,.0f} est."
        elif rows:
            ax.scatter([xs[-1]], [ys[-1]], s=22, color=ACCENT, edgecolor=WHITE, linewidth=1.2, zorder=4)
            lab = f"{ys[-1]:,.0f}"
        if rows:
            ax.annotate(lab, (xs[-1], ys[-1]), xytext=(-2, 6), textcoords="offset points", ha="right",
                        fontsize=7, color=INK, fontweight="bold")
            imax = max(full, key=lambda i: ys[i]) if full else None
            if imax is not None and imax != len(rows) - 1:
                ax.scatter([xs[imax]], [ys[imax]], s=16, color=ACCENT, edgecolor=WHITE, linewidth=1.0, zorder=4)
                ax.annotate(f"{ys[imax]:,.0f}", (xs[imax], ys[imax]), xytext=(0, 6), textcoords="offset points", ha="center",
                            fontsize=6.5, color=MUTED)
            ax.set_xticks(xs[::2] if len(xs) > 8 else xs)
            ax.set_xticklabels([f"'{str(x)[2:]}" if len(xs) > 8 else str(x) for x in (xs[::2] if len(xs) > 8 else xs)])
            ax.set_xlim(xs[0] - 0.4, xs[-1] + 0.4)
            ax.set_ylim(0, max(ys) * 1.25 + 1)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(BORDER)
    ax.grid(axis="y", color=BORDER, lw=0.5)
    ax.set_axisbelow(True)
    ax.tick_params(labelsize=6.5)
    ax.yaxis.set_major_locator(__import__("matplotlib").ticker.MaxNLocator(4, integer=True))
    ax.yaxis.set_major_formatter(__import__("matplotlib").ticker.StrMethodFormatter("{x:,.0f}"))
    buf = _png(fig)
    plt.close(fig)
    return buf, title, sub


def chart_alerts(model: dict, w: float, h: float) -> tuple[io.BytesIO, str, str]:
    """Open alerts by trigger: horizontal stacked bars, new (last 7 sim days) vs earlier; total at the bar tip."""
    plt = _mpl()
    from matplotlib.patches import FancyBboxPatch, PathPatch
    from matplotlib.path import Path

    trig = model["alerts_by_trigger"]
    labels = [t["label"] for t in trig]
    new = [t["new"] for t in trig]
    old = [t["earlier"] for t in trig]
    tot = [a + b for a, b in zip(new, old)]
    fig = plt.figure(figsize=(w / 72, h / 72))
    ax = fig.add_axes([0.30, 0.06, 0.62, 0.76])
    n = len(trig)
    ys = list(range(n))[::-1]
    xmax = max(tot + [1]) * 1.18
    ax.set_xlim(0, xmax)
    ax.set_ylim(-0.6, n - 0.4)
    fig.canvas.draw()
    bb = ax.get_window_extent()
    px_x = bb.width / xmax                  # display pixels per x unit (at fig.dpi, not the 300 dpi export)
    px_y = bb.height / (n - 0.4 + 0.6)      # display pixels per y unit
    css = fig.dpi / 96                      # one CSS px in display pixels
    bar_h = min(0.56, 24 * css / px_y)      # <= 24 css px thick
    gap = 2 * css / px_x                    # 2 css px surface gap, in x units
    r_px = 4 * css                          # 4 css px rounded data-end

    def seg(x0, x1, y, color, rounded):
        """One bar segment; the data end (right) gets 4 css px rounded corners, the baseline end stays square."""
        if x1 - x0 <= 0:
            return
        y0, y1 = y - bar_h / 2, y + bar_h / 2
        rx = min(r_px / px_x, x1 - x0) if rounded else 0
        ry = min(r_px / px_y, bar_h / 2) if rounded else 0
        verts = [(x0, y0), (x1 - rx, y0), (x1, y0), (x1, y0 + ry), (x1, y1 - ry), (x1, y1), (x1 - rx, y1), (x0, y1), (x0, y0)]
        codes = [Path.MOVETO, Path.LINETO, Path.CURVE3, Path.CURVE3, Path.LINETO, Path.CURVE3, Path.CURVE3, Path.LINETO,
                 Path.CLOSEPOLY]
        ax.add_patch(PathPatch(Path(verts, codes), facecolor=color, lw=0, zorder=3))

    for y, a, b in zip(ys, new, old):
        if a and b:
            seg(0, a - gap / 2, y, SERIES[0], False)
            seg(a + gap / 2, a + b, y, SERIES[1], True)
        elif a:
            seg(0, a, y, SERIES[0], True)
        elif b:
            seg(0, b, y, SERIES[1], True)
    for y, t in zip(ys, tot):
        ax.text(t + xmax * 0.015, y, f"{t:,}", va="center", ha="left", fontsize=7, color=INK, fontweight="bold")
    ax.set_yticks(ys)
    ax.set_yticklabels(labels, fontsize=6.8, color=INK)
    ax.set_xticks([])
    for s in ("top", "right", "bottom"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color(BORDER)
    # legend (two series -> always present), top-left above the bars
    lx = 0.30
    for i, (name, col) in enumerate((("New (7 sim days)", SERIES[0]), ("Earlier", SERIES[1]))):
        fig.patches.append(FancyBboxPatch((lx, 0.905), 0.022, 0.05, boxstyle="round,pad=0,rounding_size=0.006",
                                          transform=fig.transFigure, color=col, lw=0))
        t = fig.text(lx + 0.032, 0.93, name, fontsize=6.5, color=MUTED, va="center")
        fig.canvas.draw()
        lx = t.get_window_extent().x1 / fig.bbox.width + 0.04
    buf = _png(fig)
    plt.close(fig)
    return buf, "Open alerts by trigger", "Doctor alert queue across all facilities, new vs earlier"


# ---------------------------------------------------------------------------------------------- drawing helpers
def _hex(c):
    from reportlab.lib.colors import HexColor

    return HexColor(c)


def _sw(text, font, size):
    from reportlab.pdfbase.pdfmetrics import stringWidth

    return stringWidth(text, font, size)


def fit(text: str, font: str, size: float, width: float) -> str:
    text = text or ""
    if _sw(text, font, size) <= width:
        return text
    while text and _sw(text + "…", font, size) > width:
        text = text[:-1]
    return text.rstrip(" ,;·") + "…"


def wrap(text: str, font: str, size: float, width: float, max_lines: int) -> list[str]:
    words, lines, line = (text or "").split(), [], ""
    for w in words:
        t = f"{line} {w}".strip()
        if _sw(t, font, size) <= width:
            line = t
        else:
            if line:
                lines.append(line)
            line = w
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = fit(lines[-1] + " …", font, size, width) if not lines[-1].endswith("…") else lines[-1]
    return [fit(x, font, size, width) for x in lines]


def card(c, x, y_top, w, h, fill=WHITE, stroke=BORDER, r=12):
    c.setFillColor(_hex(fill))
    if stroke:
        c.setStrokeColor(_hex(stroke))
        c.setLineWidth(0.7)
    c.roundRect(x, y_top - h, w, h, r, stroke=1 if stroke else 0, fill=1)


def text(c, x, y, s, font=None, size=8, color=INK, anchor="left"):
    c.setFillColor(_hex(color))
    c.setFont(font or F, size)
    if anchor == "right":
        c.drawRightString(x, y, s)
    elif anchor == "center":
        c.drawCentredString(x, y, s)
    else:
        c.drawString(x, y, s)


def pill(c, x, y, label, fg, bg, size=6.6, pad=5, h=11.5, dot=None, anchor="left"):
    w = _sw(label, FB, size) + 2 * pad + (7 if dot else 0)
    if anchor == "right":
        x -= w
    c.setFillColor(_hex(bg))
    c.roundRect(x, y, w, h, h / 2, stroke=0, fill=1)
    tx = x + pad
    if dot:
        c.setFillColor(_hex(dot))
        c.circle(tx + 2.2, y + h / 2, 2.2, stroke=0, fill=1)
        tx += 7
    text(c, tx, y + (h - size) / 2 + 1.2, label, FB, size, fg)
    return w


def card_title(c, x, y_top, title, sub=None, pad=12):
    text(c, x + pad, y_top - pad - 8.5, title, FB, 9.5, INK)
    if sub:
        text(c, x + pad, y_top - pad - 19.5, sub, F, 7, MUTED)


# ---------------------------------------------------------------------------------------------- page
def _date_long(d: dt.date) -> str:
    return f"{d.day} {d:%B %Y}"


def _sim_short(s: str | None) -> str:
    if not s:
        return "—"
    d = dt.datetime.fromisoformat(s)
    return f"{d.day} {d:%b %Y}"


def _utc_short(s: str | None) -> str:
    if not s:
        return "—"
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return f"{d.day} {d:%b %Y %H:%M} UTC"
    except ValueError:
        return s


def draw_header(c, model, y):
    d = dt.date.fromisoformat(model["date"])
    # brand mark: accent rounded square with a rising "signal" polyline
    c.setFillColor(_hex(ACCENT))
    c.roundRect(M, y - 34, 34, 34, 9, stroke=0, fill=1)
    c.setStrokeColor(_hex(WHITE))
    c.setLineWidth(2)
    c.setLineCap(1)
    c.setLineJoin(1)
    p = c.beginPath()
    for i, (px, py) in enumerate(((7, 12), (13, 12), (16.5, 22), (21, 9), (24, 16), (27, 16))):
        (p.moveTo if i == 0 else p.lineTo)(M + px, y - 34 + py)
    c.drawPath(p, stroke=1, fill=0)
    x = M + 44
    text(c, x, y - 9, "EARLY SIGNALS  ·  GASTRIC CANCER SURVEILLANCE, RWANDA", FB, 7, ACCENT)
    text(c, x, y - 26, f"Daily risk brief — {_date_long(d)}", FB, 17, INK)
    src = "live serve DB" if model["source"] == "live" else "committed snapshot"
    text(c, x, y - 39, fit(f"Data as of {_sim_short(model['sim_time'])} (simulated)  ·  run #{model['run_id']}  ·  "
                           f"model {model['risk_model_id'] or '—'}  ·  {src}", F, 7.5, CW - 44 - 100), F, 7.5, MUTED)
    pill(c, PAGE_W - M, y - 14, "Synthetic data", WARN_TXT, WARN_SOFT, size=7, h=13, dot=WARN, anchor="right")
    text(c, PAGE_W - M, y - 26, "Not for clinical use", F, 7, MUTED, anchor="right")
    c.setStrokeColor(_hex(BORDER))
    c.setLineWidth(0.7)
    c.line(M, y - 50, PAGE_W - M, y - 50)
    return y - 50


def _delta_text(v, unit="", good_when_down=None, pct=False, prev_date=None):
    if v is None:
        return None, MUTED
    if abs(v) < 1e-9:
        return f"no change vs {prev_date}", MUTED
    s = f"{v:+.1f}{unit}" if pct or isinstance(v, float) and not float(v).is_integer() else f"{v:+.0f}{unit}"
    col = MUTED
    if good_when_down is not None:
        col = (GOOD_TXT if v < 0 else BAD_TXT) if good_when_down else (GOOD_TXT if v > 0 else BAD_TXT)
    return f"{s} vs {prev_date}", col


def draw_kpis(c, model, y_top, h=78):
    k, dl = model["kpis"], model["deltas"]
    prev = model["previous_report"]
    prev_s = _sim_short(prev + "T00:00:00") if prev else None
    val = model["validation"]
    bands = model["bands"] or {}
    scored = sum(bands.values())
    asr = k.get("national_asr")
    tiles = [
        ("HIGH-risk patients", _fmt_int(k.get("high_patients")), f"of {scored:,} scored in the GI cohort",
         _delta_text(dl.get("high_patients"), prev_date=prev_s), None),
        ("Awaiting endoscopy", _fmt_int(k.get("high_awaiting_endoscopy")), "HIGH band, not scoped since flag",
         _delta_text(dl.get("high_awaiting_endoscopy"), good_when_down=True, prev_date=prev_s),
         (WARN, "Action") if (k.get("high_awaiting_endoscopy") or 0) > 0 else (GOOD, "Clear")),
        ("New HIGH alerts", _fmt_int(k.get("new_high_alerts")), f"last {RD.NEW_ALERT_DAYS} sim days · {k.get('open_alerts', 0):,} open in total",
         _delta_text(dl.get("new_high_alerts"), prev_date=prev_s), None),
        ("Claude agreement", "—" if val["agreement_pct"] is None else f"{val['agreement_pct']:.0f}%",
         f"{val['n']} case{'s' if val['n'] != 1 else ''} reviewed · {val['disagree']} disputed" if val["n"] else "no validations yet",
         _delta_text(dl.get("agreement_pct"), unit=" pts", good_when_down=False, pct=True, prev_date=prev_s), None),
        (f"National ASR {k.get('asr_year') or ''}".strip(), "—" if asr is None else f"{asr:.1f}",
         "per 100,000" + (" · partial year" if k.get("asr_partial_year") else "")
         + (f" · {k['last_full_year']}: {k['last_full_year_asr']:.1f}" if k.get("last_full_year_asr") is not None
            and k.get("last_full_year") != k.get("asr_year") else ""),
         (None, MUTED), None),
    ]
    n = len(tiles)
    w = (CW - (n - 1) * 8) / n
    for i, (label, value, sub, (dtxt, dcol), status) in enumerate(tiles):
        x = M + i * (w + 8)
        card(c, x, y_top, w, h, fill=WHITE, r=12)
        text(c, x + 10, y_top - 17, fit(label, F, 7.6, w - 20), F, 7.6, MUTED)
        if status:
            pill(c, x + w - 10, y_top - 40, status[1], WARN_TXT if status[0] == WARN else GOOD_TXT,
                 WARN_SOFT if status[0] == WARN else GOOD_SOFT, size=5.8, h=10, pad=4, anchor="right")
        text(c, x + 10, y_top - 41, value, FB, 20, INK)
        lines = wrap(sub, F, 6.4, w - 20, 2)
        yy = y_top - 53
        for ln in lines:
            text(c, x + 10, yy, ln, F, 6.4, MUTED)
            yy -= 8.2
        if dtxt:
            text(c, x + 10, yy, fit(dtxt, FB, 6.4, w - 20), FB, 6.4, dcol)
    return y_top - h


def draw_charts(c, model, y_top, h=172):
    from reportlab.lib.utils import ImageReader

    w = (CW - GAP) / 2
    for i, fn in enumerate((chart_trend, chart_alerts)):
        x = M + i * (w + GAP)
        card(c, x, y_top, w, h, r=14)
        iw, ih = w - 20, h - 46
        buf, title, sub = fn(model, iw, ih)
        card_title(c, x, y_top, title, sub)
        c.drawImage(ImageReader(buf), x + 10, y_top - h + 8, iw, ih)
    return y_top - h


def draw_highlights(c, model, y_top, h=68):
    card(c, M, y_top, CW, h, fill=ACCENT_SOFT, stroke=None, r=14)
    src = "Claude's observations" if model["highlights_source"] == "claude" else "What the numbers say"
    text(c, M + 12, y_top - 19, "Highlights", FB, 9.5, NAVY)
    text(c, M + 12, y_top - 30, src, F, 6.8, MUTED)
    items = model["highlights"][:4]
    col_x = M + 100
    col_w = (CW - 100 - 12 - 12) / 2
    wrapped = [wrap(s_, F, 7.2, col_w - 10, 3) for s_ in items]
    row1 = max((len(w) for w in wrapped[:2]), default=1)
    row2 = max((len(w) for w in wrapped[2:]), default=0)
    lead = 8.8
    content = (row1 + row2) * lead + (6 if row2 else 0)
    top = max(16.0, (h - content) / 2 + 6.5)   # centre the bullets vertically in the strip
    for i, lines in enumerate(wrapped):
        cx = col_x + (i % 2) * (col_w + 12)
        cy = y_top - top - (i // 2) * (row1 * lead + 6)
        c.setFillColor(_hex(ACCENT))
        c.circle(cx + 2, cy + 2.4, 1.8, stroke=0, fill=1)
        for j, ln in enumerate(lines):
            text(c, cx + 9, cy - j * lead, ln, F, 7.2, INK)
    return y_top - h


VERDICT_STYLE = {"agree": ("Agree", GOOD_TXT, GOOD_SOFT, GOOD), "disagree": ("Disagree", BAD_TXT, BAD_SOFT, BAD),
                 "uncertain": ("Uncertain", WARN_TXT, WARN_SOFT, WARN), None: ("Pending", MUTED, NEUTRAL_SOFT, FAINT)}


def draw_table(c, model, y_top, h=272):
    card(c, M, y_top, CW, h, r=14)
    cases = model["top_cases"][:10]
    high = (model["bands"] or {}).get("HIGH", 0)
    n_high = sum(1 for r in cases if r.get("risk_band") == "HIGH")
    card_title(c, M, y_top, "Top high-risk patients",
               "HIGH band, not yet diagnosed · newest flag first, then probability · patients shown by display ID only")
    if 0 < n_high < len(cases):
        pill(c, M + CW - 12, y_top - 23, f"{high} HIGH · next {len(cases) - n_high} MEDIUM shown", MUTED, NEUTRAL_SOFT,
             size=6.2, h=11, pad=5, anchor="right")
    pad = 12
    # (header, width, align, left inset); width 0 = takes the remaining space
    cols = [("#", 14, "left"), ("Patient", 64, "left"), ("Facility", 92, "left"), ("Age/sex", 36, "left"),
            ("Prob.", 32, "right"), ("T1 pts", 30, "right"), ("Top reasons", 0, "left"), ("Scope", 46, "left"),
            ("Claude", 58, "left")]
    inner = CW - 2 * pad
    fixed = sum(w for _, w, _ in cols)
    cols = [(n, w or inner - fixed, a) for n, w, a in cols]
    x0 = M + pad
    xs, x = [], x0
    for _, w, _ in cols:
        xs.append(x)
        x += w
    reason_x = xs[6] + 12
    hy = y_top - 46
    c.setFillColor(_hex(SURFACE2))
    c.roundRect(x0 - 4, hy - 5, inner + 8, 15, 5, stroke=0, fill=1)
    for j, (name, w, a) in enumerate(cols):
        hx = reason_x if j == 6 else (xs[j] + w if a == "right" else xs[j])
        text(c, hx, hy, name, FB, 6.8, MUTED, anchor="right" if a == "right" else "left")
    rh = 19.5
    ry = hy - 8
    for i, r in enumerate(cases):
        if i == n_high and 0 < n_high:  # separator before the MEDIUM top-up rows
            ry -= 13
            c.setStrokeColor(_hex(BORDER))
            c.setLineWidth(0.5)
            c.line(x0, ry + 13, x0 + inner, ry + 13)
            text(c, x0, ry + 3.5, "Next highest probability (MEDIUM band, not in the HIGH alert list)", FB, 6.4, MUTED)
        ry -= rh
        if i and i != n_high:
            c.setStrokeColor(_hex(BORDER))
            c.setLineWidth(0.5)
            c.line(x0, ry + rh, x0 + inner, ry + rh)
        is_high = r.get("risk_band") == "HIGH"
        mid = ry + rh / 2 - 2.4
        vals = [str(i + 1), r["patient_id"], r.get("facility") or "—",
                f"{r.get('age', '—')} {r.get('sex') or ''}".strip(),
                f"{100 * r['ensemble_prob']:.1f}%" if r.get("ensemble_prob") is not None else "—",
                str(r.get("t1_score")) if r.get("t1_score") is not None else "—"]
        for j, v in enumerate(vals):
            name, w, a = cols[j]
            font = FB if j in (1, 4) and is_high else F
            col = MUTED if j == 0 else INK
            if a == "right":
                text(c, xs[j] + w, mid, v, font, 7.2, col, anchor="right")
            else:
                text(c, xs[j], mid, fit(v, font, 7.2, w - 4), font, 7.2, col)
        rs = [t.get("label") or _pretty_feature(t.get("feature")) for t in (r.get("top_reasons") or [])[:2]]
        rw = xs[7] - reason_x - 6
        for j, s_ in enumerate(rs):
            text(c, reason_x, ry + rh / 2 + 1.8 - j * 8.0, fit(s_, F, 6.5, rw), F, 6.5, INK if j == 0 else MUTED)
        if r.get("scoped") is None:
            text(c, xs[7], mid, "—", F, 7.2, FAINT)
        else:
            scoped = bool(r.get("scoped"))
            pill(c, xs[7], ry + rh / 2 - 5, "Scoped" if scoped else "Awaiting", GOOD_TXT if scoped else WARN_TXT,
                 GOOD_SOFT if scoped else WARN_SOFT, size=6, h=10, pad=4)
        if is_high or r.get("verdict"):
            lab, fg, bg, dot = VERDICT_STYLE.get(r.get("verdict"), VERDICT_STYLE[None])
            if r.get("verdict") and r.get("confidence") is not None:
                lab = f"{lab} {100 * r['confidence']:.0f}%"
            pill(c, xs[8], ry + rh / 2 - 5, lab, fg, bg, size=6, h=10, pad=4, dot=dot)
        else:
            text(c, xs[8], mid, "—", F, 7.2, FAINT)
    if not cases:
        text(c, x0, hy - 24, "No patients are scored in this run.", F, 7.2, MUTED)
    return y_top - h


def draw_footer(c, model, y_top, h=76):
    card(c, M, y_top, CW, h, fill=SURFACE2, stroke=None, r=14)
    val, dq = model["validation"], model["data_quality"] or {}
    colw = (CW - 24 - 2 * 16) / 3
    if val["n"]:
        dis = ", ".join(_pretty_feature(d["feature"]) for d in val["most_disputed"][:2]) or "none"
        vtxt = (f"{val['n']} case{'s' if val['n'] != 1 else ''} reviewed: {val['agree']} agree, {val['disagree']} disagree, "
                f"{val['uncertain']} uncertain. Mean confidence {val['mean_confidence']:.2f}. Most disputed reasons: {dis}. "
                f"Last review {_utc_short(val['last_run_at'])}.")
    else:
        vtxt = "No reviews yet. Run /validate-risk (or /loop 30m /validate-risk 5) in Claude Code to review the HIGH list."
    if dq:
        raw = dq.get("raw_checks_failing") or []
        dtxt = (f"{dq.get('checks_ok', 0)} checks OK, {dq.get('checks_warn', 0)} warnings, {dq.get('checks_low', 0)} below target. "
                f"Feed freshness {dq.get('freshness_days', '—')} days"
                + ("" if not raw else f"; failing: {', '.join(raw)}") + ". "
                f"H. pylori tested {dq.get('hp_tested_pct', '—')}% (target 30), smoking recorded "
                f"{dq.get('completeness_smoking_pct', '—')}% (target 50).")
    else:
        dtxt = "No data-quality marts in this snapshot."
    models = ", ".join(v for _, v in sorted((model.get("models") or {}).items())) or "—"
    ptxt = (f"Pipeline run #{model['run_id']} published {_utc_short(model.get('published_at'))}. Models: {models}. "
            f"Built {_utc_short(model['generated_at'])} by scripts/daily_report.py from the "
            f"{'live serve database' if model['source'] == 'live' else 'committed snapshot (reports/snapshots/latest.json)'}.")
    for i, (title, body) in enumerate((("Claude validation", vtxt), ("Data quality", dtxt), ("Provenance", ptxt))):
        x = M + 12 + i * (colw + 16)
        if i:
            c.setStrokeColor(_hex(BORDER))
            c.setLineWidth(0.7)
            c.line(x - 8, y_top - 12, x - 8, y_top - h + 12)
        text(c, x, y_top - 19, title, FB, 8, INK)
        for j, ln in enumerate(wrap(body, F, 6.6, colw, 5)):
            text(c, x, y_top - 31 - j * 8.6, ln, F, 6.6, MUTED)
    return y_top - h


def render(model: dict, out: Path) -> Path:
    from reportlab.pdfgen import canvas

    _register_fonts()
    out.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(out), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle(f"Early Signals daily risk brief {model['date']}")
    c.setAuthor("Early Signals (synthetic data)")
    c.setSubject("Gastric cancer early-warning: HIGH-risk patients, alerts, Claude validation")
    c.setFillColor(_hex(WHITE))
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    y = PAGE_H - M
    y = draw_header(c, model, y) - 12
    y = draw_kpis(c, model, y) - GAP
    y = draw_charts(c, model, y) - GAP
    y = draw_highlights(c, model, y) - GAP
    y = draw_table(c, model, y) - GAP
    y = draw_footer(c, model, y)
    assert y >= M + 4, f"layout overflow: {y:.1f}"
    text(c, M, M - 6, "Synthetic data generated for the Early Signals demo. Patients appear by display ID only. Not for clinical use.",
         F, 6.3, FAINT)
    text(c, PAGE_W - M, M - 6, "Page 1 of 1", F, 6.3, FAINT, anchor="right")
    c.showPage()
    c.save()
    return out


def check_pdf(path: Path) -> int:
    from pypdf import PdfReader

    n = len(PdfReader(str(path)).pages)
    if n != 1:
        print(f"CHECK FAILED: {path} has {n} pages (expected exactly 1)", file=sys.stderr)
        return 1
    print(f"check ok: {path.relative_to(RD.ROOT) if path.is_relative_to(RD.ROOT) else path} is exactly 1 page")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", type=dt.date.fromisoformat, default=dt.date.today(), help="report date (YYYY-MM-DD), default today")
    ap.add_argument("--out", type=Path, help="PDF path (default reports/daily/<date>.pdf); the companion .json sits next to it")
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--live", action="store_true", help="read the serve DuckDB (default when data/analytics/current.json exists)")
    src.add_argument("--from-snapshot", action="store_true", help="render from reports/snapshots/latest.json only")
    ap.add_argument("--snapshot-only", action="store_true", help="refresh reports/snapshots/latest.json from the serve DB; no PDF")
    ap.add_argument("--observations", help="text/markdown file with up to 4 bullet observations for the Highlights strip")
    ap.add_argument("--check", action="store_true", help="assert the PDF is exactly one page (exit 1 otherwise)")
    args = ap.parse_args(argv)
    if args.snapshot_only:
        if args.from_snapshot:
            sys.exit("error: --snapshot-only reads the serve DB; it cannot be combined with --from-snapshot")
        p = RD.refresh_snapshot()
        if p is None:
            sys.exit("error: no published serve DB to snapshot (data/analytics/current.json)")
        print(f"snapshot: {p.relative_to(RD.ROOT)}")
        return 0
    snap, mode = load_inputs(args)
    out = args.out or (RD.DAILY_DIR / f"{args.date.isoformat()}.pdf")
    model = build_model(snap, mode, args.date, previous_report(args.date), read_observations(args.observations))
    render(model, out)
    out.with_suffix(".json").write_text(json.dumps(model, indent=1, default=str) + "\n")
    rel = lambda p: p.relative_to(RD.ROOT) if p.is_relative_to(RD.ROOT) else p  # noqa: E731
    print(f"report: {rel(out)}  ({mode})\ncompanion: {rel(out.with_suffix('.json'))}")
    k = model["kpis"]
    print(f"kpis: HIGH={k.get('high_patients')} awaiting_endoscopy={k.get('high_awaiting_endoscopy')} "
          f"new_high_alerts={k.get('new_high_alerts')} agreement={model['validation']['agreement_pct']}% "
          f"national_asr={k.get('national_asr') and round(k['national_asr'], 1)}")
    return check_pdf(out) if args.check else 0


if __name__ == "__main__":
    sys.exit(main())
