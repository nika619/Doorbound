import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draw, rng } from './fixtures.ts';
import { cdf, moments, phi, phiInv, posterior, PRIOR_SIGMA, quantile, remaining, sum, type LogNormal } from './stats.ts';

test('normal CDF and its inverse match known values and invert each other', () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(phi(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(phi(-1) - 0.158655) < 1e-6);
  for (const p of [1e-6, 0.01, 0.1, 0.5, 0.85, 0.99, 1 - 1e-6]) assert.ok(Math.abs(phi(phiInv(p)) - p) < 2e-7 * Math.max(1, p * 100), `p=${p}`);
});

test('the normal tail stays accurate far out, where an absolute-error fit would not', () => {
  // Reference values of Q(z) = 1 - Phi(z), to 6 significant figures.
  for (const [z, q] of [[3, 1.34990e-3], [5, 2.86652e-7], [7, 1.27981e-12], [9, 1.12859e-19]]) assert.ok(Math.abs(phi(-z) / q - 1) < 1e-5, `z=${z}: ${phi(-z)} vs ${q}`);
});

test('with no history the median is the stated time and the spread is the prior', () => {
  const d = posterior(480);
  assert.ok(Math.abs(Math.exp(d.mu) - 480) < 1e-9);
  assert.ok(Math.abs(d.sigma - PRIOR_SIGMA) < 1e-12);
});

test('real mornings pull the estimate towards reality, and a habitual underestimate widens it', () => {
  const said = posterior(480, [840, 840, 840, 840, 840]); // says 8 minutes, takes 14
  assert.ok(Math.exp(said.mu) > 700 && Math.exp(said.mu) < 840, `median ${Math.exp(said.mu)}`);
  const honest = posterior(840, [840, 830, 850, 845, 835]);
  assert.ok(honest.sigma < said.sigma, 'a gap between word and deed is extra uncertainty');
});

test('Fenton-Wilkinson sum gives the right probability of making a deadline (Monte Carlo, 200k draws)', () => {
  const r = rng(7);
  const steps: LogNormal[] = [posterior(840, [800, 900, 860]), posterior(360), posterior(240, [300, 280]), posterior(180)];
  const S = sum(steps.map(moments))!;
  for (const deadline of [1500, 1700, 1900, 2100]) {
    let hit = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) if (steps.reduce((a, d) => a + draw(r, d), 0) <= deadline) hit++;
    const mc = hit / N;
    assert.ok(Math.abs(cdf(S, deadline) - mc) < 0.02, `deadline ${deadline}: analytic ${cdf(S, deadline).toFixed(3)} vs simulated ${mc.toFixed(3)}`);
  }
});

test('the remainder of a step already under way has the right mean and spread (Monte Carlo)', () => {
  const r = rng(11);
  const d = posterior(840, [800, 900, 860]);
  for (const elapsed of [300, 840, 1000]) {
    const rest: number[] = [];
    while (rest.length < 100_000) {
      const x = draw(r, d);
      if (x > elapsed) rest.push(x - elapsed);
    }
    const mean = rest.reduce((a, b) => a + b, 0) / rest.length;
    const sd = Math.sqrt(rest.reduce((a, b) => a + (b - mean) ** 2, 0) / rest.length);
    const m = remaining(d, elapsed, 0);
    assert.ok(Math.abs(m.mean - mean) / mean < 0.02, `elapsed ${elapsed}: mean ${m.mean.toFixed(1)} vs ${mean.toFixed(1)}`);
    assert.ok(Math.abs(Math.sqrt(m.variance) - sd) / sd < 0.04, `elapsed ${elapsed}: sd ${Math.sqrt(m.variance).toFixed(1)} vs ${sd.toFixed(1)}`);
  }
});

test('a step far past anything expected is assumed short, never negative or infinite', () => {
  const m = remaining({ mu: Math.log(300), sigma: 0.1 }, 3000);
  assert.equal(m.mean, 30);
  assert.ok(Number.isFinite(m.variance));
});

test('quantile and CDF agree', () => {
  const d = { mu: Math.log(600), sigma: 0.3 };
  for (const p of [0.1, 0.5, 0.85, 0.95]) assert.ok(Math.abs(cdf(d, quantile(d, p)) - p) < 1e-6);
});
