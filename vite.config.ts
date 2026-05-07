import { defineConfig, type Plugin } from "vite";
import webExtension from "vite-plugin-web-extension";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve, dirname, join } from "path";

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

/**
 * Chrome extensions reject any file or directory whose name begins
 * with "_" (those are reserved for system use — _locales, _metadata,
 * etc.). @rollup/plugin-commonjs's dynamic-require helper is named
 * `_commonjs-dynamic-modules.js` and is shared between several of our
 * entry bundles, so the loader fails with:
 *   "Cannot load extension with file or directory name
 *    _commonjs-dynamic-modules.js."
 *
 * vite-plugin-web-extension runs a separate Rollup build per manifest
 * entry, which makes a top-level `chunkFileNames` rule unreliable — the
 * underscore-prefixed asset still slips through. This plugin patches
 * the final dist tree after every build pass: it renames the helper to
 * drop the leading underscore and rewrites every `import` reference
 * we emitted to match.
 */
function stripUnderscoreChunksPlugin(): Plugin {
  return {
    name: "strip-underscore-chunks",
    apply: "build",
    closeBundle: {
      order: "post",
      handler() {
        const outDir = resolve("dist");
        try {
          statSync(outDir);
        } catch {
          return;
        }
        const renames = new Map<string, string>();
        const walk = (dir: string): void => {
          for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) {
              walk(full);
              continue;
            }
            if (!name.startsWith("_")) continue;
            // Strip *all* leading underscores. Result e.g.
            //   _commonjs-dynamic-modules.js -> commonjs-dynamic-modules.js
            const stripped = name.replace(/^_+/, "");
            if (!stripped) continue;
            const newFull = join(dir, stripped);
            renameSync(full, newFull);
            renames.set(name, stripped);
          }
        };
        walk(outDir);
        if (renames.size === 0) return;

        // Rewrite every JS file in dist so the import strings line up
        // with the new file names. Plain text replacement is safe here
        // because the helper names are unique tokens.
        const rewriteWalk = (dir: string): void => {
          for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) {
              rewriteWalk(full);
              continue;
            }
            if (!/\.(?:js|mjs|cjs|css)$/.test(name)) continue;
            let txt = readFileSync(full, "utf8");
            let touched = false;
            for (const [from, to] of renames) {
              if (txt.includes(from)) {
                txt = txt.split(from).join(to);
                touched = true;
              }
            }
            if (touched) writeFileSync(full, txt);
          }
        };
        rewriteWalk(outDir);
      },
    },
  };
}

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      additionalInputs: [
        "src/library/library.html",
      ],
    }),
    copyIconsPlugin(),
    stripUnderscoreChunksPlugin(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
