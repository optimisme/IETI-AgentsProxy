"""Short greedy prompts of growing length, for the ProposalPaddingPick band (a prompt chunk of 64-127 rows). Prints the
prompt lengths that fail and those that pass, and each reply. usage: short_sweep.py URL [FROM] [TO] [STEP] [TEMPERATURE] [OUT.json]"""
import json, sys, urllib.error, urllib.request

url = sys.argv[1]
lo, hi, step = (int(sys.argv[i]) if len(sys.argv) > i else d for i, d in ((2, 10), (3, 90), (4, 3)))
temperature = float(sys.argv[5]) if len(sys.argv) > 5 else 0
words = "river stone ledger copper lantern orbit meadow cipher harbor velvet quarry signal timber falcon ember glacier".split()
ok, bad, replies = [], [], {}
for n in range(lo, hi, step):
    text = " ".join(words[(i * 7 + n) % len(words)] for i in range(n)) + "\n\nName the first word."
    body = {"model": "x", "messages": [{"role": "user", "content": text}], "max_tokens": 12, "temperature": temperature, "seed": 7,
            "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=300))
        ok.append(r["usage"]["prompt_tokens"])
        replies[str(n)] = r["choices"][0]["message"].get("content")
    except urllib.error.HTTPError as e:
        bad.append((n, e.code, e.read()[:60].decode()))
print("ok prompt tokens", ok)
print("failed (words, status, message)", bad)
if len(sys.argv) > 6:
    json.dump(replies, open(sys.argv[6], "w"), indent=0)
