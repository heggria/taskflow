# Usability evidence fixtures v1

These files are recording templates for the beta.2 cognitive usability gate.
They contain no participant data and do not claim that a study occurred.

Before use, verify:

```bash
pnpm check:web-reference-fixtures
pnpm check:web-render-evidence
pnpm test:e2e-web-console
```

Follow `docs/internal/webui/usability-script-v1.md` exactly. Create one copy of
`session-result.template.json` per participant. Never edit a completed session
record; create a corrected superseding record and retain the original. Create
one copy of `zh-cn-content-review.template.json` for each of the two native
Simplified-Chinese reviewers, with one `content-ux` and one
`technical-safety` role. After five fresh English-language sessions, the
approved reference review, and both Chinese reviews, copy
`study-summary.template.json` and fill it from the immutable records.

Use this evidence layout:

```text
artifacts/web-usability/<release-candidate>/
├── reference-review.json
├── study-summary.json
├── sessions/
│   └── <opaque-participant-id>.json
└── zh-cn-reviews/
    ├── content-ux.json
    └── technical-safety.json
```

Validate a completed bundle with:

```bash
node scripts/verify-web-human-evidence.mjs \
  --evidence-dir artifacts/web-usability/<release-candidate>
```

Direct personal identifiers are prohibited. `participantId` is an opaque local
study id. Free-form notes must not contain names, contact details, employer, or
credentials.
