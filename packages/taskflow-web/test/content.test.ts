import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import {
	WEB_CONTENT_CATALOG_VERSION,
	WEB_PROJECTED_CONTENT_ARGUMENTS,
	WEB_PROJECTED_CONTENT_KEYS,
	WebContentMessageSchema,
	type WebContentMessage,
} from "taskflow-control/web-presentation-schema";
import {
	WEB_COMBINED_CONTENT_KEYS,
	WEB_CONTENT_LOCALES,
	WEB_PROJECTED_CONTENT_CATALOG,
	WEB_SIMPLE_FORBIDDEN_TERMS,
	WEB_STATIC_CONTENT_KEYS,
	WEB_STATIC_CONTENT_REGISTRY,
	assertWebContentCatalogsValid,
	formatWebContentMessage,
	formatWebStaticContent,
	lintSimpleWebContent,
	selectWebContentLocale,
	webContentCanonicalMaterial,
} from "../src/content/catalog.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(
	testDir,
	"../../taskflow-control/test/fixtures/web-v1/reference",
);
const referenceManifestPath = path.resolve(
	testDir,
	"../../../docs/internal/webui/reference-set-v1/manifest.json",
);

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
		.join(",")}}`;
}

function sha256(value: unknown): string {
	return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function visitContentMessages(
	value: unknown,
	visit: (message: WebContentMessage) => void,
): void {
	if (Array.isArray(value)) {
		for (const item of value) visitContentMessages(item, visit);
		return;
	}
	if (value === null || typeof value !== "object") return;
	if (Value.Check(WebContentMessageSchema, value)) {
		visit(value as WebContentMessage);
		return;
	}
	for (const child of Object.values(value)) visitContentMessages(child, visit);
}

test("content catalogs are complete, closed, bilingual, and startup-valid", () => {
	assert.doesNotThrow(() => assertWebContentCatalogsValid());
	assert.equal(Object.keys(WEB_PROJECTED_CONTENT_CATALOG).length, 149);
	assert.equal(WEB_PROJECTED_CONTENT_KEYS.length, 149);
	assert.equal(WEB_STATIC_CONTENT_KEYS.length, 188);
	assert.equal(WEB_COMBINED_CONTENT_KEYS.length, 337);
	assert.equal(new Set(WEB_COMBINED_CONTENT_KEYS).size, 337);
	assert.deepEqual(WEB_CONTENT_LOCALES, ["en", "zh-CN"]);
	const material = webContentCanonicalMaterial();
	assert.equal(material.projectedRegistry.length, 149);
	assert.equal(material.staticRegistry.length, 188);
	assert.equal(material.catalogs.en.length, 337);
	assert.equal(material.catalogs["zh-CN"].length, 337);
});

test("reference manifest binds exact registry and locale-catalog digests", () => {
	const manifest = JSON.parse(
		fs.readFileSync(referenceManifestPath, "utf8"),
	) as {
		contentCatalogs: {
			version: string;
			keysetDigests: {
				projected: string;
				static: string;
				combined: string;
			};
			catalogDigests: Record<"en" | "zh-CN", string>;
		};
		screens: Array<{ staticContentKeys: string[] }>;
	};
	const material = webContentCanonicalMaterial();
	assert.equal(manifest.contentCatalogs.version, WEB_CONTENT_CATALOG_VERSION);
	assert.deepEqual(manifest.contentCatalogs.keysetDigests, {
		projected: sha256(material.projectedRegistry),
		static: sha256(material.staticRegistry),
		combined: sha256(material.combinedKeys),
	});
	assert.deepEqual(manifest.contentCatalogs.catalogDigests, {
		en: sha256(material.catalogs.en),
		"zh-CN": sha256(material.catalogs["zh-CN"]),
	});
	assert.equal(manifest.screens.length, 9);
	for (const screen of manifest.screens) {
		assert.ok(screen.staticContentKeys.length > 0);
		for (const key of screen.staticContentKeys) {
			assert.ok(
				WEB_STATIC_CONTENT_KEYS.includes(
					key as (typeof WEB_STATIC_CONTENT_KEYS)[number],
				),
				key,
			);
		}
	}
});

test("WebContentMessage codec enforces the exact key-specific argument tuple", () => {
	const valid: WebContentMessage = {
		catalogVersion: WEB_CONTENT_CATALOG_VERSION,
		key: "task.working.one.detail",
		args: [
			{ name: "activeStepCount", value: 1 },
			{ name: "activeStepLabels", value: ["Check tests"] },
		],
	};
	assert.equal(Value.Check(WebContentMessageSchema, valid), true);
	assert.equal(
		Value.Check(WebContentMessageSchema, {
			...valid,
			args: [{ name: "activeStepLabels", value: ["Check tests"] }],
		}),
		false,
	);
	assert.equal(
		Value.Check(WebContentMessageSchema, {
			...valid,
			args: [...valid.args].reverse(),
		}),
		false,
	);
	assert.equal(
		Value.Check(WebContentMessageSchema, {
			...valid,
			args: [...valid.args, { name: "workspaceCount", value: 2 }],
		}),
		false,
	);
	assert.deepEqual(WEB_PROJECTED_CONTENT_ARGUMENTS[valid.key], [
		"activeStepCount",
		"activeStepLabels",
	]);
});

test("every projected reference message renders in both locales without raw keys", () => {
	let messageCount = 0;
	for (const file of fs.readdirSync(fixtureRoot).sort()) {
		const fixture = JSON.parse(
			fs.readFileSync(path.join(fixtureRoot, file), "utf8"),
		) as unknown;
		visitContentMessages(fixture, (message) => {
			messageCount += 1;
			for (const locale of WEB_CONTENT_LOCALES) {
				const rendered = formatWebContentMessage(message, locale, {
					timeZone: "UTC",
				});
				assert.ok(rendered.length > 0, `${file}/${message.key}/${locale}`);
				assert.notEqual(rendered, message.key);
				assert.deepEqual(
					lintSimpleWebContent(locale, rendered),
					[],
					`${file}/${message.key}/${locale}`,
				);
			}
		});
	}
	assert.ok(messageCount >= 40);
});

test("formatter handles plural, list, number, date, and closed enum selection", () => {
	assert.equal(
		formatWebStaticContent("summary.task-count", "en", { count: 1 }),
		"1 task",
	);
	assert.equal(
		formatWebStaticContent("summary.task-count", "en", { count: 2 }),
		"2 tasks",
	);
	assert.match(
		formatWebStaticContent(
			"settings.session-expires",
			"en",
			{ expiresAt: 1_800_000_000_000 },
			{ timeZone: "UTC" },
		),
		/^Session ends /u,
	);
	assert.equal(
		formatWebContentMessage(
			{
				catalogVersion: WEB_CONTENT_CATALOG_VERSION,
				key: "task.working.many.detail",
				args: [
					{ name: "activeStepCount", value: 2 },
					{ name: "activeStepLabels", value: ["Check tests", "Build app"] },
				],
			},
			"en",
		),
		"Taskflow is working on 2 steps: Check tests and Build app. You do not need to do anything right now.",
	);
	assert.match(
		formatWebContentMessage(
			{
				catalogVersion: WEB_CONTENT_CATALOG_VERSION,
				key: "task.waiting.capacity.detail",
				args: [{ name: "capacityReason", value: "capacity-full" }],
			},
			"zh-CN",
		),
		/当前并发任务已满/u,
	);
});

test("locale selection is exact, closed, memory-only input with fixed primary map", () => {
	assert.equal(selectWebContentLocale(["fr-FR", "zh-Hant"]), "zh-CN");
	assert.equal(selectWebContentLocale(["en-GB"]), "en");
	assert.equal(selectWebContentLocale(["fr-FR"]), "en");
	assert.equal(selectWebContentLocale(["zh-CN"], "en-US"), "en");
	assert.equal(selectWebContentLocale(["en"], "not_a_locale"), "en");
});

test("Simple and shared catalogs exclude internal terms while Pro retains diagnostics", () => {
	for (const [key, entry] of Object.entries(WEB_STATIC_CONTENT_REGISTRY)) {
		if (entry.surface === "pro") continue;
		for (const locale of WEB_CONTENT_LOCALES) {
			for (const forbidden of WEB_SIMPLE_FORBIDDEN_TERMS[locale]) {
				assert.doesNotMatch(
					JSON.stringify(entry.values[locale]),
					new RegExp(forbidden, locale === "en" ? "iu" : "u"),
					`${key}/${locale}`,
				);
			}
		}
	}
	assert.equal(
		formatWebStaticContent("pro.source.control-store", "en"),
		"ControlStore",
	);
	assert.throws(
		() =>
			formatWebStaticContent(
				"summary.task-count",
				"en",
				{} as never,
			),
		/missing content argument count/u,
	);
});
