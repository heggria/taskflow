# pi-taskflow (Español)

> ⚠️ **Esta traducción está desactualizada.** Consulta el [README en inglés](../../README.md) para obtener la información más reciente.

pi-taskflow es un *grafo de tareas* declarativo y verificable para [Pi coding agent](https://pi.dev): no un workflow que escribes como script, sino un DAG que declaras y que el runtime verifica antes de gastar un solo token. Cero dependencias en tiempo de ejecución, 535 pruebas, 9 tipos de fase.

> **¿Por qué "taskflow" y no "workflow"?** Un *workflow* (estilo code-mode) es un script imperativo que *fluye*, con el grafo oculto en el control de flujo. Un *taskflow* mueve el plan a un grafo declarativo de nodos de tarea discretos — que se puede verificar estáticamente, visualizar, reanudar y guardar como un comando. Cambiamos expresividad por verificabilidad, a propósito.

```bash
pi install npm:pi-taskflow
```

[GitHub](https://github.com/heggria/pi-taskflow) · [README en inglés](../../README.md) · [README en chino](../../README.zh-CN.md)
