# Marquee

Say the occasion, and your TV or Echo Show becomes a live show that you run by voice.

> "It's Aarav's seventh birthday at five." … "Start the candle countdown." … "Cake time."

Marquee is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) with an MCP App that is the stage. It is an entry for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ track).

**Status: foundation.** The show clock, the MCP server, the stage view and a small test host work and are tested. The scene design system, the Alexa+ simulator, the Fire TV app and occasion memory are not built yet.

## How it works

- **A show** is a live scene plus a list of cues. A cue changes the scene after a delay, or when someone calls it by name.
- **The server holds the clock.** It stores timestamps, not timers. Every screen asks for the state about once a second, works out its offset from the server's clock, and draws the same moment. A cue that came due while no screen was looking still starts at its scheduled time.
- **Voice turns are tool calls.** An assistant calls `start_show`, `start_countdown`, `set_score`, `add_cue`, `fire_cue` or `control_show`. Each returns a plain sentence to speak and the live state to draw.
- **The stage is one HTML file.** Inside an MCP host it talks through the MCP Apps bridge; opened directly at `/stage` (a TV) it reads the same state over HTTP.

## Run it

Needs Node 20 or later.

```bash
npm install
```

```bash
npm start
```

Then open http://localhost:3939/ for the test host, or http://localhost:3939/stage for the bare stage.

## Check it

Unit tests for the show clock (no server needed):

```bash
npm test
```

End-to-end protocol check against the running server:

```bash
npm run smoke
```

A voice turn from "another device" while a screen is open:

```bash
npx tsx scripts/voice-turn.ts control_show '{"action":"pause"}'
```

## Verified and not verified

| Claim | Status |
|---|---|
| Negotiates MCP protocol 2025-11-25 over Streamable HTTP | Verified by `npm run smoke` |
| The same endpoint serves a client that negotiates the 2026-07-28 revision | Verified by `npm run smoke` |
| Refuses a request from a foreign Origin with 403 | Verified by `npm run smoke` |
| The stage renders from a `ui://` resource in a sandboxed iframe through the MCP Apps bridge | Verified by hand in Chromium, 13 Oct 2026 |
| A pause from a separate client reaches an open screen within about a second, and two screens agree | Measured once, on one machine, 13 Oct 2026: pause seen after 1.3 s, screen clock within 13 ms of the server, two screens 0 ms apart |
| Works in a real Alexa+ host | **Not verified.** No participant has access to one |
| Works on Fire TV | **Not verified.** No emulator image is installed yet |

## Licence

MIT. See `LICENSE`.
