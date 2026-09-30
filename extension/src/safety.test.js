/**
 * safety.test.js — Unit tests for Action Safety & Risk Classifier
 */

import { describe, it, expect } from "vitest";
import { classifyActionRisk, RISK_LEVELS } from "./safety.js";

describe("classifyActionRisk", () => {
  it("classifies scroll, wait, done as LOW risk", () => {
    expect(classifyActionRisk({ action: "scroll", direction: "down", amount_px: 100 }).level).toBe(RISK_LEVELS.LOW);
    expect(classifyActionRisk({ action: "wait" }).level).toBe(RISK_LEVELS.LOW);
    expect(classifyActionRisk({ action: "done" }).level).toBe(RISK_LEVELS.LOW);
  });

  it("classifies type as MEDIUM risk", () => {
    const res = classifyActionRisk({ action: "type", target_node_id: "n1", value_source: "user_provided" });
    expect(res.level).toBe(RISK_LEVELS.MEDIUM);
  });

  it("classifies click on non-destructive element as MEDIUM risk", () => {
    const btn = document.createElement("button");
    btn.textContent = "Next Page";
    const res = classifyActionRisk({ action: "click", target_node_id: "n1" }, btn);
    expect(res.level).toBe(RISK_LEVELS.MEDIUM);
  });

  it("classifies click on submit/pay/delete/purchase button as HIGH risk", () => {
    const submitBtn = document.createElement("button");
    submitBtn.textContent = "Submit Application";
    expect(classifyActionRisk({ action: "click", target_node_id: "n1" }, submitBtn).level).toBe(RISK_LEVELS.HIGH);

    const payBtn = document.createElement("button");
    payBtn.textContent = "Pay ₹1,200";
    expect(classifyActionRisk({ action: "click", target_node_id: "n2" }, payBtn).level).toBe(RISK_LEVELS.HIGH);

    const deleteBtn = document.createElement("button");
    deleteBtn.id = "btn-delete-account";
    expect(classifyActionRisk({ action: "click", target_node_id: "n3" }, deleteBtn).level).toBe(RISK_LEVELS.HIGH);
  });
});
