# Agentic credential vault: storage, delegation, and browser authority

Research for [#116](https://github.com/jra3/chikin/issues/116). Inspected **2026-10-14**. Working scope assumption pending operator feedback: a local Chikin Fleet, covering browser logins and API credentials. Sources below are primary vendor documentation, protocol specifications, and this repository. “Documented” means the source describes the capability; it does not mean we installed, audited, or adversarially tested that product. Recommendations and threat-model conclusions are explicitly our analysis.

## Recommendation

Build a **local credential-use broker**, with an existing vault as its eventual storage backend. Let an Instance request an operation on a named account; let the broker authenticate the requester, check a short-lived grant, resolve the credential privately, perform a bounded operation, and return a structured result. Do not start by exposing a general `get_secret` tool. Do not build production vault encryption in the prototype.

For APIs, a broker can own the outgoing request and keep a token outside the agent process. For browser logins, keeping a password out of tool output is achievable, but keeping it out of a hostile agent with unrestricted CDP is a different project. A successful login also creates session authority: protecting the password alone does not constrain what the agent can do afterward.

The first prototype should prove grant lifecycle and bounded credential use against synthetic services. A separate real-browser spike should determine which Browser capabilities must be withheld. Neither should touch the live Fleet's golden profile, Seed Volume, or real credentials.

## The distinctions that determine the design

| Mechanism | What receives the secret? | What it buys | What it does not establish |
| --- | --- | --- | --- |
| Retrieve a vault item | Caller process, and potentially model context | Central storage, permissions, auditing | Protection against an untrusted caller |
| Inject environment variables | Launched process | Avoids checked-in secrets and manual handling | Isolation from code that can inspect its own environment |
| Fill a browser form | Browser renderer and destination site | Password need not pass through model tools | Protection from page scripts, debugger access, or a compromised host |
| Broker an API operation | Trusted broker and approved service | Agent can exercise a bounded capability without possessing the token | Safe behavior on every authorized endpoint |
| Reuse a logged-in profile | Browser holding session state | Fewer password/MFA ceremonies | Narrow account authority or instant remote revocation |
| Issue dynamic credentials | Authorized recipient | Limited lifetime and potentially limited permissions | Non-disclosure to that recipient |

These are different security boundaries, not interchangeable meanings of “agent vault.”

## Existing tools and what their docs actually support

### 1Password

**Service Accounts: useful backend adapter.** Accounts can be scoped to particular vaults and Environments, with explicit permissions and a separate authentication token. Built-in Personal/Private/Employee and default Shared vaults cannot be assigned to them. Use a dedicated automation vault, and keep its service-account token in the broker's trust domain. A service account still fetches secrets; restricting which vault it can read is not a no-disclosure boundary. [Service-account overview](https://www.1password.dev/service-accounts), [setup and limitations](https://www.1password.dev/service-accounts/get-started).

**Environments MCP: metadata and provisioning, not browser login.** The documented local server can list Environment and variable names, create/update Environments, and create locally mounted `.env` files; its tools do not return stored secret values. Approval persists for the permitted Environment tool until 1Password locks. The local mounts make secrets available to application processes. Our inference: the MCP tool's output policy does not prevent an agent with sufficient local process/file access from reading the resulting application input. [Environments MCP](https://www.1password.dev/environments/mcp-server).

**Agentic Autofill: relevant browser design precedent.** The documented Claude integration pairs an allowlisted, signed partner app, binds grants to agent sessions, asks the human for release, and delivers credentials to the extension. The agent stops observing while the extension fills and submits; failed submissions clear the fields. The security document explicitly accepts same-user/admin compromise, destination-page scripts receiving the credentials, and the agent exercising the resulting signed-in account. This is a vendor-described design, not our verification. Its documented Mac/partner integration is not evidence of a generic API usable by Chikin's Linux Browsers. [Security design](https://support.1password.com/1password-claude-security/).

**Credential Broker: do not infer browser support from its name.** The public-preview announcement describes workload identity and GitHub Actions delivering approved credentials at runtime. This is promising for eliminating a long-lived service-account bootstrap token where a suitable workload identity exists. It does not establish a ready-made credential-use firewall for local Chikin browser sessions. [Public-preview announcement](https://1password.com/blog/1password-credential-broker-public-preview).

### Bitwarden Secrets Manager

Machine accounts have scoped secret/project access and access tokens. The SDK/CLI is a reasonable backend for an independently protected broker. Secrets Manager is a separate workflow from an end-user browser password manager; do not assume its project/secret model automatically imports browser login behavior. [Machine accounts](https://bitwarden.com/help/machine-accounts/), [overview](https://bitwarden.com/help/secrets-manager-overview/).

`bws run` injects secrets into a command's environment. Bitwarden explicitly warns against running untrusted commands this way, and explains that `--no-inherit-env` is not a sandbox. Thus `bws run agent` addresses storage hygiene but does not satisfy hostile-agent non-disclosure. A broker can use the SDK privately instead. [CLI documentation](https://bitwarden.com/help/secrets-manager-cli/).

### OpenBao / HashiCorp Vault

OpenBao assigns leases to dynamic secrets and service authentication tokens, and can renew or revoke them. Database engines can mint unique username/password pairs per request. This is a strong fit when the target supports dynamically issued credentials, especially infrastructure APIs/databases. It does not create short-lived accounts on an arbitrary website merely because its password is stored in a KV engine. [Leases](https://openbao.org/docs/concepts/lease/), [database engine](https://openbao.org/docs/2.5.x/secrets/databases/).

Vault response wrapping exchanges the secret response for a short-lived, single-use wrapping token; the recipient unwraps it to obtain the payload. That improves delivery and detects premature consumption. It is not “use without disclosure” to the final recipient. Our recommendation: consider these systems if dynamic infrastructure credentials or existing operational expertise justify the deployment; avoid adding their operational surface solely to prove a local browser-login idea. [Response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping).

### Browserbase

Browserbase documents manual login through Live View followed by context reuse for cookies/session state. That resembles Chikin's authenticated Profile Volume concept, while Browserbase itself is a cloud service and does not fit Chikin's local-only topology. Its docs acknowledge interactive MFA and passkey challenges. Context persistence is session reuse, not a narrower authorization grant. [Website authentication](https://docs.browserbase.com/platform/identity/authentication).

Its current 1Password quickstart resolves username/password with a service account and interpolates them into `stagehand.act(...)` instructions. Therefore that particular recipe is not evidence for keeping secrets outside model-facing instructions. It is distinct from 1Password's Agentic Autofill design. [Inspected quickstart](https://docs.browserbase.com/integrations/1password/quickstart).

Browserbase Secrets encrypts values client-side for storage, exposes names/IDs through get/list, and supplies attached values to Function runtime code through `context.secrets`. Our inference: keep function code trusted; a value absent from a control-plane listing is still readable to its authorized execution environment. [Secrets access model](https://docs.browserbase.com/platform/secrets/overview).

### Agent-oriented alternatives worth a second spike

**varlock credential proxy** gives a process placeholders, injects real credentials on verified upstream TLS connections, and documents route rules. It is an early preview. Its own limitations are unusually useful: same-user execution is not a hard boundary; default egress is permissive; response scrubbing misses transformed, large, or compressed echoes; and a trusted upstream can return the secret. Treat it as a candidate for an API-broker comparison, not a verified drop-in solution. [Proxy design and limitations](https://varlock.dev/guides/proxy/).

The accompanying sandbox guide separates filesystem/process/network containment from credential injection, and documents Docker/Podman isolation for Linux. That separation is directly applicable to Chikin even if varlock is not selected. [Sandboxing](https://varlock.dev/guides/proxy/sandboxing/).

**Vercel agent-browser** documents named login credentials and `auth login` as a way to avoid handing passwords to the LLM. This is a useful UX precedent. Its security page and repository README contain differing wording about whether encryption requires an explicit key; verify pinned source and version before making an at-rest claim. In either case, a local encrypted file plus a key readable by the same agent is not an independent security boundary. [Security documentation](https://agent-browser.dev/security), [upstream README](https://github.com/vercel-labs/agent-browser/blob/main/README.md).

## Browser-specific boundaries

### CDP makes concealed form filling insufficient

Chrome's protocol exposes cookie retrieval, request post-data retrieval, request/response events, and JavaScript evaluation. A driver can install observation before login, inspect subsequent authenticated traffic, or exercise the session without extracting anything. Masking passwords in a snapshot does not remove these capabilities. [Network protocol](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [Runtime protocol](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/).

**Our analysis:** a credible browser broker needs an exclusive authentication phase and a restricted agent interface, including the bypass paths. Simply pausing cooperative tool calls does not remove previously installed event listeners, page modifications, workers, independent CDP connections, or sibling Browser access. A fresh broker-owned Browser plus narrow post-login tools is a better experiment than injecting into an arbitrarily agent-modified tab. Even then, the destination site remains trusted with its own credentials.

Chikin currently exposes both an MCP Lane and a raw CDP Lane. [ADR 0003](../adr/0003-accept-cross-browser-reachability-close-the-gateway.md) deliberately accepts peer CDP/VNC reachability because seeding gives Browsers the same identities. **Per-account vault grants invalidate that rationale.** The ADR explicitly calls for revisiting the decision when identities become separate. Individual grant enforcement at the gateway would be bypassable if a compromised Browser can drive another account's Browser directly. Network isolation, seed policy, and authority to open a Lane must become part of this project before claiming account separation. See also [project vocabulary](../../CONTEXT.md) and `itest/gateway-reachability.mjs`.

The gateway already holds a model API key outside Browser containers, and [ADR 0008](../adr/0008-the-gateway-runs-the-decision-loop-and-holds-its-key.md) explains why its session closure owns the decision loop and CDP bookkeeping. Our integration recommendation is to evaluate reuse of that ownership/queue before introducing a second browser driver. Keeping credentials outside a Browser is consistent with that existing boundary; adding per-Instance authorization is new work.

### MFA and passkeys are not ordinary vault fields

TOTP depends on a shared secret and time; a broker with the seed can produce codes without a human. Our analysis: putting password and TOTP seed behind one unattended grant makes that grant sufficient for both steps, even though the website still presents two fields. Human approval should be a separate policy decision, not an accidental consequence of needing an OTP. [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238).

WebAuthn keeps private-key operations inside an authenticator and binds credentials to a relying party; sites may require user verification. A virtual test authenticator proves test flows, not the ability to use an existing hardware/synced passkey. SMS, email links, push approval, and passkey ceremonies need explicit supported integrations or a human handoff. Do not solve the prototype by weakening the person's real MFA settings. [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/).

### Revoking a grant and revoking a website session differ

**Our analysis:** stopping future broker calls is locally enforceable. It does not undo already completed actions, revoke an exported cookie, or force every website to invalidate its server-side session. A production system must distinguish “grant revoked,” “Browser disconnected,” “local session material removed,” and “upstream session invalidated.” Only report the last one when the site's logout/revocation behavior was exercised and verified. A short broker TTL is not evidence of a short upstream cookie lifetime.

## Prototype boundary and next experiment

A standalone HTML grant model can make request/approve/deny/expire/revoke behavior reviewable. An actual local Node broker can prove two operations: inject a token into a fixed API request, and submit a synthetic website login while retaining its cookie privately for one bounded follow-up operation. That latter implementation is **HTTP form/session brokering**, not a demonstrated CDP/browser integration. No production encryption, genuine MFA, or general website compatibility follows from it.

Recommended invariants for the working prototype:

1. A request names an operation/account; a server-held route selects the destination. Reject caller-supplied arbitrary URLs, headers, credential references, and redirects.
2. Bind a grant to an authenticated requester, account, permitted operations, expiry, and usage bound. A human-readable Instance name alone is not authentication.
3. The agent cannot approve its own request. UI separation by itself is a demonstration; same-user code execution remains outside the prototype's protection claim.
4. Denied, expired, revoked, cross-requester, and replayed grants fail before credential use. Consume one-shot authority atomically across concurrent requests.
5. Do not return raw upstream responses or cookies. Return operation-specific fields; test an upstream that echoes the credential. Exact-string redaction alone is not proof against transformed echoes.
6. Audit requester, account alias, operation, decision, and time without credential values, cookies, headers, or arbitrary response bodies.
7. An operation that may already have completed must not be reported as safely retryable merely because the result could not be read.

**Next browser spike:** use a synthetic login site and fresh isolated Browser with seeding disabled. Establish broker ownership of the authentication phase, then hand over a small approved tool surface. Attack it with preinstalled script observers, CDP network listeners, cookie export, failed submissions, origin/frame changes, redirect destinations, concurrent requests, and a second Browser attempting peer access. Verify what remains observable after handover. Until those tests pass under an explicit attacker model, label the feature “keeps credentials out of normal tool output,” not “credentials cannot be extracted by the agent.”

## Decisions still needing product judgment

- Are we protecting against accidental transcript exposure, a prompt-injected browser agent, a compromised Browser, or a same-user shell agent? These require increasingly different boundaries.
- Must agents retain unrestricted CDP/evaluate access after login? If yes, treat the granted account/session as delegated authority and narrow the account itself.
- Is the preferred source an existing personal password manager, dedicated automation accounts, or newly issued API credentials?
- Should approval authorize one operation, one login, or a time-limited session? What must revoke actually end?
- Which first real site has a representative login flow and an appropriately limited test account?

The concrete recommendation is independent of the storage vendor: prototype the authority boundary first, then add a vault adapter behind it.

## Prototype outcome (2026-10-14)

The [working broker and standalone grant model](../../gateway/prototypes/credential-vault/README.md) now exist on the throwaway branch `research/116-agentic-credential-vault`. The broker performed API token authentication and synthetic HTTP website login/account reads; its walkthrough demonstrated grant binding, denied overrides, exhaustion, expiry, revocation with fixture logout, and concurrent-request handling. Captured agent/operator HTTP replies and audit state did not contain the generated fixture secrets, including secrets deliberately echoed in upstream diagnostic fields. See the [recorded execution](../../gateway/prototypes/credential-vault/evidence.txt) for the finite observed cases.

The state model's browser-session walkthrough demonstrated the separate authority created by handing a session to a Browser: revoking the login grant leaves that session active. These observations support investigating a credential-use broker with an existing vault backend. They do not validate a storage vendor, real Chrome login, MFA, isolation from a hostile host, or production adoption of the throwaway implementation. No production Gateway behavior was changed.
