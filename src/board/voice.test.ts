import assert from 'node:assert/strict';
import { test } from 'node:test';
import { voiceRank } from './voice.ts';

test('a neural voice beats Google, Google beats the desktop voices, and Zira comes last', () => {
  const v = (name: string, lang = 'en-US', isDefault = false) => ({ name, lang, default: isDefault });
  const voices = [v('Microsoft Zira - English (United States)'), v('Microsoft David - English (United States)', 'en-US', true), v('Google US English'), v('Microsoft Ava Online (Natural) - English (United States)'), v('Microsoft Heera - English (India)', 'en-IN'), v('Google Deutsch', 'de-DE')];
  const order = [...voices].sort((a, b) => voiceRank(a) - voiceRank(b)).map((x) => x.name.split(' ')[1]);
  assert.deepEqual(order, ['Ava', 'US', 'David', 'Heera', 'Zira', 'Deutsch']);
});
