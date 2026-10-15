import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduledReport } from './ScheduledReport';
import { scheduledReportTitle } from './transcript';

test('native scheduled reports are compact and retain their complete body on expansion', async t => {
  const text = '[Cronjob "Maintenance response supervisor" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n' + 'Full worker evidence\n'.repeat(1500);
  const title = scheduledReportTitle({ role:'user', text });
  assert.equal(title, 'Maintenance response supervisor');
  assert.equal(scheduledReportTitle({ role:'assistant', text }), undefined);
  assert.equal(scheduledReportTitle({ role:'user', text:'Please review this normally.' }), undefined);
  const dom = new JSDOM('<div id="root"></div>', {url:'http://localhost'});
  const restore: Array<() => void> = [];
  for (const [key,value] of Object.entries({window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})) {
    const old=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    restore.push(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});
  }
  const root=createRoot(document.getElementById('root')!);
  t.after(async()=>{await act(()=>root.unmount());dom.window.close();restore.forEach(fn=>fn());});
  await act(()=>root.render(<ScheduledReport title={title!} createdAt={new Date().toISOString()}><pre>{text}</pre></ScheduledReport>));
  assert.match(document.querySelector('summary')!.textContent!,/Scheduled report.*Maintenance response supervisor/);
  assert.equal(document.querySelector('pre'),null,'the large body is not rendered while collapsed');
  await act(()=>{const details=document.querySelector('details')!;details.open=true;details.dispatchEvent(new dom.window.Event('toggle'));});
  assert.equal(document.querySelector('pre')!.textContent,text);
});
