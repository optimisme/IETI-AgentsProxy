"""N cold prompts at once, for the ProposalPaddingPick 500s: documents no earlier request shares, one-token replies by
default. Prints each reply's status and tokens. usage: cold_many.py URL SEED [N] [TOKENS] [MAX_TOKENS] [TEMPERATURE]"""
import json, random, sys, threading, time, urllib.error, urllib.request

url, seed = sys.argv[1], int(sys.argv[2])
n = int(sys.argv[3]) if len(sys.argv) > 3 else 4
tokens = int(sys.argv[4]) if len(sys.argv) > 4 else 8000
max_tokens = int(sys.argv[5]) if len(sys.argv) > 5 else 1
temperature = float(sys.argv[6]) if len(sys.argv) > 6 else 0
words = "river stone ledger copper lantern orbit meadow cipher harbor velvet quarry signal timber falcon ember glacier".split()
out = [None] * n


def one(i):
    r = random.Random(seed + i)
    lines = [f"Record {k}: " + " ".join(r.choice(words) for _ in range(18)) + f". Code {r.randint(1000, 9999)}." for k in range(tokens * 380 // 13600)]
    body = {"model": "x", "messages": [{"role": "user", "content": "\n".join(lines) + "\n\nWhich code does Record 7 carry?"}],
            "max_tokens": max_tokens, "temperature": temperature, "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t = time.time()
    try:
        u = json.load(urllib.request.urlopen(req, timeout=1800))["usage"]
        out[i] = f"ok {u['completion_tokens']} tokens {time.time() - t:.1f} s"
    except urllib.error.HTTPError as e:
        out[i] = f"HTTP {e.code} {e.read()[:120]!r} {time.time() - t:.1f} s"


ts = [threading.Thread(target=one, args=(i,)) for i in range(n)]
[t.start() for t in ts]
[t.join() for t in ts]
print(f"n {n} tokens {tokens} max {max_tokens} temp {temperature}: {sum(o.startswith('ok') for o in out)} ok of {n}")
for o in out:
    if not o.startswith("ok"):
        print(" ", o)
