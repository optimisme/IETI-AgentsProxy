"""Read only the private serving process's /proc counters; no CUDA calls."""
import json,os,subprocess
from pathlib import Path


def sample(identity):
    path=Path('/proc')/str(identity['host_pid'])
    raw=(path/'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
    assert int(fields[19])==identity['start_ticks'],'Serving process identity changed'
    status=dict(line.split(':',1) for line in (path/'status').read_text().splitlines())
    vm=dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    return {'host_pid':identity['host_pid'],'start_ticks':identity['start_ticks'],
        'VmSwap_kib':int(status.get('VmSwap','0 kB').split()[0]),
        'VmRSS_kib':int(status.get('VmRSS','0 kB').split()[0]),
        'major_faults':int(fields[9]),'minor_faults':int(fields[7]),
        'cpu_s':(int(fields[11])+int(fields[12]))/os.sysconf('SC_CLK_TCK'),
        'host_swap_in_pages':int(vm['pswpin']),'host_swap_out_pages':int(vm['pswpout']),
        'page_size':os.sysconf('SC_PAGE_SIZE')}


def resolve(container,engine_trace):
    pid=None
    for line in (engine_trace.read_text().splitlines() if engine_trace.exists() else []):
        try:event=json.loads(line)
        except json.JSONDecodeError:continue
        if event.get('event')=='instrumentation_ready':pid=event['pid'];break
    # Release-only fallback: match the exact uninstrumented bundle launcher.
    untraced=pid is None
    table=subprocess.check_output(['docker','top',container,'-eo','pid,ppid,comm'],text=True)
    for line in table.splitlines()[1:]:
        host=int(line.split()[0]);path=Path('/proc')/str(host)
        status=dict(s.split(':',1) for s in (path/'status').read_text().splitlines())
        ns_pid=int(status['NSpid'].split()[-1])
        if untraced:
            args=(path/'cmdline').read_bytes().split(b'\0')
            if b'/ieti-lowload/launch.py' not in args or b'serve' not in args:continue
            pid=ns_pid
        elif ns_pid!=pid:continue
        raw=(path/'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
        identity={'host_pid':host,'container_pid':pid,'start_ticks':int(fields[19])}
        sample(identity)
        return identity
    raise RuntimeError('Could not resolve private inference process identity')
