/**
 * agent_state.js — In-memory Task State and History for Prism Agent.
 *
 * Privacy Invariant:
 * Task history records ONLY step numbers, action types, and non-sensitive node IDs/roles.
 * Raw PII and passwords are NEVER recorded in task history.
 */

export const AGENT_STATES = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  WAITING_FOR_USER: "waiting_for_user",
  COMPLETED: "completed",
  FAILED: "failed",
});

export class AgentStateManager {
  constructor(maxSteps = 50) {
    this.maxSteps = maxSteps;
    this.reset();
  }

  setMaxStepsFromPageComplexity(interactiveElementCount) {
    this.maxSteps = Math.max(20, (interactiveElementCount || 0) * 3);
  }

  reset() {
    this.taskId = "task_" + Math.random().toString(36).substring(2, 9);
    this.taskText = "";
    this.state = AGENT_STATES.IDLE;
    this.step = 0;
    this.retries = 0;
    this.maxRetriesPerAction = 3;
    this.history = [];
    this.pendingAction = null;
    this.pendingRisk = null;
    this.statusMessage = "Prism ready";
    this.piiRedactedCount = 0;
    this.visionCount = 0;
  }

  startTask(taskText) {
    this.reset();
    this.taskText = taskText;
    this.state = AGENT_STATES.RUNNING;
    this.statusMessage = "Agent started task: " + taskText;
  }

  pause() {
    if (this.state === AGENT_STATES.RUNNING) {
      this.state = AGENT_STATES.PAUSED;
      this.statusMessage = "Agent paused by user.";
    }
  }

  resume() {
    if (this.state === AGENT_STATES.PAUSED) {
      this.state = AGENT_STATES.RUNNING;
      this.statusMessage = "Agent resumed.";
    }
  }

  stop() {
    this.state = AGENT_STATES.FAILED;
    this.statusMessage = "Agent stopped by user.";
  }

  nextStep() {
    this.step += 1;
    if (this.step > this.maxSteps) {
      this.state = AGENT_STATES.FAILED;
      this.statusMessage = `Task halted: reached maximum steps limit (${this.maxSteps}).`;
      return false;
    }
    return true;
  }

  recordStep(action, result, risk) {
    this.retries = 0;
    const item = {
      step: this.step,
      action: action.action,
      target: action.target_node_id || null,
      risk: risk.level,
      status: result.ok ? "completed" : "failed",
      timestamp: Date.now(),
    };
    this.history.push(item);
  }

  requestApproval(action, risk) {
    this.pendingAction = action;
    this.pendingRisk = risk;
    this.state = AGENT_STATES.WAITING_FOR_USER;
    this.statusMessage = risk.reason || "Action requires user approval.";
  }

  approvePendingAction() {
    const act = this.pendingAction;
    this.pendingAction = null;
    this.pendingRisk = null;
    this.state = AGENT_STATES.RUNNING;
    this.statusMessage = "Action approved by user. Resuming...";
    return act;
  }

  rejectPendingAction() {
    this.pendingAction = null;
    this.pendingRisk = null;
    this.state = AGENT_STATES.FAILED;
    this.statusMessage = "High-risk action rejected by user. Task stopped.";
  }

  complete(summary = "Task completed successfully.") {
    this.state = AGENT_STATES.COMPLETED;
    this.statusMessage = summary;
  }

  fail(reason = "Task failed.") {
    this.state = AGENT_STATES.FAILED;
    this.statusMessage = reason;
  }
}

export const agentState = new AgentStateManager();
