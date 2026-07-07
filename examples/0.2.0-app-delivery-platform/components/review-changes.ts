/**
 * 组件:多视角代码审查。
 *
 * 像 Solid 的一个可复用组件 —— 接受 props,内部有自己的响应式状态,
 * 可以被任意 flow 组合。内部用 tournament 让多个 agent 从不同角度审,
 * judge 汇总。
 *
 * 依赖靠读取自动建立:读 changes.output、read hotspotFiles 都建依赖。
 */

import { agent, parallel, tournament, gate, $derived, read } from "taskflow";
import { hotspotFiles } from "../stores/dashboard.ts";
import { severityWeight } from "../lib/utils.ts";
import type { ReviewFinding } from "../types/domain.ts";

export const reviewChanges = (changes: Phase<string>, files: Phase<string[]>) => {
  // 派生:重点文件清单 = 本次改动 ∩ 历史热点
  const focusFiles = $derived(() => {
    const changed = files.output;
    const hot = read(hotspotFiles);                 // ← 读全局 store,自动建依赖
    return changed.filter((f) => hot.includes(f));
  });

  // 多视角并行审查(3 个 agent 同时跑)
  const [correctness, security, architecture] = parallel([
    agent(
      `Review these changes for CORRECTNESS:\n${changes.output}\n\n` +
      `Pay extra attention to hotspots: ${focusFiles.output.join(", ")}`,
      { agent: "reviewer", concurrency: 6 }
    ),
    agent(`Review for SECURITY issues:\n${changes.output}`, { agent: "security-reviewer" }),
    agent(`Review for ARCHITECTURE/SOLID violations:\n${changes.output}`, { agent: "risk-reviewer" }),
  ]);

  // tournament:三个视角的发现交给 judge 去重 + 排序 + 选最严重
  const ranked = tournament({
    mode: "aggregate",                               // 聚合而非选一(研究合成用 aggregate)
    judgeAgent: "final-arbiter",
    judge:
      `Merge the three reviewers' findings. Dedup overlaps. ` +
      `Rank by severity. Output JSON array of findings.`,
    branches: [correctness, security, architecture],
  });

  // 自动 gate:有 blocker 就 BLOCK(零 LLM,纯 eval 机器门)
  const verdict = gate.automated(
    () => ranked,                                    // 输入
    { block: "{findings.any(f => f.severity === 'blocker')}" }  // ← eval 条件,零 token
  );

  return verdict;
};
