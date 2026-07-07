/**
 * ⚠️ 愿景草图 —— 含 post-0.2.0 特性(flow.component/selfHeal)。见 ../README.md。
 *
 * Flow:实现 + 自愈。
 *
 * 拿 Plan → 按 step 实现 → 每个 step 跑测试自愈 → 输出 diff。
 * 被主流水线调用。
 *
 * 展示:map 遍历 plan.steps,每个 step 复用 selfHeal 组件,
 * reduce 汇总所有 step 的 diff。
 */

import { flow, agent, map, reduce, script, $derived } from "taskflow";
import { selfHeal } from "../components/self-heal.ts";
import { chunk } from "../lib/utils.ts";
import type { Plan } from "../types/domain.ts";

export default flow("implement", ({ args }) => {
  args.declare({ plan: { type: "object" as const }, repo: { type: "string" } });
  const plan = args.plan as Plan;

  // 分批实现(避免一次改太多文件冲突)
  const batches = $derived(() => chunk(plan.steps, 3));

  // 每个 step:实现 → 自愈。map 自动并发(批次内并发,受 concurrency 约束)
  const stepResults = map(batches.output, (batch) =>
    map(batch, (step) => {
      const implemented = agent(
        `实现这个 step:\n${step.description}\n要改的文件: ${step.files.join(", ")}`,
        { agent: "executor-code", cwd: "worktree" }              // 每 step 独立 worktree
      );
      return selfHeal({
        implement: implemented,
        testCmd: `cd ${args.repo} && npx vitest run ${step.files.join(" ")}`,
        repo: args.repo,
      });
    })
  );

  // 汇总所有 step 的 diff
  const combinedDiff = reduce([stepResults], (parts) =>
    script(`cd ${args.repo} && git diff`, { cwd: "dedicated" })  // 零 token,拿最终 diff
  );

  return combinedDiff;     // Phase<string>(完整 diff)
});
