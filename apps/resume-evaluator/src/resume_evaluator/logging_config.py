"""Console-only technical events. No resume, prompt or response content."""

import json
import logging


def get_logger(name="processing.evaluator"):
    return logging.getLogger(name)


def get_diagnostic_logger():
    return logging.getLogger("processing.evaluator.metadata")


def log_event(logger, level, event, **fields):
    allowed = {"job_id", "profile_id", "attempt", "max_attempts", "model", "http_status",
               "duration_sec", "num_ctx", "max_tokens", "temperature", "timeout",
               "remaining_sec", "policy_version", "original_length", "evaluated_length",
               "prompt_tokens", "generated_tokens", "response_length_chars", "failure_stage"}
    logger.log(level, json.dumps({"event": event, **{k: v for k, v in fields.items() if k in allowed}}, ensure_ascii=False))


EVENT_MESSAGES = {}
