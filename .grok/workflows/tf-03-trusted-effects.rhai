let meta = #{
    name: "tf-03-trusted-effects",
    description: "0.3 Trusted Effects MVP: wire EffectIR into schema/FlowIR/verify, extend tests, honest GA report",
    phases: [
        #{ title: "Inventory", detail: "read freeze + current effects surface" },
        #{ title: "Implement", detail: "parallel schema/FlowIR/verify/runtime hooks" },
        #{ title: "Verify", detail: "tests + acceptance matrix" },
        #{ title: "Report", detail: "GA honesty report to scratch" },
    ],
    when_to_use: "Iterate Taskflow 0.3 Trusted Effects vertical slice toward MVP closed-loop",
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

let gap_schema = #{
    "type": "object",
    "required": ["gaps", "next_steps"],
    "properties": #{
        "gaps": #{
            "type": "array",
            "maxItems": 12,
            "items": #{
                "type": "object",
                "required": ["id", "deliverable", "status", "blocker"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "deliverable": #{ "type": "string" },
                    "status": #{ "type": "string" },
                    "blocker": #{ "type": "string" },
                },
            },
        },
        "next_steps": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 10 },
    },
};

let work_schema = #{
    "type": "object",
    "required": ["done", "files_touched", "tests_added", "notes"],
    "properties": #{
        "done": #{ "type": "boolean" },
        "files_touched": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 20 },
        "tests_added": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 10 },
        "notes": #{ "type": "string" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["tests_pass", "typecheck_pass", "mvp_contract", "blockers", "summary"],
    "properties": #{
        "tests_pass": #{ "type": "boolean" },
        "typecheck_pass": #{ "type": "boolean" },
        "mvp_contract": #{
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
        "blockers": #{ "type": "array", "items": #{ "type": "string" }, "maxItems": 15 },
        "summary": #{ "type": "string" },
    },
};

// ---------------------------------------------------------------------------
// Phase: Inventory
// ---------------------------------------------------------------------------

phase("Inventory");
log("Freeze: docs/internal/0.3.0-trusted-effects-mvp.md on feat/0.3.0-trusted-effects");

let inv_prompt = "";
inv_prompt += "Repo: pi-taskflow at cwd. Branch feat/0.3.0-trusted-effects.\n";
inv_prompt += "Read docs/internal/0.3.0-trusted-effects-mvp.md and packages/taskflow-core/src/effects/*.\n";
inv_prompt += "Read packages/taskflow-core/src/flowir/schema.ts, schema.ts (Phase), verify.ts, index.ts.\n";
inv_prompt += "For each of the 8 Trusted Effects deliverables, set status: done|partial|missing and blocker.\n";
inv_prompt += "Use read_file/grep only. next_steps = concrete implementation tasks for remaining gaps.\n";
inv_prompt += "Do NOT edit files in this step.\n";

let inv = agent(inv_prompt, #{
    label: "inventory",
    capability_mode: "read-only",
    output_schema: gap_schema,
});

if inv == () || !inv.success || inv.output == () {
    pause("verification", "Inventory agent failed — resume to retry or inspect.");
}

// ---------------------------------------------------------------------------
// Phase: Implement (max parallel fan-out)
// ---------------------------------------------------------------------------

phase("Implement");

let jobs = [];

let p1 = "";
p1 += "IMPLEMENT on branch feat/0.3.0-trusted-effects in this repo.\n";
p1 += "Goal: attach optional effects[] to FlowIR nodes and Taskflow phases.\n";
p1 += "1) packages/taskflow-core/src/flowir/schema.ts — optional effects on FlowIRNode (type + TypeBox if present).\n";
p1 += "2) packages/taskflow-core/src/schema.ts — optional effects on PhaseSchema if TypeBox Phase exists; keep backward compatible.\n";
p1 += "3) Export stays via effects/index already on barrel.\n";
p1 += "4) Add/adjust tests under packages/taskflow-core/test/ for schema accept/reject.\n";
p1 += "5) Run: PI_TASKFLOW_BUILTIN_AGENTS_DIR= node --conditions=development --experimental-strip-types --test packages/taskflow-core/test/effects-trusted.test.ts\n";
p1 += "Reuse EffectDecl from effects/types.ts. Do not implement ControlHost/daemon.\n";
p1 += "Return files_touched, tests_added, done=true only if tests you care about pass.\n";
jobs.push(#{
    prompt: p1,
    label: "impl:flowir-schema",
    capability_mode: "execute",
    output_schema: work_schema,
});

let p2 = "";
p2 += "IMPLEMENT on branch feat/0.3.0-trusted-effects.\n";
p2 += "Goal: wire validateEffectIR into verifyTaskflow (or a focused verifier module).\n";
p2 += "1) When a phase or flow carries effects[], call validateEffectIR and surface issues as VerificationIssue (category e.g. effects).\n";
p2 += "2) Prefer packages/taskflow-core/src/verifiers/ or verify.ts extension; match existing verifier patterns.\n";
p2 += "3) Tests: invalid overlap / unknown kind appear as verify errors; valid effects do not fail verify.\n";
p2 += "4) Run effects-trusted tests + any new verify test file.\n";
p2 += "Do not touch historical Control Plane packages. Return structured work_schema.\n";
jobs.push(#{
    prompt: p2,
    label: "impl:verify-wire",
    capability_mode: "execute",
    output_schema: work_schema,
});

let p3 = "";
p3 += "IMPLEMENT on branch feat/0.3.0-trusted-effects.\n";
p3 += "Goal: FlowIR hash includes effects when present (content-address effects).\n";
p3 += "1) Find hashFlowIR / compile path in packages/taskflow-core/src/flowir/.\n";
p3 += "2) Ensure two flows differing only in effects produce different hashes.\n";
p3 += "3) Unit test for hash stability and effects sensitivity.\n";
p3 += "4) Keep zero runtime deps pure. Return work_schema.\n";
jobs.push(#{
    prompt: p3,
    label: "impl:hash-effects",
    capability_mode: "execute",
    output_schema: work_schema,
});

let p4 = "";
p4 += "IMPLEMENT on branch feat/0.3.0-trusted-effects.\n";
p4 += "Goal: optional runtime helper that applies declared fs.write effects only via createCommitGateway.\n";
p4 += "1) Add packages/taskflow-core/src/effects/runtime-apply.ts (or similar) with applyDeclaredFsWrites(gateway, ...).\n";
p4 += "2) Document that agent must not write final paths for declared effects — gateway only.\n";
p4 += "3) Extend effects-trusted.test.ts with multi-write happy path and overlap pre-check.\n";
p4 += "4) Do not require LLM. Return work_schema.\n";
jobs.push(#{
    prompt: p4,
    label: "impl:runtime-apply",
    capability_mode: "execute",
    output_schema: work_schema,
});

let p5 = "";
p5 += "IMPLEMENT docs only on feat/0.3.0-trusted-effects.\n";
p5 += "1) Add a short section to CHANGELOG.md under Unreleased or 0.3.0-draft describing Trusted Effects MVP.\n";
p5 += "2) Ensure docs/internal/0.3.0-trusted-effects-mvp.md example matches create-file PathIntent.\n";
p5 += "3) Optionally add examples/trusted-effects-write.json minimal flow declaring one fs.write effect (not necessarily runnable if runtime not fully wired).\n";
p5 += "Return work_schema. Keep English conventional tone for CHANGELOG.\n";
jobs.push(#{
    prompt: p5,
    label: "impl:docs-example",
    capability_mode: "execute",
    output_schema: work_schema,
});

let impl_results = parallel(jobs);
log("Implement panel finished");

// ---------------------------------------------------------------------------
// Phase: Verify
// ---------------------------------------------------------------------------

phase("Verify");

let v_prompt = "";
v_prompt += "VERIFY Trusted Effects MVP on this repo branch.\n";
v_prompt += "1) Run: PI_TASKFLOW_BUILTIN_AGENTS_DIR= node --conditions=development --experimental-strip-types --test 'packages/taskflow-core/test/effects*.test.ts'\n";
v_prompt += "2) Run typecheck for taskflow-core if cheap: pnpm --filter taskflow-core exec tsc -p tsconfig.build.json --noEmit OR project typecheck subset.\n";
v_prompt += "3) Read docs/internal/0.3.0-trusted-effects-mvp.md eight deliverables; for each set status pass|partial|fail with evidence path.\n";
v_prompt += "4) List remaining blockers for MVP closed-loop (contract layer). Do NOT claim GA/release.\n";
v_prompt += "5) Fix only trivial test/type errors you introduced; prefer report over large refactors.\n";
v_prompt += "mvp_contract fields must be one of: pass, partial, fail.\n";

let ver = agent(v_prompt, #{
    label: "verify-mvp",
    capability_mode: "execute",
    output_schema: verify_schema,
});

if ver == () || !ver.success || ver.output == () {
    pause("verification", "Verify agent failed — resume after fixing environment.");
}

// ---------------------------------------------------------------------------
// Phase: Report
// ---------------------------------------------------------------------------

phase("Report");

let report = "# 0.3 Trusted Effects MVP — workflow report\n\n";
report += "## Inventory gaps\n\n";
if inv.success && inv.output.gaps != () {
    for g in inv.output.gaps {
        report += "- **" + g.id + "** (" + g.deliverable + "): " + g.status + " — " + g.blocker + "\n";
    }
} else {
    report += "- inventory unavailable\n";
}
report += "\n## Implement panel\n\n";
let idx = 0;
let labels = ["impl:flowir-schema", "impl:verify-wire", "impl:hash-effects", "impl:runtime-apply", "impl:docs-example"];
for r in impl_results {
    let lab = labels[idx];
    if r != () && r.success && r.output != () {
        let d = "no";
        if r.output.done == true { d = "yes"; }
        report += "- " + lab + ": done=" + d + " — " + r.output.notes + "\n";
    } else {
        report += "- " + lab + ": FAILED or empty\n";
    }
    idx += 1;
}
report += "\n## Verify\n\n";
let tests_pass = false;
let typecheck_pass = false;
let summary = "verify unavailable";
if ver != () && ver.success && ver.output != () {
    if ver.output.summary != () { summary = ver.output.summary; }
    if ver.output.tests_pass == true { tests_pass = true; }
    if ver.output.typecheck_pass == true { typecheck_pass = true; }
    report += summary + "\n\n";
    report += "- tests_pass: " + tests_pass + "\n";
    report += "- typecheck_pass: " + typecheck_pass + "\n";
    report += "\n### Contract matrix\n\n";
    let mc = ver.output.mvp_contract;
    if mc != () {
        report += "| Deliverable | Status |\n|---|---|\n";
        if mc.effect_ir != () { report += "| EffectIR | " + mc.effect_ir + " |\n"; }
        if mc.refs != () { report += "| Refs | " + mc.refs + " |\n"; }
        if mc.labels != () { report += "| Labels | " + mc.labels + " |\n"; }
        if mc.changeset != () { report += "| Changeset | " + mc.changeset + " |\n"; }
        if mc.gateway != () { report += "| Gateway | " + mc.gateway + " |\n"; }
        if mc.overlap != () { report += "| Overlap | " + mc.overlap + " |\n"; }
        if mc.host_matrix != () { report += "| Host matrix | " + mc.host_matrix + " |\n"; }
        if mc.why != () { report += "| why-* | " + mc.why + " |\n"; }
    } else {
        report += "(mvp_contract missing from verify agent)\n";
    }
    report += "\n### Blockers\n\n";
    if ver.output.blockers != () {
        for b in ver.output.blockers {
            report += "- " + b + "\n";
        }
    }
} else {
    report += "verify unavailable\n";
}
report += "\n## Honesty\n\n";
report += "This run does **not** claim npm GA or Control Plane GA.\n";
report += "MVP complete requires local+contract+real-fixture per freeze doc.\n";

let path = write_scratch_file("trusted-effects-mvp-report.md", report);
complete(#{
    path: path,
    tests_pass: tests_pass,
    typecheck_pass: typecheck_pass,
    summary: summary,
});
