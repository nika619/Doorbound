# Doorbound on real Alexa+

Doorbound is an Alexa+ add-on built with Amazon's MCP toolkit: Alexa+ is the MCP client, Doorbound the server. This is how to put it in front of Alexa+. It needs an Amazon developer account and a public HTTPS address; everything else is in this repository.

## What Alexa+ asks of an MCP server, and where Doorbound stands

From Amazon's MCP toolkit pages (read on Oct 16, 2026):

| Alexa+ asks for | Doorbound |
|---|---|
| MCP 2025-11-25 over Streamable HTTP | Yes, and the official conformance suite passes (`npm run conformance`) |
| A public HTTPS URL (a tunnel is fine while developing) | `compose.yaml` with automatic HTTPS, or any tunnel |
| Round trips under 500 ms | Tool calls take about 4 ms on the server (README, Measured) |
| OAuth 2.1; service-level sign-in with client credentials for a private server | Built in: `/oauth/token`, discovery at `/.well-known/oauth-authorization-server` |
| MCP Apps for visuals | The board is the MCP App `ui://doorbound/board.html` |

## 1. Run the server where Alexa+ can reach it

Pick a client id and a long random secret (keep the secret out of git):

```bash
openssl rand -hex 32
```

**While developing**, start a tunnel first to learn its address (Cloudflare's quick tunnel shown; any tunnel works):

```bash
cloudflared tunnel --url http://localhost:3939
```

then start Doorbound with that address (here `abc-def.trycloudflare.com`):

```bash
OAUTH_CLIENT_ID=alexa-plus OAUTH_CLIENT_SECRET=<the secret> PUBLIC_URL=https://abc-def.trycloudflare.com ALLOWED_HOSTS=abc-def.trycloudflare.com TRUST_PROXY=1 npm start
```

The server treats itself as public as soon as `ALLOWED_HOSTS` names an outside host: it refuses to start without sign-in set up, and the simulator page is switched off.

**To keep it running**, use [`compose.yaml`](compose.yaml) on a machine with a domain:

```bash
DOMAIN=doorbound.example.com AUTH_TOKEN=$(openssl rand -hex 32) OAUTH_CLIENT_ID=alexa-plus OAUTH_CLIENT_SECRET=<the secret> docker compose up -d
```

## 2. Create the add-on with Amazon's CLI

Install the Alexa AI CLI as Amazon's "Set Up Your Development Environment" page describes, sign in, and scaffold:

```bash
alexa-ai configure
```

```bash
alexa-ai new mcp --name "Doorbound" --locale en-US --mcp-server-url "https://abc-def.trycloudflare.com/mcp" --requires-auth --auth-client-id alexa-plus --auth-scopes mcp:service
```

Where the CLI asks for the rest of the sign-in, the token endpoint is `https://<your host>/oauth/token`, the grant is client credentials, the scope `mcp:service`, and the secret is your `OAUTH_CLIENT_SECRET` (sent with HTTP Basic). Amazon's pages do not show these prompts; if it wants a JSON file instead, that is `alexa-ai configure-account-linking`.

## 3. Fill in the listing (`addon-package/addon.json`)

| Field | Value |
|---|---|
| name (30 max) | Doorbound |
| short description (123 max) | A departure board for the household morning: real chances of leaving on time, and gentle re-plans when someone runs late. |
| example phrases | "Start the school run, we leave at 7:40." · "Isha's still in the shower, five more minutes." · "How are we doing?" · "We leave at 7:40 tomorrow. When should everyone be up?" |
| privacy policy | https://github.com/nika619/Doorbound/blob/main/PRIVACY.md |
| terms of use | https://github.com/nika619/Doorbound/blob/main/TERMS.md |
| icons (light) | `https://raw.githubusercontent.com/nika619/Doorbound/main/alexa/icon-SIZE.png` for SIZE 64, 72, 88, 126, 180, 241 |
| carousel image (600x900) | https://raw.githubusercontent.com/nika619/Doorbound/main/alexa/carousel.png |

**Full description:**

> Every household has a daily departure, and everyone misjudges how long things take. Doorbound turns the morning into a live departure board. Tell Alexa each person's routine once; from then on Doorbound learns how long each step really takes, and while you get ready it shows everyone's real chance of being out of the door on time. It notices a slow morning: when someone's first steps run long, it plans the rest of their morning longer too. When someone slips ("Isha's still in the shower, five more minutes"), it finds the gentlest fix the household allowed, such as breakfast to go or Dad packing her bag, so everyone still leaves on time, and Alexa says what changed. The evening before, ask when everyone should be up, and it works back from the leaving time to each person's latest start. It keeps score of itself, so you can ask how accurate it has been. Doorbound runs on your own server; your household's data never goes anywhere else.

The images are made from the product by `npm run build && node scripts/alexa-assets.mjs`.

## 4. Deploy and talk to it

```bash
alexa-ai deploy
```

Then open your add-on in the developer console (https://developer.amazon.com/alexa/console/ask/addons) and test it in the web simulator, or on an Echo Show signed in to the same account. Alexa+ reads the tool list only when you deploy, so deploy again after changing tools.

Set the household up by voice ("Isha showers for 8 minutes, then gets dressed for 6..."; "Isha's breakfast can be to go in 2 minutes"; "Dad can pack Isha's bag"), then start a departure.

**Not yet done by us:** the deploy itself. It needs Mayank's Amazon developer account; everything the server side can prove is proven in CI (conformance, the OAuth sign-in end to end, the locked-down container).
