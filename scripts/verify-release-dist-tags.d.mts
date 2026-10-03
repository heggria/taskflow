export function verifyReleaseDistTags(version: string, npmTag: string, queryTags?: (name: string) => unknown): { version: string; npmTag: string; verified: string[] };
