/**
 * background.js — MV3 service worker.
 *
 * v0.1 scope: user-triggered only. Clicking the extension icon sends a
 * "run_cycle" message to the active tab's content script. There is
 * deliberately no periodic/interval-based polling — an agent that
 * re-scans and re-calls the server on a timer regardless of whether
 * anything changed would be the opposite of what SPEC.md §4's
 * resource-utilization goals are about. The user decides when a cycle
 * runs.
 *
 * This file has no logic worth unit testing in isolation — it's pure
 * chrome.* API glue. The actual cycle logic (build → vision → send →
 * validate → execute) is entirely in content_script.js, which is
 * already tested. Keeping this file this thin is deliberate, same
 * rationale as model_adapters.js.
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "run_cycle" });
    updateBadge(tab.id, response);
  } catch (err) {
    // Most common cause: content script not injected on this page (e.g.
    // chrome:// URLs, or the page loaded before the extension did).
    console.error("[sih26171] could not reach content script:", err);
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#B00020" });
  }
});

function updateBadge(tabId, result) {
  if (!result) {
    chrome.action.setBadgeText({ tabId, text: "?" });
    return;
  }
  if (result.ok) {
    chrome.action.setBadgeText({ tabId, text: "✓" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#0F9D58" });
  } else {
    chrome.action.setBadgeText({ tabId, text: "✗" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#B00020" });
    console.warn("[sih26171] agent cycle did not complete:", result.reason, result.detail);
  }
}

// Clear the badge when navigating to a new page, so a stale ✓/✗ from the
// previous page doesn't linger and mislead the user about the new page's
// state.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (!existing || existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification:
        "Run local face detection and OCR on cropped image regions for PII redaction.",
    });
  }

  // Ping offscreen document until it responds (ensures offscreen.js is fully loaded)
  for (let i = 0; i < 30; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "offscreen_ping" });
      if (res?.pong) return;
    } catch (_) {
      // Offscreen script still loading
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "send_scene_graph") {
    const serverUrl = message.serverUrl || "http://127.0.0.1:8000/plan";
    fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload),
    })
      .then(async (res) => {
        if (!res.ok) {
          let detail = `server returned status ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson && errJson.detail) {
              detail = `server returned status ${res.status}: ${errJson.detail}`;
            }
          } catch (_) {}
          sendResponse({ ok: false, detail });
        } else {
          const plan = await res.json();
          sendResponse({ ok: true, plan });
        }
      })
      .catch((err) => {
        sendResponse({ ok: false, detail: err.message || String(err) });
      });
    return true;
  }

  if (message?.type !== "resolve_opaque_nodes") return false;

  (async () => {
    try {
      await ensureOffscreenDocument();

      const response = await chrome.runtime.sendMessage({
        type: "resolve_opaque_nodes_offscreen",
        crops: message.crops,
      });

      sendResponse(response);
    } catch (err) {
      console.error("[sih26171/background] vision resolution failed:", err);
      sendResponse({
        ok: false,
        detail: String(err),
      });
    }
  })();

  return true;
});

