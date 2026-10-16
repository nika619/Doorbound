// The official MCP conformance suite (@modelcontextprotocol/conformance), against a running server:
//   DOORBOUND_URL=http://127.0.0.1:3939 node scripts/conformance.mjs
// Runs the scenarios that apply to Doorbound, one at a time and paced, so the server's own rate limit
// (20 requests a second per client) is not what is being measured. Exits non-zero on any failure.
// Left out, and why: prompts, logging, completion and resource subscriptions are not offered, and the
// server correctly answers "method not found" for them; the tools-call-*, resources-read-* and
// json-schema scenarios call fixture tools and resources (test_simple_text, test://static-text, ...)
// that exist only in the suite's own reference server.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUITE = '@modelcontextprotocol/conformance@0.1.16';
const SCENARIOS = ['server-initialize', 'ping', 'tools-list', 'resources-list', 'dns-rebinding-protection', 'server-sse-polling', 'server-sse-multiple-streams'];
const url = `${process.env.DOORBOUND_URL ?? 'http://127.0.0.1:3939'}/mcp`;
const out = mkdtempSync(join(tmpdir(), 'conformance-'));
let failed = 0;
for (const s of SCENARIOS) {
  // One command string: npx is a script on Windows, which needs a shell, and a shell should not get loose args.
  spawnSync(`npx -y ${SUITE} server --url "${url}" --scenario ${s} -o "${out}"`, { stdio: 'ignore', shell: true });
  await new Promise((r) => setTimeout(r, 2500));
}
const ran = readdirSync(out);
if (ran.length < SCENARIOS.length) {
  console.log(`FAIL  only ${ran.length} of ${SCENARIOS.length} scenarios produced results (is the server up, and npx online?)`);
  failed++;
}
for (const d of ran)
  for (const c of JSON.parse(readFileSync(join(out, d, 'checks.json'), 'utf8'))) {
    if (c.status === 'INFO') continue;
    if (c.status === 'FAILURE') failed++;
    console.log(`${c.status === 'SUCCESS' ? 'ok  ' : c.status === 'FAILURE' ? 'FAIL' : 'warn'}  ${c.id}${c.errorMessage ? `: ${c.errorMessage}` : ''}`);
  }
rmSync(out, { recursive: true, force: true });
console.log(failed ? `\n${failed} conformance check(s) failed.` : `\nAll applicable conformance checks passed (${SUITE}).`);
process.exit(failed ? 1 : 0);
