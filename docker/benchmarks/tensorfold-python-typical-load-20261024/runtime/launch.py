#!/usr/bin/env python3
"""Common launcher: identical entry point, optional qualified opt16 policies."""
import importlib.metadata,json,os,sys
from pathlib import Path
variant=os.environ['IETI_CANDIDATE']
print('[ieti-lowload] '+json.dumps({'variant':variant,'internal_profiling':False}),flush=True)
if variant=='tuned':
    sys.path.insert(0,'/ieti-opt16')
    from serve import main
    raise SystemExit(main())
assert variant=='original'
sys.argv=['tensorfold',*sys.argv[1:]]
entry=next(e for e in importlib.metadata.entry_points(group='console_scripts') if e.name=='tensorfold')
raise SystemExit(entry.load()())
