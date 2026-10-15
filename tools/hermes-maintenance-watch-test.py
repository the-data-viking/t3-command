import importlib.util
from pathlib import Path
import unittest
import sys
import types
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watcher', Path(__file__).with_name('hermes-maintenance-watch.py'))
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)


class WatcherTests(unittest.TestCase):
    def test_running_churn_never_wakes_reviewer(self):
        result = {'threadId':'t', 'latestTurn':{'turnId':'one','state':'running'},
                  'session':{'updatedAt':'changing'}, 'messages':[{'id':'a','text':'partial','streaming':True}]}
        self.assertEqual(watcher.changed_reviews([result], {}), [])
        result['session']['updatedAt'] = 'changed again'
        result['messages'][0]['text'] += ' more'
        self.assertEqual(watcher.changed_reviews([result], {}), [])

    def test_completion_is_once_per_real_result_and_report_is_bounded(self):
        result = {'threadId':'t', 'latestTurn':{'turnId':'one','state':'completed'},
                  'messages':[{'id':'a','text':'result'*2000,'streaming':False}], 'session':{'updatedAt':'first'}}
        cache = {}
        changes = watcher.changed_reviews([result], cache)
        self.assertEqual(len(changes), 1)
        self.assertLessEqual(len(changes[0]['report']), 4000)
        result['session']['updatedAt'] = 'churn'
        self.assertEqual(watcher.changed_reviews([result], cache), [])
        result['latestTurn']['turnId'] = 'two'
        self.assertEqual(len(watcher.changed_reviews([result], cache)), 1)

    def test_pending_approval_and_failure_are_actionable_without_a_finished_turn(self):
        result = {'threadId':'t', 'latestTurn':{'turnId':'one','state':'running'},
                  'pending':[{'payload':{'requestId':'approve'}}]}
        cache = {}
        self.assertEqual(len(watcher.changed_reviews([result], cache)), 1)
        self.assertEqual(watcher.changed_reviews([result], cache), [])
        result['pending'] = []
        result['reviewErrors'] = [{'turnId':'old','summary':'old error'}]
        self.assertEqual(watcher.changed_reviews([result], cache), [])
        result['error'] = 'station unavailable'
        self.assertEqual(len(watcher.changed_reviews([result], cache)), 1)


class ImportTests(unittest.TestCase):
    def test_tool_call_placeholder_messages_do_not_become_empty_chat_bubbles(self):
        spec = importlib.util.spec_from_file_location('manager', Path(__file__).parents[1] / 'server/hermes/manage.py')
        manager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(manager)
        class Database:
            def __init__(self, _path):
                pass
            def get_session_by_title(self, _title):
                return {'id':'chat', 'source':'cli'}
            def get_messages(self, _sid, **kwargs):
                return [{'id':1,'role':'assistant','content':''},
                        {'id':2,'role':'tool','content':'tool payload'},
                        {'id':3,'role':'assistant','content':'Actual reply'}]
            def close(self):
                pass
        with patch.dict(sys.modules, {'hermes_state':types.SimpleNamespace(SessionDB=Database)}):
            result = manager.session_data(Path('/unused'), '/workspace', create=False)
        self.assertEqual([m['text'] for m in result['messages']], ['Actual reply'])


if __name__ == '__main__':
    unittest.main()
