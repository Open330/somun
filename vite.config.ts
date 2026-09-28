import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  publicDir: "public",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // React와 라우터는 배포마다 바뀌지 않는다. 따로 묶어 두면 앱 코드만 바뀐 배포에서 브라우저가 캐시를 그대로 쓴다.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "vendor", test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ }] } } },
  },
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  server: { port: 5180, proxy: { "/api": "http://localhost:8790" } },
  test: { root: ".", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], setupFiles: ["src/web/test-setup.ts"] },
});
