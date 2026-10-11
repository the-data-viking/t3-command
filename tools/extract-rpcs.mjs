import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const region = src.slice(48884, 49850).join('\n');
const names = {};
for (const m of region.matchAll(/^\t(\w+): "([^"]+)"/gm)) names[m[1]] = m[2];
const orch = {dispatchCommand:"orchestration.dispatchCommand",getWorkflowScript:"orchestration.getWorkflowScript",getTurnDiff:"orchestration.getTurnDiff",getFullThreadDiff:"orchestration.getFullThreadDiff",searchThreads:"orchestration.searchThreads",getArchivedShellSnapshot:"orchestration.getArchivedShellSnapshot",subscribeShell:"orchestration.subscribeShell",subscribeThread:"orchestration.subscribeThread"};
const re = /make\$146\((\w+)\.(\w+), \{([\s\S]*?)\n\}\)/g;
let m;
while ((m = re.exec(region))) {
  const body = m[3].replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,' ').trim();
  const pay = body.match(/payload: (.*?), success:/)?.[1] ?? '';
  const suc = body.match(/success: (.*?), error:/)?.[1] ?? body.match(/success: ([^,]+)/)?.[1];
  const wire = m[1]==='WS_METHODS' ? names[m[2]] : orch[m[2]];
  console.log(`${wire}\t${pay.replace(/\$\d+/g,'')}\t${(suc||'').replace(/\$\d+/g,'')}\t${/stream: true/.test(body)?'stream':''}`);
}
