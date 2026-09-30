/**
 * offscreen.js — runs in the MV3 offscreen document.
 *
 * This is the ONLY file that imports vision.js/model_adapters.js. It's
 * loaded once (lazily, only when a page has opaque nodes to resolve —
 * see content_script.js's ensureOffscreenDocument), not injected into
 * every tab. This is what keeps TF.js/BlazeFace/Tesseract.js (~2MB+ of
 * WASM/JS) out of the content script bundle.
 *
 * Receives crops as dataURLs (content scripts can't hand over live
 * canvas/ImageData across the messaging boundary in MV3), decodes them
 * back into images locally, then runs the same classifyOpaqueRegion
 * logic already covered by vision.test.js.
 */

import { classifyOpaqueRegion } from "./vision.js";
import { detectFaces, extractText } from "./model_adapters.js";

async function dataUrlToCanvas(dataUrl) {
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return canvas;
}

async function resolveCrop({ id, dataUrl }) {
  console.log(`[sih26171/offscreen] Decoding crop for node ${id}...`);
  const canvas = await dataUrlToCanvas(dataUrl);
  
  console.log(`[sih26171/offscreen] Running BlazeFace & Tesseract OCR on node ${id}...`);
  const [faceCount, extractedText] = await Promise.all([
    detectFaces(canvas),
    extractText(canvas),
  ]);
  
  const token = classifyOpaqueRegion({ faceCount, extractedText });
  console.log(`[sih26171/offscreen] Node ${id} resolved token: ${token}`);
  return { id, token };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "offscreen_ping") {
    sendResponse({ pong: true });
    return false;
  }
  if (message?.type !== "resolve_opaque_nodes_offscreen") return false;

  (async () => {
    try {
      const results = {};
      // Sequential by design — same resource-utilization rationale as
      // the original resolveAllOpaqueNodes: bound peak GPU/CPU usage
      // rather than firing every crop's inference concurrently.
      for (const crop of message.crops) {
        const { id, token } = await resolveCrop(crop);
        results[id] = token;
      }
      sendResponse({ ok: true, results });
    } catch (err) {
      console.error("[sih26171/offscreen] resolution failed:", err);
      sendResponse({ ok: false, detail: String(err) });
    }
  })();

  return true; // keep channel open for async sendResponse
});
