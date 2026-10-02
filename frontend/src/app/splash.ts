import type { QueryClient } from "@tanstack/react-query";

/** The initial-load splash lives in index.html (it paints before this bundle). It goes away once the first screen's data
 * has loaded: the query cache has fetched something and then stayed idle for a short beat (queries that start after
 * another resolves would otherwise see a gap), but never before the intro animation has finished, and never later than
 * MAX_MS (a slow or failing API shows the app with its own loading and error states). */
const MIN_MS = 1900;      // lines traced + ring drawn (index.html timeline)
const IDLE_MS = 250;
const NO_FETCH_MS = 1500; // a screen that loads nothing
const MAX_MS = 12_000;
const FADE_MS = 450;

export function dismissSplashWhenLoaded(qc: QueryClient) {
  const el = document.getElementById("es-splash");
  if (!el) return;
  const start = performance.now();
  let seenFetch = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const hide = () => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(idleTimer);
    clearTimeout(noFetch);
    clearTimeout(cap);
    const wait = Math.max(0, MIN_MS - (performance.now() - start));
    setTimeout(() => {
      el.classList.add("is-out");
      el.setAttribute("aria-busy", "false");
      setTimeout(() => el.remove(), FADE_MS);
    }, wait);
  };

  const check = () => {
    if (qc.isFetching() > 0) {
      seenFetch = true;
      clearTimeout(idleTimer);
      idleTimer = undefined;
    } else if (seenFetch && idleTimer === undefined) {
      idleTimer = setTimeout(() => { idleTimer = undefined; if (qc.isFetching() === 0) hide(); }, IDLE_MS);
    }
  };

  const unsubscribe = qc.getQueryCache().subscribe(check);
  const noFetch = setTimeout(() => { if (!seenFetch) hide(); }, NO_FETCH_MS);
  const cap = setTimeout(hide, MAX_MS);
  el.setAttribute("aria-busy", "true");
  // reveal the wordmark once Urbanist (imported in main.tsx) is usable; fall back to whatever face after 1.5 s
  const fontReady = () => el.classList.add("font-ready");
  Promise.race([document.fonts.load('600 22px "Urbanist Variable"'), new Promise((r) => setTimeout(r, 1500))]).then(fontReady, fontReady);
  check();
}
