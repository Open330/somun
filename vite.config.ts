import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  publicDir: false,
  build: { outDir: "../../dist/web", emptyOutDir: true },
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  server: { port: 5180, proxy: { "/api": "http://localhost:8790" } },
  test: { root: ".", include: ["src/**/*.test.ts"] },
});
