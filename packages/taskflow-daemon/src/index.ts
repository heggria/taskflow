/**
 * taskflowd — multi-mount control clerk (process speech is not authority).
 */
export { startDaemon, type DaemonHandle, type DaemonOptions } from "./daemon.ts";
export { startUdsServer, udsRpc, PROTOCOL_MAJOR, type UdsServerHandle } from "./uds-server.ts";
