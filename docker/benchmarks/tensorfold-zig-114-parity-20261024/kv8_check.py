#!/usr/bin/env python3
"""Quality of a KV cache setting: greedy code answers (saved, to compare across settings) and needles in long code haystacks."""
import json, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
url, out = sys.argv[1], ROOT / sys.argv[2]
out.mkdir(exist_ok=True)
topics = ["a binary search in Python", "reversing a linked list in C", "a debounce helper in JavaScript", "FizzBuzz in Rust",
          "a SQL query for the top 3 salaries", "a bash loop renaming .txt files", "a Go HTTP health handler", "quicksort in Java"]


def ask(content, n):
    body = {"model": "x", "messages": [{"role": "user", "content": content}], "max_tokens": n, "temperature": 0,
            "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=900))
    return r["choices"][0]["message"].get("content") or "", r["usage"]["prompt_tokens"]


answers = {t: ask(f"Write {t}. Code only.", 160)[0] for t in topics}
(out / "answers.json").write_text(json.dumps(answers, indent=1) + "\n")
files = json.loads((ROOT / "agent-fixture.json").read_text())["files"]
hay = "\n\n".join(f"// file: {f['path']}\n{f['text']}" for f in files)
results = []
for i, chars in enumerate((40000, 100000, 180000)):
    for depth in (0.2, 0.5, 0.8):
        key = f"ORCHID-{908173 + i * 239 + int(depth * 10)}"
        s = (hay * 2)[:chars]
        cut = s.rfind("\n", 0, int(len(s) * depth))
        text = s[:cut] + f"\n// The project recovery code is {key}.\n" + s[cut:] + "\n\nWhat is the project recovery code? Reply with the code only."
        got, tokens = ask(text, 24)
        results.append({"tokens": tokens, "depth": depth, "key": key, "got": got.strip(), "passed": key in got})
        print("needle", tokens, depth, key in got, repr(got.strip()[:40]), flush=True)
(out / "needles.json").write_text(json.dumps(results, indent=1) + "\n")
print("needles passed", sum(r["passed"] for r in results), "of", len(results), flush=True)
