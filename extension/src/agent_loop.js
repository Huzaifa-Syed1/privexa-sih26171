/**
 * agent_loop.js — Autonomous Multi-Step Agent Loop for Prism.
 *
 * SPEC / Invariants:
 * 1. Natural Language Task -> Local Observation -> PII Redaction -> Tier 1 Local Vision (if needed)
 *    -> Sanitized Scene Graph to Server -> Planner Action -> Action Validation -> Risk Classification
 *    -> [User Approval if HIGH Risk] -> Safe Local Action -> Re-Observe -> Re-Plan -> Loop.
 * 2. Raw PII & Credentials NEVER cross the network.
 * 3. Planner action containing literal secret values is REJECTED.
 * 4. High-risk actions (submit, payment, delete, purchase) MUST pause and require explicit user approval.
 */

import { buildSceneGraph } from "./scene_graph.js";
import { validateAction, executeAction, ActionRejectedError } from "./executor.js";
import { classifyActionRisk, RISK_LEVELS } from "./safety.js";
import { agentState, AGENT_STATES } from "./agent_state.js";
import { prismUI } from "./prism_ui.js";
import { vault } from "./profile_vault.js";

const SERVER_URL = "http://127.0.0.1:8000/plan";

let currentIdToElement = new Map();

export const localValueSource = {
  getLocalValueFor(nodeId, source) {
    const domain = typeof window !== "undefined" && window.location ? window.location.hostname : "default";
    if (source) {
      const val = vault.getValueBySource(source, domain);
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
  if (typeof document === "undefined") return map;
  const allElements = document.querySelectorAll(
    "input, textarea, select, button, a, img, canvas, iframe"
  );
  for (const el of allElements) {
    const id = el.getAttribute("data-sih26171-id");
    if (id) map.set(id, el);
  }
  return map;
}

export async function sendSceneGraphToServer(graph, serverUrl = SERVER_URL) {
  const unresolvedOpaque = graph.nodes.filter((n) => n.source === "vision_pending");
  if (unresolvedOpaque.length > 0) {
    throw new Error(
      `refusing to send scene-graph: ${unresolvedOpaque.length} node(s) still have unresolved source="vision_pending"`
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
    action_history: graph.action_history || [],
  };

  const maxRetries = 3;
  let lastError = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage) {
        const response = await chrome.runtime.sendMessage({
          type: "send_scene_graph",
          serverUrl,
          payload,
        });
        if (!response || !response.ok) {
          const detail = response?.detail || "background service worker failed to reach server";
          if (i < maxRetries - 1 && (detail.includes("429") || detail.includes("502") || detail.includes("503"))) {
            await new Promise((r) => setTimeout(r, (i + 1) * 2000));
            continue;
          }
          throw new Error(detail);
        }
        return response.plan;
      }

      const res = await fetch(serverUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let detail = `server returned status ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson && errJson.detail) {
            detail = `server returned status ${res.status}: ${errJson.detail}`;
          }
        } catch (_) {}

        if (i < maxRetries - 1 && (res.status === 429 || res.status === 502 || res.status === 503)) {
          await new Promise((r) => setTimeout(r, (i + 1) * 2000));
          continue;
        }
        throw new Error(detail);
      }

      return await res.json();
    } catch (err) {
      lastError = err;
      if (i < maxRetries - 1 && (err.message.includes("429") || err.message.includes("502") || err.message.includes("503"))) {
        await new Promise((r) => setTimeout(r, (i + 1) * 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Failed to send scene graph to server");
}

/**
 * Execute a single cycle of the agent loop to fetch a Plan.
 */
export async function runPlanningCycle(taskContext, resolveOpaqueFn = null, serverUrl = SERVER_URL) {
  const graph = buildSceneGraph({ taskContext });
  currentIdToElement = rebuildIdMap(graph);

  if (agentState && agentState.history) {
    graph.action_history = agentState.history.slice(-10).map(
      (item) => `Step ${item.step}: ${item.action} action on ${item.target || "page"} (${item.status})`
    );
  }

  const redactedNodes = graph.nodes.filter((n) => n.value_redacted && n.value_redacted.startsWith("<REDACTED"));
  agentState.piiRedactedCount += redactedNodes.length;

  if (graph.opaqueNodes.length > 0 && resolveOpaqueFn) {
    agentState.visionCount += graph.opaqueNodes.length;
    try {
      const resolvedMap = await resolveOpaqueFn(graph.opaqueNodes);
      graph.nodes = graph.nodes.map((n) => resolvedMap.get(n.id) || n);
    } catch (err) {
      console.warn("[prism] Vision resolution failed, applying safe redacted fallback:", err);
      graph.nodes = graph.nodes.map((n) => {
        if (n.source === "vision_pending") {
          return { ...n, value_redacted: "<REDACTED:opaque_image>", source: "vision" };
        }
        return n;
      });
    }
  }

  const plan = await sendSceneGraphToServer(graph, serverUrl);
  
  if (!plan || !plan.actions || !Array.isArray(plan.actions)) {
      throw new Error("Server did not return a valid Plan object with actions array");
  }

  for (const action of plan.actions) {
      validateAction(action);
  }

  return { plan, graph };
}

/**
 * Run the autonomous multi-step agent loop until completed, failed, or stopped.
 */
export async function runAgentLoop(taskText, options = {}) {
  const {
    resolveOpaqueFn = null,
    serverUrl = SERVER_URL,
    delayBetweenStepsMs = 600,
    requestUserApprovalFn = null,
  } = options;

  await vault.load();
  agentState.startTask(taskText);

  // Set dynamic max steps budget based on initial page complexity
  const initialGraph = buildSceneGraph({ taskContext: taskText });
  agentState.setMaxStepsFromPageComplexity(initialGraph.nodes.length);

  prismUI.update(agentState);

  while (agentState.state === AGENT_STATES.RUNNING) {
    if (!agentState.nextStep()) {
      prismUI.update(agentState);
      break;
    }

    agentState.statusMessage = `Observing page for step ${agentState.step}...`;
    prismUI.update(agentState);

    let planningResult;
    try {
      planningResult = await runPlanningCycle(taskText, resolveOpaqueFn, serverUrl);
    } catch (err) {
      console.error("[prism/agent_loop] Planning Cycle failed:", err);
      if (err instanceof ActionRejectedError) {
        agentState.fail(`Server plan rejected: ${err.message}`);
      } else {
        agentState.fail(`Planning Cycle error: ${err.message}`);
      }
      prismUI.update(agentState);
      break;
    }

    const { plan } = planningResult;
    let cycleBroken = false;

    // Batch execute actions in the plan
    for (const action of plan.actions) {
      if (agentState.state !== AGENT_STATES.RUNNING) {
        cycleBroken = true;
        break; // Stop executing batch if state changed (e.g., user stopped)
      }
      
      const targetElement = action.target_node_id ? currentIdToElement.get(action.target_node_id) : null;
      const risk = classifyActionRisk(action, targetElement);

      if (action.action === "done") {
        const summary = action.summary || "Task completed successfully.";
        agentState.recordStep(action, { ok: true }, risk);
        agentState.complete(summary);
        prismUI.update(agentState);
        cycleBroken = true;
        break;
      }

      // Risk assessment & User approval check
      if (risk.level === RISK_LEVELS.HIGH) {
        agentState.requestApproval(action, risk);
        prismUI.update(agentState);

        let approved = false;
        if (requestUserApprovalFn) {
          approved = await requestUserApprovalFn(action, risk);
        } else {
          approved = await waitForUIApproval();
        }

        if (!approved) {
          agentState.rejectPendingAction();
          prismUI.update(agentState);
          cycleBroken = true;
          break;
        }
        agentState.approvePendingAction();
        prismUI.update(agentState);
      }

      // Execute safe action
      const reasoningTxt = action.reasoning ? ` (${action.reasoning})` : "";
      agentState.statusMessage = `Executing ${action.action} on ${action.target_node_id || "page"}${reasoningTxt}...`;
      prismUI.update(agentState);

      let execResult;
      try {
        execResult = executeAction(action, currentIdToElement, localValueSource);
      } catch (err) {
        execResult = { ok: false, reason: err.message };
      }

      agentState.recordStep(action, execResult, risk);
      prismUI.update(agentState);

      if (!execResult.ok) {
        agentState.retries += 1;
        if (agentState.retries > agentState.maxRetriesPerAction) {
          agentState.fail(`Failed to execute ${action.action} after ${agentState.maxRetriesPerAction} retries.`);
          prismUI.update(agentState);
          cycleBroken = true;
          break;
        }
        // Wait and break out of the batch to re-observe the DOM if execution fails
        await new Promise((res) => setTimeout(res, 500));
        cycleBroken = true;
        break;
      }

      await new Promise((res) => setTimeout(res, delayBetweenStepsMs));
    }
    
    // Once the plan (batch) is completed or broken (due to failure), the while loop continues to re-observe.
  }

  return agentState;
}

function waitForUIApproval() {
  return new Promise((resolve) => {
    prismUI.onApproveAction = () => resolve(true);
    prismUI.onRejectAction = () => resolve(false);
  });
}
