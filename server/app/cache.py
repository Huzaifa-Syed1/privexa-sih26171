"""
cache.py — scene-graph-hash cache, per SPEC.md §6.

cache_key = sha256(json.dumps(scene_graph_without_timestamp_and_bbox, sort_keys=True))

bbox and timestamp are excluded because pixel-perfect layout jitter and
time shouldn't bust the cache — the same *semantic* state should hit the
same cached plan.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Optional

from app.schemas import SceneGraph, Plan


def _strip_volatile_fields(graph: SceneGraph) -> dict:
    """
    Produce the dict that actually gets hashed: every field except
    timestamp (top-level), action_history, and bbox (per-node). Field order from Pydantic's
    model_dump is stable per-model, but we additionally sort_keys on the
    JSON dump so dict key order can never affect the hash either.
    """
    data = graph.model_dump(mode="json")
    data.pop("timestamp", None)
    data.pop("action_history", None)
    for node in data.get("nodes", []):
        node.pop("bbox", None)
    return data


def compute_cache_key(graph: SceneGraph) -> str:
    stripped = _strip_volatile_fields(graph)
    serialized = json.dumps(stripped, sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


@dataclass
class CacheEntry:
    plan: Plan
    stored_at: float


class PlanCache:
    """
    In-memory cache, v0.1 scope (SPEC.md §7 — no persistence required for
    the 36-hour prototype). TTL exists so a stale cached plan for a page
    that has since changed doesn't get served forever.
    """

    def __init__(self, ttl_seconds: float = 300.0):
        self._store: dict[str, CacheEntry] = {}
        self._ttl = ttl_seconds
        self.hits = 0
        self.misses = 0

    def get(self, graph: SceneGraph) -> Optional[Plan]:
        key = compute_cache_key(graph)
        entry = self._store.get(key)
        if entry is None:
            self.misses += 1
            return None
        if (time.time() - entry.stored_at) > self._ttl:
            # Expired — treat as a miss and evict.
            del self._store[key]
            self.misses += 1
            return None
        self.hits += 1
        return entry.plan

    def put(self, graph: SceneGraph, plan: Plan) -> None:
        key = compute_cache_key(graph)
        self._store[key] = CacheEntry(plan=plan, stored_at=time.time())

    def size(self) -> int:
        return len(self._store)

    def clear(self) -> None:
        self._store.clear()
        self.hits = 0
        self.misses = 0
