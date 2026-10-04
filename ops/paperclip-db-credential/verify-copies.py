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
MAX_CARRIER_LINE_BYTES = 64 * 1024
SERVICE_FILE_NAMES = {".pg_service.conf", "pg_service.conf"}
PASSFILE_NAMES = {".pgpass", "pgpass", "pgpass.conf"}
ENV_DB_URL_KEYS = {b"DATABASE_URL", b"DATABASE_MIGRATION_URL"}
ENV_LIBPQ_KEYS = {b"PGPASSWORD", b"PGPASSFILE", b"PGSERVICEFILE", b"PGSYSCONFDIR"}
PGPASSWORD_ASSIGNMENT = re.compile(rb"^[ \t]*(?:export[ \t]+)?PGPASSWORD[ \t]*=[ \t]*(.*)")
# A connection string may begin with any libpq parameter, not just host/user.
# Keep this set aligned with libpq's documented keyword/value parameters.
LIBPQ_CONNINFO_KEYS = frozenset(
    b"""host hostaddr port dbname user password passfile require_auth
    channel_binding connect_timeout client_encoding options application_name
    fallback_application_name keepalives keepalives_idle keepalives_interval
    keepalives_count tcp_user_timeout replication gssencmode sslmode requiressl
    sslnegotiation sslcompression sslcert sslkey sslkeylogfile sslpassword
    sslcertmode sslrootcert sslcrl sslcrldir sslsni requirepeer
    ssl_min_protocol_version ssl_max_protocol_version min_protocol_version
    max_protocol_version krbsrvname gsslib gssdelegation scram_client_key
    scram_server_key service target_session_attrs load_balance_hosts
    oauth_issuer oauth_client_id oauth_client_secret oauth_scope""".split()
)
LIBPQ_CONNINFO_START = re.compile(
    rb"^[ \t]*(?:" + b"|".join(sorted(LIBPQ_CONNINFO_KEYS)) + rb")[ \t]*=",
    re.I,
)
LIBPQ_CONNINFO_KEY = re.compile(
    rb"(?:^|[ \t])(?:"
    + b"|".join(sorted(LIBPQ_CONNINFO_KEYS - {b"password"}))
    + rb")[ \t]*=",
    re.I,
)
LIBPQ_PASSWORD_KEY = re.compile(rb"(?:^|[ \t])password[ \t]*=[ \t]*\S", re.I)


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


def scan_credentials(path: Path, old_url: bytes) -> tuple[bool, bool, bool]:
    """Find old URLs, inline URLs and libpq passfile entries with bounded memory.

    Prefix and credential state continue across read boundaries, including for
    URLs with a username or password longer than a read chunk.
    """
    overlap = b""
    has_old_url = False
    has_inline_url = False
    has_passfile_entry = False
    passfile_fields = 0
    passfile_field_has_bytes = False
    passfile_line_valid = True
    passfile_escaped = False
    passfile_port_star = False
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
                # A custom PGPASSFILE can have any name. Recognize its five
                # colon-separated fields in every scanned file, including
                # explicit --carrier paths, without retaining line contents.
                if not has_passfile_entry:
                    if raw_byte in (10, 13):
                        has_passfile_entry = (
                            passfile_line_valid
                            and passfile_fields == 4
                            and passfile_field_has_bytes
                            and not passfile_escaped
                        )
                        passfile_fields = 0
                        passfile_field_has_bytes = False
                        passfile_line_valid = True
                        passfile_escaped = False
                        passfile_port_star = False
                    elif passfile_line_valid:
                        if raw_byte == 0 or (
                            raw_byte == ord("#")
                            and passfile_fields == 0
                            and not passfile_field_has_bytes
                        ):
                            passfile_line_valid = False
                        elif passfile_escaped:
                            passfile_field_has_bytes = True
                            passfile_escaped = False
                        elif raw_byte == ord("\\"):
                            if passfile_fields == 1:
                                passfile_line_valid = False
                            else:
                                passfile_escaped = True
                        elif raw_byte == ord(":"):
                            if not passfile_field_has_bytes or passfile_fields == 4:
                                passfile_line_valid = False
                            else:
                                passfile_fields += 1
                                passfile_field_has_bytes = False
                        else:
                            if passfile_fields == 1:
                                if (
                                    raw_byte == ord("*")
                                    and not passfile_field_has_bytes
                                ):
                                    passfile_port_star = True
                                elif not (
                                    48 <= raw_byte <= 57 and not passfile_port_star
                                ):
                                    passfile_line_valid = False
                            passfile_field_has_bytes = True
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
    has_passfile_entry |= (
        passfile_line_valid
        and passfile_fields == 4
        and passfile_field_has_bytes
        and not passfile_escaped
    )
    return has_old_url, has_inline_url, has_passfile_entry


def scan_libpq_carrier(path: Path) -> list[str]:
    """Reject libpq password sources that contain no PostgreSQL URL.

    A service file may have any name via PGSERVICEFILE. Shell assignments and
    keyword/value conninfo may also have arbitrary names. Read bounded lines
    in every file; suspicious oversized lines fail closed. Values are not logged.
    """
    is_env = path.name.startswith(".env")
    is_service = path.name in SERVICE_FILE_NAMES
    is_passfile = path.name in PASSFILE_NAMES
    is_named_carrier = is_env or is_service or is_passfile
    reasons = set()
    in_service_section = False
    skipping_oversized_line = False
    conninfo_has_key = False
    conninfo_has_password = False
    meaningful_lines = 0
    password_only_line = False
    with path.open("rb") as source:
        while line := source.readline(MAX_CARRIER_LINE_BYTES + 1):
            if skipping_oversized_line:
                skipping_oversized_line = not line.endswith(b"\n")
                continue
            if len(line) > MAX_CARRIER_LINE_BYTES:
                if is_named_carrier or (
                    not line.lstrip().startswith(b"#")
                    and (
                        in_service_section
                        or line.lstrip().startswith(b"[")
                        or PGPASSWORD_ASSIGNMENT.match(line)
                        or LIBPQ_CONNINFO_START.match(line)
                    )
                ):
                    reasons.add("oversized-db-carrier-line")
                if is_named_carrier:
                    break
                skipping_oversized_line = not line.endswith(b"\n")
                continue
            if not line.strip() or line.lstrip().startswith(b"#"):
                continue
            if re.fullmatch(rb"\[[^\]\r\n]+\]", line.strip()):
                in_service_section = True
            if is_env:
                assignment = re.match(
                    rb"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)[ \t]*=",
                    line,
                )
                if assignment:
                    key = assignment.group(1)
                    if key in ENV_DB_URL_KEYS:
                        reasons.add("env-db-url")
                    if key == b"PGPASSWORD":
                        reasons.add("env-libpq-password")
                    if key in ENV_LIBPQ_KEYS - {b"PGPASSWORD"}:
                        reasons.add("env-libpq-credential-reference")
            if (is_service or in_service_section) and re.match(
                rb"^[ \t]*(?:password|passfile)[ \t]*=", line, re.I
            ):
                reasons.add("libpq-service-credential")
            # Ignore computed source-code expressions such as
            # PGPASSWORD=unquote(url.password); Bash $'...' and $"..." are
            # literal strings even though they begin with a dollar sign.
            shell_assignment = PGPASSWORD_ASSIGNMENT.match(line)
            if shell_assignment:
                value = shell_assignment.group(1).strip()
                is_shell_literal = value.startswith((b"$'", b'$"'))
                if value and (
                    is_shell_literal
                    or (
                        not value.startswith((b"$", b"`"))
                        and not re.match(rb"[A-Za-z_][A-Za-z_0-9]*\(", value)
                    )
                ):
                    reasons.add("env-libpq-password")
            if not is_service and not in_service_section:
                meaningful_lines += 1
                if LIBPQ_CONNINFO_START.match(line):
                    has_key = bool(LIBPQ_CONNINFO_KEY.search(line))
                    has_password = bool(LIBPQ_PASSWORD_KEY.search(line))
                    conninfo_has_key |= has_key
                    conninfo_has_password |= has_password
                    password_only_line = has_password and not has_key
                    if conninfo_has_key and conninfo_has_password:
                        reasons.add("libpq-conninfo-password")
                else:
                    conninfo_has_key = False
                    conninfo_has_password = False
            if is_passfile:
                reasons.add("libpq-passfile-entry")
    if meaningful_lines == 1 and password_only_line:
        reasons.add("libpq-conninfo-password")
    return sorted(reasons)


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
            has_old_url, has_inline_url, has_passfile_entry = scan_credentials(
                path, old_url
            )
            is_instance_config = (
                path.name == "config.json" and path.parent.name == ".paperclip"
            )
            data = path.read_bytes() if is_instance_config else b""
            carrier_reasons = scan_libpq_carrier(path)
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
        if has_passfile_entry and "libpq-passfile-entry" not in carrier_reasons:
            reasons.append("libpq-passfile-entry")
        reasons.extend(carrier_reasons)
        if is_instance_config:
            try:
                config = json.loads(data)
                if config.get("database", {}).get("connectionString"):
                    reasons.append("config-connection-string")
            except (ValueError, TypeError, AttributeError):
                reasons.append("invalid-config-json")
        if reasons:
            print(
                f"FAIL {path} mode={stat.S_IMODE(info.st_mode):04o} uid={info.st_uid} reasons={','.join(reasons)}"
            )
            failures += 1
    print(f"Copy scan: checked={checked} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
