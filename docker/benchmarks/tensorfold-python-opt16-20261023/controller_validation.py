#!/usr/bin/env python3
"""Detached, resumable private GPU campaign with independent guards and restoration."""
import datetime,fcntl,hashlib,json,os,signal,subprocess,sys,threading,time,urllib.request
from pathlib import Path
import base_probe as base
import process_metrics
ROOT=Path(__file__).resolve().parent
DOCKER=ROOT.parent.parent
RESULTS=ROOT/'results'
NORMAL='qwen38_flash_next_cuda_vram128_tensorfold_mlx_4bit_mtp_int8_ssd_vision'
TEST='qwen38_flash_next_python_opt16'
ABORT=threading.Event();STOP=threading.Event();ACTIVE=threading.Event()
INTERRUPTED=[]
CURRENT=None
CURRENT_PROCESS=None


def save(path,x):
    path.write_text(json.dumps(x,indent=2)+'\n')


def docker(*args,timeout=90,check=True,env=None):
    p=subprocess.run(['docker',*args],capture_output=True,text=True,timeout=timeout,env=env)
    if check and p.returncode:raise RuntimeError(f'docker {args[:2]} failed: '+p.stderr[-3000:])
    return p.stdout


def health(port):
    return base.api(f'http://127.0.0.1:{port}','/health')


def guard():
    initial=None
    while not STOP.wait(.5):
        if not ACTIVE.is_set():initial=None;continue
        m=base.memory()
        if initial is None:initial=m
        reason=None
        if INTERRUPTED:reason='interrupted'
        elif m['available_gib']<6:reason='host_available_below_6GiB'
        elif m['oom_kill']>initial['oom_kill']:reason='new_host_OOM'
        elif m['pswpout']-initial['pswpout']>262144:reason='new_swap_out_above_1GiB'
        if reason:
            save(CURRENT/'safety-abort.json',{'reason':reason,'memory':m,'initial':initial,'epoch':time.time()})
            ABORT.set();docker('stop','--timeout','10',TEST,check=False,timeout=45);return


def wait_healthy(port,timeout):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if ABORT.is_set() or INTERRUPTED:raise RuntimeError('Interrupted or safety guard triggered')
        if port==8009 and docker('inspect',TEST,'--format','{{.State.Running}}',check=False).strip()!='true':
            raise RuntimeError('Private container exited during startup')
        try:
            h=health(port)
            if h.get('ok'):return h
        except Exception:pass
        time.sleep(3)
    raise RuntimeError(f'Health timeout on private/restored port {port}')


def observe(folder,stop):
    import re
    with (folder/'prometheus.jsonl').open('a',buffering=1) as f:
        while not stop.is_set():
            try:
                with urllib.request.urlopen('http://127.0.0.1:8009/metrics',timeout=3) as r:raw=r.read().decode()
                metrics={}
                for line in raw.splitlines():
                    m=re.match(r'([^\s{]+)\s+([^\s]+)$',line)
                    if m and not line.startswith('#'):
                        try:metrics[m[1]]=float(m[2])
                        except ValueError:pass
                f.write(json.dumps({'time':time.time(),'metrics':metrics,'serving_process':process_metrics.sample(CURRENT_PROCESS),**base.memory()})+'\n')
            except Exception as error:f.write(json.dumps({'time':time.time(),'error':repr(error)})+'\n')
            stop.wait(1)


def main():
    global CURRENT, CURRENT_PROCESS
    RESULTS.mkdir(exist_ok=True)
    lock=(ROOT/'controller.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda n,f:INTERRUPTED.append(n))
    initial=json.loads(docker('inspect',NORMAL,'--format','{{json .State}}'))
    save(RESULTS/'normal-state-before.json',initial)
    guard_thread=threading.Thread(target=guard,daemon=True);guard_thread.start()
    error=None;completed=[];restored=False;normal_stopped=False
    try:
        assert initial['Running'],'Original Python service must be running before campaign'
        deadline=time.monotonic()+180
        while health(8000).get('requests_running',0):
            if time.monotonic()>deadline:raise RuntimeError('Normal service did not become idle')
            time.sleep(2)
        normal_stopped=True
        docker('stop','--timeout','60',NORMAL)
        while True:
            plan=json.loads((ROOT/'validation_plan.json').read_text())
            run=next((r for r in plan['runs'] if not (RESULTS/r['id']/'result.json').exists()),None)
            if run is None:break
            assert run['id'].replace('-','').replace('_','').isalnum()
            CURRENT=RESULTS/run['id'];CURRENT.mkdir(exist_ok=True)
            assert not (CURRENT/'started.json').exists(),'Preserve partial trial; select a fresh run ID'
            save(CURRENT/'started.json',{'epoch':time.time(),'run':run,'plan_sha256':hashlib.sha256((ROOT/'validation_plan.json').read_bytes()).hexdigest()})
            env={**os.environ,'IETI_RUN':run['id']}
            profile=DOCKER/run['profile']
            assert profile.is_file()
            save(CURRENT/'profile.json',{'path':run['profile'],'sha256':hashlib.sha256(profile.read_bytes()).hexdigest()})
            ACTIVE.set()
            docker('compose','-f',str(profile),'config','--quiet',env=env)
            docker('compose','-f',str(profile),'up','-d','--force-recreate',env=env,timeout=180)
            h=wait_healthy(8009,1200)
            save(CURRENT/'health-before.json',h)
            subprocess.run([sys.executable,str(ROOT/'runtime_inventory.py'),run['id']],check=True)
            selected='{{json .State}}'
            save(CURRENT/'state-before.json',json.loads(docker('inspect',TEST,'--format',selected)))
            (CURRENT/'startup.log').write_text(docker('logs',TEST))
            CURRENT_PROCESS=process_metrics.resolve(TEST,CURRENT/'engine.jsonl')
            save(CURRENT/'serving-process.json',CURRENT_PROCESS)
            observed_stop=threading.Event();observer=threading.Thread(target=observe,args=(CURRENT,observed_stop),daemon=True);observer.start()
            calibration={'started_epoch':time.time(),'before':{**base.memory(),'serving_process':process_metrics.sample(CURRENT_PROCESS)}}
            for _ in range(30):
                if ABORT.is_set() or INTERRUPTED:break
                time.sleep(1)
            calibration.update(ended_epoch=time.time(),after={**base.memory(),'serving_process':process_metrics.sample(CURRENT_PROCESS)})
            save(CURRENT/'idle-calibration.json',calibration)
            client=None
            try:
                with (CURRENT/'client.log').open('w') as log:
                    client=subprocess.Popen([sys.executable,'-u',str(ROOT/run.get('script','run_suite.py')),'--out',str(CURRENT/'client'),'--suite',run.get('suite','capacity')],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
                    started=time.monotonic()
                    while client.poll() is None:
                        if ABORT.is_set() or INTERRUPTED or time.monotonic()-started>4500:
                            raise RuntimeError('Trial interrupted, guarded, or exceeded 75 minutes')
                        time.sleep(1)
                    code=client.returncode
                if code!=0:raise RuntimeError(f'Benchmark failed with exit {code}; see client.log')
                save(CURRENT/'health-after.json',health(8009))
            finally:
                if client is not None and client.poll() is None:
                    os.killpg(client.pid,signal.SIGTERM)
                    try:client.wait(timeout=5)
                    except subprocess.TimeoutExpired:os.killpg(client.pid,signal.SIGKILL);client.wait(timeout=5)
                observed_stop.set();observer.join(timeout=5)
                (CURRENT/'runtime.log').write_text(docker('logs',TEST,check=False))
                docker('stop','--timeout','20',TEST,check=False)
                ACTIVE.clear()
                save(CURRENT/'state-after.json',json.loads(docker('inspect',TEST,'--format',selected)))
            save(CURRENT/'result.json',{'completed':True,'client_exit_code':code,'epoch':time.time()})
            completed.append(run['id'])
            print(json.dumps({'completed_run':run['id'],'epoch':time.time()}),flush=True)
    except BaseException as exc:
        error=repr(exc);print('CAMPAIGN_ERROR',error,flush=True)
    finally:
        ACTIVE.clear();STOP.set()
        if CURRENT is not None:
            (CURRENT/'final-runtime.log').write_text(docker('logs',TEST,check=False))
        docker('stop','--timeout','20',TEST,check=False)
        if normal_stopped:docker('start',NORMAL,check=False)
        # Restoration must still run after a user/controller interruption or memory abort.
        for _ in range(400):
            try:
                h=health(8000)
                if h.get('ok'):
                    restored=True;save(RESULTS/'restored-health.json',h);break
            except Exception:pass
            time.sleep(3)
        state=json.loads(docker('inspect',NORMAL,'--format','{{json .State}}'))
        save(RESULTS/'restored-state.json',state)
        save(RESULTS/'controller-result.json',{'error':error,'completed_runs':completed,'original_python_healthy':restored,'normal_stopped_for_test':normal_stopped,'epoch':time.time()})
    return 0 if error is None and restored else 1

if __name__=='__main__':sys.exit(main())
