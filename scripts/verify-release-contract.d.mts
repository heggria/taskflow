export const STABLE_PACKAGE_NAMES: string[];
export function verifyReleaseContract(repo: string, options?: { published?: boolean }): { version: string; packages: string[]; npmTag: string };
export function releaseNpmTag(version: string): "beta" | "latest";
