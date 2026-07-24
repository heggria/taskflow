# Usability evidence fixtures v1

These files are recording templates for the beta.2 cognitive usability gate.
They contain no participant data and do not claim that a study occurred.

Before use, verify:

```bash
pnpm check:web-reference-fixtures
pnpm check:web-render-evidence
pnpm test:e2e-web-console
```

Create one copy of `session-result.template.json` per participant. Never edit a
completed session record; create a corrected superseding record and retain the
original. Create one copy of `zh-cn-content-review.template.json` for each of
the two native Simplified-Chinese reviewers. After five fresh English-language
sessions and both Chinese reviews, copy `study-summary.template.json` and fill
it from the immutable participant and reviewer records.

Direct personal identifiers are prohibited. `participantId` is an opaque local
study id. Free-form notes must not contain names, contact details, employer, or
credentials.
