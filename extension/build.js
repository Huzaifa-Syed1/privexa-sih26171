#!/usr/bin/env node
/**
 * build.js — bundles the tested ES modules into MV3-compatible output.
 *
 * Why this exists: Chrome MV3 content scripts and service workers don't
 * load bare ES module imports the way content_script.js/background.js
 * are written (for clarity, and to import directly from the same files
 * vitest tests). esbuild bundles everything into a single IIFE per
 * entry point — this introduces zero logic changes, it only concatenates
 * already-tested modules, which is exactly why the unit test suite
 * remains trustworthy for this bundled output.
 */

import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync, cpSync } from "fs";

const OUT_DIR = "dist";
mkdirSync(OUT_DIR, { recursive: true });

const shared = {
  bundle: true,
  format: "iife",
  target: "chrome115",
  outdir: OUT_DIR,
  logLevel: "info",
};

await esbuild.build({
  ...shared,
  entryPoints: {
    content_script: "src/content_script.js",
    background: "src/background.js",
    offscreen: "src/offscreen.js",
  },
});

copyFileSync("public/manifest.json", `${OUT_DIR}/manifest.json`);
copyFileSync("public/offscreen.html", `${OUT_DIR}/offscreen.html`);
cpSync("public/tesseract", `${OUT_DIR}/tesseract`, { recursive: true });

console.log(`\nBundled to ${OUT_DIR}/. Load this directory as an unpacked extension.`);
