#!/usr/bin/env python3
"""Mixed-pass check: 4 greedy code answers decode while long needle prompts fill (their chunks ride the rounds);
every answer and needle saved to OUT/mix.json to compare runs with TF_FLASHNEXT_MIXED=0 and 1."""
import json, sys, time, threading, urllib.request
from pathlib import Path

P = Path.home() / "docker/benchmarks/tensorfold-zig-114-parity-20261024"
url, out = sys.argv[1], Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
topics = ["a binary search in Python", "reversing a linked list in C", "a debounce helper in JavaScript", "FizzBuzz in Rust"]


def ask(content, n):
    body = {"model": "x", "messages": [{"role": "user", "content": content}], "max_tokens": n, "temperature": 0,
            "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    r = json.load(urllib.request.urlopen(req, timeout=900))
    return r["choices"][0]["message"].get("content") or "", r["usage"]["prompt_tokens"], time.time() - t0


files = json.loads((P / "agent-fixture.json").read_text())["files"]
hay = "\n\n".join(f"// file: {f['path']}\n{f['text']}" for f in files)
res = {"answers": {}, "needles": []}
for rnd in range(2):
    def answer(t):
        res["answers"][f"{rnd}:{t}"] = ask(f"Write {t}. Explain each step after the code.", 700)[0]
    ths = [threading.Thread(target=answer, args=(t,)) for t in topics]
    for th in ths: th.start()
    time.sleep(1.5)
    for i, chars in enumerate((60000, 120000)):
        key = f"ORCHID-{555001 + rnd * 97 + i * 13}"
        s = (hay * 2)[:chars]
        cut = s.rfind("\n", 0, int(len(s) * (0.3 + 0.4 * i)))
        text = s[:cut] + f"\n// The project recovery code is {key}.\n" + s[cut:] + "\n\nWhat is the project recovery code? Reply with the code only."
        got, tokens, secs = ask(text, 24)
        res["needles"].append({"tokens": tokens, "key": key, "got": got.strip(), "passed": key in got, "s": round(secs, 1)})
        print("needle", tokens, key in got, repr(got.strip()[:30]), f"{secs:.1f}s", flush=True)
    for th in ths: th.join()
(out / "mix.json").write_text(json.dumps(res, indent=1) + "\n")
print("needles passed", sum(r["passed"] for r in res["needles"]), "of", len(res["needles"]), flush=True)
