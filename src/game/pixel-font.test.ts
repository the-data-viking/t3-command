import assert from 'node:assert/strict';
import test from 'node:test';
import { fitText, GLYPH_H, GLYPH_W, GLYPHS, glyphFor, STATUS_GLYPHS } from '../art/pixelfont';

test('every glyph is a well-formed 5×7 cell', () => {
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    assert.equal(rows.length, GLYPH_H, `${ch} height`);
    assert.ok(rows.every((row) => row.length === GLYPH_W && /^[#.]+$/.test(row)), `${ch} rows`);
  }
});

test('glyphs are distinct, so no two characters read the same', () => {
  const seen = new Map<string, string>();
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    const key = rows.join('/');
    assert.ok(!seen.has(key) || ch === ' ', `${ch} duplicates ${seen.get(key)}`);
    seen.set(key, ch);
  }
});

test('labels cover what the map writes: names, counts, separators and unknowns', () => {
  for (const ch of 'THE-LIVING-STONE · +5 SETTLED CPU 17% RAM 70% #42 MAC MINI (LOCAL) 2/3 …') assert.notEqual(glyphFor(ch), GLYPHS['?'], ch);
  assert.deepEqual(glyphFor('a'), GLYPHS.A, 'lowercase is uppercased');
  assert.deepEqual(glyphFor('é'), GLYPHS.E, 'accents fall back to the base letter');
  assert.deepEqual(glyphFor('—'), GLYPHS['-']);
  assert.deepEqual(glyphFor('🚀'), GLYPHS['?']);
});

test('every status has its own 5×5 shape, independent of color', () => {
  const shapes = Object.values(STATUS_GLYPHS).map((rows) => rows.join('/'));
  assert.equal(new Set(shapes).size, shapes.length);
  for (const rows of Object.values(STATUS_GLYPHS)) assert.ok(rows.length === 5 && rows.every((r) => r.length === 5));
});

test('zoomed-out titles shorten to fit their facility instead of running into neighbors', () => {
  // 6 screen px per character at 1:1; a 50 px wide station fits 8 characters.
  assert.equal(fitText('THE-LIVING-STONE', 50, 1), 'THE-LIV…');
  assert.equal(fitText('GITHUB', 50, 1), 'GITHUB');
  assert.equal(fitText('THE-LIVING-STONE', 400, 2), 'THE-LIVING-STONE');
  assert.equal(fitText('ANYTHING', 2, 1).length <= 2, true, 'never wider than the room it has');
});
