import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { runAgentCycle } from "./content_script.js";

function stubLayout() {
  Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30 };
  };
}

beforeEach(() => {
  stubLayout();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runAgentCycle — happy path", () => {
  it("builds a graph, sends it, and executes a returned click action", async () => {
    document.body.innerHTML = `<button>Submit</button>`;

    const mockPlan = { actions: [{ action: "click", target_node_id: "n1" }] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockPlan,
    });
    vi.stubGlobal("fetch", fetchMock);

    const btn = document.querySelector("button");
    const clickSpy = vi.fn();
    btn.addEventListener("click", clickSpy);

    const result = await runAgentCycle("test task");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("sends a payload containing no vision_pending nodes and no internal fields", async () => {
    document.body.innerHTML = `<input type="password" value="secret123"><button>Go</button>`;

    let sentBody;
    const fetchMock = vi.fn().mockImplementation((url, opts) => {
      sentBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ actions: [{ action: "wait" }] }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    await runAgentCycle();

    const serialized = JSON.stringify(sentBody);
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("_el");
    expect(serialized).not.toContain("_opaque");
    for (const node of sentBody.nodes) {
      expect(node.source).not.toBe("vision_pending");
    }
  });
});

describe("runAgentCycle — Tier 1 vision resolution via offscreen document", () => {
  it("crops opaque nodes, delegates to the offscreen doc via chrome.runtime.sendMessage, and sends the resolved node", async () => {
    document.body.innerHTML = `<canvas></canvas>`;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,FAKE");

    let sentBody;
    const fetchMock = vi.fn().mockImplementation((url, opts) => {
      sentBody = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ actions: [{ action: "wait" }] }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const sendMessageMock = vi.fn().mockResolvedValue({
      ok: true,
      results: { n1: "<REDACTED:face,count=1>" },
    });

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: sendMessageMock,
        onMessage: { addListener: vi.fn() },
      },
    });

    const result = await runAgentCycle();

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const sentMessage = sendMessageMock.mock.calls[0][0];
    expect(sentMessage.type).toBe("resolve_opaque_nodes");
    expect(sentMessage.crops).toEqual([{ id: "n1", dataUrl: "data:image/png;base64,FAKE" }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const canvasNode = sentBody.nodes.find((n) => n.role === "canvas");
    expect(canvasNode.source).toBe("vision");
    expect(canvasNode.value_redacted).toBe("<REDACTED:face,count=1>");
    expect(result.ok).toBe(true);
  });

  it("returns vision_error and never calls fetch when the offscreen document reports failure", async () => {
    document.body.innerHTML = `<canvas></canvas>`;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,FAKE");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue({ ok: false, detail: "model failed to load" }),
        getContexts: vi.fn().mockResolvedValue([]),
        onMessage: { addListener: vi.fn() },
      },
      offscreen: { createDocument: vi.fn().mockResolvedValue(undefined) },
    });

    const result = await runAgentCycle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("vision_error");
  });

  it("returns vision_error when a cross-origin-tainted canvas throws on toDataURL", async () => {
    document.body.innerHTML = `<canvas></canvas>`;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => {
      throw new DOMException("tainted canvas", "SecurityError");
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn(), getContexts: vi.fn(), onMessage: { addListener: vi.fn() } },
      offscreen: { createDocument: vi.fn() },
    });

    const result = await runAgentCycle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("vision_error");
  });
});

describe("runAgentCycle — server error handling", () => {
  it("returns a server_error result when fetch rejects", async () => {
    document.body.innerHTML = `<button>Go</button>`;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await runAgentCycle();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("server_error");
  });

  it("returns a server_error result when the server responds non-2xx", async () => {
    document.body.innerHTML = `<button>Go</button>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await runAgentCycle();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("server_error");
  });
});

describe("runAgentCycle — rejects malformed/adversarial server actions instead of executing them", () => {
  it("rejects and does not execute when server smuggles a literal value", async () => {
    document.body.innerHTML = `<input type="text" id="field">`;
    const adversarialPlan = {
      actions: [{
        action: "fill_local",
        target_node_id: "n1",
        value_source: "profile.email",
        value: "attacker-controlled-text",
      }]
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => adversarialPlan })
    );

    const result = await runAgentCycle();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("action_rejected");
    expect(document.getElementById("field").value).toBe("");
  });

  it("rejects an unknown action type", async () => {
    document.body.innerHTML = `<button>Go</button>`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ actions: [{ action: "eval", code: "x" }] }) })
    );

    const result = await runAgentCycle();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("action_rejected");
  });
});

describe("runAgentCycle — fill_local action uses only local values", () => {
  it("fills a text field from its own current value (local autofill), never from the server", async () => {
    document.body.innerHTML = `<input type="text" id="field" value="already-typed-by-user">`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ actions: [{ action: "fill_local", target_node_id: "n1", value_source: "profile.name" }] }),
      })
    );
    vi.mock("./profile_vault.js", () => ({
      vault: {
        load: vi.fn(),
        resolveLocalValue: vi.fn(() => "already-typed-by-user"),
        getValueBySource: vi.fn(() => "already-typed-by-user"),
      },
    }));

    const result = await runAgentCycle();
    expect(result.ok).toBe(true);
    expect(document.getElementById("field").value).toBe("already-typed-by-user");
  });
});
