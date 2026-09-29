import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import attendance from "./api/attendance.js";
import wind from "./api/wind.js";

// Serves the Vercel functions in api/ from the Vite dev and preview servers,
// so /api/attendance and /api/wind behave the same locally as when deployed.
function apiRoutes() {
  const mount = (server) => {
    server.middlewares.use("/api/attendance", (req, res) => attendance(req, res));
    server.middlewares.use("/api/wind", (req, res) => wind(req, res));
  };
  return { name: "api-routes", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  // The api/ handlers read process.env; locally those values live in .env.
  const env = loadEnv(mode, process.cwd(), ["TUSKER_", "WEATHERAPI_"]);
  for (const [name, value] of Object.entries(env)) {
    if (!(name in process.env)) process.env[name] = value;
  }

  return {
    // Relative URLs so dist/ works from any folder or sub-path.
    base: "./",
    // Files in public/ are copied as-is, so runtime paths like
    // "../assets/butterfly_atlas.webp" in flight-garden/main.js keep working.
    publicDir: "public",
    plugins: [apiRoutes()],
    server: {
      // The R2 video bucket's CORS rule only allows this origin, so fail
      // loudly instead of drifting to another port where videos can't load.
      port: 5173,
      strictPort: true,
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
  };
});
