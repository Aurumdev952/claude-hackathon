/** Early Signals v2 design tokens ("ClyHealth / MedEx" light bento system, plan §A1).
 * Every colour is an RGB-triplet CSS variable defined in src/styles.css (light default, dark via [data-theme="dark"] / .dark),
 * so a later Tailwind 4 / HeroUI 3 upgrade is mechanical. HeroUI's own palette (primary/default/success/warning/danger,
 * background, content1-4, divider, focus) is configured below with the same hex values. */
import { heroui } from "@heroui/theme";

const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

// HeroUI scales: light runs 50 = lightest, dark runs 50 = darkest (HeroUI convention), so `text-success-700` reads in both.
const green = { 50: "#F0FDF4", 100: "#DCFCE7", 200: "#BBF7D0", 300: "#86EFAC", 400: "#4ADE80", 500: "#22C55E", 600: "#16A34A", 700: "#15803D", 800: "#166534", 900: "#14532D" };
const amber = { 50: "#FFFBEB", 100: "#FEF3C7", 200: "#FDE68A", 300: "#FCD34D", 400: "#FBBF24", 500: "#F59E0B", 600: "#D97706", 700: "#B45309", 800: "#92400E", 900: "#78350F" };
const red = { 50: "#FEF2F2", 100: "#FEE2E2", 200: "#FECACA", 300: "#FCA5A5", 400: "#F87171", 500: "#EF4444", 600: "#DC2626", 700: "#B91C1C", 800: "#991B1B", 900: "#7F1D1D" };

const light = {
  background: "#F3F5F9", foreground: "#0F172A", divider: "#E6EAF2", focus: "#3F6FE8", overlay: "#0B1220",
  content1: { DEFAULT: "#FFFFFF", foreground: "#0F172A" }, content2: { DEFAULT: "#F7F8FB", foreground: "#0F172A" },
  content3: { DEFAULT: "#EEF1F6", foreground: "#0F172A" }, content4: { DEFAULT: "#E6EAF2", foreground: "#0F172A" },
  default: { 50: "#F7F8FB", 100: "#EEF1F6", 200: "#E6EAF2", 300: "#D5DBE6", 400: "#A9B3C4", 500: "#7C889C", 600: "#64748B", 700: "#475569", 800: "#1E293B", 900: "#0F172A", DEFAULT: "#E6EAF2", foreground: "#0F172A" },
  primary: { 50: "#F3F6FF", 100: "#E8EFFF", 200: "#C9D8FB", 300: "#9DB7F4", 400: "#6F95EE", 500: "#3F6FE8", 600: "#2F5BD6", 700: "#2448AE", 800: "#1E3A8A", 900: "#172C66", DEFAULT: "#3F6FE8", foreground: "#FFFFFF" },
  secondary: { DEFAULT: "#1E3A8A", foreground: "#FFFFFF" },
  success: { ...green, DEFAULT: "#22C55E", foreground: "#FFFFFF" },
  warning: { ...amber, DEFAULT: "#F59E0B", foreground: "#FFFFFF" },
  danger: { ...red, DEFAULT: "#EF4444", foreground: "#FFFFFF" },
};
const dark = {
  background: "#0B1220", foreground: "#E6EAF2", divider: "#243049", focus: "#4C7EF0", overlay: "#000000",
  content1: { DEFAULT: "#121A2B", foreground: "#E6EAF2" }, content2: { DEFAULT: "#1A2336", foreground: "#E6EAF2" },
  content3: { DEFAULT: "#243049", foreground: "#E6EAF2" }, content4: { DEFAULT: "#2E3B57", foreground: "#E6EAF2" },
  default: { 50: "#121A2B", 100: "#1A2336", 200: "#243049", 300: "#2E3B57", 400: "#3E4C6A", 500: "#64748B", 600: "#94A3B8", 700: "#B6C2D6", 800: "#D5DBE6", 900: "#E6EAF2", DEFAULT: "#243049", foreground: "#E6EAF2" },
  primary: { 50: "#101A33", 100: "#1B2A4E", 200: "#22386A", 300: "#2B4A8E", 400: "#3A63C4", 500: "#4C7EF0", 600: "#638FFF", 700: "#8FB0FF", 800: "#BCD0FF", 900: "#E8EFFF", DEFAULT: "#4C7EF0", foreground: "#FFFFFF" },
  secondary: { DEFAULT: "#E8EFFF", foreground: "#0F172A" },
  success: { 50: "#052E1F", 100: "#064E3B", 200: "#065F46", 300: "#047857", 400: "#059669", 500: "#10B981", 600: "#34D399", 700: "#6EE7B7", 800: "#A7F3D0", 900: "#D1FAE5", DEFAULT: "#34D399", foreground: "#0B1220" },
  warning: { 50: "#2D1B05", 100: "#451A03", 200: "#78350F", 300: "#92400E", 400: "#B45309", 500: "#D97706", 600: "#F59E0B", 700: "#FBBF24", 800: "#FCD34D", 900: "#FEF3C7", DEFAULT: "#FBBF24", foreground: "#0B1220" },
  danger: { 50: "#2A0E0E", 100: "#450A0A", 200: "#7F1D1D", 300: "#991B1B", 400: "#B91C1C", 500: "#DC2626", 600: "#EF4444", 700: "#F87171", 800: "#FCA5A5", 900: "#FEE2E2", DEFAULT: "#F87171", foreground: "#0B1220" },
};

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx,mjs}"],
  // HeroUI components use `dark:`; we toggle both the data-theme attribute and the `dark` class (Providers / TopNav).
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // semantic tokens (new)
        bg: v("bg"),
        surface: { DEFAULT: v("surface"), 2: v("surface-2") },
        border: v("border"),
        fg: { DEFAULT: v("fg"), muted: v("fg-muted") },
        accent: { DEFAULT: v("accent"), hover: v("accent-hover"), soft: v("accent-soft") },
        nav: { DEFAULT: v("nav"), fg: v("nav-fg") },
        serious: v("serious"),
        /** Status text that stays legible on white (darker steps) and on the dark surface. */
        tone: { success: v("success-text"), warning: v("warning-text"), serious: v("serious-text"), danger: v("danger-text") },
        glass: v("glass"),
        // temporary old-name aliases (Phase 4 codemod: basalt→bg, ridge→surface, ridge2→surface-2, line→border,
        // mist→fg, fog→fg-muted, kivu→accent, tea→success, sorghum→warning, laterite→danger)
        basalt: v("basalt"), ridge: v("ridge"), ridge2: v("ridge2"), mist: v("mist"), fog: v("fog"),
        kivu: v("kivu"), tea: v("tea"), sorghum: v("sorghum"), laterite: v("laterite"), line: v("line"),
      },
      fontFamily: { sans: ['"Inter Variable"', "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
      fontSize: {
        display: ["40px", { lineHeight: "44px", fontWeight: "600", letterSpacing: "-0.02em" }],
        metric: ["28px", { lineHeight: "32px", fontWeight: "600", letterSpacing: "-0.015em" }],
        h1: ["22px", { lineHeight: "28px", fontWeight: "600", letterSpacing: "-0.01em" }],
        title: ["15px", { lineHeight: "20px", fontWeight: "600" }],
        label: ["12.5px", { lineHeight: "16px" }],
        micro: ["11px", { lineHeight: "14px" }],
      },
      borderRadius: { tile: "14px", card: "18px", modal: "24px" },
      boxShadow: {
        card: "var(--shadow-card)",
        float: "var(--shadow-float)",
        tile: "var(--shadow-tile)",
        panel: "var(--shadow-card)", // alias (old name)
      },
      backgroundImage: {
        "range-gradient": "linear-gradient(90deg, #22C55E 0%, #84CC16 28%, #F59E0B 58%, #F97316 78%, #EF4444 100%)",
        "cta-gradient": "linear-gradient(135deg, rgb(var(--accent)) 0%, #6C8CFF 55%, #8B7CF6 100%)",
      },
      keyframes: {
        pulseDot: { "0%,100%": { opacity: 1, transform: "scale(1)" }, "50%": { opacity: 0.35, transform: "scale(0.8)" } },
        rise: { from: { opacity: 0, transform: "translateY(6px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        ping2: { "0%": { transform: "scale(1)", opacity: 0.55 }, "80%,100%": { transform: "scale(2.4)", opacity: 0 } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        pulseDot: "pulseDot 1.6s ease-in-out infinite",
        rise: "rise .35s ease-out both",
        ping2: "ping2 1.8s cubic-bezier(0,0,.2,1) infinite",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [
    heroui({
      defaultTheme: "light",
      defaultExtendTheme: "light",
      layout: {
        radius: { small: "10px", medium: "14px", large: "18px" },
        borderWidth: { small: "1px", medium: "1px", large: "2px" },
        disabledOpacity: "0.45",
        boxShadow: {
          small: "0 1px 2px rgba(16,24,40,.05), 0 2px 8px rgba(16,24,40,.05)",
          medium: "0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.08)",
          large: "0 12px 40px rgba(16,24,40,.14)",
        },
      },
      themes: {
        light: { colors: light },
        dark: {
          colors: dark,
          layout: {
            boxShadow: {
              small: "0 1px 2px rgba(0,0,0,.4), 0 2px 8px rgba(0,0,0,.25)",
              medium: "0 1px 2px rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.35)",
              large: "0 16px 48px rgba(0,0,0,.55)",
            },
          },
        },
      },
    }),
  ],
};
