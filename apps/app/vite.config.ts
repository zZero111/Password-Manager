import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri dev server settings: fixed port, and listen on the LAN address Tauri
// gives us when running on a phone (TAURI_DEV_HOST).
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  optimizeDeps: { exclude: ["hash-wasm"] },
});
