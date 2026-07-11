"use client";

import { useState } from "react";

type ViewId = "json" | "ts" | "flowir";

function CodeLine({ code, lang }: { code: string; lang: ViewId }) {
	const lines = code.split("\n");
	const seen = new Map<string, number>();
	const keyedLines = lines.map((line) => {
		const count = (seen.get(line) ?? 0) + 1;
		seen.set(line, count);
		return { key: `${lang}-${line}-${count}`, line };
	});
	return (
		<pre className="home-code-sample">
			<code>
				{keyedLines.map(({ key, line }, i) => (
					<div key={key} className="home-code-sample__line">
						<span className="home-code-sample__no">{i + 1}</span>
						<span className="home-code-sample__text">{line}</span>
					</div>
				))}
			</code>
		</pre>
	);
}

export function AuthoringSwitcher({
	labels,
	jsonCode,
	tsCode,
	flowirCode,
}: {
	labels: {
		json: string;
		ts: string;
		flowir: string;
		noteTitle: string;
		notes: ReadonlyArray<string>;
	};
	jsonCode: string;
	tsCode: string;
	flowirCode: string;
}) {
	const [view, setView] = useState<ViewId>("json");

	const code = view === "json" ? jsonCode : view === "ts" ? tsCode : flowirCode;

	return (
		<div className="authoring-switcher">
			<div className="authoring-switcher__top">
				<div
					className="authoring-switcher__tabs"
					role="tablist"
					aria-label={labels.noteTitle}
				>
					{(
						[
							["json", labels.json],
							["ts", labels.ts],
							["flowir", labels.flowir],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							className="authoring-switcher__tab"
							data-active={view === id}
							role="tab"
							aria-selected={view === id}
							onClick={() => setView(id)}
						>
							{label}
						</button>
					))}
				</div>
			</div>

			<div className="authoring-switcher__grid">
				<div className="authoring-switcher__code">
					<CodeLine code={code} lang={view} />
				</div>
				<aside className="authoring-switcher__note">
					<p className="home-kicker">{labels.noteTitle}</p>
					<ul>
						{labels.notes.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
				</aside>
			</div>
		</div>
	);
}
