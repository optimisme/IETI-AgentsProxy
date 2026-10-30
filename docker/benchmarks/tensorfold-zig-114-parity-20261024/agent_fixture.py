#!/usr/bin/env python3
"""Builds agent-fixture.json: an OpenCode-like shared system prompt plus real source files used as tool results."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
TOOLS = {
    'read': 'Read a file from the workspace. Returns numbered lines. Use offset and limit for large files.',
    'edit': 'Replace an exact string in a file. old_string must be unique; preserve indentation exactly.',
    'write': 'Create or overwrite a file. Read the file first when it already exists.',
    'bash': 'Run a shell command in the project directory and return stdout, stderr and the exit code.',
    'grep': 'Search file contents with a regular expression. Returns matching paths and line numbers.',
    'glob': 'List files matching a glob pattern, newest first.',
    'list': 'List a directory tree, ignoring node_modules and build output.',
    'todowrite': 'Replace the session task list. Each item has content, status and priority.',
    'webfetch': 'Fetch a URL and return it as markdown.',
}
RULES = [
    'You are an interactive coding agent working inside a student repository.',
    'Be concise. Prefer editing existing files over creating new ones and match the surrounding style.',
    'Never invent APIs: read the code before changing it and run the tests after changing it.',
    'When a command fails, read the error, form a hypothesis and fix the cause instead of retrying.',
    'Explain non-obvious decisions in one sentence. Do not add comments that restate the code.',
    'Keep secrets out of logs, commits and responses. Ask before destructive or outward-facing actions.',
    'Use the task list for multi-step work and keep exactly one item in progress.',
    'Reference code as path:line so the student can jump to it.',
]


def schema(name, text):
    props = {'path': {'type': 'string', 'description': 'Absolute or workspace-relative path.'},
             'offset': {'type': 'integer', 'description': 'First line to return, 1-based.'},
             'limit': {'type': 'integer', 'description': 'Maximum number of lines to return.'},
             'timeout': {'type': 'integer', 'description': 'Milliseconds before the call is cancelled.'},
             'description': {'type': 'string', 'description': 'Five to ten words describing the call for the student.'}}
    return {'type': 'function', 'function': {'name': name, 'description': text,
            'parameters': {'type': 'object', 'properties': props, 'required': ['path']}}}


def system():
    parts = ['# Agent instructions', *RULES, '', '# Tools']
    for name, text in TOOLS.items():
        parts.append(f'## {name}\n{text}\n' + json.dumps(schema(name, text), indent=2))
    parts += ['', '# Coding conventions']
    for path in (REPO / 'AGENTS.md', REPO / 'README.md'):
        if path.exists():
            parts.append(path.read_text()[:14000])
    return '\n'.join(parts)


files = sorted(p for p in (REPO / 'proxyServer' / 'src').rglob('*.js') if p.stat().st_size > 2500)
tasks = [
    'Add a per-group monthly token quota next to the daily and hourly ones, with tests.',
    'The streaming endpoint sometimes leaves usage rows with status pending; find out why and fix it.',
    'Refactor the provider selection so a failed upstream is skipped for 30 seconds.',
    'Add an admin page that lists the ten heaviest users of the last 24 hours.',
    'Make API key rotation keep the old key valid for five minutes.',
    'Rate limiting resets on restart; persist the counters in SQLite without slowing requests.',
    'Add request IDs to every log line and return them in an X-Request-Id header.',
    'Students report 500 errors when the prompt contains an image; reproduce and fix.',
]
out = {'system': system(), 'tasks': tasks,
       'files': [{'path': str(p.relative_to(REPO)), 'text': p.read_text()} for p in files]}
(ROOT / 'agent-fixture.json').write_text(json.dumps(out) + '\n')
print(len(out['system']), 'system chars;', len(files), 'files;', sum(len(f['text']) for f in out['files']), 'file chars')
