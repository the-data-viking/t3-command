"""Adapter lifecycle regressions; --native additionally uses installed Hermes's real ledger/queue."""
import asyncio
import importlib.util
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

NATIVE = '--native' in sys.argv
if NATIVE:
    sys.argv.remove('--native')
else:
    # Unit coverage runs without a local Hermes installation or model credentials.
    class NativeAgent:
        def __init__(self, session_manager=None):
            self.session_manager = session_manager

        async def cancel(self, session_id, **kwargs):
            self.session_manager.get_session(session_id).cancel_event.set()

    def module(name, **values):
        result = types.ModuleType(name)
        result.__dict__.update(values)
        sys.modules[name] = result
        return result

    acp = module('acp', text_block=lambda text: types.SimpleNamespace(text=text))
    module('acp.schema', PromptResponse=lambda **kw: types.SimpleNamespace(**kw))
    module('acp_adapter.entry', _load_env=Mock(), _setup_logging=Mock())
    module('acp_adapter.server', HermesACPAgent=NativeAgent)
    module('acp_adapter.session', SessionManager=object)
    module('hermes_constants', get_hermes_home=Mock())
    module('tools')
    module('tools.async_delegation', has_live_for_session=Mock(), claim_event_delivery=Mock(),
           complete_event_delivery=Mock(), release_event_delivery=Mock(), interrupt_for_session=Mock())
    module('tools.process_registry', process_registry=types.SimpleNamespace(drain_notifications=Mock()))

spec = importlib.util.spec_from_file_location('t3_command_bot', Path(__file__).with_name('bot.py'))
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)
from acp.schema import PromptResponse
from tools import async_delegation as delegation
from tools.process_registry import process_registry


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state = types.SimpleNamespace(cancel_event=threading.Event(), agent=types.SimpleNamespace(session_id='compressed-head'))
        self.agent = bot.CommandACPAgent(session_manager=types.SimpleNamespace(get_session=lambda _: self.state))
        self.event = {'type': 'async_delegation', 'session_key': 'chat', 'delegation_id': 'child'}
        self.calls = []

        async def once(prompt, session_id, **kwargs):
            self.calls.append(prompt[0].text)
            return PromptResponse(stop_reason='end_turn')

        self.agent._prompt_once = once

    async def test_finalizing_child_is_delivered_before_prompt_returns(self):
        # The child publishes AFTER the first drain, before the next liveness read.
        with patch.object(delegation, 'has_live_for_session', side_effect=[True, False, False]), \
             patch.object(process_registry, 'drain_notifications', side_effect=[[], [(self.event, 'research result')], []]), \
             patch.object(delegation, 'claim_event_delivery', return_value='claim'), \
             patch.object(delegation, 'complete_event_delivery') as ack:
            response = await self.agent.prompt([bot.acp.text_block('start')], 'chat')
        self.assertEqual(response.stop_reason, 'end_turn')
        self.assertEqual(self.calls, ['start', 'research result'])
        ack.assert_called_once_with(self.event, 'claim')

    async def test_halt_during_background_wait_stops_children_without_followup(self):
        async def cancel(_):
            await asyncio.sleep(0.03)
            await self.agent.cancel('chat')

        with patch.object(bot.HermesACPAgent, 'cancel', new=AsyncMock(side_effect=lambda *a, **kw: self.state.cancel_event.set())), \
             patch.object(delegation, 'interrupt_for_session') as interrupt, \
             patch.object(delegation, 'has_live_for_session', return_value=True), \
             patch.object(process_registry, 'drain_notifications', return_value=[]):
            response, _ = await asyncio.gather(self.agent.prompt([bot.acp.text_block('start')], 'chat'), cancel(None))
        self.assertEqual(response.stop_reason, 'cancelled')
        self.assertEqual(self.calls, ['start'])
        interrupt.assert_called_once_with(session_key='chat', reason='acp_cancel')

    async def test_failed_followup_releases_claim_without_acknowledging(self):
        self.agent._prompt_once = AsyncMock(side_effect=[PromptResponse(stop_reason='end_turn'), RuntimeError('failed')])
        with patch.object(delegation, 'has_live_for_session', return_value=False), \
             patch.object(process_registry, 'drain_notifications', return_value=[(self.event, 'result')]), \
             patch.object(delegation, 'claim_event_delivery', return_value='claim'), \
             patch.object(delegation, 'release_event_delivery') as release, \
             patch.object(delegation, 'complete_event_delivery') as ack:
            with self.assertRaisesRegex(RuntimeError, 'failed'):
                await self.agent.prompt([bot.acp.text_block('start')], 'chat')
        release.assert_called_once_with(self.event, 'claim')
        ack.assert_not_called()

    async def test_followup_can_delegate_more_work_before_final_completion(self):
        second = {**self.event, 'delegation_id': 'second'}
        with patch.object(delegation, 'has_live_for_session', side_effect=[False, True, False, False]), \
             patch.object(process_registry, 'drain_notifications', side_effect=[[(self.event, 'first result')], [], [(second, 'second result')], []]), \
             patch.object(delegation, 'claim_event_delivery', return_value='claim'), \
             patch.object(delegation, 'complete_event_delivery') as ack:
            await self.agent.prompt([bot.acp.text_block('start')], 'chat')
        self.assertEqual(self.calls, ['start', 'first result', 'second result'])
        self.assertEqual(ack.call_count, 2)

    async def test_notifications_are_scoped_and_duplicate_claims_do_not_rerun_parent(self):
        def drain(**kwargs):
            owns = kwargs['owns_event']
            self.assertFalse(owns({'type': 'async_delegation', 'session_key': 'other'}))
            self.assertFalse(owns({'type': 'completion', 'session_key': 'chat'}))
            self.assertTrue(owns(self.event))
            return [(self.event, 'already delivered')] if not self.seen else []

        self.seen = False
        def claim(*_):
            self.seen = True
            return None

        with patch.object(delegation, 'has_live_for_session', return_value=False), \
             patch.object(process_registry, 'drain_notifications', side_effect=drain), \
             patch.object(delegation, 'claim_event_delivery', side_effect=claim):
            await self.agent.prompt([bot.acp.text_block('start')], 'chat')
        self.assertEqual(self.calls, ['start'])

    @unittest.skipUnless(NATIVE, 'requires installed Hermes')
    async def test_native_worker_survives_parent_reply_and_result_is_acknowledged(self):
        handles = []
        async def once(prompt, session_id, **kwargs):
            self.calls.append(prompt[0].text)
            if len(self.calls) == 1:
                def worker():
                    time.sleep(0.25)
                    return {'summary': 'NATIVE_BACKGROUND_RESULT', 'api_calls': 0}
                handles.append(await asyncio.to_thread(delegation.dispatch_async_delegation,
                    goal='controlled diagnostic', context=None, toolsets=None, role='general', model=None,
                    session_key=session_id, parent_session_id='compressed-head', runner=worker))
                self.assertEqual(handles[-1]['status'], 'dispatched')
            return PromptResponse(stop_reason='end_turn')
        self.agent._prompt_once = once
        response = await self.agent.prompt([bot.acp.text_block('start')], 'chat')
        self.assertEqual(response.stop_reason, 'end_turn')
        self.assertEqual(len(self.calls), 2)
        self.assertIn('NATIVE_BACKGROUND_RESULT', self.calls[1])
        saved = delegation.get_durable_delegation(handles[0]['delegation_id'])
        self.assertEqual(saved['delivery_state'], 'delivered')
        self.assertIsNotNone(saved['completed_at'])


if __name__ == '__main__':
    unittest.main(argv=[__file__])
