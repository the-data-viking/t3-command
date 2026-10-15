"""Read-only T3 maintenance response watcher; no model calls or mutations."""
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HOME = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes')))
ROOT = HOME / 'maintenance'
RPC_JS = r'''
const spec=JSON.parse(process.argv[1]);
function rpc(env,tag,payload){return new Promise((resolve,reject)=>{
 let done=false;const ws=new WebSocket(spec.route.replace(/^http/,'ws')+'/env/'+encodeURIComponent(env)+'/ws');
 const finish=(v,err)=>{if(done)return;done=true;clearTimeout(timer);ws.close();err?reject(err):resolve(v)};
 const timer=setTimeout(()=>finish(null,Error('RPC timeout')),15000);
 ws.onopen=()=>ws.send(JSON.stringify({_tag:'Request',id:'1',tag,payload,headers:[]}));
 ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m._tag==='Chunk'){ws.send(JSON.stringify({_tag:'Ack',requestId:m.requestId}));finish(m.values)}else if(m._tag==='Exit'){m.exit._tag==='Success'?finish(m.exit.value):finish(null,Error('RPC failure '+JSON.stringify(m.exit.cause)))}}catch(e){finish(null,e)}};
 ws.onerror=()=>finish(null,Error('WebSocket error'));ws.onclose=()=>{if(!done)finish(null,Error('Connection closed'))};
})}
(async()=>{const out=await rpc(spec.envId,'orchestration.subscribeThread',{threadId:spec.threadId});const t=out.find(v=>v.kind==='snapshot')?.snapshot?.thread;if(!t)throw Error('No thread snapshot');const approvals=new Map();for(const a of t.activities){const id=a.payload?.requestId;if(['approval.requested','user-input.requested'].includes(a.kind)&&id)approvals.set(id,a);if(['approval.resolved','user-input.resolved'].includes(a.kind)&&id)approvals.delete(id);}console.log(JSON.stringify({envId:spec.envId,label:spec.label,threadId:t.id,modelSelection:t.modelSelection,latestTurn:t.latestTurn,session:t.session,messages:t.messages.filter(m=>m.role==='assistant').slice(-3).map(m=>({id:m.id,text:m.text,streaming:m.streaming})),pending:[...approvals.values()],reviewErrors:t.activities.filter(a=>a.kind==='provider.approval.respond.failed').slice(-3),proposedPlans:t.proposedPlans}));})().catch(e=>{console.error(e.message);process.exitCode=1});
'''


def scrub(text):
    text = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[REDACTED]', text)
    text = re.sub(r'\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-|dp\.(?:st|ct)\.)[A-Za-z0-9_.-]+', '[REDACTED]', text)
    return re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED]', text)


def atomic_json(path, value):
    tmp = path.with_name(path.name + '.new')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(path)


def read_worker(worker, route):
    spec = {k: worker[k] for k in ['envId', 'threadId', 'label']}
    spec['route'] = route.rstrip('/')
    try:
        node = shutil.which('node') or '/opt/homebrew/bin/node'
        p = subprocess.run([node, '-e', RPC_JS, json.dumps(spec)], capture_output=True, text=True, timeout=25)
        if p.returncode:
            raise RuntimeError(p.stderr.strip()[:600] or 'node RPC failed')
        data = json.loads(scrub(p.stdout))
        for message in data.get('messages', []):
            if len(message.get('text', '')) > 18000:
                message['text'] = message['text'][:18000] + '\n[TRUNCATED: read exact thread before deciding]'
        return data
    except Exception as exc:
        return {k: spec[k] for k in ['envId', 'threadId', 'label']} | {'error': scrub(str(exc))}


def review_material(result):
    """Stable, actionable evidence only; running progress is not a new review."""
    turn = result.get('latestTurn') or {}
    errors = [e for e in result.get('reviewErrors') or []
              if not e.get('turnId') or e.get('turnId') == turn.get('turnId')]
    pending = result.get('pending') or []
    plans = result.get('proposedPlans') or []
    if result.get('error'):
        return {'threadId': result['threadId'], 'error': result['error']}
    terminal = turn.get('state') in ('completed', 'interrupted', 'error')
    if not terminal and not pending and not errors and not plans:
        return None
    material = {'threadId': result['threadId'], 'turnId': turn.get('turnId'),
                'state': turn.get('state'), 'modelSelection': result.get('modelSelection'),
                'pending': pending, 'reviewErrors': errors, 'proposedPlans': plans}
    if terminal:
        material['messages'] = [m for m in result.get('messages') or []
                                if m.get('text') and not m.get('streaming')]
    return material


def changed_reviews(results, fingerprints):
    changes = []
    for result in results:
        material = review_material(result)
        if material is None:
            continue
        digest = hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()
        if fingerprints.get(result['threadId']) != digest:
            # Full evidence stays in watcher-snapshots.json; the reviewer must read
            # the exact thread before authorizing an action. Keep the wake-up small.
            changes.append({'envId': result.get('envId'), 'label': result.get('label'),
                            'threadId': result['threadId'], 'turnId': material.get('turnId'),
                            'state': material.get('state'), 'error': material.get('error'),
                            'pendingRequests': len(material.get('pending') or []),
                            'reviewErrors': len(material.get('reviewErrors') or []),
                            'proposedPlans': len(material.get('proposedPlans') or []),
                            'report': '\n'.join(m['text'] for m in material.get('messages') or [])[-4000:]})
        fingerprints[result['threadId']] = digest
    return changes


def main():
    source = ROOT / 'fleet-state.json'
    if not source.exists():
        return
    state = json.loads(source.read_text())
    workers = {w['threadId']: w for w in state.get('workers', []) if w.get('threadId') and w.get('reviewStatus') != 'closed'}
    # Include explicit follow-up queue entries without duplicating existing threads.
    queue = ROOT / 'supervision-queue.json'
    if queue.exists():
        queued = json.loads(queue.read_text())
        for decision in queued.get('decisions', []):
            # The finding stays open in its follow-up; don't re-alert on the reviewed source report.
            if decision.get('nextThreadId'):
                workers.pop(decision.get('sourceThreadId'), None)
        for w in queued.get('workers', []):
            if w.get('threadId') and w.get('reviewStatus') != 'closed':
                workers[w['threadId']] = w
    if not workers:
        return
    route = state.get('route')
    if not route or not route.startswith('https://'):
        raise RuntimeError('No authorized HTTPS route in fleet state')
    cache_file = ROOT / 'watcher-state.json'
    cache = json.loads(cache_file.read_text()) if cache_file.exists() else {'fingerprints': {}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda w: read_worker(w, route), workers.values()))
    changes = changed_reviews(results, cache['fingerprints'])
    ROOT.mkdir(parents=True, exist_ok=True)
    atomic_json(ROOT / 'watcher-snapshots.json', {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'workers': results})
    # Preview mode exercises real reads without consuming notifications.
    if '--preview' not in sys.argv:
        atomic_json(cache_file, cache)
    if changes:
        print('Full evidence: ' + str(ROOT / 'watcher-snapshots.json'))
        print('MAINTENANCE RESPONSE REVIEW REQUIRED. Load t3-command. You own these loops: analyze final responses and tool evidence, explicitly authorize/deny/defer proposed maintenance actions, follow up only with Opus 5.5 medium, verify effects, and persist decisions/closure. Do not merely relay this notice. No fallback models. Snapshots are read-only observations, not independent proof of worker claims.')
        print(json.dumps(changes, ensure_ascii=False))


if __name__ == '__main__':
    main()
