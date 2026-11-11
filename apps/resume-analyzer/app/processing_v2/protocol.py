"""Validate a delivery before choosing its API or touching a document."""

import json
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit

import jwt


class InvalidJob(Exception):
    """Reject this delivery without retry; never expose input in diagnostics."""


class ClosedJob(Exception):
    """Acknowledge an expired, deleted or already completed operation."""


class RetryJob(Exception):
    """Return a transient failure to the broker's native delayed retry."""


class DocumentError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
FIELDS = {"job_id", "task_id", "file_id", "operation", "mode", "attempt", "deadline"}


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InvalidJob()
        value[key] = item
    return value


@dataclass(frozen=True)
class Job:
    command: dict
    token: str
    deadline: float

    def check_open(self):
        if time.time() >= self.deadline:
            raise ClosedJob()

    @property
    def id(self):
        return self.command["job_id"]


def verify_delivery(body, properties, mode, operation, public_key, now=None):
    now = time.time() if now is None else now
    try:
        if len(body) > 65536:
            raise InvalidJob()
        command = json.loads(body, object_pairs_hook=unique_object)
        if not isinstance(command, dict) or set(command) != FIELDS:
            raise InvalidJob()
        if command["mode"] != mode or command["operation"] != operation:
            raise InvalidJob()
        if any(not isinstance(command[k], str) or not UUID.fullmatch(command[k])
               for k in ("job_id", "task_id", "file_id")):
            raise InvalidJob()
        if type(command["attempt"]) is not int or not 1 <= command["attempt"] <= 100:
            raise InvalidJob()
        date = command["deadline"]
        if not isinstance(date, str) or "T" not in date:
            raise InvalidJob()
        parsed = datetime.fromisoformat(date.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise InvalidJob()
        deadline = parsed.timestamp()
        if not math.isfinite(deadline):
            raise InvalidJob()
        if properties.content_type != "application/json" or properties.delivery_mode != 2 or properties.message_id != command["job_id"]:
            raise InvalidJob()
        token = (properties.headers or {}).get("x-job-token")
        if not isinstance(token, str) or len(token) > 16384:
            raise InvalidJob()
        header = jwt.get_unverified_header(token)
        if header != {"alg": "RS256", "typ": "hr-processing-job+jwt"}:
            raise InvalidJob()
        # Check expiry only after verifying signature, issuer and scope. An
        # attacker must not be able to turn an invalid token into a harmless ACK.
        claims = jwt.decode(token, public_key, algorithms=["RS256"],
                            issuer=f"hr-{mode}-jobs", audience=f"hr-{mode}-job-api",
                            options={"verify_exp": False, "verify_iat": False,
                                     "require": ["sub", "iat", "exp"]})
        for key in ("mode", "operation", "task_id", "file_id", "attempt"):
            if type(claims.get(key)) is not type(command[key]) or claims[key] != command[key]:
                raise InvalidJob()
        if claims["sub"] != command["job_id"] or claims.get("aud") != f"hr-{mode}-job-api":
            raise InvalidJob()
        if type(claims["iat"]) is not int or type(claims["exp"]) is not int or claims["iat"] > now + 5 or claims["exp"] <= claims["iat"]:
            raise InvalidJob()
        if claims["exp"] != math.floor(deadline):
            raise InvalidJob()
        expected = {"input:read", "file:read", "progress:write", "result:write"}
        if operation == "prepare":
            expected.add("output:write")
        permissions = claims.get("permissions")
        if not isinstance(permissions, list) or any(not isinstance(p, str) for p in permissions) or set(permissions) != expected:
            raise InvalidJob()
        if now >= deadline or now >= claims["exp"]:
            raise ClosedJob()
        return Job(command, token, min(deadline, claims["exp"]))
    except (InvalidJob, ClosedJob):
        raise
    except (ValueError, TypeError, KeyError, OverflowError, jwt.PyJWTError):
        raise InvalidJob() from None


def api_address(value, mode):
    url = urlsplit(value)
    prefix = "/internal/guest" if mode == "guest" else "/internal/app"
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment or url.path.rstrip("/") != prefix:
        raise ValueError(f"Invalid {mode} API configuration")
    return value.rstrip("/")
