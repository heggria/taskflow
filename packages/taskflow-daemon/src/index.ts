/**
 * taskflowd — multi-mount control clerk (process speech is not authority).
 */
export {
	startDaemon,
	type DaemonHandle,
	type DaemonOptions,
} from "./daemon.ts";
export {
	startUdsServer,
	udsRpc,
	PROTOCOL_MAJOR,
	MAX_UDS_LINE_BYTES,
	MAX_UDS_CONNECTIONS,
	UDS_HELLO_DEADLINE_MS,
	UDS_RPC_TIMEOUT_MS,
	type UdsServerHandle,
	type UdsServerOptions,
	type UdsRpcOptions,
} from "./uds-server.ts";
export {
	mountProject,
	validateAbsoluteProjectRoot,
	assertMountAllowed,
	sameProjectRoot,
	resolveMountAllowRoots,
	MOUNT_ALLOW_ROOTS_ENV,
	type MountResult,
	type MountProjectOptions,
} from "./mount.ts";
