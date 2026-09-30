import { describe, it, expect, beforeEach } from "vitest";
import { buildSceneGraph } from "./scene_graph.js";
import { TOKENS } from "./redact.js";

function setBody(html) {
  document.body.innerHTML = html;
}

// jsdom doesn't implement layout, so getBoundingClientRect() returns all
// zeros by default, which our isVisible() would treat as "invisible" and
// skip entirely. We patch it per-test to report a plausible non-zero box,
// mirroring what a real rendered page would return.
function stubLayout() {
  Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30 };
  };
}

beforeEach(() => {
  stubLayout();
  setBody("");
});

describe("buildSceneGraph — basic structure", () => {
  it("returns the expected top-level shape", () => {
    setBody(`<button>Submit</button>`);
    const graph = buildSceneGraph();
    expect(graph.version).toBe("1.0");
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(graph).toHaveProperty("viewport");
    expect(graph).toHaveProperty("timestamp");
    expect(graph).toHaveProperty("focused_node_id");
  });

  it("assigns stable sequential ids starting fresh each call", () => {
    setBody(`<button>A</button><button>B</button>`);
    const graph = buildSceneGraph();
    expect(graph.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("does not leak internal fields (_el, _opaque) into public nodes", () => {
    setBody(`<button>Submit</button>`);
    const graph = buildSceneGraph();
    for (const node of graph.nodes) {
      expect(node).not.toHaveProperty("_el");
      expect(node).not.toHaveProperty("_opaque");
    }
  });
});

describe("buildSceneGraph — redaction integration", () => {
  it("redacts a password field and never exposes its value", () => {
    setBody(`<input type="password" id="pw" value="hunter2SuperSecret">`);
    const graph = buildSceneGraph();
    const node = graph.nodes.find((n) => n.type === "password");
    expect(node.value_redacted).toBe(TOKENS.PASSWORD);

    // Whole-graph safety net: serialize and make sure the raw secret
    // never appears anywhere in the output, not just in the expected field.
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("hunter2SuperSecret");
  });

  it("redacts an email input by type", () => {
    setBody(`<input type="email" id="em">`);
    const graph = buildSceneGraph();
    const node = graph.nodes.find((n) => n.type === "email");
    expect(node.value_redacted).toBe(TOKENS.EMAIL);
  });

  it("redacts visible text content containing an email address", () => {
    setBody(`<a href="#">Contact: someone@example.com</a>`);
    const graph = buildSceneGraph();
    const node = graph.nodes.find((n) => n.role === "link");
    expect(node.value_redacted).toBe(TOKENS.EMAIL);
    // The label itself must also be sanitized — a raw label containing the
    // address would leak it even if value_redacted looks correct.
    expect(node.label).toBe(TOKENS.EMAIL);
    expect(JSON.stringify(graph)).not.toContain("someone@example.com");
  });

  it("does not redact a harmless button label", () => {
    setBody(`<button>Submit</button>`);
    const graph = buildSceneGraph();
    const node = graph.nodes[0];
    expect(node.value_redacted).toBeNull();
    expect(node.label).toBe("Submit");
  });

  it("never reads .value for a password field at all (label/type only)", () => {
    // Regression guard: even if a future refactor accidentally tries to
    // read el.value on a password field, this test's dedicated secret
    // string must never show up anywhere in the graph.
    setBody(`<input type="password" value="TOTALLY-UNIQUE-SECRET-XYZ">`);
    const graph = buildSceneGraph();
    expect(JSON.stringify(graph)).not.toContain("TOTALLY-UNIQUE-SECRET-XYZ");
  });
});

describe("buildSceneGraph — labeling", () => {
  it("prefers aria-label over other label sources", () => {
    setBody(`<button aria-label="Close dialog">X</button>`);
    const graph = buildSceneGraph();
    expect(graph.nodes[0].label).toBe("Close dialog");
  });

  it("falls back to placeholder for inputs with no aria-label or <label>", () => {
    setBody(`<input type="text" placeholder="Search products">`);
    const graph = buildSceneGraph();
    expect(graph.nodes[0].label).toBe("Search products");
  });

  it("uses an associated <label for=...> element", () => {
    setBody(`<label for="uname">Username</label><input type="text" id="uname">`);
    const graph = buildSceneGraph();
    const input = graph.nodes.find((n) => n.type === "text");
    expect(input.label).toBe("Username");
  });
});

describe("buildSceneGraph — opaque (vision-pending) elements", () => {
  it("marks a canvas as vision_pending, not dom", () => {
    setBody(`<canvas></canvas>`);
    const graph = buildSceneGraph();
    expect(graph.nodes[0].source).toBe("vision_pending");
  });

  it("marks an image with no alt text as vision_pending", () => {
    setBody(`<img src="photo.jpg">`);
    const graph = buildSceneGraph();
    expect(graph.nodes[0].source).toBe("vision_pending");
  });

  it("treats an image WITH meaningful alt text as DOM-explainable", () => {
    setBody(`<img src="logo.png" alt="Company logo">`);
    const graph = buildSceneGraph();
    expect(graph.nodes[0].source).toBe("dom");
    expect(graph.nodes[0].label).toBe("Company logo");
  });

  it("collects opaque nodes separately with live element refs for Tier 1", () => {
    setBody(`<canvas></canvas><button>Submit</button>`);
    const graph = buildSceneGraph();
    expect(graph.opaqueNodes.length).toBe(1);
    expect(graph.opaqueNodes[0]._el.tagName.toLowerCase()).toBe("canvas");
  });

  it("always sets value_redacted to null for opaque nodes at Tier 0 (Tier 1 fills it in later)", () => {
    setBody(`<canvas></canvas>`);
    const graph = buildSceneGraph();
    expect(graph.nodes[0].value_redacted).toBeNull();
  });
});

describe("buildSceneGraph — element tagging (content_script.js id-resolution contract)", () => {
  it("tags each tracked element with data-sih26171-id matching its scene-graph id", () => {
    setBody(`<button id="a">A</button><button id="b">B</button>`);
    const graph = buildSceneGraph();
    const elA = document.getElementById("a");
    const elB = document.getElementById("b");
    expect(elA.getAttribute("data-sih26171-id")).toBe(graph.nodes[0].id);
    expect(elB.getAttribute("data-sih26171-id")).toBe(graph.nodes[1].id);
  });

  it("re-tags elements with fresh ids on a second call (ids are per-cycle, not permanent)", () => {
    setBody(`<button id="a">A</button>`);
    const graph1 = buildSceneGraph();
    const graph2 = buildSceneGraph();
    // Same element, but resetIds() means the second graph starts from n1
    // again — the DOM attribute must reflect the LATEST graph, not the
    // first one, or content_script.js would resolve stale ids.
    const el = document.getElementById("a");
    expect(el.getAttribute("data-sih26171-id")).toBe(graph2.nodes[0].id);
    expect(graph1.nodes[0].id).toBe(graph2.nodes[0].id); // both "n1" since counter resets
  });
});

describe("buildSceneGraph — focus tracking", () => {
  it("identifies the focused node id", () => {
    setBody(`<input type="text" id="a"><input type="text" id="b">`);
    document.getElementById("b").focus();
    const graph = buildSceneGraph();
    const focusedNode = graph.nodes.find((n) => n.id === graph.focused_node_id);
    expect(focusedNode).toBeDefined();
  });

  it("returns null focused_node_id when nothing relevant is focused", () => {
    setBody(`<button>Submit</button>`);
    const graph = buildSceneGraph();
    expect(graph.focused_node_id).toBeNull();
  });
});

describe("buildSceneGraph — filled state tracking", () => {
  it("sets filled: false for an empty text input", () => {
    setBody(`<input type="text" id="name" value="">`);
    const graph = buildSceneGraph();
    const node = graph.nodes[0];
    expect(node.filled).toBe(false);
  });

  it("sets filled: true for a filled text input", () => {
    setBody(`<input type="text" id="name" value="Jane Doe">`);
    const graph = buildSceneGraph();
    const node = graph.nodes[0];
    expect(node.filled).toBe(true);
  });

  it("sets filled: null for non-form elements", () => {
    setBody(`<button>Submit</button>`);
    const graph = buildSceneGraph();
    const node = graph.nodes[0];
    expect(node.filled).toBeNull();
  });
});
