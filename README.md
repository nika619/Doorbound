# Doorbound

[![CI](https://github.com/nika619/Doorbound/actions/workflows/ci.yml/badge.svg)](https://github.com/nika619/Doorbound/actions/workflows/ci.yml) ![MIT licence](https://img.shields.io/badge/licence-MIT-ffb547) ![MCP 2025-11-25](https://img.shields.io/badge/MCP-2025--11--25-ffb547)

*Every morning is a departure.*

**The household's morning, as a live departure board on Alexa+.** Who is doing what, each person's real chance of making the door on time, and a new plan the moment someone slips.

![The board re-routing live: an amber scan crosses the runway, Isha's bag lifts out of her lane and lands in Dad's, and her chance climbs back](docs/reroute.gif)

> "Alexa, start the school run. We leave in 40 minutes."
> "I'm done with breakfast."
> "Isha's still in the shower. Ten more minutes, she says."
> **Alexa:** "Re-routed: Isha has breakfast to go and Dad takes over pack bag for Isha. Everyone still leaves at 7:52, and Isha is back on track, with about a 9 in 10 chance."

Built for the Build, Ship, Shape: Amazon Developer Hackathon, Alexa+ track: an MCP server over Streamable HTTP (2025-11-25) whose board is an MCP App.

## Doorbound in 60 seconds

- **Honest chances, proven:** when it says 85%, about 85% happen, on simulated mornings and on mornings built to break its assumptions; it keeps score of itself on yours.
- **An exact re-plan:** the gentlest changes the household allowed, checked against brute force on 1,000 mornings.
- **Real mornings:** one bathroom, slow starts, weekday habits, a family that always underestimates, alarms for tomorrow, the journey to school, the front door saying when you left.
- **One add-on for every household:** Alexa+ account linking (OAuth with PKCE), each household kept apart, deletion by voice, idle data removed.
- **Built to be checked:** 95 tests, an end-to-end smoke test, the official MCP conformance suite and an Echo Show screen check, all in CI with the locked-down container and the AWS template.

**Try it in a minute:**

```bash
npm ci && npm run build && npm start
```

Then open http://localhost:3939 for the story, http://localhost:3939/sim to talk to it as Alexa+ would, or http://localhost:3939/board#replay for the board replaying a morning.

## The problem

Nearly every household has a daily departure: school, work, the bus. And people misjudge how long things take, even things they do every day. This is the planning fallacy: in Buehler, Griffin and Ross (1994), only about 30% of students finished by the time they had predicted. Five people's mornings make it worse, because one person's overrun lands on everyone else.

The usual tools are a timer per task or a checklist per person. Neither knows that Isha's eight-minute shower takes twelve, and neither can tell you, at 7:26 with a shower still running, whether the family will make 7:52, or what to change so it does.

## What it does

- **A board for the kitchen screen.** One row per person in split-flap letters: what they are doing, what is next, a status (ON TIME, TIGHT, DELAYED), their chance of being ready by the gate drawn as a live curve (the filled part is before the gate), and the time they will be ready by. Below, a runway: everyone's remaining steps laid out to the gate, with a soft tail showing how late it could realistically run.
- **It learns.** Every "I'm done" is a real duration. After a few mornings the plan uses what actually happens, not what was said ("Isha's shower takes *12 minutes*, not 8").
- **It re-plans within the household's rules.** When someone falls behind, it finds the gentlest set of changes the household allows: a quicker version (breakfast to go), someone else takes a step (Dad packs the bag), a step waits until after leaving (the dishwasher), or is skipped. Alexa says what changed; one word undoes it.
- **It notices a slow morning.** One person's steps share today's pace, so a long shower stretches the rest of their plan ("SLOW TODAY +20%"); if a household's mornings run slow together, it learns that too and lets one person's pace inform everyone's.
- **The evening before.** "We leave at 7:40 tomorrow, when should everyone be up?" It works back to each person's latest start for an 85% chance together, with the most sleep in total, and offers to set alarms.
- **It keeps score of itself.** Every chance it gives is checked against what happened; "How accurate have you been?" answers from your own mornings. [PILOT.md](PILOT.md) runs five real mornings and prints the report.
- **Works with the rest of the house.** "We need to be at school by 8:15, it's a 20-minute drive": Alexa+ can take the time from the calendar and the journey from traffic, and Doorbound works back to the leave time, allowing for traffic at the same 85% as everything else. It offers Alexa reminders and alarms (Alexa's own, which can speak first), and a front-door sensor, smart lock or Ring routine can post to the household's private door link to say the household has left, so each morning is scored by when the door really opened.
- **Anyone, from anywhere.** "I'm done." "She's still in the shower." "We need to leave ten minutes early." "How are we doing?" "Dad can pack Isha's bag." Set up and run entirely by voice; each sentence is one tool call.
- **On the Echo Show and beyond.** A small card inside the conversation, and the full board on a tap. For an always-on kitchen display, open the household's private TV link ("Alexa, put the board on the TV") in the Echo Show's browser, a tablet or a TV: it keeps the screen awake while a departure runs and catches up the moment it is shown again. Checked at Echo Show 5, 8, 10, 15 and 21 sizes (`npm run screens`: nothing scrolls, runs off or is set below 12 px). `/board#replay` plays the demo morning in the browser with no server state at all.

![Before the news: the board has already noticed Isha's shower running long and marks her TIGHT](docs/board-tight.jpg)

![Alexa's inline card inside the conversation: each person's chance at a glance](docs/card.jpg)

## The maths, in brief

The demo household (Aarav, Isha, Dad) and its "learned" history are illustrative, not measured; the board says so in its replay. Everything the board and Alexa say comes from one model ([docs/MATHS.md](docs/MATHS.md) has every formula and proof):

1. **Each step is a distribution**, log-normal, learned from real mornings with what was said as the prior, and with the predictive spread, since a learned time is itself uncertain.
2. **A morning is a sum of steps** (Fenton–Wilkinson), so each person's chance of making the door is closed-form, and a step under way keeps a realistic remainder.
3. **A slow morning is slow all through:** a person's steps share today's pace, updated exactly from each finished step and from the step still running; households, weekdays and a household's own planning fallacy are learned too.
4. **One bathroom:** shared spaces are queued live and anticipated ahead, so the chance stays honest before the queue forms.
5. **The re-plan is exact:** the cheapest set of allowed changes that gets everyone out at 85%, checked against brute force.

**How we know it is right** (all in `npm test`): calibrated on 40,000 simulated mornings (when it says 80–90%, 84.9% happen; error 0.39%); still honest on mornings that break its assumptions (heavy tails, other shapes, people who underestimate, late taps: 1.1% to 3.1%, 6.7% cautious with late taps); the re-plan equals the brute-force optimum on 1,000 random mornings; every posterior matches numerical integration. Details and the rest in [docs/MATHS.md](docs/MATHS.md).

![The story page: her chance falls, the search tries the gentlest fixes, and the cheapest that works wins](docs/story-replan.jpg)

## Measured

On a Windows 11 laptop, Node 24 (`tsx scripts/bench.ts`, and `tsx scripts/bench.ts load` against a running server):

| | p50 | p95 | worst |
|---|---|---|---|
| Re-plan, 2,000 random mornings (1-5 people) | 0.19 ms | 7.8 ms | 19.4 ms |
| Re-plan, a household at the limits (8 people × 15 steps, 1,200 candidate changes) | 54 ms | 59 ms | 67 ms |
| The board's work each second (3 people, today's pace included) | 11 µs | 18 µs | |
| Board poll under load: 300 screens + 30 speakers for 20 s | 1.5 ms | 5.3 ms | 84 ms |
| Tool call under the same load | 4.1 ms | 6.5 ms | 9.5 ms |
| Memory of one running server (one household) | about 72 MB | | |

Zero errors in the load test. Pushed to 2,000 screens, one process served about 1,830 requests a second (load generator on the same laptop; poll p95 20 ms), still with no errors. Re-measured on Oct 16, 2026, after the pace model went in. A household needs a few requests a second. An unchanged poll is answered with an empty 204; the board page is one 85 kB (gzipped) file with no external requests, and the story page, with the whole board inside it, is 176 kB.

## Run it

On real Alexa+ (Amazon's MCP toolkit, with sign-in and the listing ready): see [ALEXA.md](ALEXA.md). For a few real mornings at home: [PILOT.md](PILOT.md).

Needs Node 20 or later.

```bash
npm install
```

```bash
npm run demo
```

- http://localhost:3939 is **the story**: a scroll story of the problem, the maths and the re-plan, every curve computed in the page by the same core the server runs, with the live board on a wall-mounted Echo Show.
- http://localhost:3939/sim is **the Alexa+ simulator**: the Echo Show on the wall, the conversation as subtitles, speaker avatars and a mic, and a drawer with every MCP message. Press **Play the morning** for the scripted morning (about 90 seconds on a 20× demo clock), or talk to it. The demo resets to the same household on every start.
- http://localhost:3939/board is the board on its own, as a TV would show it.

For a real household, `npm start` (no demo clock, empty household: tell it your routines).

![The simulator: the Echo Show on the wall, Alexa's answer as a subtitle, the demo morning's timeline and the dock](docs/simulator.jpg)

## Deploy it

An Alexa+ add-on talks to a self-hosted MCP server over Streamable HTTP, so Doorbound has to be reachable over HTTPS. With Docker, one command does it, certificate included:

```bash
DOMAIN=doorbound.example.com AUTH_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

For Alexa+, add `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` and follow [ALEXA.md](ALEXA.md): Alexa+ signs in with OAuth client credentials, which the server issues itself (one-hour, signed, bound to its own `/mcp`), then calls `https://doorbound.example.com/mcp`. Add `OAUTH_REDIRECT_URIS` and the same server serves every household that links it: each Alexa account links to one household (start a new one, or join with its key), and each household's data lives apart. [`compose.yaml`](compose.yaml) runs the server read-only, with every Linux capability dropped, no new privileges, a 256 MB memory cap and a volume for the household, behind Caddy, which fetches and renews the certificate. The [`Dockerfile`](Dockerfile) builds in one stage and ships only Node and `dist/` (the pages and the server bundled into one 0.9 MB file): no sources, no `node_modules`, no npm, running as the `node` user. One process of about 80 MB serves many households, each in its own folder, opened when used.

**On AWS, for every household:** [`deploy/aws/doorbound.yaml`](deploy/aws/doorbound.yaml) is one CloudFormation stack: a small Graviton instance (t4g.small by default) running the same locked-down container behind Caddy, tokens in Secrets Manager (read at boot, never in the instance's user data), no SSH (Systems Manager instead), IMDSv2 only, an encrypted disk kept on termination, and a daily snapshot kept for a week. Give it the domain, the tokens and Alexa+'s redirect URLs; point the domain at the `PublicIp` output; register the `McpUrl` output with Alexa+. Families never host anything: they link Doorbound in the Alexa app. At AWS's on-demand list prices that is roughly $18 a month (instance, disk, public IPv4, secret; check current prices for your region). One process served about 1,830 requests a second on our laptop, and an open board asks once a second (mostly an empty 204), so one small instance should hold hundreds of households' boards at once; measure on yours with `tsx scripts/bench.ts load`. CI runs AWS's `cfn-lint` on the template; we have not deployed it ourselves.

Without Docker, `npm start` behind any HTTPS proxy or tunnel, with these set:

| Variable | What it does |
|---|---|
| `HOST` | Address to listen on. Anything other than loopback requires the next two. |
| `AUTH_TOKEN` | A fixed bearer token for your own tools and scripts (32+ characters). |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | How Alexa+ signs in (secret 32+ characters): it trades them at `/oauth/token` for a one-hour token. Rotating the secret revokes every token. |
| `PUBLIC_URL` | The https origin Alexa+ calls, for example `https://doorbound.example.com`; tokens are bound to its `/mcp`. |
| `OAUTH_REDIRECT_URIS` | Turns on account linking: one server, many households. The redirect URLs Alexa+ gives (exact match). Without it, the server is one household's. |
| `HOUSEHOLD_RETENTION_DAYS` | A linked household nobody has changed for this many days is deleted (default 180, from 30 to 3650). |
| `ALLOWED_HOSTS` | Host names clients will use (DNS-rebinding protection). |
| `ALLOWED_ORIGINS` | Origins allowed to call `/mcp` from a browser, if any. |
| `SCREEN_KEY` | Key a TV presents to read the board: open `https://your-host/board#k=SCREEN_KEY` (the fragment never reaches a server log). |
| `TRUST_PROXY=1` | Behind a proxy: rate-limit by the forwarded address, send HSTS over HTTPS. |
| `DATA_DIR` | Where the household file and audit log live (default `data/`). |

The MCP endpoint is `/mcp`; the board is the resource `ui://doorbound/board.html`.

## Check it

```bash
npm test
```

73 tests: the statistics against simulation, today's pace and the household's, the departure model, the re-planner (brute force and properties), learning, storage, the security guards, the speech of a whole morning through the real tools, and our 2 kB MCP Apps bridge against the official host-side `AppBridge`.

```bash
npm run smoke
```

Against a running server (18 checks, 20 with OAuth on): both protocol versions, every tool's schema, the MCP App resource, a morning with a re-route and undo, the HTTP edges (foreign Origin 403, 64 kB cap, hash-only CSP on the board and the story page). It passes against `node dist/server.mjs` started from outside the project, which is what the container runs.

```bash
npm run conformance
```

The official MCP conformance suite (`@modelcontextprotocol/conformance` 0.1.16) against a running server, paced under its rate limit: initialize, ping, tools/list, resources/list, both DNS-rebinding checks and the SSE scenarios pass. The others need the suite's own fixture server or features Doorbound does not offer (prompts, logging, completion), which it correctly answers with "method not found".

```bash
npm run typecheck
```

On GitHub, CI runs all of this on every push (Node 22 and 24), runs the conformance suite, then builds the Docker image, checks it refuses to start without a token, and runs the smoke test, OAuth sign-in included, against the container running read-only with every capability dropped. Dependabot checks the dependencies weekly.

## How it is built

```
src/core/     the model: statistics, learning, the departure, the re-planner (pure functions, no I/O)
src/server/   the MCP server, tools, storage, audit log, HTTP guards
src/board/    the board (an MCP App), and its 2 kB bridge to the host
src/site/     the story page: scroll scenes drawn from the core, the board replaying inside
src/sim/      the Alexa+ simulator and the small router that stands in for Alexa's language model
scripts/      build (pages and the server bundle), smoke test, benchmark, screenshots, one-turn client
Dockerfile, compose.yaml   the container and the one-command HTTPS deployment
```

- **The server holds the clock and the state; screens hold nothing.** Every screen derives the board from the same core functions and the server's time, so an Echo Show and a TV agree to the second.
- **One tool per thing a household says**, each with an output schema, plain speakable text, and error results that say what to say instead (Amazon's add-on design guide).
- **The board is one self-contained HTML file** (fonts inlined), served with a hash-only Content Security Policy. It builds its DOM once and then changes only what moved: one transform per frame, text once a second.

## Design

- **From the object itself.** An airport departure board, read from across a kitchen: amber on warm black, split-flap letters, one row per traveller. A soft spotlight and film grain keep it from looking like a spreadsheet.
- **Two voices of type.** Bold condensed capitals for the facts, an italic serif for the one word that carries the feeling ("The *school run*", "*Re-routed.*", "takes *12 minutes*"), Barlow for everything else. All three under the SIL Open Font License.
- **Motion with a job.** Real split-flaps: the old top half falls, the new bottom half swings in and settles. A re-route is choreographed: an amber scan crosses the runway, the rows it touches light up, the handed-over step lifts out of one lane and arcs into another, the chance counts up. A change of standing sweeps the row in its new colour. Words arrive one by one (blur to sharp, 60 ms apart, expo-out). Nothing loops for decoration, and reduced motion turns it all off.
- **A story, not a brochure.** The page at `/` is a scroll story in the genre of cinematic product sites: pinned stages, one idea per beat, a progress hairline and a numbered rail, one hard colour block, a giant outlined wordmark. Its hero object is the product itself, replaying live on a wall-mounted Echo Show, and every chart in it is the real model, not an illustration.
- **Calm by default.** Sound (a flap clatter, a chime on a re-route) is off until someone switches it on. The minutes left sit behind everything as a faint outline, not a flashing countdown.
- **Readable by everyone.** Text contrast at least 4.5:1 (3:1 for large labels), measured; real buttons with focus rings and names that say whose step they mark; a screen-reader sentence per row and spoken updates; nothing told by colour alone.

## Security

The server refuses to start beyond loopback without a token and a host allow-list, compares tokens in constant time, rate-limits every client, validates every input and the file on disk, caps bodies at 64 kB, keeps an append-only audit log, and serves pages under a hash-only CSP. [SECURITY.md](SECURITY.md) walks a 19-point checklist item by item against the code.

## Limits, honestly

- A household's shared pace (κ) starts at 0 and is used only once its own mornings show it. A whole house that oversleeps simply starts later, which the board sees at once.
- ρ starts at 0.3 by assumption and is learned from the household's own mornings; the step in progress is tied to the pace to first order (the delta method), exact at its start.
- Fenton–Wilkinson is an approximation; the tests bound its error, they do not make it exact.
- It learns from the last nine mornings per person and step; one strange morning moves it, a few correct it.
- The simulator's router is a small rule set standing in for Alexa+'s language model, which in Alexa+ reads the tool descriptions itself.
- Tested in browsers and the simulator, not on an Echo Show (we have no Amazon devices), and not yet deployed to Alexa+ itself: Amazon's add-on tools were partner-only when we checked ([ALEXA.md](ALEXA.md) has every step ready).
- The board is designed for households of up to eight.
- The Docker image and compose file have not been built here (no Docker on the development machine); the bundle they run is tested directly. Memory was measured on Windows.

## License

MIT. See [LICENSE](LICENSE).
