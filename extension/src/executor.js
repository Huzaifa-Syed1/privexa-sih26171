/**
 * executor.js — performs an Action (SPEC.md §5) against the live DOM.
 *
 * This file is the enforcement point for the single most important rule
 * in the whole system: the server can tell us WHICH field to fill and
 * WHAT KIND of value belongs there, but it can never hand back a literal
 * value for a redacted field. If a server response ever contains a
 * literal string where only a value_source enum is allowed, that response
 * is rejected outright — not sanitized, not partially executed. Rejected.
 */

const VALID_ACTIONS = new Set(["click", "fill_local", "scroll", "wait", "done"]);
const VALID_VALUE_SOURCES = new Set([
  "profile.name",
  "profile.email",
  "profile.phone",
  "profile.address",
  "profile.city",
  "profile.state",
  "profile.pincode",
  "profile.dob",
  "credential.current_site.username",
  "credential.current_site.password"
]);

export class ActionRejectedError extends Error {}

/**
 * Validate an action object against the SPEC.md §5 contract.
 * Throws ActionRejectedError with a specific reason on any violation.
 *
 * @param {object} action
 */
export function validateAction(action) {
  if (!action || typeof action !== "object") {
    throw new ActionRejectedError("action is not an object");
  }
  if (!VALID_ACTIONS.has(action.action)) {
    throw new ActionRejectedError(`unknown action type: ${action.action}`);
  }

  if (action.action === "fill_local") {
    if (!action.target_node_id) {
      throw new ActionRejectedError("fill_local action missing target_node_id");
    }
    if (!VALID_VALUE_SOURCES.has(action.value_source)) {
      throw new ActionRejectedError(
        `fill_local action must specify a valid value_source enum, got: ${action.value_source}`
      );
    }
    if ("value" in action) {
      throw new ActionRejectedError(
        "fill_local action contains a literal 'value' field — this is never permitted, " +
        "even alongside a valid value_source"
      );
    }
  }

  if (action.action === "click" && !action.target_node_id) {
    throw new ActionRejectedError("click action missing target_node_id");
  }

  if (action.action === "scroll") {
    if (!["up", "down"].includes(action.direction)) {
      throw new ActionRejectedError("scroll action has invalid direction");
    }
    if (typeof action.amount_px !== "number" || action.amount_px <= 0) {
      throw new ActionRejectedError("scroll action has invalid amount_px");
    }
  }

  return true;
}

/**
 * Resolve a scene-graph node id back to a live DOM element.
 * Requires the caller to have kept the id->element mapping from the last
 * buildSceneGraph() call (scene_graph.js strips _el before the graph is
 * serialized for the network, but the content script keeps a local map).
 *
 * @param {Map<string, Element>} idToElement
 * @param {string} nodeId
 * @returns {Element}
 */
function resolveElement(idToElement, nodeId) {
  const el = idToElement.get(nodeId);
  if (!el) {
    throw new ActionRejectedError(`target_node_id ${nodeId} does not resolve to a live element`);
  }
  return el;
}

/**
 * Execute a validated action.
 *
 * @param {object} action - already passed through validateAction()
 * @param {Map<string, Element>} idToElement - current id -> element map
 * @param {{getLocalValueFor: (nodeId: string, source: string) => string|null}} localSource -
 *   the ONLY permitted source of an actual value for a "fill_local" action.
 */
export function executeAction(action, idToElement, localSource) {
  validateAction(action);

  switch (action.action) {
    case "click": {
      const el = resolveElement(idToElement, action.target_node_id);
      
      // Visual feedback: scroll into view & outline target element in green pulse
      const targetForVisual = el.tagName.toLowerCase() === "option" ? (el.closest("select") || el) : el;
      if (targetForVisual && typeof targetForVisual.scrollIntoView === "function") {
        targetForVisual.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      const originalOutline = targetForVisual.style.outline;
      const originalTransition = targetForVisual.style.transition;
      targetForVisual.style.transition = "outline 0.2s ease-in-out";
      targetForVisual.style.outline = "4px solid #0F9D58";
      setTimeout(() => {
        targetForVisual.style.outline = originalOutline;
        targetForVisual.style.transition = originalTransition;
      }, 1000);

      if (el.tagName.toLowerCase() === "option") {
        const parentSelect = el.closest("select");
        if (parentSelect) {
          parentSelect.value = el.value;
          const idx = Array.from(parentSelect.options).indexOf(el);
          if (idx >= 0) parentSelect.selectedIndex = idx;
          el.selected = true;
          parentSelect.dispatchEvent(new Event("input", { bubbles: true }));
          parentSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (el.tagName.toLowerCase() === "select") {
        el.focus();
        el.dispatchEvent(new Event("click", { bubbles: true }));
        // Smart fallback: if select is clicked directly, choose the cheapest/economy option if available
        const cheapestOpt = Array.from(el.options).find((o) =>
          (o.textContent || "").toLowerCase().includes("cheapest") ||
          (o.textContent || "").toLowerCase().includes("economy")
        );
        if (cheapestOpt) {
          el.value = cheapestOpt.value;
          const idx = Array.from(el.options).indexOf(cheapestOpt);
          if (idx >= 0) el.selectedIndex = idx;
          cheapestOpt.selected = true;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        el.click();
      }
      return { ok: true };
    }

    case "fill_local": {
      const el = resolveElement(idToElement, action.target_node_id);
      
      // Visual feedback: scroll into view & outline target element
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      const originalOutline = el.style.outline;
      el.style.outline = "4px solid #4285F4";
      setTimeout(() => { el.style.outline = originalOutline; }, 1000);

      const value = localSource.getLocalValueFor(action.target_node_id, action.value_source);
      if (value === null || value === undefined) {
        return { ok: false, reason: "no_local_value_available" };
      }

      // Framework compatibility (React/Vue/Angular): set value via native prototype setter
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement?.prototype || el.__proto__,
        "value"
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement?.prototype || el.__proto__,
        "value"
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(el, value);
      } else {
        el.value = value;
      }

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    case "scroll": {
      const delta = action.direction === "down" ? action.amount_px : -action.amount_px;
      window.scrollBy({ top: delta, behavior: "smooth" });
      return { ok: true };
    }

    case "wait": {
      return { ok: true, waited: true };
    }

    case "done": {
      return { ok: true, done: true, summary: action.summary || null };
    }

    default:
      throw new ActionRejectedError(`unhandled action type: ${action.action}`);
  }
}
