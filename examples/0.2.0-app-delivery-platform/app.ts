/**
 * ⚠️ 愿景草图 —— 含 post-0.2.0 特性($derived/$store/read/write/flow.component)。见 ./README.md。
 *
 * taskflow 0.2.0 应用 —— 自主软件交付平台
 *
 * issue → 规划 → 实现 → 审查 → 安全审计 → 自愈 → 置信度决策 → 交付/转人工
 *
 * 这是整个应用的入口。展示 Solid 路线能写出的【最复杂】组合:
 *   - 动态路由(按 issue 复杂度走不同流水线)
 *   - 多 flow 互调(plan / implement / 子组件)
 *   - 全局响应式 store(dashboard)读写
 *   - 条件编排(when) + 分支
 *   - 置信度驱动的自动决策($derived 链)
 *   - 预算池管理 + 耗尽熔断
 *
 * 依赖图完全靠读取自动建立 —— 没有一个手写 dependsOn。
 * 改一个 issue 的字段,只有相关分支重算(overstory 增量)。
 */

import { flow, agent, gate, approval, parallel, script, $derived, $store, read, write, when, json } from "taskflow"; // $derived/$store/read/write = [post-0.2.0]
import planFlow from "./flows/plan.ts";             // [post-0.2.0] planFlow 内部用 $derived
import implementFlow from "./flows/implement.ts";    // [post-0.2.0] implementFlow 用 flow.component
import { reviewChanges } from "./components/review-changes.ts";  // [post-0.2.0] flow.component
import { securityAudit } from "./components/security-audit.ts"; // [post-0.2.0] flow.component
import { dashboard, remainingBudget } from "./stores/dashboard.ts"; // [post-0.2.0] $store/$derived
import { config } from "./config/app.ts";
import { needsSecurityReview, inferComplexity } from "./lib/utils.ts";
import type { Issue, DeliveryReport, DeliveryStatus } from "./types/domain.ts";

export default flow("deliver", ({ args, budget }) => {
  args.declare({ issue: { type: "object" as const } });
  budget(config.budget);                                         // 绑定全局预算池

  const issue = args.issue as Issue;

  // ── 注册到全局看板(写 store;后续派生自动更新) ─────────────────────
  write(dashboard.active, (m) => m.set(issue.id, issue));

  // ── 动态路由:按复杂度选流水线(像 Vue Router 的路由表) ─────────────
  const pipeline = $derived(() => config.routing[issue.complexity]);  // "fast-path" | "standard" | "rigorous"

  // ── 阶段1:规划(调子 flow) ────────────────────────────────────────
  const plan = when(() => pipeline.output !== "fast-path",
    () => planFlow({ issue }),
    () => agent(                                               // fast-path:跳过 tournament,直接简单实现
      `简单任务,直接做:${issue.title}\n${issue.body}`,
      { agent: "executor", output: json<any>() }
    )
  );

  // ── 阶段2:实现(调子 flow;依赖 plan) ─────────────────────────────
  const diff = when(() => pipeline.output !== "fast-path",
    () => implementFlow({ plan: plan.output, repo: issue.repo }),
    () => script(`cd ${issue.repo} && git diff`)              // fast-path 直接拿 diff
  );

  // ── 阶段3:代码审查(复用组件;读 diff + 改动文件) ──────────────────
  const changedFiles = $derived(() => plan.output.affectedFiles ?? []);
  const review = reviewChanges(diff, changedFiles);          // 多视角 + tournament + auto-gate

  // ── 阶段4:安全审计(仅高风险 issue;条件编排) ──────────────────────
  const mustAudit = $derived(() =>
    needsSecurityReview(issue.labels, [...config.securityGate.triggerLabels])
  );
  const security = when(() => mustAudit.output,
    () => securityAudit(diff, $derived(() => plan.output.riskAreas ?? [])),
    () => agent("no security review needed", { agent: "executor-fast", optional: true })
  );

  // ── 阶段5:置信度计算(派生链:review + security + 历史) ─────────────
  const confidence = $derived(() => {
    const base = read(historicalConfidence);                 // 先验(来自 store)
    const reviewPenalty = review.output.findings?.filter(f => f.severity === "blocker").length ?? 0;
    const secPenalty = security.output ? 0.3 : 0;            // 有安全问题重罚
    return Math.max(0, base - reviewPenalty * 0.2 - secPenalty);
  });

  // ── 阶段6:决策门(置信度 + 预算 驱动) ──────────────────────────────
  const decision = gate.automated(
    () => $derived(() => ({
      conf: confidence.output,
      budget: read(remainingBudget),                         // 读 store 派生
    })),
    {
      // eval 条件(零 token 机器门)
      pass:  "{conf >= 0.85 && budget > 0}",
      block: "{conf < 0.6 || budget <= 0}",
    }
  );

  // ── 阶段7:人工审批(仅中等置信度区间) ──────────────────────────────
  const humanApproval = when(
    () => confidence.output >= 0.6 && confidence.output < 0.85,
    () => approval({
      request: `置信度 ${(confidence.output * 100).toFixed(0)}%,在灰区。人工确认是否合并?`,
      input: diff.output,
      choices: ["approve", "reject", "edit"],
    }),
    () => agent("auto-decision, no approval needed", { agent: "executor-fast", optional: true })
  );

  // ── 阶段8:交付动作(合并 / 标记转人工) ─────────────────────────────
  const delivery = $derived((): DeliveryStatus => {
    if (read(remainingBudget) <= 0) return "blocked-budget";
    if (confidence.output < 0.6) return "needs-human";
    if (decision.output === "BLOCK") return "needs-human";
    return "delivered";
  });

  const prAction = when(() => delivery.output === "delivered",
    () => script(`cd ${issue.repo} && git checkout -b "fix/${issue.id}" && git add -A && git commit -m "${issue.title}" && gh pr create --fill`,
      { cwd: "dedicated" }),
    () => script(`echo "marked needs-human: ${issue.id}" > .taskflow/handoff/${issue.id}.md`,
      { cwd: "dedicated" })
  );

  // ── 阶段9:生成报告 + 写回看板(更新 store) ──────────────────────────
  const report = agent(
    `生成交付报告 JSON。Issue ${issue.id}, 状态 ${delivery.output}, ` +
    `置信度 ${confidence.output}, PR: ${prAction.output}。`,
    { agent: "doc-writer", output: json<DeliveryReport>(), final: true }
  );

  // 写回历史 store(后续 issue 的 historicalConfidence/hotspotFiles 自动更新)
  write(dashboard.history, (h) => [...h, report.output]);
  write(dashboard.active, (m) => { m.delete(issue.id); return m; });

  return report;
});
