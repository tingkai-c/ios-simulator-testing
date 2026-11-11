#!/usr/bin/env python3
"""Transfer one simulator app's Documents/Library while its simulator is stopped."""

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile

ROOTS = ("Documents", "Library")
MAX_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 10000
BUNDLE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,254}\Z")
UDID = re.compile(r"[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\Z")


def check_bundle(bundle):
    if not BUNDLE.fullmatch(bundle):
        raise ValueError("Invalid bundle identifier")


def inspect_archive(archive, bundle):
    """Validate every member before creating anything in the destination."""
    check_bundle(bundle)
    members = archive.infolist()
    if len(members) > MAX_ENTRIES:
        raise ValueError("Too many archive entries")
    seen = set()
    total = 0
    for member in members:
        name = member.filename
        parts = PurePosixPath(name).parts
        normalized = str(PurePosixPath(name))
        if (not parts or name.startswith("/") or "\\" in name
                or any(part in (".", "..") for part in name.rstrip("/").split("/"))
                or normalized != name.rstrip("/")
                or parts[0] not in (*ROOTS, "manifest.json")
                or (parts[0] == "manifest.json" and len(parts) != 1)):
            raise ValueError("Unsafe archive path")
        key = normalized.casefold()
        if key in seen:
            raise ValueError("Duplicate archive path")
        seen.add(key)
        mode = member.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (member.flag_bits & 1):
            raise ValueError("Links, special files, and encrypted entries are unsupported")
        if (kind == stat.S_IFDIR) != member.is_dir() and kind != 0:
            raise ValueError("Inconsistent archive entry")
        total += member.file_size
        if total > MAX_BYTES:
            raise ValueError("Expanded archive exceeds limit")
    manifest_info = archive.getinfo("manifest.json")
    if manifest_info.file_size > 32768:
        raise ValueError("Manifest exceeds limit")
    manifest = json.loads(archive.read(manifest_info))
    if manifest != {"schemaVersion": 1, "bundleId": bundle}:
        raise ValueError("Fixture does not match target application")
    return members


def _check_root(container, name):
    root = container / name
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise ValueError("Application data root must be a directory")
    return root


def export_container(container, destination, bundle):
    check_bundle(bundle)
    container = Path(container).resolve(strict=True)
    destination = Path(destination)
    count, total = 1, 0
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps({"schemaVersion": 1, "bundleId": bundle}))
        for name in ROOTS:
            root = _check_root(container, name)
            archive.writestr(name + "/", b"")
            count += 1
            if not root.exists():
                continue
            for current, directories, files in os.walk(root, followlinks=False):
                for entry in sorted(directories + files):
                    path = Path(current) / entry
                    info = path.lstat()
                    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                        raise ValueError("App data contains a link or special file")
                    count += 1
                    total += info.st_size if path.is_file() else 0
                    if count > MAX_ENTRIES or total > MAX_BYTES:
                        raise ValueError("Application data exceeds fixture limits")
                    archive.write(path, str(path.relative_to(container)))
    if destination.stat().st_size > MAX_BYTES:
        destination.unlink()
        raise ValueError("Compressed fixture exceeds limit")


def import_container(container, source, bundle):
    container = Path(container).resolve(strict=True)
    if Path(source).stat().st_size > MAX_BYTES:
        raise ValueError("Compressed fixture exceeds limit")
    with zipfile.ZipFile(source) as archive:
        members = inspect_archive(archive, bundle)
        for name in ROOTS:
            _check_root(container, name)
        # Staging and backup stay on the container filesystem so renames are atomic.
        with tempfile.TemporaryDirectory(prefix=".simulator-fixture-", dir=container) as temporary:
            temporary = Path(temporary)
            stage, backup = temporary / "stage", temporary / "backup"
            stage.mkdir(mode=0o700)
            backup.mkdir(mode=0o700)
            for name in ROOTS:
                (stage / name).mkdir(mode=0o700)
            for member in members:
                if member.filename == "manifest.json":
                    continue
                target = stage / member.filename
                if member.is_dir():
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with archive.open(member) as incoming, target.open("xb") as outgoing:
                        shutil.copyfileobj(incoming, outgoing)
                    target.chmod(0o600)
            moved, installed = [], []
            try:
                for name in ROOTS:
                    current = container / name
                    if current.exists():
                        os.replace(current, backup / name)
                        moved.append(name)
                    os.replace(stage / name, current)
                    installed.append(name)
            except BaseException:
                for name in reversed(installed):
                    shutil.rmtree(container / name)
                for name in reversed(moved):
                    os.replace(backup / name, container / name)
                raise


def simctl(*args, timeout=180):
    return subprocess.run(["xcrun", "simctl", *args], check=True, capture_output=True,
                          text=True, timeout=timeout).stdout.strip()


def transfer(operation, udid, bundle, file):
    if not UDID.fullmatch(udid):
        raise ValueError("Invalid simulator identifier")
    check_bundle(bundle)
    container = Path(simctl("get_app_container", udid, bundle, "data"))
    if not container.is_absolute() or container.is_symlink() or not container.is_dir():
        raise ValueError("Invalid simulator application data container")
    # A stopped simulator also stops extensions and flushes SQLite/WAL writers.
    simctl("shutdown", udid)
    try:
        if operation == "export":
            export_container(container, file, bundle)
        else:
            import_container(container, file, bundle)
    finally:
        simctl("boot", udid)
        simctl("bootstatus", udid, "-b", timeout=240)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("import", "export"))
    parser.add_argument("--udid", required=True)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--file", required=True)
    args = parser.parse_args()
    transfer(args.operation, args.udid, args.bundle, args.file)


if __name__ == "__main__":
    main()
