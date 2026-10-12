"""Integration checks against this Compose project; Python 3, no dependencies.

Temporarily creates one files row and one S3 object, restarts the two storage
containers, and removes only those uniquely identified test artifacts.
"""
import json
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def run(*args, check=True):
    result = subprocess.run(args, cwd=ROOT, text=True, encoding="utf-8",
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}):\n{result.stderr}\n{result.stdout}")
    return result


def compose(*args, check=True):
    return run("docker", "compose", *args, check=check)


def sql(query):
    return compose("exec", "-T", "postgres", "sh", "-c",
                   'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                   '-v ON_ERROR_STOP=1 -At -c "$1"', "--", query).stdout.strip()


def s3(script):
    return compose("run", "--rm", "--no-deps", "--entrypoint", "/bin/sh",
                   "s3-init", "-ec", script).stdout.strip()


def ready():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        ids = compose("ps", "-q", "postgres", "seaweedfs").stdout.split()
        if len(ids) == 2:
            states = run("docker", "inspect", "--format",
                         "{{.State.Health.Status}}", *ids).stdout.split()
            if states == ["healthy", "healthy"]:
                return
        time.sleep(2)
    raise RuntimeError("Storage containers did not become healthy within 180 seconds")


def catalog():
    return json.loads(sql("""
        SELECT json_build_object(
          'columns', (SELECT json_agg(row_to_json(c) ORDER BY c.table_name, c.ordinal_position)
            FROM (SELECT table_name, column_name, ordinal_position,
              format_type(a.atttypid, a.atttypmod) AS type,
              is_nullable, column_default
              FROM information_schema.columns i
              JOIN pg_class t ON t.relname = i.table_name
                AND t.relnamespace = 'public'::regnamespace
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = i.column_name
              WHERE table_schema = 'public' AND table_name <> 'flyway_schema_history') c),
          'constraints', (SELECT json_agg(row_to_json(c) ORDER BY c.table_name, c.name)
            FROM (SELECT t.relname AS table_name, co.conname AS name, co.contype AS kind,
              ARRAY(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(num, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.num ORDER BY ord) AS columns,
              rt.relname AS target,
              ARRAY(SELECT a.attname FROM unnest(co.confkey) WITH ORDINALITY k(num, ord)
                JOIN pg_attribute a ON a.attrelid = rt.oid AND a.attnum = k.num ORDER BY ord) AS target_columns,
              co.confdeltype AS delete_action, co.confupdtype AS update_action,
              pg_get_constraintdef(co.oid) AS definition
              FROM pg_constraint co JOIN pg_class t ON t.oid = co.conrelid
              LEFT JOIN pg_class rt ON rt.oid = co.confrelid
              WHERE t.relnamespace = 'public'::regnamespace AND t.relname <> 'flyway_schema_history'
                AND co.contype IN ('p', 'u', 'f', 'c')) c),
          'indexes', (SELECT json_agg(row_to_json(i) ORDER BY indexname)
            FROM pg_indexes i WHERE schemaname = 'public' AND tablename <> 'flyway_schema_history')
        );
    """))


def check_schema(schema):
    spec = (ROOT / "docs/candidate_matching_architecture.md").read_text(encoding="utf-8")
    block = spec.split("```text", 1)[1].split("```", 1)[0]
    expected = {}
    primary, unique, foreign = set(), set(), set()
    types = {"UUID": "uuid", "TIMESTAMPTZ": "timestamp with time zone",
             "TEXT[]": "text[]", "TEXT": "text", "BOOLEAN": "boolean",
             "BIGINT": "bigint", "JSONB": "jsonb"}
    table = None
    for line in block.splitlines():
        if not line.strip():
            continue
        if not line.startswith(" "):
            table = line.strip()
            continue
        name, type_name, rest = re.match(r"\s+(\w+)\s+([A-Z]+(?:\([^)]*\)|\[\])?\??)(.*)", line).groups()
        nullable = type_name.endswith("?")
        type_name = type_name.rstrip("?")
        normalized = types.get(type_name, type_name.lower())
        normalized = normalized.replace("varchar(", "character varying(").replace("char(", "character(")
        expected[table, name] = (normalized, "YES" if nullable else "NO",
                                 "true" if "DEFAULT TRUE" in rest else None)
        if " PK" in rest:
            primary.add((table, (name,)))
        if " UQ" in rest:
            unique.add((table, (name,)))
        fk = re.search(r"FK → (\w+)\.(\w+)", rest)
        if fk:
            foreign.add((table, (name,), fk[1], (fk[2],)))
    actual = {(c["table_name"], c["column_name"]):
              (c["type"], c["is_nullable"], c["column_default"]) for c in schema["columns"]}
    assert actual == expected, f"Column mismatch: {actual.items() ^ expected.items()}"
    tables = sorted({key[0] for key in expected})
    assert len(tables) == 8
    assert json.loads(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables "
                         "WHERE schemaname = 'public';")) == sorted(tables + ["flyway_schema_history"])
    unique |= {("files", ("bucket", "object_key")), ("profile_ratings", ("resume_id", "profile_id"))}
    constraints = schema["constraints"]
    for kind, wanted in [("p", primary), ("u", unique)]:
        assert {(c["table_name"], tuple(c["columns"])) for c in constraints if c["kind"] == kind} == wanted
    assert {(c["table_name"], tuple(c["columns"]), c["target"], tuple(c["target_columns"]))
            for c in constraints if c["kind"] == "f"} == foreign
    assert all(c["delete_action"] == c["update_action"] == "a" for c in constraints if c["kind"] == "f")
    checks = {(c["table_name"], tuple(c["columns"])): c["definition"]
              for c in constraints if c["kind"] == "c"}
    allowed = {("resumes", ("status",)): {"in_work", "in_process", "historical"},
               ("resumes", ("scoring_status",)): {"pending", "processing", "completed", "failed"},
               ("resume_events", ("event_type",)): {"uploaded", "replaced", "replacement_rejected",
                                                     "scored", "scoring_failed", "status_changed"}}
    assert set(checks) == set(allowed) | {("profile_ratings", ("score",))}
    for key, values in allowed.items():
        assert set(re.findall(r"'([^']*)'", checks[key])) == values
    assert re.search(r"score >= .*0", checks["profile_ratings", ("score",)])
    assert re.search(r"score <= .*100", checks["profile_ratings", ("score",)])
    indexes = schema["indexes"]
    assert len(indexes) == len(primary) + len(unique) + 2
    assert any("(cluster_id)" in i["indexdef"] and i["tablename"] == "profiles" for i in indexes)
    assert any("(phone, last_name, first_name, middle_name)" in i["indexdef"]
               and "WHERE (is_active = true)" in i["indexdef"]
               and i["tablename"] == "candidate_blacklist" for i in indexes)
    assert sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal "
               "AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace);") == "0"
    # Exercise CHECK rejection in PostgreSQL, with no committed fixtures.
    sql("""DO $$ BEGIN
      BEGIN
        INSERT INTO resumes VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          'unknown', 'pending', now(), now());
        RAISE EXCEPTION 'Invalid business status accepted';
      EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN
        INSERT INTO resumes VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          'in_work', 'unknown', now(), now());
        RAISE EXCEPTION 'Invalid scoring status accepted';
      EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN
        INSERT INTO resume_events (id, resume_id, event_type, created_at)
          VALUES (gen_random_uuid(), gen_random_uuid(), 'unknown', now());
        RAISE EXCEPTION 'Invalid event type accepted';
      EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN
        INSERT INTO profile_ratings (id, resume_id, profile_id, score, calculated_at)
          VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), -0.01, now());
        RAISE EXCEPTION 'Negative score accepted';
      EXCEPTION WHEN check_violation THEN NULL; END;
      BEGIN
        INSERT INTO profile_ratings (id, resume_id, profile_id, score, calculated_at)
          VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 100.01, now());
        RAISE EXCEPTION 'Score above 100 accepted';
      EXCEPTION WHEN check_violation THEN NULL; END;
    END $$;""")
    print(f"PASS: exactly 8 application tables; {len(expected)} columns, PK/FK/UNIQUE/CHECK/defaults/indexes match the specification")


def main():
    compose("config", "--quiet")
    ready()
    schema = catalog()
    check_schema(schema)
    history_query = 'SELECT json_agg(h ORDER BY installed_rank) FROM flyway_schema_history h;'
    history = sql(history_query)
    assert [(r["version"], r["script"], r["success"]) for r in json.loads(history)] == [
        ("1", "V1__initial_schema.sql", True)]
    print("PASS: Flyway V1 applied successfully")
    marker = str(uuid.uuid4())
    key = f"_infrastructure-smoke/{marker}.txt"
    body = f"infrastructure-smoke-{marker}"
    client = 'aws --endpoint-url "$S3_ENDPOINT" s3api '
    bucket = s3('printf "%s" "$S3_BUCKET"')
    # These values appear in SQL literals; bucket names must satisfy S3 naming rules.
    assert re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket), "Invalid S3 bucket name"
    inserted = uploaded = False
    try:
        sql(f"INSERT INTO files (id, bucket, object_key, file_name, created_at) "
            f"VALUES ('{marker}', '{bucket}', '{key}', 'infrastructure-smoke.txt', now());")
        inserted = True
        row_query = f"SELECT row_to_json(f) FROM files f WHERE id = '{marker}';"
        row = sql(row_query)
        uploaded = True  # Clean up the unique key even if upload/read verification fails.
        s3(f"printf '%s' '{body}' >/tmp/smoke.txt; "
           f"{client}put-object --bucket \"$S3_BUCKET\" --key '{key}' --body /tmp/smoke.txt >/dev/null; "
           f"{client}get-object --bucket \"$S3_BUCKET\" --key '{key}' /tmp/read.txt >/dev/null; "
           "cmp /tmp/smoke.txt /tmp/read.txt")
        s3(f"if {client}list-buckets --no-sign-request >/tmp/anonymous 2>&1; then exit 1; fi; "
           "grep -q 'AccessDenied' /tmp/anonymous; "
           f"if AWS_SECRET_ACCESS_KEY=invalid {client}list-buckets >/tmp/invalid 2>&1; then exit 1; fi; "
           "grep -Eq 'SignatureDoesNotMatch|AccessDenied' /tmp/invalid")
        print("PASS: authenticated S3 upload/download; anonymous and invalid credentials rejected")
        compose("run", "--rm", "--no-deps", "flyway", "migrate")
        compose("run", "--rm", "--no-deps", "s3-init")
        assert catalog() == schema and sql(history_query) == history and sql(row_query) == row
        print("PASS: repeated migration and bucket initialization preserve schema/history/data")
        compose("restart", "postgres", "seaweedfs")
        ready()
        assert catalog() == schema and sql(history_query) == history and sql(row_query) == row
        s3(f"{client}get-object --bucket \"$S3_BUCKET\" --key '{key}' /tmp/read.txt >/dev/null; "
           f"test \"$(cat /tmp/read.txt)\" = '{body}'")
        print("PASS: PostgreSQL row, migration history, bucket and S3 object survive storage restart")
        # Also exercise the requested deployment command again with data present.
        compose("up", "-d", "--build")
        ready()
        assert catalog() == schema and sql(history_query) == history and sql(row_query) == row
        s3(f"{client}get-object --bucket \"$S3_BUCKET\" --key '{key}' /tmp/read.txt >/dev/null; "
           f"test \"$(cat /tmp/read.txt)\" = '{body}'")
        print("PASS: repeated docker compose up -d --build preserves PostgreSQL and S3 data")
    finally:
        try:
            if uploaded:
                s3(f"{client}delete-object --bucket \"$S3_BUCKET\" --key '{key}' >/dev/null; "
                   f"if {client}head-object --bucket \"$S3_BUCKET\" --key '{key}' >/tmp/deleted 2>&1; then exit 1; fi; "
                   "grep -Eq '\\(404\\)|Not Found|NoSuchKey' /tmp/deleted")
        finally:
            if inserted:
                sql(f"DELETE FROM files WHERE id = '{marker}';")
    print("PASS: S3 deletion verified; temporary test metadata and object removed")


if __name__ == "__main__":
    main()
