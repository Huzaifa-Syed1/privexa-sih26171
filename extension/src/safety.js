/**
 * safety.js — Prism Safety & Risk Classifier
 *
 * Classifies server actions into risk levels:
 * - LOW: scroll, wait, observe, click non-destructive buttons/links
 * - MEDIUM: type/fill form fields
 * - HIGH: submit, pay, purchase, delete, register, send sensitive communication
 *
 * HIGH-risk actions MUST trigger a user approval prompt before execution.
 */

export const RISK_LEVELS = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

const HIGH_RISK_KEYWORDS = [
  "submit",
  "pay",
  "payment",
  "buy",
  "purchase",
  "delete",
  "remove",
  "checkout",
  "transfer",
];

/**
 * Classify the risk level of an action.
 *
 * @param {object} action - Action object from server
 * @param {Element|null} targetElement - Live DOM element (if applicable)
 * @returns {{ level: "LOW"|"MEDIUM"|"HIGH", reason: string }}
 */
export function classifyActionRisk(action, targetElement = null) {
  if (!action) {
    return { level: RISK_LEVELS.LOW, reason: "No action" };
  }

  if (action.action === "scroll" || action.action === "wait" || action.action === "done") {
    return { level: RISK_LEVELS.LOW, reason: `${action.action} action is safe` };
  }

  if (action.action === "type") {
    return { level: RISK_LEVELS.MEDIUM, reason: "Typing local profile data into field" };
  }

  if (action.action === "click") {
    let text = "";
    if (targetElement) {
      text = (
        (targetElement.textContent || "") +
        " " +
        (targetElement.getAttribute("aria-label") || "") +
        " " +
        (targetElement.getAttribute("value") || "") +
        " " +
        (targetElement.id || "")
      ).toLowerCase();
    }

    const isHighRisk = HIGH_RISK_KEYWORDS.some((kw) => text.includes(kw));

    if (isHighRisk) {
      return {
        level: RISK_LEVELS.HIGH,
        reason: `Clicking high-risk target button ("${text.trim() || action.target_node_id}") requires user approval.`,
      };
    }

    return { level: RISK_LEVELS.MEDIUM, reason: `Clicking button ("${text.trim() || action.target_node_id}")` };
  }

  return { level: RISK_LEVELS.MEDIUM, reason: "Standard action" };
}
