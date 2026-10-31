#!/usr/bin/env python3
"""Archive controller-session records, then detach cleanly from SSH."""
import datetime,fcntl,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent
lock=(root/'controller.lock').open('a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
results=root/'results';results.mkdir(exist_ok=True)
if (results/'controller-result.json').exists():
 archive=root/'sessions'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 archive.mkdir(parents=True,exist_ok=False)
 for name in ('controller-result.json','normal-state-before.json','restored-health.json','restored-state.json'):
  p=results/name
  if p.exists():(archive/name).write_bytes(p.read_bytes())
 if (root/'controller.log').exists():(archive/'controller.log').write_bytes((root/'controller.log').read_bytes())
 (results/'controller-result.json').unlink()
lock.close()
with (root/'controller.log').open('w') as log:
 p=subprocess.Popen([sys.executable,'-u',str(root/'controller.py')],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
(root/'controller.pid').write_text(str(p.pid)+'\n')
with (root/'telemetry.log').open('a') as log:
 observer=subprocess.Popen([sys.executable,str(root/'telemetry.py')],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
(root/'telemetry.pid').write_text(str(observer.pid)+'\n')
print(json.dumps({'controller_pid':p.pid,'telemetry_pid':observer.pid}))
