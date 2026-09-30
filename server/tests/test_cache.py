import time

import pytest

from app.cache import PlanCache, compute_cache_key
from app.schemas import SceneGraph, Viewport, SceneNode, Plan, ClickAction, WaitAction


def make_graph(bbox=(0, 0, 10, 10), timestamp=1, node_id="n1", label="Go", extra_node=False):
    nodes = [
        SceneNode(id=node_id, role="button", label=label, type=None,
                   bbox=list(bbox), value_redacted=None, source="dom")
    ]
    if extra_node:
        nodes.append(
            SceneNode(id="n2", role="textbox", label="Email", type="email",
                       bbox=[0, 0, 5, 5], value_redacted="<REDACTED:email>", source="dom")
        )
    return SceneGraph(
        version="1.0",
        viewport=Viewport(w=1024, h=768),
        timestamp=timestamp,
        nodes=nodes,
        focused_node_id=None,
        task_context=None,
    )


class TestComputeCacheKey:
    def test_same_semantic_graph_different_timestamp_same_key(self):
        g1 = make_graph(timestamp=1000)
        g2 = make_graph(timestamp=9999999)
        assert compute_cache_key(g1) == compute_cache_key(g2)

    def test_same_semantic_graph_different_bbox_same_key(self):
        g1 = make_graph(bbox=(0, 0, 10, 10))
        g2 = make_graph(bbox=(500, 500, 999, 999))
        assert compute_cache_key(g1) == compute_cache_key(g2)

    def test_different_label_produces_different_key(self):
        g1 = make_graph(label="Go")
        g2 = make_graph(label="Submit")
        assert compute_cache_key(g1) != compute_cache_key(g2)

    def test_different_node_set_produces_different_key(self):
        g1 = make_graph(extra_node=False)
        g2 = make_graph(extra_node=True)
        assert compute_cache_key(g1) != compute_cache_key(g2)

    def test_key_is_deterministic_across_repeated_calls(self):
        g = make_graph()
        assert compute_cache_key(g) == compute_cache_key(g)

    def test_key_is_a_hex_sha256_digest(self):
        g = make_graph()
        key = compute_cache_key(g)
        assert len(key) == 64
        int(key, 16)  # raises ValueError if not valid hex


class TestPlanCache:
    def test_miss_on_empty_cache(self):
        cache = PlanCache()
        graph = make_graph()
        assert cache.get(graph) is None
        assert cache.misses == 1
        assert cache.hits == 0

    def test_hit_after_put(self):
        cache = PlanCache()
        graph = make_graph()
        plan = Plan(actions=[ClickAction(action="click", target_node_id="n1")])

        cache.put(graph, plan)
        result = cache.get(graph)

        assert result == plan
        assert cache.hits == 1

    def test_hit_on_semantically_identical_graph_with_different_bbox_and_timestamp(self):
        cache = PlanCache()
        g1 = make_graph(bbox=(0, 0, 10, 10), timestamp=100)
        g2 = make_graph(bbox=(200, 200, 400, 400), timestamp=999999)
        plan = Plan(actions=[WaitAction(action="wait")])

        cache.put(g1, plan)
        result = cache.get(g2)

        assert result == plan
        assert cache.hits == 1

    def test_miss_on_semantically_different_graph(self):
        cache = PlanCache()
        g1 = make_graph(label="Go")
        g2 = make_graph(label="Submit")
        cache.put(g1, Plan(actions=[ClickAction(action="click", target_node_id="n1")]))

        assert cache.get(g2) is None
        assert cache.misses == 1

    def test_expired_entry_is_treated_as_a_miss(self):
        cache = PlanCache(ttl_seconds=0.05)
        graph = make_graph()
        cache.put(graph, Plan(actions=[ClickAction(action="click", target_node_id="n1")]))

        time.sleep(0.1)
        result = cache.get(graph)

        assert result is None
        assert cache.misses == 1

    def test_expired_entry_is_evicted_from_the_store(self):
        cache = PlanCache(ttl_seconds=0.05)
        graph = make_graph()
        cache.put(graph, Plan(actions=[ClickAction(action="click", target_node_id="n1")]))
        time.sleep(0.1)
        cache.get(graph)  # triggers eviction
        assert cache.size() == 0

    def test_size_reflects_number_of_distinct_entries(self):
        cache = PlanCache()
        cache.put(make_graph(label="A"), Plan(actions=[WaitAction(action="wait")]))
        cache.put(make_graph(label="B"), Plan(actions=[WaitAction(action="wait")]))
        assert cache.size() == 2

    def test_put_overwrites_existing_entry_for_the_same_key(self):
        cache = PlanCache()
        graph = make_graph()
        cache.put(graph, Plan(actions=[WaitAction(action="wait")]))
        cache.put(graph, Plan(actions=[ClickAction(action="click", target_node_id="n1")]))
        result = cache.get(graph)
        assert isinstance(result.actions[0], ClickAction)

    def test_clear_resets_store_and_counters(self):
        cache = PlanCache()
        graph = make_graph()
        cache.put(graph, Plan(actions=[WaitAction(action="wait")]))
        cache.get(graph)
        cache.get(make_graph(label="different"))

        cache.clear()

        assert cache.size() == 0
        assert cache.hits == 0
        assert cache.misses == 0
