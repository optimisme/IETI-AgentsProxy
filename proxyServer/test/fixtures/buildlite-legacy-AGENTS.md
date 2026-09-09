# Lite Harness

Generic programming harness optimized for small local models and short contexts.

## Core rules

- Keep context small. Read only what the current task needs.
- The coordinator delegates; it does not edit files directly.
- Prefer the smallest correct change and one file at a time.
- Do not rewrite a whole existing file for a local change.
- Split large changes into small independent edits.
- Use specialized agents to isolate noisy context: project exploration, web research, and image analysis.
- Pass compact conclusions between agents, never raw research or long excerpts.
- Do not repeat a failed tool call with the same arguments.
- For new files, create the empty file first, then edit it.
- After two failed implementation attempts for the same task, stop and report a blocker.
- Do not claim build, test, lint, typecheck, runtime, or visual validation unless it actually ran.

## Typical flow

`build_lite -> [project_explorer/web_researcher/image_analyzer if needed] -> code_planner -> file_editor -> code_reviewer -> validator`

## Final response

State what changed, what was checked, and any remaining blocker. Keep it short.
