#!/usr/bin/env python3
"""Stage a smoke candidate for the pinned 2026-08 Paperclip ACPX package.

This script only writes a new package directory. It refuses an unexpected input
revision, so a later release cannot silently receive a partial textual patch.
It links untouched dependencies to the source installation for local smoke;
deploy the three changed files with backups, not this candidate directory.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path


BASE_SHA256 = {
    "dist/acpx-engine/execute.js": "c8e1c9289a115d7ed6f6a54a0a092f7a6bc3ed47c2552b000b824d608b6b86e0",
    "node_modules/acpx/dist/live-checkpoint-ClPCSdrW.js": "8a2a951fdd70d9309504a61f086a03baafbe97b608f023813b409a8445b97c0a",
    "node_modules/acpx/dist/runtime.js": "ceebed12d058689503b3efd0524574d9622543f054015e0db896e5269c1ab6e7",
}


def replace_once(text: str, before: str, after: str, label: str) -> str:
    count = text.count(before)
    if count != 1:
        raise ValueError(f"{label}: expected one anchor, found {count}")
    return text.replace(before, after, 1)


def patch_execute(text: str) -> str:
    projection = '''// A staged release may reuse an old adapter-utils package. Keep the ACPX
// process boundary closed even when the server has control-plane credentials.
const ACPX_INHERITED_HOST_ENV_KEYS = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
    "HOMEDRIVE", "HOMEPATH", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG",
    "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);
const ACPX_INHERITED_PROVIDER_ENV_KEYS = {
    codex: new Set(["OPENAI_API_KEY", "CODEX_API_KEY"]),
    claude: new Set([
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CONFIG_DIR",
    ]),
    gemini: new Set([
        "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_GENAI_USE_GCA",
    ]),
};
const ACPX_SERVER_ONLY_ENV_KEYS = new Set([
    "PAPERCLIP_AGENT_JWT_SECRET", "BETTER_AUTH_SECRET",
    "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
    "PAPERCLIP_SECRETS_PROVIDER", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT",
    "PAPERCLIP_MIGRATION_AUTO_APPLY", "PAPERCLIP_HEARTBEAT_GLOBAL_CONCURRENCY_LIMIT",
]);
export function projectAcpxInheritedHostEnvironment(inheritedEnv, acpxAgent) {
    const providerKeys = ACPX_INHERITED_PROVIDER_ENV_KEYS[acpxAgent];
    const projected = {};
    for (const [key, value] of Object.entries(inheritedEnv)) {
        if (typeof value !== "string") continue;
        const normalizedKey = key.toUpperCase();
        if (ACPX_INHERITED_HOST_ENV_KEYS.has(normalizedKey) ||
            /^LC_[A-Z0-9_]{1,32}$/.test(normalizedKey) ||
            providerKeys?.has(normalizedKey) === true) projected[key] = value;
    }
    return projected;
}
export function buildAcpxLaunchEnvironment(env, acpxAgent, inheritedEnv = process.env) {
    const merged = ensurePathInEnv({
        ...projectAcpxInheritedHostEnvironment(inheritedEnv, acpxAgent), ...env,
    });
    return Object.fromEntries(Object.entries(merged).filter(([key, value]) =>
        typeof value === "string" && !ACPX_SERVER_ONLY_ENV_KEYS.has(key.toUpperCase())));
}
'''
    text = replace_once(text, "async function buildRuntime(input) {", projection + "async function buildRuntime(input) {", "projection")
    text = replace_once(
        text,
        "normalizeGeminiAcpCommandShell(agentCommandShell, ensurePathInEnv({ ...process.env, ...env }))",
        "normalizeGeminiAcpCommandShell(agentCommandShell, buildAcpxLaunchEnvironment(env, acpxAgent))",
        "Gemini launch env",
    )
    text = replace_once(
        text,
        "const runtimeEnv = Object.fromEntries(Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter((entry) => typeof entry[1] === \"string\"));",
        "const runtimeEnv = buildAcpxLaunchEnvironment(env, acpxAgent);",
        "ACPX runtime env",
    )
    text = replace_once(text, "        env,\n        loggedEnv,", "        env,\n        launchEnv: runtimeEnv,\n        loggedEnv,", "prepared launch env")
    text = replace_once(
        text,
        "        const cached = canResume ? warmHandles.get(prepared.sessionKey) : undefined;\n        const childStderrState",
        "        const cached = canResume ? warmHandles.get(prepared.sessionKey) : undefined;\n"
        "        const terminalEnv = cached?.terminalEnv ?? Object.create(null);\n"
        "        for (const key of Object.keys(terminalEnv)) delete terminalEnv[key];\n"
        "        Object.assign(terminalEnv, prepared.launchEnv);\n"
        "        const childStderrState",
        "warm terminal env",
    )
    text = replace_once(text, "            agentRegistry: prepared.agentRegistry,\n            permissionMode:",
                        "            agentRegistry: prepared.agentRegistry,\n            terminalEnv,\n            permissionMode:", "runtime terminal env")
    if text.count("sessionOptions: { env: prepared.env }") != 2:
        raise ValueError("expected two ACPX session env sites")
    text = text.replace("sessionOptions: { env: prepared.env }", "sessionOptions: { env: prepared.launchEnv }")
    text = replace_once(text, "                        handle: sessionHandle,\n                        childStderrState,",
                        "                        handle: sessionHandle,\n                        terminalEnv,\n                        childStderrState,", "warm handle entry")
    return text


def patch_checkpoint(text: str) -> str:
    text = replace_once(text, "const env = { ...process.env };\n\tconst protectedAuthEnvKeys = promotePrefixedAuthEnvironment(env);",
                        "const env = { ...(sessionEnv ?? process.env) };\n\tconst protectedAuthEnvKeys = promotePrefixedAuthEnvironment(env);", "agent spawn env")
    text = replace_once(text, '''function toEnvObject(env) {
\tif (!env || env.length === 0) return;
\tconst merged = { ...process.env };
\tfor (const entry of env) merged[entry.name] = entry.value;
\treturn merged;
}
function buildTerminalSpawnOptions(command, cwd, env, platform = process.platform) {
\tconst resolvedEnv = toEnvObject(env);''', '''function toEnvObject(env, baseEnv) {
\tif (baseEnv !== void 0) {
\t\tconst merged = { ...baseEnv };
\t\tfor (const entry of env ?? []) {
\t\t\tif (Object.hasOwn(baseEnv, entry.name)) merged[entry.name] = entry.value;
\t\t}
\t\treturn merged;
\t}
\tif (!env || env.length === 0) return;
\tconst merged = { ...process.env };
\tfor (const entry of env) merged[entry.name] = entry.value;
\treturn merged;
}
function buildTerminalSpawnOptions(command, cwd, env, baseEnv, platform = process.platform) {
\tconst resolvedEnv = toEnvObject(env, baseEnv);''', "terminal spawn env")
    text = replace_once(text, "var TerminalManager = class {\n\tcwd;", "var TerminalManager = class {\n\tcwd;\n\tbaseEnv;", "terminal manager field")
    text = replace_once(text, "\t\tthis.cwd = options.cwd;\n\t\tthis.permissionMode = options.permissionMode;",
                        "\t\tthis.cwd = options.cwd;\n\t\tthis.baseEnv = options.baseEnv;\n\t\tthis.permissionMode = options.permissionMode;", "terminal manager constructor")
    text = replace_once(text, "spawnTerminalProcess(params, this.cwd)", "spawnTerminalProcess(params, this.cwd, this.baseEnv)", "terminal create")
    text = replace_once(text, "async function spawnTerminalProcess(params, defaultCwd) {", "async function spawnTerminalProcess(params, defaultCwd, baseEnv) {", "terminal process")
    if text.count("spawnAndWait(directCommand, params, defaultCwd)") != 1 or text.count("spawnAndWait(fallbackCommand, params, defaultCwd)") != 1:
        raise ValueError("unexpected terminal spawn call sites")
    text = text.replace("spawnAndWait(directCommand, params, defaultCwd)", "spawnAndWait(directCommand, params, defaultCwd, baseEnv)")
    text = text.replace("spawnAndWait(fallbackCommand, params, defaultCwd)", "spawnAndWait(fallbackCommand, params, defaultCwd, baseEnv)")
    text = replace_once(text, "async function spawnAndWait(spawnCommand, params, defaultCwd) {\n\tconst spawnOptions = buildTerminalSpawnOptions(spawnCommand.command, params.cwd ?? defaultCwd, params.env);",
                        "async function spawnAndWait(spawnCommand, params, defaultCwd, baseEnv) {\n\tconst spawnOptions = buildTerminalSpawnOptions(spawnCommand.command, params.cwd ?? defaultCwd, params.env, baseEnv);", "terminal spawn options")
    text = replace_once(text, "\t\tthis.terminalManager = new TerminalManager({\n\t\t\tcwd: this.options.cwd,",
                        "\t\tthis.terminalManager = new TerminalManager({\n\t\t\tcwd: this.options.cwd,\n\t\t\tbaseEnv: this.options.terminalEnv,", "ACP client terminal env")
    return text


def patch_runtime(text: str) -> str:
    return replace_once(text, "const clientOptions = { ...options, onAgentStderr: this.options.onAgentStderr };",
                        "const clientOptions = { ...options, onAgentStderr: this.options.onAgentStderr, terminalEnv: this.options.terminalEnv };",
                        "ACPX runtime option forwarding")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: hela18694-acpx-env.py <installed-adapter-utils-package> <new-package-dir>")
    source = Path(sys.argv[1]).resolve(strict=True)
    target = Path(sys.argv[2]).resolve()
    if target.exists():
        raise SystemExit("candidate output already exists")
    if target.is_relative_to(source):
        raise SystemExit("candidate output must be outside the installed package")
    for relative, expected in BASE_SHA256.items():
        actual = hashlib.sha256((source / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"unexpected installed revision: {relative}: sha256 {actual}")
    target.mkdir(parents=True)
    shutil.copy2(source / "package.json", target / "package.json")
    shutil.copytree(source / "dist", target / "dist")
    (target / "node_modules").mkdir()
    shutil.copytree(source / "node_modules/acpx", target / "node_modules/acpx")
    # Link only the small packages required by this isolated smoke candidate.
    # The live dependency tree itself is neither copied nor modified.
    for package_root in (source, source / "node_modules/acpx"):
        manifest = json.loads((package_root / "package.json").read_text())
        for name in manifest.get("dependencies", {}):
            if name == "acpx" or name.startswith("@paperclipai/"):
                continue
            link = target / "node_modules" / name
            if link.exists() or link.is_symlink():
                continue
            dependency = next(
                (parent / "node_modules" / name for parent in (package_root, *package_root.parents)
                 if (parent / "node_modules" / name).is_dir()),
                None,
            )
            if dependency is None:
                # Some CLI-only optional dependencies are absent in this
                # bundled runtime and are not imported by the ACPX engine.
                continue
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(dependency.resolve(), target_is_directory=True)
    patches = {
        "dist/acpx-engine/execute.js": patch_execute,
        "node_modules/acpx/dist/live-checkpoint-ClPCSdrW.js": patch_checkpoint,
        "node_modules/acpx/dist/runtime.js": patch_runtime,
    }
    for relative, edit in patches.items():
        file = target / relative
        original = file.read_text()
        os.chmod(file, 0o644)
        file.write_text(edit(original))
        print(f"staged {relative}: sha256 {hashlib.sha256(file.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
