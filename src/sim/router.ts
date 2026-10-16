// Stands in for Alexa+'s language model in the simulator: maps what someone says to one tool call.
// Deliberately small and deterministic (the organisers allow a scripted simulation), so a demo is
// repeatable. In real Alexa+, the model reads the tool descriptions and fills the same arguments.

export interface Call {
  tool: string;
  args: Record<string, unknown>;
}

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
const num = (s: string) => WORDS[s.toLowerCase()] ?? Number(s);
const NUM = String.raw`(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)`;

/** "7:40", "7.40", "740", "7 40 am" → "07:40" (24-hour). */
export function clockOf(text: string): string | null {
  const m = text.match(/\b(\d{1,2})(?:[:.\s]?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\d)/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (/p/i.test(m[3] ?? '') && h < 12) h += 12;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "gets dressed" → "Get dressed", "brushes his teeth" → "Brush teeth", "has breakfast" → "Breakfast". */
export function tidyStep(raw: string): string {
  let words = raw
    .trim()
    .toLowerCase()
    .replace(/\b(his|her|their|my)\s+/g, '')
    .split(/\s+/);
  if (words.length > 1 && ['has', 'have', 'eats', 'eat', 'does', 'do', 'takes', 'take'].includes(words[0])) words = words.slice(1);
  words[0] = words[0].replace(/(sh|ch|ss|x)es$/, '$1').replace(/([^s])s$/, '$1');
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param people  names in the household, to recognise who is meant
 * @param speaker who is talking (Alexa+ recognises voices; the simulator lets you pick)
 * @param clockIn turns "in N minutes" into a clock time on the server's clock
 */
export function route(utterance: string, people: string[], speaker: string | null, clockIn?: (minutes: number) => string): Call | null {
  const text = utterance.trim().replace(/^alexa[,\s]+/i, '');
  const lower = text.toLowerCase();
  const named = people.find((p) => new RegExp(String.raw`\b${p.toLowerCase()}\b`).test(lower));
  const who = named ?? (/\b(i|i'm|im|i am|me|my)\b/.test(lower) ? speaker : null);

  if (/\bundo\b|keep the old plan|change it back/.test(lower)) return { tool: 'undo_reroute', args: {} };
  if (/\b(we've left|we have left|end the|cancel the|stop the)\b/.test(lower)) return { tool: 'end_departure', args: {} };
  if (/how long does|really take|what have you learned|what did you learn/.test(lower)) return { tool: 'learned_times', args: {} };
  if (/how accurate|how reliable|how honest|can i trust|how right/.test(lower)) return { tool: 'how_accurate', args: {} };
  if (/how are we doing|who's late|who is late|how long until|are we on time/.test(lower)) return { tool: 'departure_status', args: {} };

  // What can bend: "Isha's breakfast can be to go in 2 minutes", "Dad can pack Isha's bag", "the dishwasher can wait", "Aarav can skip reading"
  const owner = (n: string | undefined) => (n ? people.find((p) => p.toLowerCase() === n) : undefined);
  const quick = lower.match(new RegExp(String.raw`^(?:(\w+)'s\s+)?(.+?)\s+can be\s+(.+?)\s+in\s+${NUM}\s+minutes?\.?$`));
  if (quick && !owner(quick[2])) {
    // (not "Isha can be ready in 5 minutes": that is a person, not a step)
    const person = owner(quick[1]) ?? who;
    return person ? { tool: 'allow_change', args: { person, step: tidyStep(quick[2]), quickVersion: { name: tidyStep(`${quick[2]} ${quick[3]}`), minutes: num(quick[4]) } } } : null;
  }
  const helps = lower.match(/^(\w+) can (?:\w+ )?(\w+)'s (.+?)\.?$/);
  if (helps && owner(helps[1]) && owner(helps[2])) return { tool: 'allow_change', args: { person: owner(helps[2])!, step: tidyStep(helps[3]), helper: owner(helps[1])! } };
  const waits = lower.match(/^(?:(\w+)'s |the |my )?(.+?) can wait\.?$/);
  if (waits) {
    const person = owner(waits[1]) ?? speaker;
    return person ? { tool: 'allow_change', args: { person, step: tidyStep(waits[2]), canWait: true } } : null;
  }
  const skips = lower.match(/^(\w+) can skip (?:the |their |his |her )?(.+?)\.?$/);
  if (skips && owner(skips[1])) return { tool: 'allow_change', args: { person: owner(skips[1])!, step: tidyStep(skips[2]), optional: true } };

  // "we leave at 7:40 tomorrow, when should everyone be up?"
  if (/\b(tomorrow|get up|be up|wake|alarms?)\b/.test(lower) && /\b(leave|leaving|at)\b/.test(lower)) {
    const leaveAt = clockOf(lower.replace(/^.*?\b(?:leave|leaving|at)\s+/, ''));
    return leaveAt ? { tool: 'plan_tomorrow', args: { leaveAt } } : null;
  }

  // "start the school run, we leave at 7:40" / "... we leave in 28 minutes"
  if (/\bstart\b/.test(lower) && /\b(leave|leaving|run)\b/.test(lower)) {
    const name = text.match(/start (?:the )?([a-z ]+?)(?=[,.]|\s+(?:we|and|leaving|leave|at|in)\b|$)/i)?.[1]?.trim();
    const inMin = lower.match(new RegExp(String.raw`in ${NUM} minutes?`));
    const leaveAt = inMin && clockIn ? clockIn(num(inMin[1])) : clockOf(lower.replace(/^.*?\b(?:leave|leaving|at)\s+/, ''));
    if (!leaveAt) return null;
    const title = name && !/^(departure|morning)$/i.test(name) ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;
    return { tool: 'start_departure', args: { leaveAt, ...(title ? { name: title } : {}) } };
  }
  // "we need to leave ten minutes early" / "leave at 7:30 instead"
  if (/\bleave\b/.test(lower) && /\b(early|earlier|later|instead|at)\b/.test(lower)) {
    const shift = lower.match(new RegExp(String.raw`${NUM} minutes? (early|earlier|later)`));
    if (shift) return { tool: 'change_departure', args: { shiftMinutes: (shift[2] === 'later' ? 1 : -1) * num(shift[1]) } };
    const at = clockOf(lower.replace(/^.*?\bat\s+/, ''));
    if (at) return { tool: 'change_departure', args: { leaveAt: at } };
  }
  // "Isha's still in the shower" / "Aarav needs five more minutes"
  if (who && /\bstill\b|more minutes?|running (late|behind|over)|needs? (more|longer|another)/.test(lower)) {
    const extra = lower.match(new RegExp(String.raw`${NUM} more minutes?|another ${NUM} minutes?`));
    const n = extra ? num(extra[1] ?? extra[2]) : undefined;
    return { tool: 'still_going', args: { person: who, ...(n ? { extraMinutes: n } : {}) } };
  }
  // "I'm done" / "Aarav has finished breakfast"
  if (who && /\b(done|finished|ready|all set)\b/.test(lower)) return { tool: 'step_done', args: { person: who } };

  // "Isha showers for 8 minutes, then gets dressed for 6, then has breakfast for 4"
  if (named) {
    const step = new RegExp(String.raw`^(?:${named}\s+|she\s+|he\s+|they\s+)?(.+?)\s+for\s+${NUM}(?:\s+minutes?)?$`, 'i');
    const steps = text
      .split(/,|;|\bthen\b|\band\b/i)
      .map((seg) => seg.trim().match(step))
      .filter((m): m is RegExpMatchArray => !!m);
    if (steps.length) return { tool: 'set_routine', args: { person: named, steps: steps.map((m) => ({ name: tidyStep(m[1]), minutes: num(m[2]) })) } };
  }
  return null;
}
