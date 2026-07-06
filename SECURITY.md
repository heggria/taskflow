# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in taskflow, please report it privately rather than opening a public issue.

- **Email:** bshengtao@gmail.com
- **Subject:** `[SECURITY] taskflow — <brief description>`

I aim to acknowledge reports within 72 hours and ship a fix within 7 days for confirmed vulnerabilities.

## Scope

taskflow runs subagent processes, manages a file-based cache with atomic locks, and resolves interpolation expressions from user-provided DSL definitions. Areas of particular interest:

| Area | Concern |
|------|---------|
| **Path traversal** | Can a malicious flow definition escape the workspace via `cwd` or file writes? |
| **Interpolation injection** | Can `{args.X}` or `{steps.ID.output}` be exploited to execute arbitrary shell commands? A string-form `script` `run` containing an interpolation placeholder is **rejected at validation**; the array form passes interpolated values as argv (no shell). |
| **Cache poisoning** | Can a crafted fingerprint or TTL bypass freshness guarantees? |
| **Subagent capability** | Author-written flows can execute shell — via `script` phases and bash-enabled subagents — so a flow definition is **trusted input**. Model calls, and any flow *generated at runtime by a model* (`flow{def}` / `ctx_spawn`), are untrusted by nature. |
| **File lock atomicity** | Can a concurrent process corrupt the run index or cache through race conditions? |

The runtime has intentional hardening: `realpath`-based path containment, runId validation, atomic writes, and stale-lock stealing. But if you find a bypass, it's a vulnerability.

## Supported versions

| Version | Support |
|---------|---------|
| v0.1.5 (latest) | ✅ Active |
| Earlier versions | ❌ Unsupported — upgrade to latest |

## Disclosure

After the fix is released, vulnerabilities will be disclosed publicly in a GitHub Security Advisory and noted in `CHANGELOG.md`. Credit will be given unless you prefer to remain anonymous.
