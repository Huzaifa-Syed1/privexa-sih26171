/**
 * agent_loop.test.js — Unit tests for Autonomous Multi-Step Agent Loop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAgentLoop, sendSceneGraphToServer } from "./agent_loop.js";
import { agentState, AGENT_STATES } from "./agent_state.js";

describe("agent_loop", () => {
  let originalFetch;

  beforeEach(() => {
    document.body.innerHTML = `
      <form id="regForm">
        <input type="text" id="username" name="username" />
        <input type="email" id="email" name="email" />
        <button type="button" id="submitBtn">Submit Application</button>
      </form>
    `;
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("refuses to send graph if vision_pending nodes remain unresolved", async () => {
    const graph = {
      version: "1.0",
      url_hash: "test",
      viewport: { w: 100, h: 100 },
      timestamp: Date.now(),
      nodes: [{ id: "n1", source: "vision_pending" }],
      focused_node_id: null,
      task_context: "test",
    };

    await expect(sendSceneGraphToServer(graph, "http://localhost:8000/plan")).rejects.toThrow(
      /unresolved source="vision_pending"/
    );
  });

  it("runs a multi-step loop completing when server returns done", async () => {
    let stepCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      stepCount++;
      if (stepCount === 1) {
        return {
          ok: true,
          json: async () => ({ actions: [{ action: "click", target_node_id: "n1" }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({ actions: [{ action: "done", summary: "Form processed successfully" }] }),
      };
    });

    const resultState = await runAgentLoop("Fill form", {
      serverUrl: "http://localhost:8000/plan",
      delayBetweenStepsMs: 10,
    });

    expect(resultState.state).toBe(AGENT_STATES.COMPLETED);
    expect(resultState.statusMessage).toBe("Form processed successfully");
  });

  it("pauses and requests approval on high-risk actions", async () => {
    const btn = document.getElementById("submitBtn");
    btn.setAttribute("data-sih26171-id", "n3");

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ actions: [{ action: "click", target_node_id: "n3" }] }),
    });

    const approvalHandler = vi.fn().mockResolvedValue(false); // Reject approval

    const resultState = await runAgentLoop("Submit app", {
      serverUrl: "http://localhost:8000/plan",
      delayBetweenStepsMs: 10,
      requestUserApprovalFn: approvalHandler,
    });

    expect(approvalHandler).toHaveBeenCalled();
    expect(resultState.state).toBe(AGENT_STATES.FAILED);
    expect(resultState.statusMessage).toContain("rejected by user");
  });
});
