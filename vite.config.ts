import { defineConfig } from "vite";

// Static client build. `base: "./"` lets the dist folder be hosted from any path.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", chunkSizeWarningLimit: 1600 },
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
