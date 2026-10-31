"""Greedy two-turn conversations (8 at once, ~12k-token documents): the second turn resumes the first's kept state, so
its replies must be the same whichever way the state was kept (a copy, or resident rows), written to <out>.json.
usage: reuse_check.py URL OUT [OTHER.json]"""
import json, random, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

url, out = sys.argv[1], sys.argv[2]
words = "river stone ledger copper lantern orbit meadow cipher harbor velvet quarry signal timber falcon ember glacier".split()


def doc(i):
    r = random.Random(4100 + i)
    lines = [f"Record {k}: " + " ".join(r.choice(words) for _ in range(18)) + f". Code {r.randint(1000, 9999)}." for k in range(380)]
    return "\n".join(lines)


def ask(messages):
    body = {"model": "x", "messages": messages, "max_tokens": 48, "temperature": 0, "stream": False,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=600))
    return r["choices"][0]["message"].get("content") or "", r["usage"]


def talk(i):
    m = [{"role": "user", "content": doc(i) + f"\n\nWhich code does Record {37 + i} carry? Answer with the code only."}]
    a1, u1 = ask(m)
    m += [{"role": "assistant", "content": a1}, {"role": "user", "content": f"And Record {200 + i}? Code only."}]
    a2, u2 = ask(m)
    return a1, a2, u2["prompt_tokens"], (u2.get("prompt_tokens_details") or {}).get("cached_tokens", 0)


with ThreadPoolExecutor(8) as ex:
    res = list(ex.map(talk, range(8)))
t1 = [r[0] for r in res]; t2 = [r[1] for r in res]
print("turn 2 prompt tokens", [r[2] for r in res], "cached", [r[3] for r in res])
json.dump({"turn1": t1, "turn2": t2, "cached": [r[3] for r in res]}, open(out + ".json", "w"), indent=1)
if len(sys.argv) > 3:
    o = json.load(open(sys.argv[3]))
    print("turn 1 =", sys.argv[3] + ":", sum(a == b for a, b in zip(o["turn1"], t1)), "of 8")
    print("turn 2 =", sys.argv[3] + ":", sum(a == b for a, b in zip(o["turn2"], t2)), "of 8")
