# Trying the credential-vault prototype

Start here if you want to run the demonstration or prepare a trial where an agent uses a real website account.

**Today: the synthetic demonstration is runnable. A real-credential session with an arbitrary agent is not wired up yet.** The prototype proves login through Chikin, a restricted operation interface, and client containment. It does not yet provide a persistent broker command, a Bitwarden adapter, or a model-driven agent connection.

The code is on `research/116-agentic-credential-vault`, tracked in [#116](https://github.com/jra3/chikin/issues/116). The [technical README](README.md) explains the implementation and recorded evidence.

## 1. Run what works now

From the repository root:

```sh
npm ci --prefix gateway --ignore-scripts
node gateway/prototypes/credential-vault/chikin-demo.mjs --restricted
```

You need Node 22+, permission to use Docker, and an existing local Chikin installation with:

- Images: `chikin:local`, `chikin-gateway:local`, and `node:22-bookworm-slim`.
- Networks: `chikin-control`, `chikin-net`, and `chikin-egress`, with the usual socket proxy available to the Gateway.
- Port `18116` free. If it is occupied, use `VAULT_CHIKIN_PORT=18117 node gateway/prototypes/credential-vault/chikin-demo.mjs --restricted`.

This command creates a scratch Gateway, a synthetic website, and one fresh disposable Browser. It generates its own username/password, runs login and extraction checks, exercises a contained client, and tears the run down. Seeding and volume GC are disabled. The live Browser and your existing profiles are not used.

Success ends with `PASS` results, a `VERDICT` line, and `CLEANUP`. In particular, look for:

```text
PASS restricted login works
PASS restricted logout works
PASS useful account read succeeds without raw DOM
PASS contained agent can work only through restricted socket
PASS generated password absent from all captured tool outputs and audit
```

The contained client should report an invoice total of `42` and status `paid`. The complete reference run is in [restricted-evidence.txt](restricted-evidence.txt).

**There is nothing to attach another agent to after this command finishes.** It is an automated walkthrough, and the broker socket, credentials, grant, and Browser are temporary. `restricted-agent.mjs` is a scripted exercise client, not an LLM agent.

If it fails, retain the error and the failing check. Normal completion and caught failures clean up owned resources; abrupt termination can leave scratch resources behind. Do not use a broad Docker volume prune to clean them up. Only resources identified as belonging to that run should be removed.

## First real trial: Reddit / Codex

The selected task is to sign into `https://www.reddit.com` and return the account's **joined subreddits**. Codex is the selected driving agent. Login/MFA method remains unconfirmed. The proposed read operation returns subreddit names and canonical links; it must enumerate all pages and distinguish a complete result from a partial list. It must not substitute recommendations, visited communities, or the logged-out defaults for account memberships.

On 2026-10-15 the public login form loaded in T3's collaborative browser, but a fresh isolated **Chikin Browser** received **“Reddit - Prove your humanity”** before the login form. No credential was supplied or submitted. The disposable Browser, Profile Volume, scratch Gateway and private network were removed. This is a preflight result, not a successful login or an authenticated subreddit read.

Repeat that public-only check with the same prerequisites as the synthetic demo:

```sh
node gateway/prototypes/credential-vault/reddit-preflight.mjs
```

Exit `0` means the public login form appeared, `2` means human verification is required, and `1` means an error occurred. The command accepts no credentials and cleans up rather than leaving a session available. Do not enter credentials into T3's unrestricted preview as a workaround for the vault trial. The operator challenge handoff, private credential entry, Reddit read handler, and contained Codex connection still need implementation before the real-account trial.

## 2. Before supplying a real credential

Send these non-secret details first:

```text
Website / login URL:
First task after login:
Agent and how you normally run it:
Login method: password only / TOTP / push / passkey / SSO / other
Desired credential source: Bitwarden / one-time private entry
Account alias: an invented label, such as vendor-test
Allowed outcome: exactly what the agent may read or change
```

For example, “log into this vendor portal and read the latest invoice total” is enough to define an initial task. “Browse anything in my account” is not a bounded operation the current design supports.

Do not paste the password, Bitwarden master password, `BW_SESSION`, OTP seed, or recovery codes into chat or an issue. The broker needs the credential; the implementation discussion needs the site and task.

**Do not put a real password into `chikin-demo.mjs`, `browser-fixture.mjs`, or `CHIKIN_DEMO_PASSWORD`.** The fixture intentionally echoes its generated password into a hidden DOM attribute, and the attack exercise copies it into another page field. These are deliberate test traps. They are unsuitable for real credentials.

## 3. What must be added for the first real trial

These are implementation steps, not features you can enable with a flag today:

1. **A handler for the chosen website and task.** The existing code assumes `/login`, `/account`, `#username`, `#password`, and a synthetic invoice field. A real handler must specify the approved HTTPS destinations, form behavior, successful-login check, permitted task actions, and allowed results. MFA/SSO/passkey flows need an explicit supported handoff; they are not implemented.
2. **A persistent operator-controlled broker.** It must stay running while the agent works and provide a private way to create, revoke, and end a session. Currently those operations are harness methods, and grants default to 60 seconds with one login and three invoice-read attempts.
3. **A private credential resolver.** For Bitwarden, use Password Manager's `bw` behind the broker, with an approved item UUID and exact site policy. The broker must validate the returned Login item and keep the unlock session out of the agent environment. The current resolver only returns generated credentials. See the [Bitwarden research](../../../docs/research/agentic-credential-vault.md).
4. **An adapter for the chosen agent runtime.** The current interface is HTTP over a Unix socket, not MCP. The adapter must expose only the reviewed operations and attach the limited agent token/grant itself. It must preserve separation from the broker host, raw Gateway/CDP/noVNC access, Docker socket, and credential store.

A normal host-running coding agent with unrestricted shell access does not meet that last condition. Merely hiding its browser tools would leave a host-level bypass.

The demo client uses `--network none`. A normal cloud-backed agent also needs to reach its model provider, so dropping an unmodified agent CLI into that container will not work. The integration needs either a trusted model runner that dispatches only restricted operations, or deliberately constrained model connectivity for the contained runtime. No such model relay is shipped in this prototype.

## 4. How the real credential handoff should work

Once the site handler and session runner exist, the operator supplies the credential directly to the trusted broker. The agent does not receive it.

**Preferred with your existing Bitwarden setup:** you unlock Bitwarden privately in the operator environment. The broker retrieves the one approved Login item. Its `BW_SESSION` stays with the broker; the agent gets neither that session nor a general `bw` command. An item UUID is a reference to select, not a credential to put in the agent's prompt.

**Alternative for a one-off trial:** an operator-only masked prompt can accept the site's username/password into broker memory. That prompt still needs to be implemented. A real password should not be supplied through a chat message, a command-line argument, a committed file, or the demo's fixture environment.

A file with restrictive permissions would not by itself hide a credential from an agent running as the same host user. The runtime separation is part of the handoff design, not an optional later hardening step.

## 5. What the agent is allowed to do

The current prototype's operation contract is:

| Operation | Allowed behavior |
| --- | --- |
| `browser_login` | Sign into the approved account once. No credential or URL arguments. |
| `invoice_read` | Return only a numeric total and `paid`/`unpaid` status. Up to three read attempts. |
| `browser_logout` | Perform the reviewed website sign-out action. |

The real site's task will replace or extend `invoice_read` with its own reviewed operation. The agent will not get arbitrary clicks, navigation, JavaScript, DOM dumps, screenshots, network logs, cookie export, or file upload/download as an escape hatch.

For adapter development, the existing wire shape is:

```http
POST /call
Host: vault-broker
Authorization: Bearer <limited agent token>
Content-Type: application/json

{"grantId":"<broker-issued grant>","method":"browser_login"}
```

It travels over the private Unix socket; there is no public TCP port for this interface. `GET /tools` lists the three operations and also requires authentication. This is a protocol example, not a command that can attach to the already-finished demonstration.

A successful task reply looks like:

```json
{"ok":true,"invoice":{"totalUSD":42,"status":"paid"}}
```

The website password, session cookies, raw page content, and Gateway token are absent. The limited agent token is still a capability: it belongs in the contained runtime/adapter, not in chat or a public handoff document.

## 6. Run and end a real trial

After the missing pieces above are implemented, the intended operator sequence is:

1. Start an isolated broker-owned Browser with no inherited Seed Volume.
2. Supply the approved credential privately and grant the chosen agent a specific task, time limit, and usage allowance.
3. Start the contained agent adapter. Give the agent the task and allowed operation names; let the adapter supply its token/grant.
4. Verify successful login from the broker's approved result, then inspect the task result and credential-free audit.
5. While the grant remains active, have the agent sign out through the reviewed logout operation. Revoke further access and destroy only that trial's disposable Browser/Profile Volume.

If you need to stop access immediately, revoke first. Operator cleanup must remain possible afterward: the revoked agent cannot call `browser_logout` either. Revocation prevents subsequent tool calls; it cannot recall an action already sent or promise that the website has invalidated its session. Removing the disposable Browser removes the local session copy, not necessarily the website's server-side session.

On `outcome_unknown` or `login_outcome_unknown`, do not blindly repeat the operation. The input may already have reached the site; inspect the session through the trusted operator path before granting another attempt. On `page_refused` or `result_schema_refused`, report the mismatch and fix the site handler rather than giving the agent unrestricted browser access.

The website, task and agent are now selected: **Reddit, joined subreddits, Codex**. The remaining non-secret input is **the login/MFA method**. The credential comes afterward, through the private broker handoff, once the missing integration and human-verification handoff are implemented.
