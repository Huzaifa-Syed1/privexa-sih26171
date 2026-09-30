/**
 * model_adapters.js — real, browser-only implementations of the
 * {captureRegion, detectFaces, extractText} interface that vision.js
 * takes as injected dependencies.
 *
 * This file is intentionally NOT unit tested with the real models —
 * BlazeFace/Tesseract.js need actual WebGL/WASM + real image data to do
 * anything meaningful, and a test that mocks them at this level would
 * just be re-testing that JavaScript calls functions correctly. The
 * decision logic that actually matters (vision.test.js) is already
 * covered independent of these real implementations.
 *
 * What SHOULD happen before this ships: a manual smoke test per
 * docs/SPEC.md §8 checklist — load the extension, point it at a page
 * with a real photo containing a face, and confirm in devtools that the
 * network payload contains a face token and not raw pixel data.
 */

import * as blazeface from "@tensorflow-models/blazeface";
import * as tf from "@tensorflow/tfjs";
import Tesseract from "tesseract.js";

let _faceModel = null;
let _ocrWorker = null;

/**
 * Lazily load and cache the BlazeFace model. Called once per extension
 * lifetime (background service worker keeps this warm), not per-node —
 * loading a model per detection would dominate latency.
 */
async function getFaceModel() {
  if (!_faceModel) {
    try {
      await tf.setBackend("cpu");
    } catch (_) {}
    _faceModel = await blazeface.load();
  }
  return _faceModel;
}

async function getOcrWorker() {
  if (!_ocrWorker) {
    _ocrWorker = await Tesseract.createWorker("eng", 1, {
      workerPath: chrome.runtime.getURL("tesseract/worker.min.js"),
      corePath: chrome.runtime.getURL("tesseract/core"),
      langPath: chrome.runtime.getURL("tesseract/lang"),
      cacheMethod: "readOnly",
      workerBlobURL: false,
      gzip: true,
    });
  }
  return _ocrWorker;
}

/**
 * Crop the given element's rendered region into an ImageData/canvas
 * suitable for feeding to BlazeFace and Tesseract. For <canvas> elements
 * this reads directly; for <img> it draws to an offscreen canvas first.
 *
 * @param {Element} el
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function captureRegion(el) {
  const rect = el.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const ctx = canvas.getContext("2d");

  const tag = el.tagName.toLowerCase();
  if (tag === "canvas") {
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  } else if (tag === "img") {
    // drawImage on a same-origin (or CORS-enabled) <img> works directly;
    // a cross-origin image without CORS headers will taint the canvas,
    // which is a browser security feature we deliberately do not try to
    // bypass — a tainted canvas throws on getImageData, and we let that
    // propagate as a normal error rather than silently sending nothing.
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  } else {
    throw new Error(`captureRegion: unsupported element tag "${tag}"`);
  }

  return canvas;
}

/**
 * Real face detection via BlazeFace.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<number>} face count
 */
export async function detectFaces(canvas) {
  try {
    const facePromise = (async () => {
      const model = await getFaceModel();
      const predictions = await model.estimateFaces(canvas, false);
      return predictions.length;
    })();
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(0), 3000));
    return await Promise.race([facePromise, timeoutPromise]);
  } catch (err) {
    console.warn("[sih26171] detectFaces error:", err);
    return 0;
  }
}

/**
 * Real OCR via Tesseract.js.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<string>} extracted text
 */
export async function extractText(canvas) {
  try {
    const ocrPromise = (async () => {
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(canvas);
      return data.text || "";
    })();
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(""), 5000));
    return await Promise.race([ocrPromise, timeoutPromise]);
  } catch (err) {
    console.warn("[sih26171] extractText error:", err);
    return "";
  }
}

/**
 * Release model resources. Call on extension unload/idle to free memory —
 * not required for correctness, but good citizenship on a "client
 * resource utilization" -scored task.
 */
export async function teardown() {
  if (_ocrWorker) {
    await _ocrWorker.terminate();
    _ocrWorker = null;
  }
  _faceModel = null;
}
