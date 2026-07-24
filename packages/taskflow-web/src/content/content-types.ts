export const WEB_CONTENT_LOCALES = ["en", "zh-CN"] as const;
export type WebContentLocale = (typeof WEB_CONTENT_LOCALES)[number];

export const WEB_CONTENT_SURFACES = ["simple", "pro", "shared"] as const;
export type WebContentSurface = (typeof WEB_CONTENT_SURFACES)[number];

export const WEB_CATALOG_ARGUMENT_KINDS = [
	"string",
	"string-list",
	"count",
	"timestamp",
	"capacity-reason",
	"blocking-reason",
	"recovery-action",
	"verification-reason",
] as const;
export type WebCatalogArgumentKind =
	(typeof WEB_CATALOG_ARGUMENT_KINDS)[number];

export type WebCatalogArgumentDefinition = {
	readonly name: string;
	readonly kind: WebCatalogArgumentKind;
};

export type WebContentTemplate =
	| string
	| {
			readonly kind: "plural";
			readonly arg: string;
			readonly one: string;
			readonly other: string;
	  }
	| {
			readonly kind: "select";
			readonly arg: string;
			readonly cases: Readonly<Record<string, string>>;
	  };

export type WebLocalizedCatalogEntry = {
	readonly args: readonly WebCatalogArgumentDefinition[];
	readonly surface: WebContentSurface;
	readonly values: Readonly<Record<WebContentLocale, WebContentTemplate>>;
};
