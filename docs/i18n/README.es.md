<div align="center">

<img src="./assets/hero.png" alt="pi-taskflow — declarative DAG orchestration for Pi subagents: stateful, resumable, context-isolated" width="900">

<p>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/v/pi-taskflow?style=flat-square&color=B692FF&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-taskflow"><img src="https://img.shields.io/npm/dm/pi-taskflow?style=flat-square&color=6E8BFF&label=downloads" alt="npm downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-43D9AD?style=flat-square" alt="MIT license"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/runtime%20deps-0-43D9AD?style=flat-square" alt="zero runtime dependencies"></a>
  <a href="https://github.com/heggria/pi-taskflow/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heggria/pi-taskflow/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/tests-394-6E8BFF?style=flat-square" alt="394 tests"></a>
  <a href="#whats-inside"><img src="https://img.shields.io/badge/dogfooded-%E2%9C%93-43D9AD?style=flat-square" alt="dogfooded"></a>
  <a href="https://pi.dev"><img src="https://img.shields.io/badge/for-Pi%20coding%20agent-B692FF?style=flat-square" alt="for the Pi coding agent"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.hi.md">हिन्दी</a> ·
  <b><a href="./README.es.md">Español</a></b> ·
  <a href="./README.ar.md">العربية</a>
</p>

<p><strong>Orquestación declarativa de DAG para <a href="https://pi.dev">Pi</a> subagentes.</strong><br/>
Fan out · gate · resume · guardar como comando — los resultados intermedios no sobrecargan tu contexto.</p>

```bash
pi install npm:pi-taskflow
```

</div>

---

**Los subagentes se lanzan y olvidan. Los taskflows lanzan, expanden, pausan, gatean, reanudan y se guardan a sí mismos como un comando.**

Ya conoces la herramienta de subagente integrada con su `task` / `tasks` / `chain`. `pi-taskflow` habla la *misma* abreviatura — así que tus delegaciones existentes se convierten instantáneamente en procesos **trackeables, reanudables y guardables como un comando de una palabra `/tf:<name>`**. Cuando superes la abreviatura, el DSL completo te ofrece un DAG real: fan-out (expansión) dinámico sobre docenas de elementos, enrutamiento condicional, compuertas de calidad, aprobaciones humanas, reintentos y un límite de gasto duro.

Y durante todo el tiempo, **solo la fase final llega a tu conversación.** Cada transcripción intermedia permanece en el runtime, nunca en tu ventana de contexto.

## Por qué existe esto

Esta es la pared contra la que chocas con subagentes brutos: describes un plan multi-paso en prosa, el modelo lo re-deriva cada vez, las transcripciones intermedias inundan tu contexto, y en cuanto falla una llamada de modelo empiezas de cero. No hay reutilización, ni recuperación, ni estructura.

`pi-taskflow` mueve el plan **fuera del prompt y dentro de una definición declarativa.** El runtime es dueño del DAG, los bucles, los reintentos y el estado intermedio. Declaras un pipeline una vez y lo ejecutas cien veces — por su nombre.

<div align="center">
<img src="./assets/context-isolation.png" alt="With raw subagents every transcript floods your context; with pi-taskflow transcripts stay in the runtime and only the final result returns" width="900">
</div>

> Cuando un trabajo necesita doce pasos con ramificación en abanico y una compuerta de revisión, necesitas orquestación — no un prompt con suerte.

| | subagent (integrado) | **pi-taskflow** |
|---|---|---|
| **Quién conduce** | el modelo, turno a turno | el runtime, desde una definición |
| **Topología** | cadena / paralelo plano | **DAG con concurrencia por capas + enrutamiento** |
| **Resultados intermedios** | en tu ventana de contexto | **en el runtime — no en tu contexto** |
| **Escala** | un puñado de tareas | **fan-out `map` dinámico sobre docenas de elementos** |
| **Reutilizable** | re-descrito cada vez | **guardado como `/tf:<name>`** |
| **Reanudable** | ✗ | **✓ entre sesiones — fases cacheadas se saltan automáticamente** |
| **Compuertas de calidad** | ✗ | **fases `gate` que se detienen en `VERDICT: BLOCK`** |
| **Enrutamiento condicional** | ✗ | **guardas `when` + uniones `join: any` (OR-join)** |
| **Tolerancia a fallos** | ✗ | **`retry` por fase + re-intento automático en errores transitorios** |
| **Humano en el circuito** | ✗ | **fases `approval` (aprobar / rechazar / editar)** |
| **Control de costos** | ✗ | **`budget` para toda la ejecución (límites en USD / tokens)** |
| **Composición** | ✗ | **fases `flow` ejecutan sub-flujos guardados** |
| **Progreso en vivo** | opaco mientras se ejecuta | **renderizado en vivo del DAG con tiempos + costo** |
| **Ergonomía** | JSON inline cada vez | **abreviatura (`task`/`tasks`/`chain`) *o* DSL** |

No reemplaza la herramienta de subagente. Le da a tus subagentes un DAG, una memoria y un nombre.

## Comparado con otras extensiones de Pi

El ecosistema de Pi tiene ahora **más de 20 extensiones de delegación, flujo de trabajo y orquestación** — cada una excelente para lo que fue creada. Aquí hay un mapa honesto de dónde se sitúa `pi-taskflow` (verificado contra la última versión npm de cada paquete, junio de 2026). Para el desglose completo — cada paquete, fortalezas *y* debilidades — consulta [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md). Para el panorama más amplio, no-Pi (LangGraph, Temporal, CrewAI, Mastra…) consulta [`COMPETITORS.md`](./COMPETITORS.md).

| Extensión | Modelo | DSL propio | DAG | Fan-out dinámico | Reanudación entre sesiones | Compuerta de calidad | Aprobación humana | Guardar como comando | Cero deps |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **pi-taskflow** | **taskflows multi-fase declarativos** | **✓** | **✓** | **✓ `map`** | **✓ hash-de-fase** | **✓** | **✓** | **✓ `/tf:<name>`** | **✓** |
| [`@pi-agents/orchid`](https://www.npmjs.com/package/@pi-agents/orchid) | pipeline opinado de 9 fases + bucle Ralph | fijo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ (2) |
| [`pi-crew`](https://www.npmjs.com/package/pi-crew) | equipos por roles + git worktrees + async | parcial | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✕ (7) |
| [`ultimate-pi`](https://www.npmjs.com/package/ultimate-pi) | arnés gobernado plan→ejecutar→revisar | contratos YAML | ✓ (plan-time) | ✕ | ✓ | ✓ (3 niveles) | ✓ | ✓ | ✕ (16) |
| [`@zhushanwen/pi-workflow`](https://www.npmjs.com/package/@zhushanwen/pi-workflow) | scripts JS (`agent`/`parallel`/`pipeline`) | sí (JS) | ✕ (lineal) | ✓ | ✓ | ✕ | ✕ | ✓ (caché de llamada) | ✓ |
| [`@fiale-plus/pi-rogue-orchestration`](https://www.npmjs.com/package/@fiale-plus/pi-rogue-orchestration) | bucle de temporizador + resolución de objetivos | ✕ | ✕ | ✕ | ✓ | ✓ (verificación de objetivo) | ✕ | ✕ | ✓ |
| [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) | delegación simple / paralela / en cadena | ✕ | ✕ | estático | – | ✕ | aclarar | flujos nombrados | ✕ (3) |
| [`@gotgenes/pi-subagents`](https://www.npmjs.com/package/@gotgenes/pi-subagents) | subagentes estilo Claude-Code + worktrees | ✕ | ✕ | ✕ | ✓ (por id) | ✕ | por agente | ✕ | ✕ (1) |
| [`pi-pipeline`](https://www.npmjs.com/package/pi-pipeline) | pipeline fijo SPEC→PLAN→TASKS→VERIFY | ✕ | fijo | ✕ | planificación de sesión | ✓ | aclarar | ✕ | ✕ (2) |
| [`pi-agent-flow`](https://www.npmjs.com/package/pi-agent-flow) | `fork` paralelo de un solo disparo | sí | ✕ | ✕ | – | ✕ | ✕ | – | ✕ (2) |

*(Porción representativa de los 20+ — consulta [`PI-ECOSYSTEM.md`](./PI-ECOSYSTEM.md) para verlos todos, incluyendo `@0xkobold/pi-orchestration`, `@melihmucuk/pi-crew`, `@mediadatafusion/pi-workflow-suite`, `gentle-pi`, `@dreki-gg/pi-subagent`, y más.)*

**Cómo elegir:**

- **`@pi-agents/orchid`** es el orquestador más completo en funciones del ecosistema (DAG + worktrees + bucle Ralph + buzón de agente) — pero su DSL es un pipeline *fijo* de 9 fases, tiene dependencias runtime + jiti, y está en beta. Usa `pi-taskflow` cuando quieras **definir tu propio grafo** (no adoptar uno ya opinado) con **cero dependencias** y una instalación de un solo comando.
- **`pi-crew` / `ultimate-pi`** son más pesados — aislamiento con worktree, equipos asíncronos duraderos, gobernanza multi-nivel. Si buscas algo ligero, declarativo y con cero dependencias, este es el proyecto.
- **`@zhushanwen/pi-workflow`** es el más cercano en espíritu y también tiene cero dependencias, pero describes los flujos como **scripts de JavaScript**. El **DSL JSON declarativo** de `pi-taskflow` es más seguro y auditable, y su **reanudación por hash de entrada a nivel de fase** es más granular que la deduplicación por caché de llamada.
- **`@fiale-plus/pi-rogue-orchestration`** tiene un verdadero **bucle hasta-completar** (una función que `pi-taskflow` aún no tiene). Si tu trabajo es "sigue hasta que se cumpla el objetivo", vale la pena echarle un vistazo; `pi-taskflow` es para pipelines *estructurados y ramificados*.
- **`pi-subagents` / `@gotgenes/pi-subagents`** son las opciones maduras para delegaciones ad-hoc del tipo "usa el revisor en este diff" y trabajos en segundo plano. `pi-taskflow` es para cuando esas delegaciones necesitan convertirse en un *pipeline repetible y reanudable*.
- **`pi-pipeline` / `pi-agent-flow`** envían flujos *fijos y opinados*. `pi-taskflow` envía un *lienzo vacío*: tú (o el modelo) declaran el grafo que se ajusta al trabajo.

> La frase honesta: **`pi-taskflow` es la única extensión de Pi que te da un pipeline de subagentes declarativo, reanudable y con forma de DAG que guardas como un comando de una palabra — con cero dependencias runtime y aislamiento de contexto por diseño.** Las brechas conocidas que está cerrando a continuación: bucle hasta-completar, aislamiento de worktree y ejecuciones en segundo plano no bloqueantes (consulta [`STRATEGY.md`](./STRATEGY.md)).

## Inicio en 30 segundos

**1. Instala** — un comando:

```bash
pi install npm:pi-taskflow
```

> **Opcional:** ejecuta `/tf init` una vez para mapear los 18 agentes integrados con roles de modelo
> (`fast`, `strong`, `thinker`, …) a tus propios modelos — un selector interactivo.
> Si lo omites, los agentes usan el modelo predeterminado de Pi. Consulta [Roles de modelo](#roles-de-modelo).

**2. Ejecuta** — solo pídele al modelo en una sesión de Pi:

> *Ejecuta una cadena: primero explora el flujo de autenticación, luego resume los hallazgos.*

El modelo llama a la herramienta `taskflow` automáticamente. Obtienes progreso en vivo, tiempos por paso, costo de tokens y un registro de ejecución guardado — **el mismo esfuerzo que la herramienta integrada, ahora trackeable y reanudable.**

**3. Guarda** — di *"guárdalo"* y tendrás `/tf:<name>` para siempre.

Eso es todo. Puedes estar ejecutando tu primer flujo de trabajo antes de que se enfríe tu café — sin escribir una sola definición de fase.

### La abreviatura (misma forma que la herramienta integrada)

```jsonc
// Simple — un agente, un trabajo
{ "task": "Resume la arquitectura de src/", "agent": "explorer" }

// Paralelo — lanza varios a la vez, las salidas se fusionan
{ "tasks": [
  { "task": "Audita auth en src/api",             "agent": "analyst" },
  { "task": "Audita validación de entrada en src/api", "agent": "analyst" }
] }

// Cadena — secuencial; cada paso ve la salida del anterior
{ "chain": [
  { "task": "Lista la API pública de src/lib", "agent": "scout" },
  { "task": "Escribe documentación para:\n{previous.output}", "agent": "writer" }
] }
```

`agent` es opcional (por defecto usa el primer agente descubierto). Añade un `name` para etiquetar la ejecución y habilitar su guardado como comando.

## Míralo en acción

Esto no es un mockup. **Es stdout de una ejecución real** — el flujo `self-improve` que escribe y verifica sus propias suites de pruebas, interceptado en pleno vuelo por una compuerta de calidad:

```
⊗ taskflow self-improve  6/7 · bloqueado · $0.095
    ✓ discover            agent   deepseek-v4-flash  10t ↑38k ↓6.7k $0.011
  ┌ ✓ write-runner-tests  agent   claude-sonnet-4-6  10t ↑13 ↓6.6k $0.020
  ├ ✓ write-store-tests   agent   claude-sonnet-4-6  10t ↑11 ↓10k $0.018
  ├ ✓ write-agents-tests  agent   claude-sonnet-4-6  10t ↑28 ↓13k $0.030
  └ ✓ fix-stability       agent   claude-sonnet-4-6  10t ↑13 ↓3.9k $0.012
    ✓ verify              gate    BLOQUEO 3 errores de tipo en archivos de prueba  deepseek-v4-flash
    ⊘ report              reduce  saltado · Compuerta bloqueada  ↳ fix-stability
```

**El diseño *es* el DAG.** Sin tablero, sin logs que grep — lees la barra de progreso y entiendes todo el pipeline:

- **Encabezado** — `⊗` = bloqueado (una compuerta lo detuvo); `6/7` fases procesadas; costo agregado `$0.095`.
- **Iconos de estado** — `✓` completado · `◐` ejecutándose · `✗` fallido · `⊘` saltado · `○` pendiente.
- **Riel `┌ ├ └`** — fases en la misma capa del DAG, ejecutándose concurrentemente. Las cuatro tareas `write-*`/`fix-stability` se expanden desde `discover`. Un riel vacío = una capa de una sola fase.
- **`↳`** — una dependencia larga que salta capas. `report` depende del `verify` adyacente *y* de `fix-stability` dos capas atrás, por lo que solo se anota ese borde de salto.
- **Compuerta** — `verify` emitió `VERDICT: BLOCK`, por lo que el runtime saltó `report` y terminó la ejecución como `blocked`, mostrando la razón en línea.
- **Detalle** — por fase: modelo, conteos de tokens (`↑`in `↓`out), costo, tiempo. Las fases de fan-out también muestran el progreso de subtareas (`3/15 2✗ 8▸`).

## Ve a lo declarativo

La abreviatura es tu rampa de entrada. El DSL es donde `pi-taskflow` demuestra su valía — fan-out dinámico, enrutamiento estructurado y compuertas de calidad.

### Fan out y reduce

```jsonc
{
  "name": "resumir-archivos",
  "description": "Descubre archivos, resume cada uno, produce un informe",
  "args": { "dir": { "default": "." } },
  "concurrency": 8,
  "phases": [
    { "id": "discover", "type": "agent", "agent": "scout",
      "task": "Lista los archivos fuente bajo {args.dir} (no recursivo).\nGenera SOLO un array JSON [{\"file\":\"\"}]. Sin prosa.",
      "output": "json" },
    { "id": "summarize", "type": "map",
      "over": "{steps.discover.json}", "as": "item", "agent": "scout",
      "task": "Lee {item.file} y da un resumen de una oración.",
      "dependsOn": ["discover"] },
    { "id": "report", "type": "reduce", "from": ["summarize"], "agent": "writer",
      "task": "Combina en una breve visión general:\n{steps.summarize.output}",
      "dependsOn": ["summarize"], "final": true }
  ]
}
```

1. **`discover`** lista cada archivo y emite un array JSON.
2. **`summarize`** es un `map` — expande un subagente por archivo, limitado a 8 concurrentes, con `{item.file}` vinculado a cada ruta.
3. **`report`** es un `reduce` — fusiona cada resumen en una visión general limpia.

Los resúmenes intermedios nunca entran en tu contexto. El runtime los posee; tú obtienes el informe. **Guárdalo una vez → `/tf:resumir-archivos dir=src` para siempre.**

### Enruta, gatea, reintenta, aprueba y limita el gasto

```jsonc
{
  "name": "triaje-y-arreglo",
  "budget": { "maxUSD": 1.5 },
  "phases": [
    { "id": "triage", "type": "agent", "agent": "analyst", "output": "json",
      "task": "Clasifica el bug. Genera SOLO {\"severity\":\"high\"} o {\"severity\":\"low\"}." },
    { "id": "deep",  "when": "{steps.triage.json.severity} == high", "dependsOn": ["triage"],
      "agent": "executor-code", "task": "Encuentra la causa raíz y parchéalo.",
      "retry": { "max": 2, "backoffMs": 500 } },
    { "id": "quick", "when": "{steps.triage.json.severity} == low",  "dependsOn": ["triage"],
      "agent": "executor-fast", "task": "Aplica el arreglo rápido." },
    { "id": "approve", "type": "approval", "join": "any", "dependsOn": ["deep", "quick"],
      "task": "Revisa el arreglo antes de que se publique." },
    { "id": "ship", "type": "agent", "dependsOn": ["approve"],
      "task": "Abre un PR con el cambio.", "final": true }
  ]
}
```

- **`when`** enruta a `deep` *o* `quick` desde el JSON de triaje — la otra rama se salta.
- **`join: "any"`** permite que `approve` se active en cuanto se completa la rama que se ejecutó (una OR-join).
- **`retry`** re-ejecuta un parche inestable con retroceso; **`budget`** detiene toda la ejecución si se vuelve demasiado costosa.
- **`approval`** pausa para un humano (aprobar / rechazar / editar) antes del `ship` final.

Sin scripting. Sin `eval`. Solo datos que el runtime ejecuta — lo suficientemente seguro como para ejecutar definiciones generadas por LLM directamente.

## Tipos de fase

| type | qué hace | campos requeridos |
|------|----------|-------------------|
| `agent` | un subagente ejecuta una tarea | `task` |
| `parallel` | ejecuta `branches[]` concurrentemente | `branches` (array de `{task, agent?}`) |
| `map` | **fan out** sobre un array — un subagente por elemento, `{item}` vinculado | `over`, `task` |
| `gate` | paso de calidad/revisión que puede **detener el flujo** | `task` |
| `reduce` | agrega salidas de fases `from[]` en una | `from`, `task` |
| `approval` | pausa **humano en el circuito** — aprobar / rechazar / editar | — |
| `flow` | ejecuta un **sub-flujo guardado** como una fase (composición) | `use` |
| `loop` | **itera una tarea hasta completar** — re-ejecuta un cuerpo hasta una condición, convergencia o tope | `task`, `until` |
| `tournament` | **N variantes compiten**, un juez elige la mejor (o agrega) | `task` \| `branches` |

### Campos comunes de fase

Cada fase necesita un `id` único y un `type` (por defecto `agent`). Además de los campos por tipo:

| Campo | Significado |
|---|---|
| `agent` | Agente a ejecutar (por defecto el primer agente descubierto) |
| `dependsOn` | IDs de fase que esta fase espera — construye el DAG |
| `join` | `"all"` (por defecto) espera todas las dependencias; `"any"` es una OR-join |
| `when` | Guarda condicional — se salta a menos que la expresión sea truthy |
| `retry` | `{ max, backoffMs?, factor? }` — reintenta un subagente fallido |
| `output` | `"text"` (por defecto) o `"json"` (expone `{steps.ID.json}`) |
| `model` / `thinking` / `tools` | Anulaciones por fase para el subagente |
| `cwd` | Directorio de trabajo para el subagente |
| `concurrency` | Límite de fan-out para `map` / `parallel` (anula el valor por defecto del flujo) |
| `final` | Marca la fase que lleva el resultado (si no, gana la última fase) |
| `optional` | Un fallo aquí **no** aborta la ejecución |
| `use` / `with` | (`flow`) nombre del sub-flujo guardado + sus args |
| `cache` | `{ scope, ttl?, fingerprint? }` — memoización entre ejecuciones (ver más abajo) |

Claves a nivel de flujo: `name`, `description`, `args`, `concurrency` (por defecto 8), `agentScope` y `budget: { maxUSD?, maxTokens? }`.

### Flujo de control y fiabilidad

- **`when`** — salta una fase a menos que una expresión sea truthy. Soporta `{refs}`, `== != < > <= >=`, `&& || !`, paréntesis y cadenas/números entre comillas. Combínalo con `join: "any"` en la fase de fusión para enrutamiento if/else real. Los errores de análisis **fallan abiertamente**.
- **`join: "any"`** — una OR-join: la fase se ejecuta tan pronto como *una* dependencia se completa (por defecto `"all"` espera todas).
- **`retry`** — `{ "max": 2, "backoffMs": 500, "factor": 2 }` reintenta un subagente fallido con retroceso fijo o exponencial; el uso se suma y el contador de intentos se muestra como `↻N` en la TUI. Los errores transitorios del proveedor (rate-limit / 5xx / timeout) **se reintentan automáticamente incluso sin una política explícita**; los errores duros no.
- **`approval`** — pausa para un humano (Aprobar / Rechazar / Editar). Rechazar detiene el flujo; Editar inyecta la nota escrita como salida de la fase para los pasos descendentes. Las ejecuciones no interactivas se auto-aprueban.
- **`flow`** — `{ "type": "flow", "use": "deep-research", "with": { "topic": "{item}" } }` ejecuta un flujo guardado como una fase (la recursión se detecta y se rechaza).

### Bucle hasta completar (`loop`)

Algunos trabajos son inherentemente iterativos — refinar un borrador hasta que un revisor esté satisfecho, reintentar y mejorar hasta que las pruebas pasen, converger en una respuesta. Una fase `loop` re-ejecuta un cuerpo de tarea hasta que se cumple una condición de parada:

```jsonc
{
  "id": "refinar",
  "type": "loop",
  "task": "Mejora este borrador (iteración {loop.iteration}). Intento anterior:\n{loop.lastOutput}\n\nDevuelve JSON {\"draft\":\"…\",\"done\":true|false}.",
  "until": "{steps.refinar.json.done} == true",   // la salida de la propia iteración se expone aquí
  "output": "json",
  "maxIterations": 6,        // por defecto 10, tope duro 100 — el bucle SIEMPRE termina
  "convergence": true        // por defecto: se detiene antes si la salida de una iteración es idéntica a la anterior
}
```

- **Variables locales del cuerpo** — la tarea puede leer `{loop.iteration}` (base 1), `{loop.lastOutput}` (la salida de la iteración anterior) y `{loop.maxIterations}` para construir sobre su propio trabajo previo; las tres también están disponibles para la condición `until`.
- **`until`** — se evalúa después de cada iteración con la salida de la iteración expuesta como `{steps.<esteId>.output}` / `.json`. Mismos operadores que `when`. El bucle se detiene en cuanto es truthy.
- **Siempre termina.** Cuatro paradas independientes: `until` truthy, **convergencia** (un punto fijo — salida idéntica a la iteración anterior), **`maxIterations`** (tope duro en 100) o una **iteración fallida** (la fase falla con la salida parcial preservada). Un `until` malformado **detiene** el bucle en lugar de girar para siempre (fail-safe) y muestra una advertencia en la fase.
- La TUI muestra `↻N` con la razón de parada (`done` / `converged` / `max` / `failed`); el uso se suma entre iteraciones. Como `gate`/`approval`, `loop` está **excluido del caché `cross-run`** (cada ejecución debe iterar de nuevo).

### Torneo (`tournament`)

Para trabajos abiertos, el mejor resultado a menudo viene de generar varios candidatos y elegir el más fuerte — mejor-de-N con un juez, en una fase declarativa:

```jsonc
{
  "id": "titular",
  "type": "tournament",
  "task": "Escribe un titular impactante para este post de lanzamiento.",
  "variants": 4,                    // genera 4 competidores de la MISMA tarea (por defecto 3, máximo 20)
  "judge": "Elige el titular con el gancho más fuerte y la promesa más clara.",
  "judgeAgent": "reviewer",          // opcional; por defecto usa el agente de la fase
  "mode": "best"                     // "best" (por defecto) | "aggregate"
}
```

- **Competidores** — ya sea `variants: N` copias de una `task` (la diversidad viene del no determinismo del modelo), o `branches: [{task, agent?}, …]` distintas cuando quieres enfrentar *diferentes enfoques* entre sí.
- **Juez** — después del fan-out, un agente juez ve cada variante (numerada) más tu rúbrica `judge` y elige un ganador mediante una línea `WINNER: <n>` o `{"winner": n}`. Un veredicto ilegible **falla abiertamente** hacia la variante 1; un juez fallido también retrocede — el trabajo nunca se pierde.
- **`mode`** — `best` devuelve la variante ganadora **textualmente**; `aggregate` devuelve la respuesta **sintetizada** del juez combinando las partes más fuertes.
- **Cortocircuitos:** si solo sobrevive un competidor, gana sin llamada al juez; si todos fallan, la fase falla. La TUI muestra `⚑ N→#k`; el uso suma variantes + juez. Como `gate`, está **excluido del caché `cross-run`**.
- **`budget`** — un techo `{maxUSD, maxTokens}` para toda la ejecución; una vez superado, las fases pendientes se saltan y el fan-out en vuelo deja de generar, terminando la ejecución como `blocked`.
- **Vigilante de inactividad** — un subagente que permanece en silencio durante 5 minutos se trata como atascado y se elimina (SIGTERM → SIGKILL), por lo que un hijo colgado nunca puede congelar todo el flujo.

### Memoización entre ejecuciones (`cache`)

Cada fase ya está direccionada por contenido: dentro de la **reanudación** de una misma ejecución, una fase cuyas entradas resueltas no han cambiado se salta. `cache` extiende esa reutilización **entre ejecuciones independientes** — si alguna ejecución anterior calculó una fase con un hash de entrada idéntico, su resultado se reutiliza por **$0.00**.

```jsonc
{
  "id": "analizar-auth",
  "task": "Resume cómo funciona el módulo de autenticación.",
  "context": ["src/auth/**/*.ts"],
  "cache": {
    "scope": "cross-run",                 // "run-only" (por defecto) | "cross-run" | "off"
    "ttl": "6h",                          // antigüedad máxima opcional antes de tratar un acierto como fallo
    "fingerprint": ["git:HEAD", "glob:src/auth/**/*.ts"]  // incorpora estado del mundo en la clave
  }
}
```

- **`scope`** — `"run-only"` (por defecto) es exactamente el comportamiento histórico (solo reanudación dentro de la misma ejecución). `"cross-run""` opta por que la fase entre al almacén persistente. `"off"` deshabilita completamente la reutilización (incluso dentro de una ejecución), para depuración.
- **La frescura es todo el juego.** La clave de caché ya incluye el prompt, los elementos de `over` y cualquier archivo de `context` (pre-leídos en la tarea). `fingerprint` pliega entradas *implícitas* en la clave para que "el mundo cambió" se convierta en un fallo de caché: `git:HEAD`, `glob:<pat>` (tamaño+mtime), `glob!:<pat>` (hash de contenido), `file:<ruta>`, `env:<NOMBRE>`. `ttl` (`30m`/`6h`/`7d`) es un respaldo de tiempo.
- **Límite honesto:** un subagente que lee un archivo que no declaró en `context`/`fingerprint` aún puede servir un acierto `cross-run` obsoleto. Por eso el valor por defecto es `run-only` y por qué las fases `gate`/`approval` tienen **prohibido** usar `cross-run` (deben producir un resultado fresco cada ejecución). Opta solo para fases cuya salida sea función de entradas declaradas.
- El caché reside en `.pi/taskflows/cache/` (gitignored). Límpialo con `action: "cache-clear"`. Razonamiento completo: [`docs/rfc-cross-run-memoization.md`](./docs/rfc-cross-run-memoization.md).

### Fases gate (control de calidad)

Un `gate` ejecuta un agente para revisar la salida de fases anteriores y puede **bloquear el resto del flujo de trabajo.** Termina la tarea de gate pidiendo un veredicto que el runtime pueda leer:

- una línea final `VERDICT: PASS` o `VERDICT: BLOCK` (también acepta `OK`, `FAIL`, `STOP`, `REJECT`, `HALT` — la última ocurrencia gana), o
- JSON como `{"continue": false, "reason": "faltan comprobaciones de auth"}` / `{"verdict": "block", "reason": "..."}`.

En **BLOCK**, las fases descendentes se saltan y la ejecución termina como `blocked` con la razón mostrada. **La salida ambigua falla abiertamente** (se trata como PASS) — un gate nunca detiene tu flujo por accidente.

```
Revisa la auditoría a continuación. Si algún endpoint carece de autenticación, termina con
"VERDICT: BLOCK" y una razón de una línea; de lo contrario termina con "VERDICT: PASS".

{steps.audit.output}
```

## Interpolación y expresiones

| placeholder | resuelve a |
|---|---|
| `{args.X}` | argumento de invocación |
| `{steps.ID.output}` | salida de texto de una fase anterior |
| `{steps.ID.json}` | salida anterior parseada como JSON (o `{steps.ID.json.campo}`) |
| `{item}` / `{item.campo}` | elemento actual dentro de una fase `map` |
| `{previous.output}` | salida de la fase inmediatamente upstream |

Gramática de condiciones (para `when`): `== != < > <= >=`, `&& || !`, paréntesis, cadenas/números entre comillas y cualquier referencia `{...}` — ej. `"when": "{steps.triage.json.route} == deep && {args.force} != true"`.

> Referenciar `{steps.X}` que no está declarado en `dependsOn` es un **error de validación duro** — el runtime detecta el error de pipeline más común antes de que un solo agente se ejecute.

## Comandos

Los flujos guardados se convierten en atajos de CLI. Todos los comandos se ejecutan en la sesión de Pi:

| Comando | Qué hace |
|---|---|
| `/tf list` | Lista todos los flujos guardados |
| `/tf run <nombre> [args]` | Ejecuta un flujo guardado (ej. `/tf run resumir-archivos dir=src`) |
| `/tf show <nombre>` | Muestra la definición de un flujo |
| `/tf runs` | Explora el historial reciente de ejecuciones (TUI interactiva) |
| `/tf resume <runId>` | Continúa una ejecución pausada/fallida — las fases cacheadas se saltan automáticamente |
| `/tf init` | **Mapea interactivamente los roles de modelo** a tus modelos habilitados (escribe `~/.pi/agent/settings.json`) |
| `/tf:<nombre> [args]` | Atajo — ejecuta el flujo en un solo toque |

Acciones de herramienta (usadas por el modelo): `run` (con `define` inline o `name` guardado), `save`, `resume`, `list`, `init`.

## Reanudación entre sesiones

Una ejecución de taskflow no está atada a tu sesión. Cada fase completada se escribe en disco, por lo que una ejecución que falla (o que detienes) puede continuarse más tarde con `/tf resume <runId>` — **las fases cacheadas se saltan automáticamente** y solo el trabajo restante gasta tokens.

<div align="center">
<img src="./assets/resume.png" alt="A run fails midway in session 1; in session 2 /tf resume skips the cached phases and only re-runs the failed phase and what follows" width="900">
</div>

La reanudación se basa en el hash de entrada de cada fase — si la salida de una fase upstream cambió, las fases dependientes se re-ejecutan; si nada cambió, se reutilizan. Ninguna otra extensión de Pi hace esto entre sesiones.

## Almacenamiento

```
.pi/taskflows/<nombre>.json          # definiciones a nivel de proyecto (commitea para compartir)
~/.pi/agent/taskflows/<nombre>.json  # definiciones a nivel de usuario
.pi/taskflows/runs/<runId>.json      # estado de ejecución para reanudación (gitignore esto)
```

> Commitea `.pi/taskflows/` y todo tu equipo comparte los pipelines — sin sincronización de configuración, sin documento de inicio. El estado de ejecución se escribe atómicamente y está protegido por un bloqueo de archivo sin dependencias, por lo que las ejecuciones concurrentes nunca corrompen el índice.

Ámbito de descubrimiento de agentes (a través de `agentScope` en la definición del flujo):

| valor | descubre agentes de |
|---|---|
| `"user"` (por defecto) | `~/.pi/agent/agents/*.md` |
| `"project"` | `.pi/agents/*.md` (sube por el árbol) |
| `"both"` | usuario + proyecto; proyecto gana en colisión de nombres |

## Agentes

Taskflow incluye **18 agentes integrados** — cada uno un archivo `.md` con un prompt de sistema ajustado, nivel de thinking y conjunto de herramientas. Puedes referenciarlos por `name` en cualquier fase o abreviatura, justo después de instalar. Sin configuración requerida.

### Lista de agentes integrados

| Agente | Rol | Thinking | Rol predeterminado |
|---|---|---:|---|
| `executor` | Implementar cambios de código planificados | high | `{{fast}}` |
| `executor-fast` | Arreglos triviales (≤2 archivos, ≤50 líneas) | off | `{{fast}}` |
| `executor-code` | Implementación multi-archivo compleja | high | `{{strong}}` |
| `executor-ui` | Frontend / estilo / cambios visuales | high | `{{vision}}` |
| `scout` | Reconocimiento rápido de código y mapeo de archivos | off | `{{fast}}` |
| `planner` | Creación de plan de implementación | high | `{{strong}}` |
| `analyst` | Análisis de requisitos, detección de ambigüedad | high | `{{thinker}}` |
| `critic` | Autoevaluación en línea durante el razonamiento | xhigh | `{{thinker}}` |
| `reviewer` | Revisión general de código / arquitectura | high | `{{strong}}` |
| `risk-reviewer` | Riesgo de backend / infra / DB / API | high | `{{reasoner}}` |
| `security-reviewer` | Vulnerabilidades de seguridad, auth/crypto | xhigh | `{{reasoner}}` |
| `plan-arbiter` | Compuerta de calidad del plan (tareas complejas) | high | `{{arbiter}}` |
| `final-arbiter` | Desempate cuando los críticos discrepan | xhigh | `{{arbiter}}` |
| `test-engineer` | Diseñar e implementar pruebas | high | `{{fast}}` |
| `doc-writer` | Redacción de documentación | off | `{{fast}}` |
| `recover` | Recuperación de sesión después de compactación | low | `{{fast}}` |
| `verifier` | Ejecutar pruebas, validar resultados | off | `{{fast}}` |
| `visual-explorer` | Análisis de metadatos de diseño Figma | high | `{{vision}}` |

Los agentes están en capas: **integrado → usuario (`~/.pi/agent/agents/`) → proyecto (`.pi/agents/`)**. Un agente de usuario o proyecto con el mismo `name` anula al integrado — así que puedes personalizar cualquier agente sin tocar el paquete.

### Roles de modelo

El campo `model` de cada agente integrado usa un **placeholder de rol** (ej. `{{fast}}`) en lugar de una cadena de proveedor fija. Esto desacopla la *intención* de la *implementación* — mapeas roles a modelos una vez, y cada agente se adapta.

| Rol | Intención | Modelo típico |
|---|---|---|
| `{{fast}}` | Barato y rápido — alto volumen, bajo riesgo | DeepSeek V4 Flash |
| `{{strong}}` | Equilibrado — planificación, revisión, complejidad moderada | MiMo v2.5 Pro |
| `{{thinker}}` | Análisis profundo — requisitos, crítica | DeepSeek V4 Pro |
| `{{arbiter}}` | Juicio final — desempate, compuertas de calidad del plan | Qwen 3.7 Max |
| `{{vision}}` | Multimodal — trabajo de UI, lectura de diseño | MiniMax M3 |
| `{{reasoner}}` | Razonamiento cauteloso — seguridad, riesgo | GLM 5.1 |

Sin configuración, los agentes recurren al modelo predeterminado de Pi. Para mapear roles a modelos reales, ejecuta la configuración interactiva:

```bash
/tf init
```

`/tf init` comienza con un **menú de acciones**. Los usuarios primerizos ven un atajo de 2 opciones ("Usar valores recomendados" / "Configurar cada rol"). Los usuarios recurrentes ven el menú completo de 5 opciones:

```
? ¿Qué quieres hacer con los roles de modelo?
  ❯ Usar valores recomendados
    Configurar cada rol
    Editar un rol
    Mostrar roles actuales
    Cancelar
```

El selector muestra los **nombres visibles** de los modelos con indicadores de capacidad y marcadores de actual/recomendado:

```
? Modelo para 'vision' — Multimodal (executor-ui, visual-explorer)
  Actual: openrouter/anthropic/claude-sonnet-4-6
  Recomendado: minimax/MiniMax-M3
  ───────────────
  ❯ MiniMax M3 (minimax/MiniMax-M3) · image ✓ · reasoning ✓ · (recomendado)
    Claude Sonnet 4.6 (openrouter/anthropic/...) · image ✓ · reasoning ✓ · (actual)
    GPT-5 (openrouter/openai/gpt-5) · image ✓
    DeepSeek V4 Flash (openrouter/deepseek/v4-flash)
    ───────────────
    Personalizado (escribe el tuyo)
    Mantener actual
    Volver al menú de acciones
```

Antes de guardar, una **pantalla de vista previa** muestra el diff de tus cambios:

```
? Revisar cambios:
  fast       openrouter/deepseek/deepseek-v4-flash   (sin cambios)
  strong     openrouter/xiaomi/mimo-v2.5-pro         (sin cambios)
  thinker    openrouter/qwen/qwen3.7-max             (cambiado ← era: openrouter/deepseek/v4-pro)
  arbiter    openrouter/qwen/qwen3.7-max             (sin cambios)
  vision     minimax/MiniMax-M3                      (sin cambios)
  reasoner   z-ai/glm-5.1                            (sin cambios)
  ───────────────
  ❯ Guardar estos cambios
    Editar un rol
    Cancelar
```

Tus elecciones se escriben en `~/.pi/agent/settings.json`:

```json
{
  "modelRoles": {
    "fast":     "openrouter/deepseek/deepseek-v4-flash",
    "strong":   "openrouter/xiaomi/mimo-v2.5-pro",
    "thinker":  "openrouter/deepseek/deepseek-v4-pro",
    "arbiter":  "openrouter/qwen/qwen3.7-max",
    "vision":   "minimax/MiniMax-M3",
    "reasoner": "z-ai/glm-5.1"
  }
}
```

Edita los valores manualmente en cualquier momento, o simplemente vuelve a ejecutar `/tf init`. También puedes anular agentes individuales a través de `subagents.agentOverrides` en el mismo archivo:

```json
{
  "modelRoles": { ... },
  "subagents": {
    "agentOverrides": {
      "executor": { "model": "anthropic/claude-sonnet-4-20250514" },
      "reviewer": { "thinking": "xhigh" }
    }
  }
}
```

### Ruta de herramienta (`action="init"`)

El modelo también puede configurar roles a través de la herramienta `taskflow`:

| Modo | Comportamiento |
|---|---|
| `mode: "show"` (por defecto) | Informe de solo lectura de `modelRoles` actual. Nunca sobrescribe. |
| `mode: "apply-defaults"` + `force: true` | Escribe `RECOMMENDED_DEFAULTS` en `settings.json`, preservando claves obsoletas. |
| `mode: "interactive"` | Lanza el menú de acciones completo + flujo del selector (requiere una sesión UI). |

> **Nota de obsolescencia v0.0.13:** Si se omite `mode`, la herramienta recurre al comportamiento de v0.0.12 cuando `modelRoles` está vacío (auto-escribe valores predeterminados) con un aviso de `console.warn`. Si `modelRoles` ya existe, se comporta como `mode: "show"`. Este puente se eliminará en v0.0.14.

### Agentes personalizados

Coloca un archivo `.md` en `~/.pi/agent/agents/` (nivel de usuario) o `.pi/agents/` (nivel de proyecto, commitealo) para añadir el tuyo:

```markdown
---
name: mi-linter

description: Ejecuta ESLint e informa violaciones

tools: read, bash

model: "{{fast}}"

thinking: off
---

Eres un agente de linting. Ejecuta `npx eslint --format json` en los
archivos proporcionados. Informa las violaciones agrupadas por archivo. Sin correcciones.
```

Luego refiérete a él en cualquier fase: `{ "agent": "mi-linter", "task": "Haz lint de src/" }`.

## Ejemplos

Definiciones listas para leer en [`examples/`](./examples):

| Archivo | Demuestra |
|---|---|
| [`summarize-files.json`](./examples/summarize-files.json) | discover → `map` fan-out → `reduce` |
| [`conditional-research.json`](./examples/conditional-research.json) | enrutamiento `when` + `join: any` + `gate` + `budget` |
| [`guarded-refactor.json`](./examples/guarded-refactor.json) | `approval` (humano en el circuito) + `retry` + `gate` |

Copia uno en `.pi/taskflows/<nombre>.json` (o `~/.pi/agent/taskflows/`) y se registra como `/tf:<nombre>` — o simplemente apunta el modelo hacia él.

## Qué hay dentro

<div align="center">

**0 dependencias runtime** · **394 pruebas** · **10 tipos de fase** · **reanudación entre sesiones** · **memoización entre ejecuciones** · **~4.9k LOC de runtime**

</div>

- **Cero dependencias runtime.** Sin campo `dependencies` — el runtime está construido enteramente sobre módulos nativos de Node (`fs` / `path` / `os` / `child_process` / `crypto`). El bloqueo de archivo es `fs.openSync("wx")`, no una biblioteca de terceros.
- **371 pruebas en 14 suites** que cubren concurrencia, bloqueo atómico de archivos (regresiones de carrera de 8 procesos), endurecimiento contra path traversal, reanudación entre sesiones, frescura de caché entre ejecuciones (aislamiento de clave flujo/thinking/herramientas, invalidación de fingerprint, desalojo TTL/LRU), veredictos de gate, topes de budget, reintento/backoff, flujos de approval, terminación de loop, juicio de tournament, composición de sub-flujos, aislamiento de callback, vigilante de inactividad, configuración init de roles de modelo, y parseModelFromLabel con regresión de nombre de modelo entre paréntesis — además de una prueba end-to-end en vivo que genera subagentes reales y dogfood de caché entre ejecuciones.
- **Endurecido por diseño.** Defensa contra path traversal (léxica + `realpath`), validación de runId, sanitización de HTML/errores, escrituras atómicas, robo de bloqueo obsoleto mediante `rename` y un vigilante de inactividad que elimina subagentes atascados.
- **Dogfooded.** Cada nueva característica debe sobrevivir el propio flujo `self-improve` del proyecto antes de publicarse.

## 🍽️ Comemos nuestro propio dog food

Cada característica en `pi-taskflow` se publica **a través de `pi-taskflow`.**

Nuestro flujo `self-improve` es un DAG de 10 fases — audita el código fuente, parchea defectos, verifica corrección, gatea en calidad y muestra el informe — todo declarativamente. Está guardado como `/tf:self-improve` y se ejecuta antes de cada lanzamiento. Ningún otro orquestador de agentes en el ecosistema de Pi se construye a sí mismo consigo mismo.

| Campaña | Escala | Fases | Resultado |
|----------|-------|--------|---------|
| [Dogfood v0.0.8](./docs/dogfooding-v0.0.8-report.md) | Auditoría completa → triaje → arreglo → verificación | 10 fases, 234 pruebas | 13 arreglos, todos pasan |
| [Auto-auditoría v0.0.6](./docs/self-audit-report.md) | inventory → map audit → gate → approval → map fix → reduce | 9 fases | 11 defectos críticos corregidos |
| [Dogfood caché entre ejecuciones](./docs/rfc-cross-run-memoization.md) | Runtime real + almacén en disco | Harness de prueba dedicado | Corrección de caché bajo fingerprints adversariales |
| [Revisión cruzada adversarial](./docs/brainstorm-adversarial-review-report.md) | Revisión adversarial multi-agente | `tournament` + `gate` | Arreglo de clave de caché P0 publicado |
| [Revisión de rediseño de init](./docs/issue-necessity-review-report.md) | Auditoría de necesidad → verificaciones paralelas → veredicto | 7 fases | Plan de rediseño completo validado |

> **Meta:** usamos el fan-out `map` de `pi-taskflow`, veredictos `gate`, `approval` humano en el circuito, `tournament` mejor-de-N, `loop` hasta-completar y caché `cross-run` — para construir `pi-taskflow`.

## Estado y límites

**v0.0.13** — bucle hasta-completar (fase `loop`: itera hasta una condición, convergencia o tope), torneo (mejor-de-N con un juez), memoización entre ejecuciones (caché direccionado por contenido con fingerprints git/archivo/glob/variable de entorno y TTL), `/tf init` interactivo con selectores de modelo conscientes del rol + vista previa diff + escritura-fusión atómica, 18 agentes integrados con 6 roles de modelo. Capa completa de flujo de control y fiabilidad (guardas `when`, `join: any`, `retry`/backoff, `approval`, composición `flow`, topes `budget`, vigilante de inactividad) sobre el DSL + runtime DAG (`agent`/`parallel`/`map`/`gate`/`reduce`). Flujos inline y guardados, reanudación entre sesiones, progreso en vivo y contexto aislado. Una ejecución se realiza como una sola llamada de herramienta en streaming.

Límites conocidos (trackeados, acotados — sin sorpresas a mitad del flujo):

- **Sin ejecución en segundo plano desacoplada.** Una ejecución necesita la sesión de Pi abierta. La ejecución en segundo plano real (y los disparadores por evento/cron sobre ella) está en el roadmap.
- **Sin `output: "file"`.** Las salidas son solo texto/JSON — escribe archivos mediante la herramienta `write` de un agente.
- **`map` requiere un array JSON.** El campo `over` debe resolverse a un array `{steps.ID.json}`. Envuelve una lista de texto en una fase de un solo agente con `output: "json"` primero.
- **El DAG debe ser acíclico.** Los ciclos se rechazan en la validación.

## Desarrollo

```bash
npm install
npm run typecheck
npm test            # pruebas unitarias — sin red, sin generación de procesos
npm run test:e2e    # end-to-end real (genera subagentes vivos; necesita acceso a modelos)
```

El runtime vive en `extensions/`, las pruebas en `test/`, los ejemplos ejecutables en `examples/` y el razonamiento de diseño completo en [`DESIGN.md`](./DESIGN.md).

## Contribuir

Las contribuciones son bienvenidas — este es un proyecto joven y de movimiento rápido. Abre un issue o PR en [GitHub](https://github.com/heggria/pi-taskflow). Buenas primeras contribuciones: nuevos flujos de ejemplo, ideas de tipos de fase y pulido de la TUI.

## Licencia

MIT
