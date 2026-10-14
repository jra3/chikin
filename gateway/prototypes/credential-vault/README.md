# Credential-use broker prototype

Throwaway research for [#116](https://github.com/jra3/chikin/issues/116), captured on branch `research/116-agentic-credential-vault`. Nothing here is wired into the production Gateway or Docker build. All credentials are synthetic, regenerated on startup, and held in memory. The original HTTP broker needs only Node 22+. The Chikin browser demo below also uses Docker, existing Chikin images/networks, and the Gateway’s locked Playwright dependency.

## Question and verdict

**Can an agent complete a useful credential-backed operation without receiving the credential, while an independent operator controls scope, lifetime, and usage?**

**Yes, for a trusted broker exposing a small operation interface.** The executable walkthrough performed real authenticated HTTP requests, retained a website session privately, refused unauthorized uses, and checked captured replies for the fixture's secrets even though upstream diagnostic fields deliberately echoed them.

This does **not** establish secrecy against an agent with host/process access, and the original HTTP broker does not implement Chrome login. The follow-up below now demonstrates login inside real Chikin Chrome. The research identifies unrestricted CDP and accepted cross-Browser reachability as separate obstacles to meaningful account isolation in Chikin. A production vault adapter remains a later choice.

## Run the Chikin website-login prototype (preferred first slice)

The operator clarified that the first feature should log into websites through Chikin; personal Bitwarden is the likely source. This follow-up submits a real HTML login form inside a fresh Chikin Browser through a separate scratch Gateway.

```sh
npm ci --prefix gateway --ignore-scripts
node gateway/prototypes/credential-vault/chikin-demo.mjs
```

Prerequisites: Docker access; existing `chikin:local`, `chikin-gateway:local`, and `node:22-bookworm-slim` images; the usual `chikin-control`, `chikin-net`, and `chikin-egress` networks and socket proxy; port 18116 free. Override `VAULT_CHIKIN_PORT`, `VAULT_GATEWAY_IMAGE`, or `VAULT_CHROME_IMAGE` if needed. The script uses existing images without rebuilding or restarting production services, and reports the Gateway image digest it exercised.

The trusted harness creates a one-use login grant. An agent-side call names only `demo-accounts` and its grant; the broker navigates its own fresh tab, checks the exact origin, form action/method and field types, resolves synthetic credentials privately, fills/submits, and verifies the authenticated account page. The fixture issues a real HttpOnly session cookie to Chrome. The agent receives an authentication result, with no password.

The run uses one random `inst-vault-*` Name, no Seed Volume, a fleet cap of the existing count plus one, disabled volume GC, disabled attached reaping, and long idle/sweep intervals. It checks the effective settings in `/healthz` before provisioning. Normal completion and caught failures remove only resources created under this run’s unpredictable names. An abrupt process/host termination can still leave those scratch resources behind; no broad cleanup/prune is performed. The live Browser and sticky profiles are never driven or removed.

[Observed transcript](chikin-evidence.txt) and [authenticated-page screenshot](browser-authenticated.png) record the successful run. It proved login, headful Chrome, wrong-agent/account/destination refusals, replay/expiry/revocation, exactly one actual form submission, and real website logout. Revoking the grant intentionally left the already-established site session usable until logout.

The operator/agent separation here is an in-process harness convention, not production authentication. Unlike the earlier HTTP broker, the Browser now owns the website session. This does not defend against unrestricted CDP, hostile page scripts, a same-user shell agent, or peer-Browser access. It does not perform MFA, SSO or real Bitwarden access.

**Bitwarden seam:** `createLoginBroker` accepts `resolveCredential(accountAlias)`. Replace the synthetic resolver only inside the trusted broker, using Password Manager’s `bw get item <approved-item-UUID>` and an operator-held `BW_SESSION`. Keep an explicit item/origin allowlist; do not expose arbitrary item lookup or vault unlock to the agent. `bw` is distinct from Secrets Manager’s `bws`. No Bitwarden command or actual vault access is part of this prototype. The research records the unlock and URI-matching constraints.

**Transport sharp edge:** Node’s built-in `fetch` sends Fetch Metadata and is refused by Chikin’s CDP page guard. The harness uses Node HTTP for discovery and the same Playwright CDP transport as the existing integration tests. The production guard was not weakened.

## Run the working broker

From the repository root:

```sh
node gateway/prototypes/credential-vault/broker.mjs
```

Open the **operator console URL printed by the command**. It includes a random capability in the fragment. Keep that URL in the operator's trust domain; it allows issuing grants. Reload works with the fragment intact. Restarting invalidates all keys, grants, and sessions. Stop with Ctrl+C. To use another port:

```sh
VAULT_PROTOTYPE_PORT=43872 node gateway/prototypes/credential-vault/broker.mjs
```

Try these flows:

1. Grant one invoice read. Try another agent and another destination: both refuse without consuming the allowance. Run the approved operation: it returns an invoice count and total. Repeat: the allowance is exhausted.
2. Select website account access and three uses. Grant access and run twice: the fixture records one login and two reads. Revoke: it records logout and the broker discards its cookie. Try again: refused.
3. Grant access and wait 60 seconds. The grant expires; future calls refuse. Retained fixture sessions are cleaned up on a 250 ms sweep.

The console's “simulate agent” controls are explicitly operator-only demonstration controls. The actual `/agent/execute` interface authenticates agents with separate bearer credentials; the command below exercises it directly.

## Run the reproducible HTTP walkthrough

```sh
node gateway/prototypes/credential-vault/demo.mjs
```

This starts fresh broker and fixture listeners on random loopback ports, runs the scenarios, prints their results, and closes both listeners. It never uses Docker, the live Gateway, a real vault, or a real website. [evidence.txt](evidence.txt) records the successful 2026-10-14 run on Node 22.23.2.

Observed cases: unauthenticated caller, self-approval attempt, wrong agent, wrong operation, destination override, body identity override, foreign Origin, valid API read, replay, website login, cookie reuse, revocation/logout, simultaneous one-shot calls, simultaneous website calls, expiry, and credential-echo exclusion from captured replies/audit state. This is a finite demonstration, not a general proof that arbitrary malicious upstream responses cannot leak information.

## Open the standalone state model

Double-click [model.html](model.html), or visit `/model` on the running broker. It needs no server or dependencies when opened as a file. Six guided walkthroughs and free-play controls expose the model's full state.

Its last walkthrough intentionally differs from the broker: it models handing a signed-in Browser to the agent. Revoking the vault grant leaves the website session active until a separate sign-out action. The broker demo keeps the cookie in its own custody and can call the synthetic site's logout endpoint. These two custody models must not be confused.

## Mechanism

- A separate random bearer credential authenticates each of two demo agents. Caller-supplied identity fields are refused.
- The operator creates immutable grants for one authenticated agent and one named operation, with 1–3 uses and a 60-second lifetime.
- Operation definitions pin the credential alias, destination, HTTP method, and output shape. Caller-supplied URLs, headers, bodies, and other overrides are refused. Fetch refuses redirects.
- Usage is reserved before the first asynchronous operation. A second overlapping website call is refused, preventing competing session creation.
- The broker injects an API token or performs a synthetic login and stores the cookie. Only typed operation results cross the agent interface. Fixture responses deliberately include secret-bearing diagnostics to catch accidental whole-response forwarding.
- Audit entries contain broker-known identities, operation names, grant IDs, timestamps, and decisions. They never include upstream payloads or HTTP credentials.
- Ambiguous upstream failure consumes the allowance and returns `retryable: false`. Revocation cannot recall an HTTP request already sent.

## Scope and limitations

- Broker and fixture are separate HTTP listeners in the same trusted Node process, bound to `127.0.0.1`. This proves the request path, not OS/process isolation. UI and fixture data are synthetic. Memory is not securely erased, and audit history is unbounded for this short-lived demo.
- Operator and agent keys are held by the trusted demonstration harness. No production identity enrollment, vault unlock, storage encryption, key rotation, or durable audit exists.
- The website fixture accepts a JSON login and returns a cookie. There is no general form discovery, browser control, MFA, passkey, redirect/SSO, or real vault integration.
- HTTP without TLS is confined to loopback synthetic services. A production adapter needs approved HTTPS destinations, DNS/egress policy, response schemas, and supported session termination semantics.
- Cleanup calls the fixture's working logout endpoint. There is no claim that every real website invalidates all copies of a session on logout. Failed cleanup is not retried durably.
- The operator console permits simulated agent actions for inspection. It is not an approval UI safe to expose inside the untrusted agent's browser.
- Browser interactions verified grant issuance, wrong-agent denial, API completion, website login, revocation/logout, and all six steps of the session-outlives-grant model. The collaborative browser's snapshot command failed; verification used its click and DOM-inspection tools, so no screenshot artifact is claimed.

## Next production decision

Choose whether the first supported boundary is accidental transcript exposure or a hostile/prompt-injected agent. For the stronger boundary, a Browser spike must restrict raw CDP, script execution/observation, and peer-Browser access; use a fresh Browser with no inherited Seed Volume. Then connect one supported vault backend and one representative test account. Do not lift this prototype into production as a credential vault.

See the [primary-source research](../../../docs/research/agentic-credential-vault.md).
