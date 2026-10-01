/** "Highland Watch" design tokens (SPEC §16.1). Colours come from CSS variables so light/dark themes swap cleanly. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        basalt: v("basalt"), ridge: v("ridge"), ridge2: v("ridge2"), mist: v("mist"), fog: v("fog"),
        kivu: v("kivu"), tea: v("tea"), sorghum: v("sorghum"), laterite: v("laterite"), line: v("line"),
      },
      fontFamily: { sans: ['"Public Sans Variable"', "system-ui", "sans-serif"] },
      boxShadow: { panel: "0 1px 0 rgb(255 255 255 / 0.03) inset, 0 12px 32px -18px rgb(0 0 0 / 0.6)" },
      keyframes: {
        pulseDot: { "0%,100%": { opacity: 1, transform: "scale(1)" }, "50%": { opacity: 0.35, transform: "scale(0.8)" } },
        rise: { from: { opacity: 0, transform: "translateY(6px)" }, to: { opacity: 1, transform: "translateY(0)" } },
      },
      animation: { pulseDot: "pulseDot 1.6s ease-in-out infinite", rise: "rise .35s ease-out both" },
    },
  },
  plugins: [],
};
