"""
planner.py — turns a sanitized SceneGraph into an Action via an LLM call.

Split into two halves on purpose:
  - build_prompt() / parse_llm_response(): pure functions, fully unit
    tested without any network access.
  - LLMPlanner.plan(): thin orchestration that calls the actual API
    client (injected, so it can be swapped/mocked) and pipes the result
    through the pure functions above.

The critical invariant this file must uphold: parse_llm_response() always
returns either a valid Action (already passed through Pydantic validation)
or raises. There is no code path that returns a dict-shaped "action-like"
object that skipped schema validation — if the LLM's JSON doesn't
validate as one of the five known Action types, that is a hard failure,
not a best-effort pass-through.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Protocol

from pydantic import ValidationError, TypeAdapter

from app.schemas import (
    SceneGraph,
    Action,
    Plan,
    ClickAction,
    FillLocalAction,
    ScrollAction,
    WaitAction,
    DoneAction,
)

_plan_adapter = TypeAdapter(Plan)
logger = logging.getLogger("sih26171")


class PlannerError(Exception):
    """Raised when the LLM's response can't be turned into a valid Plan."""


SYSTEM_PROMPT = """You are a browser automation planner. You receive a \
sanitized scene-graph describing the current state of a webpage — never \
raw pixels, never real user data. Some fields are redacted with tokens \
like <REDACTED:password> or <REDACTED:email>; treat these as opaque \
placeholders. You do not know and must never guess their real values.

Respond with EXACTLY ONE JSON object describing the plan. The object must \
have an 'actions' key containing a list of actions. No prose, no markdown \
fences, just the JSON object. Each action can optionally include a "reasoning" string explaining the logic. Each action must be one of:

{"action": "click", "target_node_id": "<id>", "reasoning": "<short rationale>"}
{"action": "fill_local", "target_node_id": "<id>", "value_source": "profile.name" | "profile.email" | "profile.phone" | "profile.address" | "profile.city" | "profile.state" | "profile.pincode" | "profile.dob" | "credential.current_site.username" | "credential.current_site.password", "reasoning": "<short rationale>"}
{"action": "scroll", "direction": "up" | "down", "amount_px": <positive int>, "reasoning": "<short rationale>"}
{"action": "wait", "reason": "<short string>", "reasoning": "<short rationale>"}
{"action": "done", "summary": "<short string>", "reasoning": "<short rationale>"}

Critical rules:
1. For a "fill_local" action, you NEVER include a literal value. You only specify which field to fill (target_node_id) and which precise local source to use (value_source). Any other field in your response, and any attempt to include actual field content, will be rejected before it ever reaches the browser.
2. Form completion sequence: Fill out all empty input fields in a single plan using multiple `fill_local` actions whenever possible. Skip any node already marked state=[FILLED].
3. Dropdown / Option Selection: When the task asks to select or choose a specific option (e.g. cheapest option, lowest price, specific tier), inspect all nodes with role="option", compare their labels/prices, select the node matching the criteria, and output a `click` action for that specific option node's target_node_id.
4. Button Actions & Submission: If the user task explicitly asks to submit, sign in, log in, or confirm, include a `click` action for the submit/login button as the final action after filling fields. If the task says "do not submit" or does not ask for submission, do NOT click submit buttons.
5. Error Recovery & Self-Correction: If the Action history indicates a previous action failed or failed after retries, choose an alternative node or action to complete the goal.
6. Completion: Output {"action": "done", "summary": "<short string>"} when all required form steps and instructions are complete."""


def build_prompt(graph: SceneGraph) -> str:
    """
    Build the user-turn prompt from a scene-graph. Kept deliberately
    compact (structured JSON, not prose) since the planner's whole
    latency budget depends on small payloads (SPEC.md §4/§6).
    """
    node_lines = []
    for n in graph.nodes:
        parts = [f'id={n.id}', f'role={n.role}']
        if n.label:
            parts.append(f'label="{n.label}"')
        if n.filled is not None:
            parts.append(f'state={"[FILLED]" if n.filled else "[EMPTY]"}')
        if n.value_redacted:
            parts.append(f'value={n.value_redacted}')
        node_lines.append("  " + " ".join(parts))

    focus_line = f"\nFocused node: {graph.focused_node_id}" if graph.focused_node_id else ""
    task_line = f"\nTask: {graph.task_context}" if graph.task_context else ""
    history_line = f"\nAction history:\n" + "\n".join(f"- {a}" for a in graph.action_history) if graph.action_history else ""

    return (
        f"Page nodes:\n" + "\n".join(node_lines) +
        focus_line + task_line + history_line +
        "\n\nWhat is the next plan?"
    )


def parse_llm_response(raw_text: str) -> Plan:
    """
    Parse and validate the LLM's raw text output into a concrete Plan.

    Raises PlannerError (never returns a partially-validated dict) on:
      - non-JSON output
      - JSON that doesn't match the Plan schema
      - JSON containing extra/forbidden fields
    """
    text = raw_text.strip()
    
    # Extract JSON inside ```json ... ``` or ``` ... ``` if present
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        text = match.group(1).strip()
    elif text.startswith("```"):
        text = text.strip("`").strip()
        if text.startswith("json"):
            text = text[4:].strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse LLM JSON response: {e}. Raw text was:\n{raw_text}")
        raise PlannerError(f"LLM response was not valid JSON: {e}") from e

    try:
        plan = _plan_adapter.validate_python(data)
    except ValidationError as e:
        logger.error(f"LLM response schema validation failed: {e}. Data was:\n{data}")
        raise PlannerError(f"LLM response did not match the valid Plan schema: {e}") from e

    return plan


class ChatClient(Protocol):
    """Minimal interface the injected LLM client must satisfy."""

    def complete(self, system_prompt: str, user_prompt: str) -> str: ...


class LLMPlanner:
    def __init__(self, client: ChatClient):
        self._client = client

    def plan(self, graph: SceneGraph) -> Plan:
        prompt = build_prompt(graph)
        try:
            raw_response = self._client.complete(SYSTEM_PROMPT, prompt)
        except Exception as e:
            if isinstance(e, PlannerError):
                raise e
            raise PlannerError(f"LLM API request failed: {e}") from e
        return parse_llm_response(raw_response)
