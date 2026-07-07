/**
 * Flow:需求理解 + 规划。
 *
 * 读 issue → 拆解 → tournament 选最优方案 → 输出 Plan。
 * 被主流水线调用(也可单独 /tf:plan <issue> 跑)。
 *
 * 展示:读全局 store(historicalConfidence)指导规划,
 * tournament 多角度起草方案,tournament 自动依赖 issue。
 */

import { flow, agent, tournament, $derived, read, json } from "taskflow";
import { historicalConfidence } from "../stores/dashboard.ts";
import type { Issue, Plan } from "../types/domain.ts";

export default flow("plan", ({ args }) => {
  args.declare({ issue: { type: "object" as const } });          // 传入 Issue
  const issue = args.issue as Issue;

  // 派生:用历史置信度调整规划激进程度
  const aggressiveness = $derived(() => {
    const conf = read(historicalConfidence);                     // ← 读全局 store
    return conf > 0.8 ? "ambitious" : "conservative";            // 历史表现好就敢激进
  });

  // 三种规划思路并行起草
  const strategy = tournament({
    mode: "best",
    judgeAgent: "plan-arbiter",
    judge:
      `选最优实现方案。考虑复杂度 ${issue.complexity}、` +
      `历史置信度 ${read(historicalConfidence).toFixed(2)}、` +
      `激进程度 ${aggressiveness.output}。Output JSON Plan。WINNER: <n>。`,
    branches: [
      agent(
        `方案A - 外科手术式:最小改动,精准修复。\nIssue: ${issue.title}\n${issue.body}`,
        { agent: "analyst", output: json<Plan>() }
      ),
      agent(
        `方案B - 重构式:借机优化结构。\nIssue: ${issue.title}\n${issue.body}`,
        { agent: "analyst", output: json<Plan>() }
      ),
      agent(
        `方案C - 对抗式:先找每个方案的破绽,再提幸存的。\nIssue: ${issue.title}\n${issue.body}`,
        { agent: "critic", output: json<Plan>() }
      ),
    ],
  });

  return strategy;        // Phase<Plan>
});
