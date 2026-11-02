import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the Python server started with `python app.py --no-browser`
const backend = "http://127.0.0.1:8765";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": backend,
      "/pieces": backend,
      "/sounds": backend,
      "/ws": { target: backend.replace("http", "ws"), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
