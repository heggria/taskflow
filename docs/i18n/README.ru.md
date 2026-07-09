# taskflow (Русский)

> ⚠️ **Этот перевод устарел.** Пожалуйста, обратитесь к [английскому README](../../README.md) за актуальной информацией.

taskflow — это декларативный и проверяемый *граф задач* для агентов кодирования — работает в [Pi](https://pi.dev), [OpenAI Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/product/claude-code), [OpenCode](https://opencode.ai) и [Grok Build](https://docs.x.ai/build/overview) — не workflow, который вы пишете как скрипт, а DAG, который вы объявляете и который runtime проверяет до того, как потратить хотя бы один токен. Нулевые зависимости времени выполнения, 872 теста, 9 типов фаз.

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
grok plugin install <source> --trust
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [README на английском](../../README.md) · [README на китайском](../../README.zh-CN.md)
