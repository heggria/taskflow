# taskflow (Português)

> ⚠️ **Esta tradução está desatualizada.** Consulte o [README em inglês](../../README.md) para obter as informações mais recentes.

taskflow é um *grafo de tarefas* declarativo e verificável para agentes de codificação — funciona no [Pi](https://pi.dev), [OpenAI Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/product/claude-code), [OpenCode](https://opencode.ai) e [Grok Build](https://docs.x.ai/build/overview) — não um workflow que você escreve como script, mas um DAG que você declara e que o runtime verifica antes de gastar um único token. Zero dependências em tempo de execução, 872 testes, 9 tipos de fase.

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
grok plugin install <source> --trust
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [README em inglês](../../README.md) · [README em chinês](../../README.zh-CN.md)
