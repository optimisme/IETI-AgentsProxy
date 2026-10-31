#!/usr/bin/env python3
"""Record effective distribution versions despite inherited image metadata duplicates."""
import hashlib,json,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
NAME='qwen38_flash_next_python_lowload'

def capture(run):
    assert run.replace('-','').replace('_','').isalnum()
    path=ROOT/'results'/run/'resolved-inventory.json';assert not path.exists(),'Preserve effective inventory'
    def inspect(field):return json.loads(subprocess.check_output(['docker','inspect',NAME,'--format','{{json '+field+'}}']))
    ident=inspect('.Id');env=dict(x.split('=',1) for x in inspect('.Config.Env'));assert env['IETI_RUN']==run
    source='''import collections,importlib.metadata as m,json,re,sys
norm=lambda n:re.sub(r"[-_.]+","-",n).lower()
rows=collections.defaultdict(list)
for d in m.distributions():rows[norm(d.metadata['Name'])].append({'version':d.version,'root':str(d.locate_file(''))})
active={n:m.version(n) for n in rows}
print(json.dumps({'python':sys.version,'effective_packages':active,'duplicate_distributions':{n:v for n,v in rows.items() if len(v)>1}}))'''
    data=json.loads(subprocess.check_output(['docker','exec',NAME,'/opt/tensorfold-venv/bin/python','-c',source]))
    assert inspect('.Id')==ident,'Container changed during effective inventory'
    data.update(epoch=time.time(),container_id=ident,image=inspect('.Image'),provenance='direct importlib.metadata.version by canonical distribution name',capture_source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    with path.open('x') as f:f.write(json.dumps(data,indent=2)+'\n')
    print(json.dumps({'run':run,'effective_packages':len(data['effective_packages']),'duplicate_distribution_names':len(data['duplicate_distributions'])}))

if __name__=='__main__':capture(sys.argv[1])
