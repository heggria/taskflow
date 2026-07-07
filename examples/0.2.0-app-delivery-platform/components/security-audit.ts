/**
 * 组件:深度安全审计(高风险改动专用)。
 *
 * 并行 3 个安全角度 + 对抗式验证(critic 专门挑刺)。
 * 展示:parallel + tournament(best 模式,对抗)。
 */

import { agent, parallel, tournament, gate } from "taskflow";

export const securityAudit = (diff: Phase<string>, riskAreas: Phase<string[]>) => {
  const [authn, authz, crypto] = parallel([
    agent(`审查认证(authentication)改动:\n${diff.output}\n风险区: ${riskAreas.output}`, { agent: "security-reviewer" }),
    agent(`审查授权(authorization)改动:\n${diff.output}`, { agent: "security-reviewer" }),
    agent(`审查加密/密钥改动:\n${diff.output}`, { agent: "security-reviewer" }),
  ]);

  // 对抗式:critic 专门攻击其他三个的结论
  const adversarial = tournament({
    mode: "best",
    judgeAgent: "final-arbiter",
    judge: "哪个审查发现了真实的安全漏洞?Quote evidence。WINNER: <n>。误报排除。",
    branches: [authn, authz, crypto],
  });

  return gate(adversarial, {
    agent: "security-reviewer",
    onBlock: "halt",                                // 安全问题:halt,不自动修复
  });
};
