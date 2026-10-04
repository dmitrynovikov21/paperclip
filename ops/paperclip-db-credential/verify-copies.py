#!/usr/bin/env python3
"""Check named carriers and all regular worktree files without printing secrets."""

import argparse
import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import unquote_to_bytes


URL_PREFIXES = (b"postgres://", b"postgresql://")
URL_WHITESPACE = b" \t\n\r\f\v"
PASSWORD_QUERY_KEY = b"password"
MAX_QUERY_KEY_BYTES = len(PASSWORD_QUERY_KEY) * 3  # Percent-encoded bytes.


def candidates(carriers: list[Path], worktree_roots: list[Path]):
    for carrier in carriers:
        yield carrier, True
    for root in worktree_roots:
        if root.is_symlink() or not root.is_dir():
            yield root, False
            continue
        walk_errors = []
        for directory, dirs, files in os.walk(
            root, followlinks=False, onerror=walk_errors.append
        ):
            # os.walk leaves symlinked directories in dirs without visiting them.
            # Report every one so an agent-readable copy cannot hide behind it.
            for name in dirs:
                if (Path(directory) / name).is_symlink():
                    yield Path(directory) / name, False
            for name in files:
                yield Path(directory) / name, False
        for error in walk_errors:
            yield Path(error.filename), False


def scan_credentials(path: Path, old_url: bytes) -> tuple[bool, bool]:
    """Find the old URL and any inline PostgreSQL URL with bounded memory.

    Prefix and credential state continue across read boundaries, including for
    URLs with a username or password longer than a read chunk.
    """
    overlap = b""
    has_old_url = False
    has_inline_url = False
    prefix_lengths = [0, 0]
    credential_part = 0  # 0: none, 1: username, 2: password
    part_has_bytes = False
    query_part = 0  # 0: no URL, 1: before ?, 2: parameter name, 3: value
    query_key = bytearray()
    query_key_overlong = False
    nested_url_query = False
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            data = overlap + chunk
            has_old_url |= old_url in data
            overlap = data[-(len(old_url) - 1) :] if len(old_url) > 1 else b""
            if has_inline_url:
                continue
            for raw_byte in chunk:
                byte = raw_byte + 32 if 65 <= raw_byte <= 90 else raw_byte
                found_prefix = False
                for index, prefix in enumerate(URL_PREFIXES):
                    length = prefix_lengths[index]
                    if byte == prefix[length]:
                        length += 1
                        if length == len(prefix):
                            found_prefix = True
                            length = 0
                    else:
                        length = 1 if byte == ord("p") else 0
                    prefix_lengths[index] = length
                if found_prefix and query_part == 0:
                    query_part = 1
                elif found_prefix:
                    nested_url_query = True
                if byte in URL_WHITESPACE or byte in b"'\"<>`#":
                    query_part = 0
                    query_key.clear()
                    nested_url_query = False
                # A second URL can immediately follow a query value. A bare ?
                # inside a value is not a new PostgreSQL parameter, however.
                elif byte == ord("?") and (query_part == 1 or nested_url_query):
                    query_part = 2
                    query_key.clear()
                    query_key_overlong = False
                    nested_url_query = False
                elif query_part == 2:
                    if byte == ord("&"):
                        query_key.clear()
                        query_key_overlong = False
                        nested_url_query = False
                    elif byte == ord("="):
                        if (
                            not query_key_overlong
                            and unquote_to_bytes(bytes(query_key)) == PASSWORD_QUERY_KEY
                        ):
                            has_inline_url = True
                            break
                        query_part = 3
                    elif len(query_key) < MAX_QUERY_KEY_BYTES:
                        query_key.append(byte)
                    else:
                        query_key_overlong = True
                elif query_part == 3 and byte == ord("&"):
                    query_part = 2
                    query_key.clear()
                    query_key_overlong = False
                    nested_url_query = False
                # A second prefix may itself be part of a password.
                if found_prefix and credential_part == 0:
                    credential_part = 1
                    part_has_bytes = False
                    continue
                if credential_part == 1:
                    if byte == ord(":"):
                        credential_part = 2 if part_has_bytes else 0
                        part_has_bytes = False
                    elif byte in b"/@?#":
                        credential_part = 0
                    elif byte in URL_WHITESPACE or byte in b"'\"":
                        credential_part = 0
                    else:
                        part_has_bytes = True
                elif credential_part == 2:
                    if byte == ord("@"):
                        if part_has_bytes:
                            has_inline_url = True
                            break
                        credential_part = 0
                    elif byte in URL_WHITESPACE or byte in b"'\"":
                        credential_part = 0
                    else:
                        part_has_bytes = True
    return has_old_url, has_inline_url


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-url-file", required=True, type=Path)
    parser.add_argument("--carrier", action="append", default=[], type=Path)
    parser.add_argument("--worktree-root", action="append", default=[], type=Path)
    args = parser.parse_args()
    old_url = args.old_url_file.read_bytes().strip()
    if not old_url:
        parser.error("old URL source is empty")
    paths = list(dict.fromkeys(candidates(args.carrier, args.worktree_root)))
    if not paths:
        parser.error("at least one carrier or worktree root is required")

    failures = 0
    checked = 0
    for root in args.worktree_root:
        if root.is_symlink() or not root.is_dir():
            print(f"INVALID_WORKTREE_ROOT {root}")
            failures += 1
    for path, _is_carrier in paths:
        if path in args.worktree_root:
            continue
        try:
            info = path.lstat()
        except FileNotFoundError:
            print(f"MISSING {path}")
            failures += 1
            continue
        if stat.S_ISLNK(info.st_mode):
            print(f"SYMLINK {path}")
            failures += 1
            continue
        if not stat.S_ISREG(info.st_mode):
            print(f"NONFILE {path}")
            failures += 1
            continue
        try:
            has_old_url, has_inline_url = scan_credentials(path, old_url)
            is_instance_config = (
                path.name == "config.json" and path.parent.name == ".paperclip"
            )
            data = (
                path.read_bytes() if is_instance_config or path.name == ".env" else b""
            )
        except OSError:
            print(f"UNREADABLE {path}")
            failures += 1
            continue
        checked += 1
        reasons = []
        if has_old_url:
            reasons.append("old-url-copy")
        if has_inline_url:
            reasons.append("inline-db-credential")
        if is_instance_config:
            try:
                config = json.loads(data)
                if config.get("database", {}).get("connectionString"):
                    reasons.append("config-connection-string")
            except (ValueError, TypeError, AttributeError):
                reasons.append("invalid-config-json")
        if path.name == ".env" and re.search(
            rb"^\s*DATABASE_(?:MIGRATION_)?URL\s*=", data, re.M
        ):
            reasons.append("env-db-url")
        if reasons:
            print(
                f"FAIL {path} mode={stat.S_IMODE(info.st_mode):04o} uid={info.st_uid} reasons={','.join(reasons)}"
            )
            failures += 1
    print(f"Copy scan: checked={checked} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
