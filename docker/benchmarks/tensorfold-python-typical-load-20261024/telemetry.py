#!/usr/bin/env python3
"""External clock/temperature telemetry, outside the inference worker."""
import json,subprocess,time
from pathlib import Path
root=Path(__file__).resolve().parent
with (root/'results/hardware.jsonl').open('a',buffering=1) as f:
 while True:
  p=subprocess.run(['nvidia-smi','--query-gpu=name,driver_version,temperature.gpu,power.draw,clocks.sm,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=10)
  f.write(json.dumps({'time':time.time(),'fields':['name','driver_version','temperature_C','power_W','SM_clock_MHz','GPU_utilization_pct'],'raw_csv':p.stdout.strip(),'exit_code':p.returncode})+'\n')
  if (root/'results/controller-result.json').exists():break
  time.sleep(5)
