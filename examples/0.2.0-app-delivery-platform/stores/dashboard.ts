/**
 * 响应式 Store —— 全局共享状态(跨 flow / 跨 phase)。
 *
 * 这是 Solid 路线的精华:像 Solid 的 createRoot + createStore,
 * 但作用域是整个交付流水线。任何 flow 读它就自动建立依赖;
 * 它变了,只有读取方重算(overstory 增量重算)。
 *
 * 底层 = overstory 的 Shared Context Tree(ctx_read/ctx_write),
 * 0.2.0 把它包装成 Solid 风格的 $store rune。
 */

import { $store, $derived } from "taskflow";
import type { DeliveryReport, Issue } from "../types/domain.ts";

/** 全局交付看板:实时跟踪所有 issue 的进度。 */
export const dashboard = $store({
  /** 正在处理的 issue(按 id 索引)。 */
  active: new Map<string, Issue>(),

  /** 已完成的交付报告(累积,用于学习)。 */
  history: [] as DeliveryReport[],

  /** 累计成本(预算池实时扣减依据)。 */
  spentUSD: 0,
});

/** 派生:剩余预算。读 dashboard.spentUSD,它变了自动重算。 */
export const remainingBudget = $derived(() => dashboard.spentUSD < 100 ? 100 - dashboard.spentUSD : 0);

/** 派生:历史平均置信度(用于新 issue 的先验)。 */
export const historicalConfidence = $derived(() => {
  const h = dashboard.history;
  if (h.length === 0) return 0.5;                    // 无历史 → 中性先验
  return h.reduce((s, r) => s + r.confidence, 0) / h.length;
});

/** 派生:哪些文件最常出问题(用于指导审查资源分配)。 */
export const hotspotFiles = $derived(() => {
  const counts = new Map<string, number>();
  for (const r of dashboard.history)
    for (const f of r.findings) counts.set(f.file, (counts.get(f.file) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f]) => f);
});
