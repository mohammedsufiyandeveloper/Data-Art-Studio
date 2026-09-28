import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative URLs so dist/ works from any folder or sub-path.
  base: "./",
  // Files in public/ are copied as-is, so runtime paths like
  // "../assets/butterfly_atlas.webp" in flight-garden/main.js keep working.
  publicDir: "public",
  server: {
    open: "/velocitymapping.html",
  },
  preview: {
    open: "/velocitymapping.html",
  },
  build: {
    outDir: "dist",
    // Three.js alone is ~600 kB; this is expected, not a problem.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        studio: resolve(import.meta.dirname, "velocitymapping.html"),
        flightGarden: resolve(import.meta.dirname, "flight-garden/index.html"),
      },
    },
  },
});
