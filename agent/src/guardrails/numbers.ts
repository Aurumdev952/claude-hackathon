/** Port of guardrails.numbers_in / numbers_supported (SPEC §15.2 step 9): every number in an answer must be in the data. */

const NUM_RE = /(?<![\w.])-?\d+(?:[.,]\d+)*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  const out: number[] = [];
  // typographic minus -> ASCII; the conventional "95% CI" / "95% confidence" label is not a data value
  const t = text.replace(/\u2212/g, "-").replace(/\b95\s?%\s?(CI|confidence|credible|interval)/gi, " $1");
  for (const m of t.match(NUM_RE) ?? []) {
    const s = m.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(s)) continue; // Python float() rejects e.g. "1.2.3"
    out.push(Number(s));
  }
  return out;
}

/** Python round(x, 0): banker's rounding (round half to even). */
export function pyRound(a: number): number {
  const f = Math.floor(a);
  const diff = a - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function supported(n: number, pool: number[], tol: number): boolean {
  if (Math.abs(n) <= 31 || (n >= 1990 && n <= 2035 && Number.isInteger(n))) return true;
  return pool.some(
    (a) =>
      Math.abs(n - a) <= Math.max(tol, Math.abs(a) * 0.005) ||
      (Math.abs(n - pyRound(a)) < 0.51 && Math.abs(a) > 20) ||
      Math.abs(n - a * 100) <= 0.51,
  );
}

/** Small integers (<= 31) and 4-digit years are always allowed, as in Python. */
export function numbersSupported(answer: string, allowed: unknown[], tol = 0.051): boolean {
  const pool = allowed.filter((a): a is number => typeof a === "number" && Number.isFinite(a));
  return numbersIn(answer).every((n) => supported(n, pool, tol));
}

export function unsupportedNumbers(answer: string, allowed: unknown[], tol = 0.051): number[] {
  const pool = allowed.filter((a): a is number => typeof a === "number" && Number.isFinite(a));
  return numbersIn(answer).filter((n) => !supported(n, pool, tol));
}

/**
 * Every finite number inside a JSON-like value (tool outputs -> the pool of allowed numbers). Negative values also add
 * their magnitude: prose carries the sign in words ("fell 39%", "declined 3.2% a year").
 */
export function collectNumbers(obj: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 12) return out;
  if (typeof obj === "number") {
    if (Number.isFinite(obj)) out.push(obj);
    if (obj < 0 && Number.isFinite(obj)) out.push(-obj);
  } else if (typeof obj === "string") {
    // numbers embedded in strings (e.g. alert summaries "probability 12.3%") are grounded too
    if (obj.length < 400) for (const n of numbersIn(obj)) out.push(n, Math.abs(n));
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectNumbers(v, out, depth + 1);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) collectNumbers(v, out, depth + 1);
  }
  return out;
}
