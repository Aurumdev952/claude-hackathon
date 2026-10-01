import { useEffect, useState } from "react";

/** Light is the default theme; dark is a toggle on the same semantic tokens. The theme lives on <html> as both the
 * `data-theme` attribute (our CSS variables, HeroUI themes, viz.mode()) and the `dark` class (Tailwind / HeroUI `dark:`). */
export type Theme = "light" | "dark";
const KEY = "es-theme";

export function storedTheme(): Theme {
  try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}
export function applyTheme(t: Theme, persist = false) {
  const el = document.documentElement;
  el.dataset.theme = t;
  el.classList.toggle("dark", t === "dark");
  el.classList.toggle("light", t === "light");
  el.style.colorScheme = t;
  if (persist) { try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ } }
}
export const currentTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** Reactive theme + toggle (follows changes made anywhere via MutationObserver). */
export function useTheme() {
  const [theme, set] = useState<Theme>(currentTheme);
  useEffect(() => {
    const obs = new MutationObserver(() => set(currentTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  const toggle = () => applyTheme(theme === "dark" ? "light" : "dark", true);
  return { theme, toggle, setTheme: (t: Theme) => applyTheme(t, true) };
}
