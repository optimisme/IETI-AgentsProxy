"""Sampled outputs (temperature 0.55, fixed seeds) of 8 distinct prompts: sent together vs alone and drafts on vs off,
written to <out>.json so two server settings can be compared (the sampled-draft paths must not change any token).
usage: sampled_check.py URL OUT [OTHER.json]"""
import json, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

url, out = sys.argv[1], sys.argv[2]
topics = ["a binary search in Python", "reversing a linked list in C", "a debounce helper in JavaScript", "FizzBuzz in Rust",
          "a SQL query for the top 3 salaries", "a bash loop renaming .txt files", "a Go HTTP health handler", "quicksort in Java"]

def ask(i, draft=True):
    body = {"model": "x", "messages": [{"role": "user", "content": f"Write {topics[i]}. Code only."}],
            "max_tokens": 160, "temperature": 0.55, "top_p": 0.95, "top_k": 20, "seed": 1000 + i, "stream": False,
            "chat_template_kwargs": {"enable_thinking": False}}
    if not draft:
        body["draft"] = False
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    m = json.load(urllib.request.urlopen(req, timeout=300))["choices"][0]["message"]
    return m.get("content") or ""

plain = [ask(i, draft=False) for i in range(8)]
alone = [ask(i) for i in range(8)]
with ThreadPoolExecutor(8) as ex:
    together = list(ex.map(ask, range(8)))
print("drafted alone = undrafted:", sum(a == b for a, b in zip(alone, plain)), "of 8")
print("together = alone:", sum(a == b for a, b in zip(together, alone)), "of 8")
json.dump({"plain": plain, "alone": alone, "together": together}, open(out + ".json", "w"), indent=1)
if len(sys.argv) > 3:
    other = json.load(open(sys.argv[3]))
    for k in ("plain", "alone", "together"):
        print(f"{k} = {sys.argv[3]}:", sum(a == b for a, b in zip(other[k], locals()[k])), "of 8")
