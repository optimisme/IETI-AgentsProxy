#!/usr/bin/env python3
"""Frozen typical-load matrix plus separate actual-tool-result continuations."""
import argparse,copy,hashlib,json,re,time
from pathlib import Path
import transport as wire
ROOT=Path(__file__).resolve().parent


def save(path,value):
    path.write_text(json.dumps(value,indent=2)+'\n')


def tool_value(result):
    parts=result['tool_calls']
    names=[v.get('function',{}).get('name','') for v in parts]
    text=''.join(v.get('function',{}).get('arguments','') for v in parts)
    try:args=json.loads(text)
    except (TypeError,ValueError):args={}
    ident=next((v['id'] for v in parts if v.get('id')),'call_record_number')
    return ('record_number' in names and isinstance(args,dict)),args,ident


def execute(url,case,model,out):
    payloads=copy.deepcopy(case['payloads'])
    for p in payloads:p['model']=model
    results=wire.cohort(url,case['name'],payloads,out)
    path=out/(case['name']+'.json');report=json.loads(path.read_text());s=report['summary']
    s.update(completion_p50_s=wire.base.percentile([r['elapsed_s'] for r in results],.5),
        completion_p95_s=wire.base.percentile([r['elapsed_s'] for r in results],.95),
        content_ttft_p50_s=wire.base.percentile([r['content_ttft_s'] for r in results],.5),
        content_ttft_p95_s=wire.base.percentile([r['content_ttft_s'] for r in results],.95),
        cached_users=sum(r['usage'].get('prompt_tokens_details',{}).get('cached_tokens',0)>0 for r in results),
        post_first_token_per_token_p50_s=wire.base.percentile([r['mean_time_per_output_token_after_first_s'] for r in results],.5))
    report['case_metadata']={k:v for k,v in case.items() if k!='payloads'}
    report['matrix_source_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    save(path,report)
    if case.get('turn')==0:assert s['cached_tokens']==0,('Contaminated cold prefix',case['name'],s)
    return results,payloads


def main():
    p=argparse.ArgumentParser();p.add_argument('--base',default='http://127.0.0.1:8009');p.add_argument('--out',required=True);p.add_argument('--order',default='1,2,4,8');a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True);assert not (out/'started.json').exists()
    order=list(map(int,a.order.split(',')));assert sorted(order)==[1,2,4,8]
    health=wire.base.health(a.base);assert health['ok'] and health['requests_running']==0 and health['streams']['max']==16 and health['context_length']==75000,health
    model=wire.base.api(a.base,'/v1/models')['data'][0]['id'];fixture=ROOT/'fixtures.json';data=json.loads(fixture.read_text())
    save(out/'started.json',{'epoch':time.time(),'order':order,'health':health,'fixture_sha256':hashlib.sha256(fixture.read_bytes()).hexdigest()})
    # Prior regression first: same original short16 warmup and exact mixed16 bytes.
    cases=[c for c in data['cases'] if c['kind'].startswith('diagnostic')]
    cases += [c for n in order for c in data['cases'] if c['n']==n and not c['kind'].startswith('diagnostic')]
    quality=[]
    for case in cases:
        results,payloads=execute(a.base,case,model,out)
        if case['kind']=='reasoning':
            checks=[]
            for r,expected in zip(results,case['expected']):
                values=re.findall(r'\b\d+\b',r['content'])
                checks.append({'expected':expected,'passed':r['error'] is None and len(values)==1 and int(values[0])==expected,'reasoning_bytes':len(r['reasoning'].encode()),'content':r['content']})
            quality.append({'case':case['name'],'checks':checks,'passed':sum(c['passed'] for c in checks),'requests':len(checks)})
        elif case['kind']=='tool':
            checks=[];follow=[]
            for r,body,expected in zip(results,payloads,case['expected']):
                ok,args,ident=tool_value(r)
                checks.append({'expected':expected,'passed':r['error'] is None and ok and args.get('value')==expected,'arguments':args,'reasoning_bytes':len(r['reasoning'].encode())})
                # Actual generated tool arguments/ID: these follow-ups are functional
                # live conversation evidence, excluded from fixed-payload percentages.
                call={'id':ident,'type':'function','function':{'name':'record_number','arguments':json.dumps(args)}}
                messages=copy.deepcopy(body['messages'])+[{'role':'assistant','content':None,'tool_calls':[call]},
                    {'role':'tool','tool_call_id':ident,'content':json.dumps({'recorded':args.get('value')})},
                    {'role':'user','content':'Return only the recorded integer.'}]
                req=wire.base.body(model,messages,1200);req.pop('chat_template_kwargs');req['ignore_eos']=False
                req.update(tools=body['tools'],tool_choice='none');follow.append(req)
            quality.append({'case':case['name'],'checks':checks,'passed':sum(c['passed'] for c in checks),'requests':len(checks)})
            follow_case={'name':f'tool-return-n{case["n"]}','payloads':follow,'kind':'tool_live_return','n':case['n'],'fixed_output':False,'expected':case['expected']}
            answers,_=execute(a.base,follow_case,model,out);checks=[]
            for r,expected in zip(answers,case['expected']):
                values=re.findall(r'\b\d+\b',r['content'])
                checks.append({'expected':expected,'passed':r['error'] is None and len(values)==1 and int(values[0])==expected,'content':r['content']})
            quality.append({'case':follow_case['name'],'checks':checks,'passed':sum(c['passed'] for c in checks),'requests':len(checks)})
        save(out/'quality.json',{'cases':quality,'note':'Model semantic misses are preserved separately; transport failures abort the run. Actual tool-result follow-ups are not fixed-input timing pairs.'})
    (out/'completed').write_text('All fixed matrix cohorts and live tool continuations completed.\n')


if __name__=='__main__':main()
