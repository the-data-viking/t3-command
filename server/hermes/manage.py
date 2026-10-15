"""JSON-only bridge to Hermes's native management functions. No model calls.

Executed inside the installed Hermes runtime, using the launcher's bootstrap.
Every operation runs in its own process: profile/config overrides cannot leak.
"""
import contextlib
import datetime
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid


def atomic_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, staging = tempfile.mkstemp(prefix='.t3-command-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(text)
        os.replace(staging, path)
    finally:
        if os.path.exists(staging):
            os.unlink(staging)


def safe_file(path):
    # Never write through a profile's symlink into a different bot's memory.
    if path.is_symlink():
        raise ValueError('This file is a symlink; manage it in Hermes directly.')
    return path.read_text(encoding='utf-8') if path.is_file() else ''


def summary(info):
    return dict(name=info.name, title=info.bot_title or info.display_name or info.name,
                description=info.description, model=info.model, provider=info.provider,
                skillCount=info.skill_count, isDefault=info.is_default)


def session_data(home, workspace, create=True):
    from hermes_state import SessionDB
    db = SessionDB(home / 'state.db')
    try:
        row = db.get_session_by_title('Bot Chat')
        if row and row.get('archived'):
            row = None
        if not row and not create:
            return None
        if not row:
            sid = 't3c-bot-' + uuid.uuid4().hex
            db.create_session(sid, 'acp', cwd=workspace, model_config={'cwd': workspace})
            db.set_session_pinned(sid, True)
            db.set_session_title(sid, 'Bot Chat')
        else:
            sid = row['id']
        messages = []
        for msg in db.get_messages(sid, limit=200, latest=True):
            if msg.get('role') not in ('user', 'assistant') or not isinstance(msg.get('content'), str) or not msg['content'].strip():
                continue
            stamp = msg.get('timestamp')
            if isinstance(stamp, (int, float)):
                stamp = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).isoformat()
            messages.append(dict(id='hermes-' + str(msg['id']), role=msg['role'], text=msg['content'],
                                 createdAt=stamp or datetime.datetime.now(datetime.timezone.utc).isoformat()))
        return dict(sessionId=sid, source=row.get('source') if row else 'acp', messages=messages)
    finally:
        db.close()


def mark_bot(home, title=None):
    from utils import atomic_yaml_write
    import hermes_yaml as yaml
    path = home / 'profile.yaml'
    meta = yaml.safe_load(path.read_text(encoding='utf-8')) if path.is_file() else {}
    if not isinstance(meta, dict):
        raise ValueError('Invalid Hermes profile metadata')
    meta.setdefault('ui_meta', {}).setdefault('hermes-bots', {})
    if title is not None:
        meta['ui_meta']['hermes-bots']['title'] = title
    atomic_yaml_write(home / 'profile.yaml', meta, sort_keys=False)


def main(req):
    from hermes_cli import profiles
    action = req['action']
    body = req.get('body') or {}
    if action == 'profiles.list':
        return [summary(p) for p in profiles.list_profiles()]
    name = req.get('profile', 'default')
    if not isinstance(name, str) or name != profiles.normalize_profile_name(name):
        raise ValueError('Invalid profile name')
    if name != 'default':
        profiles.validate_profile_name(name)
    if action == 'profiles.create':
        clone = body.get('cloneFrom') or None
        home = profiles.create_profile(name, clone_from=clone, no_alias=True,
                                       description=body.get('description', ''))
        mark_bot(home, body.get('title') or name)
        return dict(name=name)
    found = next((p for p in profiles.list_profiles() if p.name == name), None)
    if found is None:
        raise ValueError('Hermes profile does not exist')
    home = found.path
    if action == 'profiles.path':
        return dict(home=str(home.resolve()))
    if action == 'profiles.delete':
        if name == 'default':
            raise ValueError('The default Hermes profile cannot be deleted')
        try:
            profiles.delete_profile(name, yes=True)
        except profiles.ProfileIdentitySettlementPending as exc:
            return dict(deleted=True, warning=str(exc))
        return dict(deleted=True)
    # Native context manager also scopes access to the profile's credential store.
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(name):
        from hermes_cli.config import load_config, save_config
        cfg = load_config()
        if action in ('profiles.get', 'profiles.identity'):
            result = summary(found)
            result.update(soul=safe_file(home / 'SOUL.md'), memory=safe_file(home / 'memories' / 'MEMORY.md'),
                          userMemory=safe_file(home / 'memories' / 'USER.md'),
                          memoryProvider=(cfg.get('memory') or {}).get('provider', 'local') or 'local')
            if action == 'profiles.identity':
                return result
        if action in ('profiles.get', 'profiles.capabilities'):
            from toolsets import TOOLSETS
            from hermes_cli.skills_config import get_disabled_skills, _list_all_skills
            disabled = get_disabled_skills(cfg, 'acp')
            capabilities = dict(skills=[dict(name=s['name'], enabled=s['name'] not in disabled) for s in _list_all_skills()],
                        toolsets=(cfg.get('platform_toolsets') or {}).get('acp', ['hermes-acp']),
                        availableToolsets=[dict(name=n, description=t.get('description', '')) for n, t in TOOLSETS.items()],
                        mcpServers=[dict(name=n, enabled=c.get('enabled', True))
                                    for n, c in (cfg.get('mcp_servers') or {}).items() if isinstance(c, dict)])
            if action == 'profiles.get':
                result.update(capabilities)
                return result
            return capabilities
        if action == 'profiles.update':
            # Only explicit fields change; credentials and unrelated settings never leave Hermes.
            if ('model' in body and body['model'] != found.model) or ('provider' in body and body['provider'] != found.provider):
                from hermes_cli.web_routers.profiles import _write_profile_model
                _write_profile_model(home, body.get('provider') or found.provider or '',
                                     body.get('model') or found.model or '')
                cfg = load_config()
                from hermes_state import SessionDB
                db = SessionDB(home / 'state.db')
                try:
                    chat = db.get_session_by_title('Bot Chat')
                    if chat:
                        meta = chat.get('model_config') or {}
                        if isinstance(meta, str):
                            meta = json.loads(meta)
                        meta['provider'] = body.get('provider') or found.provider
                        meta.pop('base_url', None)
                        db.update_session_meta(chat['id'], json.dumps(meta), body.get('model') or found.model)
                finally:
                    db.close()
            if 'toolsets' in body:
                from toolsets import TOOLSETS
                if not isinstance(body['toolsets'], list) or any(t not in TOOLSETS for t in body['toolsets']):
                    raise ValueError('Unknown Hermes toolset')
                cfg.setdefault('platform_toolsets', {})['acp'] = body['toolsets']
            if 'mcpServers' in body:
                for server in body['mcpServers']:
                    if server['name'] not in (cfg.get('mcp_servers') or {}):
                        raise ValueError('Unknown MCP server')
                    cfg['mcp_servers'][server['name']]['enabled'] = bool(server['enabled'])
            if 'toolsets' in body or 'mcpServers' in body:
                save_config(cfg)
            if 'skills' in body:
                from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills, _list_all_skills
                from agent.skill_utils import ESSENTIAL_SKILLS
                installed = {s['name'] for s in _list_all_skills()}
                if any(s['name'] not in installed for s in body['skills']):
                    raise ValueError('Unknown skill')
                disabled = get_disabled_skills(cfg)
                platform_disabled = set((cfg.get('skills') or {}).get('platform_disabled', {}).get('acp', []))
                for skill in body['skills']:
                    if skill['enabled']:
                        disabled.discard(skill['name'])
                        platform_disabled.discard(skill['name'])
                    elif skill['name'] not in ESSENTIAL_SKILLS:
                        disabled.add(skill['name'])
                cfg.setdefault('skills', {}).setdefault('platform_disabled', {})['acp'] = sorted(platform_disabled)
                save_disabled_skills(cfg, disabled)
            for key, relative in [('soul', 'SOUL.md'), ('memory', 'memories/MEMORY.md'), ('userMemory', 'memories/USER.md')]:
                if key in body:
                    path = home / relative
                    safe_file(path)
                    if path.parent.is_symlink():
                        raise ValueError('Memory directory is a symlink; manage it in Hermes directly.')
                    atomic_text(path, body[key])
            if 'description' in body:
                profiles.write_profile_meta(home, description=body['description'], description_auto=False)
            if 'title' in body:
                mark_bot(home, body['title'])
            return dict(saved=True)
        if action in ('session.open', 'session.read'):
            if action == 'session.open':
                mark_bot(home)
            return session_data(home, req['workspace'], create=action == 'session.open')
        from cron import jobs
        job_id = body.get('id', '')
        if action not in ('jobs.list', 'jobs.create') and (not isinstance(job_id, str) or not job_id.isalnum()):
            raise ValueError('Invalid job id')
        if action == 'jobs.list':
            from hermes_cli.cron import _builtin_gateway_liveness
            return dict(jobs=jobs.list_jobs(include_disabled=True), scheduler=dict(
                running=_builtin_gateway_liveness(), heartbeatAge=jobs.get_ticker_heartbeat_age(),
                error=jobs.get_ticker_last_error()))
        fields = {'name', 'prompt', 'schedule', 'skills', 'model', 'provider', 'workdir', 'deliver',
                  'script', 'no_agent', 'monitor_url', 'monitor_script', 'reasoning_effort', 'context_from'}
        if action in ('jobs.create', 'jobs.update'):
            updates = {k: v for k, v in body.items() if k in fields}
            from hermes_cli.web_server_cron import _normalize_dashboard_cron_script
            for key in ('script', 'monitor_script'):
                if key in updates:
                    updates[key] = _normalize_dashboard_cron_script(updates[key], home)
            if action == 'jobs.create':
                updates['paused'] = bool(body.get('paused', False))
                if updates.get('name') and not updates['name'].startswith('[bot:'):
                    updates['name'] = '[bot:' + name + '] ' + updates['name']
                return jobs.create_job(**updates)
            result = jobs.update_job(job_id, updates)
        elif action == 'jobs.runs':
            from cron.executions import list_executions
            if jobs.get_job(job_id) is None:
                raise ValueError('Hermes job does not exist')
            return list_executions(job_id=job_id, limit=30)
        elif action == 'jobs.output':
            if jobs.get_job(job_id) is None:
                raise ValueError('Hermes job does not exist')
            # Fixed directory + validated native id, no client-supplied filesystem path.
            output_dir = jobs._job_output_dir(job_id)
            paths = sorted(output_dir.glob('*.md'), key=lambda p: p.stat().st_mtime, reverse=True)[:10]
            return [dict(name=p.name, text=p.read_text(encoding='utf-8')[-32000:]) for p in paths if not p.is_symlink()]
        else:
            fn = {'jobs.pause': jobs.pause_job, 'jobs.resume': jobs.resume_job,
                  'jobs.trigger': jobs.trigger_job, 'jobs.delete': jobs.remove_job}.get(action)
            if fn is None:
                raise ValueError('Unsupported Hermes management action')
            if not isinstance(job_id, str) or not job_id.isalnum():
                raise ValueError('Invalid job id')
            if action == 'jobs.trigger':
                from hermes_cli.cron import _builtin_gateway_liveness
                if _builtin_gateway_liveness() is not True:
                    raise ValueError('No scheduler is serving this bot. Start its Hermes gateway or Serve backend first.')
            result = fn(job_id)
        if not result:
            raise ValueError('Hermes job does not exist')
        return result


if __name__ == '__main__':
    try:
        req = json.load(sys.stdin)
        # Hermes helpers may print informational messages: keep the wire JSON-only.
        with contextlib.redirect_stdout(sys.stderr):
            result = main(req)
        print(json.dumps(dict(result=result), default=str))
    except Exception as exc:
        message = getattr(exc, 'detail', None) or str(exc)
        print(json.dumps(dict(error=message or type(exc).__name__)))
        sys.exit(1)
