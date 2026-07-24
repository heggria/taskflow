# Unknown / Reconciling Task

Status: rendered with automated checks; human approval is still pending.

The fixture keeps the Task non-terminal, marks possible live side effects, and
selects conservative checking-execution copy. It must never look cancelled or
safe-to-rerun.

Expected comprehension: the user can explain that work may still be running
and that Taskflow is checking before declaring a terminal outcome.
