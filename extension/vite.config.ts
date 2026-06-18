import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/service-worker.ts"),
        content: resolve(__dirname, "src/content/main.ts"),
        popup: resolve(__dirname, "src/popup/popup.html")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  plugins: [
    {
      name: "termlens-copy-static-extension-assets",
      closeBundle() {
        mkdirSync(resolve(__dirname, "dist"), { recursive: true });
        mkdirSync(resolve(__dirname, "dist/assets"), { recursive: true });
        copyFileSync(resolve(__dirname, "src/manifest.json"), resolve(__dirname, "dist/manifest.json"));
        copyFileSync(resolve(__dirname, "src/content/loader.js"), resolve(__dirname, "dist/content-loader.js"));
        copyFileSync(resolve(__dirname, "dist/src/popup/popup.html"), resolve(__dirname, "dist/assets/popup.html"));
      }
    }
  ]
});
