# Error and Recovery

Status: rendered with automated checks; human approval is still pending.

Fixtures cover ordinary failure, incompatible protocol, expired cursor, and a
lost command outcome. Browser-only failure projection consumes the complete
failure envelope and current route/action context; raw diagnostics remain
technical detail.

Expected comprehension: the user can state what failed, possible side effects,
whether a retry is safe, and the next available action.
