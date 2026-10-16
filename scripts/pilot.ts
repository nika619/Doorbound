// The pilot report: what real mornings in this household taught Doorbound, and how honest its chances were.
//   npm run pilot                 reads data/household.json (or DATA_DIR)
// Nothing is changed. See PILOT.md for running the pilot itself.
import { join } from 'node:path';
import { keyOf } from '../src/core/learn.ts';
import { rhoOf } from '../src/core/pace.ts';
import { honesty } from '../src/core/score.ts';
import { posterior } from '../src/core/stats.ts';
import { Store } from '../src/server/store.ts';

const dir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data');
const store = await Store.open(dir);
const min = (sec: number) => `${(sec / 60).toFixed(1)} min`;

console.log(`Doorbound pilot report, from ${join(dir, 'household.json')}\n`);
console.log('What each step really takes (median, from up to 9 mornings, with the stated time as a prior):');
for (const p of store.household.people)
  for (const s of p.steps) {
    const samples = store.history.get(keyOf(p.id, s.id)) ?? [];
    const learned = Math.exp(posterior(s.statedSec, samples).mu);
    const gap = samples.length ? `${learned > s.statedSec ? '+' : ''}${Math.round((learned / s.statedSec - 1) * 100)}%` : '';
    console.log(`  ${`${p.name}: ${s.name}`.padEnd(34)} said ${min(s.statedSec).padStart(8)}   learned ${min(learned).padStart(8)} ${gap.padStart(6)}   (${samples.length} mornings)`);
  }

const { products, pairs } = store.pace;
console.log(`\nHow much a slow step means a slow morning (rho): ${rhoOf(store.pace).toFixed(2)}, from ${Math.round(pairs)} same-morning pairs (prior 0.30 until there are enough; mean product ${pairs ? (products / pairs).toFixed(2) : 'n/a'}).`);

const { n, bands, brier } = honesty(store.scores);
console.log(`\nHow honest the chances were: ${n} forecasts checked against what happened.`);
const labels = ['under 50%', '50-80%', '80% and up'];
bands.forEach((b, i) => console.log(`  said ${labels[i].padEnd(11)} ${b.n ? `on average ${(b.said * 100).toFixed(0)}%, happened ${(b.happened * 100).toFixed(0)}%` : 'no forecasts'}   (n ${b.n})`));
if (n) console.log(`  Brier score ${brier.toFixed(3)} (0 is perfect; always saying 50% scores 0.25).`);
if (n < 30) console.log('\nFewer than 30 forecasts: treat the bands as anecdotes, not evidence.');
