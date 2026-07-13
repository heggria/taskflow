import fs from "node:fs";

setTimeout(() => {
	const marker = process.env.TASKFLOW_TEST_NORMAL_MARKER;
	if (marker) fs.writeFileSync(marker, "ok");
}, 600);
