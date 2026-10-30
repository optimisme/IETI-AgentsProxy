"""Are the replies real text, not rubbish? Each of N cold long documents (sizes spaced so some prompts' last chunks fall
in the 64-127 row band) asks for one record's code, the first records' or the last's: the reply must carry that code.
With a short_sweep JSON as well, its replies are checked for rubbish too. Exit 1 on any failure.
usage: sane_replies.py URL SEED [N] [TOKENS] [STEP] [TEMPERATURE] [SWEEP.json ...]"""
import json, random, re, sys, threading, time, urllib.error, urllib.request

url, seed = sys.argv[1], int(sys.argv[2])
n = int(sys.argv[3]) if len(sys.argv) > 3 else 6
tokens = int(sys.argv[4]) if len(sys.argv) > 4 else 74000
step = int(sys.argv[5]) if len(sys.argv) > 5 else 37
temperature = float(sys.argv[6]) if len(sys.argv) > 6 else 0.1
words = "river stone ledger copper lantern orbit meadow cipher harbor velvet quarry signal timber falcon ember glacier".split()
out = [None] * n


def rubbish(text):
    """Why a reply is rubbish, or None."""
    t = text.strip()
    if not t:
        return "empty"
    if re.search(r"(.)\1{7,}", t):
        return "a character repeated 8 times"
    if re.search(r"(\S{1,12}\s*)\1{5,}", t):
        return "a word repeated 6 times"
    if sum(c.isalnum() or c.isspace() for c in t) < 0.7 * len(t):
        return "mostly symbols"
    return None


def one(i):
    r = random.Random(seed + i)
    count = (tokens - i * step) * 380 // 13600
    codes = [r.randint(1000, 9999) for _ in range(count)]
    lines = [f"Record {k}: " + " ".join(r.choice(words) for _ in range(18)) + f". Code {codes[k]}." for k in range(count)]
    ask = 7 if i % 2 == 0 else count - 3
    body = {"model": "x", "messages": [{"role": "user", "content": "\n".join(lines) + f"\n\nWhich code does Record {ask} carry? Answer with one sentence."}],
            "max_tokens": 48, "temperature": temperature, "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        j = json.load(urllib.request.urlopen(req, timeout=1800))
    except urllib.error.HTTPError as e:
        out[i] = (False, f"HTTP {e.code} {e.read()[:120]!r}")
        return
    text = j["choices"][0]["message"]["content"] or ""
    p = j["usage"]["prompt_tokens"]
    bad = rubbish(text)
    right = str(codes[ask]) in text
    out[i] = (right and not bad, f"prompt {p} (last chunk {(p - 1) % 4096 + 1}) record {ask} wants {codes[ask]}: {bad or ('right' if right else 'WRONG')}: {text[:90]!r}")


t = time.time()
ts = [threading.Thread(target=one, args=(i,)) for i in range(n)]
[x.start() for x in ts]
[x.join() for x in ts]
good = sum(o[0] for o in out)
print(f"long documents: right and clean {good} of {n} in {time.time() - t:.0f} s")
for o in out:
    print(" ", "ok " if o[0] else "BAD", o[1])
bad_sweep = 0
for path in sys.argv[7:]:
    d = json.load(open(path))
    seen = [(k, v if isinstance(v, str) else json.dumps(v)) for k, v in d.items()]
    wrong = [(k, rubbish(v), v[:70]) for k, v in seen if rubbish(v)]
    print(f"{path.rsplit('/', 1)[-1]}: clean {len(seen) - len(wrong)} of {len(seen)}")
    for w in wrong[:5]:
        print("  BAD", w)
    bad_sweep += len(wrong)
sys.exit(good != n or bad_sweep != 0)
