import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
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
        validateManifestResources();
      }
    }
  ]
});

function validateManifestResources(): void {
  const distDir = resolve(__dirname, "dist");
  const manifest = JSON.parse(readFileSync(resolve(distDir, "manifest.json"), "utf8")) as {
    background?: { service_worker?: string };
    action?: { default_popup?: string; default_icon?: Record<string, string> };
    icons?: Record<string, string>;
    web_accessible_resources?: Array<{ resources?: string[] }>;
  };
  const resources = new Set<string>();

  if (manifest.background?.service_worker) {
    resources.add(manifest.background.service_worker);
  }
  if (manifest.action?.default_popup) {
    resources.add(manifest.action.default_popup);
  }
  for (const resource of Object.values(manifest.icons ?? {})) {
    resources.add(resource);
  }
  for (const resource of Object.values(manifest.action?.default_icon ?? {})) {
    resources.add(resource);
  }
  for (const group of manifest.web_accessible_resources ?? []) {
    for (const resource of group.resources ?? []) {
      resources.add(resource);
    }
  }

  const missing = [...resources].filter((resource) => !resource.includes("*") && !existsSync(resolve(distDir, resource)));
  if (missing.length > 0) {
    throw new Error(`Manifest references missing build resources:\n${missing.map((resource) => `- ${resource}`).join("\n")}`);
  }
}

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
