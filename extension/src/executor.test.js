import { describe, it, expect, beforeEach, vi } from "vitest";
import { validateAction, executeAction, ActionRejectedError } from "./executor.js";

describe("validateAction — well-formed actions pass", () => {
  it("accepts a click action", () => {
    expect(validateAction({ action: "click", target_node_id: "n1" })).toBe(true);
  });

  it("accepts a fill_local action with value_source=profile.name", () => {
    expect(
      validateAction({ action: "fill_local", target_node_id: "n1", value_source: "profile.name" })
    ).toBe(true);
  });

  it("accepts a fill_local action with value_source=credential.current_site.password", () => {
    expect(
      validateAction({ action: "fill_local", target_node_id: "n1", value_source: "credential.current_site.password" })
    ).toBe(true);
  });

  it("accepts a scroll action", () => {
    expect(validateAction({ action: "scroll", direction: "down", amount_px: 400 })).toBe(true);
  });

  it("accepts a wait action", () => {
    expect(validateAction({ action: "wait", reason: "page_loading" })).toBe(true);
  });

  it("accepts a done action", () => {
    expect(validateAction({ action: "done", summary: "Logged in" })).toBe(true);
  });
});

describe("validateAction — the critical rejection: server smuggling a literal value", () => {
  it("REJECTS a fill_local action carrying a literal 'value' field, even with a valid value_source", () => {
    expect(() =>
      validateAction({
        action: "fill_local",
        target_node_id: "n1",
        value_source: "profile.email",
        value: "hunter2", // this must never be accepted, regardless of value_source
      })
    ).toThrow(ActionRejectedError);
  });

  it("REJECTS a fill_local action with no value_source at all", () => {
    expect(() =>
      validateAction({ action: "fill_local", target_node_id: "n1" })
    ).toThrow(ActionRejectedError);
  });

  it("REJECTS a fill_local action with an invalid/made-up value_source", () => {
    expect(() =>
      validateAction({ action: "fill_local", target_node_id: "n1", value_source: "server_knows_best" })
    ).toThrow(ActionRejectedError);
  });

  it("REJECTS a fill_local action where value_source is itself the raw secret (adversarial)", () => {
    // Simulates a malicious/buggy server trying to sneak the value through
    // the value_source field instead of a `value` field.
    expect(() =>
      validateAction({ action: "fill_local", target_node_id: "n1", value_source: "hunter2" })
    ).toThrow(ActionRejectedError);
  });
});

describe("validateAction — other malformed actions", () => {
  it("rejects an unknown action type", () => {
    expect(() => validateAction({ action: "eval", code: "alert(1)" })).toThrow(ActionRejectedError);
  });

  it("rejects null/undefined", () => {
    expect(() => validateAction(null)).toThrow(ActionRejectedError);
    expect(() => validateAction(undefined)).toThrow(ActionRejectedError);
  });

  it("rejects a click with no target_node_id", () => {
    expect(() => validateAction({ action: "click" })).toThrow(ActionRejectedError);
  });

  it("rejects a scroll with invalid direction", () => {
    expect(() => validateAction({ action: "scroll", direction: "sideways", amount_px: 100 })).toThrow(
      ActionRejectedError
    );
  });

  it("rejects a scroll with negative amount_px", () => {
    expect(() => validateAction({ action: "scroll", direction: "down", amount_px: -50 })).toThrow(
      ActionRejectedError
    );
  });
});

describe("executeAction — click", () => {
  beforeEach(() => {
    document.body.innerHTML = `<button id="btn">Submit</button>`;
  });

  it("clicks the resolved element", () => {
    const btn = document.getElementById("btn");
    const clickSpy = vi.fn();
    btn.addEventListener("click", clickSpy);

    const idToElement = new Map([["n1", btn]]);
    const result = executeAction({ action: "click", target_node_id: "n1" }, idToElement, {});

    expect(clickSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("throws when target_node_id does not resolve to a live element", () => {
    const idToElement = new Map(); // empty — n1 not registered
    expect(() =>
      executeAction({ action: "click", target_node_id: "n1" }, idToElement, {})
    ).toThrow(ActionRejectedError);
  });
});

describe("executeAction — fill_local (local-value-only enforcement)", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input type="text" id="field">`;
  });

  it("fills the field using ONLY the local value source, never anything from the action object", () => {
    const field = document.getElementById("field");
    const idToElement = new Map([["n1", field]]);
    const localSource = { getLocalValueFor: vi.fn(() => "locally-known-value") };

    const result = executeAction(
      { action: "fill_local", target_node_id: "n1", value_source: "profile.email" },
      idToElement,
      localSource
    );

    expect(localSource.getLocalValueFor).toHaveBeenCalledWith("n1", "profile.email");
    expect(field.value).toBe("locally-known-value");
    expect(result.ok).toBe(true);
  });

  it("does NOT fill the field and reports failure when no local value is available", () => {
    const field = document.getElementById("field");
    const idToElement = new Map([["n1", field]]);
    const localSource = { getLocalValueFor: vi.fn(() => null) };

    const result = executeAction(
      { action: "fill_local", target_node_id: "n1", value_source: "profile.email" },
      idToElement,
      localSource
    );

    expect(field.value).toBe("");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_local_value_available");
  });

  it("fires input and change events after filling", () => {
    const field = document.getElementById("field");
    const idToElement = new Map([["n1", field]]);
    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    field.addEventListener("input", inputSpy);
    field.addEventListener("change", changeSpy);

    executeAction(
      { action: "fill_local", target_node_id: "n1", value_source: "profile.name" },
      idToElement,
      { getLocalValueFor: () => "x" }
    );

    expect(inputSpy).toHaveBeenCalledOnce();
    expect(changeSpy).toHaveBeenCalledOnce();
  });

  it("end-to-end: a smuggled 'value' field never reaches the DOM, even if getLocalValueFor is buggy", () => {
    const field = document.getElementById("field");
    const idToElement = new Map([["n1", field]]);
    // Even a localSource that (buggily) echoes back arbitrary input should
    // never see the smuggled value, because validateAction throws first.
    const localSource = { getLocalValueFor: vi.fn((id) => "should-never-be-called") };

    expect(() =>
      executeAction(
        { action: "fill_local", target_node_id: "n1", value_source: "profile.email", value: "attacker-value" },
        idToElement,
        localSource
      )
    ).toThrow(ActionRejectedError);

    expect(field.value).toBe("");
    expect(localSource.getLocalValueFor).not.toHaveBeenCalled();
  });
});

describe("executeAction — scroll, wait, done", () => {
  it("scrolls down by the given amount", () => {
    const scrollSpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    executeAction({ action: "scroll", direction: "down", amount_px: 300 }, new Map(), {});
    expect(scrollSpy).toHaveBeenCalledWith({ top: 300, behavior: "smooth" });
  });

  it("scrolls up as a negative delta", () => {
    const scrollSpy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    executeAction({ action: "scroll", direction: "up", amount_px: 300 }, new Map(), {});
    expect(scrollSpy).toHaveBeenCalledWith({ top: -300, behavior: "smooth" });
  });

  it("wait returns ok without doing anything observable", () => {
    const result = executeAction({ action: "wait", reason: "page_loading" }, new Map(), {});
    expect(result.ok).toBe(true);
    expect(result.waited).toBe(true);
  });

  it("done returns ok with the summary", () => {
    const result = executeAction({ action: "done", summary: "Task complete" }, new Map(), {});
    expect(result.ok).toBe(true);
    expect(result.done).toBe(true);
    expect(result.summary).toBe("Task complete");
  });
});
