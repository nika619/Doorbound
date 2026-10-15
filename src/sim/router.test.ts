import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockOf, route, tidyStep } from './router.ts';

const people = ['Aarav', 'Isha', 'Dad'];
const clockIn = (m: number) => `+${m}`;
const r = (u: string, speaker: string | null = null) => route(u, people, speaker, clockIn);

test('starting a departure, by clock time or by minutes from now', () => {
  assert.deepEqual(r('Alexa, start the school run, we leave at 7:40'), { tool: 'start_departure', args: { leaveAt: '07:40', name: 'School Run' } });
  assert.deepEqual(r('start the school run. We leave in 28 minutes'), { tool: 'start_departure', args: { leaveAt: '+28', name: 'School Run' } });
  assert.deepEqual(r('start the departure, leaving at 8:15 am'), { tool: 'start_departure', args: { leaveAt: '08:15' } });
});

test('who finished, by name or by the voice speaking', () => {
  assert.deepEqual(r("Aarav's done with breakfast"), { tool: 'step_done', args: { person: 'Aarav' } });
  assert.deepEqual(r("I'm done", 'Isha'), { tool: 'step_done', args: { person: 'Isha' } });
  assert.equal(r("I'm done", null), null, 'without a name or a known speaker, it does not guess');
});

test('running over, with and without a number', () => {
  assert.deepEqual(r("Alexa, Isha's still in the shower"), { tool: 'still_going', args: { person: 'Isha' } });
  assert.deepEqual(r('Aarav needs five more minutes'), { tool: 'still_going', args: { person: 'Aarav', extraMinutes: 5 } });
});

test('moving the departure earlier, later, or to a time', () => {
  assert.deepEqual(r('we need to leave ten minutes early'), { tool: 'change_departure', args: { shiftMinutes: -10 } });
  assert.deepEqual(r('we can leave 5 minutes later'), { tool: 'change_departure', args: { shiftMinutes: 5 } });
  assert.deepEqual(r('leave at 7:30 instead'), { tool: 'change_departure', args: { leaveAt: '07:30' } });
});

test('questions and undo', () => {
  assert.equal(r('how are we doing?')!.tool, 'departure_status');
  assert.equal(r("who's late")!.tool, 'departure_status');
  assert.equal(r('how long does the shower really take')!.tool, 'learned_times');
  assert.equal(r('undo that')!.tool, 'undo_reroute');
  assert.equal(r("we've left")!.tool, 'end_departure');
});

test('a routine in one sentence', () => {
  assert.deepEqual(r('Isha showers for 8 minutes, then gets dressed for 6, then has breakfast for four'), {
    tool: 'set_routine',
    args: { person: 'Isha', steps: [{ name: 'Shower', minutes: 8 }, { name: 'Get dressed', minutes: 6 }, { name: 'Breakfast', minutes: 4 }] },
  });
});

test('step names read naturally', () => {
  assert.equal(tidyStep('brushes his teeth'), 'Brush teeth');
  assert.equal(tidyStep('walks the dog'), 'Walk the dog');
  assert.equal(tidyStep('packs her bag'), 'Pack bag');
  assert.equal(tidyStep('breakfast'), 'Breakfast');
});

test('clock parsing', () => {
  assert.equal(clockOf('7:40'), '07:40');
  assert.equal(clockOf('7.05 pm'), '19:05');
  assert.equal(clockOf('25:00'), null);
});

test('unknown requests are not forced into a tool', () => {
  assert.equal(r('play some jazz'), null);
});
