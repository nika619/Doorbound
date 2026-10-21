import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { accessOf, authorizeRequest, formOk, formToken, householdOf, issueCode, issueToken, newHouseholdKey, redirectWith, resourceOf, screenHousehold, screenKey, TOKEN_TTL_SEC, USER_SCOPE, verifyAccessToken, type AuthRequest, type OAuthConfig } from './oauth.ts';

const c: OAuthConfig = { clientId: 'alexa-plus', clientSecret: 's'.repeat(40), signingKey: 'k'.repeat(40), publicUrl: 'https://doorbound.example.com' };
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
  assert.ok(!verifyAccessToken({ ...c, signingKey: 't'.repeat(40) }, token, NOW), 'a new signing key revokes every token');
  // Amazon holds the client secret; knowing it must not be enough to mint a token for any household.
  const minted = issueToken({ ...c, signingKey: c.clientSecret }, form({}), basic('alexa-plus', c.clientSecret), NOW).body.access_token;
  assert.ok(!verifyAccessToken(c, String(minted), NOW), 'a token signed with the client secret is refused');
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

// ---------- account linking: one add-on, many households ----------

const linked: OAuthConfig = { ...c, redirectUris: ['https://alexa.example.com/link'] };
const verifier = 'v'.repeat(43) + 'erifier-0123456789';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const query = (o: Record<string, string> = {}) =>
  new URLSearchParams({ client_id: 'alexa-plus', redirect_uri: 'https://alexa.example.com/link', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's1', ...o });

test('account linking: code with PKCE in, a token for that household and a refresh token out', () => {
  const req = authorizeRequest(linked, query()) as AuthRequest;
  assert.equal(req.redirectUri, 'https://alexa.example.com/link');
  const hh = householdOf(newHouseholdKey())!;
  const code = issueCode(linked, req, hh, NOW);
  const spent = new Map<string, number>();
  const exchange = (o: Record<string, string>, at = NOW + 5) =>
    issueToken(linked, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: req.redirectUri, code_verifier: verifier, ...o }), basic('alexa-plus', c.clientSecret), at, spent);
  assert.equal(exchange({ code_verifier: 'w'.repeat(50) }).body.error, 'invalid_grant', 'a wrong verifier fails (and spends the code)');
  const fresh = issueCode(linked, req, hh, NOW);
  const r = issueToken(linked, new URLSearchParams({ grant_type: 'authorization_code', code: fresh, redirect_uri: req.redirectUri, code_verifier: verifier }), basic('alexa-plus', c.clientSecret), NOW + 5, spent);
  assert.equal(r.status, 200);
  assert.equal(r.body.scope, USER_SCOPE);
  assert.deepEqual(accessOf(linked, String(r.body.access_token), NOW + 10), { scope: USER_SCOPE, household: hh });
  const again = issueToken(linked, new URLSearchParams({ grant_type: 'authorization_code', code: fresh, redirect_uri: req.redirectUri, code_verifier: verifier }), basic('alexa-plus', c.clientSecret), NOW + 6, spent);
  assert.equal(again.body.error, 'invalid_grant', 'a code works once');
  const late = issueCode(linked, req, hh, NOW);
  assert.equal(issueToken(linked, new URLSearchParams({ grant_type: 'authorization_code', code: late, redirect_uri: req.redirectUri, code_verifier: verifier }), basic('alexa-plus', c.clientSecret), NOW + 601, spent).body.error, 'invalid_grant', 'codes last ten minutes');
  const other = issueCode(linked, req, hh, NOW);
  assert.equal(issueToken(linked, new URLSearchParams({ grant_type: 'authorization_code', code: other, redirect_uri: 'https://evil.example.com/', code_verifier: verifier }), basic('alexa-plus', c.clientSecret), NOW + 5, spent).body.error, 'invalid_grant', 'the redirect URI must match');
  const refreshed = issueToken(linked, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(r.body.refresh_token) }), basic('alexa-plus', c.clientSecret), NOW + 7200, spent);
  assert.equal(accessOf(linked, String(refreshed.body.access_token), NOW + 7200)?.household, hh, 'a refresh keeps the household');
  assert.equal(issueToken(linked, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(r.body.access_token) }), basic('alexa-plus', c.clientSecret), NOW + 10, spent).body.error, 'invalid_grant', 'an access token is not a refresh token');
  assert.equal(issueToken(c, new URLSearchParams({ grant_type: 'authorization_code', code: fresh }), basic('alexa-plus', c.clientSecret), NOW, spent).body.error, 'unsupported_grant_type', 'no linking without redirect URIs');
});

test('a bad authorization request is shown, or sent back, never followed blindly', () => {
  assert.equal('error' in authorizeRequest(linked, query({ redirect_uri: 'https://evil.example.com/' })) && !('redirectUri' in authorizeRequest(linked, query({ redirect_uri: 'https://evil.example.com/' }))), true, 'an unregistered redirect URI is never redirected to');
  assert.equal((authorizeRequest(linked, query({ client_id: 'someone' })) as { error: string }).error, 'unauthorized_client');
  for (const [o, e] of [[{ code_challenge_method: 'plain' }, 'invalid_request'], [{ response_type: 'token' }, 'unsupported_response_type'], [{ scope: 'mcp:service' }, 'invalid_scope'], [{ resource: 'https://other/mcp' }, 'invalid_target']] as const) {
    const r = authorizeRequest(linked, query(o)) as { error: string; redirectUri?: string };
    assert.deepEqual([r.error, r.redirectUri], [e, 'https://alexa.example.com/link']);
  }
  assert.equal(redirectWith('https://alexa.example.com/link?x=1', { code: 'c', state: 's' }), 'https://alexa.example.com/link?x=1&code=c&state=s');
  const req = authorizeRequest(linked, query()) as AuthRequest;
  const t = formToken(linked, req, NOW);
  assert.ok(formOk(linked, req, t, NOW + 60));
  assert.ok(!formOk(linked, { ...req, redirectUri: 'https://evil.example.com/' }, t, NOW + 60), 'the form is bound to its request');
  assert.ok(!formOk(linked, req, t, NOW + 601), 'and lasts ten minutes');
});

test('household keys: random, forgiving to type, never stored; TV keys verify without storage', () => {
  const k = newHouseholdKey();
  assert.match(k, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}-[0-9A-HJKMNP-TV-Z]$/);
  assert.notEqual(newHouseholdKey(), k);
  assert.equal(householdOf(k.toLowerCase().replace(/-/g, ' ')), householdOf(k), 'case and spacing do not matter');
  assert.equal(householdOf(k.replace(/0/g, 'O')), householdOf(k), 'O reads as 0');
  assert.equal(householdOf('not a key'), null);
  const hh = householdOf(k)!;
  assert.equal(screenHousehold(linked, screenKey(linked, hh)), hh);
  assert.equal(screenHousehold(linked, `h.${hh}.forged`), null);
  assert.equal(screenHousehold({ ...linked, signingKey: 'x'.repeat(40) }, screenKey(linked, hh)), null, 'a new signing key revokes TV links too');
});
