import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pick } from './understand.ts';

test("the model's answer becomes one tool call, or a sentence when it chose no tool", () => {
  const call = pick({ content: [{ type: 'text', text: 'On it.', citations: null }, { type: 'tool_use', id: 't1', name: 'step_done', input: { person: 'Isha' }, caller: { type: 'direct' } }] } as never);
  assert.deepEqual(call, { tool: 'step_done', args: { person: 'Isha' } });
  assert.deepEqual(pick({ content: [{ type: 'text', text: 'It is sunny.', citations: null }] } as never), { say: 'It is sunny.' });
  assert.deepEqual(pick({ content: [] }), { say: "Sorry, I didn't catch that." }); // a refusal comes back empty
});
