import fs from "node:fs";

process.on("SIGTERM", () => {});
if (process.send) process.send("ready");
setTimeout(() => {
	const marker = process.env.TASKFLOW_TEST_ABORT_MARKER;
	if (marker) fs.writeFileSync(marker, "survived");
}, 600);
setInterval(() => {}, 1000);
