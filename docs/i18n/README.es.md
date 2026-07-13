# taskflow (Español)

> ⚠️ **Esta traducción está desactualizada.** Consulta el [README en inglés](../../README.md) para obtener la información más reciente.

taskflow es un *grafo de tareas* declarativo y verificable para agentes de codificación — funciona en Pi, Codex, Claude Code, OpenCode y Grok Build. Línea 0.2.0: Node.js ≥ 22.19.0, 12 tipos de fase y más de 1500 pruebas. La capa MCP no depende de un SDK MCP; core usa `typebox` como peer y el DSL depende de TypeScript.

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
grok mcp add taskflow -- npx -y -p grok-taskflow@0.2.0 grok-taskflow-mcp
# or: grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp
```

[GitHub](https://github.com/heggria/taskflow) · [README en inglés](../../README.md) · [README en chino](../../README.zh-CN.md)
