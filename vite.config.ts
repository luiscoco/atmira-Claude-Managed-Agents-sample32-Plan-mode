import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React app runs on :5173 and forwards /api calls to the Node server on :3001,
// because the Agent SDK must run in Node (it spawns a Claude Code process).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3001" },
    // The labs' working folders are rewritten by the server and by Claude Code while an agent runs. Concept 25's
    // fake CLAUDE_CONFIG_DIR (compact-lab/config) locks its backup files, and watching them crashed Vite with EBUSY.
    watch: { ignored: ["**/*-lab/**", "**/sandbox/**"] },
  },
});
