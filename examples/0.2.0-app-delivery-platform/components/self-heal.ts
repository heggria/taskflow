/**
 * 组件:测试驱动的自愈循环。
 *
 * 实现 → 测试 → 失败就修复,直到通过或收敛或达上限。
 * 这是个独立可复用的"自愈"组件,被多个 flow 引用。
 *
 * 展示:loop 内部引用 prev(上一轮)、收敛检测、条件 phase(when)。
 */

import { agent, script, loop, $derived, type Phase } from "taskflow";

export const selfHeal = (opts: {
  implement: Phase<string>;       // 初始实现 phase
  testCmd: string;                // 测试命令
  repo: string;
  maxIterations?: number;
}) => {
  const cap = opts.maxIterations ?? 4;

  return loop({
    until: "{steps.test.exit === 0}",
    maxIterations: cap,
    convergence: "{steps.test.output hash unchanged}",  // 连续两轮错误一样 → 停(避免空转)
    initial: opts.implement,
    body: (prev) => ({
      test: script(opts.testCmd, { cwd: "dedicated" }),
      fix: agent(
        `测试失败了。修复它。\n\n命令: ${opts.testCmd}\n` +
        `仓库: ${opts.repo}\n上一轮输出:\n${prev.test?.output ?? prev.output}\n\n` +
        `只改让测试通过的必要代码。不要重构。`,
        {
          agent: "executor-code",
          cwd: "worktree",                          // 每轮在独立 worktree 改,互不污染
          when: "{steps.test.exit !== 0}",          // 测试过了就不 fix
        }
      ),
    }),
  });
};
