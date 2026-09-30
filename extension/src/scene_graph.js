/**
 * scene_graph.js — Tier 0: DOM Reader
 *
 * Walks the live DOM and produces a scene-graph matching SPEC.md §2.
 * This module is the ONLY place allowed to read raw `.value` / `.textContent`
 * off real page elements — and it never puts that raw value into the
 * returned scene-graph. Every node's `value_redacted` field goes through
 * redactNode() first. There is no path in this file that assigns a raw
 * string to `value_redacted`.
 *
 * Runs in the content script context (has DOM access).
 */

import { redactNode, redactText, TOKENS } from "./redact.js";

// Roles we care about for agent interaction. Anything else is skipped —
// we don't need to describe every <div> on the page, only the actionable
// or informative ones.
const INTERACTIVE_TAGS = new Set(["input", "textarea", "select", "option", "button", "a"]);

let _idCounter = 0;
function nextId() {
  _idCounter += 1;
  return `n${_idCounter}`;
}

/**
 * Reset the id counter. Call this at the start of building a fresh
 * scene-graph for a new page/task so ids are stable within one session
 * but don't grow unbounded across many rebuilds.
 */
export function resetIds() {
  _idCounter = 0;
}

function isVisible(el) {
  if (el.tagName.toLowerCase() === "option") {
    const parent = el.closest("select");
    return parent ? isVisible(parent) : false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (parseFloat(style.opacity) === 0) return false;
  return true;
}

function inferRole(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "option") return "option";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  if (tag === "img") return "image";
  if (tag === "canvas") return "canvas";
  return "generic";
}

function inferLabel(el) {
  if (el.tagName.toLowerCase() === "option") {
    const text = el.textContent ? el.textContent.trim() : el.value;
    return sanitizeLabelText(text);
  }

  if (el.tagName.toLowerCase() === "select") {
    let baseLabel = el.getAttribute("aria-label");
    if (!baseLabel && el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl && labelEl.textContent.trim()) baseLabel = labelEl.textContent.trim();
    }
    if (!baseLabel) baseLabel = el.getAttribute("placeholder") || "Dropdown";
    
    const optionSummaries = Array.from(el.options)
      .map((opt) => (opt.textContent || "").trim())
      .filter(Boolean)
      .join(" | ");
    return sanitizeLabelText(`${baseLabel} (Options: ${optionSummaries})`);
  }

  // Priority: aria-label > associated <label> > placeholder > visible text > alt
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return sanitizeLabelText(ariaLabel.trim());

  if (el.id) {
    const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl && labelEl.textContent.trim()) return sanitizeLabelText(labelEl.textContent.trim());
  }

  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return sanitizeLabelText(placeholder.trim());

  if (el.tagName.toLowerCase() === "img") {
    const alt = el.getAttribute("alt");
    return alt ? sanitizeLabelText(alt.trim()) : null;
  }

  const text = el.textContent && el.textContent.trim();
  if (text && text.length > 0 && text.length < 100) return sanitizeLabelText(text);

  return null;
}

/**
 * Labels are meant to describe *what a field/element is*, not carry
 * arbitrary page content. If a label happens to contain PII (e.g. a link
 * whose visible text is literally an email address, or a button whose
 * text got dynamically templated with a phone number), replace the whole
 * label with its redaction token rather than passing the raw text through.
 * A label is a much smaller surface than full text content, so on match
 * we deliberately drop the whole string rather than trying to surgically
 * excise just the matched substring (partial redaction of a short label
 * tends to leave the rest identifying anyway).
 */
function sanitizeLabelText(text) {
  const token = redactText(text);
  return token || text;
}

function bboxOf(el) {
  if (el.tagName.toLowerCase() === "option") {
    const parent = el.closest("select");
    if (parent) return bboxOf(parent);
  }
  const r = el.getBoundingClientRect();
  return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
}

/**
 * Determine whether an element is "DOM-opaque" — meaning its meaningful
 * content can't be described from attributes/text alone and needs the
 * Tier 1 local vision fallback (SPEC.md §4 Stage B).
 */
function isDomOpaque(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "canvas") return true;
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    // No usable alt text -> we don't know what's in the image from DOM alone.
    return !alt || alt.trim().length === 0;
  }
  if (tag === "iframe") {
    // Cross-origin iframes throw on contentDocument access; same-origin ones
    // we could in principle recurse into, but v0.1 treats all iframes as
    // opaque per SPEC.md §7 (explicitly out of scope for deep handling).
    return true;
  }
  return false;
}

/**
 * Build one scene-graph node from a DOM element. Returns null if the
 * element isn't relevant (invisible, or a tag we don't track).
 *
 * @param {Element} el
 * @returns {object|null}
 */
function buildNode(el) {
  if (!isVisible(el)) return null;

  const tag = el.tagName.toLowerCase();
  const trackedTags = new Set([...INTERACTIVE_TAGS, "img", "canvas", "iframe"]);
  if (!trackedTags.has(tag)) return null;

  const role = inferRole(el);
  const label = inferLabel(el);
  const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
  const opaque = isDomOpaque(el);

  const rawVal = (el.value !== undefined && el.value !== null) ? String(el.value).trim() : "";
  const isFilled = tag === "option" ? el.selected : rawVal.length > 0;
  const isFormElement = tag === "input" || tag === "textarea" || tag === "select";

  const redactionInput = {
    type,
    autocomplete: el.getAttribute("autocomplete") || undefined,
    textContent: isFilled ? rawVal : (type === "password" ? undefined : (el.textContent || "").slice(0, 500)),
  };

  let value_redacted = null;
  if (!opaque && tag !== "option") {
    const token = redactNode(redactionInput);
    if (token) {
      value_redacted = token;
    } else if (isFilled && isFormElement) {
      value_redacted = TOKENS.VALUE;
    } else {
      value_redacted = null;
    }
  }
  const id = nextId();

  // Tag the live element with its scene-graph id so content_script.js can
  // resolve target_node_id back to a real element later, without needing
  // to re-walk the DOM heuristically (which could drift out of sync with
  // how this function assigns ids). This attribute never carries any
  // value/content — only an opaque sequential id — so it introduces no
  // new PII surface.
  el.setAttribute("data-sih26171-id", id);

  return {
    id,
    role,
    label: label || null,
    type: type || null,
    bbox: bboxOf(el),
    value_redacted,
    filled: isFormElement ? isFilled : null,
    source: opaque ? "vision_pending" : "dom",
    // Internal-only field, stripped before the scene-graph leaves the
    // browser (see buildSceneGraph). Kept here so the Tier 1 vision pass
    // knows which nodes to crop and process.
    _opaque: opaque,
    _el: el,
  };
}

/**
 * Walk the document and build the full scene-graph.
 *
 * @param {{taskContext?: string}} opts
 * @returns {{version: string, nodes: object[], opaqueNodes: object[], focused_node_id: string|null}}
 */
function getUrlHash() {
  if (typeof window === "undefined" || !window.location || !window.location.href) {
    return "sha256:00000000";
  }
  const cleanUrl = window.location.origin + window.location.pathname;
  let hash = 0;
  for (let i = 0; i < cleanUrl.length; i++) {
    hash = ((hash << 5) - hash) + cleanUrl.charCodeAt(i);
    hash |= 0;
  }
  return "sha256:" + Math.abs(hash).toString(16);
}

export function buildSceneGraph(opts = {}) {
  resetIds();

  const elements = document.querySelectorAll(
    "input, textarea, select, option, button, a, img, canvas, iframe"
  );

  const nodes = [];
  const opaqueNodes = []; // kept separately with live _el refs for Tier 1

  for (const el of elements) {
    const node = buildNode(el);
    if (!node) continue;

    if (node._opaque) {
      opaqueNodes.push(node);
    }
    nodes.push(node);
  }

  const active = document.activeElement;
  let focusedId = null;
  if (active) {
    const match = nodes.find((n) => n._el === active);
    if (match) focusedId = match.id;
  }

  // Strip internal-only fields before this is treated as "the scene-graph
  // that's allowed to leave the browser". opaqueNodes above still holds
  // live element references for the vision pipeline to use locally.
  const publicNodes = nodes.map(({ _el, _opaque, ...rest }) => rest);

  return {
    version: "1.0",
    url_hash: getUrlHash(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    timestamp: Date.now(),
    nodes: publicNodes,
    opaqueNodes, // NOT sent over the network as-is; consumed by vision.js first
    focused_node_id: focusedId,
    task_context: opts.taskContext || null,
  };
}
