import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from './MessageMarkdown';

const render = (text: string) => renderToStaticMarkup(<MessageMarkdown text={text} envId="env" threadId="thread" />);

test('external images render with alt text and an accessible full-size link', () => {
  const html = render('![Map](https://images.test/map.png)');
  assert.match(html, /src="https:\/\/images.test\/map.png"/);
  assert.match(html, /alt="Map"/);
  assert.match(html, /href="https:\/\/images.test\/map.png"/);
});

test('absolute, relative, file URL and Windows embeds wait for T3 resolution', () => {
  for (const src of ['/tmp/map.png', 'images/map.png', 'file:///tmp/map.png', 'C:/captures/map.png']) {
    assert.match(render(`![Map](${src})`), /Loading image/);
    assert.doesNotMatch(render(`![Map](${src})`), /<img/);
  }
});

test('unsafe image URLs and raw HTML cannot become executable content', () => {
  assert.doesNotMatch(render('![Map](javascript:alert%281%29)'), /(?:src|href)="javascript:/);
  assert.doesNotMatch(render('<img src=x onerror=alert(1)>'), /<img/);
  assert.doesNotMatch(render('[click](javascript:alert%281%29)'), /href="javascript:/);
});
