import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
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
