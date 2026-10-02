/** Early Signals design v3 tokens ("Granger polish", design-v3.md). Every colour is an RGB-triplet CSS variable defined
 * in src/styles.css (light default, dark via [data-theme="dark"] / .dark); the token table and the v2 → v3 name mapping
 * live at the top of that file. HeroUI's own palette (primary = brand green, danger = signal, default = greys, success/warning/danger,
 * background, content1-4, divider, focus) is configured below with the same hex values. */
import { heroui } from "@heroui/theme";

const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

// HeroUI scales: light runs 50 = lightest, dark runs 50 = darkest (HeroUI convention), so `text-success-700` reads in both.
const signalLight = { 50: "#FEF4EF", 100: "#FDE9E1", 200: "#FBCDB9", 300: "#F8A98A", 400: "#F47E54", 500: "#F05A28", 600: "#D14516", 700: "#B83A12", 800: "#8F2E10", 900: "#6B240E" };
const signalDark = { 50: "#24150F", 100: "#3A2219", 200: "#5E2C1C", 300: "#8C3518", 400: "#C2441A", 500: "#F05A28", 600: "#FF6D3A", 700: "#FF8A5C", 800: "#FFB08F", 900: "#FFDCCD" };
// brand: primary #4F6F51, secondary #98D59B
const brandLight = { 50: "#F1F8F1", 100: "#E6F3E7", 200: "#CDE9CF", 300: "#B2DEB4", 400: "#98D59B", 500: "#6E9B71", 600: "#4F6F51", 700: "#3F5A41", 800: "#304532", 900: "#223123" };
const brandDark = { 50: "#141D15", 100: "#1F2E21", 200: "#2C432E", 300: "#3B5A3D", 400: "#4F6F51", 500: "#6E9B71", 600: "#98D59B", 700: "#B2DEB4", 800: "#CDE9CF", 900: "#E6F3E7" };
const greenLight = { 50: "#EEF8F2", 100: "#DCF1E5", 200: "#B5E2C9", 300: "#83CDA8", 400: "#4FB585", 500: "#2E9E6A", 600: "#24855A", 700: "#1F7A52", 800: "#185F40", 900: "#11432D" };
const amberLight = { 50: "#FDF6E7", 100: "#FBEDCC", 200: "#F6D894", 300: "#EFC05A", 400: "#E6A626", 500: "#D98A00", 600: "#B87500", 700: "#9A6200", 800: "#7A4E00", 900: "#5A3900" };

const light = {
  background: "#F1F2F6", foreground: "#15171C", divider: "#E8E9EF", focus: "#4F6F51", overlay: "#15171C",
  content1: { DEFAULT: "#FFFFFF", foreground: "#15171C" }, content2: { DEFAULT: "#F5F6F9", foreground: "#15171C" },
  content3: { DEFAULT: "#ECEDF2", foreground: "#15171C" }, content4: { DEFAULT: "#E8E9EF", foreground: "#15171C" },
  default: { 50: "#F5F6F9", 100: "#ECEDF2", 200: "#E8E9EF", 300: "#D6D8DF", 400: "#A3A8B5", 500: "#8B909E", 600: "#6B7080", 700: "#4A4F5C", 800: "#2A2D35", 900: "#15171C", DEFAULT: "#ECEDF2", foreground: "#15171C" },
  primary: { ...brandLight, DEFAULT: "#4F6F51", foreground: "#FFFFFF" },
  secondary: { DEFAULT: "#15171C", foreground: "#FFFFFF" },
  success: { ...greenLight, DEFAULT: "#2E9E6A", foreground: "#FFFFFF" },
  warning: { ...amberLight, DEFAULT: "#D98A00", foreground: "#15171C" },
  danger: { ...signalLight, DEFAULT: "#D14516", foreground: "#FFFFFF" },
};
const dark = {
  background: "#0E1014", foreground: "#F2F3F5", divider: "#262A33", focus: "#98D59B", overlay: "#000000",
  content1: { DEFAULT: "#16191F", foreground: "#F2F3F5" }, content2: { DEFAULT: "#1D2128", foreground: "#F2F3F5" },
  content3: { DEFAULT: "#242831", foreground: "#F2F3F5" }, content4: { DEFAULT: "#2C313B", foreground: "#F2F3F5" },
  default: { 50: "#16191F", 100: "#1D2128", 200: "#262A33", 300: "#2C313B", 400: "#3E4450", 500: "#5A5F6B", 600: "#8B909E", 700: "#B4B8C2", 800: "#D7DAE0", 900: "#F2F3F5", DEFAULT: "#262A33", foreground: "#F2F3F5" },
  primary: { ...brandDark, DEFAULT: "#98D59B", foreground: "#15171C" },
  secondary: { DEFAULT: "#F2F3F5", foreground: "#15171C" },
  success: { 50: "#0F241A", 100: "#143524", 200: "#1A4A33", 300: "#226446", 400: "#2E8A5E", 500: "#2E9E6A", 600: "#4CC28A", 700: "#7AD4A9", 800: "#AEE6CB", 900: "#DDF5E9", DEFAULT: "#4CC28A", foreground: "#15171C" },
  warning: { 50: "#2A1E05", 100: "#3D2B07", 200: "#5C410A", 300: "#7F590C", 400: "#A9760B", 500: "#D98A00", 600: "#F0A626", 700: "#F5BE5E", 800: "#F9D493", 900: "#FCEBCB", DEFAULT: "#F0A626", foreground: "#15171C" },
  danger: { ...signalDark, DEFAULT: "#FF6D3A", foreground: "#15171C" },
};

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./node_modules/@heroui/theme/dist/components/(accordion|avatar|badge|button|chip|divider|drawer|dropdown|input|kbd|listbox|menu|modal|popover|ripple|scroll-shadow|select|skeleton|spinner|tabs|toggle).js"],
  // HeroUI components use `dark:`; we toggle both the data-theme attribute and the `dark` class (Providers / TopNav).
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // v3 tokens
        page: v("page"),
        surface: { DEFAULT: v("surface"), 2: v("surface-2") },
        tile: { DEFAULT: v("tile"), hover: v("tile-hover") },
        hairline: v("hairline"),
        ink: { DEFAULT: v("ink"), on: v("on-ink") },
        muted: v("muted"),
        faint: v("faint"),
        brand: { DEFAULT: v("brand"), strong: v("brand-strong"), soft: v("brand-soft"), text: v("brand-text"), on: v("on-brand"), 2: v("brand-2") },
        signal: { DEFAULT: v("signal"), strong: v("signal-strong"), soft: v("signal-soft"), text: v("signal-text"), on: v("on-signal") },
        sky: { DEFAULT: v("sky"), soft: v("sky-soft") },
        // v2 names, pointed at v3 tokens in styles.css (bg → page, surface-2 → tile, border → hairline, fg → ink, accent → brand …)
        bg: v("bg"),
        border: v("border"),
        fg: { DEFAULT: v("fg"), muted: v("fg-muted") },
        accent: { DEFAULT: v("accent"), hover: v("accent-hover"), soft: v("accent-soft") },
        nav: { DEFAULT: v("nav"), fg: v("nav-fg") },
        serious: v("serious"),
        /** Status text that stays legible on white (darker steps) and on the dark surface. */
        tone: { success: v("success-text"), warning: v("warning-text"), serious: v("serious-text"), danger: v("danger-text") },
        glass: v("glass"),
      },
      fontFamily: { sans: ['"Urbanist Variable"', "Urbanist", "system-ui", "-apple-system", "Segoe UI", "sans-serif"] },
      // Type scale (design-v3 §Type). Urbanist runs small, so body is 14/20 and labels 13/18.
      fontSize: {
        display: ["48px", { lineHeight: "52px", fontWeight: "500", letterSpacing: "-0.02em" }],
        metric: ["40px", { lineHeight: "44px", fontWeight: "500", letterSpacing: "-0.02em" }],
        h1: ["28px", { lineHeight: "34px", fontWeight: "600", letterSpacing: "-0.01em" }],
        title: ["17px", { lineHeight: "24px", fontWeight: "600" }],
        body: ["14px", { lineHeight: "20px" }],
        label: ["13px", { lineHeight: "18px", fontWeight: "500" }],
        micro: ["12px", { lineHeight: "16px", fontWeight: "500" }],
      },
      borderRadius: { tile: "16px", card: "24px", hero: "28px", modal: "24px" },
      boxShadow: {
        card: "var(--shadow-card)",
        float: "var(--shadow-float)",
        tile: "var(--shadow-tile)",
      },
      keyframes: {
        pulseDot: { "0%,100%": { opacity: 1, transform: "scale(1)" }, "50%": { opacity: 0.35, transform: "scale(0.8)" } },
        rise: { from: { opacity: 0 }, to: { opacity: 1 } },
        ping2: { "0%": { transform: "scale(1)", opacity: 0.55 }, "80%,100%": { transform: "scale(2.4)", opacity: 0 } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        pulseDot: "pulseDot 1.6s ease-in-out infinite",
        rise: "rise .25s ease-out both",
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
        radius: { small: "12px", medium: "16px", large: "24px" },
        borderWidth: { small: "1px", medium: "1px", large: "2px" },
        disabledOpacity: "0.45",
        // Flat UI: overlays (popover, dropdown, modal) carry the one soft shadow; `small` (tab cursor, switch thumb) is a hairline lift.
        boxShadow: {
          small: "0 1px 2px rgba(21,23,28,.06)",
          medium: "0 16px 48px rgba(21,23,28,.12)",
          large: "0 16px 48px rgba(21,23,28,.12)",
        },
      },
      themes: {
        light: { colors: light },
        dark: {
          colors: dark,
          layout: {
            boxShadow: {
              small: "0 1px 2px rgba(0,0,0,.3)",
              medium: "0 16px 48px rgba(0,0,0,.5)",
              large: "0 16px 48px rgba(0,0,0,.5)",
            },
          },
        },
      },
    }),
  ],
};
