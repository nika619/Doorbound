// OAuth 2.1 for Alexa+, both tiers.
//
// Tier 1, client credentials: Alexa+ itself signs in with a client id and secret and gets a service token
// (scope mcp:service). It can list tools and read the board's template, never a household's data.
// Tier 2, account linking (authorization code with PKCE S256): each Alexa account links to one household,
// and its token (scope "mcp:tools mcp:resources") carries that household as `sub`. A server with no
// redirect URIs configured is a single-household server: there the service token reaches its one household.
//
// Every token, code and refresh token is stateless: an HMAC over its claims with a key derived from the
// client secret, so they survive restarts and rotating the secret revokes them all. Codes last ten minutes and are
// spent on first use (remembered until they expire). Errors follow RFC 6749 section 5.2; tokens are bound to
// this server's MCP URL (RFC 8707); discovery is RFC 8414 and RFC 9728.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { tokenMatches } from './guard.ts';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Signs every token and key. The server's alone: Amazon holds the client secret, so it must not sign anything. */
  signingKey: string;
  /** The server's public origin, for example https://doorbound.example.com (no path, no trailing slash). */
  publicUrl: string;
  /** Where Alexa+ may be sent back to after linking (exact match). None: no account linking. */
  redirectUris?: string[];
}

export const SCOPE = 'mcp:service';
export const USER_SCOPE = 'mcp:tools mcp:resources';
/** Alexa+ asks for an hour or less; it fetches a new token by itself when one expires. */
export const TOKEN_TTL_SEC = 3600;
export const CODE_TTL_SEC = 600; // the linking page shows the household key first, and writing it down takes a while
export const REFRESH_TTL_SEC = 90 * 86_400;

export const linking = (c: OAuthConfig) => !!c.redirectUris?.length;
export const resourceOf = (c: OAuthConfig) => `${c.publicUrl}/mcp`;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const keyOf = (c: OAuthConfig) => createHmac('sha256', c.signingKey).update('doorbound access token v1').digest();

/** `kind.claims.signature`, the signature covering kind and claims, so one kind cannot pass for another. */
function seal(c: OAuthConfig, kind: string, claims: Record<string, unknown>): string {
  const payload = b64url(JSON.stringify(claims));
  return `${kind}.${payload}.${b64url(createHmac('sha256', keyOf(c)).update(`${kind}.${payload}`).digest())}`;
}

function unseal(c: OAuthConfig, kind: string, token: string | undefined, nowSec: number): Record<string, unknown> | null {
  const parts = token?.split('.');
  if (!parts || parts.length !== 3 || parts[0] !== kind) return null;
  const expected = createHmac('sha256', keyOf(c)).update(`${kind}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return claims.aud === resourceOf(c) && typeof claims.exp === 'number' && claims.exp > nowSec ? claims : null;
  } catch {
    return null;
  }
}

export const authorizationServerMetadata = (c: OAuthConfig) => ({
  issuer: c.publicUrl,
  token_endpoint: `${c.publicUrl}/oauth/token`,
  ...(linking(c) ? { authorization_endpoint: `${c.publicUrl}/oauth/authorize`, code_challenge_methods_supported: ['S256'] } : {}),
  grant_types_supported: linking(c) ? ['client_credentials', 'authorization_code', 'refresh_token'] : ['client_credentials'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  scopes_supported: linking(c) ? [SCOPE, ...USER_SCOPE.split(' ')] : [SCOPE],
  response_types_supported: linking(c) ? ['code'] : [], // without linking, nothing is sent to a browser
});

export const protectedResourceMetadata = (c: OAuthConfig) => ({
  resource: resourceOf(c),
  authorization_servers: [c.publicUrl],
  scopes_supported: linking(c) ? [SCOPE, ...USER_SCOPE.split(' ')] : [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Doorbound',
});

// ---------- households ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A household key: 128 random bits in Crockford base32, read out as groups of five. */
export function newHouseholdKey(): string {
  const bytes = randomBytes(16);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out.match(/.{1,5}/g)!.join('-');
}
/** The household a key opens: a hash, so the key itself is never stored. Null for anything not a key. */
export function householdOf(key: string): string | null {
  const k = key.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return k.length === 26 && [...k].every((ch) => CROCKFORD.includes(ch)) ? createHash('sha256').update(`doorbound household ${k}`).digest('hex').slice(0, 32) : null;
}

// ---------- tokens ----------

export interface Access {
  scope: string;
  /** The linked household; absent for Alexa's own service token. */
  household?: string;
  /** When it was issued (Unix seconds). */
  iat: number;
}

/** A Bearer token this server issued, for this server, not expired. Constant time on the signature. */
export function accessOf(c: OAuthConfig, token: string | undefined, nowSec: number): Access | null {
  const claims = unseal(c, 'db1', token, nowSec);
  if (!claims || typeof claims.scope !== 'string') return null;
  const iat = typeof claims.iat === 'number' ? claims.iat : 0;
  return typeof claims.sub === 'string' ? { scope: claims.scope, household: claims.sub, iat } : { scope: claims.scope, iat };
}
/** A refresh token's household and when it was issued, so a forgotten household's can be refused. */
export function refreshOf(c: OAuthConfig, token: string | undefined, nowSec: number): { household: string; iat: number } | null {
  const claims = unseal(c, 'dbr', token, nowSec);
  return claims && typeof claims.sub === 'string' ? { household: claims.sub, iat: typeof claims.iat === 'number' ? claims.iat : 0 } : null;
}
export const verifyAccessToken = (c: OAuthConfig, token: string | undefined, nowSec: number) => accessOf(c, token, nowSec) !== null;

const accessToken = (c: OAuthConfig, scope: string, nowSec: number, household?: string) =>
  seal(c, 'db1', { aud: resourceOf(c), scope, iat: Math.floor(nowSec), exp: Math.floor(nowSec) + TOKEN_TTL_SEC, ...(household ? { sub: household } : {}) });

// ---------- the authorization request (account linking) ----------

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Check what Alexa+ sent to /oauth/authorize. A bad client or redirect URI is shown on the page and never
 * redirected to (RFC 6749 4.1.2.1); anything else wrong goes back to the redirect URI as an error.
 */
export function authorizeRequest(c: OAuthConfig, q: URLSearchParams): AuthRequest | { error: string; description: string; redirectUri?: string; state?: string } {
  const redirectUri = q.get('redirect_uri') ?? '';
  if (!linking(c) || !tokenMatches(q.get('client_id') ?? '', c.clientId)) return { error: 'unauthorized_client', description: 'Unknown client.' };
  if (!c.redirectUris!.includes(redirectUri)) return { error: 'invalid_request', description: 'That redirect URI is not registered.' };
  const state = q.get('state') ?? '';
  const back = { redirectUri, state };
  if (q.get('response_type') !== 'code') return { error: 'unsupported_response_type', description: 'Only code is supported.', ...back };
  const codeChallenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return { error: 'invalid_request', description: 'PKCE with S256 is required.', ...back };
  const scope = (q.get('scope') ?? USER_SCOPE).split(' ').filter(Boolean);
  if (scope.some((s) => !USER_SCOPE.split(' ').includes(s))) return { error: 'invalid_scope', description: `Scopes: ${USER_SCOPE}.`, ...back };
  const resource = q.get('resource');
  if (resource && resource.replace(/\/$/, '') !== resourceOf(c)) return { error: 'invalid_target', description: `resource must be ${resourceOf(c)}.`, ...back };
  if (state.length > 512) return { error: 'invalid_request', description: 'state is too long.', ...back };
  return { clientId: c.clientId, redirectUri, state, codeChallenge };
}

/** A one-minute, single-use code for this household, bound to the client, redirect URI and PKCE challenge. */
export const issueCode = (c: OAuthConfig, r: AuthRequest, household: string, nowSec: number) =>
  seal(c, 'dbc', { aud: resourceOf(c), cid: r.clientId, ruri: r.redirectUri, cc: r.codeChallenge, sub: household, exp: Math.floor(nowSec) + CODE_TTL_SEC, jti: b64url(randomBytes(12)) });

/** Where to send the browser back to: the code (or error) and the state, on the registered redirect URI. */
export function redirectWith(redirectUri: string, params: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

/** A form the authorize page rendered, bound to its request, for ten minutes: a POST nobody rendered is refused. */
export const formToken = (c: OAuthConfig, r: AuthRequest, nowSec: number) => seal(c, 'dbf', { aud: resourceOf(c), r, exp: Math.floor(nowSec) + 600 });
export const formOk = (c: OAuthConfig, r: AuthRequest, token: string, nowSec: number) => {
  const claims = unseal(c, 'dbf', token, nowSec);
  return !!claims && JSON.stringify(claims.r) === JSON.stringify(r);
};

// ---------- the token endpoint ----------

export interface TokenReply {
  status: number;
  body: Record<string, string | number>;
  headers?: Record<string, string>;
}

const error = (status: number, code: string, description: string, headers?: Record<string, string>): TokenReply => ({ status, body: { error: code, error_description: description }, headers });

/** Client id and secret from HTTP Basic (form-encoded, per RFC 6749 2.3.1) or from the body; never both. */
function clientOf(form: URLSearchParams, authorization: string | undefined): { id?: string; secret?: string; both: boolean } {
  const inBody = form.has('client_id') || form.has('client_secret');
  if (authorization?.startsWith('Basic ')) {
    const raw = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
    const at = raw.indexOf(':');
    if (at < 0) return { both: inBody };
    try {
      return { id: decodeURIComponent(raw.slice(0, at).replace(/\+/g, ' ')), secret: decodeURIComponent(raw.slice(at + 1).replace(/\+/g, ' ')), both: inBody };
    } catch {
      return { both: inBody };
    }
  }
  return { id: form.get('client_id') ?? undefined, secret: form.get('client_secret') ?? undefined, both: false };
}

/** Codes already exchanged, until they would have expired anyway: a code works once. */
const SPENT = new Map<string, number>();

/** The token endpoint: a form body and the Authorization header in, an RFC 6749 reply out. */
export function issueToken(c: OAuthConfig, form: URLSearchParams, authorization: string | undefined, nowSec: number, spent = SPENT): TokenReply {
  const client = clientOf(form, authorization);
  if (client.both) return error(400, 'invalid_request', 'Send the client credentials one way only.');
  // Both compared in constant time, and both always compared, so timing says nothing about which was wrong.
  const idOk = tokenMatches(client.id, c.clientId);
  const secretOk = tokenMatches(client.secret, c.clientSecret);
  if (!idOk || !secretOk) return error(401, 'invalid_client', 'Unknown client or wrong secret.', { 'WWW-Authenticate': 'Basic realm="doorbound"' });
  const resource = form.get('resource')?.replace(/\/$/, '');
  const grant = form.get('grant_type');
  const user = (household: string) => ({
    status: 200,
    body: {
      access_token: accessToken(c, USER_SCOPE, nowSec, household),
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SEC,
      scope: USER_SCOPE,
      refresh_token: seal(c, 'dbr', { aud: resourceOf(c), sub: household, iat: Math.floor(nowSec), exp: Math.floor(nowSec) + REFRESH_TTL_SEC }),
    },
  });

  if (grant === 'client_credentials') {
    if (resource !== resourceOf(c)) return error(400, 'invalid_target', `resource must be ${resourceOf(c)}.`);
    const scopes = (form.get('scope') ?? SCOPE).split(' ').filter(Boolean);
    if (!scopes.length || scopes.some((s) => s !== SCOPE)) return error(400, 'invalid_scope', `The only scope for client credentials is ${SCOPE}.`);
    return { status: 200, body: { access_token: accessToken(c, SCOPE, nowSec), token_type: 'Bearer', expires_in: TOKEN_TTL_SEC, scope: SCOPE } };
  }
  if (grant === 'authorization_code' && linking(c)) {
    if (resource && resource !== resourceOf(c)) return error(400, 'invalid_target', `resource must be ${resourceOf(c)}.`);
    for (const [jti, exp] of spent) if (exp <= nowSec) spent.delete(jti);
    const code = unseal(c, 'dbc', form.get('code') ?? undefined, nowSec);
    if (!code || code.cid !== c.clientId || spent.has(String(code.jti))) return error(400, 'invalid_grant', 'The code is unknown, expired or already used.');
    spent.set(String(code.jti), Number(code.exp));
    if (form.get('redirect_uri') !== code.ruri) return error(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
    const verifier = form.get('code_verifier') ?? '';
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !tokenMatches(challenge, String(code.cc))) return error(400, 'invalid_grant', 'The PKCE code_verifier does not match.');
    return user(String(code.sub));
  }
  if (grant === 'refresh_token' && linking(c)) {
    const r = unseal(c, 'dbr', form.get('refresh_token') ?? undefined, nowSec);
    if (!r || typeof r.sub !== 'string') return error(400, 'invalid_grant', 'The refresh token is unknown or expired.');
    return user(r.sub);
  }
  return error(400, 'unsupported_grant_type', linking(c) ? 'Use client_credentials, authorization_code or refresh_token.' : 'Only client_credentials is supported.');
}

/**
 * A household's private keys: the household, a generation and a signature, so the server stores only the
 * generation. A TV link (h) and a door-hook key (k) are never interchangeable. Bumping the household's
 * generation retires every link handed out before; the caller checks it against the household's store.
 */
const linkKey = (c: OAuthConfig, kind: 'h' | 'k', household: string, gen: number) =>
  `${kind}.${household}.${gen}.${createHmac('sha256', keyOf(c)).update(`${kind === 'h' ? 'screen' : 'hook'}.${household}.${gen}`).digest('base64url')}`;
function linkOf(c: OAuthConfig, kind: 'h' | 'k', key: string): { household: string; gen: number } | null {
  const m = new RegExp(`^${kind}\\.([0-9a-f]{32})\\.(\\d{1,9})\\.`).exec(key);
  return m && tokenMatches(key, linkKey(c, kind, m[1], Number(m[2]))) ? { household: m[1], gen: Number(m[2]) } : null;
}
export const hookKey = (c: OAuthConfig, household: string, gen = 0) => linkKey(c, 'k', household, gen);
export const hookHousehold = (c: OAuthConfig, key: string) => linkOf(c, 'k', key);
export const screenKey = (c: OAuthConfig, household: string, gen = 0) => linkKey(c, 'h', household, gen);
export const screenHousehold = (c: OAuthConfig, key: string) => linkOf(c, 'h', key);
