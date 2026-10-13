"""Shared backup/restore plumbing; requires only Python 3 and Docker Compose."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WRITERS = ("frontend", "backend", "worker", "pgadmin")


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def quote_literal(value):
    return "'" + value.replace("'", "''") + "'"


class Project:
    def __init__(self, compose_files=(), project=None):
        self.prefix = ["docker", "compose"]
        if project:
            self.prefix += ["--project-name", project]
        for file in compose_files:
            self.prefix += ["-f", str(Path(file).resolve())]
        self.config = json.loads(self.run("config", "--format", "json").stdout)

    def run(self, *args, stdin=None, stdout=None):
        result = subprocess.run(self.prefix + list(args), cwd=ROOT, stdin=stdin,
                                stdout=stdout or subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            # Never print the configuration JSON: it contains credentials.
            detail = result.stderr.decode("utf-8", errors="replace").strip()[-1500:]
            raise RuntimeError(f"Compose {args[0]} failed ({result.returncode}): {detail}")
        return result

    def sql(self, query):
        result = self.run("exec", "-T", "postgres", "sh", "-ec",
                          'exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                          '-v ON_ERROR_STOP=1 -At -c "$1"', "--", query)
        return result.stdout.decode("utf-8").strip()

    def metadata(self):
        tables = json.loads(self.sql("SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]') "
                                     "FROM pg_tables WHERE schemaname='public' "
                                     "AND tablename <> 'flyway_schema_history';"))
        if not tables:
            raise RuntimeError("Application schema is absent; run Flyway first")
        migrations = json.loads(self.sql(
            "SELECT coalesce(json_agg(m ORDER BY installed_rank), '[]') FROM "
            "(SELECT installed_rank,version,type,script,checksum,success "
            "FROM public.flyway_schema_history) m;"))
        if not migrations or not all(m["success"] for m in migrations):
            raise RuntimeError("Flyway migration history is missing or contains a failure")
        schema = json.loads(self.sql("""
            SELECT json_build_object(
              'columns', (SELECT json_agg(c ORDER BY table_name,ordinal_position)
                FROM (SELECT table_name,column_name,ordinal_position,udt_name,
                  character_maximum_length,is_nullable,column_default
                  FROM information_schema.columns WHERE table_schema='public'
                    AND table_name <> 'flyway_schema_history') c),
              'constraints', (SELECT json_agg(c ORDER BY table_name,name)
                FROM (SELECT t.relname AS table_name,co.conname AS name,
                  pg_get_constraintdef(co.oid) AS definition FROM pg_constraint co
                  JOIN pg_class t ON t.oid=co.conrelid
                  WHERE t.relnamespace='public'::regnamespace
                    AND t.relname <> 'flyway_schema_history') c),
              'indexes', (SELECT json_agg(i ORDER BY tablename,indexname)
                FROM (SELECT tablename,indexname,indexdef FROM pg_indexes
                  WHERE schemaname='public' AND tablename <> 'flyway_schema_history') i)
            );
        """))
        counts = ",".join(quote_literal(table) + ", (SELECT count(*) FROM public." + quote_identifier(table) + ")"
                           for table in tables)
        files = json.loads(self.sql("SELECT coalesce(json_agg(f ORDER BY bucket,object_key), '[]') FROM "
                                    "(SELECT bucket,object_key,file_sha256,size_bytes FROM public.files) f;"))
        return {
            "database": self.sql("SELECT current_database();"),
            "postgres_major": int(self.sql("SHOW server_version_num;")) // 10000,
            "migrations": migrations,
            "schema_sha256": hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest(),
            "tables": json.loads(self.sql("SELECT json_build_object(" + counts + ");")),
            "files": files,
        }

    def dump(self, path):
        with Path(path).open("xb") as output:
            self.run("exec", "-T", "postgres", "sh", "-ec",
                     'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                     '--format=custom --data-only --schema=public '
                     '--exclude-table=public.flyway_schema_history --no-owner --no-privileges', stdout=output)

    def restore_dump(self, path):
        with Path(path).open("rb") as source:
            self.run("exec", "-T", "postgres", "sh", "-ec",
                     'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
                     '--data-only --no-owner --no-privileges --exit-on-error --single-transaction', stdin=source)

    def s3(self, action, archive, state=None, readonly=True):
        mounts = ["--volume", f"{ROOT / 'scripts/s3_snapshot.mjs'}:/snapshot/tool.mjs:ro",
                  "--volume", f"{Path(archive).resolve()}:/snapshot/archive" + (":ro" if readonly else "")]
        if state:
            mounts += ["--volume", f"{Path(state).resolve()}:/snapshot/state"]
        # Reuse the backend image's S3 SDK and environment, without starting its API.
        result = self.run("run", "--rm", "--no-deps", "-T", "--user", "0:0", "--entrypoint", "node",
                          *mounts, "backend", "/snapshot/tool.mjs", action)
        return json.loads(result.stdout)

    @contextmanager
    def paused(self, resume_on_error=True):
        running = set(self.run("ps", "--status", "running", "--services").stdout.decode().splitlines())
        services = [name for name in WRITERS if name in running]
        resume = True
        paused = False
        try:
            if services:
                print("Pausing application writers; allowing active work to finish...", flush=True)
                self.run("stop", "--timeout", "930", *services)
            paused = True
            yield
        except BaseException:
            resume = resume_on_error or not paused
            raise
        finally:
            if services and resume:
                self.run("start", *services)
                print("Previously running application services restarted.", flush=True)
            elif services:
                print("Restore did not finish verification; application services remain stopped.", flush=True)


def add_project_arguments(parser):
    parser.add_argument("--compose-file", "-f", action="append", default=[], help="Compose file; repeat for overrides")
    parser.add_argument("--project", help="Compose project name (defaults to current configuration)")


def validate_references(metadata, s3):
    objects = {obj["key"]: obj for obj in s3["objects"]}
    if len(objects) != len(s3["objects"]):
        raise ValueError("Duplicate object keys in S3 inventory")
    for file in metadata["files"]:
        if file["bucket"] != s3["bucket"] or file["object_key"] not in objects:
            raise ValueError("A database file refers to an object absent from the S3 snapshot")
        obj = objects[file["object_key"]]
        if file["file_sha256"] and file["file_sha256"] != obj["sha256"]:
            raise ValueError("A database file hash differs from the S3 object's bytes")
        if file["size_bytes"] is not None and file["size_bytes"] != obj["size"]:
            raise ValueError("A database file size differs from the S3 object's bytes")


def validate_archive(directory):
    root = Path(directory).resolve(strict=True)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format_version") != 1:
        raise ValueError("Unsupported or incomplete backup format")
    s3_path = root / "s3.json"
    if sha256(s3_path) != manifest["s3_manifest_sha256"]:
        raise ValueError("S3 manifest checksum mismatch")
    s3 = json.loads(s3_path.read_text(encoding="utf-8"))
    for item in [manifest["dump"], *s3["objects"]]:
        relative = item["file"]
        expected = "database.dump" if item is manifest["dump"] else "objects/" + hashlib.sha256(item["key"].encode()).hexdigest() + ".bin"
        if relative != expected:
            raise ValueError("Unexpected backup file path")
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root) or path.stat().st_size != item["size"] or sha256(path) != item["sha256"]:
            raise ValueError("Backup file checksum, size or path mismatch")
    with (root / "database.dump").open("rb") as source:
        if source.read(5) != b"PGDMP":
            raise ValueError("Invalid PostgreSQL custom dump")
    validate_references(manifest["source"], s3)
    return manifest, s3


def validate_target(project, manifest, s3):
    target = project.metadata()
    source = manifest["source"]
    if target["postgres_major"] != source["postgres_major"]:
        raise ValueError("PostgreSQL major version differs from the backup")
    if target["schema_sha256"] != source["schema_sha256"] or target["migrations"] != source["migrations"]:
        raise ValueError("Schema/migrations differ; initialize using the backup's version of the project")
    if any(target["tables"].values()):
        raise ValueError("Target application database is not empty; restore refuses to replace existing data")
    inventory = project.s3("inventory", ROOT / "scripts")
    if inventory["bucket"] != s3["bucket"]:
        raise ValueError("S3_BUCKET must match the bucket name stored in the backup")
    if inventory["objects"]:
        raise ValueError("Target S3 bucket is not empty; restore refuses to overwrite existing objects")

