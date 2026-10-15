"""Move the two local fleet routines out of Bot Chat using native cron conversations.

Run inside the installed Hermes runtime. Default is a dry run; --apply backs up the
current definitions/scripts, installs the watcher and uses native job update APIs.
No existing agent or worker is stopped, and queued report content is retained.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import tempfile

JOBS = {'Hourly fleet maintenance', 'Maintenance response supervisor'}
BOUNDARY = ('Run this scheduled maintenance review in its isolated cron conversation. '
            'Keep the canonical Bot Chat available for the human. Do not deliver routine '
            'wake-ups or reports to bot-chat:default, message the default bot, or change '
            'routine delivery back to Bot Chat. Save reports locally. Read '
            'HERMES_HOME/maintenance/fleet-state.json, supervision-queue.json, '
            'watcher-snapshots.json and chat-isolation-migration.json for continuity. '
            'Preserve active work and all standing approval/model restrictions. ')
REVIEW = ('Load t3-command. Review returned results and pending requests using exact live '
          'thread evidence before authorizing actions. Explicitly authorize, deny or defer '
          'scoped maintenance actions; follow up only with claudeAgent/claude-opus-5-5, '
          'effort=medium and fastMode=false. Never substitute models. Independently verify '
          'effects and persist decisions, ownership, and closure evidence under '
          'HERMES_HOME/maintenance. Report meaningful outcomes or new blockers; NO_REPLY '
          'if unchanged. Do not merely relay the watcher output.')


def job_updates(job, peer_id):
    prompt = job.get('prompt') or REVIEW
    if not prompt.startswith(BOUNDARY):
        prompt = BOUNDARY + '\n\n' + prompt
    return {'no_agent': False, 'deliver': 'local', 'prompt': prompt,
            'context_from': ['self', peer_id]}


def atomic_text(path, text):
    fd, staging = tempfile.mkstemp(prefix='.chat-isolation-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(text)
        os.replace(staging, path)
    finally:
        if os.path.exists(staging):
            os.unlink(staging)


def main(apply=False):
    from cron import jobs
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles
    home = get_hermes_home().resolve()
    default = next(p.path.resolve() for p in profiles.list_profiles() if p.is_default)
    if home != default:
        raise ValueError('Run this migration in the default Hermes profile.')
    selected = [j for j in jobs.list_jobs(include_disabled=True) if j.get('name') in JOBS]
    if len(selected) != 2 or {j['name'] for j in selected} != JOBS:
        raise ValueError('Expected exactly the hourly fleet and response-supervisor routines.')
    plan = {j['id']: job_updates(j, next(p['id'] for p in selected if p['id'] != j['id'])) for j in selected}
    if not apply:
        print(json.dumps({'apply': False, 'jobs': [{'id':j['id'], 'name':j['name'], 'deliver':'local', 'no_agent':False} for j in selected]}))
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    directory = home / 'maintenance' / ('chat-isolation-backup-' + stamp)
    directory.mkdir(parents=True, mode=0o700)
    atomic_text(directory / 'jobs.json', json.dumps(selected, indent=2))
    scripts = home / 'scripts'
    watcher = scripts / 't3-maintenance-watch.py'
    hourly = scripts / 't3-maintenance-hourly.py'
    source = Path(__file__).with_name('hermes-maintenance-watch.py')
    originals = {p: p.read_text() for p in (watcher, hourly)}
    for path, text in originals.items():
        atomic_text(directory / path.name, text)
    suppressed = []
    try:
        for job in selected:
            jobs.pause_job(job['id'], reason='Moving fleet supervision out of direct Bot Chat')
        atomic_text(watcher, source.read_text())
        hourly_text = originals[hourly].replace('Wake the fleet operator in its Bot Chat', 'Prepare an isolated fleet-maintenance cron review')
        hourly_text = hourly_text.replace('No new separate-model cron agent is required: you are the operator. ', '')
        atomic_text(hourly, hourly_text)
        for job in selected:
            updated = jobs.update_job(job['id'], plan[job['id']])
            if not updated or updated.get('deliver') != 'local' or updated.get('no_agent'):
                raise RuntimeError('Native cron did not accept isolated execution.')
        # Native suppression is locked and only changes never-started queued receipts.
        # Claimed/running deliveries finish naturally; their full payload is retained.
        from cron.bot_chat_delivery import defer
        pending = home / 'cron' / 'bot_chat_pending'
        for path in pending.glob('*.json'):
            record = json.loads(path.read_text())
            if record.get('job', {}).get('id') not in plan or record.get('status') != 'queued':
                continue
            shutil.copy2(path, directory / path.name)
            result = defer(record['id'], record['job'], record['content'], record['profile'], Path(record['home']),
                           suppressed=True, for_failure=bool(record.get('for_failure')), degraded=bool(record.get('degraded')))
            if result.get('status') == 'suppressed':
                suppressed.append(str(path))
        manifest = {'configuredAt':stamp, 'backup':str(directory), 'jobs':list(plan),
                    'suppressedPendingReports':suppressed,
                    'note':'Review any unfinished maintenance work from the retained reports and supervision files; direct Bot Chat is reserved for the human.'}
        atomic_text(home / 'maintenance' / 'chat-isolation-migration.json', json.dumps(manifest, indent=2))
        for job in selected:
            if job.get('enabled'):
                jobs.resume_job(job['id'])
    except Exception:
        for path, text in originals.items():
            atomic_text(path, text)
        for job in selected:
            jobs.update_job(job['id'], {k:job.get(k) for k in ('prompt','no_agent','deliver','context_from')})
            if job.get('enabled'):
                jobs.resume_job(job['id'])
        raise
    print(json.dumps({'configured':True, 'backup':str(directory), 'suppressedPendingReports':len(suppressed),
                      'jobs':[{'id':j['id'],'name':j['name'],'deliver':jobs.get_job(j['id'])['deliver'],
                               'enabled':jobs.get_job(j['id'])['enabled']} for j in selected]}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    main(parser.parse_args().apply)
