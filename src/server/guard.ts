// Request guards: authentication, rate limiting, body size and security headers.
// Each is small, O(1) per request, and bounded in memory.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------- authentication ----------

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison of a presented bearer token with the expected one. Hashing first makes lengths equal. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

// ---------- rate limiting ----------

/**
 * Token bucket per client. Refills continuously; O(1) per check.
 * The client map is capped: when full, the least recently seen client is evicted (Map keeps insertion order).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly maxClients = 10_000,
  ) {}

  /** Returns 0 if allowed, else the seconds to wait. */
  take(client: string, nowMs: number): number {
    let b = this.buckets.get(client);
    if (b) this.buckets.delete(client); // re-insert below: most recent goes last
    else {
      b = { tokens: this.burst, at: nowMs };
      if (this.buckets.size >= this.maxClients) this.buckets.delete(this.buckets.keys().next().value!);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((nowMs - b.at) / 1000) * this.perSecond);
    b.at = nowMs;
    this.buckets.set(client, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / this.perSecond);
  }

  get size() {
    return this.buckets.size;
  }
}

// ---------- request body ----------

export class BodyTooLarge extends Error {}

/** Read a request body up to `limit` bytes; rejects as soon as the limit is passed, without buffering the rest. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new BodyTooLarge());
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, size)));
    req.on('error', reject);
  });
}

// ---------- headers ----------

export interface PageHashes {
  scripts: string[];
  styles: string[];
}

/** Headers sent on every response. */
export function baseHeaders(res: ServerResponse, https: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * A strict Content Security Policy for one of our single-file pages: nothing loads from anywhere,
 * and only the exact inline script and style blocks built into the page may run (by hash).
 */
export function pageCsp(hashes: PageHashes, opts: { microphone?: boolean } = {}): Record<string, string> {
  const h = (list: string[]) => list.map((x) => `'sha256-${x}'`).join(' ');
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src ${h(hashes.scripts)}`,
      `style-src ${h(hashes.styles)}`,
      'font-src data:',
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    ...(opts.microphone ? { 'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self), payment=(), usb=()' } : {}),
  };
}

/** The client address, honouring a reverse proxy only when told to. */
export function clientOf(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';
