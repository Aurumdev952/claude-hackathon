"""Small-cell suppression for ministry aggregates (n < 5 -> null + "<5"), with complementary suppression.

Primary suppression alone leaks: a total minus the visible cells gives back the hidden one (approved 8, district A 5
shown, district B 3 hidden -> 8 - 5 = 3), a rate times its shown denominator gives back a hidden numerator, and
n - adhered gives back a hidden complement. `suppress_group` therefore:

1. hides every count 1-4 (primary);
2. hides a part when its complement within the row (whole - part) is 1-4 (`pairs`), and hides every count of a row
   whose `base` count is hidden;
3. per count column across the rows of one breakdown (`group=True`): when exactly one cell is hidden, also hides the
   next-smallest positive cell, so the hidden cells cannot be recovered from the column total. When no other positive
   cell exists, the column total is hidden instead (`totals`);
4. repeats 2-3 until nothing changes, then nulls every derived value (`derived`: rate, median, percentage, survival)
   whose source counts include a hidden or small one.

Zeros are not hidden (a true zero discloses nothing about a person), except in a row whose base count is hidden, where
the whole row is. A hidden count gets `<field>_label`: "<5" when it is small, "suppressed" when it is 5+ and hidden only
to protect a small one (complementary).
"""
from __future__ import annotations

SMALL = 5


def small(v) -> bool:
    return v is not None and not isinstance(v, bool) and 0 < v < SMALL


def suppress_group(rows: list[dict], fields: tuple[str, ...], *, base: str | None = None,
                   pairs: tuple[tuple[str, str], ...] = (), derived: dict[str, tuple[str, ...]] | None = None,
                   group: bool = True, totals: dict | None = None,
                   hidden_totals: set[str] | frozenset = frozenset()) -> tuple[list[dict], dict]:
    """Returns (rows, totals) with suppressed values set to None. `pairs` are (part, whole) with part <= whole in each
    row; `derived` maps a derived field to the counts it is computed from (they may include count fields that are not
    in `fields`, e.g. helper counts that are dropped afterwards). `totals` are the column totals shown next to the
    rows ({field: value}); they are suppressed too (primary + when a lone hidden cell cannot be paired)."""
    out = [dict(r) for r in rows]
    hidden: set[tuple[int, str]] = {(i, f) for i, r in enumerate(out) for f in fields if small(r.get(f))}
    tot = dict(totals or {})
    tot_hidden = {f for f in fields if small(tot.get(f))} | {f for f in hidden_totals if tot.get(f)}
    changed = True
    while changed:
        changed = False

        def hide(i, f, force=False):
            nonlocal changed
            v = out[i].get(f)
            if (i, f) not in hidden and (v or (force and v is not None)):  # zeros only with the whole row (base)
                hidden.add((i, f))
                changed = True

        for i, r in enumerate(out):
            if base and (i, base) in hidden:
                for f in fields:
                    hide(i, f, force=True)
            for part, whole in pairs:
                p, w = r.get(part), r.get(whole)
                if p is None or w is None:
                    continue
                if (i, whole) in hidden or small(w - p):
                    hide(i, part)
                if (i, part) in hidden and w == p:
                    hide(i, whole)  # whole == part: showing the whole would show the hidden part
        if group and len(out) > 1:
            for f in fields:
                col = [i for i in range(len(out)) if (i, f) in hidden]
                if len(col) != 1 or f in tot_hidden:
                    continue
                cand = sorted((out[i].get(f), i) for i in range(len(out))
                              if (i, f) not in hidden and out[i].get(f))
                if cand:
                    hide(cand[0][1], f)
                elif f in tot:
                    tot_hidden.add(f)
                    changed = True
        elif group and len(out) == 1 and totals:
            for f in fields:
                if (0, f) in hidden and f in tot and f not in tot_hidden and tot.get(f):
                    tot_hidden.add(f)
                    changed = True
        if group:
            # a hidden total must not be recoverable as the sum of fully visible cells
            for f in tot_hidden:
                if not any((i, f) in hidden for i in range(len(out))):
                    cand = sorted((out[i].get(f), i) for i in range(len(out)) if out[i].get(f))
                    if cand:
                        hide(cand[0][1], f)
    for i, f in hidden:
        out[i][f"{f}_label"] = label(out[i][f])
        out[i][f] = None
    for i, r in enumerate(out):
        for d, src in (derived or {}).items():
            if any((i, s) in hidden or small(rows[i].get(s)) for s in src):
                r[d] = None
    for f in tot_hidden:
        tot[f"{f}_label"] = label(tot.get(f))
        tot[f] = None
    return out, tot


def label(v) -> str:
    """"<5" for a small cell; "suppressed" for a cell of 5+ hidden only so that a small one cannot be recovered."""
    return "suppressed" if v is not None and not isinstance(v, bool) and v >= SMALL else "<5"


def suppress_breakdowns(totals: dict, breakdowns: list[list[dict]], fields: tuple[str, ...], *,
                        pairs: tuple[tuple[str, str], ...] = ()) -> tuple[dict, list[list[dict]]]:
    """Several breakdowns (by district, by pathway, ...) of the same column totals: suppressed jointly until stable, so
    no total or cell can be recovered from another breakdown. Returns (totals, [rows per breakdown])."""
    t_rows, _ = suppress_group([totals], fields, pairs=pairs, group=False)
    hid = {f for f in fields if t_rows[0].get(f) is None and totals.get(f)}
    while True:
        outs, before = [], set(hid)
        for rows in breakdowns:
            r, t = suppress_group(rows, fields, pairs=pairs, totals=totals, hidden_totals=hid)
            hid |= {f for f in fields if t.get(f) is None and totals.get(f)}
            outs.append(r)
        if hid == before:
            break
    tot = dict(totals)
    for f in hid:
        tot[f"{f}_label"] = label(tot.get(f))
        tot[f] = None
    return tot, outs


def suppress_row(row: dict, fields: tuple[str, ...], derived: tuple[str, ...] = ()) -> dict:
    """Single-row form (no group): every count 1-4 hidden; when the base count (first field) is hidden, the whole row
    is; derived values are nulled whenever any count of the row is hidden."""
    rows, _ = suppress_group([row], fields, base=fields[0] if fields else None,
                             derived={d: fields for d in derived}, group=False)
    return rows[0]
