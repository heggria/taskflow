const BASE_ENV_KEYS = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM",
	"TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
	"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE",
	"HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
	"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

export const CHILD_ENV_ALLOWLIST_ENV = "PI_TASKFLOW_CHILD_ENV_ALLOW";

// Host-principal controls are never delegable through the generic child env
// allowlist. A subagent may receive task credentials, but it must not mint the
// host's cwd-bridge authority for a nested Taskflow invocation.
const HOST_ONLY_ENV_KEYS = new Set([
	"TASKFLOW_CWD_BRIDGE_MODE",
	"TASKFLOW_WORKSPACE_RECONCILE_MODE",
]);

/** Build a least-privilege child environment. Provider credentials and
 * host-specific configuration are retained explicitly; unrelated parent
 * secrets are never inherited by an adversarial subagent. */
export function filteredChildEnv(
	source: NodeJS.ProcessEnv,
	exactKeys: readonly string[],
	prefixes: readonly string[],
): NodeJS.ProcessEnv {
	const exact = new Set(exactKeys.map((key) => key.toUpperCase()));
	for (const key of source[CHILD_ENV_ALLOWLIST_ENV]?.split(",") ?? []) {
		if (key.trim()) exact.add(key.trim().toUpperCase());
	}
	const normalizedPrefixes = prefixes.map((prefix) => prefix.toUpperCase());
	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const normalized = key.toUpperCase();
		if (HOST_ONLY_ENV_KEYS.has(normalized)) continue;
		if (
			BASE_ENV_KEYS.has(normalized) ||
			exact.has(normalized) ||
			normalizedPrefixes.some((prefix) => normalized.startsWith(prefix))
		) {
			filtered[key] = value;
		}
	}
	return filtered;
}
