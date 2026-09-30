import pytest
from fastapi.testclient import TestClient

from app.main import app, cache
from app.planner import PlannerError
from app.schemas import Plan, ClickAction, WaitAction, FillLocalAction


class FakePlanner:
    """Injected via app.state.planner so tests never touch the real Groq API."""

    def __init__(self, plan_or_exception):
        self._plan_or_exception = plan_or_exception
        self.call_count = 0

    def plan(self, graph):
        self.call_count += 1
        if isinstance(self._plan_or_exception, Exception):
            raise self._plan_or_exception
        return self._plan_or_exception


@pytest.fixture(autouse=True)
def reset_state():
    cache.clear()
    app.state.planner = None
    yield
    cache.clear()
    app.state.planner = None


def make_valid_graph_payload(**overrides):
    payload = {
        "version": "1.0",
        "viewport": {"w": 1024, "h": 768},
        "timestamp": 1735900000,
        "nodes": [
            {
                "id": "n1",
                "role": "textbox",
                "label": "Email",
                "type": "email",
                "bbox": [0, 0, 100, 20],
                "value_redacted": "<REDACTED:email>",
                "source": "dom",
            },
            {
                "id": "n2",
                "role": "button",
                "label": "Submit",
                "type": None,
                "bbox": [0, 30, 60, 20],
                "value_redacted": None,
                "source": "dom",
            },
        ],
        "focused_node_id": "n1",
        "task_context": "logging in",
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def client():
    return TestClient(app)


class TestHealthEndpoint:
    def test_health_returns_ok(self, client):
        res = client.get("/health")
        assert res.status_code == 200
        assert res.json()["status"] == "ok"


class TestPlanEndpointHappyPath:
    def test_returns_the_plan_from_the_planner(self, client):
        app.state.planner = FakePlanner(Plan(actions=[ClickAction(action="click", target_node_id="n2")]))

        res = client.post("/plan", json=make_valid_graph_payload())

        assert res.status_code == 200
        body = res.json()
        assert "actions" in body
        assert len(body["actions"]) == 1
        assert body["actions"][0]["action"] == "click"
        assert body["actions"][0]["target_node_id"] == "n2"

    def test_second_identical_request_hits_the_cache_and_does_not_call_the_planner_again(self, client):
        fake = FakePlanner(Plan(actions=[WaitAction(action="wait")]))
        app.state.planner = fake

        payload1 = make_valid_graph_payload(timestamp=100)
        payload2 = make_valid_graph_payload(timestamp=999999)  # different timestamp, same semantics

        r1 = client.post("/plan", json=payload1)
        r2 = client.post("/plan", json=payload2)

        assert r1.status_code == 200
        assert r2.status_code == 200
        assert r1.json() == r2.json()
        assert fake.call_count == 1  # only called once — second was a cache hit


class TestPlanEndpointRejectsBadInput:
    def test_rejects_a_scene_graph_with_a_raw_password_value(self, client):
        payload = make_valid_graph_payload()
        payload["nodes"][0]["value_redacted"] = "hunter2SuperSecretPassword"

        res = client.post("/plan", json=payload)

        assert res.status_code == 422  # FastAPI/Pydantic validation error

    def test_rejects_a_scene_graph_with_a_raw_email_in_a_label(self, client):
        payload = make_valid_graph_payload()
        payload["nodes"][0]["label"] = "Contact me at someone@example.com"

        res = client.post("/plan", json=payload)

        assert res.status_code == 422

    def test_rejects_missing_required_fields(self, client):
        res = client.post("/plan", json={"version": "1.0"})
        assert res.status_code == 422

    def test_rejects_an_unrecognized_redaction_token(self, client):
        payload = make_valid_graph_payload()
        payload["nodes"][0]["value_redacted"] = "<REDACTED:ssn>"

        res = client.post("/plan", json=payload)

        assert res.status_code == 422

    def test_rejects_a_focused_node_id_pointing_nowhere(self, client):
        payload = make_valid_graph_payload(focused_node_id="does-not-exist")
        res = client.post("/plan", json=payload)
        assert res.status_code == 422


class TestPlanEndpointHandlesPlannerFailure:
    def test_returns_502_when_the_planner_cannot_produce_a_valid_plan(self, client):
        app.state.planner = FakePlanner(PlannerError("LLM returned garbage"))

        res = client.post("/plan", json=make_valid_graph_payload())

        assert res.status_code == 502

    def test_returns_a_clean_500_not_a_raw_stack_trace_when_planner_construction_fails(self, client, monkeypatch):
        """
        Regression test: found via a real HTTP smoke test that a missing
        GEMINI_API_KEY produced an unhandled 500 with a stack trace instead
        of a clean JSON error. app.state.planner is left as None here
        (no fake injected) to exercise the real _build_planner() path,
        and GEMINI_API_KEY is deliberately unset.
        """
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        app.state.planner = None

        res = client.post("/plan", json=make_valid_graph_payload())

        assert res.status_code == 500
        body = res.json()
        assert "detail" in body
        assert "GEMINI_API_KEY" in body["detail"]

    def test_a_failed_plan_is_not_cached(self, client):
        app.state.planner = FakePlanner(PlannerError("boom"))
        payload = make_valid_graph_payload()

        r1 = client.post("/plan", json=payload)
        assert r1.status_code == 502

        # If it had been (incorrectly) cached, this would still 502 with
        # call_count staying at 1; we specifically want to confirm the
        # planner is invoked AGAIN, proving nothing was cached from the
        # failed attempt.
        fake2 = FakePlanner(PlannerError("boom again"))
        app.state.planner = fake2
        r2 = client.post("/plan", json=payload)
        assert r2.status_code == 502
        assert fake2.call_count == 1


class TestPlanEndpointResponseIsAlwaysAValidPlan:
    def test_response_never_contains_a_value_field_for_fill_local_actions(self, client):
        app.state.planner = FakePlanner(
            Plan(actions=[FillLocalAction(action="fill_local", target_node_id="n1", value_source="profile.name")])
        )

        res = client.post("/plan", json=make_valid_graph_payload())

        assert res.status_code == 200
        action_json = res.json()["actions"][0]
        assert "value" not in action_json
        assert action_json["value_source"] == "profile.name"
