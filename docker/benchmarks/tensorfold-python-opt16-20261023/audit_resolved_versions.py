#!/usr/bin/env python3
"""Supplement old metadata only when identical pinned install evidence proves it."""
import hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parent
REF='candidate-capacity-3'
norm=lambda n:re.sub(r'[-_.]+','-',n).lower()

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())
def installed(p):
    lines=[s.strip()[len('Successfully installed '):] for s in p.read_text().splitlines() if s.strip().startswith('Successfully installed ')]
    if len(lines)!=1:raise ValueError(f'Expected one complete pip install record: {p}')
    values={}
    for item in lines[0].split():
        m=re.fullmatch(r'(.+)-([0-9].*)',item)
        if not m:raise ValueError(f'Unparsed installer item: {item}')
        values[norm(m[1])]=m[2]
    return values

def main():
    folder=ROOT/'results'/REF;reference=load(folder/'resolved-inventory.json');legacy=load(folder/'runtime-inventory.json');versions=installed(folder/'startup.log');done=[];unresolved=[]
    raw={norm(n):v for n,v in legacy['packages'].items()}
    for p in (ROOT/'results').glob('*/runtime-inventory.json'):
        target=p.parent/'resolved-inventory.json'
        if target.exists():continue
        data=load(p)
        try:local=installed(p.parent/'startup.log')
        except (ValueError,FileNotFoundError) as e:unresolved.append({'run':p.parent.name,'error':str(e)});continue
        evidence={'same_pinned_image':data['image']==reference['image'],'same_legacy_distribution_inventory':{norm(n):v for n,v in data['packages'].items()}==raw,'same_complete_installer_versions':local==versions}
        if not all(evidence.values()):unresolved.append({'run':p.parent.name,'evidence':evidence});continue
        result={'effective_packages':reference['effective_packages'],'image':data['image'],'provenance':'Historical audit: identical pinned image, legacy inventory and complete pip install versions; all profiles use the same pinned-image venv bootstrap. Original inventory preserved.','evidence':evidence,'installer_packages':local,'reference_run':REF,'reference_inventory_sha256':digest(folder/'resolved-inventory.json'),'legacy_inventory_sha256':digest(p),'startup_log_sha256':digest(p.parent/'startup.log')}
        with target.open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
        done.append(p.parent.name)
    result={'reference_run':REF,'supplemented':done,'unresolved':unresolved,'masked_legacy_versions':{n:{'legacy':raw.get(n),'active':v} for n,v in reference['effective_packages'].items() if raw.get(n)!=v}}
    (ROOT/'resolved-version-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

if __name__=='__main__':main()
