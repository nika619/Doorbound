# Friction log

Kept from the first day of building. Each entry: the task, the steps, expected versus actual, severity, the workaround, and a suggestion. Only things that actually happened to us are listed.

Environment: Windows 11, Node 24.14, no Amazon devices.

---

## 1. Alexa+: finding a way to test an add-on

- **Date:** 13 Oct 2026
- **Task:** Find out how a hackathon participant runs an MCP add-on against Alexa+.
- **Steps:** Read the Alexa+ add-on docs home, the overview, the MCP Toolkit overview, "Set up your development environment", and "Test in the Web Simulator".
- **Expected:** A simulator or sandbox we could sign up for.
- **Actual:** The setup and testing pages read as if the tools are available. That they are partner-only is stated on the docs home page and in the hackathon FAQ, not on the pages a developer lands on from search.
- **Severity:** High. It decides the whole shape of a submission.
- **Workaround:** Built our own MCP host in a web page (a real MCP client plus the MCP Apps bridge).
- **Suggestion:** Put an access banner on every setup and testing page. Better, publish a minimal public host that behaves like the Alexa+ MCP client, so outside developers test against the same behaviour.

## 2. Alexa+: what an MCP App view is allowed to do

- **Date:** 13 Oct 2026
- **Task:** Decide whether a live, timed scene (a countdown) can run inside an add-on's view.
- **Steps:** Read "Alexa+ MCP Client and App Lifecycle", "The Conversation Surface", "Display Modes" and "Supported Capabilities".
- **Expected:** A statement of how long a view lives, whether it survives later turns, whether a later tool result reaches an open view, whether a view may play sound, and what its content security policy is.
- **Actual:** None of the four pages says. "Supported Capabilities" lists only authentication and account linking. The lifecycle page covers registration and the initialize payload, not the view.
- **Severity:** High. A design can be built that the platform then cannot run.
- **Workaround:** Designed to the minimum the MCP Apps specification guarantees: the server holds the clock, the view polls an app-only tool once a second, and nothing depends on sound or on a view staying open.
- **Suggestion:** One capability table: view lifetime, cross-turn updates, audio, timers, network policy, size limits, supported MCP Apps messages.

## 3. Alexa+: turn timing

- **Date:** 13 Oct 2026
- **Task:** Check whether an add-on can pace speech (count aloud, or speak at a set moment).
- **Steps:** Read "The Conversation Surface".
- **Expected:** Either a way to time speech, or a clear statement that there is none.
- **Actual:** The page says the model is turn-based and that the add-on influences speech through data. It does not say whether a view or a tool can trigger speech later, or whether Alexa's own timers can be set by an add-on.
- **Severity:** Medium.
- **Workaround:** Speech only at turn boundaries; all pacing on screen.
- **Suggestion:** State plainly what an add-on cannot do, with the recommended pattern for timed experiences.

## 4. Alexa+: tool design guidance stops short of numbers

- **Date:** 13 Oct 2026
- **Task:** Design tools to Amazon's guide before writing them.
- **Steps:** Read "Tools, Schema, and Data Design".
- **Expected:** Naming rules, a sensible number of tools, a latency budget, and how the spoken text relates to `structuredContent`.
- **Actual:** Good principles (one tool per intent, never return nothing, declare only what you honour) but no latency budget, no tool-count guidance and no example of a result that reads well aloud.
- **Severity:** Low.
- **Workaround:** Wrote each result's text as one plain sentence and tested it against a "no symbols" pattern.
- **Suggestion:** Add two worked examples of tool results, one good and one bad, with what Alexa says for each.

## 5. Fire TV: Vega on Windows

- **Date:** 13 Oct 2026
- **Task:** Set up for the Vega OS path on a Windows 11 PC.
- **Steps:** Read the Vega SDK install page for 0.24.
- **Expected:** Windows or WSL support.
- **Actual:** macOS and Ubuntu only; Windows and WSL are listed as unsupported and untested.
- **Severity:** High for anyone on Windows: the platform Amazon is moving to cannot be targeted at all.
- **Workaround:** Plan the TV app for Fire OS and an Android TV emulator.
- **Suggestion:** Support WSL2, or offer a hosted Vega Virtual Device.

## 6. Fire TV: what "the Fire TV simulator" is

- **Date:** 13 Oct 2026
- **Task:** Find the Fire TV simulator the rules mention.
- **Steps:** Searched the Fire TV docs; read the emulator guide and the Fire TV FAQ.
- **Expected:** A Fire OS image to download.
- **Actual:** There is none. The guidance is a generic Android TV image in Android Studio (API 30 to match Fire OS 8), and Amazon's own FAQ says emulators are not reliable for Fire TV testing.
- **Severity:** Medium.
- **Workaround:** None yet; the emulator image is not installed on our machine.
- **Suggestion:** Publish a Fire OS system image for the Android emulator.

## 7. Ring: finding the sandbox

- **Date:** 13 Oct 2026
- **Task:** Find the Ring sandbox with synthetic devices that "Getting Started" describes.
- **Steps:** Read "Getting Started", "Develop" and the first part of the API reference; searched the web for the Developer Playground.
- **Expected:** A page that says where the sandbox is and what it contains.
- **Actual:** "Getting Started" mentions a sandbox in its glossary and FAQ only. "Develop" describes testing with a real Ring account and says only US devices are supported. The Playground is named in the hackathon FAQ and the hello-world README, and what it contains (one doorbell, three sample streams, no motion webhooks) is written down only in a forum reply.
- **Severity:** Medium. It cost us the track decision.
- **Workaround:** Chose another track.
- **Suggestion:** A "Developer Playground" page: how to open it, what devices and events it has, and what it cannot do.

## 8. MCP SDK packages: two lines, mixed messages

- **Date:** 13 Oct 2026
- **Task:** Install the MCP server SDK and the MCP Apps SDK together.
- **Steps:** `npm view` on `@modelcontextprotocol/sdk` and `@modelcontextprotocol/ext-apps`; read their package metadata.
- **Expected:** The MCP Apps SDK to work with the package most guides name, `@modelcontextprotocol/sdk`.
- **Actual:** `ext-apps` 2.x has peer dependencies on the split 2.x packages (`server`, `client`, `core`), which implement a later protocol revision (2026-07-28) and serve 2025-11-25 clients as "legacy". The `ext-apps` licence is MIT on npm and Apache-2.0 on the repository badge.
- **Severity:** Low. Once known, it works well: one endpoint served both revisions in our tests.
- **Workaround:** Used the 2.x line throughout and tested the 2025-11-25 handshake explicitly.
- **Suggestion (for the hackathon pages):** Say which SDK line to use for "spec 2025-11-25 or later", since the current SDK defaults to a newer revision.

## 9. MCP Apps: messages sent before the view is ready vanish

- **Date:** 15 Oct 2026
- **Task:** Switch the board to fullscreen from the host as soon as it opens, the way an Echo Show would after "open the board".
- **Steps:** In our simulator, created the official host-side `AppBridge`, connected it to the board's frame, then sent a tool result and a `host-context-changed` with `displayMode: fullscreen`.
- **Expected:** Either the messages are queued until the view finishes `ui/initialize`, or the call fails loudly.
- **Actual:** The specification says a host must not message the view before `ui/notifications/initialized`, but nothing in the host-side API stopped or warned us: the board simply stayed in its inline card. We noticed it in a screenshot, then found the rule in the specification.
- **Severity:** Medium. The failure is silent and timing-dependent, so it can pass on a fast machine and fail on a device.
- **Workaround:** The simulator keeps a `ready` promise that settles on `initialized` and awaits it before every message.
- **Suggestion:** Have `AppBridge` queue host-to-view messages until the view is initialized, or reject them with a clear error.

## 10. MCP Apps: the view-side SDK is large for a kitchen screen

- **Date:** 15 Oct 2026
- **Task:** Keep the board small and fast on an Echo Show.
- **Steps:** Bundled the board with the official view-side `App` class from `@modelcontextprotocol/ext-apps`.
- **Expected:** A few kilobytes for a handshake, tool calls and display-mode requests.
- **Actual:** About 455 kB of script in the single-file board.
- **Severity:** Low.
- **Workaround:** Wrote a 2 kB view bridge with only the messages the board uses (`src/board/bridge.ts`), and a test that runs it against the official host-side `AppBridge` and a real MCP server, so it cannot drift from the specification unnoticed.
- **Suggestion:** Ship a minimal view-side entry point (handshake, `tools/call`, display mode, size changes) that tree-shakes to a few kilobytes.

---

## 11. Alexa+: the MCP authentication page contradicts itself

- **Date:** 16 Oct 2026
- **Task:** Make Doorbound sign Alexa+ in the way the MCP toolkit expects, so it could be deployed as a real add-on.
- **Steps:** Read "Authentication" (`/docs/alexaplus/add-ons/mcp-toolkit-authentication`), then the quickstart and the CLI reference for where the credentials go.
- **Expected:** One list of requirements for the token endpoint and the 401 response.
- **Actual:** The MUST list says to authenticate the client "via HTTP Basic Authentication"; the checklist on the same page allows "HTTP Basic or POST body credentials". The scopes are `mcp:resources` in one place and `mcp:resource` in the runtime table. The page says `WWW-Authenticate` in a 401 is unsupported, while the MCP 2025-11-25 authorization spec has clients discover the authorization server from exactly that header (`resource_metadata`). Nothing says whether a private server may skip auth.
- **Severity:** Medium. Each of these decides whether Alexa+ can sign in at all, and none can be tested without add-on access.
- **Workaround:** Implemented the strict reading of each: Basic or body (never both, never in the query), scope `mcp:service`, tokens of an hour or less, RFC 6749 errors, and both the `WWW-Authenticate` header and the RFC 9728 metadata, so either discovery path works. Tested end to end in CI.
- **Suggestion:** One normative requirements table per tier, consistent scope names, a sentence on how this relates to the MCP spec's own discovery, and a public conformance check (like the MCP conformance suite) that an add-on developer can run before deploying.

## 12. Alexa+: the CLI reference leaves out installing the CLI and what `addon.json` holds

- **Date:** 16 Oct 2026
- **Task:** Prepare a complete add-on package (listing text, images, sign-in) ready for `alexa-ai deploy`.
- **Steps:** Read the Alexa AI CLI reference, the MCP quickstart and the Alexa+ Add-on API reference.
- **Expected:** An install command, the `addon.json` schema, and where `--requires-auth` takes the token URL and client secret.
- **Actual:** No install command on the CLI page. `addon.json` fields appear only as a summary in the quickstart; the API reference covers the REST API, not the file. `alexa-ai new mcp` has `--requires-auth`, `--auth-client-id` and `--auth-scopes`, but nothing for the token URL or the secret, and the account-linking config file has no documented schema.
- **Severity:** Medium.
- **Workaround:** Wrote ALEXA.md with everything Doorbound can supply (endpoint, scopes, token URL, listing text, images in every required size, privacy policy and terms) and an honest note about the prompts we could not see.
- **Suggestion:** A JSON Schema for `addon.json` and for the account-linking config, published next to the CLI reference, and a `--auth-token-url` / `--auth-client-secret-env` pair on `alexa-ai new mcp`.

## 13. Alexa+ rules: "Agent Skill" means two different things

- **Date:** 16 Oct 2026
- **Task:** Decide whether to build an "Agent Skill" as well as the MCP server.
- **Steps:** Compared the track rules ("a working Agent Skill, or a self-hosted MCP server") with the MCP toolkit pages.
- **Expected:** One meaning.
- **Actual:** In the docs, the "Add-on Agent Skill" is a helper for coding agents (Claude Code, Kiro, Cursor) that scaffolds and deploys an add-on; it is not something an add-on ships. The rules read as if an Agent Skill were a kind of submission.
- **Severity:** Low, but it costs a team a day if they guess wrong.
- **Workaround:** Put the effort into what makes the add-on deployable (sign-in, listing kit, conformance) instead of a package of our own.
- **Suggestion:** A sentence in the track rules on what counts as a "working Agent Skill" for judging.

## 14. MCP conformance suite: written for the reference server

- **Date:** 16 Oct 2026
- **Task:** Run the official MCP conformance suite (`@modelcontextprotocol/conformance` 0.1.16) against Doorbound and put it in CI.
- **Steps:** `npx @modelcontextprotocol/conformance server --url http://127.0.0.1:3939/mcp`.
- **Expected:** A pass or fail per protocol feature the server offers.
- **Actual:** 4 of 30 passed on the first run. Most scenarios call fixture tools and resources that only the suite's reference server has (`test_simple_text`, `test://static-text`); prompts, logging and completion scenarios fail on servers that rightly do not offer them; there is no option for an auth header; and the scenarios fire fast enough to hit any sensible rate limit (our server answered 429, which failed the DNS-rebinding scenario's "valid Host accepted" check).
- **Severity:** Low (once understood).
- **Workaround:** `scripts/conformance.mjs` runs the scenarios that apply, paced, and fails CI on any of them failing. All of them pass.
- **Suggestion:** Skip scenarios for capabilities the server did not declare in `initialize`, mark fixture-only scenarios as such, and add `--header` for auth.
