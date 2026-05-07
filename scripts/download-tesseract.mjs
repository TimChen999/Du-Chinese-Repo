#!/usr/bin/env node
/**
 * Stages tesseract.js's runtime assets in public/tesseract/ so the
 * build copies them into dist/tesseract/. Bundling these locally:
 *
 *   - Eliminates the only remaining remote-code execution in the
 *     extension. Chrome Web Store MV3 policy forbids fetching JS from
 *     a CDN at runtime; tesseract.js's default behaviour does that.
 *   - Lets OCR run on sites with strict Content-Security-Policy that
 *     block jsDelivr / blob: workers (e.g. 番茄小说). Without this
 *     they silently break OCR for both image and font-cipher flows.
 *   - Removes the ~1.7 MB chi_sim trained-data download that every
 *     fresh user pays on first OCR.
 *
 * Three of the four files are copied straight from node_modules — they
 * shipped with the dependencies. chi_sim trained data is downloaded
 * once from the project-naptha CDN (the same place tesseract.js fetches
 * from at runtime by default) using the *fast* variant: ~1.7 MB
 * compressed vs ~20 MB for "best", with negligible accuracy difference
 * on clean rendered glyphs (which is the hot path for both our flows).
 *
 * Idempotent: skips files that already exist. Override with FORCE=1.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(ROOT, "public", "tesseract");
const FORCE = process.env.FORCE === "1";

mkdirSync(OUT_DIR, { recursive: true });

// ─── 1. Copy worker.min.js + tesseract-core-simd-lstm.* from node_modules

const COPIES = [
  {
    from: resolve(ROOT, "node_modules", "tesseract.js", "dist", "worker.min.js"),
    to: resolve(OUT_DIR, "worker.min.js"),
  },
  {
    from: resolve(
      ROOT,
      "node_modules",
      "tesseract.js-core",
      "tesseract-core-simd-lstm.wasm",
    ),
    to: resolve(OUT_DIR, "tesseract-core-simd-lstm.wasm"),
  },
  {
    from: resolve(
      ROOT,
      "node_modules",
      "tesseract.js-core",
      "tesseract-core-simd-lstm.wasm.js",
    ),
    to: resolve(OUT_DIR, "tesseract-core-simd-lstm.wasm.js"),
  },
];

for (const { from, to } of COPIES) {
  if (existsSync(to) && !FORCE) {
    const size = statSync(to).size;
    if (size > 1024) {
      console.log("[tesseract] %s already present (%d bytes). Skipping.", to, size);
      continue;
    }
  }
  if (!existsSync(from)) {
    console.error(
      "[tesseract] Source missing: %s. Run `npm install` first.",
      from,
    );
    process.exit(1);
  }
  copyFileSync(from, to);
  console.log("[tesseract] Copied %s", to);
}

// ─── 2. Download chi_sim_fast.traineddata.gz ──────────────────────

const TRAINED_DATA_TARGET = resolve(OUT_DIR, "chi_sim.traineddata.gz");
// Source: https://github.com/tesseract-ocr/tessdata_fast — the "fast"
// LSTM-only variant. ~1.7 MB; "best" is ~20 MB and offers negligible
// gains on rendered (non-photographic) text, which is what both our
// font-cipher decoder and image-OCR feature feed in.
const TRAINED_DATA_URL =
  "https://tessdata.projectnaptha.com/4.0.0_fast/chi_sim.traineddata.gz";

if (existsSync(TRAINED_DATA_TARGET) && !FORCE) {
  const size = statSync(TRAINED_DATA_TARGET).size;
  if (size > 100_000) {
    console.log(
      "[tesseract] %s already present (%d bytes). Skipping.",
      TRAINED_DATA_TARGET,
      size,
    );
    process.exit(0);
  }
}

await fetchToFile(TRAINED_DATA_URL, TRAINED_DATA_TARGET);
const finalSize = statSync(TRAINED_DATA_TARGET).size;
console.log(
  "[tesseract] Downloaded chi_sim trained data → %s (%d bytes)",
  TRAINED_DATA_TARGET,
  finalSize,
);

function fetchToFile(url, destination) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.get(url, { timeout: 120_000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        res.resume();
        if (!next) {
          rejectPromise(new Error(`Redirect with no Location header from ${url}`));
          return;
        }
        fetchToFile(next, destination).then(resolvePromise, rejectPromise);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        rejectPromise(
          new Error(`Unexpected status ${res.statusCode} from ${url}`),
        );
        return;
      }
      pipeline(res, createWriteStream(destination)).then(
        () => resolvePromise(),
        rejectPromise,
      );
    });
    req.on("error", rejectPromise);
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
  });
}
