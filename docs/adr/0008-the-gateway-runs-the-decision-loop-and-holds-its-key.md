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
- **OpenRouter as a second provider, and Jev through it (added).**
  `CHIKIN_OPENROUTER_API_KEY` is used only when no Anthropic key is set.
  OpenRouter serves TypeSafe's own System One endpoint (`/api/v1/systemone`).
  So the TypeSafe SDK, pointed at `https://openrouter.ai/api` with that key, is
  the default decider there (`jev-latest`). It is a port of jev-ultrafast's
  operation and target questions, with a small text model for fill values and
  one Jev yes/no question for the consequential check. In the 2026-10-11 live
  runs it reached the same outcomes as Haiku 5.5, 2 to 6 times faster end to
  end. Click decisions took 0.3 to 0.7 s including the consequential check.
  Fills took about 1 to 2 s, dominated by the text model. So when the goal
  quotes values, the same Jev request also asks one choice question per
  fillable field (the quoted strings plus NONE), and a confident pick is typed
  verbatim with no text-model call; the fill decision median fell from 1.3 s to
  0.25 s (#110). Thresholds and fallbacks live in `gateway/src/loop/jev.ts`.
  Any non-`jev-*` id is
  sent as an OpenRouter chat model instead. That includes `typesafe/jev-router`,
  which is a router to other LLMs (GPT-6 Luna, DeepSeek V4.1 Flash), not Jev.
