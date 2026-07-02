# Adversarial Review — commit 2ce4557 (peek + timeout + expect) — 2026-07-02

> 流程：4 路攻击面 reviewer 并行（security / concurrency-lifecycle /
> validator-correctness / API-DX）→ critic 交叉质证（杀误报、并重复、调整严重度）
> → verdict。Run id: `adversarial-review-r1r2-mr391xmf-068617`（verdict phase
> 因 idle timeout 失败，cross-examine 输出已含完整结论；结果经人工确认）。
>
> 注：本次 review 本身 dogfood 了刚实现的 peek —— 用 `peekRun()` 直接取回了
> cross-examine 的中间输出。

## 总体裁决：SHIP-WITH-FIXES（全部修复已落地，commit 见 git log）

Security 全绿：path traversal、injection、ReDoS、prototype pollution、
AbortController 资源泄漏均验证无问题。runtime 接线（listener 清理、usage
记账、cache key、resume 语义）逐路径确认正确。

## 已确认并修复

| # | Sev | 位置 | 问题 | 修复 |
|---|-----|------|------|------|
| F2 | MED | peek.ts splitItems | budget-skipped item 无 section，按顺序索引会静默错位返回后续 item 的内容 | 按 `### [k/N]` 标签的 k 键索引（Map<number,string>），缺失项报 "not found (budget-skipped)" + 可用索引 |
| F1 | MED | peek.ts splitItems | item 内容若嵌入分隔符+伪标签可导致误切 | first-label-wins 缓解真实 item 不被覆盖；完全无歧义需 mergePhaseState 换 collision-free 分隔符（追踪为 follow-up，未动 merge 格式） |
| F3 | LOW | contract.ts enum | JSON.stringify 比较对对象字面量 key 顺序敏感 | 换结构化 deepEqual |
| F5 | LOW | pi index.ts /tf peek | `--item abc` → NaN → "Item NaN out of range" | 正整数校验 + usage 提示 |
| F4 | LOW | runtime.ts tournament | all-variants-failed 返回路径漏 `timedOut` 标记 | 补 `timedOut: ran.some(r=>r.phaseTimeout)` |
| F6 | LOW | verify.ts contract pass | 漏扫 context/input/judge/with/run 中的 refs | sources 扩展 |
| F8 | LOW | MCP tool descriptions | run 与 peek 未互相引用 runId，LLM 不会串联 | 双向 cross-reference |
| F9 | LOW | SKILL.md | timeout 行未说明 per-call 语义（tournament judge 也各有 cap）及 script 300s 上限差异 | 已补 |
| F10 | LOW | MCP server.ts | executeTaskflow 若抛异常则终态 saveRun 不执行 | `.finally()` 包裹 |
| F7 | LOW | verify.ts REF regex | `{steps.x.json[0]}` 方括号形式不匹配 | 确认为文档问题：interpolate 本就不支持 `[k]`（只支持 `.k` 点式），SKILL.md 中错误的 `json[k]` 写法已改为 `json.k` |

## 被杀的误报（避免未来重复上报）

- **MaxListenersExceeded on fan-out**：listener 用 `{once:true}` + finally 清理，最多是 Node 的 cosmetic 警告，非泄漏。
- **timeout 后 contract check 被跳过**：设计如此——校验被 abort 的输出无意义。
- **timeout 与 usage 双计**：timedOut 分支 push 后 break，正常路径先 push 再判断，无双计（逐行核实）。
- **gate 的 onBlock:retry 总时长超预期**：per-call 语义已在文档明示，可推算，非 bug。
- **script 不受新 timeout 管**：有意为之，schema 验证 + 文档均明确。

## Follow-up（不阻塞）

- mergePhaseState 换 collision-free item 分隔符（彻底解决 F1），peek 同步适配。
