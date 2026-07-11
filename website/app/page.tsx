import type { Metadata } from "next";

const title = "taskflow — Declarative DAG Orchestration for Coding Agents";
const description =
	"A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command.";
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
