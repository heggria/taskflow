"use client";

import { useState } from "react";
import Link from "next/link";

export type HostId = "pi" | "codex" | "claude" | "opencode" | "grok" | "hermes";

const HOSTS: { id: HostId; label: string; command: string; guide: string }[] = [
	{
		id: "pi",
		label: "Pi",
		command: "pi install npm:pi-taskflow",
		guide: "/docs/getting-started",
	},
	{
		id: "codex",
		label: "Codex",
		command:
			"codex plugin marketplace add heggria/taskflow && codex plugin add taskflow@taskflow",
		guide: "/docs/getting-started",
	},
	{
		id: "claude",
		label: "Claude Code",
		command:
			"claude plugin marketplace add heggria/taskflow && claude plugin install claude-taskflow@taskflow",
		guide: "/docs/getting-started",
	},
	{
		id: "opencode",
		label: "OpenCode",
		command:
			"opencode mcp add taskflow -- npx -y -p opencode-taskflow opencode-taskflow-mcp",
		guide: "/docs/getting-started",
	},
	{
		id: "grok",
		label: "Grok",
		command:
			"grok mcp add taskflow -- npx -y -p grok-taskflow grok-taskflow-mcp",
		guide: "/docs/getting-started",
	},
	{
		id: "hermes",
		label: "Hermes",
		command:
			"hermes mcp add taskflow --command npx --args -y -p hermes-taskflow@0.2.10 hermes-taskflow-mcp",
		guide: "/docs/guides/hermes",
	},
];

export function InstallRail({
	lang,
	labels,
}: {
	lang: "en" | "zh-cn";
	labels: {
		copy: string;
		copied: string;
		guide: string;
	};
}) {
	const [active, setActive] = useState<HostId>("pi");
	const [copied, setCopied] = useState(false);
	const current = HOSTS.find((h) => h.id === active);

	if (!current) {
		return null;
	}

	const onCopy = async () => {
		try {
			await navigator.clipboard.writeText(current.command);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		} catch {
			/* ignore */
		}
	};

	return (
		<div className="install-rail">
			<div className="install-rail__tabs" role="tablist" aria-label="Host">
				{HOSTS.map((host) => (
					<button
						key={host.id}
						type="button"
						className="install-rail__tab"
						data-active={host.id === active}
						role="tab"
						aria-selected={host.id === active}
						onClick={() => setActive(host.id)}
					>
						{host.label}
					</button>
				))}
			</div>

			<div className="install-rail__body">
				<div className="install-rail__command">
					<code>{current.command}</code>
				</div>
				<div className="install-rail__actions">
					<button type="button" className="install-rail__copy" onClick={onCopy}>
						{copied ? labels.copied : labels.copy}
					</button>
					<Link className="install-rail__guide" href={`/${lang}${current.guide}`}>
						{labels.guide}
					</Link>
				</div>
			</div>
		</div>
	);
}
