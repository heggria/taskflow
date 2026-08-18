/**
 * Turn a filesystem path or already-valid ESM specifier into something
 * `import()` will accept on every platform.
 *
 * Node's ESM loader only accepts `file:`, `data:`, and `node:` URLs. A native
 * Windows path such as `C:\\…\\runner.js` is parsed as protocol `c:` and
 * rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME (issue #139). `pathToFileURL`
 * is correct for the *current* platform, but unit tests and docs also need
 * drive-letter / UNC strings to convert when the process itself is POSIX.
 *
 * Drive/UNC conversion goes through `URL.pathname` so `#` / `?` / spaces are
 * percent-encoded (a raw `new URL("file:///C:/a#b")` would treat `#` as a
 * fragment and import the truncated path).
 */
import { pathToFileURL } from "node:url";

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^[\\/]{2}[^\\/]/;

function windowsDriveToFileUrl(windowsPath: string): string {
	const normalized = windowsPath.replace(/\\/g, "/");
	const url = new URL("file:///");
	url.pathname = `/${normalized}`;
	return url.href;
}

function windowsUncToFileUrl(windowsPath: string): string {
	const normalized = windowsPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const slash = normalized.indexOf("/");
	const host = slash === -1 ? normalized : normalized.slice(0, slash);
	const rest = slash === -1 ? "/" : normalized.slice(slash);
	const url = new URL("file://");
	url.host = host;
	url.pathname = rest || "/";
	return url.href;
}

export function toModuleImportSpecifier(moduleRef: string): string {
	const trimmed = moduleRef.trim();
	if (
		trimmed.startsWith("file:") ||
		trimmed.startsWith("data:") ||
		trimmed.startsWith("node:")
	) {
		return trimmed;
	}
	if (WINDOWS_DRIVE.test(trimmed)) return windowsDriveToFileUrl(trimmed);
	if (WINDOWS_UNC.test(trimmed)) return windowsUncToFileUrl(trimmed);
	return pathToFileURL(trimmed).href;
}
