import { describe, it, expect, vi } from "vitest";
import { classifyOpaqueRegion, resolveOpaqueNode, resolveAllOpaqueNodes } from "./vision.js";
import { TOKENS } from "./redact.js";

describe("classifyOpaqueRegion — pure decision logic", () => {
  it("returns null when nothing is detected", () => {
    expect(classifyOpaqueRegion({ faceCount: 0, extractedText: "" })).toBeNull();
  });

  it("returns a face token when only a face is detected, no text", () => {
    expect(classifyOpaqueRegion({ faceCount: 1, extractedText: "" })).toBe(TOKENS.face(1));
  });

  it("includes the correct count for multiple faces", () => {
    expect(classifyOpaqueRegion({ faceCount: 3, extractedText: "" })).toBe(TOKENS.face(3));
  });

  it("returns a face token when face detected with only sparse/short text", () => {
    const shortText = "OK"; // well under the density threshold
    expect(classifyOpaqueRegion({ faceCount: 1, extractedText: shortText })).toBe(TOKENS.face(1));
  });

  it("returns DOCUMENT when a face AND dense text are both present (e.g. an ID card photo)", () => {
    const denseText = "GOVERNMENT OF INDIA IDENTITY CARD NAME DATE OF BIRTH ADDRESS DISTRICT STATE PIN CODE";
    expect(classifyOpaqueRegion({ faceCount: 1, extractedText: denseText })).toBe(TOKENS.DOCUMENT);
  });

  it("prioritizes DOCUMENT over plain face token even with multiple faces", () => {
    const denseText = "GOVERNMENT OF INDIA IDENTITY CARD NAME DATE OF BIRTH ADDRESS DISTRICT STATE PIN CODE";
    expect(classifyOpaqueRegion({ faceCount: 2, extractedText: denseText })).toBe(TOKENS.DOCUMENT);
  });

  it("returns the specific email token when OCR text contains an email, no face", () => {
    expect(
      classifyOpaqueRegion({ faceCount: 0, extractedText: "reach us at hello@example.com" })
    ).toBe(TOKENS.EMAIL);
  });

  it("returns the specific Aadhaar token when OCR text contains a checksum-valid Aadhaar number", () => {
    expect(
      classifyOpaqueRegion({ faceCount: 0, extractedText: "Aadhaar No: 234123412346" })
    ).toBe(TOKENS.AADHAAR);
  });

  it("returns the specific PAN token when OCR text contains a PAN pattern", () => {
    expect(
      classifyOpaqueRegion({ faceCount: 0, extractedText: "Permanent Account Number ABCDE1234F" })
    ).toBe(TOKENS.PAN);
  });

  it("checks named categories per-line so a match isn't missed in a multi-line block", () => {
    const text = "Some heading\nNo PII here\ncontact: someone@example.com\nfooter text";
    expect(classifyOpaqueRegion({ faceCount: 0, extractedText: text })).toBe(TOKENS.EMAIL);
  });

  it("falls back to generic_pii when text has sensitive-shaped fragments but no named pattern matches", () => {
    // Long alphanumeric code that isn't email/phone/aadhaar/pan/card-shaped
    const text = "Reference Number: XJ4499812Q see attached form";
    const result = classifyOpaqueRegion({ faceCount: 0, extractedText: text });
    expect(result).toBe(TOKENS.generic(1));
  });

  it("counts multiple distinct generic-sensitive fragments", () => {
    const text = "Ref: ABC123456 and also XYZ987654 on this form";
    const result = classifyOpaqueRegion({ faceCount: 0, extractedText: text });
    expect(result).toBe(TOKENS.generic(2));
  });

  it("returns null for plain, non-sensitive short text", () => {
    expect(classifyOpaqueRegion({ faceCount: 0, extractedText: "Welcome to our homepage" })).toBeNull();
  });

  it("never includes any fragment of the actual OCR'd text in its output token", () => {
    const inputs = [
      "someone@example.com",
      "Aadhaar 234123412346",
      "PAN ABCDE1234F",
      "Reference Number: XJ4499812Q",
    ];
    for (const text of inputs) {
      const token = classifyOpaqueRegion({ faceCount: 0, extractedText: text });
      if (token) {
        // Token must be from the fixed vocabulary shape, never containing
        // the raw OCR'd substring.
        expect(token).toMatch(/^<REDACTED:/);
        expect(token.endsWith(">")).toBe(true);
      }
    }
  });
});

describe("resolveOpaqueNode — orchestration with injected model calls", () => {
  function makeNode(overrides = {}) {
    return {
      id: "n5",
      role: "image",
      label: null,
      type: null,
      bbox: [0, 0, 100, 100],
      value_redacted: null,
      source: "vision_pending",
      _el: {},
      ...overrides,
    };
  }

  it("calls captureRegion, then detectFaces and extractText with its result", async () => {
    const node = makeNode();
    const fakeImageData = { fake: true };
    const deps = {
      captureRegion: vi.fn().mockResolvedValue(fakeImageData),
      detectFaces: vi.fn().mockResolvedValue(0),
      extractText: vi.fn().mockResolvedValue(""),
    };

    const result = await resolveOpaqueNode(node, deps);

    expect(deps.captureRegion).toHaveBeenCalledWith(node._el);
    expect(deps.detectFaces).toHaveBeenCalledWith(fakeImageData);
    expect(deps.extractText).toHaveBeenCalledWith(fakeImageData);
    expect(result.source).toBe("vision");
    expect(result.value_redacted).toBeNull();
  });

  it("produces a face token end-to-end when the injected face model finds a face", async () => {
    const node = makeNode();
    const deps = {
      captureRegion: vi.fn().mockResolvedValue({}),
      detectFaces: vi.fn().mockResolvedValue(1),
      extractText: vi.fn().mockResolvedValue(""),
    };

    const result = await resolveOpaqueNode(node, deps);
    expect(result.value_redacted).toBe(TOKENS.face(1));
  });

  it("preserves all other node fields unchanged (id, bbox, role, label)", async () => {
    const node = makeNode({ id: "n9", bbox: [1, 2, 3, 4], role: "canvas", label: "chart" });
    const deps = {
      captureRegion: vi.fn().mockResolvedValue({}),
      detectFaces: vi.fn().mockResolvedValue(0),
      extractText: vi.fn().mockResolvedValue(""),
    };

    const result = await resolveOpaqueNode(node, deps);
    expect(result.id).toBe("n9");
    expect(result.bbox).toEqual([1, 2, 3, 4]);
    expect(result.role).toBe("canvas");
    expect(result.label).toBe("chart");
  });

  it("throws if called on a node that isn't vision_pending (misuse guard)", async () => {
    const node = makeNode({ source: "dom" });
    const deps = {
      captureRegion: vi.fn(),
      detectFaces: vi.fn(),
      extractText: vi.fn(),
    };
    await expect(resolveOpaqueNode(node, deps)).rejects.toThrow(/vision_pending/);
    expect(deps.captureRegion).not.toHaveBeenCalled();
  });

  it("propagates a rejection from captureRegion rather than swallowing it", async () => {
    const node = makeNode();
    const deps = {
      captureRegion: vi.fn().mockRejectedValue(new Error("capture failed")),
      detectFaces: vi.fn(),
      extractText: vi.fn(),
    };
    await expect(resolveOpaqueNode(node, deps)).rejects.toThrow("capture failed");
  });
});

describe("resolveAllOpaqueNodes — batch resolution", () => {
  it("resolves multiple nodes and returns a map keyed by id", async () => {
    const nodes = [
      { id: "n1", source: "vision_pending", _el: {} },
      { id: "n2", source: "vision_pending", _el: {} },
    ];
    const deps = {
      captureRegion: vi.fn().mockResolvedValue({}),
      detectFaces: vi.fn().mockResolvedValue(0),
      extractText: vi.fn().mockResolvedValue(""),
    };

    const resolved = await resolveAllOpaqueNodes(nodes, deps);
    expect(resolved.size).toBe(2);
    expect(resolved.get("n1").source).toBe("vision");
    expect(resolved.get("n2").source).toBe("vision");
  });

  it("processes nodes sequentially, not concurrently (bounds resource usage)", async () => {
    const callOrder = [];
    const nodes = [
      { id: "n1", source: "vision_pending", _el: {} },
      { id: "n2", source: "vision_pending", _el: {} },
    ];
    const deps = {
      captureRegion: vi.fn(async (el) => {
        callOrder.push("start");
        await new Promise((r) => setTimeout(r, 5));
        callOrder.push("end");
        return {};
      }),
      detectFaces: vi.fn().mockResolvedValue(0),
      extractText: vi.fn().mockResolvedValue(""),
    };

    await resolveAllOpaqueNodes(nodes, deps);
    // If sequential: start, end, start, end. If concurrent: start, start, end, end.
    expect(callOrder).toEqual(["start", "end", "start", "end"]);
  });

  it("returns an empty map for an empty input list", async () => {
    const deps = { captureRegion: vi.fn(), detectFaces: vi.fn(), extractText: vi.fn() };
    const resolved = await resolveAllOpaqueNodes([], deps);
    expect(resolved.size).toBe(0);
    expect(deps.captureRegion).not.toHaveBeenCalled();
  });
});
