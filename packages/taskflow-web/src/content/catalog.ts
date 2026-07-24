import {
	WEB_BLOCKING_REASON_CODES,
	WEB_CAPACITY_REASON_CODES,
	WEB_CONTENT_CATALOG_VERSION,
	WEB_DEFAULT_LOCALE,
	WEB_PROJECTED_CONTENT_ARGUMENTS,
	WEB_PROJECTED_CONTENT_KEYS,
	WEB_SUPPORTED_LOCALES,
	WEB_VERIFICATION_REASON_CODES,
	type WebContentArg,
	type WebContentMessage,
	type WebProjectedContentKey,
} from "taskflow-control/web-presentation-schema";
import { RECOVERY_ACTIONS } from "taskflow-control/types";
import {
	WEB_CATALOG_ARGUMENT_KINDS,
	WEB_CONTENT_LOCALES,
	type WebCatalogArgumentDefinition,
	type WebCatalogArgumentKind,
	type WebContentLocale,
	type WebContentTemplate,
	type WebLocalizedCatalogEntry,
} from "./content-types.ts";
import { WEB_PROJECTED_CONTENT_CATALOG } from "./projected-catalog.ts";
import {
	WEB_STATIC_CONTENT_KEYS,
	WEB_STATIC_CONTENT_REGISTRY,
	type WebStaticContentKey,
} from "./static-keys.ts";

export { WEB_CONTENT_LOCALES };
export { WEB_PROJECTED_CONTENT_CATALOG };
export { WEB_STATIC_CONTENT_KEYS, WEB_STATIC_CONTENT_REGISTRY };
export type {
	WebCatalogArgumentDefinition,
	WebCatalogArgumentKind,
	WebContentLocale,
	WebContentTemplate,
	WebLocalizedCatalogEntry,
	WebStaticContentKey,
};

export const WEB_SIMPLE_FORBIDDEN_TERMS = {
	en: [
		"RunStatus",
		"RunStage",
		"Receipt",
		"CAS",
		"commitSeq",
		"watermark",
		"reservation",
		"reconcile",
		"provider",
		"ControlStore",
		"BoundPlan",
	],
	"zh-CN": [
		"控制存储",
		"回执",
		"水位",
		"预留",
		"对账",
		"提供商",
		"绑定计划",
		"提交序号",
	],
} as const satisfies Record<WebContentLocale, readonly string[]>;

export const WEB_DISALLOWED_VOICE_PATTERNS = {
	en: [
		/\bdon['’]?t worry\b/iu,
		/\boops\b/iu,
		/\bwe feel\b/iu,
		/\bi feel\b/iu,
		/\bwill be (?:done|ready) (?:soon|shortly)\b/iu,
	],
	"zh-CN": [/别担心/u, /糟糕/u, /马上就好/u, /很快就会/u, /我(?:感到|觉得)/u],
} as const satisfies Record<WebContentLocale, readonly RegExp[]>;

export type WebCombinedContentKey =
	| WebProjectedContentKey
	| WebStaticContentKey;

export const WEB_COMBINED_CONTENT_KEYS = Object.freeze(
	[...WEB_PROJECTED_CONTENT_KEYS, ...WEB_STATIC_CONTENT_KEYS].sort((a, b) =>
		a.localeCompare(b, "en"),
	),
) as readonly WebCombinedContentKey[];

type RuntimeArgument = string | readonly string[] | number;
export type WebStaticContentArguments = Readonly<
	Record<string, RuntimeArgument>
>;

export type WebContentFormatOptions = {
	readonly timeZone?: string;
};

const PLACEHOLDER =
	/\{([A-Za-z][A-Za-z0-9]*)(?:,\s*(number|datetime))?\}/gu;

function templateStrings(template: WebContentTemplate): readonly string[] {
	if (typeof template === "string") return [template];
	if (template.kind === "plural") return [template.one, template.other];
	return Object.values(template.cases);
}

function enumValues(kind: WebCatalogArgumentKind): readonly string[] | undefined {
	switch (kind) {
		case "capacity-reason":
			return WEB_CAPACITY_REASON_CODES;
		case "blocking-reason":
			return WEB_BLOCKING_REASON_CODES;
		case "recovery-action":
			return RECOVERY_ACTIONS;
		case "verification-reason":
			return WEB_VERIFICATION_REASON_CODES;
		default:
			return undefined;
	}
}

function assertArgumentDefinitions(
	key: string,
	args: readonly WebCatalogArgumentDefinition[],
): void {
	const names = args.map((arg) => arg.name);
	const sorted = [...names].sort((a, b) => a.localeCompare(b, "en"));
	if (
		new Set(names).size !== names.length ||
		names.some((name, index) => name !== sorted[index])
	) {
		throw new TypeError(`${key}: catalog arguments must be unique and sorted`);
	}
	for (const arg of args) {
		if (
			!WEB_CATALOG_ARGUMENT_KINDS.includes(
				arg.kind as (typeof WEB_CATALOG_ARGUMENT_KINDS)[number],
			)
		) {
			throw new TypeError(`${key}: unknown argument kind ${arg.kind}`);
		}
	}
}

function assertTemplate(
	key: string,
	locale: WebContentLocale,
	template: WebContentTemplate,
	args: readonly WebCatalogArgumentDefinition[],
): void {
	const definitions = new Map(args.map((arg) => [arg.name, arg.kind]));
	const referenced = new Set<string>();
	if (typeof template !== "string") {
		const selectorKind = definitions.get(template.arg);
		if (!selectorKind) {
			throw new TypeError(
				`${key}/${locale}: selector argument ${template.arg} is not declared`,
			);
		}
		referenced.add(template.arg);
		if (template.kind === "plural") {
			if (selectorKind !== "count") {
				throw new TypeError(
					`${key}/${locale}: plural selector must use a count argument`,
				);
			}
		} else {
			const expectedCases = enumValues(selectorKind);
			if (!expectedCases) {
				throw new TypeError(
					`${key}/${locale}: select requires a closed enum argument`,
				);
			}
			const actualCases = Object.keys(template.cases);
			const missing = expectedCases.filter(
				(value) => !actualCases.includes(value),
			);
			const extra = actualCases.filter(
				(value) => !expectedCases.includes(value),
			);
			if (missing.length > 0 || extra.length > 0) {
				throw new TypeError(
					`${key}/${locale}: select cases mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`,
				);
			}
		}
	}

	for (const text of templateStrings(template)) {
		if (
			/<\/?[A-Za-z][^>]*>/u.test(text) ||
			/javascript:/iu.test(text) ||
			/https?:\/\//iu.test(text)
		) {
			throw new TypeError(`${key}/${locale}: executable or remote markup`);
		}
		for (const match of text.matchAll(PLACEHOLDER)) {
			const [, name, formatter] = match;
			const kind = definitions.get(name!);
			if (!kind) {
				throw new TypeError(
					`${key}/${locale}: template uses undeclared argument ${name}`,
				);
			}
			if (formatter === "number" && kind !== "count") {
				throw new TypeError(
					`${key}/${locale}: ${name} is not a count argument`,
				);
			}
			if (formatter === "datetime" && kind !== "timestamp") {
				throw new TypeError(
					`${key}/${locale}: ${name} is not a timestamp argument`,
				);
			}
			if (kind === "count" && formatter !== "number") {
				throw new TypeError(
					`${key}/${locale}: count argument ${name} requires number formatting`,
				);
			}
			if (kind === "timestamp" && formatter !== "datetime") {
				throw new TypeError(
					`${key}/${locale}: timestamp argument ${name} requires datetime formatting`,
				);
			}
			if (enumValues(kind)) {
				throw new TypeError(
					`${key}/${locale}: enum argument ${name} cannot be rendered raw`,
				);
			}
			referenced.add(name!);
		}
	}
	const unused = args.filter((arg) => !referenced.has(arg.name));
	if (unused.length > 0) {
		throw new TypeError(
			`${key}/${locale}: unused catalog arguments ${unused.map((arg) => arg.name).join(",")}`,
		);
	}
}

function termPattern(term: string): RegExp {
	return /^[A-Za-z][A-Za-z0-9-]*$/u.test(term)
		? new RegExp(`\\b${term}\\b`, "iu")
		: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

export function lintSimpleWebContent(
	locale: WebContentLocale,
	text: string,
): readonly string[] {
	const violations: string[] = [];
	for (const term of WEB_SIMPLE_FORBIDDEN_TERMS[locale]) {
		if (termPattern(term).test(text)) violations.push(`internal-term:${term}`);
	}
	for (const pattern of WEB_DISALLOWED_VOICE_PATTERNS[locale]) {
		if (pattern.test(text)) violations.push(`voice:${pattern.source}`);
	}
	return violations;
}

function assertSimpleCopy(
	key: string,
	entry: WebLocalizedCatalogEntry,
): void {
	if (entry.surface === "pro") return;
	for (const locale of WEB_CONTENT_LOCALES) {
		for (const text of templateStrings(entry.values[locale])) {
			const violations = lintSimpleWebContent(locale, text);
			if (violations.length > 0) {
				throw new TypeError(
					`${key}/${locale}: Simple content violations ${violations.join(",")}`,
				);
			}
		}
	}
}

function assertCatalogEntry(
	key: string,
	entry: WebLocalizedCatalogEntry,
): void {
	assertArgumentDefinitions(key, entry.args);
	for (const locale of WEB_CONTENT_LOCALES) {
		const template = entry.values[locale];
		if (template === undefined) {
			throw new TypeError(`${key}: missing complete ${locale} catalog value`);
		}
		assertTemplate(key, locale, template, entry.args);
	}
	assertSimpleCopy(key, entry);
}

export function assertWebContentCatalogsValid(): void {
	if (
		WEB_CONTENT_CATALOG_VERSION !== "taskflow-content.v1" ||
		WEB_DEFAULT_LOCALE !== "en" ||
		WEB_SUPPORTED_LOCALES.length !== WEB_CONTENT_LOCALES.length ||
		WEB_SUPPORTED_LOCALES.some(
			(locale, index) => locale !== WEB_CONTENT_LOCALES[index],
		)
	) {
		throw new TypeError("P17 catalog version or locale registry drift");
	}
	const projectedKeys = Object.keys(WEB_PROJECTED_CONTENT_CATALOG).sort((a, b) =>
		a.localeCompare(b, "en"),
	);
	const expectedProjected = [...WEB_PROJECTED_CONTENT_KEYS].sort((a, b) =>
		a.localeCompare(b, "en"),
	);
	if (
		projectedKeys.length !== expectedProjected.length ||
		projectedKeys.some((key, index) => key !== expectedProjected[index])
	) {
		throw new TypeError("projected catalog keyset drift");
	}
	if (
		new Set(WEB_COMBINED_CONTENT_KEYS).size !==
		WEB_PROJECTED_CONTENT_KEYS.length + WEB_STATIC_CONTENT_KEYS.length
	) {
		throw new TypeError("projected and static content keys overlap");
	}
	for (const key of WEB_PROJECTED_CONTENT_KEYS) {
		const entry = WEB_PROJECTED_CONTENT_CATALOG[key];
		const expectedArgs = WEB_PROJECTED_CONTENT_ARGUMENTS[key];
		if (
			entry.args.length !== expectedArgs.length ||
			entry.args.some((arg, index) => arg.name !== expectedArgs[index])
		) {
			throw new TypeError(`${key}: projection/catalog argument drift`);
		}
		assertCatalogEntry(key, entry);
	}
	for (const key of WEB_STATIC_CONTENT_KEYS) {
		assertCatalogEntry(key, WEB_STATIC_CONTENT_REGISTRY[key]);
	}
}

function assertRuntimeArgument(
	key: string,
	definition: WebCatalogArgumentDefinition,
	value: RuntimeArgument | undefined,
): asserts value is RuntimeArgument {
	if (value === undefined) {
		throw new TypeError(`${key}: missing content argument ${definition.name}`);
	}
	switch (definition.kind) {
		case "count":
		case "timestamp":
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0
			) {
				throw new TypeError(`${key}: ${definition.name} must be a safe integer`);
			}
			return;
		case "string-list":
			if (
				!Array.isArray(value) ||
				value.some((item) => typeof item !== "string")
			) {
				throw new TypeError(`${key}: ${definition.name} must be a string list`);
			}
			return;
		case "capacity-reason":
		case "blocking-reason":
		case "recovery-action":
		case "verification-reason": {
			if (
				typeof value !== "string" ||
				!enumValues(definition.kind)?.includes(value)
			) {
				throw new TypeError(`${key}: invalid ${definition.name}`);
			}
			return;
		}
		case "string":
			if (typeof value !== "string") {
				throw new TypeError(`${key}: ${definition.name} must be text`);
			}
			return;
	}
}

function formatTemplate(
	key: string,
	locale: WebContentLocale,
	template: WebContentTemplate,
	definitions: readonly WebCatalogArgumentDefinition[],
	values: WebStaticContentArguments,
	options: WebContentFormatOptions,
): string {
	for (const definition of definitions) {
		assertRuntimeArgument(key, definition, values[definition.name]);
	}
	const extra = Object.keys(values).filter(
		(name) => !definitions.some((definition) => definition.name === name),
	);
	if (extra.length > 0) {
		throw new TypeError(`${key}: unexpected content arguments ${extra.join(",")}`);
	}

	let selected: string;
	if (typeof template === "string") {
		selected = template;
	} else if (template.kind === "plural") {
		const value = values[template.arg];
		if (typeof value !== "number") {
			throw new TypeError(`${key}: plural argument ${template.arg} is invalid`);
		}
		selected =
			new Intl.PluralRules(locale).select(value) === "one"
				? template.one
				: template.other;
	} else {
		const value = values[template.arg];
		if (typeof value !== "string" || !template.cases[value]) {
			throw new TypeError(`${key}: select argument ${template.arg} is invalid`);
		}
		selected = template.cases[value];
	}

	const definitionsByName = new Map(
		definitions.map((definition) => [definition.name, definition]),
	);
	return selected.replace(
		PLACEHOLDER,
		(_whole, name: string, formatter: string | undefined) => {
			const definition = definitionsByName.get(name);
			const value = values[name];
			if (!definition || value === undefined) {
				throw new TypeError(`${key}: formatter argument ${name} is invalid`);
			}
			if (formatter === "number" && typeof value === "number") {
				return new Intl.NumberFormat(locale).format(value);
			}
			if (formatter === "datetime" && typeof value === "number") {
				return new Intl.DateTimeFormat(locale, {
					dateStyle: "medium",
					timeStyle: "short",
					timeZone: options.timeZone ?? "UTC",
				}).format(value);
			}
			if (Array.isArray(value)) {
				return new Intl.ListFormat(locale, {
					style: "long",
					type: "conjunction",
				}).format([...value]);
			}
			if (typeof value === "string") return value;
			throw new TypeError(`${key}: formatter argument ${name} needs a format`);
		},
	);
}

function projectedArgumentValues(
	message: WebContentMessage,
): WebStaticContentArguments {
	return Object.fromEntries(
		message.args.map((arg: WebContentArg) => [arg.name, arg.value]),
	);
}

export function formatWebContentMessage(
	message: WebContentMessage,
	locale: WebContentLocale,
	options: WebContentFormatOptions = {},
): string {
	if (message.catalogVersion !== WEB_CONTENT_CATALOG_VERSION) {
		throw new TypeError(
			`unsupported content catalog ${message.catalogVersion as string}`,
		);
	}
	const entry = WEB_PROJECTED_CONTENT_CATALOG[message.key];
	if (!entry) throw new TypeError(`unknown projected content key ${message.key}`);
	return formatTemplate(
		message.key,
		locale,
		entry.values[locale],
		entry.args,
		projectedArgumentValues(message),
		options,
	);
}

export function formatWebStaticContent(
	key: WebStaticContentKey,
	locale: WebContentLocale,
	args: WebStaticContentArguments = {},
	options: WebContentFormatOptions = {},
): string {
	const entry = WEB_STATIC_CONTENT_REGISTRY[key];
	if (!entry) throw new TypeError(`unknown static content key ${key as string}`);
	return formatTemplate(key, locale, entry.values[locale], entry.args, args, options);
}

export function selectWebContentLocale(
	preferredLocales: readonly string[],
	override?: string,
): WebContentLocale {
	const candidates = override === undefined ? preferredLocales : [override];
	for (const candidate of candidates) {
		let canonical: string;
		try {
			[canonical] = Intl.getCanonicalLocales(candidate);
		} catch {
			continue;
		}
		if (canonical === "en" || canonical === "zh-CN") return canonical;
		const primary = canonical.split("-")[0]?.toLowerCase();
		if (primary === "en") return "en";
		if (primary === "zh") return "zh-CN";
	}
	return WEB_DEFAULT_LOCALE;
}

export function webContentCanonicalMaterial(): {
	readonly version: typeof WEB_CONTENT_CATALOG_VERSION;
	readonly projectedRegistry: readonly unknown[];
	readonly staticRegistry: readonly unknown[];
	readonly combinedKeys: readonly string[];
	readonly catalogs: Readonly<Record<WebContentLocale, readonly unknown[]>>;
} {
	const projectedRegistry = WEB_PROJECTED_CONTENT_KEYS.map((key) => ({
		key,
		args: WEB_PROJECTED_CONTENT_CATALOG[key].args,
		surface: WEB_PROJECTED_CONTENT_CATALOG[key].surface,
	}));
	const staticRegistry = WEB_STATIC_CONTENT_KEYS.map((key) => ({
		key,
		args: WEB_STATIC_CONTENT_REGISTRY[key].args,
		surface: WEB_STATIC_CONTENT_REGISTRY[key].surface,
	}));
	const catalogs = Object.fromEntries(
		WEB_CONTENT_LOCALES.map((locale) => [
			locale,
			WEB_COMBINED_CONTENT_KEYS.map((key) => {
				const entry =
					key in WEB_PROJECTED_CONTENT_CATALOG
						? WEB_PROJECTED_CONTENT_CATALOG[
								key as WebProjectedContentKey
							]
						: WEB_STATIC_CONTENT_REGISTRY[key as WebStaticContentKey];
				return { key, args: entry.args, value: entry.values[locale] };
			}),
		]),
	) as unknown as Record<WebContentLocale, readonly unknown[]>;
	return {
		version: WEB_CONTENT_CATALOG_VERSION,
		projectedRegistry,
		staticRegistry,
		combinedKeys: WEB_COMBINED_CONTENT_KEYS,
		catalogs,
	};
}

// Missing keys, invalid arguments, unsafe Simple copy, or malformed templates
// fail the package at build/startup rather than leaking raw keys at runtime.
assertWebContentCatalogsValid();
