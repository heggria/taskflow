import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const referenceRoot = path.join(
	repositoryRoot,
	"docs/internal/webui/reference-set-v1",
);
const evidencePath = path.join(referenceRoot, "render-evidence.json");
const renderRoot = path.join(
	repositoryRoot,
	"output/playwright/beta2-reference",
);
const outputPath = path.join(renderRoot, "review.html");
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

assert.equal(
	evidence.status,
	"rendered-awaiting-human-approval",
	"review gallery must not imply approval",
);
assert.equal(
	evidence.screenshots.length,
	evidence.matrix.representativeScreenshotCount +
		evidence.matrix.supplementalScreenshotCount,
);

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function relativeImagePath(entry) {
	const expectedPrefix = "output/playwright/beta2-reference/";
	assert.equal(
		entry.path.startsWith(expectedPrefix),
		true,
		`unexpected screenshot path: ${entry.path}`,
	);
	const relative = entry.path.slice(expectedPrefix.length);
	assert.equal(relative.includes(".."), false);
	assert.equal(
		fs.existsSync(path.join(renderRoot, relative)),
		true,
		`missing screenshot: ${entry.path}`,
	);
	return relative;
}

const byScreen = new Map();
for (const entry of evidence.screenshots) {
	const rows = byScreen.get(entry.screenId) ?? [];
	rows.push(entry);
	byScreen.set(entry.screenId, rows);
}

const screenSections = [...byScreen.entries()]
	.sort(([left], [right]) => left.localeCompare(right))
	.map(([screenId, entries]) => {
		const cards = entries
			.sort((left, right) =>
				[
					left.fixtureId,
					left.locale,
					left.theme,
					left.viewport,
				]
					.join("\u0000")
					.localeCompare(
						[
							right.fixtureId,
							right.locale,
							right.theme,
							right.viewport,
						].join("\u0000"),
					),
			)
			.map((entry) => {
				const a11y =
					entry.seriousOrCriticalA11yViolations === null
						? "not assessed"
						: `${entry.seriousOrCriticalA11yViolations} serious/critical`;
				return `
					<article class="card">
						<a href="${escapeHtml(relativeImagePath(entry))}" target="_blank" rel="noreferrer">
							<img
								alt="${escapeHtml(`${entry.screenId}, ${entry.fixtureId}, ${entry.locale}, ${entry.theme}, ${entry.viewport}`)}"
								loading="lazy"
								src="${escapeHtml(relativeImagePath(entry))}"
							>
						</a>
						<div class="meta">
							<strong>${escapeHtml(entry.fixtureId)}</strong>
							<span>${escapeHtml(entry.locale)} · ${escapeHtml(entry.theme)} · ${escapeHtml(entry.viewport)}</span>
							<span>overflow: ${escapeHtml(entry.horizontalOverflow)}</span>
							<span>a11y: ${escapeHtml(a11y)}</span>
							<code>${escapeHtml(entry.sha256)}</code>
						</div>
					</article>`;
			})
			.join("\n");
		return `
			<section>
				<header class="section-header">
					<div>
						<p class="eyebrow">Screen family</p>
						<h2>${escapeHtml(screenId)}</h2>
					</div>
					<a href="../../../docs/internal/webui/reference-set-v1/screens/${escapeHtml(screenId)}.md">Review specification</a>
				</header>
				<div class="grid">${cards}</div>
			</section>`;
	})
	.join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Taskflow Web reference review</title>
	<style>
		:root { color-scheme: light dark; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
		* { box-sizing: border-box; }
		body { margin: 0; background: Canvas; color: CanvasText; }
		main { width: min(1800px, 100%); margin: 0 auto; padding: 32px; }
		h1, h2, p { margin-block: 0; }
		h1 { font-size: clamp(2rem, 5vw, 4.5rem); line-height: 1; max-width: 12ch; }
		h2 { font-size: 1.6rem; }
		a { color: LinkText; text-underline-offset: 0.2em; }
		code { display: block; overflow-wrap: anywhere; font-size: 0.72rem; opacity: 0.7; }
		.intro { display: grid; gap: 18px; padding-block-end: 56px; }
		.notice { max-width: 78ch; padding: 16px 18px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; background: color-mix(in srgb, CanvasText 4%, Canvas); }
		.summary { display: flex; flex-wrap: wrap; gap: 8px; }
		.summary span { padding: 6px 10px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, Canvas); }
		section { border-block-start: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding-block: 32px 64px; }
		.section-header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-block-end: 20px; }
		.eyebrow { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.62; }
		.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 18px; }
		.card { min-width: 0; overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 16px; background: color-mix(in srgb, CanvasText 3%, Canvas); }
		.card img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: contain; object-position: top; background: white; }
		.meta { display: grid; gap: 5px; padding: 14px; }
		.meta span { font-size: 0.82rem; opacity: 0.76; }
		@media (max-width: 640px) {
			main { padding: 20px 14px; }
			.section-header { align-items: start; flex-direction: column; }
		}
	</style>
</head>
<body>
	<main>
		<header class="intro">
			<p class="eyebrow">0.3.0-beta.2 · human review material</p>
			<h1>Web reference review</h1>
			<p class="notice"><strong>Not approved.</strong> This page only assembles hash-bound rendered evidence. Reviewers must still judge hierarchy, content, consequences, narrow layouts, theme parity and comprehension against each screen specification.</p>
			<div class="summary">
				<span>${escapeHtml(evidence.matrix.representativeScreens)} screen families</span>
				<span>${escapeHtml(evidence.matrix.representativeScreenshotCount)} matrix renders</span>
				<span>${escapeHtml(evidence.matrix.supplementalScreenshotCount)} supplemental renders</span>
				<span>${escapeHtml(evidence.matrix.a11yAssessedScreenshotCount)} axe-assessed</span>
				<span>${escapeHtml(evidence.status)}</span>
			</div>
		</header>
		${screenSections}
	</main>
</body>
</html>
`;

fs.mkdirSync(renderRoot, { recursive: true });
fs.writeFileSync(outputPath, html, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${path.relative(repositoryRoot, outputPath)}\n`);
