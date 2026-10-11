# Jev Ultrafast as a chikin tool call

Research note, 2026-10-11. Not an ADR: nothing here is decided. `docs/` had no
research convention (only `adr/`, `INSTALL.md`, `original-design-notes.md`,
`superpowers/`), so this starts `docs/research/`.

**Question.** What would it take to give the MCP lane a goal-level tool,
working name `chikin_achieve({ goal, page?, budget })`, that runs a fast inner
loop inside the gateway (atomic snapshot -> indexed action table -> small
"System 1" model picks op + index -> execute under hit-test and freshness guards
-> repeat until DONE/BLOCKED) and returns the outcome plus a trace? The
snapshot/act primitives are documented as that loop's building blocks.

**Primary source.** `browser-use/jev-ultrafast`, public, MIT, commit `1231850`
(2026-09-18). Cloned to `/tmp/jev-research/jev-ultrafast`; file:line cites
below are against that commit. Secondary: the AgentsPulse write-up
(<https://agentspulse.github.io/tutorials/jev-ultrafast-browser-agent/>), checked
against the repo in section 1.4.

---

## 1. What Jev Ultrafast actually does

The runtime is ~590 lines of Python plus 107 lines of in-page JavaScript:
`jev_ultrafast/{agent,browser,model,questions}.py` and `snapshot.js`. The
README's table of files is accurate. Chrome is reached through
`browser-harness==0.1.13` (`pyproject.toml`), a sibling Browser Use package
whose `cdp(method, session_id=..., **params)` helper is the only browser API
used — every browser interaction is a raw CDP call, no Playwright/puppeteer.

### 1.1 Each claimed technique, cited

| # | Claim in the brief | Verified? | Where |
|---|---|---|---|
| 1 | Atomic DOM snapshot in one browser call: controls, accessible names, values, visible text, indexed action table | Yes | `snapshot.js` is one IIFE evaluated by a single `Runtime.evaluate` (`browser.py:188`). It walks `document.querySelectorAll(selector)` for `a[href],button,input,textarea,select,summary,[contenteditable],[role=...]` (`snapshot.js:24-27`), computes a name via `aria-labelledby` > `aria-label` > `<label>` > button value > `alt` > text content > `title` > `placeholder` (`:12-23`), filters to visible/enabled/in-viewport by `checkVisibility` + `getBoundingClientRect` centre inside the viewport (`:10-11, :57-59`), emits one `fill` and one `click` candidate per editable control and one `select` candidate per `<option>` (`:68-80`), caps at 250 (`:99-100`), appends synthetic `scroll_down`/`scroll_up`/`wait` (`:102-104`), and collects up to 6000 chars of **viewport-visible** text with a `TreeWalker` + `Range` bounds check (`:82-92`). |
| 2 | Small op vocabulary targeting indices, never selectors | Yes | Ops are `CLICK`, `TYPE_TEXT`, `SELECT` (from action kinds) plus `SCROLL_UP/DOWN`, `WAIT` (synthetic controls) plus `DONE`, `BLOCKED` (`model.py:51, :88-90`). Targets are `"1"`, `"2"`, ... or `"3:2"` for option 2 of element 3 (`model.py:73-76`). The model answer is validated against the offered set before anything executes (`model.py:30-45`); an unknown choice raises. Node identity is a code-owned integer from a `WeakMap` cache (`snapshot.js:3-7`); the model never sees a selector, backendNodeId or coordinate. |
| 3 | Scoped freshness checks on click (target + nearby context + form state) | Yes | `cache.pageKey()` = `[timeOrigin, href, scroll, viewport, every safe form field's (identity, value, checked, selectedIndex, disabled, readOnly)]` (`snapshot.js:44-46`). `cache.guard(e)` = the target's identity/role/name/value/aria state/href plus the `innerText` (6000 chars) of its nearest `form, dialog, article, li, tr, [role=row]` ancestor (`:47-54`). `Browser.fresh()` re-evaluates both for CLICK/SELECT and compares to the snapshot's copies (`browser.py:88-97`); every other op compares the **full** `marker` (URL, title, visible text, all semantic actions) (`:98`, marker at `snapshot.js:97-98`). Stale -> `StalePage`, the agent re-observes and re-predicts (`agent.py:59-64`). |
| 4 | Execution-time geometry resolve + hit-test, reject covered targets, retained node refs | Yes | `browser_operation("act")` evaluates: node still connected, not disabled/inert, `checkVisibility`, (for fill) not readOnly, bounding rect centre inside viewport, and **`e.contains(document.elementFromPoint(x,y))`** (`browser.py:144-151`). Null -> `StalePage("Target changed or is covered")`. Only then `Input.dispatchMouseEvent` pressed/released at the freshly computed centre (`:166-168`). Native `<select>` is set in-page with `input`+`change` events (`:152-158`), and a thrown evaluation there is a hard stop, not a retry, because the change event may already have fired (`:130-131, :162-163`). |
| 5 | Interaction-specific waits: 200 ms combobox, else <=2 rAF / 50 ms | Yes | `Browser.observe()` runs an in-page promise after the previous action: `setTimeout(finish, autocomplete ? 200 : 50)` racing `requestAnimationFrame` until `frames >= 2` and, for a `role=combobox` fill, until a visible `[role=option]` exists under `aria-controls`/`aria-owns` (`browser.py:44-76`). Explicit WAIT is `time.sleep(0.1)` (`:103-104`). |
| 6 | Focus emulation so a hidden tab isn't throttled, without fronting it | Partly | The tab is created with `Target.createTarget(url="about:blank", background=True)` and `Emulation.setFocusEmulationEnabled(enabled=True)` is sent on its session (`browser.py:23-27`). That is what the code does. **Whether it un-throttles rAF in a hidden tab is not something the repo demonstrates**: Chromium's command is documented as "simulating a focused and active page" (`Emulation.setFocusEmulationEnabled` in the protocol registry bundled at `gateway/node_modules/chrome-devtools-mcp/build/src/third_party/index.js`), i.e. `document.hasFocus()`/`:focus`, not page visibility. The 50 ms `setTimeout` fallback in #5 means the loop proceeds even if rAF never fires, so the claim is untested by its own design. See open question Q1. |
| 7 | No screenshots by default | Yes | `Agent(screenshots=False)` default (`agent.py:13`); capture only when `screenshots` or `record_dir` is set (`:21`, `browser.py:192-193`). The model request never contains an image (`model.py:107-117` sends `url,title,text,elements,recent_actions`). |
| 8 | CDP calls 1092 -> 101 per task | Yes, and more specific than the README | `docs/full-speed-measurement.json` `summary`: baseline median 1092 calls / 9450 ms, candidate 101 / 7092 ms, 3 pairs each. Counting is a monkeypatch of `browser_module.cdp` (`scripts/measure_flights.py:29-40`), so it counts calls the runtime made, not Chrome-internal traffic. Per-method breakdown for pair 1: **baseline 1102 calls = 828 `DOM.resolveNode` + 158 `Runtime.evaluate` + 40 `Runtime.callFunctionOn` + 30 `Accessibility.getFullAXTree` + 20 mouse events + ...; candidate 101 = 75 `Runtime.evaluate` + 20 `Input.dispatchMouseEvent` + 4 `dispatchKeyEvent` + 2 `insertText`.** The headline reduction is almost entirely "stop resolving every AX node to a handle on every observation". |
| 9 | Limits: no shadow DOM, frames, canvas, uploads, new tabs, nested scroll | Yes | README "Evidence and limits"; `docs/performance.md` "Limits"; `docs/design.md` "Boundaries". The code confirms: `querySelectorAll` on `document` only (no shadow roots, no frames); `safe()` drops `type=file` (`snapshot.js:9`); scroll is a wheel event at a fixed point (550,650) with delta +-560 (`browser.py:139`, `snapshot.js:102-103`), so only the main scroller moves. |

Two things the brief did not list but matter for a port:

- **Typing is select-all + `Input.insertText`**, not per-key typing (`browser.py:170-185`), after a real mouse click on the field. That is 4 CDP calls per fill regardless of text length.
- **Mutations are never retried; execution is logged before the next observation** (`agent.py:90-91, :120-141`; `AGENTS.md`). The loop also declares BLOCKED after three consecutive non-wait actions that changed nothing (`agent.py:153-157`). Budgets: 60 actions, 120 model calls (`questions.py:26`, `agent.py:75, :102`).

### 1.2 Tool call vs decision model

Split the repo by who decides:

| Layer | Files | Ships in chikin? |
|---|---|---|
| **Observe** — snapshot, indexed table, visible text, guards | `snapshot.js`; `browser.py:188-194` | Yes — the inner loop's observation primitive |
| **Act** — freshness check, geometry + hit-test, dispatch, post-action wait | `browser.py:88-107, :135-186, :44-76` | Yes — the inner loop's execution primitive |
| **Loop** — predict/act/observe, budgets, stale retry, BLOCKED detection, trace | `agent.py` | Yes, in TypeScript, as the body of `chikin_achieve` |
| **Decide** — op + target heads in one request, answer validation | `model.py:48-148` (TypeSafe), `questions.py` | The **request shape and validation**, yes; **TypeSafe itself, no** (section 2) |
| **Text helper** — JSON `{text}` from a small LLM for TYPE_TEXT | `model.py:151-198` | Needed: something has to produce the string to type. Section 2.3 |
| Inspector UI, screencast, demo renderer | `demo.py`, `static/`, `scripts/` | No |

### 1.3 Per-step cost, Jev vs chrome-devtools-mcp 1.1.1

The pinned child (`gateway/package.json`) is what the MCP lane pays today, so
the delta per step is worth stating from its source
(`gateway/node_modules/chrome-devtools-mcp/build/src/`):

| | Jev Ultrafast | `chrome-devtools-mcp` 1.1.1 (`take_snapshot` + `click`/`fill`) |
|---|---|---|
| Observation | 1 `Runtime.evaluate` returning table + text + guards | `take_snapshot` -> `TextSnapshot.create` -> puppeteer `accessibility.snapshot({includeIframes:true})` -> **1 `Accessibility.getFullAXTree` per frame** (bundled puppeteer, `Accessibility.snapshot`); uid = `${snapshotId}_${counter}` keyed by `loaderId_backendNodeId` (`TextSnapshot.js:28-58`). Node handles are **not** resolved at snapshot time; `getElementByUid` resolves one on use (`McpPage.js:236-259`). So upstream is nowhere near the 828-resolveNode baseline Jev measured against — that baseline was Browser Use's own older loop. |
| What the model reads | Viewport-visible controls + 6000 chars of visible text | Whole-document a11y tree (interesting nodes), including offscreen content |
| Click precondition | connected, visible, enabled, in viewport, **`elementFromPoint` hit-test** | puppeteer Locator: `#waitForVisibilityIfNeeded`, `#waitForEnabledIfNeeded`, `#waitForStableBoundingBoxIfNeeded`, then click at centre. **No occlusion hit-test**: the bundled puppeteer contains zero `elementFromPoint`/`elementsFromPoint` calls. A covered button is clicked through to whatever is on top. |
| Freshness | pageKey + scoped guard compared to the observed snapshot | None beyond "uid still resolves" (`McpPage.js:246-259`); a uid from an old snapshot clicks whatever that backendNodeId is now |
| Post-action wait | <=2 rAF / 50 ms; 200 ms for a combobox fill | `WaitForHelper.waitForEventsAfterAction`: 100 ms `expectNavigationIn` window, then MutationObserver stable-for-100 ms with a 3000 ms cap (`WaitForHelper.js:18-21, :30-66, :108-150`). Floor ~200 ms, ceiling ~3.1 s, per action |
| Fill | click + select-all + `Input.insertText` | Locator `fill()` with `defaultTimeout + 10 ms/char` (`tools/input.js` `fillFormElement`) |
| Focus emulation | explicit, on an owned background tab | bundled puppeteer has an `#emulateFocus` state that sends the command when `state.active`; I did not trace what enables it for the child's pages |
| Tab | creates and owns a background tab, closes it on exit | acts on the child's **selected** page |

The honest delta a chikin loop buys over "the calling LLM drives upstream
`take_snapshot`/`click`": the hit-test, the freshness guard, the viewport-scoped
smaller observation, ~4x less wait per action, and — the part that dominates
wall time — no big-model round trip per click (section 6).

### 1.4 Where the secondary article overreaches

The AgentsPulse piece is mostly faithful to the README. Three places it says
more than the repo supports:

- **"$0.0039 per task."** The article itself derives this from token counts x
  TypeSafe's list price ($0.042/Mtok input, output free — `docs.typesafe.ai/models.md`)
  plus the reported $0.00006272 OpenRouter charge. The repo publishes only the
  $0.00006272 (`docs/performance.md:32`) and says explicitly that TypeSafe
  "responses contain token counts without a billed dollar amount". Fine as an
  estimate; it is not a repo number.
- **"Focus emulation prevents hidden-tab animation throttling."** Repeated from
  the README; neither the README nor the code demonstrates it (row 6 above).
- **"Reduced ... 91%" presented as a runtime property.** The repo's own framing
  is narrower: three pairs, one task, one profile, sign-test p = 0.25
  (`docs/performance.md:13-18`), and the baseline is the project's own previous
  loop, which resolved every AX node per observation. Nothing in the repo
  compares against chrome-devtools-mcp, Playwright, or Browser Use's main agent.

---

## 2. The decision model: what Jev is, and what we would use instead

### 2.1 Jev / TypeSafe

- Jev is TypeSafe's hosted "System One" model: `POST https://api.typesafe.ai/v1/systemone`
  with `{ state, model: "jev-1.13.0" | "jev-latest", questions: { <id>: Question } }`;
  a `Question` is `choice` (returns `choice`, `probabilities`, `confidence`),
  `score`, or `noul` (0-1 truthiness). All questions in one request are
  evaluated in parallel against the one `state` (`docs.typesafe.ai/api.md`,
  `concepts/system-one.md`). Text-only input; 64k state+questions budget.
- **Hosted only.** `docs.typesafe.ai/llms.txt` lists no self-hosting, on-prem,
  or open-weights page; the only "deploy" content is the API. Pricing is per
  input token, $0.042/Mtok, output free (`models.md:13-18`).
- Jev Ultrafast's request (`model.py:81-117`) is: `state = { page: {url,title,text},
  elements: [{index,label,role,value,checked?,selected?,expanded?,operations}],
  recent_actions }`; `questions = { operation: choice over {CLICK,TYPE_TEXT,SELECT,
  SCROLL_UP,SCROLL_DOWN,WAIT,DONE,BLOCKED}, click_target: choice over clickable
  indices, type_text_target: choice over editable indices, select_target: choice
  over "idx:opt" }`. Only the head matching the chosen operation is consumed
  (`model.py:125-131`). TypeSafe's published limits for jev-1.13 (literal
  reading, no counting/arithmetic, option-order sensitivity, large irrelevant
  state — `model-jaggedness/jev-1.13.md`) are exactly the shape of a
  pick-from-a-table problem, which is why the runtime keeps the table small and
  viewport-scoped.
- **Using it from chikin is possible as a vendor dependency** (an API key in the
  gateway's env — note the compose-line rule in CLAUDE.md), with a 178 ms median
  decision latency on their numbers. It is not a prerequisite for the loop:
  `model.py` is 150 lines against an HTTP endpoint and `choose()` is the only
  contract the loop needs (`{choice, operation, target}` validated against the
  offered ids).

### 2.2 A substitute System 1: Claude Haiku 5.5

Facts from the `claude-api` skill reference (cached 2026-10-06), not memory:
`claude-haiku-5-5`, $0.10 / $0.50 per Mtok for prompts up to 100K tokens,
1M context, adaptive thinking on by default with effort defaulting to `medium`,
`thinking: {type: "disabled"}` accepted at effort `high` or below; refusals have
no server-side fallback on Haiku. The reference does **not** list Haiku 5.5
among the models that reject forced `tool_choice`, but since Opus 5.5 / Sonnet
5.5 / Fable 5.1 do, the portable shape is structured outputs
(`output_config.format`) with `strict`-style schemas rather than
`tool_choice: {type:"tool"}`.

Request shape for one decision (mirrors `model.py` so the loop code is the
same whichever backend answers):

```jsonc
// POST /v1/messages, model claude-haiku-5-5, thinking disabled, effort low,
// max_tokens ~256, output_config.format = JSON schema below
system: "<the NEXT_ACTION + TARGET rules from questions.py, verbatim> ... Reply only with the JSON object."
user:   {
  "goal": "...",
  "page": { "url": "...", "title": "...", "text": "<=6000 chars visible text" },
  "elements": [ { "index": 1, "role": "combobox", "label": "Where from?", "value": "San Francisco", "operations": ["TYPE_TEXT","CLICK"] }, ... ],
  "recent_actions": [ { "action": "...", "kind": "click", "text": null, "page_changed": true }, ... ],
  "allowed": { "operation": ["CLICK","TYPE_TEXT","SELECT","SCROLL_DOWN","WAIT","DONE","BLOCKED"],
               "click_target": ["1","3","7"], "type_text_target": ["1","2"], "select_target": ["5:1","5:2"] }
}
// schema: { operation: enum(allowed.operation), target: string|null, text: string|null,
//           confidence: number 0-1 } — additionalProperties false
```

Validation stays in code exactly as `model.py:30-45` does it: `operation` must
be in the offered set, `target` must be in the head for that operation, `text`
must be non-empty only for TYPE_TEXT. Anything else is a rejected decision (no
browser action), counted against the budget. Differences from Jev worth
designing around:

- Haiku returns one answer, not a probability distribution; the `confidence`
  field is self-reported. Jev's calibrated probabilities are what Jev Ultrafast
  uses for its BLOCKED/repeat heuristics only marginally (`agent.py:153-157`
  uses `page_changed`, not probabilities), so little is lost.
- Haiku can generate the TYPE_TEXT value in the same call (section 2.3), which
  removes Jev Ultrafast's second model round trip for text.
- Latency: not measured here. Haiku 5.5 with thinking off and a ~3-6K-token
  prompt is the number to measure first (Q4); 178 ms is Jev's bar.
- Prompt caching: the system prompt and the goal are stable across steps; the
  page state is not. Put the cache breakpoint after the rules.

A fine-tuned small open model is the other option the brief names. Nothing in
the repo or TypeSafe's docs provides training data or weights, so that path is
"collect traces from the Haiku-backed loop first". Not recommended as the first
slice.

### 2.3 The text helper

Jev Ultrafast needs a second, generative model for TYPE_TEXT because Jev cannot
generate (`model.py:151-198`; `questions.py` `TEXT_VALUE`), and it caches that
value across a stale retry only when the whole helper input is identical
(`agent.py:110-114`). With Haiku as the decider, the `text` field rides in the
same decision, and the cache rule becomes "the decision is consumed once;
a stale retry re-asks". Keep the `{"text": null}` = "value not inferable from
the goal" convention (`TEXT_VALUE`): it is what stops the model from inventing
personal data.

---

## 3. What chikin already has, and the sharp edges a loop trips

### 3.1 Relevant plumbing (all in `gateway/src/`)

- **Gateway-owned tools exist**: `chikin_identify` / `chikin_reset` are appended
  to `tools/list` replies (`bridge.ts:783-786`), classified before forwarding
  (`classifyClientFrame`, `:430`), handled by the gateway and answered with
  `replyTool` (`:1162`; `handleIdentify` `:1176`, `handleReset` `:1101`); they
  never reach the child. `chikin_achieve` is a third one of these.
- **The gateway can already reach the Browser's CDP over HTTP**: `realPages()`
  fetches `http://${currentIp}:${config.cdpPort}/json/list` (`bridge.ts:653-669`),
  and `chromeVersion()` reads `/json/version`. `currentIp` is the container's
  `chikin-net` address from `provisioner.resolveIp` (`provisioner.ts:597-606`),
  which is the pinned reverse-dial rule in CLAUDE.md (resolved IP, never a bare
  container name). The gateway has **no websocket client dependency**
  (`package.json`: sdk, chrome-devtools-mcp, dockerode, express, http-proxy),
  but Node >= 22 ships a global `WebSocket`, so a direct CDP session needs no
  new package. The CDP lane (`cdp.ts`) is a proxy, not a client; it does not
  help here.
- **Injected child calls exist**: `callChild(tool, args)` (`bridge.ts:629-648`)
  sends a `tools/call` on the child's stdio with a gateway-prefixed id, settled
  only by the reply or `clearChildState()`. That is how `FOREGROUND_TOOLS`
  activation works.
- **Lazy provisioning**: a session holds no container until the first frame
  `isBrowserWork()` accepts (`bridge.ts:1503-1515`); `ensureBrowser()` is the
  shared attach (`:1088-1096`); on `FleetFullError` the tool gets a retryable
  error, never a 429 (`attachThenForward`, `:1255-1264`).
- **Activity clocks**: `registry.touch` on any frame; `touchBrowserActivity`
  only for forwarded `tools/call` (`:1504`). The reaper reads the latter.
- **SSE keepalive**: `startSseKeepalive` writes `: keepalive` every
  `SSE_KEEPALIVE_MS = 30_000` into the GET stream and POST replies
  (`server.ts:67, :107`), so a tool call running for minutes does not hit
  undici's 300 s body timeout.
- **MCP SDK 1.29.0** (`@modelcontextprotocol/sdk`) supports
  `notifications/progress` keyed by the request's `_meta.progressToken` and
  `notifications/cancelled` (`types.js:47-49, :245, :598`). On the client side
  the SDK's default request timeout is `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`
  (`shared/protocol.js:8`), reset by progress only when the client passes
  `resetTimeoutOnProgress` (`:177-183`).

### 3.2 Three ways to implement the inner loop's browser side

**Option A — gateway-owned loop over a direct CDP websocket to the Browser (recommended).**
The `chikin_achieve` handler opens `ws://<currentIp>:9222/devtools/browser/<id>`
(from `/json/version`), attaches to a target with `Target.attachToTarget
{flatten:true}`, and runs `snapshot.js`/`act` verbatim as `Runtime.evaluate`
calls — a line-for-line port of `browser.py` to TypeScript, ~250 lines, plus
the loop (~150) and the Haiku client (~100).

- Trips: **lane exclusivity is by Name, not by connection.** `busyWith`
  (`cdp.ts:304-308`) refuses a second *driver*; Chrome itself accepts many CDP
  clients, and the child's puppeteer connection coexists with ours (the gateway
  already does `/json/*` reads beside it). But two drivers on one tab can
  interleave: the child's `WaitForHelper` MutationObserver sees our mutations,
  the child's selected page can navigate under its feet, and `window.__jevFast`
  lives in the main world where the client's `evaluate_script` can see it.
  Which tab the loop drives is a real decision (Q2): (a) an owned background
  tab via `Target.createTarget{background:true}` as Jev does — but the child
  auto-attaches to new targets, so it appears in `list_pages` with its own
  retired-never-reused id, and the client's next `select_page`/`take_screenshot`
  may land on it (the ADR 0006 trap, in reverse); or (b) the child's selected
  page, found by URL in `/json/list` — ambiguous when two tabs share a URL, the
  exact objection ADR 0006 recorded against `/json/activate`.
- Does **not** trip the child mutex: nothing here is a child tool call, so a
  stuck `take_screenshot` elsewhere in the session does not block the loop and
  the loop does not block the client's other calls. That is the main reason to
  prefer A over B.
- Must do by hand what forwarding does for free: call `ensureBrowser()` before
  the first step (the handler is gateway-owned, so `isBrowserWork` does not
  fire for it — `classifyClientFrame` returns `identify|reset|block|forward`,
  and a new branch `achieve` has to gate on identity *and* provision), and call
  `deps.registry.touchBrowserActivity(name)` **per step**, or a ten-minute loop
  reads as ten idle minutes on the dashboard and to the reaper (CLAUDE.md:
  "the gateway's idle clock is not a browser-activity clock").
- Must handle the container going away mid-loop: `chikin_reset`, the nav
  watchdog's respawn, or the unhealthy-container recreate change `currentIp`;
  the socket errors, and the loop must end the call with a retryable error
  carrying the trace so far, never reconnect silently (a mutation may have
  landed — the "never retry a mutation" rule from `AGENTS.md`).
- Sandbox note: `Runtime.evaluate` in the main world is what upstream's
  `evaluate_script` already does (`tools/script.js` `performEvaluation`), so
  this adds no new capability class.

**Option B — loop composed from injected child calls (`callChild`).**
Each step = `evaluate_script(snapshot.js)` + `evaluate_script(act)` through the
child, or `take_snapshot` + `click{uid}`.

- Trips everything ADR 0006 is about: every injected call waits the child's
  per-session mutex out with no clock (`callChild` deliberately has none), so
  one slow client call anywhere freezes the loop, and the loop's own dozens of
  calls queue the client's. Per-step floor is upstream's `WaitForHelper`
  (~200 ms to 3.1 s per action) on top of Jev's own waits. `evaluate_script`
  returns prose with a fenced JSON block (`script.js` `performEvaluation`) that
  the gateway would have to parse — the same load-bearing-prose problem #75
  recorded for `## Pages`. Using `click{uid}` instead loses the hit-test and
  freshness guards (section 1.3).
- Only merit: it acts on exactly the child's selected page, with no second
  driver. Not worth the mutex coupling.

**Option C — upstream contribution to `chrome-devtools-mcp`.**
A `take_snapshot{viewportOnly}` and a hit-tested `click` would be good upstream
PRs (the occlusion gap is real), but upstream is 1.9.0 and chikin pins 1.1.1
for format-stability reasons (#75), the tool schemas are fixed at session start
for every MCP client, and none of it gives chikin the goal-level loop. Pursue
as a side quest, not as the path.

### 3.3 The long-running tool call

`chikin_achieve` runs for seconds to minutes. Everything on this list is
already true or cheap:

| Concern | State |
|---|---|
| undici 300 s body timeout on the POST reply | Covered: `startSseKeepalive` on POST replies, 30 s period (`server.ts`). |
| Client-side request timeout | Not covered by the gateway. The MCP SDK client default is 60 s and only resets on progress if the client opted in; Claude Code's own MCP tool timeout is a client setting. Send `notifications/progress` per step when the call carries `_meta.progressToken` (section 4); document that a client without progress-reset needs a per-tool timeout. |
| Child tool mutex | Not involved in Option A. The loop and the client's ordinary calls interleave on the browser, not on the child. |
| "Nothing bounds a child call" (ADR 0006, #90) | Not inherited: the loop's own calls are CDP with an explicit per-call timeout (Jev's harness gives `Runtime.evaluate` 25 s; use the same order), and the loop has a step budget and a wall budget from `budget`. This is the one place a wall clock is legitimate, because the loop owns every call it is timing — ADR 0006's objection was to clocking calls *behind a mutex the clock cannot see*. |
| `MAX_FLEET` / provisioning | `ensureBrowser()` before step 1; fleet-full is the usual retryable tool error. |
| Activity stamping | `touchBrowserActivity` per step (above). |
| Session close mid-loop | `Session.close` must cancel the loop (abort the socket); the trace is lost with the session, which is fine. |
| Respawn / reset mid-loop | End the call with an error carrying the partial trace (above). |

Where the loop *lives*: in the gateway process, in `bridge.ts`'s session
closure (it needs `currentIp`, `ensureBrowser`, `replyTool`, `deps.registry`),
with the browser-side port in a new `gateway/src/achieve/` module so it is
testable against a fake CDP server the way `cdp.test.ts` fakes Chrome. A
sidecar process buys isolation the gateway does not need and would have to sit
on `chikin-egress` to be reachable (ADR 0003). Inside the Browser container is
wrong: the loop calls a model API and holds a key, and the container is the
untrusted side of the network split (ADR 0002).

---

## 4. Observability and cancel

- **Progress**: when the `tools/call` carries `_meta.progressToken`, emit
  `notifications/progress { progressToken, progress: step, total: budget.steps,
  message: "CLICK [7] Search" }` after each executed action. It is the only
  in-band signal the MCP transport offers mid-call, and it is what resets the
  SDK client's timeout. Clients that did not send a token get nothing until the
  end; that is the protocol.
- **Trace**: the result always carries the full step list — Jev Ultrafast's
  `history` record (`agent.py:121-141`: step, action label, kind, choice, text,
  latency, `page_changed`, url, elapsed) is the right shape, plus the final
  `{url, title}`, `status: done|blocked|budget|error`, and counts (steps, model
  calls, CDP calls, model tokens). Return it as `structuredContent` *and* a
  short text summary; the gateway controls this tool, so the structured channel
  is not subject to the `--experimentalStructuredContent` flag problem (#75).
  Also log one line per step on the gateway so the dashboard's session row can
  show "achieve: step 7/60".
- **Cancel**: honour `notifications/cancelled { requestId }` for the in-flight
  achieve: stop after the current action completes (never mid-mutation), reply
  with `status: cancelled` and the trace. Check the SDK's server-side
  `AbortSignal` on the request handler; if the raw-frame pump in `bridge.ts`
  bypasses it, match on `method === "notifications/cancelled"` in
  `http.onmessage` and look the id up. `chikin_reset` is the blunt cancel and
  already works (the socket dies).
- **Screenshots** stay off in the loop (Jev's default), both for speed and
  because the Xvfb background-tab capture hang (ADR 0006) is still live. The
  caller can `take_screenshot` afterwards through the normal path.

---

## 5. Permission and confirmation

Jev Ultrafast's guards answer "is this still the element I observed and can
the click land?" — not "is this click allowed?". The README says so
("A DONE choice still requires independent outcome verification"), the article
says so, and `agent.py` has no allow-list of any kind: the first step on a
page with a "Place order" button is one CLICK away. For a fleet that runs the
operator's logged-in golden profile (CLAUDE.md), that is the real risk of
shipping a loop at all.

What a policy hook looks like, in order of cost:

1. **Scope the goal.** `chikin_achieve` takes `allowed_origins` (default: the
   origin of the starting page). The loop refuses, as BLOCKED with reason, any
   step whose observed URL is off-list, and never follows a navigation off it.
   Cheap, code-only, catches the OAuth-hop and "open result in new site" cases.
2. **Classify the action before executing it.** A second question in the same
   Haiku call — "does this action submit a form, make a purchase, send a
   message, delete, sign in/out, or change account settings?" as a boolean —
   and a `confirm: "never" | "consequential" | "always"` parameter. On a
   consequential action with `confirm: consequential`, the loop ends with
   `status: needs_confirmation` and the trace, and the caller re-invokes with
   `resume_token`. This keeps the big model in the loop exactly where it adds
   judgement and nowhere else. It is the Managed-Agents `auto` permission
   shape, done client-side. Note Jev's literal-reading caveat applies to the
   classifier question as much as to the pick.
3. **Deny-list of element labels** (`"Buy"`, `"Pay"`, `"Delete"`, `"Send"`) is
   the obvious third layer and the one that lies most (localisation, icon
   buttons). Treat it as defence in depth, not policy.
4. **DONE is a claim.** Return it as `status: done` with the final visible text
   and URL and say in the tool description that the caller verifies. Jev
   Ultrafast's `examples/flights.py` has an independent verifier for exactly
   this reason.

The loop must also never type into `type=password` fields (`snapshot.js:9`
already drops them from the table) and should refuse goals that contain what
look like credentials; the golden profile is logged in, which is the point.

---

## 6. Cost and latency model

Per step today (calling LLM drives `take_snapshot` + `click` through the MCP
lane): one big-model round trip reading the whole a11y tree (often 5-20K
tokens), one `take_snapshot` (1 `getFullAXTree` per frame), one `click`
(resolve + locator waits + `WaitForHelper` 0.2-3.1 s), plus the gateway hop.
On Opus 5.5 at $4/$20 per Mtok that is roughly 2-10 cents and 5-20 s per step,
dominated by the model.

Per step in the loop: 1 `Runtime.evaluate` (snapshot, ~5-20 ms on Jev's
numbers: 75 evaluates = 2.25 s for 13 actions incl. guards and waits), 1-2
evaluates for freshness + hit-test, 2-4 input events, 1 evaluate for the
post-action wait (50-200 ms); one Haiku 5.5 call on ~3-6K input tokens (the
viewport-scoped table + 6K chars text + rules) and ~50 output tokens:
~$0.0005 per step, latency to be measured (Jev's 178 ms median is the bar;
Haiku with thinking off is the first thing to time, Q4). A 10-action task:
roughly 10 x (model latency + ~300 ms) plus page loads, versus 10 x
(5-20 s). Jev's own matched numbers are 7.1 s for 10 interactions on Google
Flights, with 17 decisions and 2 text calls.

The cost of the big model does not go to zero: it still states the goal, reads
the trace, verifies, and handles `blocked`/`needs_confirmation`. That is one or
two big-model turns per task instead of one per click.

---

## 7. Size of the work and the first slice

Rough sizes, gateway TypeScript:

| Piece | Est. lines | Notes |
|---|---|---|
| CDP session client (ws, attach, evaluate with timeout, input events) | 150 | Node 22 global `WebSocket`; fake Chrome in tests as `cdp.test.ts` does |
| `snapshot.js` + act script, shipped as string assets | 110 (verbatim JS) + 100 | Port of `browser.py:44-76, :135-194` |
| Loop: observe/decide/act, stale retry, budgets, BLOCKED detection, trace | 200 | Port of `agent.py` |
| Haiku decider: prompt, schema, validation | 120 | Port of `model.py` + `questions.py` |
| `chikin_achieve` tool: schema, classify branch, `ensureBrowser`, activity stamping, progress, cancel, structured result | 150 | In `bridge.ts` closure |
| Policy: `allowed_origins`, consequential-action classification, `needs_confirmation` / `resume_token` | 100 | |
| Tests: fake CDP, fixture page (port `static/fixture.html`), decider stub, lazy-provision and activity-stamp assertions, compose-env line for the API key | 400+ | `check_guards.py` lists the cases: moved/replaced/hidden/disabled controls, changed nearby context, overlay blocking, native select, text replacement, autocomplete arrival, navigation |
| Docs: README tool entry, ADR for "a gateway-owned loop drives the Browser over a second CDP connection", CLAUDE.md sharp edge on tab ownership | | |

Call it ~1,300 lines plus tests, two to three focused sessions, if the tab
question (Q2) is settled first.

**Recommended first slice** — a read-only primitive, `chikin_snapshot`:

- Gateway-owned tool over Option A's direct CDP connection, running
  `snapshot.js` on the child's selected page (located by URL from `/json/list`;
  refuse with an explicit error when the URL is ambiguous) and returning the
  indexed table + visible text as `structuredContent`.
- No mutations, so no permission question, no "never retry" question, no tab
  ownership question beyond "which one to read".
- It proves the three things everything else depends on: the second CDP
  connection coexisting with the child, the gateway-owned-tool branch with
  `ensureBrowser` + activity stamping, and that the snapshot is small and fast
  on the fleet's real pages (Ancestry, the sites in the golden profile).
- It is independently useful: the calling LLM can read it instead of
  `take_snapshot` and then `click{uid}` upstream. A measured token and latency
  comparison on real sessions is the evidence that decides whether the loop is
  worth building, before any model key goes into the gateway.

Second slice: `chikin_act({ index, op, text })` with freshness + hit-test, on an
owned tab. Third: the loop with Haiku and the policy hook. Jev's TypeSafe
backend can be a fourth, behind the same `choose()` interface, if the Haiku
latency is not good enough.

---

## 8. Open questions

- **Q1 — Does `Emulation.setFocusEmulationEnabled` matter under Xvfb?** Chikin's
  Chrome is headful with one window; a background tab is not composited (ADR
  0006). Focus emulation is about `document.hasFocus()`, not visibility, and
  the 50 ms fallback in Jev's wait means the repo never proves it. Experiment:
  on an isolated gateway (itest rules), create a background tab, enable focus
  emulation, count rAF callbacks over 1 s. If rAF stays throttled, the loop
  should run on the front tab or accept the 50 ms timeout path as the norm.
  Separately, it is **not** a cheaper fix for the screenshot hang: the capture
  needs a compositor surface, which focus emulation does not create.
- **Q2 — Which tab does the loop drive?** Owned background tab (Jev; clean, but
  it appears in the child's `list_pages` and can be selected by the client) vs
  the child's selected tab (no new tab; ambiguous by URL; two drivers on one
  page). A `Target.createTarget` + `Target.activateTarget` of our own tab for
  the loop's duration, restored after, is a third option and the one that
  sidesteps Q1 — but it fronts a tab the client did not choose.
- **Q3 — Is a second CDP client visible to the child in a way that breaks the
  nav watchdog?** `verifyNav` compares the child's reported pages to
  `/json/list`; an owned extra tab changes the list. Needs a test against
  `nav-watchdog.test.ts`'s fixtures.
- **Q4 — Haiku 5.5 decision latency** on a 4K-token pick-from-table prompt
  with thinking disabled, effort low, structured output. Nothing here is worth
  building if that is 2 s.
- **Q5 — Shadow DOM and frames.** Jev's snapshot ignores both. Upstream's a11y
  snapshot crosses iframes (`includeIframes:true`). The sites in the golden
  profile decide whether the loop needs `shadowRoot` traversal (cheap to add to
  `snapshot.js`) or frame attachment (not cheap: separate sessions, separate
  coordinate spaces).
- **Q6 — Where does the API key live?** A new env knob needs `config.ts`, a
  `docker-compose.yml` line, `.env.example` and the README table together, or
  `compose-env.test.ts` fails (CLAUDE.md). The gateway would then hold a paid
  credential; today it holds none.
- **Q7 — Tracking.** Filed as jra3/chikin #95 (the loop) and #96 (first slice,
  `chikin_snapshot`). Linear is no longer used for this repo.

---

## Sources

- Repo: <https://github.com/browser-use/jev-ultrafast> at `1231850` —
  `README.md`, `AGENTS.md`, `docs/design.md`, `docs/performance.md`,
  `docs/full-speed-measurement.json`, `jev_ultrafast/*`, `scripts/measure_flights.py`,
  `scripts/check_guards.py`, `tests/test_agent.py`.
- TypeSafe docs: <https://docs.typesafe.ai/> — `api.md`, `models.md`,
  `concepts/system-one.md`, `patterns/fan-out.md`, `model-jaggedness/jev-1.13.md`,
  `llms.txt` (fetched 2026-10-11).
- Secondary: <https://agentspulse.github.io/tutorials/jev-ultrafast-browser-agent/>
  (published 2026-09-28).
- Chikin: `CLAUDE.md`, `CONTEXT.md`, `docs/adr/0005`, `docs/adr/0006`,
  `gateway/src/bridge.ts`, `gateway/src/cdp.ts`, `gateway/src/provisioner.ts`,
  `gateway/src/server.ts`, `gateway/package.json`,
  `gateway/node_modules/chrome-devtools-mcp` 1.1.1 (`build/src/tools/{snapshot,input,script}.js`,
  `McpPage.js`, `TextSnapshot.js`, `WaitForHelper.js`, `ToolHandler.js`,
  bundled puppeteer 25.1.0 in `third_party/index.js`),
  `gateway/node_modules/@modelcontextprotocol/sdk` 1.29.0.
- Model facts: the `claude-api` skill reference (cached 2026-10-06).
