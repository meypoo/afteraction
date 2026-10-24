import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tailwind runs through postcss.config.mjs.
// `pnpm dev` proxies the API to a running `afteraction` (default port 4317).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
