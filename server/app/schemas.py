"""
schemas.py — the server's half of the SPEC.md contract.

Design principle: use Pydantic's type system to make illegal states
unrepresentable wherever possible, rather than relying on runtime checks
scattered through business logic. In particular:

  - REDACTION_TOKENS is a closed set (SPEC.md §3). A scene-graph node's
    value_redacted field is validated against this exact set — an
    unrecognized token is a validation error, not silently accepted data.

  - Action is a discriminated union (SPEC.md §5). A `type` action's
    schema has NO field that could hold a literal value — there is no
    `value: str` anywhere in this file for a type action. This isn't a
    convention we hope the LLM planner respects; it's structurally
    impossible to construct an ActionType with a literal value and have
    it pass validation, because the field doesn't exist.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Redaction tokens (SPEC.md §3) — closed vocabulary, validated with a regex
# that matches the token SHAPES (since face/generic tokens carry a count).
# ---------------------------------------------------------------------------

_FIXED_TOKENS = {
    "<REDACTED:password>",
    "<REDACTED:email>",
    "<REDACTED:phone>",
    "<REDACTED:aadhaar>",
    "<REDACTED:pan>",
    "<REDACTED:card_number>",
    "<REDACTED:document>",
    "<REDACTED:value>",
    "<REDACTED:opaque_image>",
}
_COUNTED_TOKEN_RE = re.compile(r"^<REDACTED:(face|generic_pii),count=\d+>$")


def is_valid_redaction_token(value: str) -> bool:
    return value in _FIXED_TOKENS or bool(_COUNTED_TOKEN_RE.match(value))


class SceneNode(BaseModel):
    """One element of the page, per SPEC.md §2."""

    id: str
    role: str
    label: Optional[str] = None
    type: Optional[str] = None
    bbox: list[int] = Field(min_length=4, max_length=4)
    value_redacted: Optional[str] = None
    filled: Optional[bool] = None
    source: Literal["dom", "vision"]

    @field_validator("value_redacted")
    @classmethod
    def validate_token_shape(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if not is_valid_redaction_token(v):
            raise ValueError(
                f"value_redacted {v!r} is not a recognized redaction token. "
                f"This field may never contain a raw value — if this fired, "
                f"something upstream (the extension) sent unsanitized data, "
                f"and this request must be rejected, not repaired."
            )
        return v

    @field_validator("label")
    @classmethod
    def label_must_not_look_like_raw_pii(cls, v: Optional[str]) -> Optional[str]:
        """
        Defense in depth: even though the extension is responsible for
        sanitizing labels (scene_graph.js's sanitizeLabelText), the server
        does not trust the client blindly. A label containing an obvious
        email/phone shape is rejected outright rather than silently
        accepted — better to fail a request than to silently log/cache
        raw PII server-side because a client had a bug.
        """
        if v is None:
            return v
        if re.search(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", v):
            raise ValueError(f"label appears to contain a raw email address: rejected")
        if re.search(r"\b\d{10,12}\b", v):
            raise ValueError(f"label appears to contain a raw long digit sequence: rejected")
        return v


class Viewport(BaseModel):
    w: int
    h: int


class SceneGraph(BaseModel):
    """The full incoming request body, per SPEC.md §2."""

    version: str
    url_hash: Optional[str] = None
    viewport: Viewport
    timestamp: int
    nodes: list[SceneNode]
    focused_node_id: Optional[str] = None
    task_context: Optional[str] = None
    action_history: Optional[list[str]] = None

    @model_validator(mode="after")
    def focused_id_must_reference_a_real_node(self) -> "SceneGraph":
        if self.focused_node_id is not None:
            ids = {n.id for n in self.nodes}
            if self.focused_node_id not in ids:
                raise ValueError(
                    f"focused_node_id {self.focused_node_id!r} does not match any node id"
                )
        return self


# ---------------------------------------------------------------------------
# Actions (SPEC.md §5) — discriminated union, no field can carry a literal
# value for a type action.
# ---------------------------------------------------------------------------


class LocalSource(str, Enum):
    profile_name = "profile.name"
    profile_email = "profile.email"
    profile_phone = "profile.phone"
    profile_address = "profile.address"
    profile_city = "profile.city"
    profile_state = "profile.state"
    profile_pincode = "profile.pincode"
    profile_dob = "profile.dob"
    credential_username = "credential.current_site.username"
    credential_password = "credential.current_site.password"


class ClickAction(BaseModel):
    model_config = {"extra": "forbid"}

    action: Literal["click"]
    target_node_id: str
    reasoning: Optional[str] = None


class FillLocalAction(BaseModel):
    action: Literal["fill_local"]
    target_node_id: str
    value_source: LocalSource
    reasoning: Optional[str] = None
    model_config = {"extra": "forbid"}


class ScrollAction(BaseModel):
    model_config = {"extra": "forbid"}

    action: Literal["scroll"]
    direction: Literal["up", "down"]
    amount_px: int = Field(gt=0)
    reasoning: Optional[str] = None


class WaitAction(BaseModel):
    model_config = {"extra": "forbid"}

    action: Literal["wait"]
    reason: Optional[str] = None
    reasoning: Optional[str] = None


class DoneAction(BaseModel):
    model_config = {"extra": "forbid"}

    action: Literal["done"]
    summary: Optional[str] = None
    reasoning: Optional[str] = None


Action = ClickAction | FillLocalAction | ScrollAction | WaitAction | DoneAction


class Plan(BaseModel):
    actions: list[Action]
