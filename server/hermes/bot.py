"""Canonical Bot Chat adapter using the installed Hermes ACP transport.

Stock ACP restores only source=acp rows. This SessionManager extension admits only
an exactly titled native Bot Chat from another interface, preserving its stored
source/history. Hermes's native session lease fences all clients, including CLI
and Desktop. The installed adapter still handles tools, approvals and streaming.
"""
import asyncio
import json
import logging
import sys
import uuid

import acp
from acp_adapter.entry import _load_env, _setup_logging
from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionManager
from hermes_constants import get_hermes_home


class BotSessionManager(SessionManager):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.leases = {}

    def _restore(self, session_id):
        db = self._get_db()
        row = db.get_session(session_id) if db else None
        if not row or row.get('title') != 'Bot Chat':
            raise ValueError('This adapter resumes only the canonical Bot Chat')
        from hermes_cli.active_sessions import try_acquire_active_session
        from hermes_cli.config import load_config
        lease, refusal = try_acquire_active_session(
            session_id=session_id, surface='T3 Command', config=load_config(),
            registry_home=get_hermes_home(), track_liveness=True,
            metadata={'live_session_id': 't3-command-' + uuid.uuid4().hex})
        if lease is None:
            raise ValueError(str(refusal))
        self.leases[session_id] = lease
        try:
            if row.get('source') == 'acp':
                state = super()._restore(session_id)
                if state is None:
                    raise ValueError('Hermes could not restore this Bot Chat')
                return state
            # Equivalent to Hermes's normal resume path, without changing provenance.
            if row.get('ended_at') is not None:
                db.reopen_session(session_id)
            meta = row.get('model_config') or {}
            if isinstance(meta, str):
                meta = json.loads(meta)
            cwd = meta.get('cwd') or row.get('cwd') or '.'
            history = db.get_messages_as_conversation(session_id, repair_alternation=True)
            model = row.get('model') or None
            agent = self._make_agent(
                session_id=session_id, cwd=cwd, model=model, api_mode=meta.get('api_mode') or None,
                requested_provider=meta.get('provider') or row.get('billing_provider'),
                base_url=meta.get('base_url') or row.get('billing_base_url'))
            return self._install_state(session_id, agent, cwd, model or getattr(agent, 'model', '') or '', history, persist=False)
        except Exception:
            self.leases.pop(session_id).release()
            raise

    def end_all_sessions(self):
        try:
            super().end_all_sessions()
        finally:
            for lease in self.leases.values():
                lease.release()
            self.leases.clear()


def main():
    _setup_logging()
    _load_env()
    from agent.ssl_verify import install_truststore
    install_truststore()
    logger = logging.getLogger(__name__)
    if sys.platform == 'win32':
        from acp_adapter.entry import _warm_memory_provider_import
        _warm_memory_provider_import(logger)
    # Match the installed ACP entrypoint's MCP discovery behavior.
    try:
        from hermes_cli.mcp_startup import start_background_mcp_discovery
        start_background_mcp_discovery(logger=logger, thread_name='t3-command-bot-mcp')
    except Exception:
        logger.debug('MCP discovery failed', exc_info=True)
    agent = HermesACPAgent(session_manager=BotSessionManager())
    try:
        asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))
    finally:
        agent.session_manager.end_all_sessions()


if __name__ == '__main__':
    main()
