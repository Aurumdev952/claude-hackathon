import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": { target: process.env.VITE_API_URL ?? "http://127.0.0.1:8000", changeOrigin: true, ws: true },
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
        },
      },
    },
  },
});
