/**
 * 应用配置 —— 声明式、可 diff、版本化。
 * 就像 Vue 应用的配置文件,但这里是 agent 编排策略。
 */

export const config = {
  /** 全局预算池(所有 flow 共享,实时扣减)。 */
  budget: { maxUSD: 100, maxTokens: 5_000_000 },

  /** 不同复杂度的 issue 走不同流水线(动态路由)。 */
  routing: {
    trivial:  "fast-path",     // 直接实现,跳过 tournament
    moderate: "standard",      // 规划→实现→审查
    complex:  "rigorous",      // + tournament 选策略 + 多轮自愈 + 安全审查
    unknown:  "rigorous",      // 未知当复杂处理
  } as const,

  /** 并发与限流。 */
  concurrency: {
    fileReview: 6,             // 同时审查 6 个文件
    migrationBatch: 4,
    gateParallelism: 3,        // gate 的多视角并发
  },

  /** 自愈上限(防止无限循环)。 */
  selfHeal: {
    maxIterations: 4,
    convergenceCheck: true,    // 连续两轮无变化则停
  },

  /** 安全门:这些标签的 issue 必须过 security-reviewer。 */
  securityGate: {
    triggerLabels: ["security", "auth", "crypto", "payment"],
    requireReviewer: "security-reviewer",
  },

  /** 置信度阈值:低于此值不自动合并,转人工。 */
  confidence: {
    autoMergeThreshold: 0.85,
    humanReviewThreshold: 0.6,   // 低于此值直接 needs-human
  },
} as const;
