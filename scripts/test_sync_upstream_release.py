import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import sync_upstream_release as sync


class ReleaseTests(unittest.TestCase):
    def test_select_release_rejects_prerelease_and_unsafe_tags(self):
        for change in ({"prerelease": True}, {"draft": True}, {"tag_name": "v1/../../x"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                sync.validate_release({"tag_name": "v1.2.3", "draft": False, "prerelease": False, **change})
        sync.validate_release({"tag_name": "v1.2.3", "draft": False, "prerelease": False})

    def test_asset_change_invalidates_completion_marker(self):
        release = {"id": 1, "tag_name": "v1.2.3", "assets": [{"id": 2, "name": "a", "size": 3, "updated_at": "a"}]}
        before = sync.completion_marker(release)
        release["assets"][0]["updated_at"] = "b"
        self.assertNotEqual(before, sync.completion_marker(release))

    def test_verify_checksums_rejects_corruption_and_missing_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "denova-v1-linux-x64.tar.gz"
            archive.write_bytes(b"release")
            digest = hashlib.sha256(b"release").hexdigest()
            (root / "checksums.txt").write_text(f"{digest}  {archive.name}\n")
            sync.verify_assets(root)
            archive.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "Checksum mismatch"):
                sync.verify_assets(root)
            (root / "checksums.txt").write_text("")
            with self.assertRaisesRegex(ValueError, "Missing checksum"):
                sync.verify_assets(root)

    def test_extract_preserves_bundle_and_rejects_unsafe_members(self):
        for member_name, member_type in [("denova/web/index.html", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE), ("denova/link", tarfile.SYMTYPE)]:
            with self.subTest(member=member_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "bundle.tar.gz"
                with tarfile.open(archive, "w:gz") as bundle:
                    member = tarfile.TarInfo(member_name)
                    member.type = member_type
                    member.size = 2 if member_type == tarfile.REGTYPE else 0
                    member.linkname = "../../escape" if member_type == tarfile.SYMTYPE else ""
                    bundle.addfile(member, io.BytesIO(b"ok") if member.size else None)
                if member_name == "denova/web/index.html":
                    sync.extract_bundle(archive, root / "out")
                    self.assertEqual((root / "out/denova/web/index.html").read_bytes(), b"ok")
                else:
                    with self.assertRaises(ValueError):
                        sync.extract_bundle(archive, root / "out")

    def test_only_not_found_is_treated_as_missing_release(self):
        import subprocess
        for error, expected in [("gh: Not Found (HTTP 404)", None), ("gh: Bad credentials (HTTP 401)", "error")]:
            with patch.object(sync, "run", side_effect=[subprocess.CalledProcessError(1, "gh", stderr=error), "[]"]):
                if expected is None:
                    self.assertIsNone(sync.find_release("owner/repo", "v1.2.3"))
                else:
                    with self.assertRaises(subprocess.CalledProcessError):
                        sync.find_release("owner/repo", "v1.2.3")

    def test_draft_release_is_found_after_tag_endpoint_returns_not_found(self):
        import subprocess
        draft = {"tag_name": "upstream-v1.2.3", "draft": True}
        with patch.object(sync, "run", side_effect=[subprocess.CalledProcessError(1, "gh", stderr="gh: Not Found (HTTP 404)"), json.dumps([[draft]])]):
            self.assertEqual(sync.find_release("owner/repo", "upstream-v1.2.3"), draft)

    def test_force_invalidates_completion_before_download_failure(self):
        release = {"id": 1, "tag_name": "v1.2.3", "assets": []}
        mirror = {"draft": False, "body": sync.ORIGIN_MARKER + sync.completion_marker(release)}
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "api", return_value=release), patch.object(sync, "find_release", return_value=mirror), patch.object(sync, "run", side_effect=["", RuntimeError("download failed")]) as command:
            args = SimpleNamespace(tag="", repository="owner/repo", directory=Path(directory), force=True)
            with self.assertRaisesRegex(RuntimeError, "download failed"):
                sync.prepare(args)
            self.assertEqual(command.call_args_list[0].args[:4], ("gh", "release", "edit", "upstream-v1.2.3"))
            notes = (args.directory / "retry-notes.md").read_text()
            self.assertIn(sync.ORIGIN_MARKER, notes)
            self.assertNotIn(sync.completion_marker(release), notes)

    def test_completed_release_skips_but_draft_and_force_retry(self):
        release = {"id": 1, "tag_name": "v1.2.3", "assets": []}
        mirror = {"draft": False, "body": sync.completion_marker(release)}
        self.assertTrue(sync.is_complete(release, mirror, False))
        self.assertFalse(sync.is_complete(release, mirror, True))
        self.assertFalse(sync.is_complete(release, {**mirror, "draft": True}, False))
        self.assertFalse(sync.is_complete(release, None, False))

    def test_completed_prepare_does_not_download_or_create_files(self):
        release = {"id": 1, "tag_name": "v1.2.3", "assets": []}
        mirror = {"draft": False, "body": sync.ORIGIN_MARKER + sync.completion_marker(release)}
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "api", return_value=release), patch.object(sync, "find_release", return_value=mirror), patch.object(sync, "run") as command, patch.dict("os.environ", {}, clear=True):
            target = Path(directory) / "output"
            sync.prepare(SimpleNamespace(tag="", repository="owner/repo", directory=target, force=False))
            command.assert_not_called()
            self.assertFalse(target.exists())

    def test_finish_publishes_only_after_upload_and_never_promotes_old_tag(self):
        for latest_id, upload_fails in [(1, False), (2, False), (1, True)]:
            with self.subTest(latest_id=latest_id, upload_fails=upload_fails), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                release = {"id": 1, "tag_name": "v1.2.3", "assets": []}
                (root / "release.json").write_text(json.dumps(release))
                (root / "assets").mkdir()
                (root / "assets/checksums.txt").write_text("checksums")
                calls = []

                def command(*args):
                    calls.append(args)
                    if upload_fails and args[:3] == ("gh", "release", "upload"):
                        raise RuntimeError("upload failed")
                    return ""

                with patch.object(sync, "find_release", side_effect=[release, None]), patch.object(sync, "api", return_value={"id": latest_id}), patch.object(sync, "run", side_effect=command):
                    args = SimpleNamespace(directory=root, repository="owner/repo")
                    if upload_fails:
                        with self.assertRaisesRegex(RuntimeError, "upload failed"):
                            sync.finish(args)
                        self.assertFalse(any(call[0] == "docker" or call[:3] == ("gh", "release", "edit") for call in calls))
                        self.assertNotIn(sync.completion_marker(release), (root / "mirror-notes.md").read_text())
                    else:
                        sync.finish(args)
                        self.assertEqual(calls[-1][:3], ("gh", "release", "edit"))
                        self.assertIn(f"--latest={str(latest_id == 1).lower()}", calls[-1])
                        self.assertEqual(any(call[0] == "docker" for call in calls), latest_id == 1)
                        self.assertIn(sync.completion_marker(release), (root / "mirror-notes.md").read_text())


if __name__ == "__main__":
    unittest.main()
