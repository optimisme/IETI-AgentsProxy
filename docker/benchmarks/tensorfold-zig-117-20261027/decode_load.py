"""16 replies at once from short prompts, for the reply rounds' block times (TF_FLASHNEXT_PROFILE=2): prints wall,
output tokens and tokens/s. usage: decode_load.py URL [STREAMS] [MAX_TOKENS]"""
import json, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

url = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 16
most = int(sys.argv[3]) if len(sys.argv) > 3 else 800
topics = ["a binary heap", "TCP slow start", "the CAP theorem", "Dijkstra's algorithm", "a B-tree insert", "Raft leader election",
          "copy-on-write", "a bloom filter", "two-phase commit", "LRU caches", "garbage collection", "a trie", "consistent hashing",
          "mutexes vs semaphores", "virtual memory paging", "the actor model"]


def one(i):
    body = {"model": "x", "messages": [{"role": "user", "content": f"Explain {topics[i % len(topics)]} with a Python example and its complexity."}],
            "max_tokens": most, "temperature": 0, "stream": False, "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url + "/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=1800))["usage"]["completion_tokens"]


t = time.time()
with ThreadPoolExecutor(n) as ex:
    out = sum(ex.map(one, range(n)))
s = time.time() - t
print("decode load:", n, "streams, wall", round(s, 1), "output", out, "tok/s", round(out / s, 1))
