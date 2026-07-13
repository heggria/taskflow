import fs from "node:fs";

const [marker] = process.argv.slice(2);
if (!marker) process.exit(2);

setTimeout(() => fs.writeFileSync(marker, "survived"), 500);
setInterval(() => {}, 1000);
