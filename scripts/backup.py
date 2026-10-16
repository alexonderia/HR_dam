"""Create a consistent data-only PostgreSQL + S3 snapshot."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import uuid

from backup_common import ROOT, Project, add_project_arguments, sha256, validate_archive, validate_references, write_json

MOSCOW_TIME_ZONE = timezone(timedelta(hours=3))


def create_backup(project, directory):
    directory = Path(directory).resolve()
    if directory.is_relative_to(ROOT / "apps") or "," in str(directory):
        raise ValueError("Choose a backup directory outside apps/ and without commas")
    directory.mkdir(parents=True, exist_ok=False)
    with project.paused():
        source = project.metadata()
        project.dump(directory / "database.dump")
        s3 = project.s3("backup", directory, readonly=False)
        validate_references(source, s3)
        if project.metadata() != source:
            raise RuntimeError("Database changed during backup; snapshot was not finalized")
        dump = directory / "database.dump"
        write_json(directory / "manifest.json", {
            "format_version": 1,
            "created_at": datetime.now(MOSCOW_TIME_ZONE).isoformat(),
            "source": source,
            "dump": {"file": "database.dump", "size": dump.stat().st_size, "sha256": sha256(dump)},
            "s3_manifest_sha256": sha256(directory / "s3.json"),
        })
        try:
            validate_archive(directory)
        except BaseException:
            (directory / "manifest.json").rename(directory / "manifest.incomplete.json")
            raise
    print(f"Backup complete: {directory}", flush=True)
    print(f"Tables: {len(source['tables'])}; rows: {sum(source['tables'].values())}; S3 objects: {len(s3['objects'])}")
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", help="New snapshot directory (must not already exist)")
    add_project_arguments(parser)
    args = parser.parse_args()
    destination = args.destination or ROOT / "backups" / (datetime.now(MOSCOW_TIME_ZONE).strftime("%Y%m%d_%H%M%S_МСК") + "-" + uuid.uuid4().hex[:8])
    create_backup(Project(args.compose_file, args.project), destination)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError) as error:
        print(f"Backup failed: {error}", file=sys.stderr)
        sys.exit(1)
