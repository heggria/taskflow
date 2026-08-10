# Homepage v3 — Overall Design & Implementation Plan

> **Status:** Superseded on 2026-07-10 by `docs/internal/homepage-v4-plan.md`.  
> **Date:** 2026-07-10  
> **Scope:** `website/` homepage (`/[lang]`) only. Docs chrome may inherit tokens lightly; docs content pages out of scope unless noted.  
> **Inputs:** v1 (over-designed), v2 (clean but flat), 4-agent brainstorm (brand / motion / PLG / creative director).  
> **Goal:** 高级感 (premium craft + status) **and** 冲动感 (desire to install *now*) without returning to blob/glass kitsch.  
> **Historical note:** This document records the v3 direction that was implemented, then rejected for the 0.2.0 flagship reset. See `homepage-v4-plan.md` for the current redesign direction.

---

## 0. Executive summary

### 0.1 Why v2 fails (diagnosis lock-in)

| Symptom | Root cause |
|---------|------------|
| 干净但不高级 | Restraint without authorship; even craft; diagram-as-hero; SaaS section grammar |
| 不冲动 | Hero states the resolution too early; no staged pain; demo has no climax; best pain copy buried in footer |
| 像模板 | Ambient CSS (fade/marquee/particles) ≠ product theater |
| Killer insight 被埋 | Context isolation treated as one feature among equals |

### 0.2 North-star concept (one sentence)

**「The Collapse」— A 3-second ritual: multi-agent chaos is erased; only the final answer survives. The rest of the page is aftermath.**

Metaphor (visual language, not literal illustration): **Foundry of Final Answers** — cold industrial monochrome + one heat accent; intermediate = slag; `finalOutput` = ingot.

### 0.3 Dual lever model (must not mix carelessly)

| Lever | 高级感 | 冲动感 |
|-------|--------|--------|
| Emotion | Status, craft, mystery, “I’m among the few” | Recognition of pain, FOMO, “install tonight” |
| Time | Slow, sparse, held breath | One spike, then silence |
| Page budget | 95% of surfaces | **Exactly one** signature moment + CTA harvest |
| Anti-pattern | Empty museum | Neon urgency / badge confetti |

**Rule:** One 高级 spine for the whole site. One 冲动 spike (The Collapse + primary CTA). Impulse does not redesign the brand system.

### 0.4 Success metrics (qualitative acceptance)

A first-time visitor (power user of Claude/Codex/Pi) after **15 seconds** should be able to say:

1. **Pain:** My host chat gets polluted by subagent noise.  
2. **Law:** taskflow keeps intermediates out of the host; only the answer returns.  
3. **Proof:** I saw a run end with a clean host message.  
4. **Action:** I know one install path for *my* host.

After **60 seconds** they should also know: verify-before-tokens, resume/cache, 5 hosts, JSON or TS DSL.

---

## 1. Audience, positioning, non-goals

### 1.1 Primary ICP (hero of the story)

**Host-chat operator:** a strong individual developer who already runs multi-step agent work inside Claude Code / Codex / Pi / OpenCode / Grok, hits context collapse or paste-hell weekly, and wants a named, resumable pipeline without adopting LangGraph/Temporal.

- **Cares about:** clean context, not re-running 40 minutes, not babysitting agents  
- **Does not care about first:** phase-type inventory, event-kernel internals, “declarative vs imperative” theory  

### 1.2 Secondary ICP (later sections only)

Platform / infra eng who needs gates, budgets, tournaments, replay as *policy*. They arrive after the law is proven.

### 1.3 Villain / prize

| Role | Entity |
|------|--------|
| Villain | Intermediate transcripts + “start over from zero” |
| Mentor | taskflow runtime (graph + isolation + verify) |
| Prize | Clean final answer + reusable named flow on existing host |

### 1.4 Positioning statement (internal)

> taskflow is the **context-isolation layer** for multi-phase coding agents: declare work as a verifiable DAG, run subagents out-of-process, return only `finalOutput` to the host.

Not: “another agent framework.”  
Not: “Airflow for LLMs” as the hero line (accurate but unsexy — demote to supporting).

### 1.5 Non-goals (v3 homepage)

- Full product tour of all 12 phase types on first screen  
- Real-time live backend demos (static/export site)  
- Fake social proof / fake counters  
- WebGL / 3D graph flex  
- Scroll-jacking multi-minute cinema  
- Changing docs IA or full site redesign beyond homepage tokens  
- Returning to v1 mesh blobs, glass cards, conic badge spin, perpetual CTA glow  

---

## 2. Narrative architecture (beat sheet)

Energy curve (not monotonic decay):

```
Beat1 Pain (↑) → Beat2 Law (↑↑ peak) → Beat3 Proof/Install (↑)
→ Beat4 Power consequences (→) → Beat5 Status strip (↑) → Beat6 CTA harvest (↑)
```

| # | Beat | User feeling | On-page form | Duration of attention |
|---|------|--------------|--------------|------------------------|
| 0 | Environment | “This runs where I already work” | Quiet host marks (not infinite marquee as hero) | 1s |
| 1 | **Pain / recognition** | “That’s my Tuesday” | Hero headline + sub + optional micro scar line | 3–5s |
| 2 | **The Collapse (signature)** | Awe + relief | Signature 3s stage (autoplay once) | 3s |
| 3 | **The Law** | Intellectual peak | One large doctrine line under/after Collapse | 2s |
| 4 | **Proof / install** | Competence FOMO | One command + host switcher + mini gem | 10–20s |
| 5 | **Consequences of the law** | “This is a system” | 3 cards: verify / resume·cache / power later | 15s |
| 6 | **0.2 as era** | Serious product | Not “changelog” — “runtime became a system” + 4–6 dense items | 15s |
| 7 | **Dual authoring** | Engineer proof | JSON \| TS linked to same mental model | 10s |
| 8 | **Worldview compare** | Identity | Ad-hoc vs taskflow (not textbook CS) | 10s |
| 9 | **One case** | Trust | One real/dogfood outcome (or omit if weak) | 8s |
| 10 | **CTA harvest** | Action | Pain echo + install + docs | 5s |

### 2.1 What to kill from v2 structure

| v2 block | Fate |
|----------|------|
| Hero “Orchestrate / Return only the answer” as pure category | Replace with pain→law arc |
| Infinite hosts marquee as primary trust | Demote to static row or slow crossfade under environment |
| Stats 12/5/0/1 as equal inventory | Rebuild as **contract strip** (see §5.5) |
| “What’s new in 0.2” feature grid as mid-page peak | Reframe as era; never higher energy than Collapse |
| Principles 01–04 equal grid | Merge into law consequences or kill |
| Comparison declarative vs imperative | Rewrite as identity/context ownership |
| Footer-only “Stop pasting logs” | **Promote** energy into hero sub or post-Collapse caption |

---

## 3. Signature moment — The Collapse (full spec)

### 3.1 Purpose

Make the product invariant **felt** in ≤3 seconds:

> Intermediate agent work never enters the host. Only the final answer survives.

### 3.2 Placement

- **Primary:** Hero below headline+CTA (or between sub and CTA on large screens — prefer **below first CTA pair** so CTA is visible without waiting for animation).  
- **Alternative on mobile:** Static final frame first; autoplay only if `prefers-reduced-motion: no-preference` and `IntersectionObserver` ≥50% visible once.

### 3.3 Shot list (exact timing)

| t (ms) | Visual | Audio (optional, default off) | Accessibility |
|--------|--------|-------------------------------|---------------|
| 0–100 | Stage mounts: dark product frame, host chrome skeleton | — | Focusable region `aria-label` |
| 100–800 | **Noise phase:** stacked fake transcript chips (tool spam, partial JSON, “reviewer…”, token counters). Intentionally dense/uncomfortable. Host chat panel shows growing sludge | — | |
| 800–1600 | Noise **reorders** into a clear left-to-right graph (plan → map×N → gate → reduce). Recognition beat | — | |
| 1600–2400 | **Erase:** intermediate nodes/edges dissolve (ink-lift / slag-skim — hard cut opacity + scaleY collapse, not soft pastel fade). Host panel **clears** in sync | Optional single dry tick | |
| 2400–3000 | **Only final remains:** one answer card in host panel; mono label `finalOutput`. Caption fades in under stage | — | |
| 3000+ | Hold final frame. Button “Replay” (text, quiet). No infinite loop of the full collapse | — | |

**Total autoplay:** 3000ms once per page visit (sessionStorage `tf-collapse-played=1`). Replay resets.

### 3.4 Reduced motion

`prefers-reduced-motion: reduce` → jump to **final frame** only + caption. No autoplay.

### 3.5 Visual language of erase (do / don’t)

| Do | Don’t |
|----|--------|
| Hard dissolve, mask wipe, scale collapse | Soft multi-color particle explosion |
| One accent color on success path only at t≥2400 | Rainbow edges |
| Host chrome (window chrome, empty then one message) | Floating diagram without host metaphor |
| Mono micro-labels | Decorative Lucide rain |

### 3.6 Copy locked to the moment

| Locale | Caption (after silence) |
|--------|-------------------------|
| en | Only the final answer survives. |
| zh-cn | 只有最终答案活下来。 |

Supporting micro-line (optional, smaller):

| en | Intermediate transcripts never enter the host. |
| zh-cn | 中间 transcript 永不进入宿主。 |

### 3.7 Component name

`components/home/collapse-stage.tsx` (`"use client"`)

Props: `labels: { caption, micro?, hostTitle, finalLabel, replay }`  
Internal: state machine `noise | structure | erase | final`.

---

## 4. Visual design system

### 4.1 Palette (homepage tokens)

Keep independent `--home-*` (do not force docs to pure black if docs need brand warm — homepage owns the spine).

| Token | Light | Dark | Role |
|-------|-------|------|------|
| `--home-bg` | `0 0% 100%` | `0 0% 3.5%` | Page ground |
| `--home-fg` | `0 0% 8%` | `0 0% 98%` | Primary text / primary buttons |
| `--home-muted` | `0 0% 40%` | `0 0% 58%` | Secondary text |
| `--home-border` | `0 0% 90%` | `0 0% 14%` | Hairlines |
| `--home-surface` | `0 0% 98%` | `0 0% 6%` | Bands / cards |
| `--home-stage` | `0 0% 6%` | `0 0% 5%` | **Product stage always dark** |
| `--home-stage-fg` | `0 0% 96%` | `0 0% 96%` | Text on stage |
| `--home-heat` | `24 95% 48%` | `30 100% 55%` | **Sacred accent** — rare |

**Accent budget:** heat ≤ ~2% of first-screen pixels. Allowed uses only:

1. Collapse final answer edge / check  
2. Primary CTA hover ring (optional, subtle)  
3. Semantic PASS in stage  

Forbidden: heat on every card border, marquee dots, all icons.

### 4.2 Typography

| Role | Spec |
|------|------|
| Display (hero) | 2.75–4.5rem, **font-weight 600**, tracking `-0.04em`, line-height 1.05–1.1 |
| Display em line | Same size or 0.92×; gradient or muted fade (not orange) for second line |
| Section H2 | 2–2.75rem, weight 600, tracking `-0.03em` |
| Body | 1–1.125rem, weight 400, line-height 1.6, max-width ~36rem for reading |
| Micro / mono | 11–12px, `JetBrains Mono` / `--font-mono`, tracking wide for labels |
| **Weight cliff** | Display vs body must feel like a cliff, not a slope (v2 medium-weight problem) |

### 4.3 Layout rhythm

| Zone | Max width | Vertical padding |
|------|-----------|------------------|
| Content | 72rem (1152px) | — |
| Hero | centered 40rem copy + stage 48–56rem | pt 6–8rem, pb 4–6rem |
| Full-bleed bands | 100vw with surface bg | py 6–8rem |
| **Asymmetry** | Stage denser than marketing chrome | — |

Section alternation (break brochure cadence):

1. Hero (light bg + dark stage)  
2. Law strip (light, almost empty)  
3. Proof/install (surface)  
4. Consequences (light, 3 columns)  
5. 0.2 era (surface)  
6. Code dual (light)  
7. Compare (surface)  
8. CTA (dark inverted or pure fg band)  

### 4.4 Surfaces & depth

| Surface | Treatment |
|---------|-----------|
| Cards | 1px border, **no** glass blur, **no** gradient border jewelry |
| Stage | Dark, 1px border, shadow `0 24px 80px -32px` black/55% |
| Hover | Border darken only; **no** global `translateY` lift on every card |
| Focus | 2px ring `home-fg` |

### 4.5 Iconography

- Prefer **none** on hero.  
- Micro geometric marks OK in stage (status dots).  
- Lucide only if sparse (CTA arrows). Never watermark icons.

### 4.6 Light/dark philosophy

- **Reading habitat:** light (or system) marketing chrome.  
- **Product habitat:** stage always dark (even in light mode).  
- Theme toggle remains fumadocs global; stage tokens fixed dark.

---

## 5. Section-by-section specification

### 5.1 Global chrome

- Keep `HomeLayout` (nav + i18n + github).  
- Homepage body uses `.home-root` full-bleed.  
- Nav stays fumadocs; do not invent a second mega-nav.

### 5.2 Beat 0–1 — Hero

**Structure (desktop):**

```
[eyebrow: taskflow 0.2]
[H1 line1: pain/identity]
[H1 line2: doctrine or payoff]
[sub: 1–2 sentences max]
[CTA primary] [CTA secondary]
[Collapse stage]
[caption under stage]
[hosts: static or slow row]
```

**Copy — EN (locked recommendation: impulse-first doctrine hybrid)**

| Element | EN | ZH |
|---------|----|----|
| Eyebrow | taskflow 0.2 | taskflow 0.2 |
| H1 L1 | Your host chat is not a dump for subagents. | 宿主对话不该是子代理的垃圾场。 |
| H1 L2 | Only the answer belongs in your context. | 只有答案该进入你的上下文。 |
| Sub | Declare multi-phase coding work as a verifiable DAG. Subagents run isolated. Intermediate transcripts never enter Claude, Codex, Pi, OpenCode, or Grok — only `finalOutput` returns. | 把多阶段编程工作声明成可验证的 DAG。子代理隔离运行。中间 transcript 永不进入 Claude / Codex / Pi / OpenCode / Grok——只有 `finalOutput` 回来。 |
| CTA primary | Get started | 开始使用 |
| CTA secondary | GitHub | GitHub |
| Hosts label | Runs where you already think | 运行在你已经在用的宿主上 |

**CTA links:**  
- Primary → `/{lang}/docs/getting-started`  
- Secondary → `https://github.com/heggria/taskflow`  

**Layout detail:** On `lg+`, H1 max-width 20ch for L1 (allow wrap); avoid ultra-long single line on ultrawide.

### 5.3 Beat 2–3 — Collapse + Law

Law can be the **stage caption** (preferred) so we don’t repeat three times.

If separate law band: full-width, large type, almost no other UI:

> Intermediate agent work stays in the runtime.  
> **Only the answer enters your window.**

### 5.4 Beat 4 — Proof / Install

**Title:** Prove it in one command. / 一条命令证明。

**Host segmented control** (client): `claude | codex | pi | opencode | grok`

| Host | Install command (verify against repo before ship) |
|------|--------------------------------------------------|
| claude | `claude plugin install …` (use current docs path) |
| codex | `codex plugin add …` |
| pi | `pi install npm:pi-taskflow` (or current) |
| opencode | mcp entry from docs |
| grok | plugin / npx path from docs |

**UI:** Mono command in dark chip + **Copy** button → checkmark 1.5s.

**Mini gem** (right or below): 12–15 line JSON or TS of discover→map→reduce with `final: true` — not the full review-changes novel.

**Detail:** Commands must match `skills-src` / README install paths at implement time (agent: docs-sync).

### 5.5 Contract strip (replaces vanity stats)

Four cells, equal width, border-divided:

| Value | Label EN | Label ZH |
|-------|----------|----------|
| 1 | answer returns to host | 回到宿主的答案 |
| 0 | intermediate transcripts in chat | 进入对话的中间记录 |
| 5 | host CLIs | 宿主 CLI |
| ∞ → 1 | work collapsed to final | 工作坍缩为最终结果 |

Optional fifth micro line: `0` engine runtime deps — only if space; never lead with it.

### 5.6 Beat 5 — Consequences of the law (3 cards only)

**Title:** What isolation makes possible. / 隔离带来的能力。

| # | Title EN | Body EN | Title ZH | Body ZH |
|---|----------|---------|----------|---------|
| 1 | Verify before tokens | Static analysis catches cycles, dead ends, and impossible budgets before a model is called. | 花 token 前先验证 | 静态分析在调用模型前捕获环路、死路与不可能的预算。 |
| 2 | Resume & cache | Failed runs continue. Content-addressed phases skip work you already paid for. | 续跑与缓存 | 失败的运行可继续。内容寻址阶段跳过你已付费的工作。 |
| 3 | Power when ready | Gates, loops, tournaments, race/expand, sub-flows — composed as data, not paste. | 需要时再上强度 | 门控、循环、锦标赛、race/expand、子流程——以数据组合，而非粘贴。 |

No “01/02/03” museum numbers unless mono and tiny.

### 5.7 Beat 6 — 0.2 as era (not changelog)

**Title:** 0.2 — the runtime became a system. / 0.2 — 运行时成为系统。  
**Sub:** Not a feature dump — the layer under your host is now complete enough to build on.

Items (6 max, dense, mono tags OK):

1. TypeScript DSL (S4)  
2. race & expand (Horizon B)  
3. Event kernel (S0–S3, opt-in, fail-closed)  
4. Offline replay  
5. Five host adapters  
6. Cross-run FlowIR cache  

**Do not** title this “What’s new in 0.2” (changelog energy kills premium).

### 5.8 Beat 7 — Dual authoring

**Title:** Same contract. Two surfaces. / 同一合同，两种写法。  
**Caption:** JSON for portability. TypeScript for authoring. One runtime.

Two panels side by side (`lg`), stacked mobile. Shared example name `review-changes`. Syntax tint only; no float animation on windows.

**Link highlight (stretch goal M):** hovering a phase id in JSON dims others — nice-to-have, not P0.

### 5.9 Beat 8 — Worldview comparison

**Title:** Ad-hoc multi-agent vs taskflow  
**Subtitle:** Not CS theory — who owns your context.

| Row | taskflow | Ad-hoc |
|-----|----------|--------|
| Who owns the plan? | Declared graph you can version | Model prose you re-derive |
| What enters your chat? | `finalOutput` only | Every intermediate dump |
| Failure? | Resume + cache | Restart from zero |
| Before spend? | Verify | Hope |

UI: left column inverted (fg bg) for taskflow header; checks vs minus — keep v2 pattern but rewrite rows.

### 5.10 Beat 9 — Social / case (conditional)

**Prefer:** one dogfood or case study with numbers (e.g. security review / release notes).  
**If no real quote:** omit testimonials entirely (fake “Series B” quotes reduce 高级感).

### 5.11 Beat 10 — Final CTA

**EN**

- Title: Stop paying context rent on intermediate transcripts.  
- Body: Declare the graph. Verify it. Get the answer — on the host you already use.  
- Primary: Read the docs → `/{lang}/docs`  
- Secondary: Examples → github examples  

**ZH**

- Title: 别再为中间 transcript 支付上下文租金。  
- Body: 声明图。先验证。拿答案——在你已经在用的宿主上。  
- Primary: 阅读文档  
- Secondary: 示例  

Band: high contrast (fg background, bg text) or pure surface with strong type — not orange gradient soup.

---

## 6. Motion system

### 6.1 Tokens

| Name | Value | Use |
|------|-------|-----|
| `motion-fast` | 120ms | Button press, copy check |
| `motion-ui` | 200ms | Borders, chips |
| `motion-content` | 400–700ms | Reveal |
| `ease-out-premium` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances |
| `ease-ui` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Controls |
| `linear` | linear | **Only** continuous data-flow strokes |

### 6.2 Allowed motions

| Motion | Where |
|--------|-------|
| Collapse state machine | Stage only |
| One-shot hero text entrance (opacity + 8–12px Y, **no heavy blur**) | Hero copy |
| Scroll reveal once | Sections below fold |
| Copy success check | Install chip |
| Optional path highlight on phase hover | Stage / code (P1) |

### 6.3 Forbidden motions

- Global card hover-lift  
- Infinite full Collapse loop  
- Marquee as primary attention (slow or static hosts)  
- Blur-in > 4px  
- Code window float/bob  
- Badge shimmer / conic spin  
- Parallel ambient loops competing with Collapse  

### 6.4 Scroll choreography (P1 stretch)

Sticky stage over ~100vh scrubbing acts is **P1**, not P0. P0 is autoplay Collapse once + hold.  
If implemented: map scroll 0–100% to noise→structure→erase→final; `prefers-reduced-motion` → static frames with step dots.

---

## 7. Component architecture

```
website/
  app/[lang]/page.tsx              # Server: composition + copy + JSON-LD
  components/home/
    collapse-stage.tsx             # Client: signature moment (P0)
    install-strip.tsx              # Client: host switch + copy (P0)
    hosts-row.tsx                  # Static or slow row (rewrite)
    reveal.tsx                     # Keep, retune easing
    contract-strip.tsx             # Server OK
    consequence-cards.tsx          # Server OK
    dual-code.tsx                  # Server OK
    compare-table.tsx              # Server OK
    final-cta.tsx                  # Server OK
    # DELETE or gut: flow-demo.tsx as hero (replace with collapse-stage)
  app/globals.css                  # home-* tokens + stage + motion
```

### 7.1 page.tsx rules

- All user-facing strings in `copy.en` / `copy['zh-cn']` (parity required).  
- No marketing logic in CSS-only content.  
- JSON-LD: `async` script (already fixed).  
- Keep SEO metadata in layout.

### 7.2 Accessibility

- Collapse: `role="img"` + `aria-label` describing final state; Replay keyboard accessible.  
- Don’t rely on color alone for PASS.  
- Focus order: CTAs before Replay.  
- Contrast: WCAG AA for body text on both themes.

### 7.3 Performance

- No heavy Lottie files required; CSS + SVG preferred.  
- Collapse SVG/DOM budget: &lt; 50 nodes if possible.  
- Avoid layout thrash; use transform/opacity.  
- `sessionStorage` for played flag.  
- Static export compatible (no SSR-only APIs without guards).

---

## 8. Content accuracy (must verify at implement)

Implementing agents must cross-check:

| Claim | Source of truth |
|-------|-----------------|
| Install commands per host | README, skills, host guides |
| 5 hosts list | pi, codex, claude, opencode, grok |
| 12 phase types | schema PHASE_TYPES |
| 0 runtime deps (engine) | taskflow-core package.json |
| Isolation / finalOutput | AGENTS.md invariants |
| Kernel default OFF | claim-vs-impl / runtime |
| DSL package name | taskflow-dsl |

**Honesty:** Do not claim flagship $6→$0.40 as certified. Do not claim S5 kernel default ON.

---

## 9. i18n requirements

| Rule | Detail |
|------|--------|
| Full parity | Every EN string has ZH |
| No mixed hero | ZH pages must not show EN doctrine only |
| Technical terms | Keep `finalOutput`, DAG, host names in Latin where conventional; explain in ZH body |
| Line breaks | ZH H1 may be two lines; test at 375px width |

---

## 10. Implementation plan (multi-agent ready)

### 10.1 Phase order (serial dependencies)

```
Phase A — Design tokens + CSS spine (blocks visual work)
    ↓
Phase B — Collapse stage (hero product theater)
    ↓
Phase C — page.tsx recompose + all copy EN/ZH
    ↓
Phase D — Install strip + contract strip + sections
    ↓
Phase E — Polish a11y/reduced-motion/SEO + visual QA
```

### 10.2 Multi-agent work packages (after plan approval)

| Agent | Package | Owns | Depends on | Deliverable |
|-------|---------|------|------------|-------------|
| **A1 Tokens** | CSS system | `globals.css` home tokens, stage, buttons, motion tokens, kill dead v1/v2 utilities | — | Tokens documented in CSS comments |
| **A2 Collapse** | Signature | `collapse-stage.tsx` + CSS classes | A1 | 3s state machine, replay, reduced-motion |
| **A3 Page shell** | Composition | `page.tsx` structure, section order, imports | A1, A2 API | Full page wiring |
| **A4 Copy** | i18n | All EN/ZH strings per this plan | A3 structure | Parity table |
| **A5 Install** | PLG | `install-strip.tsx`, commands from docs | A1, docs read | Copy-to-clipboard + hosts |
| **A6 Sections** | Content blocks | contract, consequences, era, dual-code, compare, CTA | A1, A4 | Components or inline |
| **A7 QA** | Verification | build, a11y, reduced-motion, mobile 375, claim 1280/1440, no console errors | all | Checklist signed |

**Parallelism after A1:** A2 ∥ A5 ∥ (A4 prep).  
**A3** after A2 props stable.  
**A6** can parallel A3 if contracts fixed.  
**A7** last.

### 10.3 File-level change list

| File | Action |
|------|--------|
| `docs/internal/homepage-v3-plan.md` | This plan (source of truth) |
| `website/app/globals.css` | Replace home utilities with v3 system |
| `website/app/[lang]/page.tsx` | Full recompose |
| `website/components/home/collapse-stage.tsx` | **Create** |
| `website/components/home/install-strip.tsx` | **Create** |
| `website/components/home/flow-demo.tsx` | **Remove from hero** (delete or relegate to docs only) |
| `website/components/home/hosts-row.tsx` | Rewrite static/slow |
| `website/components/home/reveal.tsx` | Retune only |
| `website/app/[lang]/layout.tsx` | Metadata titles if needed; keep RootProvider fix |
| `website/app/layout.tsx` | Keep passthrough |

### 10.4 Out of scope for agents unless asked

- Open Graph image redesign (recommended follow-up)  
- Marketing site separate from fumadocs  
- Real GIF recording of live CLI  

---

## 11. Detailed copy deck (ready to paste)

### 11.1 English

```
eyebrow: taskflow 0.2
h1_1: Your host chat is not a dump for subagents.
h1_2: Only the answer belongs in your context.
sub: Declare multi-phase coding work as a verifiable DAG. Subagents run isolated. Intermediate transcripts never enter Claude, Codex, Pi, OpenCode, or Grok — only finalOutput returns.
cta_primary: Get started
cta_secondary: GitHub
collapse_caption: Only the final answer survives.
collapse_micro: Intermediate transcripts never enter the host.
hosts_label: Runs where you already think
proof_title: Prove it in one command.
proof_copy: Copy
consequences_title: What isolation makes possible.
era_title: 0.2 — the runtime became a system.
era_sub: Not a feature dump — the layer under your host is now complete enough to build on.
code_title: Same contract. Two surfaces.
code_caption: JSON for portability. TypeScript for authoring. One runtime.
compare_title: Ad-hoc multi-agent vs taskflow
compare_sub: Not CS theory — who owns your context.
cta_title: Stop paying context rent on intermediate transcripts.
cta_body: Declare the graph. Verify it. Get the answer — on the host you already use.
cta_docs: Read the docs
cta_examples: Examples
```

### 11.2 Chinese

```
eyebrow: taskflow 0.2
h1_1: 宿主对话不该是子代理的垃圾场。
h1_2: 只有答案该进入你的上下文。
sub: 把多阶段编程工作声明成可验证的 DAG。子代理隔离运行。中间 transcript 永不进入 Claude、Codex、Pi、OpenCode 或 Grok——只有 finalOutput 回来。
cta_primary: 开始使用
cta_secondary: GitHub
collapse_caption: 只有最终答案活下来。
collapse_micro: 中间 transcript 永不进入宿主。
hosts_label: 运行在你已经在用的宿主上
proof_title: 一条命令证明。
proof_copy: 复制
consequences_title: 隔离带来的能力。
era_title: 0.2 — 运行时成为系统。
era_sub: 不是功能清单——宿主之下的这一层，已经足够被认真构建。
code_title: 同一合同，两种写法。
code_caption: JSON 便于移植。TypeScript 便于编写。同一运行时。
compare_title: 临时多代理 vs taskflow
compare_sub: 不是计算机课——谁拥有你的上下文。
cta_title: 别再为中间 transcript 支付上下文租金。
cta_body: 声明图。先验证。拿答案——在你已经在用的宿主上。
cta_docs: 阅读文档
cta_examples: 示例
```

---

## 12. Acceptance checklist (ship gate)

### 12.1 Strategic

- [ ] Visitor can state pain + law in 15s  
- [ ] Collapse is the only cinematic event  
- [ ] No “What’s new in 0.2” changelog title  
- [ ] Testimonials omitted or real only  
- [ ] Install commands match current docs  

### 12.2 Visual

- [ ] Stage always dark; heat accent rare  
- [ ] No glass / mesh blobs / badge shimmer  
- [ ] Type weight cliff visible  
- [ ] Mobile 375px: no horizontal overflow; H1 readable  
- [ ] Desktop 1280/1440: stage not tiny illustration  

### 12.3 Motion

- [ ] Collapse plays once; Replay works  
- [ ] `prefers-reduced-motion`: static final  
- [ ] No infinite full-story loop  
- [ ] Console free of script-order errors  

### 12.4 Engineering

- [ ] `npm run build` in website/ passes  
- [ ] EN + ZH parity  
- [ ] JSON-LD async  
- [ ] RootProvider still inside `<body>`  

---

## 13. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Collapse looks gimmicky | Hard industrial erase; no rainbow; hold final frame |
| Pain copy feels aggressive | Pair with calm stage; no “you’re dumb” |
| Install commands drift | A5 reads README at implement time |
| Full-bleed breaks fumadocs nav | Test HomeLayout padding; adjust `.home-root` |
| Too much text in hero | Hard cap sub to 2 sentences |
| Dark stage in light mode contrast | Use fixed stage tokens, not `home-bg` |

---

## 14. Post-v3 follow-ups (explicitly later)

1. Open Graph / Twitter image matching Collapse final frame  
2. Optional scroll-scrub sticky stage (P1)  
3. Linked JSON↔graph highlight (P1)  
4. Homepage A/B on H1 L1 pain vs pure doctrine  
5. Real case study module with metrics  

---

## 15. Decision log (pre-implementation)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| North star | Foundry + Collapse | Product-true erasure myth |
| H1 strategy | Pain L1 + doctrine L2 | Impulse + premium |
| Demo P0 | Finite Collapse, not infinite DAG particles | Climax > ambient |
| Marquee | Demote | Motion without meaning |
| Changelog framing | Banned on homepage | Kills 高级感 |
| Fake quotes | Banned | Kills trust |
| Kernel/S5 claims | Honest, opt-in | claim-vs-impl |
| Multi-agent start | **Only after human GO on this plan** | User request |

---

## 16. GO criteria for multi-agent implementation

Implementation agents may start when user says e.g. **「按 v3 方案执行」** and optionally notes:

- H1 preference override (pain-first vs doctrine-first)  
- Whether P1 scroll-scrub is in or out (default **out**)  
- Whether to include a case/testimonial block (default **omit** if no real content)

---

*End of plan. Source of truth for homepage v3 until superseded.*
