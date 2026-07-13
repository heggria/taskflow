/**
 * taskflow 0.2.0 — DSL 复杂度演示(愿景上限)
 *
 * ⚠️ POST-0.2.0 特性警告 ──────────────────────────────────────────
 * 这个 demo 故意展示了 0.2.0 的【完整愿景上限】,其中部分特性在
 * `docs/rfc-0.2.0-dsl-syntax.md` §7 明确标为 **post-0.2.0**(依赖全局
 * 响应式运行时 / Shared Context Tree,首版不含):
 *   - `$derived` / `$state`      全局响应式派生状态
 *   - `read()` / `write()`       读写全局响应式 store
 *   - `flow.component(...)`      带 props 的可复用子 flow
 * 这些行在文件内用 `// [post-0.2.0]` 标注。0.2.0 首版能跑的是其余部分
 * (agent/map/gate/reduce/loop/tournament/approval/script + 编译期类型)。
 * 不要把这个文件当作 0.2.0 首版的可运行样例 —— 它是愿景草图。
 * ────────────────────────────────────────────────────────────────
 *
 * 场景:大型 monorepo 的"智能迁移 + 安全审计 + 自愈"系统。
 * 把 styled-components 全量迁移到 Tailwind,同时跑安全审计,
 * 失败自动修复,最后 tournament 选最优策略汇总。
 *
 * 这个 demo 展示 DSL 能写出的工程级复杂度:
 *   - 响应式组合(flow 片段像组件一样组合)
 *   - 自动依赖追踪(编译期收集 .output 引用,不用手写 dependsOn)
 *   - 派生状态($derived [post-0.2.0],中间指标自动计算)
 *   - 细粒度更新(overstory:改一个文件只重算相关分支)
 *   - 跨文件复用(components/ 里是可复用的 flow 组件 [post-0.2.0])
 *   - 多层 map 嵌套 + gate 链 + tournament + loop 自愈 + 动态子流程
 *
 * 对照:这个逻辑用现在的 JSON DSL 写大约要 300+ 行嵌套 + 字符串模板,
 * 且依赖要手写、没有类型、改一个输入全量重跑。
 */

import { flow, agent, map, parallel, gate, reduce, tournament, loop, approval, script } from "taskflow";
import { $derived, $state, json, read, type Phase } from "taskflow"; // [post-0.2.0] $derived/$state/read 需全局响应式运行时
import { migrateOneFile } from "./components/migrate-one.ts";          // [post-0.2.0] migrateOneFile 是 flow.component
import { auditOneFile } from "./components/audit-one.ts";             // [post-0.2.0] auditOneFile 是 flow.component

// ============================================================================
// 主 flow —— 像写一个 Solid App:组合多个"组件"(子 flow)
// ============================================================================
export default flow("smart-migration", ({ args, budget }) => {
  args.declare({ repo: { type: "string", default: "." }, dryRun: { type: "boolean", default: false } });
  budget({ maxUSD: 50, maxTokens: 2_000_000 });

  // ── 阶段 1:并行侦察(两个独立 agent,自动并发) ──────────────────────
  const [files, securityBaseline] = parallel([
    agent("List every .tsx using styled-components under {args.repo}. Output JSON array of file paths.", {
      agent: "scout", output: json<string[]>(), retry: { max: 2 },
    }),
    agent("Establish security baseline: list all current auth middleware.", { agent: "scout" }),
  ]);
  // ↑ files 和 securityBaseline 自动并发;且它们之间无依赖边。

  // ── 阶段 2:派生指标(像 Solid 的 const doubled = createMemo) ─────────
  const plan = $derived(() => ({          // [post-0.2.0] 全局响应式派生
    total: files.output.length,
    batches: chunk(files.output, 8),         // 分批,每批 8 个文件
    riskProfile: securityBaseline.output.includes("no-auth") ? "high" : "normal",
  }));
  // ↑ $derived 是派生计算 —— 它依赖 files 和 securityBaseline;
  //   files 变了它会自动重算;这就是 overstory 的响应式,也是 Solid 的 createMemo。

  // ── 阶段 3:动态规划(tournament 选最佳迁移策略) ─────────────────────
  const strategy = tournament({
    mode: "best",
    judgeAgent: "final-arbiter",
    judge: `Judge on: ${plan.output.riskProfile} risk repo. correctness vs blast radius. WINNER: <n>.`,
    branches: [
      agent("Strategy A: codemod-first, manual review. Lowest blast radius.", { agent: "analyst" }),
      agent("Strategy B: AI-rewrite each file fresh. Highest correctness.", { agent: "analyst" }),
      agent("Strategy C: hybrid — codemod then AI-fix residuals.", { agent: "critic" }),
    ],
  });
  // ↑ tournament 的 judge 读了 plan.output —— 自动依赖 plan → files → securityBaseline。

  // ── 阶段 4:分批迁移 + 每文件自愈(map 嵌套复用组件) ──────────────────
  const migrations = map(plan.output.batches, (batch, batchIdx) =>
    flow.component(migrateOneFile, {            // [post-0.2.0] 可复用子 flow ← 复用 components/migrate-one.ts
      file: batch,
      strategy: strategy.output,
      dryRun: args.dryRun,
    })({
      // migrateOneFile 内部是 "migrate → test → fix loop" (见下方组件定义)
      // 这里 map 自动让每个 batch 并发,batch 内部串行
    })
  );

  // ── 阶段 5:并行安全审计(复用另一个组件) ───────────────────────────
  const audits = map(files.output, (f) =>
    flow.component(auditOneFile, { file: f, baseline: securityBaseline.output })  // [post-0.2.0]
  );

  // ── 阶段 6:交叉验证 gate(不同 agent 复核迁移 + 审计) ────────────────
  const verified = gate(
    parallel([migrations, audits]),
    { agent: "reviewer", onBlock: "retry" },
    (both) => agent(
      `Cross-check: did any migration introduce a security regression vs the audit?\n` +
      `Migrations:\n${both.a.output}\n\nAudits:\n${both.b.output}\n\n` +
      `VERDICT: BLOCK if any regression, else PASS.`
    )
  );

  // ── 阶段 7:全局自愈 loop(整体不过就重新规划) ───────────────────────
  const healed = loop({
    until: "{steps.verifyCheck.exit === 0}",
    maxIterations: 3,
    body: (prev) => ({
      verifyCheck: script(
        `cd {args.repo} && npx tsc --noEmit && npx vitest run`,
        { cwd: "dedicated" }
      ),
      replan: agent(                            // ← loop 里引用 prev,自动建依赖
        `Previous round failed verification:\n${prev.verifyCheck.output}\n\n` +
        `Replan the remaining migrations. Strategy was: ${strategy.output}`,
        { agent: "planner", when: "{steps.verifyCheck.exit !== 0}" }
      ),
    }),
  })(verified);                                 // ← loop 依赖 verified,自动建边

  // ── 阶段 8:人工审批(高风险仓库才触发) ─────────────────────────────
  const approved = approval({
    when: () => plan.output.riskProfile === "high",   // ← 条件 gate,TS 函数谓词
    request: "This is a HIGH-risk repo. Approve final merge?",
    input: healed.output,
    choices: ["approve", "reject", "edit"],
  });

  // ── 阶段 9:最终汇总(派生 + reduce) ────────────────────────────────
  const report = reduce([healed, audits, strategy], (parts) =>
    agent(
      `Write an executive migration report.\n` +
      `Files migrated: ${plan.output.total}\n` +
      `Strategy chosen: ${parts.strategy.output}\n` +
      `Security findings: ${parts.audits.output}\n` +
      `Final state: ${parts.healed.output}`,
      { agent: "doc-writer", final: true }
    )
  );

  return report;
});

// ============================================================================
// 组件 1:迁移单个文件(内含 migrate→test→fix 自愈循环)
// 文件:components/migrate-one.ts —— 像 Solid 的一个可复用组件
// ============================================================================
export const migrateOneFile = flow.component(   // [post-0.2.0] 可复用子 flow
  "migrate-one",
  ({ props }: { props: { file: string; strategy: string; dryRun: boolean } }) => {

    const migrated = agent(
      `Migrate ${props.file} from styled-components to Tailwind.\n` +
      `Use strategy: ${props.strategy}\n` +
      `Dry-run: ${props.dryRun}`,
      { agent: "executor-code", cwd: "worktree" }   // ← 每文件独立 git worktree,互不干扰
    );

    // 组件内的自愈循环:test 不过就 fix,最多 3 轮
    const healed = loop({
      until: "{steps.test.exit === 0}",
      maxIterations: 3,
      convergence: "{steps.test.output hash unchanged}",   // 连续两轮错误一样就停(收敛)
      body: (prev) => ({
        test: script(`cd {props.file} && npx vitest run`, { cwd: "dedicated" }),
        fix: agent(
          `Tests failed for ${props.file}:\n${prev.test.output}\nFix the migration.`,
          { agent: "executor", when: "{steps.test.exit !== 0}" }
        ),
      }),
    })(migrated);

    return healed;
  }
);

// ============================================================================
// 组件 2:审计单个文件(并行跑 3 个角度 + reduce)
// 文件:components/audit-one.ts
// ============================================================================
export const auditOneFile = flow.component(    // [post-0.2.0] 可复用子 flow
  "audit-one",
  ({ props }: { props: { file: string; baseline: string } }) => {

    // 三视角并行审计(像 Solid 里一个组件内开多个 createSignal)
    const [auth, injection, regression] = parallel([
      agent(`Audit ${props.file} for auth regressions vs baseline:\n${props.baseline}`, { agent: "risk-reviewer" }),
      agent(`Audit ${props.file} for injection risks introduced by migration.`, { agent: "security-reviewer" }),
      agent(`Audit ${props.file} for behavioral regressions.`, { agent: "reviewer" }),
    ]);

    // gate:任一视角 BLOCK 则整个审计 BLOCK (join: any)
    const verified = gate(
      parallel([auth, injection, regression], { join: "any" }),
      { agent: "final-arbiter" }
    );

    return verified;
  }
);

// ============================================================================
// 工具:分批(普通 TS 函数,编译期求值 —— Svelte 路线也能用)
// ============================================================================
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
