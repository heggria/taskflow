# Web reference set v1

This directory binds the nine beta.2 reference-screen families to executable
P17 fixtures and actual packaged `taskflow-web` renders.

Current status: rendered and automatically checked, but still
`draft-unapproved`. Rendering is evidence that the components, fixtures,
content catalogs, responsive layouts, and packaged browser client compose
correctly. It is not human product approval, authority E2E proof, P17
conformance, or wire freeze.

## Evidence

- `manifest.json` binds every fixture, projection, content keyset, locale
  catalog, and screen specification.
- `render-evidence.json` binds 144 representative screenshots
  (9 screens × 2 locales × 2 themes × 4 viewport conditions) plus 5
  supplemental state renders by SHA-256.
- Screenshot bytes live under `output/playwright/beta2-reference/`.
- `pnpm check:web-render-evidence` verifies every local screenshot and fixture
  digest, the complete matrix, document-level horizontal overflow, and the
  recorded accessibility checks.
- `node scripts/build-web-reference-review.mjs` validates the screenshot
  inventory and writes a local, lazy-loaded review gallery to
  `output/playwright/beta2-reference/review.html`. The gallery is an inspection
  aid only: it cannot change approval status.
- Serious/critical axe checks run on the 1440×900 and 320 CSS-pixel light-theme
  representative renders in both locales. Unassessed render entries use
  `null`, never a fabricated zero.

`200-percent-zoom` uses a 720×450 effective CSS viewport, which is the layout
space a 1440×900 viewport exposes at 200% browser zoom. It is kept separate
from the 320 CSS-pixel narrow-screen condition.

## Evidence boundary

The renderer uses the real packaged browser application and a real loopback
session, then injects the committed design fixtures at the generated P17
endpoint boundary. This proves component rendering against those exact
fixtures; it does not pretend that fixture states came from ControlStore.

The separate packaged-dist E2E starts the daemon, mounts multiple real project
stores, observes SSE and polling fallback, stops a live provider process through
the durable command path, and renders a real Receipt/artifact. Both evidence
classes are required.

## Approval

Human reviewers must inspect the rendered matrix, confirm the screen-specific
comprehension goal in each `screens/*.md`, and create a completed copy of
`review-result.template.json`. The template itself is checked to contain no
approval evidence. Until a completed, independently reviewed record is bound
to the exact manifest and render-evidence hashes, `manifest.json.status` and
every screen `reviewStatus` remain unapproved.
