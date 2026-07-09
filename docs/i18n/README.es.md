# taskflow (Español)

> ⚠️ **Esta traducción está desactualizada.** Consulta el [README en inglés](../../README.md) para obtener la información más reciente.

taskflow es un *grafo de tareas* declarativo y verificable para agentes de codificación — funciona en [Pi](https://pi.dev), [OpenAI Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/product/claude-code), [OpenCode](https://opencode.ai) y [Grok Build](https://docs.x.ai/build/overview): no un workflow que escribes como script, sino un DAG que declaras y que el runtime verifica antes de gastar un solo token. Cero dependencias en tiempo de ejecución, 872 pruebas, 9 tipos de fase.

> **¿Por qué "taskflow" y no "workflow"?** Un *workflow* (estilo code-mode) es un script imperativo que *fluye*, con el grafo oculto en el control de flujo. Un *taskflow* mueve el plan a un grafo declarativo de nodos de tarea discretos — que se puede verificar estáticamente, visualizar, reanudar y guardar como un comando. Cambiamos expresividad por verificabilidad, a propósito.

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

[GitHub](https://github.com/heggria/taskflow) · [README en inglés](../../README.md) · [README en chino](../../README.zh-CN.md)
