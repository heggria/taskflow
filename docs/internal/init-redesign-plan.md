# `/tf init` redesign — design plan for review

**Status:** design draft, awaiting analyst + reviewer + risk-reviewer sign-off
**Target version:** 0.0.13
**Estimated scope:** 1 new file, 1 modified, 1 new test, README + package.json

---

## 1. Problem statement

The current `/tf init` (and the tool `action="init"`) has 3 user-visible defects that surfaced during v0.0.12 dogfooding:

1. **Tool path silently clobbers** user-configured `modelRoles`. Any LLM call to `taskflow` with `action="init"` overwrites `~/.pi/agent/settings.json` with hard-coded defaults, even if the user spent time tuning their mapping. There's no `force` flag and no diff preview.
2. **Slash path has no escape hatch**. A user who just wants the recommended defaults must still step through 6 individual `select` dialogs. Conversely, a user who only wants to change one role must step through all 6.
3. **The selector shows raw `provider/model-id` strings** with no display name, no capability flags, no per-role filtering. For the `vision` role, models that don't accept images are listed; for `thinker`/`arbiter`/`reasoner`, no signal is given that some models support reasoning and others don't.

Plus several smaller issues (no save-preview, no Custom validation, no sub-commands, no diff, no stale-role detection) that this plan bundles because they share infrastructure.

---

## 2. Goals & non-goals

### Goals

- **G1. Eliminate silent overwrites.** Tool `action="init"` is read-only by default; writes require explicit opt-in.
- **G2. One-click recommended defaults.** A user can go from "no settings" to "defaults applied" in a single dialog.
- **G3. Tweak-one-role support.** A user can change a single role without re-walking all 6.
- **G4. Show model metadata in pickers.** Display name, reasoning/image flags, and current/recommended markers.
- **G5. Save preview with diff.** Before writing, show old → new and ask for confirmation.
- **G6. Validate Custom input.** Reject malformed `provider/model-id` strings; warn when the model isn't in the registry.
- **G7. Single source of truth.** The role list and recommended defaults live in one place (`extensions/init.ts`), not duplicated across the tool path and slash path.
- **G8. Unit-testable.** The pickers, the diff logic, and the I/O are all pure functions that can be tested without driving the full interactive loop.

### Non-goals

- **N1. No new role types.** The 6 existing roles (`fast`, `strong`, `thinker`, `arbiter`, `vision`, `reasoner`) are unchanged. Adding a 7th role (e.g. `coder`) is a separate decision.
- **N2. No per-agent override UI.** The existing `subagents.agentOverrides` mechanism in `settings.json` is not touched; the init flow only manages `modelRoles`.
- **N3. No new top-level CLI sub-commands.** `/tf init show` / `/tf init reset` are **not** introduced; the show/reset paths go through the new action menu instead. (A future `init --reset` flag could be added later — out of scope.)
- **N4. No migration of stale roles.** If `settings.json` has a role key not in the known set, we surface it in the action menu but don't auto-delete it. (Defer to a follow-up.)

---

## 3. File-level changes

### 3.1 New: `extensions/init.ts`

Single source of truth for init logic. Exports:

```typescript
// Role catalog (replaces both `roleDescs` and `roleDefs` in index.ts)
export interface InitRole {
  role: string;                                  // "fast"
  description: string;                           // "Cheap & quick — high-volume, low-stakes"
  /** Filter the model registry to models usable for this role. */
  filter?: (m: Model<Api>) => boolean;
  /** Sort tiebreaker after recommended-first. */
  sort?: (a: Model<Api>, b: Model<Api>) => number;
  /** Which `input` modalities are required (default: text-only). */
  requireModality?: ("text" | "image")[];
  /** Prefer `reasoning: true` models in display order. */
  preferReasoning?: boolean;
}
export const INIT_ROLES: readonly InitRole[];
// Derived from INIT_ROLES so the catalog is the single source of truth (reviewer F3).
export const RECOMMENDED_DEFAULTS: Readonly<Record<string, string>>;
export const SETTINGS_PATH: string;  // `${getAgentDir()}/settings.json`

// Settings.json I/O — reuses `writeFileAtomic` from `extensions/store.ts:760` (R1).
// `readSettings` validates: missing file → `{}`; malformed JSON → throws (caller
// wraps in `errorResult`); `modelRoles` must be a plain object or absent (analyst
// Major 6 / risk-reviewer R11). Array, string, or null → coerced to `{}` with a warn.
export function readSettings(): Record<string, unknown>;
export function writeSettings(settings: Record<string, unknown>): string;  // returns path

// Picker helpers (pure, fully testable)
export function formatModelOption(m: Model<Api>): string;
export function buildRoleOptions(
  role: InitRole,
  available: ReadonlyArray<Model<Api>>,
  ctx: { current?: string; recommended?: string },  // single context object (reviewer P3)
): string[];  // includes "(current)" / "(recommended)" markers, a separator,
              // "Custom (type your own)", and — when ctx.current is set —
              // "Keep current". "Back to action menu" is always present.
              // When ctx.current is undefined (first run), "Keep current" is
              // omitted (analyst Blocker 2 / reviewer P2).
export function parseCustomModel(input: string): { provider: string; id: string } | null;

// Diff for the preview screen (analyst Blocker 1 + risk-reviewer R11/R12)
export type RoleDiffStatus = "unchanged" | "changed" | "new" | "stale-preserved";
export interface RoleDiffEntry {
  role: string;
  status: RoleDiffStatus;
  before?: string;
  after?: string;
}
export function diffRoles(
  before: Record<string, string>,
  after: Record<string, string>,
  catalog: ReadonlyArray<{ role: string }>,
): RoleDiffEntry[];

// Main interactive flow — discriminated union (reviewer F2 / P3).
export type InitFlowResult =
  | { kind: "saved"; chosen: Record<string, string>; savedPath: string }
  | { kind: "no-change"; chosen: Record<string, string> }
  | { kind: "cancelled" };

export async function runInteractiveInit(ctx: {
  hasUI: boolean;
  signal: AbortSignal;
  ui: ExtensionUIContext;        // narrowed to what init needs
  modelRegistry: ModelRegistry;
  modelList: Model<Api>[];       // pre-resolved: enabledModels or getAvailable()
  currentRoles: Record<string, string>;
}): Promise<InitFlowResult>;
```

The interactive flow opens with an **action menu**. **First-run short-circuit**: when `currentRoles` is empty (no `modelRoles` key, or it's an empty object), the menu collapses to a 2-option gate — `"Apply recommended defaults"` and `"Configure manually"`. This avoids the no-op "Edit one role" / "Show current roles" / "Keep current" UX dead-ends.

```
? What do you want to do with model roles?
  ❯ Use recommended defaults              ← writes RECOMMENDED_DEFAULTS and exits
    Configure each role                   ← current behavior, with metadata + preview
    Edit one role                         ← jump to a single role, keep rest as current
    Show current roles                    ← prints, doesn't open editor
    Cancel                                ← no-op
```

After "Configure each role" or "Edit one role", each picker is built by `buildRoleOptions(...)` (now taking a single `ctx: { current?, recommended? }` object). **Per-role picker footer adapts to first-run:** when `ctx.current` is `undefined`, the footer omits the `"Keep current"` entry entirely and the title line omits `Current: …`. The `"Custom (type your own)"` and `"Back to action menu"` entries stay. The display format:

```
? Model for 'vision' — Multimodal (executor-ui, visual-explorer)
  Current: openrouter/anthropic/claude-sonnet-4-6
  Recommended: minimax/MiniMax-M3
  ───────────────
  ❯ MiniMax M3 (minimax/MiniMax-M3) · image ✓ · reasoning ✓ · (recommended)
    Claude Sonnet 4.6 (openrouter/anthropic/...) · image ✓ · reasoning ✓ · (current)
    GPT-5 (openrouter/openai/gpt-5) · image ✓
    DeepSeek V4 Flash (openrouter/deepseek/v4-flash) · image ✓
    ───────────────
    Custom (type your own)
    Keep current
    Back to action menu
```

After collecting picks, the **preview screen** (using `ctx.ui.select` with options `[Save, Edit a role, Cancel]`):

```
? Review changes:
  fast       openrouter/deepseek/deepseek-v4-flash   (unchanged)
  strong     openrouter/xiaomi/mimo-v2.5-pro         (unchanged)
  thinker    openrouter/qwen/qwen3.7-max             (changed ← was: openrouter/deepseek/v4-pro)
  arbiter    openrouter/qwen/qwen3.7-max             (unchanged)
  vision     minimax/MiniMax-M3                      (unchanged)
  reasoner   z-ai/glm-5.1                            (unchanged)
  ───────────────
  ❯ Save these changes
    Edit a role
    Cancel
```

`"Edit a role"` jumps back into the per-role loop, starting at the changed role. `Cancel` discards everything.

### 3.2 Modified: `extensions/index.ts`

**3.2.a Tool path (currently `extensions/index.ts:277–320`)**

Replace the silent-overwrite block with:

```typescript
if (action === "init") {
  const settings = readSettings();
  const current = (settings.modelRoles ?? {}) as Record<string, string>;
  const mode = params.mode ?? "show";

  // Default: show (read-only). Never overwrites.
  if (mode === "show") {
    return { content: [{ type: "text", text: formatRolesReport(current, readSettings) }], ... };
  }
  // Apply defaults requires explicit `force: true`.
  if (mode === "apply-defaults") {
    if (!params.force) return errorResult(action, "mode=apply-defaults requires force=true to overwrite.");
    writeSettings({ ...settings, modelRoles: { ...RECOMMENDED_DEFAULTS } });
    return { content: [{ type: "text", text: formatDiffReport(current, RECOMMENDED_DEFAULTS) }], ... };
  }
  // mode=interactive — the slash /tf init flow runs here, but only when UI is present.
  if (mode === "interactive") {
    if (!ctx.hasUI) return errorResult(action, "mode=interactive requires an interactive session.");
    const result = await runInteractiveInit({ ... });
    return { content: [{ type: "text", text: formatFlowResult(result) }], ... };
  }
  return errorResult(action, `Unknown init mode: ${mode}`);
}
```

The tool schema gets a new `mode` enum and a `force` boolean.

**3.2.b Slash path (currently `extensions/index.ts:570–650`)**

Replace the per-role loop with `runInteractiveInit(...)`. The `if (!ctx.hasUI)` branch still handles the "show or warn" fallback for non-interactive sessions.

### 3.3 New: `test/init.test.ts`

Covers the pure functions (no UI driving needed):

- `formatModelOption` — name, provider/id, flags
- `buildRoleOptions` — current marker, recommended marker, separator, Custom + Keep current entries
- `buildRoleOptions` with role-aware filtering (vision role omits text-only models)
- `buildRoleOptions` with role-aware sorting (thinker role prefers reasoning-first)
- `parseCustomModel` — accepts `provider/model-id`, rejects malformed strings
- `parseCustomModel` — multi-slash names (e.g. `vercel-ai-gateway/anthropic/claude-sonnet-4-6`) handled
- `diffRoles` — unchanged / changed / new / removed buckets
- `readSettings` + `writeSettings` round-trip preserves other keys (e.g. `subagents.agentOverrides`)
- `pickRecommended` — falls back to first available when registry is empty
- `INIT_ROLES` — every role has a non-empty description
- `RECOMMENDED_DEFAULTS` — every key is a member of `INIT_ROLES`
- Mock `ctx.ui` that records `select`/`input` calls and returns canned answers → drives `runInteractiveInit` end-to-end for at least one scenario (action menu → use defaults → save)

### 3.4 Modified: `package.json`

Add `test/init.test.ts` to the `test` script (the existing glob-less `node --test` invocation).

### 3.4.1 Modified: `extensions/index.ts` schema (tool params)

The tool schema gets two new fields. Use `StringEnum` (the project's standard helper, used 7 places in the codebase) to get typebox-level rejection of unknown modes:

```typescript
mode: Type.Optional(StringEnum(
  ["show", "apply-defaults", "interactive"] as const,
  { description: "Init action mode. 'show' is read-only; 'apply-defaults' requires force:true; 'interactive' requires a UI session.", default: "show" }
)),
force: Type.Optional(Type.Boolean({
  description: "Destructive: overwrites `modelRoles` in ~/.pi/agent/settings.json. Required for mode='apply-defaults'.",
})),
```

### 3.5 Modified: `README.md`

Update the "Configure each role" example to reflect:
- Action menu at the top
- Picker now shows model display names + capability flags
- Preview screen before save
- New `force: true` semantics for the tool path

---

## 4. Public API changes

### 4.1 Tool schema (`action="init"`)

**Before:**

```typescript
{
  action: "init"
}
```

**After:**

```typescript
{
  action: "init",
  mode?: "show" | "apply-defaults" | "interactive",  // default: "show"
  force?: boolean,                                    // only for apply-defaults
}
```

**Compatibility:** existing callers passing only `action: "init"` now get the show report (read-only) instead of a silent overwrite. This is a **behavior change** but a strictly safer one — we trade a destructive default for a non-destructive one. Documented in CHANGELOG (which we don't have — added as a "Breaking" note in the README "Upgrading" section).

### 4.2 Slash command

`/tf init` semantics unchanged for the happy path. The first dialog becomes the action menu instead of immediately entering the fast-role picker. The first dialog has a "Use recommended defaults" shortcut.

---

## 5. Risk analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **R1. Settings.json corruption during write** | Low | High (user loses all role config) | Reuse `writeFileAtomic(filePath, data)` from `extensions/store.ts:760` (uses `pid + randomBytes` for unique tmp, has cleanup-on-error). Do **not** hand-roll the `.tmp` + rename pattern. |
| **R2. Breaking the existing tool path for v0.0.12 users** | Medium | Medium | Two-release bridge: v0.0.13 keeps old auto-write when `mode` is omitted and `modelRoles` is empty, with a deprecation `console.warn`; v0.0.14 makes `mode` required. See §3.2.a.1. |
| **R3. Picker is too long / overwhelming** | Medium | Low (UX) | Cap the option list at ~20 entries; truncate remainder with a hint. Group by provider in the display. |
| **R4. Custom input accepts invalid models** | Medium | Low (UX) | `parseCustomModel` rejects malformed. After parse, check `modelRegistry.find(...)`; if missing, warn via `ctx.ui.notify("warning", ...)` but allow (users sometimes use custom-routed providers). Custom providers not in the registry are accepted silently — the registry check is best-effort. |
| **R5. Esc on different dialogs produces ambiguous `undefined` return** | Medium | Medium | Each dialog handler tracks which step it's on. The action menu's `undefined` → `{kind: "cancelled"}` (whole flow exits). The custom-input `undefined` → fall back to `current ?? recommended` (no exit). Picker `undefined` → treat as "Back to action menu" (return to action menu, partial picks kept in a draft). All three paths are unit-tested. |
| **R6. Test mocks diverge from real `ctx.ui` shape** | Low | Medium | Keep mock interface narrow; only the methods init actually calls. Add a comment linking back to `ExtensionUIContext`. At least one e2e smoke check in `test/e2e.mts` covering the action menu. |
| **R7. The action menu in non-interactive (RPC) mode** | Low | Low | The `ctx.hasUI` branch already exists. If UI is absent, show the same `formatRolesReport` as `mode=show` plus a "Run /tf init in an interactive session to configure" hint. |
| **R8. Recommended defaults list goes stale as providers change** | Low | Low | Out of scope for v0.0.13. Document that defaults are hard-coded in `extensions/init.ts` and need manual update. Future: read from a curated `models-recommend.json`. |
| **R9. Rounding / currency bugs in cost display** | Low | Low (cosmetic) | Display cost in `$X.XX/M input` form, 2 decimals. Truncate if too long. |
| **R10. Atomic write fails on Windows due to rename semantics** | Low | Medium | `writeFileAtomic` uses `fs.renameSync`. On Windows, rename can fail with `EPERM` if the target is open. Wrap in try/catch; on `EPERM`/`EACCES`, retry the rename once after a small `setTimeout(0)`, then fall back to non-atomic `fs.writeFileSync` with a `ctx.ui.notify("warning", ...)` so the user sees it. |
| **R11. `readSettings` doesn't validate `modelRoles` shape** | Medium | High (silent data loss / confused user) | After `JSON.parse`, check `modelRoles` is a plain object (not array, not string, not null). Coerce any other shape to `{}` with a one-time `console.warn` ("settings.json: modelRoles had unexpected shape, treating as empty"). |
| **R12. Stale role keys silently dropped by `apply-defaults`** | Medium | High (silent data loss) | `apply-defaults` merges `RECOMMENDED_DEFAULTS` with any existing keys NOT in the catalog (stale-preserved). The diff report surfaces stale-preserved keys explicitly. See §3.2.a code above. |

---

## 6. Test plan (concrete)

All tests are pure (no real TUI, no real settings file outside tmpdirs). 12-15 unit tests, 1-2 integration tests.

```
test/init.test.ts
  formatModelOption
    ✓ includes display name and provider/id
    ✓ adds "reasoning" tag when model.reasoning is true
    ✓ adds "image" tag when model.input includes "image"
    ✓ omits modality tag for text-only models
  buildRoleOptions
    ✓ marks current pick with "(current)"
    ✓ marks recommended pick with "(recommended)"
    ✓ dedupes by provider/id
    ✓ separates with a "───" line and appends "Custom (type your own)" + "Keep current"
    ✓ vision role: filters out text-only models
    ✓ thinker role: sorts reasoning=true models first
  parseCustomModel
    ✓ parses "openrouter/xiaomi/mimo-v2.5-pro"
    ✓ parses "vercel-ai-gateway/anthropic/claude-sonnet-4-6" (3+ segments)
    ✓ rejects "no-slash"
    ✓ rejects ""
    ✓ rejects "provider/" (empty id)
  diffRoles
    ✓ unchanged / changed / new / stale-preserved correctly classified
    ✓ "stale-preserved" appears when a key in `before` is NOT in catalog
    ✓ diff order matches INIT_ROLES order, with unknown roles appended
  readSettings / writeSettings
    ✓ round-trip preserves non-modelRoles keys (subagents.agentOverrides etc.)
    ✓ write is atomic (reuses `writeFileAtomic` from `store.ts:760` — verify the
      unique-tmp naming and cleanup-on-error path)
    ✓ missing file → returns {} and writes from scratch
    ✓ malformed JSON → throws (caller wraps in `errorResult`)
    ✓ `modelRoles: []` or `""` or `"string"` → returns `{}` (validated type guard)
  buildRoleOptions (empty state)
    ✓ `ctx.current` undefined → no "Keep current" entry, no "Current:" line in title
    ✓ `ctx.current` set → "Keep current" entry present
  INIT_ROLES
    ✓ every role has a non-empty description and a non-empty `defaultModel`
  RECOMMENDED_DEFAULTS
    ✓ derived from `INIT_ROLES`, not stored separately
  runInteractiveInit (mocked ui)
    ✓ empty `currentRoles` → 2-option action menu (Apply defaults / Configure manually)
    ✓ "Apply recommended defaults" → returns `{kind: "saved", chosen: RECOMMENDED_DEFAULTS}`
    ✓ "Configure each role" with "Keep current" picks → returns `{kind: "saved", chosen: current}`
    ✓ all picks identical to current → returns `{kind: "no-change", chosen: current}`, no dialog
    ✓ "Cancel" on action menu → returns `{kind: "cancelled"}`
    ✓ Esc on action menu (undefined return) → `{kind: "cancelled"}` (NOT confused with
      custom input Esc — R5 fix)
    ✓ "Edit one role" with a custom model `openrouter/x/foo` that's not in
      registry → still saves, but warns
```

---

## 7. Out-of-scope follow-ups

- `init --show` / `init --reset` as slash sub-commands (N3)
- Auto-cleanup of stale role keys (N4)
- Curated `models-recommend.json` instead of hard-coded `RECOMMENDED_DEFAULTS` (R8)
- Per-agent override UI (N2)
- A real `CHANGELOG.md` so we don't have to retrofit breaking notes into README (G2 addendum)

---

## 8. Open questions — resolved by multi-agent review

1. **Q1 (show-by-default).** **Show-by-default + one-release bridge.** Risk-reviewer correctly identified the bootstrap regression: an LLM calling `action="init"` with no `mode` on a fresh system relied on auto-write. v0.0.13 keeps the old behavior with a deprecation `console.warn`; v0.0.14 makes `mode` required. See §3.2.a.1.
2. **Q2 (defaults at top of menu).** **Yes, at the top.** Primary use case for new users.
3. **Q3 (configurable `INIT_ROLES`).** **Hard-coded in `extensions/init.ts`.** No demand signal; N1 defers the design discussion.
4. **Q4 ("Keep current" as option vs keybind).** **Explicit option in the picker footer.** TUI key events are not reliably forwarded through `ctx.ui.select`; an explicit entry is unambiguous.
5. **Q5 (no-change preview).** **Short-circuit, no dialog.** Return `{kind: "no-change", chosen: current}` and `notify` a one-liner.
