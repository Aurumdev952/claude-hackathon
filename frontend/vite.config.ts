import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [
    react(),
    // v3 patient app PWA (track U1): manifest + service worker for the /patient/app scope only. The worker is registered
    // by views/PatientApp.tsx (full-screen route, production builds) with scope "/patient/app", so the dashboards are
    // never controlled; it precaches the app shell and never caches /api, /agent, /mcp or /video. Off in the dev server.
    VitePWA({
      injectRegister: false,
      registerType: "autoUpdate",
      filename: "sw.js",
      scope: "/patient/app",
      includeAssets: ["pwa/apple-touch-icon.png", "pwa/icon.svg"],
      manifest: {
        id: "/patient/app",
        name: "Early Signals Patient (Synthetic)",
        short_name: "My care",
        description: "Your care plan, messages and check-ins from your care team. Demo app with synthetic data.",
        start_url: "/patient/app",
        scope: "/patient/app",
        display: "standalone",
        orientation: "portrait",
        lang: "en",
        background_color: "#F1F2F6", // --page
        theme_color: "#F1F2F6",
        icons: [
          { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/pwa/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackAllowlist: [/^\/patient\/app(\/|$|\?)/],
        navigateFallbackDenylist: [/^\/api/, /^\/agent/, /^\/mcp/, /^\/video/],
        globPatterns: ["**/*.{js,css,html,woff2,png,svg,webmanifest}"],
        // the 3D, map and chart bundles and the dashboards' data never belong to the patient app shell
        globIgnores: ["**/models/**", "**/geo/**", "mockServiceWorker.js", "**/three-*.js", "**/deck-*.js", "**/echarts-*.js", "**/AgentView-*.js", "**/VideoStudio-*.js"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },
      // dev: serve the manifest (e2e checks it) but never register a worker (PatientApp registers in production only)
      devOptions: { enabled: true, navigateFallbackAllowlist: [/^\/patient\/app/] },
    }),
  ],
  // several dev servers on one checkout (parallel tracks) need separate dep-optimiser caches
  cacheDir: process.env.VITE_CACHE_DIR || "node_modules/.vite",
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // widget contract shared with the agent backend (zod only; see agent/src/widgets/specs.ts)
      { find: /^@agent\/widgets$/, replacement: fileURLToPath(new URL("../agent/src/widgets/specs.ts", import.meta.url)) },
      // Remotion compositions and props shared with the video render server (video/src, browser-safe files only)
      { find: /^@video\/(.*)$/, replacement: fileURLToPath(new URL("../video/src/$1", import.meta.url)) },
    ],
    // the shared specs live outside this package: always resolve zod from the frontend's node_modules
    // (and React / Remotion / three for the video compositions, so the Player shares one React and one three)
    dedupe: ["zod", "react", "react-dom", "remotion", "@remotion/player", "@remotion/three", "three", "@react-three/fiber", "@fontsource-variable/urbanist"],
  },
  server: {
    // allow serving the shared agent widget specs (../agent/src/widgets) in dev
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    proxy: {
      "/api": { target: process.env.VITE_API_URL ?? "http://127.0.0.1:8000", changeOrigin: true, ws: true },
      // AI agent (agent/, Hono): chat SSE stream, conversations, artifacts, and the MCP endpoint
      // browser navigations (Accept: text/html) to /agent... are SPA routes, not API calls: let Vite serve index.html
      "/agent": { target: process.env.VITE_AGENT_URL ?? "http://127.0.0.1:8787", changeOrigin: true, proxyTimeout: 300_000, timeout: 300_000,
        bypass: (req) => (req.headers.accept?.includes("text/html") ? "/index.html" : undefined) },
      "/mcp": { target: process.env.VITE_AGENT_URL ?? "http://127.0.0.1:8787", changeOrigin: true, proxyTimeout: 300_000, timeout: 300_000 },
      // video render server (video/, Hono): props for the Player preview, MP4 export jobs and files
      "^/video/": { target: process.env.VITE_VIDEO_URL ?? "http://127.0.0.1:8790", changeOrigin: true, proxyTimeout: 600_000, timeout: 600_000,
        bypass: (req) => (req.headers.accept?.includes("text/html") && !req.url?.startsWith("/video/files/") ? "/index.html" : undefined) },
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei", "@react-three/postprocessing", "postprocessing"],
          deck: ["@deck.gl/core", "@deck.gl/layers", "@deck.gl/aggregation-layers", "@deck.gl/react"],
          echarts: ["echarts", "echarts-for-react"],
          ui: ["@heroui/react", "framer-motion"],
        },
      },
    },
  },
});
