import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueToken, resourceOf, TOKEN_TTL_SEC, verifyAccessToken, type OAuthConfig } from './oauth.ts';

const c: OAuthConfig = { clientId: 'alexa-plus', clientSecret: 's'.repeat(40), publicUrl: 'https://doorbound.example.com' };
const NOW = 1_800_000_000;
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
const form = (o: Record<string, string>) => new URLSearchParams({ grant_type: 'client_credentials', resource: resourceOf(c), ...o });

test('client credentials in, an hour-long Bearer token for this server out', () => {
  const r = issueToken(c, form({}), basic('alexa-plus', c.clientSecret), NOW);
  assert.equal(r.status, 200);
  assert.equal(r.body.token_type, 'Bearer');
  assert.equal(r.body.expires_in, TOKEN_TTL_SEC);
  assert.equal(r.body.scope, 'mcp:service');
  const token = String(r.body.access_token);
  assert.ok(verifyAccessToken(c, token, NOW + 10));
  assert.ok(!verifyAccessToken(c, token, NOW + TOKEN_TTL_SEC), 'expired after an hour');
  assert.ok(!verifyAccessToken({ ...c, publicUrl: 'https://other.example.com' }, token, NOW), 'bound to this server');
  assert.ok(!verifyAccessToken({ ...c, clientSecret: 't'.repeat(40) }, token, NOW), 'a new secret revokes every token');
  assert.ok(!verifyAccessToken(c, `${token.slice(0, -2)}xx`, NOW), 'a changed signature fails');
  // Swap in claims with a later expiry but keep the signature: refused.
  const [, p, s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), exp: NOW + 99_999 })).toString('base64url');
  assert.ok(!verifyAccessToken(c, `db1.${forged}.${s}`, NOW));
});

test('secrets in the body work too, but never both ways at once', () => {
  assert.equal(issueToken(c, form({ client_id: 'alexa-plus', client_secret: c.clientSecret }), undefined, NOW).status, 200);
  const both = issueToken(c, form({ client_id: 'alexa-plus' }), basic('alexa-plus', c.clientSecret), NOW);
  assert.deepEqual([both.status, both.body.error], [400, 'invalid_request']);
});

test('every wrong request gets the RFC 6749 error it should', () => {
  const ok = basic('alexa-plus', c.clientSecret);
  const cases: [URLSearchParams, string | undefined, number, string][] = [
    [form({}), basic('alexa-plus', 'wrong'), 401, 'invalid_client'],
    [form({}), basic('someone', c.clientSecret), 401, 'invalid_client'],
    [form({}), undefined, 401, 'invalid_client'],
    [form({ grant_type: 'authorization_code' }), ok, 400, 'unsupported_grant_type'],
    [form({ resource: 'https://evil.example.com/mcp' }), ok, 400, 'invalid_target'],
    [new URLSearchParams({ grant_type: 'client_credentials' }), ok, 400, 'invalid_target'],
    [form({ scope: 'mcp:tools' }), ok, 400, 'invalid_scope'],
  ];
  for (const [f, auth, status, code] of cases) {
    const r = issueToken(c, f, auth, NOW);
    assert.deepEqual([r.status, r.body.error], [status, code], `${f} ${auth}`);
  }
  assert.equal(issueToken(c, form({}), basic('alexa-plus', 'wrong'), NOW).headers?.['WWW-Authenticate'], 'Basic realm="doorbound"');
});

test('garbage is never a token', () => {
  for (const t of [undefined, '', 'db1', 'db1..', 'db1.e30.', 'Bearer x', 'db1.!!!.###']) assert.ok(!verifyAccessToken(c, t, NOW), String(t));
});
