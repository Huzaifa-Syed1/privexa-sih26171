/**
 * prism_ui.js — Floating Prism UI (Shadow DOM Control Panel)
 *
 * Provides a non-intrusive, sleek floating UI widget for the browser agent.
 * Encapsulated in a Shadow DOM to isolate styles from the host webpage.
 * Displays live task progress, privacy metrics, risk approval modal, and local vault settings.
 */

import { vault } from "./profile_vault.js";

class PrismUI {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.panelVisible = false;
    this.vaultVisible = false;
    this.onStartTask = null;
    this.onPauseTask = null;
    this.onStopTask = null;
    this.onApproveAction = null;
    this.onRejectAction = null;
  }

  init() {
    if (this.host) return;

    this.host = document.createElement("privexa-agent-root");
    this.host.style.cssText = "position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #e0e6ed;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }

      .prism-trigger {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 54px;
        height: 54px;
        border-radius: 50%;
        background: linear-gradient(135deg, #10b981 0%, #3b82f6 100%);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
        z-index: 2147483647;
      }
      .prism-trigger:hover {
        transform: scale(1.08);
        box-shadow: 0 12px 32px rgba(16, 185, 129, 0.5);
      }
      .prism-trigger svg {
        width: 26px;
        height: 26px;
        fill: none;
        stroke: #ffffff;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .prism-trigger .badge-dot {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #10b981;
        border: 2px solid #0f172a;
      }

      .prism-panel {
        position: fixed;
        bottom: 84px;
        right: 20px;
        width: 380px;
        max-height: 580px;
        background: rgba(15, 23, 42, 0.95);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 16px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: opacity 0.2s ease, transform 0.2s ease;
        z-index: 2147483647;
      }
      .prism-panel.hidden {
        opacity: 0;
        transform: translateY(20px) scale(0.95);
        pointer-events: none;
      }

      .header {
        padding: 14px 16px;
        background: rgba(30, 41, 59, 0.8);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .title-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .logo {
        font-weight: 700;
        font-size: 15px;
        letter-spacing: 0.5px;
        background: linear-gradient(135deg, #34d399 0%, #60a5fa 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .badge-privacy {
        font-size: 10px;
        padding: 3px 7px;
        border-radius: 99px;
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border: 1px solid rgba(52, 211, 153, 0.3);
      }
      .btn-icon {
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        padding: 4px;
      }
      .btn-icon:hover { color: #f8fafc; }

      .body {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        overflow-y: auto;
      }

      .task-box {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      textarea.task-input {
        width: 100%;
        height: 64px;
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 10px;
        color: #f8fafc;
        font-size: 13px;
        resize: none;
        outline: none;
      }
      textarea.task-input:focus { border-color: #3b82f6; }

      .controls {
        display: flex;
        gap: 8px;
      }
      .btn {
        flex: 1;
        padding: 9px 12px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        border: none;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .btn-primary { background: #2563eb; color: #fff; }
      .btn-primary:hover { background: #1d4ed8; }
      .btn-secondary { background: #334155; color: #cbd5e1; }
      .btn-secondary:hover { background: #475569; }
      .btn-danger { background: #dc2626; color: #fff; }
      .btn-danger:hover { background: #b91c1c; }

      .status-card {
        background: #1e293b;
        border-radius: 10px;
        padding: 12px;
        font-size: 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .status-header {
        display: flex;
        justify-content: space-between;
        color: #94a3b8;
        font-weight: 600;
      }
      .status-text { color: #38bdf8; font-weight: 500; }

      .privacy-bar {
        background: rgba(16, 185, 129, 0.08);
        border: 1px solid rgba(16, 185, 129, 0.2);
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 11px;
        color: #34d399;
        display: flex;
        justify-content: space-between;
      }

      .log-list {
        max-height: 110px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-family: monospace;
        font-size: 11px;
      }
      .log-item {
        padding: 4px 6px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.03);
        color: #cbd5e1;
      }

      .approval-overlay {
        background: rgba(220, 38, 38, 0.15);
        border: 1px solid #ef4444;
        border-radius: 10px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .approval-title {
        font-weight: 700;
        color: #f87171;
        font-size: 12px;
      }

      .vault-drawer {
        background: #0f172a;
        border-top: 1px solid #334155;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-size: 12px;
      }
      .form-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .form-row label { color: #94a3b8; font-size: 10px; }
      .form-row input {
        background: #1e293b;
        border: 1px solid #334155;
        color: #fff;
        padding: 6px;
        border-radius: 6px;
        font-size: 12px;
      }
    `;

    this.shadow.appendChild(style);

    const container = document.createElement("div");
    container.innerHTML = `
      <div class="prism-trigger" id="triggerBtn" title="Privexa Privacy Agent">
        <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        <div class="badge-dot" id="statusDot"></div>
      </div>

      <div class="prism-panel hidden" id="panel">
        <div class="header">
          <div class="title-group">
            <span class="logo">PRIVEXA</span>
            <span class="badge-privacy">100% Local PII</span>
          </div>
          <div>
            <button class="btn-icon" id="vaultToggleBtn" title="Local Vault">🔑</button>
            <button class="btn-icon" id="closePanelBtn">✕</button>
          </div>
        </div>

        <div class="body">
          <div class="task-box">
            <textarea class="task-input" id="taskInput" placeholder="Enter browser instruction (e.g., 'Fill registration form using saved profile but do not submit')"></textarea>
            <div class="controls">
              <button class="btn btn-primary" id="startBtn">Run Task</button>
              <button class="btn btn-secondary" id="pauseBtn">Pause</button>
              <button class="btn btn-danger" id="stopBtn">Stop</button>
            </div>
          </div>

          <div class="privacy-bar">
            <span>🛡️ PII Sent: <b>0</b></span>
            <span>Local Redaction: <b>Active</b></span>
          </div>

          <div class="status-card">
            <div class="status-header">
              <span>STATE: <b id="stateLabel">IDLE</b></span>
              <span id="stepLabel">Step 0/--</span>
            </div>
            <div class="status-text" id="statusMessage">Ready for instruction.</div>
          </div>

          <div id="approvalArea" style="display: none;"></div>

          <div class="log-list" id="logList">
            <div class="log-item">Privexa agent initialized.</div>
          </div>

          <div class="vault-drawer" id="vaultDrawer" style="display: none;">
            <div style="font-weight: 700; color: #60a5fa;">Local Vault (Never sent to AI)</div>
            <div class="form-row">
              <label>FULL NAME</label>
              <input type="text" id="vaultName" />
            </div>
            <div class="form-row">
              <label>EMAIL</label>
              <input type="email" id="vaultEmail" />
            </div>
            <div class="form-row">
              <label>PHONE</label>
              <input type="text" id="vaultPhone" />
            </div>
            <div class="form-row">
              <label>ADDRESS</label>
              <input type="text" id="vaultAddress" />
            </div>
            <button class="btn btn-primary" id="saveVaultBtn" style="margin-top: 6px;">Save Vault</button>
          </div>
        </div>
      </div>
    `;

    this.shadow.appendChild(container);
    document.documentElement.appendChild(this.host);

    this._bindEvents();
    this._loadVaultUI();
  }

  _bindEvents() {
    const trigger = this.shadow.getElementById("triggerBtn");
    const panel = this.shadow.getElementById("panel");
    const closeBtn = this.shadow.getElementById("closePanelBtn");
    const vaultToggle = this.shadow.getElementById("vaultToggleBtn");
    const vaultDrawer = this.shadow.getElementById("vaultDrawer");
    const saveVaultBtn = this.shadow.getElementById("saveVaultBtn");

    trigger.addEventListener("click", () => {
      this.panelVisible = !this.panelVisible;
      panel.classList.toggle("hidden", !this.panelVisible);
    });

    closeBtn.addEventListener("click", () => {
      this.panelVisible = false;
      panel.classList.add("hidden");
    });

    vaultToggle.addEventListener("click", () => {
      this.vaultVisible = !this.vaultVisible;
      vaultDrawer.style.display = this.vaultVisible ? "flex" : "none";
    });

    saveVaultBtn.addEventListener("click", async () => {
      const name = this.shadow.getElementById("vaultName").value;
      const email = this.shadow.getElementById("vaultEmail").value;
      const phone = this.shadow.getElementById("vaultPhone").value;
      const address = this.shadow.getElementById("vaultAddress").value;
      await vault.setProfile({ name, email, phone, address });
      alert("Local profile updated successfully!");
      this.vaultVisible = false;
      vaultDrawer.style.display = "none";
    });

    this.shadow.getElementById("startBtn").addEventListener("click", () => {
      const text = this.shadow.getElementById("taskInput").value.trim();
      if (text && this.onStartTask) this.onStartTask(text);
    });

    this.shadow.getElementById("pauseBtn").addEventListener("click", () => {
      if (this.onPauseTask) this.onPauseTask();
    });

    this.shadow.getElementById("stopBtn").addEventListener("click", () => {
      if (this.onStopTask) this.onStopTask();
    });
  }

  async _loadVaultUI() {
    await vault.load();
    const p = typeof vault.getProfile === "function" ? vault.getProfile() : (vault.profile || {});
    this.shadow.getElementById("vaultName").value = p.name || "";
    this.shadow.getElementById("vaultEmail").value = p.email || "";
    this.shadow.getElementById("vaultPhone").value = p.phone || "";
    this.shadow.getElementById("vaultAddress").value = p.address || "";
  }

  update(agentState) {
    if (!this.shadow) return;

    const stateLabel = this.shadow.getElementById("stateLabel");
    const stepLabel = this.shadow.getElementById("stepLabel");
    const statusMessage = this.shadow.getElementById("statusMessage");
    const statusDot = this.shadow.getElementById("statusDot");
    const approvalArea = this.shadow.getElementById("approvalArea");
    const logList = this.shadow.getElementById("logList");

    stateLabel.textContent = agentState.state.toUpperCase();
    stepLabel.textContent = `Step ${agentState.step}/${agentState.maxSteps}`;
    statusMessage.textContent = agentState.statusMessage;

    if (agentState.state === "running") {
      statusDot.style.background = "#3b82f6";
    } else if (agentState.state === "waiting_for_user") {
      statusDot.style.background = "#ef4444";
    } else if (agentState.state === "completed") {
      statusDot.style.background = "#10b981";
    } else {
      statusDot.style.background = "#64748b";
    }

    if (agentState.state === "waiting_for_user" && agentState.pendingRisk) {
      approvalArea.style.display = "block";
      approvalArea.innerHTML = `
        <div class="approval-overlay">
          <div class="approval-title">⚠️ HIGH RISK ACTION REQUIRES APPROVAL</div>
          <div>${agentState.pendingRisk.reason}</div>
          <div class="controls" style="margin-top: 6px;">
            <button class="btn btn-primary" id="approveBtn">Approve Action</button>
            <button class="btn btn-danger" id="rejectBtn">Cancel</button>
          </div>
        </div>
      `;
      this.shadow.getElementById("approveBtn").onclick = () => {
        if (this.onApproveAction) this.onApproveAction();
      };
      this.shadow.getElementById("rejectBtn").onclick = () => {
        if (this.onRejectAction) this.onRejectAction();
      };
    } else {
      approvalArea.style.display = "none";
    }

    logList.innerHTML = agentState.history
      .map(
        (h) =>
          `<div class="log-item">Step ${h.step}: ${h.action.toUpperCase()} (${h.target || "page"}) [${h.risk}] -> ${h.status}</div>`
      )
      .join("");
  }
}

export const prismUI = new PrismUI();
