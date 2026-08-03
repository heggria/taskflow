import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineProject } from "../packages/charterarc/src/index.ts";
import {
	PHASE_TYPES,
	type Taskflow,
} from "../packages/taskflow-core/src/index.ts";

const PHASE_SECTION_PREFIX = "## One runtime,";
const PHASE_SECTION_END = "\nAcross those phase types";

const phaseDocsMaintenance: Taskflow = {
	name: "maintain-phase-docs",
	phases: [
		{
			id: "repair",
			type: "agent",
			agent: "doc-writer",
			tools: ["read", "grep", "find", "ls", "edit", "write"],
			thinking: "low",
			task:
				"Apply the smallest README-only repair required by this complete evidence:\n\n" +
				"{args.charterarc}\n\nDo not return a plan or promise. Edit README.md, inspect the resulting diff, " +
				"and respond only after the repair is on disk. Do not create files or change unrelated content.",
		},
		{
			id: "verify",
			type: "gate",
			agent: "reviewer",
			tools: ["read", "grep", "find", "ls"],
			dependsOn: ["repair"],
			final: true,
			task:
				"Verify that this repair restores the documented phase catalog and changes nothing else.\n\n" +
				"Evidence:\n{args.charterarc}\n\nRepair result:\n{steps.repair.output}\n\n" +
				"End with VERDICT: PASS or VERDICT: BLOCK.",
		},
	],
};

async function observePhaseDocs(cwd: string) {
	const readme = await readFile(join(cwd, "README.md"), "utf8");
	const start = readme.indexOf(PHASE_SECTION_PREFIX);
	const end = start < 0 ? -1 : readme.indexOf(PHASE_SECTION_END, start);
	if (start < 0 || end < 0) {
		return {
			status: "unknown" as const,
			facts: { catalog: "not-located" },
			summary: "README.md phase catalog structure could not be located",
		};
	}

	const section = readme.slice(start, end);
	const expected: string[] = [...PHASE_TYPES].sort();
	const phaseColumn = section
		.split("\n")
		.filter((line) => line.trimStart().startsWith("|"))
		.map((line) => line.split("|")[2] ?? "")
		.join("\n");
	const documented = [
		...new Set([...phaseColumn.matchAll(/`([a-z][a-z-]*)`/g)].map((match) => match[1]!)),
	].sort();
	const missing = expected.filter((phase) => !documented.includes(phase));
	const extra = documented.filter((phase) => !expected.includes(phase));
	const heading = `## One runtime, ${PHASE_TYPES.length} phase types`;

	if (section.startsWith(heading) && missing.length === 0 && extra.length === 0) {
		return {
			status: "satisfied" as const,
			facts: { documented, expected },
		};
	}

	const problems = [
		`expected ${PHASE_TYPES.length} phases: ${expected.join(", ")}`,
		...(section.startsWith(heading) ? [] : [`heading must say ${PHASE_TYPES.length} phase types`]),
		...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
		...(extra.length === 0 ? [] : [`extra: ${extra.join(", ")}`]),
	];
	return {
		status: "drifted" as const,
		target: { desired: "catalog" },
		facts: { documented, expected, missing, extra },
		summary: `README.md: ${problems.join("; ")}`,
	};
}

export const phaseDocsProject = defineProject({
	desired: {
		catalog: "README phase count and catalog set match taskflow-core PHASE_TYPES",
	},
	observe: ({ cwd }) => observePhaseDocs(cwd),
	maintain: { catalog: phaseDocsMaintenance },
});
