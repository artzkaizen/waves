import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = "http://localhost:8000";

export default defineConfig({
  // The config lives beside index.html, but vite is invoked from the repo root, so the
  // root has to be stated explicitly or it looks for index.html in the wrong place.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Built into the repo-root dist/, which the Hono server serves at /.
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    // In dev the UI runs on :5173 and the API on :8000. Proxying keeps them same-origin
    // from the browser's point of view, so the httpOnly session cookie is sent normally
    // and there is no CORS-with-credentials dance to get wrong.
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/auth": { target: API, changeOrigin: true },
      "/experiments": { target: API, changeOrigin: true },
      "/exercises": { target: API, changeOrigin: true },
      "/healthz": { target: API },
      "/live": { target: API, ws: true },
    },
  },
});
