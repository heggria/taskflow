# taskflow (Português)

> ⚠️ **Esta tradução está desatualizada.** Consulte o [README em inglês](../../README.md) para obter as informações mais recentes.

taskflow é um *grafo de tarefas* declarativo e verificável para Pi, Codex, Claude Code, OpenCode e Grok Build. Linha 0.2.2: Node.js ≥ 22.19.0, 12 tipos de fase e mais de 1500 testes. A camada MCP não depende de um SDK MCP; core usa `typebox` como peer e o DSL depende de TypeScript.

> **Por que "taskflow" e não "workflow"?** Um *workflow* (estilo code-mode) é um script imperativo que *flui*, com o grafo escondido no controle de fluxo. Um *taskflow* move o plano para um grafo declarativo de nós de tarefa discretos — que pode ser verificado estaticamente, visualizado, retomado e salvo como um comando. Trocamos expressividade por verificabilidade, de propósito.

```bash
# Pi
pi install npm:pi-taskflow

# Codex
codex plugin marketplace add heggria/taskflow
codex plugin add taskflow@taskflow

# Claude Code
claude plugin marketplace add heggria/taskflow
claude plugin install claude-taskflow@taskflow

# OpenCode
opencode mcp add taskflow -- npx -y -p opencode-taskflow opencode-taskflow-mcp

# Grok Build (from monorepo checkout pre-publish, or published source)
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.2 grok-taskflow-mcp
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [README em inglês](../../README.md) · [README em chinês](../../README.zh-CN.md)
