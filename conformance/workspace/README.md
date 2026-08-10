# Workspace host conformance

`host-support-baseline.json` is the finite, normative allowlist for sandboxed
workspace execution. It starts empty. A host is not sandbox-conformant until an
exact host binary digest, OS build, architecture, sandbox mechanism version,
backend version, redacted evidence bundle, and owner approval are checked in.

Collect conservative local evidence with:

```bash
node scripts/workspace-probes/run.mjs
```

The collector deliberately reports installed hosts as `resolve-only` until the
AgentExecutor, ScriptExecutor, and race-free FileBroker suites all pass. Static
host flags, prompts, and tool permission UIs do not qualify as filesystem
enforcement evidence.

Runtime authorization must use `loadVerifiedHostSupportBaseline()` against this
checked-in file. The loader rejects symlinks, path escapes, oversized evidence,
digest mismatches, target/classification mismatches, missing or unknown strict
checks, inconsistent pass flags, and non-passing evidence for approved sandbox
cells. It hashes and parses one no-follow file snapshot. Constructing an
in-memory object with the same fields is not authority, and native policy
construction additionally requires the exact process-local approval token
minted by the matcher. Evidence must use the exact `tfws-probe:v1` schema. The
factory rechecks the independently observed Host/OS/binary tuple and binds the
complete canonical backend-capabilities digest, backend ID/version, baseline
policy ID, classification, and support-baseline ID. The current allowlist is
empty, so no host may advertise a native workspace sandbox in 0.2.1.
