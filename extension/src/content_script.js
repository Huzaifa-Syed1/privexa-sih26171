/**
 * content_script.js — orchestration layer.
 *
 * Deliberately thin. All the logic that actually matters (redaction,
 * scene-graph construction, action validation) lives in tested modules.
 * This file's only job is wiring: build graph -> resolve opaque nodes
 * via the offscreen document -> send -> validate response -> execute.
 *
 * IMPORTANT: this file does NOT import vision.js/model_adapters.js
 * directly. TensorFlow.js + BlazeFace + Tesseract.js are ~2MB+ of WASM/JS
 * — bundling them into the content script would mean every single tab
 * the user has open pays that load cost, which directly contradicts
 * SPEC.md §4's client-resource-utilization goals. Instead, opaque-node
 * resolution is delegated to an offscreen document (offscreen.js, which
 * DOES import vision.js/model_adapters.js) via chrome.runtime messaging.
 * The offscreen document is created lazily and only when a page actually
 * has opaque nodes to resolve — most pages never trigger it at all.
 *
 * NOTE: This file is written as ES modules for clarity and to match the
 * tested source files directly. Chrome MV3 content scripts don't load ES
 * modules by default — see build.js for the bundling step (esbuild) that
 * produces the actual content_script.js loaded by manifest.json. Bundling
 * introduces zero logic changes — it only concatenates these tested
 * modules, which is exactly why the unit tests above are trustworthy for
 * the bundled output too.
 */

import { buildSceneGraph } from "./scene_graph.js";
import { validateAction, executeAction, ActionRejectedError } from "./executor.js";
import { vault } from "./profile_vault.js";
import { prismUI } from "./prism_ui.js";
import { agentState } from "./agent_state.js";
import { runAgentLoop } from "./agent_loop.js";

const SERVER_URL = "http://127.0.0.1:8000/plan";

// Rebuilt on every buildSceneGraph() call from the (locally-held) opaque
// node list + the visible node list, so we can resolve ids back to real
// elements when executing actions. Never sent over the network.
let currentIdToElement = new Map();

/**
 * The only permitted source of literal values for "type" actions, per
 * executor.js's contract.
 */
const localValueSource = {
  getLocalValueFor(nodeId, valueSource) {
    const domain = typeof window !== "undefined" && window.location ? window.location.hostname : "default";
    if (valueSource) {
      const val = vault.getValueBySource(valueSource, domain);
      if (val !== null && val !== undefined) return val;
    }
    const el = currentIdToElement.get(nodeId);
    if (el) {
      const val = vault.resolveLocalValue(el, domain);
      if (val !== null && val !== undefined) return val;
      return el.value || null;
    }
    return null;
  },
};

function rebuildIdMap(graph) {
  const map = new Map();
  const allElements = document.querySelectorAll(
    "input, textarea, select, button, a, img, canvas, iframe"
  );
  // Re-walk in the same order scene_graph.js does, matching by index is
  // fragile across DOM mutations, so instead we tag elements with a data
  // attribute during buildSceneGraph and read it back here.
  for (const el of allElements) {
    const id = el.getAttribute("data-sih26171-id");
    if (id) map.set(id, el);
  }
  return map;
}

async function sendSceneGraphToServer(graph) {
  const unresolvedOpaque = graph.nodes.filter((n) => n.source === "vision_pending");
  if (unresolvedOpaque.length > 0) {
    throw new Error(
      `refusing to send scene-graph: ${unresolvedOpaque.length} node(s) still ` +
      `have unresolved source="vision_pending" — run Tier 1 vision first`
    );
  }

  const payload = {
    version: graph.version,
    url_hash: graph.url_hash,
    viewport: graph.viewport,
    timestamp: graph.timestamp,
    nodes: graph.nodes,
    focused_node_id: graph.focused_node_id,
    task_context: graph.task_context,
  };

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
    const response = await chrome.runtime.sendMessage({
      type: "send_scene_graph",
      serverUrl: SERVER_URL,
      payload,
    });
    if (!response || !response.ok) {
      throw new Error(response?.detail || "background service worker failed to reach server");
    }
    return response.plan;
  }

  const res = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`server returned ${res.status}`);
  }

  return res.json();
}

/**
 * One full cycle: read the page, send the sanitized graph, execute
 * whatever the server says to do. Exported for testing; wired to a
 * trigger (button click / periodic tick) in background.js.
 */
export async function runAgentCycle(taskContext) {
  console.log("[sih26171] 🚀 Agent cycle started...");
  const graph = buildSceneGraph({ taskContext });
  currentIdToElement = rebuildIdMap(graph);

  if (graph.opaqueNodes.length > 0) {
    console.log(`[sih26171] Resolving ${graph.opaqueNodes.length} opaque node(s) via Tier 1 Vision...`);
    let resolvedMap;
    try {
      resolvedMap = await resolveOpaqueNodesViaOffscreen(graph.opaqueNodes);
    } catch (err) {
      console.error("[sih26171] vision resolution failed:", err);
      return { ok: false, reason: "vision_error", detail: String(err) };
    }
    graph.nodes = graph.nodes.map((n) => resolvedMap.get(n.id) || n);
  }

  console.log("[sih26171] Sending sanitized scene graph to server:", graph);

  let plan;
  try {
    plan = await sendSceneGraphToServer(graph);
    console.log("[sih26171] 📩 Received plan from server:", plan);
  } catch (err) {
    console.error("[sih26171] failed to get a plan from server:", err);
    return { ok: false, reason: "server_error", detail: String(err) };
  }

  try {
    if (!plan || !plan.actions || !Array.isArray(plan.actions)) {
      throw new Error("Server response missing actions array");
    }
    for (const action of plan.actions) {
      validateAction(action);
    }
  } catch (err) {
    if (err instanceof ActionRejectedError) {
      console.error("[sih26171] REJECTED server action:", err.message, plan);
      return { ok: false, reason: "action_rejected", detail: err.message };
    }
    return { ok: false, reason: "action_rejected", detail: err.message || String(err) };
  }

  let finalResult = { ok: true };
  for (const action of plan.actions) {
    const result = executeAction(action, currentIdToElement, localValueSource);
    console.log("[sih26171] ✅ Action execution result:", result);
    if (!result.ok) {
      finalResult = result;
      break;
    }
  }
  return finalResult;
}

/**
 * Crop each opaque node's live element into a transferable image
 * (dataURL — small, JSON/message-safe) and delegate the actual face/OCR
 * inference to the offscreen document. This function contains NO model
 * logic itself — it is pure glue, matching the "thin orchestration,
 * tested logic lives elsewhere" pattern used throughout this codebase.
 * The classification logic it depends on (vision.js's
 * classifyOpaqueRegion) is tested independently in vision.test.js; this
 * function is exercised in content_script.test.js with the messaging
 * layer mocked.
 *
 * @param {object[]} opaqueNodes - nodes with source==="vision_pending" and a live _el
 * @returns {Promise<Map<string, object>>} id -> resolved node (source:"vision")
 */
async function resolveOpaqueNodesViaOffscreen(opaqueNodes) {
  

  const crops = opaqueNodes.map((node) => ({
    id: node.id,
    dataUrl: cropElementToDataUrl(node._el),
  }));

  const response = await chrome.runtime.sendMessage({
    type: "resolve_opaque_nodes",
    crops,
  });

  if (!response || !response.ok) {
    throw new Error(response?.detail || "offscreen document returned no result");
  }

  const resolved = new Map();
  for (const node of opaqueNodes) {
    const tokenResult = response.results[node.id];
    resolved.set(node.id, {
      ...node,
      value_redacted: tokenResult ?? null,
      source: "vision",
    });
  }
  return resolved;
}

function cropElementToDataUrl(el) {
  const rect = el.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const ctx = canvas.getContext("2d");
  const tag = el.tagName.toLowerCase();

  try {
    if (tag === "canvas" || tag === "img") {
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.log("[sih26171] Tainted canvas or drawImage handled safely for element:", tag);
    try {
      const blank = document.createElement("canvas");
      blank.width = 1;
      blank.height = 1;
      return blank.toDataURL("image/png");
    } catch (e) {
      throw err;
    }
  }
}



// Wire up to the background service worker. Guarded by a typeof check so
// this file stays importable/testable under vitest (no `chrome` global
// there) without needing a browser-extension test harness just to load
// the module.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "run_cycle") return false;

    runAgentCycle(message.taskContext)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("[sih26171] unexpected error during agent cycle:", err);
        sendResponse({ ok: false, reason: "unexpected_error", detail: String(err) });
      });

    return true; // keep the message channel open for the async sendResponse
  });
}

// Initialize Prism Floating Control Panel UI on page load
if (typeof document !== "undefined" && typeof window !== "undefined") {
  const initUI = () => {
    try {
      prismUI.init();
      prismUI.onStartTask = (taskText) => {
        runAgentLoop(taskText, {
          resolveOpaqueFn: resolveOpaqueNodesViaOffscreen,
        });
      };
      prismUI.onPauseTask = () => {
        agentState.pause();
        prismUI.update(agentState);
      };
      prismUI.onStopTask = () => {
        agentState.stop();
        prismUI.update(agentState);
      };
    } catch (err) {
      console.warn("[prism] UI initialization skipped or failed:", err);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUI);
  } else {
    initUI();
  }
}
