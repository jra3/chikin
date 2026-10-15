# Trying the credential-vault prototype

The first real-account trial is **Reddit username/password login, followed by reading every joined subreddit, driven by Codex**. The operator supplies credentials privately. The driving Codex runs separately from the broker and gets only three named operations.

This is throwaway research on `research/116-agentic-credential-vault`, tracked in [#116](https://github.com/jra3/chikin/issues/116). **A successful synthetic run is not evidence of successful real Reddit authentication.** No real Reddit credential has been supplied during development.

## Run the Reddit trial

From the repository root, in **your own interactive terminal**:

```sh
bash gateway/prototypes/credential-vault/reddit-trial.sh
```

Prerequisites:

- Node 22+, the Gateway dependencies (`npm ci --prefix gateway --ignore-scripts`), and Docker access.
- Existing images `chikin:local`, `chikin-gateway:local`, `node:22-bookworm-slim`; networks `chikin-control`, `chikin-egress`; the usual socket proxy.
- A working local Codex login in `~/.codex/auth.json`. This prototype uses ChatGPT authentication, not an API key. It does not alter your login or config. If authentication has expired, use the normal `codex login` flow first.
- Codex CLI 0.162.1 is the tested version. The launcher resolves its binary with `mise which codex`; alternatively set `VAULT_CODEX_BINARY` to the actual executable, not a shim. Its `codex-code-mode-host` companion must be in the same directory. The prototype defaults to model `gpt-6-astra`.
- Port `18116` free. To use another port: `VAULT_CHIKIN_PORT=18117 bash gateway/prototypes/credential-vault/reddit-trial.sh`.

The wizard has three stages:

1. **Prepare the login page.** It creates a fresh Chikin Browser on a private data network with no inherited profile, verifies the contained model connection, then opens an operator-only noVNC window. Complete Reddit's human verification if shown. Stop at the username/password form; leave the credential fields empty. Return to the terminal and press Enter. The broker verifies the form before accepting credentials.
2. **Private credential entry.** Copy the username and password from Bitwarden into the terminal's hidden prompts. Both are hidden. The wizard sends them through a pipe to an operator-only Unix socket, then unsets its shell variables. They are not command arguments, environment variables, committed files, or agent messages. The broker retains the credential in memory for one login attempt. This is manual entry from Bitwarden, **not an automatic Bitwarden integration**.
3. **Codex performs the task.** It requests login, then the joined-subreddit list, then ends its access. Keep the operator window visible in case Reddit presents another challenge. The result appears in your terminal. The wizard then removes its disposable Browser/Profile Volume and scratch Gateway/network.

Do not paste credentials, OTP seeds, Bitwarden master passwords, or `BW_SESSION` into chat. Do not run the wizard through an agent terminal tool and send it secrets via tool calls. Run it yourself. Do not substitute real credentials into any synthetic fixture or demonstration.

## What the driving agent can do

- `browser_login`: one login attempt to the reviewed Reddit form. The credential is already in broker memory; the agent supplies no username, password, destination or selector.
- `subreddit_list`: verify the authenticated username, enumerate `/subreddits/mine/subscriber.json`, and return only subreddit names and canonical links. At most two attempts, 100 pages of at most 100 entries each. Followed-user entries are excluded. The adapter returns an error on malformed data, repeated cursors, lost authentication, or pagination limits; it does not label a partial list complete.
- `session_end`: revoke further operations and discard any unused credential. The operator handles Browser destruction independently of the grant.

The agent has no raw CDP, general browser clicks, arbitrary navigation, DOM or screenshot read, cookie export, network logs, vault CLI, or operator endpoint. It can execute shell commands **inside its own disposable container**, which has no network interface beyond loopback, no Docker socket, no broker-host filesystem, and no Browser network membership. Its only mounted interfaces are the restricted tool socket and a model relay socket, plus its executable/client code.

Model authentication remains on the trusted host. The relay forwards only bounded Responses requests to a fixed model endpoint, injects the model credential there, rejects server-side tool types, and never mounts the auth file into the agent container. The agent may make up to 24 model requests per run. Browser tools, Apps, plugins, remote plugins and multi-agent features are disabled in the driving CLI. This research relay uses the observed Codex ChatGPT backend transport; it is not presented as a supported public API integration and may need updating when Codex changes.

## Human verification, errors, and stopping

A fresh Chikin Browser received **“Reddit - Prove your humanity”** in the public preflight on 2026-10-15. The operator window is the intended handoff. There is no challenge-solving automation. If the login form never appears, stop; the wizard will not request the password.

The adapter currently supports username/password only. Unexpected MFA, email confirmation, a changed login form, or Reddit refusing the authenticated JSON endpoint can stop the trial. Check the operator browser for the actual page state. Do not give the agent unrestricted browser tools to work around a refusal.

Login is consumed once it begins. An `outcome_unknown` or `login_outcome_unknown_check_operator_browser` response is **not retryable**; the input may already have reached Reddit. The wizard does not automatically resubmit your password. Fix the cause before deliberately starting another trial.

Press **Ctrl-C in the wizard terminal** to revoke access, stop the contained agent, and clean up its disposable resources. There is a 20-minute overall lifetime and a 5-minute agent-run limit. Operator cleanup works after the agent's grant has ended.

`session_end` and deleting the Profile Volume remove local access; **they do not claim to invalidate Reddit's server-side session**. This prototype does not perform a verified Reddit logout. Use Reddit's own session-management controls if remote revocation is needed.

On normal completion, your subreddit list is printed to your terminal, not written into this repository or the issue. Model input/output naturally passes through the model provider. The wizard's temporary directory is removed on exit. Abrupt termination of the host or `SIGKILL` can leave scratch resources; never use a broad Docker volume prune. Cleanup is only by the exact disposable names belonging to the run.

## Trust boundary

This protects the broker from the **contained driving Codex**, not an agent or person with shell access to the broker host. The host, operator terminal/noVNC, Docker/kernel, trusted adapter, and Reddit remain trusted. The coding assistant that builds this software has host access and belongs to that trusted side. There is no claim of secrecy from the implementation environment itself.

The approved website can encode information in valid-looking output; schema checks are not a proof against covert channels. JavaScript strings are garbage-collected, not securely zeroed. This prototype is not a production password vault or a security audit.

## Run the synthetic checks

The original restricted invoice demonstration remains available:

```sh
node gateway/prototypes/credential-vault/chikin-demo.mjs --restricted
```

The Reddit-shaped fixture exercises the actual adapter in a fresh Chikin Browser, without contacting Reddit or requiring credentials:

```sh
node gateway/prototypes/credential-vault/reddit-synthetic.mjs
```

To have actual contained Codex drive that fixture:

```sh
node gateway/prototypes/credential-vault/reddit-synthetic.mjs --codex
```

The public-only Reddit preflight takes no credentials and cleans up afterward:

```sh
node gateway/prototypes/credential-vault/reddit-preflight.mjs
```

Its exit status is `0` when the public form appears, `2` when human verification is required, or `1` on error. None of these commands establishes that the real-account trial has succeeded. See [README.md](README.md) for the earlier prototype design and evidence.
