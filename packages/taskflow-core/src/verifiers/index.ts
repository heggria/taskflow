/**
 * Built-in verifiers barrel.
 *
 * Re-exports the shipped verifiers so hosts can import them from one place:
 *   import { scriptLintVerifier, builtinVerifiers } from "taskflow-core/verifiers";
 */

export { scriptLintVerifier } from "./script-lint.ts";
export { discoverVerifiers, listVerifierPaths, type DiscoveredVerifiers } from "./discover.ts";

import type { TaskflowVerifier } from "../verify.ts";
import { scriptLintVerifier } from "./script-lint.ts";

/** All built-in verifiers, in recommended registration order. */
export const builtinVerifiers: readonly TaskflowVerifier[] = [scriptLintVerifier];
