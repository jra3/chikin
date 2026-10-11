# The gateway runs chikin_achieve's decision loop and holds the model key

`chikin_achieve` (#103) runs a read-decide-act loop: read the page as a table,
ask a fast model which row to do, do it with `chikin_act`'s guards, and repeat.
It runs inside the gateway process, in the session that owns the Browser, and
calls the Anthropic API with a key the gateway holds
(`CHIKIN_ANTHROPIC_API_KEY`). Before this the gateway held no paid credential
and made no outbound call of its own.

## Why in the gateway

The loop needs what only the session has: the Browser's `chikin-net` address,
the lazy attach, the owned-call queue, the remembered page and the activity
clock. A sidecar would have to sit on `chikin-egress` to reach the gateway
(ADR 0003), and would need its own way to reach the Browser. That is a second
CDP client with none of the session's bookkeeping. The Browser container is
the untrusted side of the network split (ADR 0002), so a key never goes there.
That leaves the gateway, which already has outbound egress for provisioning
and whose session closure already holds every piece the loop needs
(ADR 0007).

## What the key costs, and the rules that follow

- **The tool exists only when the key does.** It is listed only when a decision
  model is configured. An MCP client fixes its tool registry at session start,
  so a tool that can only answer "not configured" is worse than none. `/healthz`
  reports `achieve: true/false`, never the key. The dashboard and `/healthz`
  are unauthenticated, and `gateway/test/runtime.test.ts` holds that line.
- **The key's name is chikin-scoped.** Compose fills `${VAR}` from the
  operator's shell as well as from `.env`. A gateway knob called
  `ANTHROPIC_API_KEY` would pick up whatever the operator exported for other
  tools, and switch on a paid feature unasked.
  `gateway/test/compose-env.test.ts` fails the build if a bare name reappears.
- **Spend is bounded per call, not per gateway.** `max_steps` (at most 60) and
  `max_seconds` (at most 600) cap one call, and each step is one model call.
  Nothing caps the gateway's total spend across sessions. Anyone who can reach
  the MCP endpoint can spend the key, which is the same trust boundary as
  driving the golden profile's logins today (`GATEWAY_TOKEN`, loopback).
- **Page text is untrusted input to a model that now acts.** The rules tell the
  model that page text is data, never instructions. That is a mitigation, not a
  guarantee. The structural limits are what hold: only rows the page offers
  can be chosen, the guards run before every input, `allowed_origins` stops the
  loop off-site, and consequential rows wait for the caller unless
  `allow_consequential` is set.

## Considered options

- **In the gateway (chosen).** Above.
- **A sidecar service (rejected).** It would be isolated from the gateway's
  memory, but it would need its own network path to both the gateway and the
  Browser, plus a duplicate of the session's page and activity bookkeeping.
- **The caller's own model drives the loop (status quo, kept).** `chikin_snapshot`
  and `chikin_act` remain for any caller that would rather decide each step
  itself. `chikin_achieve` adds a mode; it does not replace one.
- **OpenRouter as a second provider (added).** `CHIKIN_OPENROUTER_API_KEY` sends
  the same decision to any OpenRouter model, used only when no Anthropic key is
  set. TypeSafe's Jev is hosted there, but only as `typesafe/jev-router`. That
  is a router that hands each request to a downstream model: GPT-6 Luna or
  DeepSeek V4.1 Flash in the 2026-10-11 runs. It is not the System One choice
  API jev-ultrafast calls, so it does not deliver Jev's 178 ms classifier
  latency. Each trace step names the model that actually answered.
- **TypeSafe's own choice API (deferred).** It needs a third key and a
  different request shape (choice heads), and cannot write a fill's text. The
  `Decider` interface (`gateway/src/loop/decider.ts`) is the seam if a
  classifier ever beats a generative model here on measured latency.
