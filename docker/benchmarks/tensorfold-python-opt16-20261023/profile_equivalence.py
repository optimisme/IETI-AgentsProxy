#!/usr/bin/env python3
"""Check public/private release commands without printing resolved Compose configuration."""
import hashlib,json,os,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent
DOCKER=ROOT.parent.parent

def main():
    names=['qwen38-flash-next-python-opt16-tuned-128gb.yml','qwen38-flash-next-python-opt16-release-test-128gb.yml'];configs=[];hashes={}
    for name in names:
        path=DOCKER/'models'/name;hashes[name]=hashlib.sha256(path.read_bytes()).hexdigest()
        data=json.loads(subprocess.check_output(['docker','compose','-f',str(path),'config','--format','json'],env={**os.environ,'IETI_RUN':'profile-equivalence'}))
        configs.append(data['services']['qwen-tensorfold'])
    ignored={'IETI_RUN','IETI_CANDIDATE'}
    fields={'command':configs[0]['command']==configs[1]['command'],'image':configs[0]['image']==configs[1]['image'],'serving_environment':{k:v for k,v in configs[0]['environment'].items() if k not in ignored}=={k:v for k,v in configs[1]['environment'].items() if k not in ignored},'runtime_mounts':configs[0]['volumes']==configs[1]['volumes'],'GPU_requests':configs[0].get('deploy')==configs[1].get('deploy')}
    result={'passed':all(fields.values()),'checks':fields,'profile_sha256':hashes,'canonical_command_sha256':hashlib.sha256(json.dumps(configs[0]['command'],sort_keys=True).encode()).hexdigest(),'expected_differences':['container/project/labels','private loopback8009 versus public8000','restart policy','test-only run labels']}
    print(json.dumps(result,indent=2));return 0 if result['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
