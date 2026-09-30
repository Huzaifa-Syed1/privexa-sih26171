/**
 * vision.js — Tier 1: local vision fallback for DOM-opaque regions.
 *
 * Runs ONLY on nodes scene_graph.js marked `source: "vision_pending"`
 * (canvas, images without alt text, iframes) — never on the full page.
 * SPEC.md §4 Stage B.
 *
 * Design note: face detection (BlazeFace) and OCR (Tesseract.js) are
 * real, heavyish, browser/WASM-dependent libraries. Rather than mock
 * those out at the module level (which would test nothing real), this
 * file isolates them behind two thin injected functions:
 *   - `detectFaces(imageData) -> Promise<number>`
 *   - `extractText(imageData) -> Promise<string>`
 * The actual decision logic — which token a given (faceCount, text)
 * combination produces — is a pure function (`classifyOpaqueRegion`)
 * that is exercised directly and thoroughly in tests, independent of
 * whether the underlying models are real or fake. `resolveOpaqueNode`
 * is the thin orchestration glue on top, analogous to how executor.js
 * separates validateAction (pure, heavily tested) from executeAction
 * (thin DOM glue).
 */

import { redactText, TOKENS } from "./redact.js";

// Heuristic threshold: an OCR'd region with this many characters per unit
// area (roughly) is treated as "text-dense" for the face+text -> DOCUMENT
// classification. Tuned loosely; false positives here just mean we
// over-redact (call something a document that wasn't), which is the safe
// direction to err in.
const DOCUMENT_TEXT_DENSITY_THRESHOLD = 40; // characters

/**
 * Detect "generic" sensitive-shaped fragments in text that did NOT match
 * any of the named categories in redact.js. This is intentionally a loose
 * heuristic (long alphanumeric codes, long digit runs) — the goal is to
 * err toward flagging possible ID/reference numbers on documents rather
 * than silently passing them through. False positives here are far
 * cheaper than false negatives.
 *
 * @param {string} text
 * @returns {number} count of generic-sensitive-looking fragments
 */
function countGenericSensitiveFragments(text) {
  if (!text) return 0;
  const longDigitRuns = text.match(/\b\d{6,}\b/g) || [];
  const longAlphaNumCodes = text.match(/\b[A-Z0-9]{6,}\b/g) || [];
  // Dedup: a long digit run can also match the alphanumeric pattern —
  // count unique fragments, not double-count the same span.
  const unique = new Set([...longDigitRuns, ...longAlphaNumCodes]);
  return unique.size;
}

/**
 * Pure decision function: given what Tier 1 detected in an opaque region,
 * return the correct redaction token (or null), per SPEC.md §3.
 *
 * Priority (matches SPEC.md §4 Stage B ordering):
 *   1. face + dense text together -> DOCUMENT (more specific than either alone)
 *   2. face alone -> face,count=N
 *   3. named PII pattern in OCR text (email/phone/aadhaar/pan/card) -> that token
 *   4. generic sensitive-shaped text -> generic_pii,count=N
 *   5. nothing found -> null
 *
 * @param {{faceCount: number, extractedText: string}} detection
 * @returns {string|null}
 */
export function classifyOpaqueRegion({ faceCount, extractedText }) {
  const text = extractedText || "";
  const isTextDense = text.length >= DOCUMENT_TEXT_DENSITY_THRESHOLD;

  if (faceCount > 0 && isTextDense) {
    return TOKENS.DOCUMENT;
  }

  if (faceCount > 0) {
    return TOKENS.face(faceCount);
  }

  // Check named categories first — run per-line so one line's match
  // doesn't get diluted/hidden by unrelated text elsewhere in the block.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const token = redactText(line);
    if (token) return token;
  }

  const genericCount = countGenericSensitiveFragments(text);
  if (genericCount > 0) {
    return TOKENS.generic(genericCount);
  }

  return null;
}

/**
 * Resolve a single vision_pending scene-graph node into its final,
 * redacted form. This is the orchestration layer — it calls the injected
 * model functions, then hands their output to the pure classifier above.
 *
 * @param {object} node - a scene-graph node with source==="vision_pending"
 *                         and a live `_el` reference (from scene_graph.js,
 *                         before it's stripped for the network payload)
 * @param {{
 *   captureRegion: (el: Element) => Promise<ImageData|any>,
 *   detectFaces: (imageData: any) => Promise<number>,
 *   extractText: (imageData: any) => Promise<string>,
 * }} deps
 * @returns {Promise<object>} a new node object with value_redacted set and source:"vision"
 */
export async function resolveOpaqueNode(node, deps) {
  if (node.source !== "vision_pending") {
    throw new Error(
      `resolveOpaqueNode called on a node that isn't vision_pending (got source="${node.source}")`
    );
  }

  const imageData = await deps.captureRegion(node._el);

  const [faceCount, extractedText] = await Promise.all([
    deps.detectFaces(imageData),
    deps.extractText(imageData),
  ]);

  const value_redacted = classifyOpaqueRegion({ faceCount, extractedText });

  return {
    ...node,
    value_redacted,
    source: "vision",
  };
}

/**
 * Resolve every vision_pending node in a scene-graph's opaqueNodes list.
 * Runs sequentially by design (not Promise.all across nodes) to bound
 * peak client resource usage — SPEC.md explicitly scores client resource
 * utilization, and running N heavy model calls concurrently on a low-end
 * machine is the wrong tradeoff even though it would be faster wall-clock.
 *
 * @param {object[]} opaqueNodes
 * @param {object} deps - same shape as resolveOpaqueNode's deps
 * @returns {Promise<Map<string, object>>} id -> resolved node
 */
export async function resolveAllOpaqueNodes(opaqueNodes, deps) {
  const resolved = new Map();
  for (const node of opaqueNodes) {
    const result = await resolveOpaqueNode(node, deps);
    resolved.set(node.id, result);
  }
  return resolved;
}
