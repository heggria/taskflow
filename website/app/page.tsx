import type { Metadata } from "next";

const title = "taskflow 0.3 — Trusted Effects for Coding Agents";
const description =
	"Declare coding-agent effects, verify typed paths, and commit admitted filesystem changes through one resource authority. 0.3.0-beta.2; beta channel and not GA.";
const canonical = "https://heggria.github.io/taskflow/en/";

export const metadata: Metadata = {
	title,
	description,
	alternates: { canonical },
	openGraph: {
		title,
		description,
		type: "website",
		url: canonical,
		images: [`${canonical}opengraph-image`],
	},
	twitter: {
		card: "summary_large_image",
		title,
		description,
		images: [`${canonical}opengraph-image`],
	},
	verification: { google: "iBm6KBJfiBJLOmW6jAtJCJlCbTiP7W9PhrDW6afMltw" },
};

export default function RootPage() {
	return <meta httpEquiv="refresh" content="0; url=./en/" />;
}
