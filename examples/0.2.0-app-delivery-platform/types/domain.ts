/**
 * 类型定义 —— 整个应用共享的领域模型。
 * 像写 Solid/Vue 应用一样,类型是契约,编译期就能抓住错误。
 */

/** 一个待交付的工作单元(来自 GitHub issue / Linear / 飞书任务)。 */
export interface Issue {
  id: string;
  title: string;
  body: string;
  labels: string[];          // ["bug", "feature", "refactor", "security", ...]
  repo: string;              // "org/repo"
  author: string;
  complexity: "trivial" | "moderate" | "complex" | "unknown";
}

/** 规划阶段的产物:把 issue 拆成可执行的 steps。 */
export interface Plan {
  summary: string;
  approach: "surgical" | "rewrite" | "hybrid";
  steps: PlanStep[];
  affectedFiles: string[];
  riskAreas: string[];       // ["auth", "db-migration", ...]
  estimatedComplexity: number;  // 1-10
}

export interface PlanStep {
  id: string;
  description: string;
  files: string[];           // 这个 step 会动的文件
  kind: "implement" | "test" | "refactor" | "doc";
}

/** 代码审查的发现。 */
export interface ReviewFinding {
  severity: "blocker" | "high" | "medium" | "low" | "nit";
  category: "correctness" | "security" | "performance" | "style" | "architecture";
  file: string;
  line?: number;
  message: string;
  evidence: string;
}

/** 交付的最终状态。 */
export type DeliveryStatus =
  | "delivered"             // 合并到 main
  | "needs-human"           // 需要人工介入
  | "blocked-budget"        // 预算耗尽
  | "blocked-conflict"      // 合并冲突无法自愈
  | "rejected";             // 审查不通过且无法修复

/** 交付报告。 */
export interface DeliveryReport {
  issue: Issue;
  status: DeliveryStatus;
  plan: Plan;
  prUrl?: string;
  findings: ReviewFinding[];
  confidence: number;       // 0-1,综合置信度
  costUSD: number;
  iterations: number;       // 自愈循环跑了多少轮
  trace: string;            // 决策链(可追溯到 key@version)
}
