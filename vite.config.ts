import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. Electron serves dist/ over the app:// protocol.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5317, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "chrome140" },
});
