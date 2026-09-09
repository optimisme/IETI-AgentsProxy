# Lite Harness

Task assistance for small local models: more small steps, recoverable context.

## Shared rules

- `build_lite` coordinates and answers. Only `file_editor` changes project files; `state_keeper` may change its assigned `.agents/state/<task-id>.md` metadata only.
- One file and roughly 50 changed lines per edit; split larger work. Avoid unrelated cleanup and whole-file rewrites for local changes.
- Handoffs carry `GOAL`, exact `TARGET` (or UNKNOWN), essential `CONSTRAINT`, and relevant acceptance IDs/root IDs. Supply only the active batch, evidence anchors, and necessary decisions.
- Read at most 120 lines initially; expand only for a specific gap. Scope searches by path/pattern and limit results to 20 matches where supported; otherwise narrow the query.
- Preserve source anchors: file path + symbol + line range; web URL + section; image identifier + region. Missing, contradictory, or stale summaries require reopening the source through the relevant specialist, never guessing. Line numbers alone can become stale.
- Keep conclusions compact; no raw files, logs, or secrets in handoffs/state. Preserve unresolved scope; never silently drop it to meet a size limit.
- Recovery uses stable root acceptance IDs: initial attempt plus at most 3 recovery rounds per root. Splits, corrections, relabeling, and resumes inherit counters; they never grant new budgets. Only a new independent user outcome gets a new root.
- Do not repeat a failed action without changed relevant evidence/files. The same test after a fix is allowed. Two consecutive no-progress delegations for an active item stop work, including discovery/split/uncertainty ping-pong or repeated state reloads. Successful calls returning the same findings, rewording, and status updates are not progress. Routine state saves/loads neither increment nor reset it; stop after two reload-only delegations without substantive work. Reset no-progress only for verified new evidence, a concretely resolved planning gap, or relevant file changes.
- Edits invalidate affected static review and runtime-check evidence, including dependent interfaces. Keep review and observed validation separate; never claim a check ran without evidence.

## Routing and responses

`build_lite -> task_router -> GENERAL assistance | IMPLEMENT pipeline`

GENERAL answers naturally; ordinary read-only requests do not create state files.
IMPLEMENT reports changes, acceptance coverage, actual checks, and unresolved work/next action. Step limits do not automatically reset context or restart execution.
