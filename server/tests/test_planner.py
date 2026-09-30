import json

import pytest

from app.planner import build_prompt, parse_llm_response, LLMPlanner, PlannerError
from app.schemas import SceneGraph, Viewport, SceneNode, Plan, ClickAction, FillLocalAction


def make_graph(nodes=None, focused_node_id=None, task_context=None):
    if nodes is None:
        nodes = [
            SceneNode(id="n1", role="textbox", label="Email", type="email",
                       bbox=[0, 0, 100, 20], value_redacted="<REDACTED:email>", source="dom"),
            SceneNode(id="n2", role="button", label="Submit", type=None,
                       bbox=[0, 30, 60, 20], value_redacted=None, source="dom"),
        ]
    return SceneGraph(
        version="1.0",
        viewport=Viewport(w=1024, h=768),
        timestamp=1,
        nodes=nodes,
        focused_node_id=focused_node_id,
        task_context=task_context,
    )


# ---------------------------------------------------------------------------
# build_prompt
# ---------------------------------------------------------------------------

class TestBuildPrompt:
    def test_includes_node_id_role_and_label(self):
        prompt = build_prompt(make_graph())
        assert "id=n1" in prompt
        assert "role=textbox" in prompt
        assert 'label="Email"' in prompt

    def test_includes_redaction_token_but_never_a_raw_value(self):
        prompt = build_prompt(make_graph())
        assert "<REDACTED:email>" in prompt

    def test_includes_task_context_when_present(self):
        prompt = build_prompt(make_graph(task_context="log in to the portal"))
        assert "log in to the portal" in prompt

    def test_omits_task_line_when_absent(self):
        prompt = build_prompt(make_graph(task_context=None))
        assert "Task:" not in prompt

    def test_includes_focused_node_when_present(self):
        prompt = build_prompt(make_graph(focused_node_id="n1"))
        assert "Focused node: n1" in prompt

    def test_asks_for_the_next_plan(self):
        prompt = build_prompt(make_graph())
        assert "next plan" in prompt.lower()


# ---------------------------------------------------------------------------
# parse_llm_response — the adversarial/robustness half
# ---------------------------------------------------------------------------

class TestParseLlmResponseHappyPath:
    def test_parses_a_click_action_in_a_plan(self):
        plan = parse_llm_response('{"actions": [{"action": "click", "target_node_id": "n2"}]}')
        assert isinstance(plan, Plan)
        assert len(plan.actions) == 1
        assert isinstance(plan.actions[0], ClickAction)
        assert plan.actions[0].target_node_id == "n2"

    def test_parses_a_fill_local_action(self):
        plan = parse_llm_response(
            '{"actions": [{"action": "fill_local", "target_node_id": "n1", "value_source": "profile.email"}]}'
        )
        assert isinstance(plan.actions[0], FillLocalAction)

    def test_tolerates_markdown_code_fence_wrapping(self):
        raw = '```json\n{"actions": [{"action": "click", "target_node_id": "n2"}]}\n```'
        plan = parse_llm_response(raw)
        assert isinstance(plan.actions[0], ClickAction)

    def test_tolerates_plain_code_fence_without_json_tag(self):
        raw = '```\n{"actions": [{"action": "click", "target_node_id": "n2"}]}\n```'
        plan = parse_llm_response(raw)
        assert isinstance(plan.actions[0], ClickAction)

    def test_tolerates_surrounding_whitespace(self):
        raw = '  \n  {"actions": [{"action": "wait"}]}  \n  '
        plan = parse_llm_response(raw)
        assert plan.actions[0].action == "wait"


class TestParseLlmResponseRejectsBadOutput:
    def test_raises_on_non_json_text(self):
        with pytest.raises(PlannerError):
            parse_llm_response("Sure! I'll click the submit button for you.")

    def test_raises_on_valid_json_but_unknown_action_type(self):
        with pytest.raises(PlannerError):
            parse_llm_response('{"actions": [{"action": "eval", "code": "alert(1)"}]}')

    def test_raises_on_valid_json_missing_required_field(self):
        with pytest.raises(PlannerError):
            parse_llm_response('{"actions": [{"action": "click"}]}')  # missing target_node_id

    def test_raises_on_empty_string(self):
        with pytest.raises(PlannerError):
            parse_llm_response("")

    def test_raises_on_json_array_instead_of_object(self):
        with pytest.raises(PlannerError):
            parse_llm_response('[{"action": "click", "target_node_id": "n1"}]')

    def test_THE_CRITICAL_CASE_raises_when_llm_tries_to_smuggle_a_literal_value(self):
        raw = json.dumps({"actions": [{
            "action": "fill_local",
            "target_node_id": "n1",
            "value_source": "profile.email",
            "value": "someone@realaddress.com",
        }]})
        with pytest.raises(PlannerError):
            parse_llm_response(raw)

    def test_raises_when_llm_invents_a_new_action_type_that_sounds_plausible(self):
        raw = json.dumps({"actions": [{"action": "fill_form", "fields": {"email": "x@y.com"}}]})
        with pytest.raises(PlannerError):
            parse_llm_response(raw)

    def test_raises_on_scroll_with_invalid_direction(self):
        raw = json.dumps({"actions": [{"action": "scroll", "direction": "diagonally", "amount_px": 100}]})
        with pytest.raises(PlannerError):
            parse_llm_response(raw)


# ---------------------------------------------------------------------------
# LLMPlanner — orchestration with a fake client
# ---------------------------------------------------------------------------

class FakeChatClient:
    def __init__(self, response_text):
        self.response_text = response_text
        self.last_system_prompt = None
        self.last_user_prompt = None

    def complete(self, system_prompt, user_prompt):
        self.last_system_prompt = system_prompt
        self.last_user_prompt = user_prompt
        return self.response_text


class TestLLMPlanner:
    def test_plan_returns_a_validated_plan_from_a_well_formed_response(self):
        client = FakeChatClient('{"actions": [{"action": "click", "target_node_id": "n2"}]}')
        planner = LLMPlanner(client)

        plan = planner.plan(make_graph())

        assert isinstance(plan, Plan)
        assert isinstance(plan.actions[0], ClickAction)
        assert plan.actions[0].target_node_id == "n2"

    def test_plan_passes_the_scene_graph_content_into_the_prompt(self):
        client = FakeChatClient('{"actions": [{"action": "wait"}]}')
        planner = LLMPlanner(client)

        planner.plan(make_graph(task_context="fill the login form"))

        assert "fill the login form" in client.last_user_prompt
        assert client.last_system_prompt is not None
        assert "redacted" in client.last_system_prompt.lower()

    def test_plan_raises_planner_error_on_malformed_response_rather_than_returning_garbage(self):
        client = FakeChatClient("I think you should click the button")
        planner = LLMPlanner(client)

        with pytest.raises(PlannerError):
            planner.plan(make_graph())

    def test_plan_raises_when_the_llm_smuggles_a_value_even_through_the_full_orchestration_path(self):
        client = FakeChatClient(json.dumps({"actions": [{
            "action": "fill_local",
            "target_node_id": "n1",
            "value_source": "profile.name",
            "value": "leaked-secret",
        }]}))
        planner = LLMPlanner(client)

        with pytest.raises(PlannerError):
            planner.plan(make_graph())
