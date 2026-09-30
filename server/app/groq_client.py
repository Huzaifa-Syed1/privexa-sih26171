"""
groq_client.py — real ChatClient implementation backed by Groq's API.

Deliberately thin, same rationale as model_adapters.js on the client
side: the interesting logic (prompt building, response validation) is
already fully tested in planner.py/test_planner.py against a fake
client. This file's only job is the actual network call.
"""

from __future__ import annotations

import os

from groq import Groq

DEFAULT_MODEL = "llama-3.1-8b-instant"


class GroqChatClient:
    def __init__(self, api_key: str | None = None, model: str = DEFAULT_MODEL):
        key = api_key or os.environ.get("GROQ_API_KEY")
        if not key:
            raise RuntimeError(
                "GROQ_API_KEY not set. Export it or pass api_key= explicitly. "
                "Get a key at https://console.groq.com"
            )
        self._client = Groq(api_key=key)
        self._model = model

    def complete(self, system_prompt: str, user_prompt: str) -> str:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.1,  # low temperature — we want consistent, boring, valid-JSON behavior
            max_tokens=200,   # actions are tiny JSON objects; no reason to allow long output
        )
        return response.choices[0].message.content
