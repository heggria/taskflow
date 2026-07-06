import type * as PageTree from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { source } from "@/lib/source";

function TaskflowLogo() {
	return (
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			className="text-fd-primary"
		>
			<circle cx="5" cy="12" r="3" fill="currentColor" />
			<circle cx="19" cy="6" r="3" fill="currentColor" />
			<circle cx="19" cy="18" r="3" fill="currentColor" />
			<path
				d="M5 12h7m0 0l3-4m-3 4l3 4"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function GitHubIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			className="size-4"
		>
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}

/**
 * Keep top-level doc sections expanded and disable their collapse trigger.
 * Nested folders remain collapsible so the sidebar stays scannable.
 */
function freezeTopLevelSections(root: PageTree.Root): PageTree.Root {
	return {
		...root,
		children: root.children.map((node) =>
			node.type === "folder" ? { ...node, collapsible: false } : node,
		),
	};
}

export default async function DocsLayoutPage({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ lang: string }>;
}) {
	const { lang } = await params;
	const tree = freezeTopLevelSections(source.pageTree[lang]);

	return (
		<DocsLayout
			tree={tree}
			nav={{
				title: (
					<div className="inline-flex items-center gap-2 text-[0.9375rem] font-semibold">
						<TaskflowLogo />
						<span>taskflow</span>
					</div>
				),
				url: `/${lang}`,
				transparentMode: "none",
			}}
			links={[
				{
					type: "icon",
					label: "GitHub",
					icon: <GitHubIcon />,
					text: "GitHub",
					url: "https://github.com/heggria/taskflow",
					external: true,
				},
				{
					type: "icon",
					label: "Discussions",
					icon: <MessageSquare className="size-4" />,
					text: "Discussions",
					url: "https://github.com/heggria/taskflow/discussions",
					external: true,
				},
			]}
			sidebar={{
				defaultOpenLevel: 1,
				banner: (
					<Link
						href={`/${lang}/docs/templates`}
						className="block rounded-lg border bg-fd-card p-3 text-sm transition-colors hover:bg-fd-accent"
					>
						<span className="inline-flex items-center rounded-full bg-fd-primary/10 px-2 py-0.5 text-xs font-medium text-fd-primary">
							New
						</span>
						<span className="mt-1 block font-medium text-fd-card-foreground">
							Templates
						</span>
						<span className="text-fd-muted-foreground">
							Browse ready-to-run taskflow examples.
						</span>
					</Link>
				),
			}}
			i18n
		>
			{children}
		</DocsLayout>
	);
}
