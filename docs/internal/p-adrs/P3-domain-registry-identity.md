# P3: Domain + Registry rebuild + clone/worktree identity

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
- ControlStore **header** is authoritative for `projectId` + `controlDomainId`.
- ControlRegistry is **non-authoritative**; rebuild on open from header.
- **move** (same inode evidence after rebind) → same projectId when rebind succeeds.
- **copy/clone** → **new projectId** unless explicit adopt-identity operator command.
- **git worktree** → new binding; default **new projectId**.

## Rebuild algorithm
1. Open project path → read header.
2. Upsert registry entry from header.
3. Never invent run state from registry alone.

## Status
Accepted for 0.3.0 wire freeze.
