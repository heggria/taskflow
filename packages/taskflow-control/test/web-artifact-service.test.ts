import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	createControlHost,
	createWebArtifactHandlers,
	projectArtifactBlobsDir,
	projectArtifactMetadataDir,
	WEB_MAX_ARTIFACT_BYTES,
	WEB_MAX_INLINE_ARTIFACT_BYTES,
	webArtifactMayRenderInline,
	webArtifactWithinDownloadBudget,
	WebArtifactMetadataSchema,
	WebReadServiceError,
	type WebHandlerContext,
} from "../src/index.ts";

function context(): WebHandlerContext {
	return {
		requestId: "request-artifact",
		listenerId: "listener-artifact",
		principalId: "principal-artifact",
		principalDisplayName: "Artifact Tester",
		principalHash: `sha256:${"a".repeat(64)}`,
		observedAt: 1_800_000_000_000,
		sessionAbsoluteExpiresAt: 1_800_028_800_000,
	};
}

test("artifact policy freezes the exact 5 MiB inline and 100 MiB download boundaries", () => {
	assert.equal(
		webArtifactMayRenderInline({
			byteLength: WEB_MAX_INLINE_ARTIFACT_BYTES,
			mediaType: "text/plain; charset=utf-8",
			redactionClass: "public",
		}),
		true,
	);
	assert.equal(
		webArtifactMayRenderInline({
			byteLength: WEB_MAX_INLINE_ARTIFACT_BYTES + 1,
			mediaType: "text/plain; charset=utf-8",
			redactionClass: "public",
		}),
		false,
	);
	assert.equal(
		webArtifactMayRenderInline({
			byteLength: WEB_MAX_INLINE_ARTIFACT_BYTES,
			mediaType: "text/html; charset=utf-8",
			redactionClass: "public",
		}),
		false,
	);
	assert.equal(
		webArtifactMayRenderInline({
			byteLength: 1,
			mediaType: "image/png",
			redactionClass: "sensitive",
		}),
		false,
	);
	assert.equal(
		webArtifactWithinDownloadBudget(WEB_MAX_ARTIFACT_BYTES),
		true,
	);
	assert.equal(
		webArtifactWithinDownloadBudget(WEB_MAX_ARTIFACT_BYTES + 1),
		false,
	);
	for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(webArtifactWithinDownloadBudget(invalid), false);
	}
});

test("artifact service: current Receipt reachability, redaction, and pre-header integrity", async () => {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "tf-web-artifact-"),
	);
	const project = path.join(root, "project");
	const home = path.join(root, "home");
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	const host = createControlHost({
		projectRoot: project,
		controlMode: "standalone",
		skipSingleton: true,
		allowMockProvider: true,
		env: { ...process.env, TASKFLOW_HOME: home },
	});
	try {
		const admitted = await host.admitAndRun({
			commandId: "cmd-artifact-service",
			program: {
				name: "artifact-service",
				phases: [
					{
						id: "result",
						type: "script",
						run: "printf artifact-body",
						final: true,
					},
				],
			},
		});
		assert.equal(admitted.ok, true);
		assert.ok(admitted.run);
		assert.ok(admitted.receipt);
		const artifactId =
			admitted.receipt!.artifactRefs[0]!;
		const artifact = host.store.getArtifact(artifactId);
		assert.ok(artifact);
		const handlers = createWebArtifactHandlers(host);
		const input = {
			params: {
				projectId: host.projectId,
				controlDomainId: host.controlDomainId,
				digest: artifact!.digest,
			},
			query: {},
			body: {},
		};
		const disclosed = await handlers.artifact(
			input,
			context(),
		);
		assert.equal(
			Value.Check(
				WebArtifactMetadataSchema,
				disclosed.metadata,
			),
			true,
		);
		assert.equal(
			Buffer.from(disclosed.body).toString("utf8"),
			admitted.run!.finalOutput,
		);
		assert.equal(
			disclosed.metadata.contentDisposition,
			"inline",
		);

		const orphan = host.store.putArtifact({
			bytes: Buffer.from("orphan", "utf8"),
			mediaType: "text/plain; charset=utf-8",
			role: "orphan-output",
			redactionClass: "public",
			runId: admitted.run!.runId,
		});
		await assert.rejects(
			async () =>
				handlers.artifact(
					{
						...input,
						params: {
							...input.params,
							digest: orphan.digest,
						},
					},
					context(),
				),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code === "TF_NOT_FOUND",
		);

		const metadataPath = path.join(
			projectArtifactMetadataDir(project),
			`${artifactId}.json`,
		);
		const originalMetadata = JSON.parse(
			fs.readFileSync(metadataPath, "utf8"),
		) as Record<string, unknown>;
		fs.writeFileSync(
			metadataPath,
			JSON.stringify({
				...originalMetadata,
				redactionClass: "sensitive",
			}),
		);
		const sensitive = await handlers.artifact(
			input,
			context(),
		);
		assert.equal(
			sensitive.metadata.contentDisposition,
			"attachment",
		);

		for (const mediaType of [
			"text/plain; charset=utf-8",
			"application/json; charset=utf-8",
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
		]) {
			fs.writeFileSync(
				metadataPath,
				JSON.stringify({
					...originalMetadata,
					mediaType,
					fileName:
						"../../report\u202Ecod.exe\"\r\nInjected",
				}),
			);
			const inline = await handlers.artifact(
				input,
				context(),
			);
			assert.equal(inline.metadata.mediaType, mediaType);
			assert.equal(
				inline.metadata.contentDisposition,
				"inline",
			);
			assert.match(
				inline.metadata.fileName ?? "",
				/^[A-Za-z0-9._ -]{1,160}$/u,
			);
			assert.doesNotMatch(
				inline.metadata.fileName ?? "",
				/[/\\\r\n\u202A-\u202E\u2066-\u2069]/u,
			);
		}

		for (const mediaType of [
			"text/html; charset=utf-8",
			"image/svg+xml",
			"application/xhtml+xml",
			"application/javascript",
			"application/xml",
			"application/pdf",
			"video/mp4",
		]) {
			fs.writeFileSync(
				metadataPath,
				JSON.stringify({
					...originalMetadata,
					mediaType,
				}),
			);
			const attachment = await handlers.artifact(
				input,
				context(),
			);
			assert.equal(
				attachment.metadata.mediaType,
				"application/octet-stream",
				mediaType,
			);
			assert.equal(
				attachment.metadata.contentDisposition,
				"attachment",
				mediaType,
			);
		}

		fs.writeFileSync(
			metadataPath,
			JSON.stringify({
				...originalMetadata,
				redactionClass: "secret",
			}),
		);
		await assert.rejects(
			async () => handlers.artifact(input, context()),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_AUTHORITY_REVOKED",
		);

		fs.writeFileSync(
			metadataPath,
			JSON.stringify(originalMetadata),
		);
		fs.writeFileSync(
			path.join(
				projectArtifactBlobsDir(project),
				artifact!.digest.slice("sha256:".length),
			),
			"tampered",
		);
		await assert.rejects(
			async () => handlers.artifact(input, context()),
			(error: unknown) =>
				error instanceof WebReadServiceError &&
				error.controlError.code ===
					"TF_DURABILITY_FAILED",
		);
	} finally {
		host.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
