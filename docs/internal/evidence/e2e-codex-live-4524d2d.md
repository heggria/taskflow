# Live Codex E2E @ tip 4524d2d

**Date:** 2026-08-11  
**Host:** worker-mac (Codex CLI 0.144.1, authenticated)  
**Tree:** clean checkout `4524d2d3be1cf670f7e0300ccd2903acc37fc9b6` (`rc/0.3.0-trusted-effects`)  
**Command:** `PI_TASKFLOW_CODEX_BIN=<codex-darwin-arm64> pnpm run test:e2e-codex`  
**Result:** **PASS** (exit 0) in ~27.6s  

## Proof
- Real `codex exec` subagents for phases pick → use → persist  
- Data flow A→B→C: pick `"Mango"` → final `"MANGO"`  
- Trusted Effects `fs.write` committed with ledger-backed `whyEffect` authority (`authorized.allowed=true`, principal `local-host-invocation`)  
- Log: `docs/internal/evidence/e2e-codex-live-4524d2d.log`

## Notes
- Brain has no local `codex` binary; dogfood ran on worker-mac with existing `~/.codex` auth.  
- Built-MCP fixture L4 remains valid; this closes the **live Codex CLI** leg on tip `4524d2d`.  
