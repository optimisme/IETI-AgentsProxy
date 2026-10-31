"""One cold prompt of about TOKENS tokens, alone, for the per-chunk profile (TF_FLASHNEXT_PROFILE): a document of random
records no earlier request shares, then a one-token reply. usage: cold_one.py URL SEED [TOKENS]"""
import json, random, sys, time, urllib.request

url, seed = sys.argv[1], int(sys.argv[2])
tokens = int(sys.argv[3]) if len(sys.argv) > 3 else 74000
words = "river stone ledger copper lantern orbit meadow cipher harbor velvet quarry signal timber falcon ember glacier".split()
r = random.Random(seed)
lines = [f"Record {k}: " + " ".join(r.choice(words) for _ in range(18)) + f". Code {r.randint(1000, 9999)}." for k in range(tokens * 380 // 13600)]
body = {"model": "x", "messages": [{"role": "user", "content": "\n".join(lines) + "\n\nWhich code does Record 7 carry?"}],
        "max_tokens": 1, "temperature": 0, "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
t = time.time()
req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
u = json.load(urllib.request.urlopen(req, timeout=1800))["usage"]
s = time.time() - t
print("cold one: prompt", u["prompt_tokens"], "seconds", round(s, 1), "tok/s", round(u["prompt_tokens"] / s))
