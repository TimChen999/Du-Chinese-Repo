import { defineConfig, type Plugin } from "vite";
import webExtension from "vite-plugin-web-extension";
import { copyFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

function copyIconsPlugin(): Plugin {
  const icons = [
    "assets/icons/icon-16.png",
    "assets/icons/icon-48.png",
    "assets/icons/icon-128.png",
  ];
  return {
    name: "copy-icons-verbatim",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? "dist";
      for (const icon of icons) {
        const dest = resolve(outDir, icon);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(resolve(icon), dest);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      additionalInputs: [
        "src/reader/reader.html",
        "src/hub/hub.html",
      ],
    }),
    copyIconsPlugin(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
