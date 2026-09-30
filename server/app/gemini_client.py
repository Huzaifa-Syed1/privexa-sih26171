"""
gemini_client.py — real ChatClient implementation backed by Google's
Gemini API (google-genai SDK) with resilient multi-model fallback and 503/429 retry support.
"""

from __future__ import annotations

import logging
import os
import time

from google import genai
from google.genai import types

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
FALLBACK_MODELS = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-2.5-pro",
    "gemini-flash-latest",
]

logger = logging.getLogger("privexa")


class GeminiChatClient:
    def __init__(self, api_key: str | None = None, model: str = DEFAULT_MODEL):
        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError(
                "GEMINI_API_KEY not set. Export it or pass api_key= explicitly. "
                "Get a free key at https://aistudio.google.com/apikey"
            )
        self._client = genai.Client(api_key=key)
        self._primary_model = model

    def complete(self, system_prompt: str, user_prompt: str) -> str:
        candidate_models = [self._primary_model] + [
            m for m in FALLBACK_MODELS if m != self._primary_model
        ]

        last_exception = None

        for model_name in candidate_models:
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    response = self._client.models.generate_content(
                        model=model_name,
                        contents=user_prompt,
                        config=types.GenerateContentConfig(
                            system_instruction=system_prompt,
                            temperature=0.1,  # low temperature — consistent, boring, valid-JSON behavior
                            max_output_tokens=4096,  # generous token limit to prevent JSON truncation
                            response_mime_type="application/json",  # force strict JSON output format
                        ),
                    )
                    return response.text
                except Exception as e:
                    err_str = str(e).lower()
                    is_notFound = "404" in err_str or "not_found" in err_str or "no longer available" in err_str
                    is_transient = (
                        "503" in err_str
                        or "unavailable" in err_str
                        or "429" in err_str
                        or "resource_exhausted" in err_str
                        or "quota" in err_str
                        or "overloaded" in err_str
                    )
                    last_exception = e
                    if is_notFound:
                        logger.warning(
                            f"Gemini model '{model_name}' returned not available/404. Skipping to fallback model..."
                        )
                        break
                    if is_transient and attempt < max_retries - 1:
                        sleep_time = (attempt + 1) * 2
                        logger.warning(
                            f"Gemini model '{model_name}' hit transient issue ({e}). Retrying in {sleep_time}s... (Attempt {attempt + 1}/{max_retries})"
                        )
                        time.sleep(sleep_time)
                        continue
                    elif is_transient:
                        logger.warning(
                            f"Gemini model '{model_name}' failed after retries. Trying fallback model..."
                        )
                        break
                    raise e

        raise RuntimeError(
            f"All Gemini models failed due to API demand/availability: {last_exception}"
        )

