#!/usr/bin/env python3
"""Optional external process counter observer for a screening run."""
import json,sys,time
from pathlib import Path
import process_metrics
root=Path(__file__).resolve().parent
run=sys.argv[1];assert run.replace('-','').replace('_','').isalnum()
folder=root/'results'/run
identity=process_metrics.resolve('qwen38_flash_next_python_opt16',folder/'engine.jsonl')
with (folder/'process.jsonl').open('a',buffering=1) as f:
 while True:
  try:value=process_metrics.sample(identity)
  except (OSError,AssertionError):break
  f.write(json.dumps({'time':time.time(),**value})+'\n')
  time.sleep(1)
