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
