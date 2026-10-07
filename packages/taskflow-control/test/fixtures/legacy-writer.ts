/** Real legacy persistence API in a separate, externally owned process. */
import { saveRun, newRunId } from "taskflow-core";
const root = process.argv[2];
const runId = newRunId("old-writer");
saveRun({ runId, flowName: "old-writer", cwd: root, def: { name: "old-writer", phases: [] }, args: {}, phases: {}, status: "running", createdAt: Date.now(), updatedAt: Date.now(), pid: process.pid }, { maxKeep: 0, maxAgeDays: 0 });
process.stdout.write(JSON.stringify({ pid: process.pid, runId }) + "\n");
setInterval(() => {}, 1000);
