# pi-taskflow (Português)

> ⚠️ **Esta tradução está desatualizada.** Consulte o [README em inglês](../../README.md) para obter as informações mais recentes.

pi-taskflow é um *grafo de tarefas* declarativo e verificável para o [Pi coding agent](https://pi.dev) — não um workflow que você escreve como script, mas um DAG que você declara e que o runtime verifica antes de gastar um único token. Zero dependências em tempo de execução, 535 testes, 9 tipos de fase.

> **Por que "taskflow" e não "workflow"?** Um *workflow* (estilo code-mode) é um script imperativo que *flui*, com o grafo escondido no controle de fluxo. Um *taskflow* move o plano para um grafo declarativo de nós de tarefa discretos — que pode ser verificado estaticamente, visualizado, retomado e salvo como um comando. Trocamos expressividade por verificabilidade, de propósito.

```bash
pi install npm:pi-taskflow
```

[GitHub](https://github.com/heggria/pi-taskflow) · [README em inglês](../../README.md) · [README em chinês](../../README.zh-CN.md)
