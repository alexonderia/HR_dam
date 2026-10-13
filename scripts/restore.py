"""Restore a snapshot into an empty, already initialized PostgreSQL + S3 stack."""
import argparse
from pathlib import Path
import sys
import tempfile

from backup_common import Project, add_project_arguments, validate_archive, validate_target


def restore_backup(project, directory):
    directory = Path(directory).resolve()
    manifest, s3 = validate_archive(directory)
    # Refuse a populated destination before stopping any running application.
    validate_target(project, manifest, s3)
    with project.paused(resume_on_error=False):
        validate_target(project, manifest, s3)
        # Objects precede database rows. The SQL restore is one transaction.
        with tempfile.TemporaryDirectory(prefix="hr-dam-restore-") as state:
            assert Path(state).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve())
            committed = False
            try:
                project.s3("restore", directory, state=state)
                project.restore_dump(directory / "database.dump")
                committed = True
                if project.metadata()["tables"] != manifest["source"]["tables"]:
                    raise RuntimeError("Post-restore database row counts differ from the snapshot")
                project.s3("verify", directory)
                # Jobs held by the old worker can safely be claimed on this installation.
                project.sql("UPDATE public.resumes SET scoring_status='pending',updated_at=now() "
                            "WHERE scoring_status='processing';")
            except BaseException:
                if not committed:
                    # A lost pg_restore connection can make commit status ambiguous.
                    # Never remove objects while database rows may refer to them.
                    try:
                        empty = not any(project.metadata()["tables"].values())
                    except (RuntimeError, ValueError):
                        empty = False
                    if empty:
                        project.s3("rollback", directory, state=state)
                    else:
                        print("Database commit status is uncertain; imported S3 objects retained.", file=sys.stderr)
                raise
    print("Restore complete: database counts and every S3 object's checksum verified.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="Snapshot directory containing manifest.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--verify-only", action="store_true", help="Check local backup integrity; no containers or writes")
    mode.add_argument("--check", action="store_true", help="Check backup and empty initialized target; no writes")
    add_project_arguments(parser)
    args = parser.parse_args()
    manifest, s3 = validate_archive(args.source)
    if args.verify_only:
        print(f"Backup verified: {len(s3['objects'])} objects and database dump.")
        return
    project = Project(args.compose_file, args.project)
    if args.check:
        validate_target(project, manifest, s3)
        print("Restore preflight passed: matching schema, empty database and S3 bucket.")
        return
    restore_backup(project, args.source)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, KeyError, TypeError) as error:
        print(f"Restore failed: {error}", file=sys.stderr)
        sys.exit(1)
