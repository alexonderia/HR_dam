"""Restore a real snapshot into disposable storage; never replace the live DB/S3."""
import argparse
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from backup_common import Project, sha256, validate_archive, validate_target, write_json
from restore import restore_backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot")
    args = parser.parse_args()
    source = Path(args.snapshot).resolve()
    manifest, s3 = validate_archive(source)
    os.environ["BACKUP_TEST_BUCKET"] = s3["bucket"]
    name = "hr-dam-backup-test-" + uuid.uuid4().hex[:8]
    assert re.fullmatch(r"hr-dam-backup-test-[a-f0-9]{8}", name)
    target = Project([ROOT / "tests/compose.backup.yml"], name)
    assert target.config["name"] == name
    print("Disposable test project:", name, flush=True)
    try:
        target.run("up", "-d", "--wait", "--wait-timeout", "120", "postgres", "seaweedfs")
        target.run("run", "--rm", "--no-deps", "flyway")
        target.run("run", "--rm", "--no-deps", "s3-init")
        validate_target(target, manifest, s3)
        print("PASS: initialized empty target accepts matching migration history", flush=True)
        with tempfile.TemporaryDirectory(prefix="backup-failure-test-", dir=ROOT / ".qa") as temporary:
            assert Path(temporary).resolve().is_relative_to((ROOT / ".qa").resolve())
            broken = Path(temporary) / "snapshot"
            shutil.copytree(source, broken)
            # A changed object must be rejected before any remote writes.
            if s3["objects"]:
                obj = broken / s3["objects"][0]["file"]
                with obj.open("ab") as output:
                    output.write(b"corruption-test")
                try:
                    validate_archive(broken)
                except ValueError:
                    pass
                else:
                    raise AssertionError("Modified object accepted")
                shutil.copyfile(source / s3["objects"][0]["file"], obj)
            # A dump failure after S3 upload must roll back imported objects and SQL.
            dump = broken / "database.dump"
            data = dump.read_bytes()
            dump.write_bytes(data[:max(5, len(data) // 2)])
            changed = {**manifest, "dump": {"file": "database.dump", "size": dump.stat().st_size, "sha256": sha256(dump)}}
            write_json(broken / "manifest.json", changed)
            try:
                restore_backup(target, broken)
            except RuntimeError:
                pass
            else:
                raise AssertionError("Truncated dump restored successfully")
            assert not any(target.metadata()["tables"].values()), "SQL failure left application rows"
            assert not target.s3("inventory", ROOT / "scripts")["objects"], "SQL failure left imported S3 objects"
        print("PASS: checksum corruption rejected; failed SQL restore rolls back S3 and transaction", flush=True)
        restore_backup(target, source)
        after = target.metadata()
        assert after["tables"] == manifest["source"]["tables"]
        assert after["files"] == manifest["source"]["files"]
        assert after["migrations"] == manifest["source"]["migrations"]
        try:
            restore_backup(target, source)
        except ValueError:
            pass
        else:
            raise AssertionError("Restore overwrote a populated target")
        assert target.metadata()["tables"] == after["tables"]
        target.s3("verify", source)
        print("PASS: all rows, UUID/file links, object bytes/metadata and migration history restored; populated target protected", flush=True)
    finally:
        # Only the unique project created above is removed, including its disposable volumes.
        target.run("down", "--volumes", "--remove-orphans")
        print("Disposable test storage removed.", flush=True)


if __name__ == "__main__":
    (ROOT / ".qa").mkdir(exist_ok=True)
    main()
