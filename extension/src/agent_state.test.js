/**
 * agent_state.test.js — Unit tests for Agent State Manager
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentStateManager, AGENT_STATES } from "./agent_state.js";

describe("AgentStateManager", () => {
  let stateMgr;

  beforeEach(() => {
    stateMgr = new AgentStateManager(5);
  });

  it("initializes with idle state", () => {
    expect(stateMgr.state).toBe(AGENT_STATES.IDLE);
    expect(stateMgr.step).toBe(0);
  });

  it("starts a task and transitions to RUNNING", () => {
    stateMgr.startTask("Fill out form");
    expect(stateMgr.state).toBe(AGENT_STATES.RUNNING);
    expect(stateMgr.taskText).toBe("Fill out form");
  });

  it("pauses and resumes task", () => {
    stateMgr.startTask("Fill out form");
    stateMgr.pause();
    expect(stateMgr.state).toBe(AGENT_STATES.PAUSED);
    stateMgr.resume();
    expect(stateMgr.state).toBe(AGENT_STATES.RUNNING);
  });

  it("halts when exceeding max steps limit", () => {
    stateMgr.startTask("Test limit");
    for (let i = 0; i < 5; i++) {
      expect(stateMgr.nextStep()).toBe(true);
    }
    expect(stateMgr.nextStep()).toBe(false);
    expect(stateMgr.state).toBe(AGENT_STATES.FAILED);
  });

  it("handles high-risk action approval flow", () => {
    stateMgr.startTask("Submit payment");
    const action = { action: "click", target_node_id: "btn-pay" };
    const risk = { level: "HIGH", reason: "Payment submission" };

    stateMgr.requestApproval(action, risk);
    expect(stateMgr.state).toBe(AGENT_STATES.WAITING_FOR_USER);
    expect(stateMgr.pendingAction).toEqual(action);

    const approvedAct = stateMgr.approvePendingAction();
    expect(approvedAct).toEqual(action);
    expect(stateMgr.state).toBe(AGENT_STATES.RUNNING);
  });

  it("calculates dynamic max steps from page complexity", () => {
    stateMgr.setMaxStepsFromPageComplexity(10);
    expect(stateMgr.maxSteps).toBe(30);

    stateMgr.setMaxStepsFromPageComplexity(2);
    expect(stateMgr.maxSteps).toBe(20);
  });
});
