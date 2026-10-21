// Speaking aloud in the warmest voice this browser has. Neural voices (Edge's "Online (Natural)", Apple's
// Premium/Enhanced, Chrome's Google voices) sound like a person; Windows' old desktop voices sound like a
// machine, and Zira's high, thin one grates most, so it comes last.
const NEURAL = /natural|neural|premium|enhanced/i;
const WARM = ['Ava', 'Emma', 'Jenny', 'Aria', 'Sonia', 'Libby', 'Samantha', 'Serena', 'Google US English', 'Google UK English Female'];

/** Lower is better: neural first, then Google's, then the known warm names, then the default; Zira last. */
export function voiceRank(v: Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'default'>): number {
  if (!/^en[-_]/i.test(v.lang)) return Infinity;
  const tier = NEURAL.test(v.name) ? 0 : /^google/i.test(v.name) ? 1 : /zira/i.test(v.name) ? 3 : 2;
  const warm = WARM.findIndex((w) => v.name.includes(w));
  return tier * 100 + (warm < 0 ? 50 : warm) - (v.default ? 1 : 0) + (/^en[-_]US/i.test(v.lang) ? 0 : 0.5);
}

let best: SpeechSynthesisVoice | null | undefined;
if ('speechSynthesis' in globalThis) speechSynthesis.addEventListener('voiceschanged', () => (best = undefined));

export function speakAloud(text: string) {
  best ??= speechSynthesis.getVoices().reduce<SpeechSynthesisVoice | null>((a, v) => (voiceRank(v) < (a ? voiceRank(a) : Infinity) ? v : a), null);
  const u = new SpeechSynthesisUtterance(text);
  if (best) {
    u.voice = best;
    u.lang = best.lang;
  }
  // Neural voices are paced well as they are; the desktop ones sound less clipped a touch slower and lower.
  const neural = !!best && voiceRank(best) < 200;
  u.rate = neural ? 1 : 0.94;
  u.pitch = neural ? 1 : 0.92;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
