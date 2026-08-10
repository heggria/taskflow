let meta = #{
    name: "tf-03-ga-converge",
    description: "0.3 Trusted Effects continuous converge: audit scoreboard, parallel close gaps, verify, update ledger toward GA",
    phases: [
        #{ title: "Audit", detail: "scoreboard + effects surface + highest proven level" },
        #{ title: "Close gaps", detail: "parallel implementers by file ownership" },
        #{ title: "Verify", detail: "effects tests + typecheck + scoreboard patch" },
        #{ title: "Record", detail: "write scoreboard + wave report" },
    ],
    when_to_use: "Iterate Taskflow 0.3 Trusted Effects until closed-loop GA (re-run each wave)",
};

let audit_schema = #{
    "type": "object",
    "required": ["highest_proven", "gaps", "wave_focus", "file_owners"],
    "properties": #{
        "highest_proven": #{ "type": "string" },
        "gaps": #{
            "type": "array",
            "maxItems": 12,
            "items": #{
                "type": "object",
                "required": ["id", "title", "owner_files", "priority"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "owner_files": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 8 },
                    "priority": #{ "type": "string" },
                },
            },
        },
        "wave_focus": #{ "type": "string" },
        "file_owners": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 8 },
    },
};

let work_schema = #{
    "type": "object",
    "required": ["gap_id", "done", "files_touched", "notes"],
    "properties": #{
        "gap_id": #{ "type": "string" },
        "done": #{ "type": "boolean" },
        "files_touched": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 20 },
        "notes": #{ "type": "string" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["tests_pass", "typecheck_pass", "highest_proven", "deliverables", "blockers", "summary"],
    "properties": #{
        "tests_pass": #{ "type": "boolean" },
        "typecheck_pass": #{ "type": "boolean" },
        "highest_proven": #{ "type": "string" },
        "deliverables": #{
            "type": "object",
            "required": ["effect_ir", "refs", "labels", "changeset", "gateway", "overlap", "host_matrix", "why"],
            "properties": #{
                "effect_ir": #{ "type": "string" },
                "refs": #{ "type": "string" },
                "labels": #{ "type": "string" },
                "changeset": #{ "type": "string" },
                "gateway": #{ "type": "string" },
                "overlap": #{ "type": "string" },
                "host_matrix": #{ "type": "string" },
                "why": #{ "type": "string" },
            },
        },
        "blockers": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 12 },
        "summary": #{ "type": "string" },
        "scoreboard_markdown": #{ "type": "string" },
    },
};

// ===========================================================================
// Audit
// ===========================================================================

phase("Audit");
log("Goal: docs/internal/0.3.0-agent-goal.md — converge to L6 GA (Trusted Effects only)");

let audit_p = "";
audit_p += "You are the AUDITOR for Taskflow 0.3 Trusted Effects GA converge.\n";
audit_p += "Repo cwd is the monorepo. Branch should be feat/0.3.0-trusted-effects.\n";
audit_p += "READ (do not edit):\n";
audit_p += "- docs/internal/0.3.0-agent-goal.md\n";
audit_p += "- docs/internal/0.3.0-trusted-effects-mvp.md\n";
audit_p += "- docs/internal/0.3.0-ga-scoreboard.md\n";
audit_p += "- packages/taskflow-core/src/effects/*\n";
audit_p += "- packages/taskflow-core/src/verifiers/effects-lint.ts\n";
audit_p += "Use grep/read_file/git status. Identify up to 5 concrete GAPS still blocking L2/L4/L5.\n";
audit_p += "Prefer non-overlapping owner_files per gap for parallel implementers.\n";
audit_p += "Priorities: P0 runtime gateway enforcement; P0 e2e fixture; P1 typecheck; P1 scoreboard accuracy; P2 MCP why-effect surface.\n";
audit_p += "highest_proven must be L0-L6 style (e.g. L1, L2). wave_focus = one sentence.\n";
audit_p += "Do NOT claim GA. Do NOT edit files.\n";

let audit = agent(audit_p, #{
    label: "audit",
    capability_mode: "read-only",
    output_schema: audit_schema,
});

if audit == () || !audit.success || audit.output == () {
    pause("verification", "Audit failed — resume to retry.");
}

let gaps = audit.output.gaps;
if gaps == () || gaps.len() == 0 {
    log("Audit found zero gaps — still run verify to confirm");
}

// ===========================================================================
// Close gaps (parallel, max 5)
// ===========================================================================

phase("Close gaps");

let jobs = [];
let gi = 0;
if gaps != () {
    for g in gaps {
        if gi >= 5 { break; }
        let owners = "";
        if g.owner_files != () {
            for f in g.owner_files {
                owners += f + " ";
            }
        }
        let pr = "";
        pr += "IMPLEMENT gap on branch feat/0.3.0-trusted-effects.\n";
        pr += "Agent goal: docs/internal/0.3.0-agent-goal.md (Trusted Effects → GA).\n";
        pr += "Gap id: " + g.id + "\n";
        pr += "Title: " + g.title + "\n";
        pr += "Priority: " + g.priority + "\n";
        pr += "Prefer editing only: " + owners + "\n";
        pr += "Rules:\n";
        pr += "- Do NOT merge historical Control Plane packages into this work.\n";
        pr += "- Fail closed for effects; pure modules stay pure.\n";
        pr += "- Add/adjust tests under packages/taskflow-core/test/effects*.test.ts when possible.\n";
        pr += "- Run: PI_TASKFLOW_BUILTIN_AGENTS_DIR= node --conditions=development --experimental-strip-types --test packages/taskflow-core/test/effects-trusted.test.ts\n";
        pr += "- done=true only if your gap is fixed with evidence; else done=false and notes say residual.\n";
        pr += "Return work_schema with gap_id=" + g.id + "\n";
        jobs.push(#{
            prompt: pr,
            label: "gap:" + g.id,
            capability_mode: "execute",
            output_schema: work_schema,
        });
        gi += 1;
    }
}

// Always schedule fixed P0 lanes if audit returned nothing useful
if jobs.len() == 0 {
    let f1 = "";
    f1 += "P0: Wire declared fs.write effects so final paths are only written via packages/taskflow-core/src/effects/runtime-apply.ts applyDeclaredFsWrites or CommitGateway.\n";
    f1 += "Find script/agent completion hooks in runtime if needed; at minimum export a clear runtime API + tests that bypass is documented fail-closed.\n";
    f1 += "Branch feat/0.3.0-trusted-effects. Run effects-trusted tests. Return work_schema gap_id=runtime-force.\n";
    jobs.push(#{ prompt: f1, label: "gap:runtime-force", capability_mode: "execute", output_schema: work_schema });

    let f2 = "";
    f2 += "P0: Add a no-LLM real fixture test that creates a temp workspace, declares fs.write effects, applies via gateway/runtime-apply, asserts file content and reject path.\n";
    f2 += "File: packages/taskflow-core/test/effects-e2e-fixture.test.ts. Run it. gap_id=e2e-fixture.\n";
    jobs.push(#{ prompt: f2, label: "gap:e2e-fixture", capability_mode: "execute", output_schema: work_schema });

    let f3 = "";
    f3 += "Update docs/internal/0.3.0-ga-scoreboard.md honestly after inspecting git and tests. Do not mark L5/L6 pass. gap_id=scoreboard.\n";
    jobs.push(#{ prompt: f3, label: "gap:scoreboard", capability_mode: "execute", output_schema: work_schema });
}

let impl = parallel(jobs);
log("Gap panel done: " + jobs.len().to_string() + " agents");

// ===========================================================================
// Verify
// ===========================================================================

phase("Verify");

let vp = "";
vp += "VERIFY Taskflow 0.3 Trusted Effects converge wave.\n";
vp += "1) Run: PI_TASKFLOW_BUILTIN_AGENTS_DIR= node --conditions=development --experimental-strip-types --test 'packages/taskflow-core/test/effects*.test.ts'\n";
vp += "2) Try typecheck: pnpm --filter taskflow-core exec tsc -p packages/taskflow-core/tsconfig.build.json --noEmit  OR project typecheck if reasonable.\n";
vp += "3) Read docs/internal/0.3.0-agent-goal.md gates G1-G8; set highest_proven honestly (L1-L6).\n";
vp += "4) For each of 8 deliverables set pass|partial|fail.\n";
vp += "5) Produce scoreboard_markdown: full markdown body for docs/internal/0.3.0-ga-scoreboard.md (overwrite content style matching existing).\n";
vp += "6) WRITE the scoreboard file with your scoreboard_markdown if tests allow.\n";
vp += "7) NEVER set highest_proven to L5/L6 without tag/publish evidence.\n";
vp += "Fix only trivial breakages from this wave.\n";

let ver = agent(vp, #{
    label: "verify-wave",
    capability_mode: "execute",
    output_schema: verify_schema,
});

if ver == () || !ver.success || ver.output == () {
    pause("verification", "Verify agent failed.");
}

// ===========================================================================
// Record
// ===========================================================================

phase("Record");

let report = "# Converge wave report\n\n";
report += "## Audit\n\n";
if audit.success && audit.output != () {
    report += "- highest_proven (audit): " + audit.output.highest_proven + "\n";
    report += "- wave_focus: " + audit.output.wave_focus + "\n";
    if audit.output.gaps != () {
        for g in audit.output.gaps {
            report += "- gap " + g.id + ": " + g.title + " [" + g.priority + "]\n";
        }
    }
}
report += "\n## Implement\n\n";
for r in impl {
    if r != () && r.success && r.output != () {
        let d = "no";
        if r.output.done == true { d = "yes"; }
        report += "- " + r.output.gap_id + " done=" + d + " — " + r.output.notes + "\n";
    } else {
        report += "- (failed slot)\n";
    }
}
report += "\n## Verify\n\n";
let tests_pass = false;
let typecheck_pass = false;
let highest = "L0";
let summary = "unavailable";
if ver != () && ver.success && ver.output != () {
    if ver.output.tests_pass == true { tests_pass = true; }
    if ver.output.typecheck_pass == true { typecheck_pass = true; }
    if ver.output.highest_proven != () { highest = ver.output.highest_proven; }
    if ver.output.summary != () { summary = ver.output.summary; }
    report += summary + "\n";
    report += "- tests_pass: " + tests_pass + "\n";
    report += "- typecheck_pass: " + typecheck_pass + "\n";
    report += "- highest_proven: " + highest + "\n";
    if ver.output.blockers != () {
        report += "\n### Blockers\n";
        for b in ver.output.blockers {
            report += "- " + b + "\n";
        }
    }
}
report += "\n## Standing order\n\n";
report += "If highest_proven is not L6, re-run workflow tf-03-ga-converge.\n";
report += "Do not tag/publish without human authority.\n";

let path = write_scratch_file("ga-converge-wave-report.md", report);

// If not L6, signal incomplete but successful wave (agent continues via re-run)
complete(#{
    path: path,
    highest_proven: highest,
    tests_pass: tests_pass,
    typecheck_pass: typecheck_pass,
    summary: summary,
    next: "re-run tf-03-ga-converge until highest_proven=L6 and human release",
});
