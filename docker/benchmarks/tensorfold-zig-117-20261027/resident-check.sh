#!/usr/bin/env bash
# On 2226: the resident prompt states candidate. With full windows the elastic cache has no room to copy a state, so a
# mark keeps only the DeltaNet state (~110 MiB) and its rows stay in the stream's caches, which outlive the stream
# until a return turn resumes them. Stages (STAGES, default all but the baselines):
#   exact      greedy together vs alone, needles and answers, sampled replies against the best build's
#   quick      about a minute once the server is up, first by default: the band's short prompts at both temperatures. Any
#              error or changed reply stops the run here
#   band       short prompts through the 64-127 row chunks (74-136 tokens) and four 74k prompts at temperature 0: no
#              errors, replies as variants/tf119d/band-*.json
#   reuse      two-turn conversations resumed from copies, then from resident states (TF_PROMPT_CACHE_RESIDENT_ALWAYS=1):
#              the replies must be the same (reuse_check.py)
#   capacity   16 requests near TOKENS (default 74000) and two return turns (the Python campaign's probe)
#   agent      the 16-user agent run at temperature 0.1
#   capacity-best, capacity-python   the same capacity probe on the best build and on Python (baselines)
# Results: resident/summary.txt and resident/capacity-<build>-<tokens>/. Leaves the last server running.
#   RVAR (resident2): the candidate's variant; RESIDENT_GIB (2): the floor resident states copy into;
#   CACHE_GIB (24): the elastic cache's cap (ended streams' caches count against it); RENV: more server env, such as
#   TF_FILL_AGING_ROUNDS=1000000 (prompts finish one after another instead of together)
set -uo pipefail
H=~/docker/benchmarks/tensorfold-zig-117-20261027
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
C=qwen38_flash_next_tensorfold_best_cuda
PY=qwen38_flash_next_python_lowload
D=$H/resident
S=$D/summary.txt
RV=${RVAR:-resident2}
T=${TOKENS:-74000}
mkdir -p "$D"
EXTRA="TF_PROMPT_CACHE_RESIDENT_GIB=${RESIDENT_GIB:-2}${RENV:+ $RENV}"
echo "# $(date -Is) resident-check $RV $EXTRA cache ${CACHE_GIB:-24} GiB tokens $T stages ${STAGES:-quick exact reuse capacity agent}" >> "$S"

up() { docker stop $PY > /dev/null 2>&1; env $EXTRA TF_EXTRA_ENV="$EXTRA${1:+ $1}" TENSORFOLD_PROMPT_CACHE_GIB=${CACHE_GIB:-24} VARIANT=$RV bash $H/up-117.sh | tail -1; }
errs() { docker logs $C 2>&1 | grep -i -E "panic|segfault|CudaFailed|out of memory|resident failed" | head -3 | sed "s/^/# /" | tee -a "$S"; }

capacity() { # label url
  local out=$D/capacity-$1-$T
  rm -rf $out
  PROBE_CAPACITY_TOKENS=$T PROBE_MIN_FREE_GIB=3 python3 -u $H/zig_probe.py capacity --base $2 --out $out --tag resident-$1-$T 2>&1 \
    | grep -E "SAFETY|Error|Traceback" | cut -c1-400 | tee -a "$S"
  python3 - "$out" "$1" <<'EOF' | tee -a "$S"
import json, sys
out, label = sys.argv[1], sys.argv[2]
for n in ('cold16', 'return1-16', 'return2-16'):
    try:
        s = json.load(open(f'{out}/capacity-{n}.json'))['summary']
    except Exception as e:
        print(label, n, 'missing'); continue
    print(label, n, 'wall', round(s['wall_s'], 1), 'tok/s', round(s['aggregate_output_tok_s'], 1), 'ttft p50/p95',
          round(s['ttft_p50_s'], 1), round(s['ttft_p95_s'], 1), 'prompt', s['input_tokens'][0], 'cached', s['cached_tokens'],
          'overlap', s['peak_overlapping_output_streams'], 'min free', round(s['min_available_gib'], 1), 'swap pages', s['swap_out_pages'])
EOF
}

sweeps() { # the short prompts at both temperatures against the reference: non-zero on an error or a changed reply
  local bad=0 t n f
  for t in 0 0.1; do
    n=${t/./}; [ $t = 0 ] && f=40 || f=10
    python3 $H/short_sweep.py http://127.0.0.1:8007 $f 140 2 $t $D/band-$n.json 2>&1 | tail -1 | cut -c1-200 | tee -a "$S"
    python3 -c "import json, sys
a=json.load(open('$H/variants/tf119d/band-t$n.json')); b=json.load(open('$D/band-$n.json'))
same=sum(a[k]==b.get(k) for k in a)
print('band temperature $t: equal to tf119d', same, 'of', len(a))
sys.exit(same != len(a))" | tee -a "$S"
    [ "${PIPESTATUS[0]}" = 0 ] || bad=1
  done
  errs
  return $bad
}

for stage in ${STAGES:-quick exact reuse capacity agent}; do
  echo "== $stage $(date -Is)" | tee -a "$S"
  case $stage in
    exact)
      up || exit 1
      docker logs $C 2>&1 | grep -m2 -E "extra env|prompt cache: elastic" | tee -a "$S"
      (cd $P && python3 greedy_check.py 2>&1 | tail -2 && python3 kv8_check.py http://127.0.0.1:8007 kvcheck-resident 2>&1 | tail -1) | tee -a "$S"
      python3 -c "import json
a=json.load(open('$P/kvcheck-117/answers.json')); b=json.load(open('$P/kvcheck-resident/answers.json'))
print('answers equal to kvcheck-117:', sum(a[k]==b.get(k) for k in a), 'of', len(a))" | tee -a "$S"
      python3 $H/sampled_check.py http://127.0.0.1:8007 $D/sampled $H/variants/sampled/sampled-on.json 2>&1 | tee -a "$S"
      errs ;;
    quick)
      up || exit 1
      sweeps || exit 1 ;;
    band)
      up || exit 1
      sweeps || exit 1
      python3 $H/cold_many.py http://127.0.0.1:8007 $(( $(date +%s) % 100000 * 10 )) 4 74000 8 2>&1 | tee -a "$S"
      errs ;;
    reuse)
      docker stop $PY > /dev/null 2>&1
      env TF_EXTRA_ENV= VARIANT=$RV bash $H/up-117.sh | tail -1 || exit 1
      python3 $H/reuse_check.py http://127.0.0.1:8007 $D/reuse-copies 2>&1 | tee -a "$S"
      up TF_PROMPT_CACHE_RESIDENT_ALWAYS=1 || exit 1
      python3 $H/reuse_check.py http://127.0.0.1:8007 $D/reuse-resident $D/reuse-copies.json 2>&1 | tee -a "$S"
      docker logs $C 2>&1 | grep "prompt cache:" | grep -v "kept nothing" | tail -1 | cut -c1-300 | sed 's/^/# /' | tee -a "$S"
      errs ;;
    capacity)
      up || exit 1
      capacity $RV${CLABEL:+-$CLABEL} http://127.0.0.1:8007
      docker logs $C 2>&1 | grep "prompt cache:" | grep -v "kept nothing" | tail -1 | cut -c1-300 | sed 's/^/# /' | tee -a "$S"
      docker logs $C > $D/capacity-$RV${CLABEL:+-$CLABEL}-$T.log 2>&1
      errs ;;
    capacity-best)
      docker stop $PY > /dev/null 2>&1
      bash $H/up-117.sh | tail -1 || exit 1
      capacity best http://127.0.0.1:8007
      errs ;;
    capacity-python)
      docker stop $C > /dev/null 2>&1
      IETI_RUN=resident-check docker compose -f ~/docker/models/qwen38-flash-next-python-typical-original-test-128gb.yml up -d --force-recreate 2>&1 | tail -1
      start=$(date +%s)
      until curl -sf http://127.0.0.1:8009/health > /dev/null; do
        [ $(( $(date +%s) - start )) -gt 1800 ] && { echo "python not ready" | tee -a "$S"; exit 1; }
        sleep 10
      done
      PROBE=1 capacity python${CLABEL:+-$CLABEL} http://127.0.0.1:8009
      docker stop $PY > /dev/null 2>&1 ;;
    agent)
      up || exit 1
      A=$D/agent${CLABEL:+-$CLABEL}
      rm -rf $A
      (cd $P && python3 agent.py --url http://127.0.0.1:8007 --users 16 --turns 8 --tag py16-u16 --temperature 0.1 --top-p 0.95 \
        --out $A) 2>&1 | python3 -c "
import sys, json
for l in sys.stdin:
    try:
        s = json.loads(l)
        print('agent tok/s', round(s['output_tok_s'], 1), 'ttft0', round(s['ttft_first_p50'], 2), 'ttftN50', round(s['ttft_later_p50'], 2),
              'ttftN95', round(s['ttft_later_p95'], 2), 'decode50', round(s['decode_tok_s_p50'], 1), 'errors', s['errors'],
              'cached', s['cached_tokens_sum'], 'minfree', round(s['min_available_gib'], 1), flush=True)
    except Exception:
        print('#', l.strip()[:300], flush=True)" | tee -a "$S"
      docker logs $C > $A.log 2>&1
      errs ;;
  esac
done
echo resident-check-done | tee -a "$S"
