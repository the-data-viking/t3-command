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


class CommandACPAgent(HermesACPAgent):
    """Keep the owning ACP prompt alive through delegated work and its follow-up.

    Command releases the process/lease when session/prompt returns. Native ACP
    returns after the parent's first reply, while daemon delegation workers and
    their completion queue still belong to that same process.
    """

    async def _prompt_once(self, prompt, session_id, **kwargs):
        return await super().prompt(prompt, session_id, **kwargs)

    async def cancel(self, session_id, **kwargs):
        await super().cancel(session_id, **kwargs)
        # The stable ACP key also covers children started before head compression.
        from tools.async_delegation import interrupt_for_session
        await asyncio.to_thread(interrupt_for_session, session_key=session_id, reason='acp_cancel')

    async def prompt(self, prompt, session_id, **kwargs):
        from acp.schema import PromptResponse
        from tools.async_delegation import (
            claim_event_delivery, complete_event_delivery, has_live_for_session, release_event_delivery,
        )
        from tools.process_registry import process_registry

        result = await self._prompt_once(prompt, session_id, **kwargs)
        state = await asyncio.to_thread(self.session_manager.get_session, session_id)
        if state is None:
            return result

        def cancelled():
            return state.cancel_event is not None and state.cancel_event.is_set()

        while result.stop_reason == 'end_turn' and not cancelled():
            # Read liveness BEFORE draining: finalizing stays live until the native
            # worker has durably saved and enqueued its result. Reversing this order
            # can miss that last result and let Command kill its owner.
            live = await asyncio.to_thread(has_live_for_session, session_key=session_id)
            notifications = await asyncio.to_thread(
                process_registry.drain_notifications, session_key=session_id,
                owns_event=lambda event: event.get('type') == 'async_delegation'
                and event.get('session_key') == session_id,
            )
            for event, text in notifications:
                if cancelled():
                    return PromptResponse(stop_reason='cancelled')
                claim = await asyncio.to_thread(claim_event_delivery, event, 't3-command-acp')
                if claim is None:
                    continue
                try:
                    # Use Hermes's normal prompt path so streaming, approvals,
                    # persistence and further delegations behave like the first turn.
                    result = await self._prompt_once([acp.text_block(text)], session_id, **kwargs)
                    if result.stop_reason != 'end_turn' or cancelled():
                        await asyncio.to_thread(release_event_delivery, event, claim)
                        return PromptResponse(stop_reason='cancelled') if cancelled() else result
                    await asyncio.to_thread(complete_event_delivery, event, claim)
                except BaseException:
                    await asyncio.to_thread(release_event_delivery, event, claim)
                    raise
            if not live and not notifications:
                break
            await asyncio.sleep(0.2)
        return PromptResponse(stop_reason='cancelled') if cancelled() else result


class BotSessionManager(SessionManager):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.leases = {}

    def _restore(self, session_id):
        db = self._get_db()
        row = db.get_session(session_id) if db else None
        if not row or row.get('title') != 'Bot Chat':
            raise acp.RequestError(-32002, 'Bot Chat was not found. Reopen Talk to bot in T3 Command.')
        from hermes_cli.active_sessions import try_acquire_active_session
        from hermes_cli.config import load_config
        lease, refusal = try_acquire_active_session(
            session_id=session_id, surface='T3 Command', config=load_config(),
            registry_home=get_hermes_home(), track_liveness=True,
            metadata={'live_session_id': 't3-command-' + uuid.uuid4().hex})
        if lease is None:
            # Plain exceptions become "Internal error" in ACP. Translate only known
            # refusal reasons; raw diagnostics can contain paths or credentials.
            messages = {
                'SESSION_NOT_OWNED': 'Bot Chat is open in another Hermes window or terminal. Close that chat there, then retry your order in T3 Command. An idle open chat can still hold the session.',
                'MAX_CONCURRENT_SESSIONS': 'Hermes has reached its active session limit. Close another Hermes chat, then retry your order.',
                'SESSION_COORDINATION_UNAVAILABLE': 'Hermes could not verify Bot Chat ownership. Check the active-session registry in Hermes before retrying.',
            }
            message = messages.get(getattr(refusal, 'reason', ''),
                                   'Hermes could not acquire Bot Chat. Check session availability in Hermes, then retry.')
            raise acp.RequestError(-32000, message)
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
    manager = SessionManager() if '--task-session' in sys.argv else BotSessionManager()
    agent = CommandACPAgent(session_manager=manager)
    try:
        asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))
    finally:
        agent.session_manager.end_all_sessions()


if __name__ == '__main__':
    main()
