/**
 * taskflowd — multi-mount control clerk (process speech is not authority).
 */
export {
	startDaemon,
	type DaemonHandle,
	type DaemonOptions,
	type DaemonWebUiLaunch,
	type DaemonWebUiStartRequest,
	type DaemonWebUiStatus,
} from "./daemon.ts";
export { startUdsServer, udsRpc, PROTOCOL_MAJOR, type UdsServerHandle } from "./uds-server.ts";
export {
	createWebSessionAuthority,
	type WebSessionAuthority,
	type WebSessionAuthorityOptions,
	type WebSessionExchange,
	type WebLaunchCapability,
	type WebSessionRecord,
} from "./web-session.ts";
export {
	startWebGateway,
	type WebGatewayHandle,
	type WebGatewayOptions,
} from "./web-gateway.ts";
export {
	decodeCanonicalWebStaticPath,
	loadWebStaticAssets,
	serveWebStaticRequest,
	WebStaticAssetsError,
	type WebStaticAssets,
	type WebStaticAssetsOptions,
} from "./web-static-assets.ts";
