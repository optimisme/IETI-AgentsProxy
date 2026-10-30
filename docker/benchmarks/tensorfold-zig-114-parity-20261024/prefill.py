#!/usr/bin/env python3
"""Cold prompt fill: unique code prompts alone (2k-32k tokens) and 4/8 at once (8k), first-token time and fill rate."""
import json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
url, tag = sys.argv[1], sys.argv[2]
files = json.loads((ROOT / "agent-fixture.json").read_text())["files"]
hay = "\n\n".join(f"// file: {f['path']}\n{f['text']}" for f in files) * 3


def ask(i, chars):
    start = (i * 7919) % (len(hay) // 3)
    text = f"[{tag} {i} {time.time()}]\n" + hay[start:start + chars] + "\n\nSummarize what this code does in one sentence."
    body = {"model": "x", "messages": [{"role": "user", "content": text}], "max_tokens": 8, "temperature": 0,
            "stream": True, "stream_options": {"include_usage": True}, "chat_template_kwargs": {"enable_thinking": False}}
    t0 = time.monotonic()
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    first, usage = None, {}
    with urllib.request.urlopen(req, timeout=900) as r:
        for line in r:
            if line.startswith(b"data:") and line[5:].strip() != b"[DONE]":
                e = json.loads(line[5:])
                if e.get("usage"): usage = e["usage"]
                if first is None and any((c.get("delta") or {}).get("content") for c in e.get("choices", [])): first = time.monotonic() - t0
    return first, usage.get("prompt_tokens", 0)


ask(0, 2000)  # warm
import os
quick = os.environ.get("QUICK") == "1"
for chars in ((64000,) if quick else (8000, 32000, 64000, 128000)):
    f, n = ask(1, chars)
    print(f"{tag} alone {n} tokens: first token {f:.2f}s, {n / f:.0f} tok/s", flush=True)
for k in ((4,) if quick else (4, 8)):
    t0 = time.monotonic()
    with ThreadPoolExecutor(k) as ex:
        res = list(ex.map(lambda i: ask(100 + i, 32000), range(k)))
    wall = time.monotonic() - t0
    n = sum(r[1] for r in res)
    print(f"{tag} {k} at once x{res[0][1]} tokens: last first token {max(r[0] for r in res):.2f}s, median {sorted(r[0] for r in res)[k // 2]:.2f}s, {n / wall:.0f} tok/s total", flush=True)
