/**
 * 工具库 —— 普通 TS 函数(编译期求值,零运行时开销)。
 * 像 Solid/Vue 应用里的 utils。
 */

/** 把数组分成指定大小的批次。 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 根据标签推断复杂度。 */
export function inferComplexity(labels: string[]): "trivial" | "moderate" | "complex" {
  if (labels.includes("good-first-issue") || labels.includes("trivial")) return "trivial";
  if (labels.includes("refactor") || labels.includes("migration")) return "complex";
  return "moderate";
}

/** 是否需要安全审查。 */
export function needsSecurityReview(labels: string[], triggerLabels: string[]): boolean {
  return labels.some((l) => triggerLabels.includes(l));
}

/** 给审查发现算严重度权重(用于 reduce 聚合)。 */
export function severityWeight(s: "blocker" | "high" | "medium" | "low" | "nit"): number {
  return { blocker: 100, high: 40, medium: 10, low: 3, nit: 1 }[s];
}
