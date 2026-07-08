import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
        popup: resolve(__dirname, "src/popup/popup.html"),
        pdfViewer: resolve(__dirname, "src/pdf-viewer/pdf-viewer.html")
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
      name: "termpop-copy-static-extension-assets",
      closeBundle() {
        mkdirSync(resolve(__dirname, "dist"), { recursive: true });
        mkdirSync(resolve(__dirname, "dist/assets"), { recursive: true });
        mkdirSync(resolve(__dirname, "dist/assets/icons"), { recursive: true });
        copyFileSync(resolve(__dirname, "src/manifest.json"), resolve(__dirname, "dist/manifest.json"));
        copyFileSync(resolve(__dirname, "src/content/loader.js"), resolve(__dirname, "dist/content-loader.js"));
        copyFileSync(resolve(__dirname, "dist/src/popup/popup.html"), resolve(__dirname, "dist/assets/popup.html"));
        copyFileSync(resolve(__dirname, "dist/src/pdf-viewer/pdf-viewer.html"), resolve(__dirname, "dist/assets/pdf-viewer.html"));
        for (const iconFile of readdirSync(resolve(__dirname, "src/assets/icons"))) {
          copyFileSync(
            resolve(__dirname, "src/assets/icons", iconFile),
            resolve(__dirname, "dist/assets/icons", iconFile)
          );
        }
        copyDirectory(resolve(__dirname, "src/_locales"), resolve(__dirname, "dist/_locales"));
      }
    }
  ]
});

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourcePath = resolve(source, entry);
    const destinationPath = resolve(destination, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
      continue;
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
}
