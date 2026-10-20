// The account-linking pages a person sees in the Alexa app when they link Doorbound: start a new household
// or join one with its key, and, for a new household, the key itself, shown once. Plain HTML, no script,
// one hashed stylesheet, never framed.

import { createHash } from 'node:crypto';
import type { AuthRequest } from './oauth.ts';

const CSS =
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0c0a;color:#f3ede2;font:16px/1.5 system-ui,sans-serif}' +
  'main{width:min(420px,100% - 32px);padding:32px 0}h1{font-size:28px;line-height:1.15;margin:0 0 8px}p{color:#b9b1a4}' +
  'button,input{font:inherit;border-radius:10px;padding:12px 16px;width:100%;box-sizing:border-box}' +
  'button{background:#ffb547;color:#14120f;border:0;font-weight:700;margin:8px 0;cursor:pointer}button.q{background:#1c1a17;color:#f3ede2;border:1px solid #3a352d}' +
  'button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #8fdcaa;outline-offset:2px}' +
  'input{background:#1c1a17;color:#f3ede2;border:1px solid #3a352d;letter-spacing:.06em}label{display:block;margin:16px 0 6px;color:#f3ede2}' +
  '.k{font:700 22px/1.4 ui-monospace,monospace;letter-spacing:.06em;color:#ffb547;background:#1c1a17;padding:16px;border-radius:10px;text-align:center;word-break:break-all}' +
  '.e{color:#ff6b4a}hr{border:0;border-top:1px solid #2a2620;margin:24px 0}' +
  'a.b{display:block;text-align:center;text-decoration:none;background:#ffb547;color:#14120f;font-weight:700;padding:12px;border-radius:10px;margin-top:16px}';

/** Headers for these pages: only our stylesheet, forms only to us (and, after them, the redirect back to Alexa+). */
export function linkHeaders(redirectUris: readonly string[]): Record<string, string> {
  const back = [...new Set(redirectUris.map((u) => new URL(u).origin))].join(' ');
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(CSS).digest('base64')}'; form-action 'self' ${back}; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Doorbound</title><style>${CSS}</style><main>${body}</main></html>`;

/** Start a new household, or join one with its key. The request rides along in hidden fields, signed by `t`. */
export function consentPage(r: AuthRequest, t: string, error = ''): string {
  const hidden = Object.entries({ client_id: r.clientId, redirect_uri: r.redirectUri, state: r.state, code_challenge: r.codeChallenge, code_challenge_method: 'S256', response_type: 'code', t })
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join('');
  return page(
    'Link Doorbound',
    `<h1>Link Doorbound to Alexa</h1><p>Alexa will plan your household's mornings with Doorbound: who is doing what, and everyone's chance of leaving on time.</p>` +
      `<form method="post">${hidden}<button name="action" value="new">Start a new household</button>` +
      `<hr><label for="key">Already have a household? Enter its key</label><input id="key" name="key" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X">` +
      (error ? `<p class="e" role="alert">${esc(error)}</p>` : '') +
      `<button class="q" name="action" value="join">Join that household</button></form>`,
  );
}

/** A new household's key, shown once, then on to Alexa+. */
export const keyPage = (key: string, continueUrl: string) =>
  page(
    'Your household key',
    `<h1>Your household key</h1><div class="k">${esc(key)}</div><p>Write it down. It links another Alexa account, such as a partner's, to this same household, or links this one again later. Doorbound keeps only a fingerprint of it and cannot show it again.</p>` +
      `<a class="b" href="${esc(continueUrl)}">Continue to Alexa</a>`,
  );
