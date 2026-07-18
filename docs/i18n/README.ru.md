# taskflow (Русский)

> ⚠️ **Этот перевод устарел.** Пожалуйста, обратитесь к [английскому README](../../README.md) за актуальной информацией.

taskflow — декларативный и проверяемый граф задач для Pi, Codex, Claude Code, OpenCode и Grok Build. Линия 0.2.3: Node.js ≥ 22.19.0, 12 типов фаз и более 1500 тестов. Слой MCP не зависит от MCP SDK; core использует peer `typebox`, а DSL зависит от TypeScript.

> **Почему "taskflow", а не "workflow"?** *Workflow* (в стиле code-mode) — это императивный скрипт, который *течёт*, а его граф спрятан в потоке управления. *Taskflow* переносит план в декларативный граф из дискретных узлов-задач — его можно статически проверить, визуализировать, возобновить и сохранить как команду. Мы осознанно меняем выразительность на проверяемость.

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
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.3 grok-taskflow-mcp
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [README на английском](../../README.md) · [README на китайском](../../README.zh-CN.md)
