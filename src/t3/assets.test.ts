import assert from 'node:assert/strict';
import test from 'node:test';
import { assetProxyUrl, imageResource } from './assets';

test('routes signed URLs through the selected environment', () => {
  assert.equal(assetProxyUrl('remote base', '/api/assets/token/photo%20one.png'), '/env/remote%20base/assets/token/photo%20one.png');
  for (const url of ['https://other/api/assets/token/a.png', '//other/api/assets/token/a.png', '/api/assets/../../oauth/token', '/api/assets/..\\..\\oauth/token']) {
    assert.throws(() => assetProxyUrl('env', url));
  }
});

test('embedded paths stay on their thread, including captures and Windows paths', () => {
  for (const [src, path] of [
    ['/tmp/capture.png', '/tmp/capture.png'], ['images/map.png', 'images/map.png'],
    ['file:///Users/me/My%20Project/image.png', '/Users/me/My Project/image.png'],
    ['C:\\captures\\image.png', 'C:\\captures\\image.png'], ['file:///C:/captures/image.png', 'C:/captures/image.png'],
    ['image.png?cache=1#preview', 'image.png'],
  ]) assert.deepEqual(imageResource(src, 'thread'), { _tag: 'media-file', threadId: 'thread', path });
  for (const src of ['https://images.test/a.png', 'http://images.test/a.png', '//images.test/a.png', 'data:image/png;base64,AA==', 'javascript:alert(1)', 'file://other/a.png', '%broken']) {
    assert.equal(imageResource(src, 'thread'), null);
  }
});
