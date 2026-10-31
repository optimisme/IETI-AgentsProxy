#!/usr/bin/env bash
# On 2226: quick screen of Flash-Next candidates on the 16-user agent run (Python's prompts, tag py16-u16).
#   quick.sh <stage> <spec> [<spec> ...]      the first spec is the baseline; each spec runs on a fresh server
#   spec = label[:KEY=value,KEY=value]
#     BUILD=117|116   build volume (default $BUILD, else 117); 116 is the 1.1.6 build tf116-20261026c via ../tensorfold-zig-116-mixed-20261026/up-116c.sh
#     TEMP=, TOPP=    agent request sampling (default 0 and 0.95)
#     anything else   engine environment, exported before the server starts (profile TF_EXTRA_ENV)
# Environment: TURNS (5; 8 = the full run), PASSES (1; 2 alternates the specs twice), CHECK=1 (greedy together vs
# alone, needles and greedy answers against the baseline's, after each spec's last pass).
# Screen: quick.sh <stage> base cand...  Confirm a winner: TURNS=8 PASSES=2 CHECK=1 quick.sh <stage>-confirm base winner
# Results: quick-<stage>/summary.txt (one line a run, then each spec's mean and its difference to the baseline).
set -uo pipefail
stage=${1:?stage}; shift
[ $# -ge 1 ] || { echo "no specs"; exit 1; }
H=~/docker/benchmarks/tensorfold-zig-117-20261027
P=~/docker/benchmarks/tensorfold-zig-114-parity-20261024
H116=~/docker/benchmarks/tensorfold-zig-116-mixed-20261026
C=qwen38_flash_next_tensorfold_best_cuda
D=$H/quick-$stage
mkdir -p "$D"
S=$D/summary.txt
echo "# $(date -Is) stage $stage turns ${TURNS:-5} passes ${PASSES:-1} check ${CHECK:-0}: $*" >> "$S"

run() { # spec pass
  local label=${1%%:*} kv="" build=${BUILD:-117} temp=0 topp=0.95 extra=()
  [[ $1 == *:* ]] && kv=${1#*:}
  local IFS=,
  for p in $kv; do
    case $p in
      BUILD=*) build=${p#BUILD=} ;;
      TEMP=*) temp=${p#TEMP=} ;;
      TOPP=*) topp=${p#TOPP=} ;;
      ?*) extra+=("$p") ;;
    esac
  done
  unset IFS
  local name=$label-$2 up=$H/up-117.sh
  [ "$build" = 116 ] && up=$H116/up-116c.sh
  echo "== $name build $build temp $temp env ${extra[*]:-}"
  env "${extra[@]}" TF_EXTRA_ENV="${extra[*]:-}" TF_HOST_TRACE=1 bash "$up" | tail -1 || return 1
  rm -rf "$D/agent-$name"
  (cd $P && python3 agent.py --url http://127.0.0.1:8007 --users 16 --turns "${TURNS:-5}" --tag py16-u16 \
      --temperature "$temp" --top-p "$topp" --out "$D/agent-$name") 2>&1 | python3 -c "
import sys, json
for l in sys.stdin:
    try:
        s = json.loads(l)
        print('$label', '$2', 'tok/s', round(s['output_tok_s'], 1), 'ttft0', round(s['ttft_first_p50'], 2),
              'ttftN50', round(s['ttft_later_p50'], 2), 'ttftN95', round(s['ttft_later_p95'], 2),
              'decode50', round(s['decode_tok_s_p50'], 1), 'wall', round(s['wall_s'], 1), 'errors', s['errors'], flush=True)
    except Exception:
        print('#', l.strip()[:300], flush=True)" | tee -a "$S"
  docker logs $C > "$D/$name.log" 2>&1
  grep -i -E "panic|fault|CudaFailed" "$D/$name.log" | head -3 | sed 's/^/# /' | tee -a "$S"
  if [ "${CHECK:-0}" = 1 ] && [ "$2" = "${PASSES:-1}" ]; then
    (cd $P && python3 greedy_check.py 2>&1 | tail -2 && python3 kv8_check.py http://127.0.0.1:8007 "quick-$stage-$label" 2>&1 | tail -1) \
      | sed "s/^/# $label check: /" | tee -a "$S"
  fi
}

for pass in $(seq 1 "${PASSES:-1}"); do
  for spec in "$@"; do run "$spec" "$pass" || { echo "# $spec failed to start" | tee -a "$S"; exit 1; }; done
done

python3 - "$S" "$P" "$stage" "${CHECK:-0}" "$@" <<'EOF'
import sys, json, os, statistics as st
path, P, stage, check, specs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
labels = [s.split(':')[0] for s in specs]
lines = open(path).read().split('\n')
start = max(i for i, l in enumerate(lines) if l.startswith('# ') and ' stage ' in l)
runs = {}
for l in lines[start:]:
    f = l.split()
    if len(f) > 3 and f[0] in labels and f[2] == 'tok/s':
        runs.setdefault(f[0], []).append(dict(zip(f[2::2], map(float, f[3::2]))))
base = runs.get(labels[0])
out = []
for lab in labels:
    r = runs.get(lab)
    if not r:
        out.append(f'mean {lab}: no runs'); continue
    m = {k: st.mean(x[k] for x in r) for k in r[0]}
    d = f" ({(m['tok/s'] / st.mean(x['tok/s'] for x in base) - 1) * 100:+.1f}% vs {labels[0]})" if base and lab != labels[0] else ''
    out.append(f"mean {lab} n={len(r)} tok/s {m['tok/s']:.1f}{d} ttftN50 {m['ttftN50']:.2f} ttftN95 {m['ttftN95']:.2f} decode50 {m['decode50']:.1f}")
    if check == '1' and lab != labels[0]:
        try:
            a = json.load(open(f'{P}/quick-{stage}-{labels[0]}/answers.json')); b = json.load(open(f'{P}/quick-{stage}-{lab}/answers.json'))
            out.append(f'  answers equal to {labels[0]}: {sum(a[k] == b.get(k) for k in a)} of {len(a)}')
        except Exception as e:
            out.append(f'  answers: {e}')
open(path, 'a').write('\n'.join(out) + '\n')
print('\n'.join(out))
EOF
echo quick-done
