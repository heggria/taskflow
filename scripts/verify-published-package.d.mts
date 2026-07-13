export interface RegistryVerificationInput {
	pkg: { name: string; version: string };
	metadata: Record<string, unknown>;
	provenanceStatement: Record<string, unknown>;
	localIntegrity: string;
	trustedOwners: string[];
	expectedRepository: string;
	expectedRef: string;
	expectedSha?: string;
}

export function sha512Integrity(data: Uint8Array): string;
export function verifyRegistryIdentity(input: RegistryVerificationInput): string[];
