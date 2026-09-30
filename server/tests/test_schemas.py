import pytest
from pydantic import ValidationError

from app.schemas import (
    SceneNode,
    SceneGraph,
    Viewport,
    ClickAction,
    FillLocalAction,
    ScrollAction,
    WaitAction,
    DoneAction,
    is_valid_redaction_token,
    Plan,
)


# ---------------------------------------------------------------------------
# Redaction token validation
# ---------------------------------------------------------------------------

class TestRedactionTokenShape:
    @pytest.mark.parametrize(
        "token",
        [
            "<REDACTED:password>",
            "<REDACTED:email>",
            "<REDACTED:phone>",
            "<REDACTED:aadhaar>",
            "<REDACTED:pan>",
            "<REDACTED:card_number>",
            "<REDACTED:document>",
            "<REDACTED:face,count=1>",
            "<REDACTED:face,count=42>",
            "<REDACTED:generic_pii,count=3>",
        ],
    )
    def test_valid_tokens_pass(self, token):
        assert is_valid_redaction_token(token) is True

    @pytest.mark.parametrize(
        "value",
        [
            "hunter2",
            "someone@example.com",
            "<REDACTED:email:h***@x.com>",  # partial-mask smuggling attempt
            "<REDACTED:unknown_type>",
            "<REDACTED:face>",  # missing count
            "<REDACTED:face,count=abc>",  # non-numeric count
            "REDACTED:email",  # missing brackets
            "",
        ],
    )
    def test_invalid_or_raw_values_rejected(self, value):
        assert is_valid_redaction_token(value) is False


class TestSceneNodeValidation:
    def _base(self, **overrides):
        base = dict(
            id="n1",
            role="textbox",
            label="Email",
            type="email",
            bbox=[0, 0, 100, 20],
            value_redacted=None,
            source="dom",
        )
        base.update(overrides)
        return base

    def test_accepts_a_well_formed_node(self):
        node = SceneNode(**self._base(value_redacted="<REDACTED:email>"))
        assert node.value_redacted == "<REDACTED:email>"

    def test_accepts_null_value_redacted(self):
        node = SceneNode(**self._base(value_redacted=None))
        assert node.value_redacted is None

    def test_rejects_a_raw_password_as_value_redacted(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(value_redacted="hunter2SuperSecret"))

    def test_rejects_a_raw_email_as_value_redacted(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(value_redacted="someone@example.com"))

    def test_rejects_a_partial_mask_smuggling_attempt(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(value_redacted="<REDACTED:email:h***@x.com>"))

    def test_rejects_an_unrecognized_token(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(value_redacted="<REDACTED:ssn>"))

    def test_rejects_bbox_with_wrong_length(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(bbox=[0, 0, 100]))

    def test_rejects_a_label_containing_a_raw_email(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(label="Contact: someone@example.com", value_redacted=None))

    def test_rejects_a_label_containing_a_long_digit_sequence(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(label="Aadhaar 234123412346", value_redacted=None))

    def test_accepts_a_harmless_label(self):
        node = SceneNode(**self._base(label="Submit button"))
        assert node.label == "Submit button"

    def test_rejects_unknown_source(self):
        with pytest.raises(ValidationError):
            SceneNode(**self._base(source="server"))


class TestSceneGraphValidation:
    def _node(self, id="n1"):
        return dict(id=id, role="button", label="Go", type=None, bbox=[0, 0, 10, 10],
                    value_redacted=None, source="dom")

    def test_accepts_a_well_formed_graph(self):
        graph = SceneGraph(
            version="1.0",
            viewport=Viewport(w=1024, h=768),
            timestamp=1735900000,
            nodes=[self._node()],
            focused_node_id="n1",
            task_context="filling a form",
        )
        assert len(graph.nodes) == 1

    def test_rejects_a_focused_node_id_that_does_not_exist(self):
        with pytest.raises(ValidationError):
            SceneGraph(
                version="1.0",
                viewport=Viewport(w=1024, h=768),
                timestamp=1,
                nodes=[self._node(id="n1")],
                focused_node_id="n99",
            )

    def test_accepts_null_focused_node_id(self):
        graph = SceneGraph(
            version="1.0",
            viewport=Viewport(w=1024, h=768),
            timestamp=1,
            nodes=[self._node()],
            focused_node_id=None,
        )
        assert graph.focused_node_id is None

    def test_a_single_bad_node_fails_the_whole_graph(self):
        with pytest.raises(ValidationError):
            SceneGraph(
                version="1.0",
                viewport=Viewport(w=1024, h=768),
                timestamp=1,
                nodes=[
                    self._node(id="n1"),
                    {**self._node(id="n2"), "value_redacted": "raw-leaked-value"},
                ],
            )


# ---------------------------------------------------------------------------
# Action validation — the critical "no smuggled value is representable" claim
# ---------------------------------------------------------------------------

class TestFillLocalActionCannotCarryALiteralValue:
    def test_a_well_formed_fill_local_action_is_accepted(self):
        action = FillLocalAction(action="fill_local", target_node_id="n1", value_source="profile.name")
        assert action.value_source == "profile.name"

    def test_extra_value_field_is_rejected_outright(self):
        """
        This is the load-bearing test. If Pydantic's extra="forbid" config
        were ever accidentally removed from FillLocalAction, this test fails —
        making that regression loud instead of silent.
        """
        with pytest.raises(ValidationError):
            FillLocalAction(
                action="fill_local",
                target_node_id="n1",
                value_source="profile.name",
                value="attacker-controlled-literal-value",
            )

    def test_extra_value_field_rejected_even_with_invalid_value_source(self):
        with pytest.raises(ValidationError):
            FillLocalAction(
                action="fill_local",
                target_node_id="n1",
                value_source="server_knows_best",
                value="hunter2",
            )

    def test_invalid_value_source_enum_is_rejected(self):
        with pytest.raises(ValidationError):
            FillLocalAction(action="fill_local", target_node_id="n1", value_source="server_knows_best")

    def test_missing_value_source_is_rejected(self):
        with pytest.raises(ValidationError):
            FillLocalAction(action="fill_local", target_node_id="n1")

    def test_the_model_has_no_value_field_in_its_schema_at_all(self):
        """
        Structural proof, not just a runtime rejection test: introspect
        the Pydantic model's field set directly and assert 'value' is not
        among them. This protects against a future refactor that adds
        `value: str | None = None` "just to be safe" — that itself would
        reopen the smuggling path even if some other check also rejected
        the extra field.
        """
        field_names = set(FillLocalAction.model_fields.keys())
        assert "value" not in field_names
        assert field_names == {"action", "target_node_id", "value_source", "reasoning"}


class TestOtherActions:
    def test_click_requires_target_node_id(self):
        with pytest.raises(ValidationError):
            ClickAction(action="click")

    def test_scroll_rejects_zero_amount(self):
        with pytest.raises(ValidationError):
            ScrollAction(action="scroll", direction="down", amount_px=0)

    def test_scroll_rejects_negative_amount(self):
        with pytest.raises(ValidationError):
            ScrollAction(action="scroll", direction="down", amount_px=-10)

    def test_scroll_rejects_invalid_direction(self):
        with pytest.raises(ValidationError):
            ScrollAction(action="scroll", direction="sideways", amount_px=100)

    def test_wait_accepts_no_reason(self):
        action = WaitAction(action="wait")
        assert action.reason is None

    def test_done_accepts_a_summary(self):
        action = DoneAction(action="done", summary="Logged in successfully")
        assert action.summary == "Logged in successfully"

    def test_all_actions_forbid_unknown_extra_fields(self):
        for cls, kwargs in [
            (ClickAction, dict(action="click", target_node_id="n1")),
            (ScrollAction, dict(action="scroll", direction="down", amount_px=10)),
            (WaitAction, dict(action="wait")),
            (DoneAction, dict(action="done")),
        ]:
            with pytest.raises(ValidationError):
                cls(**kwargs, unexpected_field="should not be allowed")

class TestPlan:
    def test_plan_accepts_valid_actions(self):
        plan = Plan(actions=[
            ClickAction(action="click", target_node_id="n1"),
            FillLocalAction(action="fill_local", target_node_id="n2", value_source="profile.email")
        ])
        assert len(plan.actions) == 2
