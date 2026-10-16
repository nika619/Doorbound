// OAuth 2.1 client credentials: how Alexa+ signs in to a private MCP server (its "Tier 1", service-level
// auth). Alexa+ is registered with a client id and secret; it trades them at /oauth/token for a Bearer
// token (scope mcp:service, at most an hour) and sends that on every MCP request.
//
// Tokens are stateless: an HMAC over {audience, scope, expiry} with a key derived from the client secret,
// so they survive restarts, and rotating the secret revokes every token at once. Errors follow RFC 6749
// section 5.2; the token is bound to this server's MCP URL (RFC 8707 resource indicators); discovery is
// RFC 8414 (authorization server) and RFC 9728 (protected resource).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { tokenMatches } from './guard.ts';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** The server's public origin, for example https://doorbound.example.com (no path, no trailing slash). */
  publicUrl: string;
}

export const SCOPE = 'mcp:service';
/** Alexa+ asks for an hour or less; it fetches a new token by itself when one expires. */
export const TOKEN_TTL_SEC = 3600;
const PREFIX = 'db1';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const keyOf = (c: OAuthConfig) => createHmac('sha256', c.clientSecret).update('doorbound access token v1').digest();
const sign = (c: OAuthConfig, payload: string) => createHmac('sha256', keyOf(c)).update(payload).digest();
export const resourceOf = (c: OAuthConfig) => `${c.publicUrl}/mcp`;

export const authorizationServerMetadata = (c: OAuthConfig) => ({
  issuer: c.publicUrl,
  token_endpoint: `${c.publicUrl}/oauth/token`,
  grant_types_supported: ['client_credentials'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  scopes_supported: [SCOPE],
  response_types_supported: [], // no authorization endpoint: nothing is sent to a browser
});

export const protectedResourceMetadata = (c: OAuthConfig) => ({
  resource: resourceOf(c),
  authorization_servers: [c.publicUrl],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Doorbound',
});

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

/** The token endpoint: a form body and the Authorization header in, an RFC 6749 reply out. */
export function issueToken(c: OAuthConfig, form: URLSearchParams, authorization: string | undefined, nowSec: number): TokenReply {
  const client = clientOf(form, authorization);
  if (client.both) return error(400, 'invalid_request', 'Send the client credentials one way only.');
  // Both compared in constant time, and both always compared, so timing says nothing about which was wrong.
  const idOk = tokenMatches(client.id, c.clientId);
  const secretOk = tokenMatches(client.secret, c.clientSecret);
  if (!idOk || !secretOk) return error(401, 'invalid_client', 'Unknown client or wrong secret.', { 'WWW-Authenticate': 'Basic realm="doorbound"' });
  if (form.get('grant_type') !== 'client_credentials') return error(400, 'unsupported_grant_type', 'Only client_credentials is supported.');
  const resource = form.get('resource')?.replace(/\/$/, '');
  if (resource !== resourceOf(c)) return error(400, 'invalid_target', `resource must be ${resourceOf(c)}.`);
  const scopes = (form.get('scope') ?? SCOPE).split(' ').filter(Boolean);
  if (!scopes.length || scopes.some((s) => s !== SCOPE)) return error(400, 'invalid_scope', `The only scope is ${SCOPE}.`);
  const payload = b64url(JSON.stringify({ aud: resourceOf(c), scope: SCOPE, exp: Math.floor(nowSec) + TOKEN_TTL_SEC }));
  return { status: 200, body: { access_token: `${PREFIX}.${payload}.${b64url(sign(c, payload))}`, token_type: 'Bearer', expires_in: TOKEN_TTL_SEC, scope: SCOPE } };
}

/** A Bearer token this server issued, for this server, not expired. Constant time on the signature. */
export function verifyAccessToken(c: OAuthConfig, token: string | undefined, nowSec: number): boolean {
  const parts = token?.split('.');
  if (!parts || parts.length !== 3 || parts[0] !== PREFIX) return false;
  const expected = sign(c, parts[1]);
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { aud?: string; scope?: string; exp?: number };
    return claims.aud === resourceOf(c) && claims.scope === SCOPE && typeof claims.exp === 'number' && claims.exp > nowSec;
  } catch {
    return false;
  }
}
