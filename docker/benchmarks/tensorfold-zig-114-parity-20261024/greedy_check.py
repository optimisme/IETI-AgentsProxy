"""Greedy outputs of 8 distinct prompts sent together vs each sent alone (batched prompt pass must not change text)."""
import json, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8007"
topics = ["a binary search in Python", "reversing a linked list in C", "a debounce helper in JavaScript", "FizzBuzz in Rust",
          "a SQL query for the top 3 salaries", "a bash loop renaming .txt files", "a Go HTTP health handler", "quicksort in Java"]

def ask(topic):
    body = {"model": "x", "messages": [{"role": "user", "content": f"Write {topic}. Code only."}],
            "max_tokens": 96, "temperature": 0, "stream": False}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    m = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]
    return (m.get("reasoning_content") or "") + "|" + (m.get("content") or "")

alone = [ask(t) for t in topics]
for rep in range(2):
    with ThreadPoolExecutor(8) as ex:
        together = list(ex.map(ask, topics))
    same = sum(a == b for a, b in zip(alone, together))
    print(f"round {rep}: {same}/8 identical")
    for t, a, b in zip(topics, alone, together):
        if a != b:
            n = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            print(f"  differs: {t!r} at char {n}: {a[n:n+40]!r} vs {b[n:n+40]!r}")
