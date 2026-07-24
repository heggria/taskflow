import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(packageRoot, "../taskflow-web/dist/app");
const destination = path.join(packageRoot, "dist", "web");
const manifest = path.join(source, "taskflow-web-assets.json");

if (!fs.existsSync(manifest)) {
	throw new TypeError(
		"taskflow-web packaged assets are missing; build taskflow-web before taskflow-cli",
	);
}
fs.cpSync(source, destination, {
	recursive: true,
	errorOnExist: true,
	force: false,
});
