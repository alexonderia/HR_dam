"""Bounded Ollama calls. Failures must never become candidate ratings."""
import os
import time

import requests

OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.getenv("OLLAMA_MODEL", "qwen3.5:4b-q4_K_M")
MODEL_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", "180"))


class ModelUnavailable(RuntimeError):
    pass


def ask_ollama_chat(system_prompt: str, user_prompt: str, num_ctx: int = 16384,
                    max_tokens: int = 2048, temperature: float = 0.0,
                    timeout: float | None = None, json_mode: bool = True,
                    json_schema: dict | None = None) -> dict:
    payload = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system_prompt},
                     {"role": "user", "content": user_prompt}],
        "stream": False,
        "think": False,
        "keep_alive": "10m",
        "options": {"num_ctx": num_ctx, "num_predict": max_tokens,
                    "temperature": temperature},
    }
    if json_schema is not None:
        payload["format"] = json_schema
    elif json_mode:
        payload["format"] = "json"
    start = time.monotonic()
    try:
        response = requests.post(f"{OLLAMA_URL}/api/chat", json=payload,
                                 timeout=(5, timeout or MODEL_TIMEOUT))
        response.raise_for_status()
        data = response.json()
        content = data.get("message", {}).get("content", "")
        if not isinstance(content, str) or not content.strip() or data.get("error"):
            raise ValueError("Empty model response")
    except (requests.RequestException, ValueError, TypeError, AttributeError) as exc:
        # Never log resume text, prompts or raw model responses.
        raise ModelUnavailable("Модель недоступна или не вернула ответ. Повторите анализ позже.") from exc
    return {"response": content, "total_time_sec": round(time.monotonic() - start, 2)}
