import { I18nProvider } from "fumadocs-ui/contexts/i18n";
import type { Viewport } from "next";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/i18n";

export function generateStaticParams() {
	return i18n.languages.map((lang) => ({ lang }));
}

const site = {
	en: {
		title: "taskflow 0.3.0-beta.1.1 — Trusted Effects beta",
		brand: "taskflow",
		description:
		"Declare coding-agent effects, verify typed paths, and commit admitted filesystem changes through one resource authority. 0.3.0-beta.1.1; beta channel and not GA.",
	},
	"zh-cn": {
		title: "taskflow 0.3.0-beta.1.1 — Trusted Effects beta",
		brand: "taskflow",
		description:
			"声明 coding-agent effect，验证类型化路径，让已准入的文件修改经过唯一 resource authority。0.3.0-beta.1.1，beta channel，尚未 GA。",
	},
} as const;

const GOOGLE_SITE_VERIFICATION =
	process.env.GOOGLE_SITE_VERIFICATION ||
	"iBm6KBJfiBJLOmW6jAtJCJlCbTiP7W9PhrDW6afMltw";

const base = process.env.TASKFLOW_BASE_PATH || "";

export async function generateMetadata({
	params,
}: {
	params: Promise<{ lang: Locale }>;
}) {
	const { lang } = await params;
	const meta = site[lang] ?? site.en;

	return {
		metadataBase: new URL("https://heggria.github.io/taskflow"),
		title: {
			default: meta.title,
			template: `%s | ${meta.brand}`,
		},
		description: meta.description,
		alternates: {
			canonical: `/${lang}/`,
			languages: {
				en: "/en/",
				"zh-CN": "/zh-cn/",
				"x-default": "/en/",
			},
		},
		icons: {
			icon: [{ url: `${base}/favicon.svg`, type: "image/svg+xml" }],
			apple: [
				{ url: `${base}/apple-icon`, sizes: "180x180", type: "image/png" },
			],
		},
		appleWebApp: {
			title: "taskflow",
			statusBarStyle: "default" as const,
			capable: true,
		},
		manifest: `${base}/manifest.webmanifest`,
		verification: GOOGLE_SITE_VERIFICATION
			? { google: GOOGLE_SITE_VERIFICATION }
			: undefined,
		openGraph: {
			title: meta.title,
			description: meta.description,
			images: "/opengraph-image",
		},
		twitter: {
			card: "summary_large_image" as const,
			title: meta.title,
			description: meta.description,
			images: "/opengraph-image",
		},
	};
}

export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f8f6f1" },
		{ media: "(prefers-color-scheme: dark)", color: "#0f1115" },
	],
};

export default async function LangLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	return <I18nProvider {...i18n.provider(lang)}>{children}</I18nProvider>;
}
