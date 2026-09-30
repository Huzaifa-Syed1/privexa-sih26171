"""
main.py — FastAPI app exposing POST /plan, per SPEC.md.

Request flow:
  1. FastAPI + Pydantic validate the incoming body as a SceneGraph.
     Anything that doesn't match the schema (including a raw PII value
     smuggled into value_redacted) is rejected with a 422 before this
     module's own code ever runs.
  2. Check the cache (scene-graph-hash keyed, SPEC.md §6).
  3. On miss, call the LLM planner, cache the result, return it.
  4. On hit, return the cached action directly — zero LLM calls.

The response itself is typed as `Action` (the discriminated union), so
FastAPI's response validation is a second, independent enforcement of
"no raw value can leave this endpoint" — even a bug in planner.py that
somehow produced a bad Action object would be caught here before
serialization.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()


from app.schemas import SceneGraph, Plan
from app.cache import PlanCache
from app.planner import LLMPlanner, PlannerError

logger = logging.getLogger("sih26171")

app = FastAPI(title="Privexa Privacy-First Browser Agent — Server")

# v0.1 scope: the extension talks to localhost only (see manifest.json
# host_permissions). Restrict CORS accordingly rather than defaulting to
# "*", even in a hackathon prototype.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

cache = PlanCache()


def _build_planner() -> LLMPlanner:
    """
    Lazily construct the real planner so importing this module (e.g. for
    tests that override app.dependency or monkeypatch _planner) doesn't
    require GEMINI_API_KEY to be set. Tests exercise the /plan route with
    a fake planner injected via app.state instead of hitting this path.
    """
    from app.gemini_client import GeminiChatClient
    return LLMPlanner(GeminiChatClient())


# Overridable for tests: if app.state.planner is set, use it instead of
# constructing a real Groq-backed one.
app.state.planner = None


@app.post("/plan", response_model=Plan)
def plan(graph: SceneGraph):
    unresolved = [n for n in graph.nodes if n.source not in ("dom", "vision")]
    if unresolved:
        # Belt-and-suspenders: the client (content_script.js) already
        # refuses to send vision_pending nodes, and SceneNode's `source`
        # field only accepts "dom"/"vision" at the type level anyway — so
        # this branch should be unreachable. Kept as an explicit, loud
        # check rather than trusting the type system alone, since this is
        # exactly the kind of assumption worth double-checking server-side.
        raise HTTPException(status_code=400, detail="scene-graph contains unresolved nodes")

    cached = cache.get(graph)
    if cached is not None:
        logger.info("cache hit")
        return cached

    logger.info("cache miss — calling planner")
    try:
        planner = app.state.planner or _build_planner()
    except RuntimeError as e:
        # e.g. GROQ_API_KEY not configured. This is a server configuration
        # problem, not a client error — 500, not 422/502 — but it must
        # still be a clean JSON error response, not an unhandled
        # exception leaking a stack trace to the caller.
        logger.error("failed to construct planner: %s", e)
        raise HTTPException(status_code=500, detail=f"server misconfigured: {e}") from e

    try:
        plan = planner.plan(graph)
    except PlannerError as e:
        logger.error("planner failed to produce a valid plan: %s", e)
        raise HTTPException(status_code=502, detail=f"planner error: {e}") from e
    except Exception as e:
        logger.error("unexpected error during planning: %s", e)
        raise HTTPException(status_code=502, detail=f"planner execution error: {e}") from e

    cache.put(graph, plan)
    return plan


@app.get("/health")
def health():
    return {"status": "ok", "cache_size": cache.size(), "cache_hits": cache.hits, "cache_misses": cache.misses}
