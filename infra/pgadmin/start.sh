#!/bin/sh
set -eu

# Import this project's connection on first launch. Use the image's Python
# to encode environment values correctly, without embedding secrets in JSON.
/venv/bin/python3 - <<'PY'
import json
import os
from pathlib import Path

server = {
    "Name": "Candidate Matching",
    "Group": "HR DAM",
    "Host": "postgres",
    "Port": 5432,
    "MaintenanceDB": os.environ["POSTGRES_DB"],
    "Username": os.environ["POSTGRES_USER"],
    "ConnectionParameters": {
        "sslmode": "prefer",
        "connect_timeout": 10,
    },
}
Path(os.environ["PGADMIN_SERVER_JSON_FILE"]).write_text(
    json.dumps({"Servers": {"1": server}}), encoding="utf-8"
)
PY

exec /entrypoint.sh "$@"
