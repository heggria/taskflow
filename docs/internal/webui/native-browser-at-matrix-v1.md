# Native browser and assistive-technology matrix v1

Status: executable manual protocol; no lane result is implied by this document.

Automated Chromium, Firefox and WebKit runs catch application regressions but
cannot prove native browser integration, spoken output, rotor navigation,
platform focus behavior or forced-colors usability. Every lane below uses the
same reviewed immutable packaged candidate and a fresh browser profile.

## Required lanes

| Lane | Platform |
|---|---|
| `safari-voiceover-macos` | Current native Safari + VoiceOver on macOS |
| `chrome-voiceover-macos` | Current native Chrome + VoiceOver on macOS |
| `edge-narrator-windows` | Current native Edge + Narrator on Windows |
| `firefox-nvda-windows` | Current native Firefox + NVDA on Windows |
| `edge-forced-colors-windows` | Current native Edge with Windows forced colors |

The browser, operating-system and assistive-technology versions must be
recorded exactly. Playwright WebKit does not satisfy the Safari lane. A macOS
accessibility-tree inspection without VoiceOver does not satisfy a VoiceOver
lane.

## Frozen tasks

| Task id | Action | Pass condition |
|---|---|---|
| `launch-simple` | Open a fresh one-time launch URL | Simple opens, focus is predictable, page title and main heading are announced |
| `skip-and-navigation` | Keyboard to the skip link, main content and navigation | Skip target works; landmarks and current destination are understandable |
| `task-state` | Open active, completed and uncertain Tasks | State, impact, required action and verification limit are read in logical order |
| `approval-dialog` | Open and dismiss the approval dialog; use an isolated store if submitting | Name, consequence and buttons are announced; focus is trapped and restored; button labels answer the question |
| `mode-and-tabs` | Switch Simple → Pro and traverse Task tabs | Task identity is preserved; selected tab and panel relation are announced |
| `graph-listbox` | Expand the accessible graph list and change node with arrows | One selected option exists; selection and inspector update together |
| `evidence` | Read verification, Receipt checks and artifact actions | Definition-list relationships, limitations and download labels remain clear |
| `live-update` | Observe one real SSE update and one polling recovery | Update is discoverable without focus theft or repetitive announcement storms |
| `narrow-zoom-contrast` | Test 320 CSS px or 200% zoom; forced-colors lane enables the OS mode | No critical action/consequence is clipped; focus and state do not rely on color alone |
| `session-dialogs` | Open logout and revoke-all dialogs; submit only against isolated stores | Scope and execution-state consequence are explicit; focus/Escape/restore work |

## Execution

1. Verify the candidate build, manifest, content and render hashes.
2. Start the native-browser review hold described in
   `usability-study-v1.md`; never retain its one-time launch capability.
3. Run all ten tasks without changing the expected wording or order.
4. Copy `browser-at-result.template.json`; fill one lane at a time.
5. Record observed spoken words or focus behavior, not an inferred summary.
6. Any safety-critical misunderstanding, unreachable action, focus loss,
   clipped consequence or color-only state is a blocking result.
7. A corrected build starts a new immutable result file; never edit completed
   evidence in place.

The five lanes pass only when every task is `pass`, no blocking issue remains,
the record hashes bind the exact candidate, and the reviewer attestation is
true.
