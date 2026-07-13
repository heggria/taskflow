export const sampleJson = `{
  "name": "review-changes",
  "budget": { "maxUSD": 2 },
  "phases": [
    {
      "id": "discover",
      "type": "agent",
      "agent": "scout",
      "task": "List changed files as a JSON array of {path} objects",
      "output": "json",
      "expect": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    },
    {
      "id": "review",
      "type": "map",
      "over": "{steps.discover.json}",
      "agent": "reviewer",
      "task": "Review {item.path}",
      "dependsOn": ["discover"]
    },
    {
      "id": "report",
      "type": "reduce",
      "from": ["review"],
      "task": "Prioritized risk summary",
      "dependsOn": ["review"],
      "final": true
    }
  ]
}`;

export const sampleTs = `import { flow, agent, map, reduce, json } from "taskflow-dsl";

export default flow("review-changes", (ctx) => {
  ctx.budget({ maxUSD: 2 });
  const discover = agent("List changed files as a JSON array of {path} objects", {
    agent: "scout",
    output: json<{ path: string }[]>(),
  });
  const review = map(discover, (item) => agent(\`Review \${item.path}\`), {
    agent: "reviewer",
  });
  const report = reduce([review], () => agent("Prioritized risk summary"), {
    final: true,
  });
  return report;
});`;

export const sampleFlowIR = `flow review-changes
  phase discover: agent scout -> json[array<{path:string}>]
  phase review:   map discover.json with reviewer
  phase report:   reduce review -> finalOutput

fingerprints
  discover  sha256:1f0…
  review    sha256:7c2…
  report    sha256:af9…

incremental
  changed: src/auth/session.ts
  stale frontier: review[session.ts], report
  cache reuse: discover, review[others]`;
