import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies /api to the orchestrator so the dev server needs no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
