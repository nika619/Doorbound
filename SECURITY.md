# Security

Departures runs in people's homes and hears about their children's mornings, so it is built to keep that to itself. This page walks a 19-point pre-launch checklist for apps built with AI help, item by item, with the code that backs each answer. "N/A" means the app has no such surface, and says why.

To report a problem, open a private security advisory on the GitHub repository rather than a public issue.

## What there is to protect

- **Data:** each household's routines (names and step lengths), the last 9 real durations per person and step, and today's departure. Stored in one JSON file on the server's own disk. No accounts, no email addresses, no payment details, no audio.
- **Surfaces:** `POST /mcp` (the tools Alexa+ calls), `GET /api/board` (state for a screen), `GET /board` (the board page, no data in it), `GET /` (a simulator, served only on the machine itself), `GET /healthz`.
- **Who may call:** Alexa+ with the bearer token you configure; screens with the screen key; anyone on the machine itself when it listens only on loopback.

## The checklist

| # | Item | Status | How |
|---|---|---|---|
| 1 | Row-level security | N/A | No database. One household per server, in one file: `src/server/store.ts`. |
| 2 | Auth on every route | Pass | `/mcp` checks the bearer token on every request, compared in constant time (SHA-256 both sides, then `timingSafeEqual`): `tokenMatches` in `src/server/guard.ts`. `/api/board` needs the screen key or the token whenever the server is reachable beyond loopback. The server **refuses to start** on a non-loopback address without a token of 32+ characters and an allow-list of host names: `src/server/main.ts`, configuration block. `/board` is a page with no data in it; the data comes from `/api/board`. |
| 3 | Never trust the front end | Pass | Every tool input is a schema with bounds (`zod`, `src/server/tools.ts`). People are matched by name against the household, never taken as ids. The server computes every plan and every chance; the board only displays them. The file on disk is treated as input too and validated on load; a file that fails is set aside, never silently used or deleted (`Store.open`). |
| 4 | Rate limiting | Pass | Token buckets per client: MCP 20/s (burst 40), board data 5/s (burst 10), pages 5/s (burst 20). The client map is capped (10,000, least recently seen evicted), so the limiter cannot be used to exhaust memory: `RateLimiter` in `src/server/guard.ts`. Behind a proxy, `TRUST_PROXY=1` keys on the forwarded address. |
| 5 | Sanitize user input | Pass | Length and shape limits on every string and number (`LIMITS` in `src/server/store.ts`: 8 people, 15 steps, 32-character names). The board writes text with `textContent` only, never `innerHTML` (`src/board/board.ts`), so a name cannot become markup. |
| 6 | Parameterized queries | N/A | No SQL or other query language. |
| 7 | Lock down CORS | Pass | No CORS headers are sent at all, so browsers block cross-origin reads. `/mcp` also validates `Host` and `Origin` (DNS-rebinding protection) with the MCP SDK's validators: loopback names only when local, the configured allow-lists otherwise. Checked by `npm run smoke` (a foreign Origin gets 403). |
| 8 | Force HTTPS | Pass when deployed as documented | Alexa+ reaches the server over HTTPS through a TLS-terminating proxy or tunnel. With `TRUST_PROXY=1` and `X-Forwarded-Proto: https`, the server sends HSTS (`baseHeaders`). On loopback (development) it speaks plain HTTP to the machine itself only. |
| 9 | IDOR | Pass | Clients never name objects by id. A tool says "Isha is done"; the server finds Isha in its own household and her current step in its own state. There is one household per server, so there is no other household's data to reach. |
| 10 | Debug off in production | Pass | Errors reach the client as "Something went wrong." with no stack or detail; the log gets the message only (`src/server/main.ts`). Tool failures are plain sentences that say what to do instead. The simulator, a development tool, is served only on loopback. |
| 11 | CAPTCHA on public forms | N/A | No public forms. Nothing unauthenticated writes data or sends mail. |
| 12 | Log admin actions | Pass | Append-only audit of every change: time, tool, outcome, the person concerned, and a hashed client address. Never arguments beyond the person, never a credential. Rotated at 1 MB so it stays bounded: `src/server/audit.ts`. |
| 13 | Private storage | Pass | The data directory is created `0700` and files are written `0600`. Writes are atomic (write, then rename) and coalesced, so a crash never leaves half a file (`Store.save`). No uploads, no downloads, no public buckets. |
| 14 | Hide admin pages properly | N/A | No admin pages. The only privileged page, the simulator, is not served beyond loopback at all. |
| 15 | Update vulnerable packages | Pass | `npm audit`: 0 vulnerabilities (Oct 15, 2026). Five runtime dependencies (the MCP SDK packages and zod), versions locked in `package-lock.json`. |
| 16 | File upload types | N/A | No file uploads. |
| 17 | AI security review | Pass | Claude reviewed the server code route by route while writing this page (Oct 15, 2026) and found nothing beyond what this table lists. A complement to items 1-16, not a substitute. |
| 18 | Security headers | Pass | Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `-Resource-Policy: same-origin`, a `Permissions-Policy` that turns off camera, location, microphone, payment and USB (`baseHeaders`). Pages add a hash-only Content Security Policy: `default-src 'none'`, scripts and styles allowed only by the SHA-256 of the exact blocks built into the page, no `unsafe-inline`, no framing (`pageCsp`; hashes from `scripts/build.mjs`). Checked by `npm run smoke`. |
| 19 | Verify webhook signatures | N/A | No webhooks. |

## Beyond the checklist

- **Secrets** live only in environment variables. `.env` and the data directory are git-ignored; nothing secret is in the repository or in any page.
- **Resource limits:** request bodies over 64 KB are refused before parsing (413); headers time out at 10 s and requests at 15 s; at most 64 headers. A re-plan is bounded by a search budget (20,000 plans, then a greedy stand-in), so a large household cannot make one request run long.
- **The screen:** it reads state and, on a touch screen inside Alexa+, can mark a step done with two taps (so a brush against the screen does nothing). A TV is read-only.
- **Privacy by design:** no audio is stored or processed here (Alexa+ turns speech into tool calls); the only personal data is first names and how long steps take.
