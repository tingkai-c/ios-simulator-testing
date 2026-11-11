import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("fixture_state", Path(__file__).parents[1] / "host/state.py")
state = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(state)
BUNDLE = "com.example.fixture"
UDID = "12345678-1234-1234-1234-123456789abc"


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.container = self.directory / "container"
        self.container.mkdir()
        for root in state.ROOTS:
            (self.container / root).mkdir()
        (self.container / "Documents/original.txt").write_text("original documents")
        (self.container / "Library/original.txt").write_text("original library")
        (self.container / ".container-metadata").write_text("keep")
        self.archive = self.directory / "fixture.zip"

    def tearDown(self):
        self.temporary.cleanup()

    def make_archive(self, entries=(), bundle=BUNDLE):
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"schemaVersion": 1, "bundleId": bundle}))
            for name, value in entries:
                archive.writestr(name, value)
        return self.archive

    def assert_original(self):
        self.assertEqual((self.container / "Documents/original.txt").read_text(), "original documents")
        self.assertEqual((self.container / "Library/original.txt").read_text(), "original library")
        self.assertEqual((self.container / ".container-metadata").read_text(), "keep")

    def test_round_trip_preserves_database_sidecars_and_empty_directories(self):
        (self.container / "Library/database.sqlite").write_bytes(b"database")
        (self.container / "Library/database.sqlite-wal").write_bytes(b"wal")
        (self.container / "Library/database.sqlite-shm").write_bytes(b"shm")
        (self.container / "Documents/empty").mkdir()
        state.export_container(self.container, self.archive, BUNDLE)
        (self.container / "Documents/original.txt").write_text("changed")
        (self.container / "Library/extra.txt").write_text("extra")
        state.import_container(self.container, self.archive, BUNDLE)
        self.assert_original()
        self.assertEqual((self.container / "Library/database.sqlite-wal").read_bytes(), b"wal")
        self.assertEqual((self.container / "Library/database.sqlite-shm").read_bytes(), b"shm")
        self.assertTrue((self.container / "Documents/empty").is_dir())
        self.assertFalse((self.container / "Library/extra.txt").exists())

    def test_foreign_bundle_is_rejected_without_modifying_data(self):
        self.make_archive([("Documents/new.txt", "new")], bundle="com.example.other")
        with self.assertRaises(ValueError):
            state.import_container(self.container, self.archive, BUNDLE)
        self.assert_original()

    def test_unsafe_member_paths_are_rejected(self):
        paths = ["../outside.txt", "/Documents/file", "Documents/../outside", "Documents\\file",
                 "Documents//file", "Documents/./file", "tmp/cache", "manifest.json/extra"]
        for name in paths:
            with self.subTest(name=name):
                self.make_archive([(name, "bad")])
                with self.assertRaises(ValueError):
                    state.import_container(self.container, self.archive, BUNDLE)
                self.assert_original()

    def test_links_and_special_files_are_rejected(self):
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600, stat.S_IFSOCK | 0o600):
            with self.subTest(mode=mode):
                self.make_archive()
                with zipfile.ZipFile(self.archive, "a") as archive:
                    info = zipfile.ZipInfo("Documents/link")
                    info.create_system = 3
                    info.external_attr = mode << 16
                    archive.writestr(info, "../../outside")
                with self.assertRaises(ValueError):
                    state.import_container(self.container, self.archive, BUNDLE)
                self.assert_original()

    def test_case_collisions_and_file_ancestor_collisions_leave_data_unchanged(self):
        cases = [[("Documents/File", "one"), ("Documents/file", "two")],
                 [("Documents/file", "one"), ("Documents/file/child", "two")]]
        for entries in cases:
            self.make_archive(entries)
            with self.assertRaises((ValueError, FileExistsError)):
                state.import_container(self.container, self.archive, BUNDLE)
            self.assert_original()

    def test_size_and_entry_limits_apply_before_changes(self):
        self.make_archive([("Documents/oversize", "x" * 200)])
        with patch.object(state, "MAX_BYTES", 100):
            with self.assertRaises(ValueError):
                state.import_container(self.container, self.archive, BUNDLE)
        self.assert_original()
        self.make_archive([("Documents/one", "1"), ("Documents/two", "2")])
        with patch.object(state, "MAX_ENTRIES", 2):
            with self.assertRaises(ValueError):
                state.import_container(self.container, self.archive, BUNDLE)
        self.assert_original()

    def test_existing_data_root_symlink_is_rejected(self):
        outside = self.directory / "outside"
        outside.mkdir()
        (outside / "keep").write_text("safe")
        (self.container / "Documents/original.txt").unlink()
        (self.container / "Documents").rmdir()
        (self.container / "Documents").symlink_to(outside, target_is_directory=True)
        self.make_archive([("Documents/new", "new")])
        with self.assertRaises(ValueError):
            state.import_container(self.container, self.archive, BUNDLE)
        self.assertEqual((outside / "keep").read_text(), "safe")
        self.assertFalse((outside / "new").exists())

    def test_export_rejects_nested_symlink(self):
        (self.container / "Library/escape").symlink_to(self.directory)
        with self.assertRaises(ValueError):
            state.export_container(self.container, self.archive, BUNDLE)

    def test_partial_replace_failure_rolls_both_roots_back(self):
        self.make_archive([("Documents/new", "new"), ("Library/new", "new")])
        replace = state.os.replace

        def fail_second_root(source, destination):
            if Path(source).parent.name == "stage" and Path(source).name == "Library":
                raise OSError("simulated replacement failure")
            return replace(source, destination)

        with patch.object(state.os, "replace", side_effect=fail_second_root):
            with self.assertRaises(OSError):
                state.import_container(self.container, self.archive, BUNDLE)
        self.assert_original()
        self.assertFalse(list(self.container.glob(".simulator-fixture-*")))

    def test_simulator_reboots_even_when_transfer_fails(self):
        calls = []

        def simctl(*args, **kwargs):
            calls.append(args)
            return str(self.container) if args[0] == "get_app_container" else ""

        self.make_archive(bundle="com.example.other")
        with patch.object(state, "simctl", side_effect=simctl):
            with self.assertRaises(ValueError):
                state.transfer("import", UDID, BUNDLE, self.archive)
        self.assertEqual([call[0] for call in calls], ["get_app_container", "shutdown", "boot", "bootstatus"])
        self.assert_original()


if __name__ == "__main__":
    unittest.main()
