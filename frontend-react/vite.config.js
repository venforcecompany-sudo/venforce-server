import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const portalDir = fileURLToPath(new URL("../Portal", import.meta.url));
const BACKEND_DEV = process.env.VITE_BACKEND_ORIGIN || "http://localhost:3333";
const ROTAS_API = ["/operacao", "/auth", "/ads", "/fechamentos", "/clientes", "/health"];

export default defineConfig({
  base: "./",
  plugins: [react()],
  publicDir: portalDir,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5181,
    open: "/central-executiva-react.html",
    proxy: Object.fromEntries(
      ROTAS_API.map((rota) => [rota, { target: BACKEND_DEV, changeOrigin: true }])
    ),
  },
  build: {
    outDir: portalDir,
    emptyOutDir: false,
    copyPublicDir: false,
    assetsDir: "assets/frontend-react",
    rollupOptions: {
      input: {
        "cliente-360-react": fileURLToPath(new URL("./cliente-360-react.html", import.meta.url)),
        "central-executiva-react": fileURLToPath(new URL("./central-executiva-react.html", import.meta.url)),
      },
      output: {
        entryFileNames: "assets/frontend-react/[name]-[hash].js",
        chunkFileNames: "assets/frontend-react/[name]-[hash].js",
        assetFileNames: "assets/frontend-react/[name]-[hash][extname]",
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.js",
    include: ["src/**/*.test.{js,jsx}"],
  },
});
