"""Opt-in native cron migration check in a temporary HERMES_HOME; no model calls."""
import importlib.util
import json
from pathlib import Path
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeMigration(unittest.TestCase):
    def test_routines_use_isolated_cron_and_old_chat_reports_stay_suppressed(self):
        from hermes_constants import get_hermes_home
        from cron import jobs
        from cron.bot_chat_delivery import defer, read_pending
        from cron.scheduler import run_job
        home = get_hermes_home()
        (home / 'scripts').mkdir(parents=True, exist_ok=True)
        (home / 'maintenance').mkdir(parents=True, exist_ok=True)
        (home / 'scripts/t3-maintenance-watch.py').write_text('print("old watcher")\n')
        (home / 'scripts/t3-maintenance-hourly.py').write_text('print("hourly report")\n')
        hourly = jobs.create_job(name='Hourly fleet maintenance', prompt='Preserve active work.', schedule='every 1h',
                                script='t3-maintenance-hourly.py', no_agent=True, deliver='bot-chat:default')
        watcher = jobs.create_job(name='Maintenance response supervisor', prompt='', schedule='every 2m',
                                 script='t3-maintenance-watch.py', no_agent=True, deliver='bot-chat:default')
        defer('queued-report', watcher, 'Retained full evidence', 'default', home)
        migration = load('migration', 'configure-hermes-maintenance.py')
        migration.main(apply=True)
        for job in [hourly, watcher]:
            updated = jobs.get_job(job['id'])
            self.assertFalse(updated['no_agent'])
            self.assertEqual(updated['deliver'], 'local')
            self.assertTrue(updated['enabled'])
            self.assertIn('self', updated['context_from'])
            self.assertIn('canonical Bot Chat available', updated['prompt'])
        receipt = read_pending('queued-report')
        self.assertEqual(receipt['status'], 'suppressed')
        self.assertEqual(receipt['content'], 'Retained full evidence')
        manifest = json.loads((home / 'maintenance/chat-isolation-migration.json').read_text())
        self.assertEqual(len(manifest['suppressedPendingReports']), 1)
        # With no changes/fleet state, native cron skips the reviewer entirely.
        success, _document, output, error = run_job(jobs.get_job(watcher['id']))
        self.assertTrue(success, error)
        self.assertIn('SILENT', output)
        self.assertFalse((home / 'runtime/active_sessions.json').exists(), 'no canonical chat lease is acquired')


if __name__ == '__main__':
    unittest.main(argv=[__file__])
