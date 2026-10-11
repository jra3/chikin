# Drive a Browser over the gateway's own CDP socket, beside the child, not through it

`chikin_snapshot` (#96) and `chikin_act` (#99) are gateway-owned MCP tools that
read and act on a Browser without going through the chrome-devtools-mcp child.
Each call opens its own websocket to the page target
(`ws://<chikin-net ip>:<cdpPort>/devtools/page/<targetId>`). It sends a few
`Runtime.evaluate` and `Input.*` commands, then closes. The child's puppeteer
connection stays open beside it. They are the first pieces of #95, a fast
decision loop in which a small model picks a row of an indexed table rather than
a large model driving `take_snapshot` and `click{uid}` one round trip at a time.
`gateway/src/snapshot/` holds the code; the in-page scripts are Browser Use's
jev-ultrafast, verbatim (MIT).

## Why not through the child

The child runs one tool call at a time per session, behind a mutex nothing
outside it can see (ADR 0006). A loop built from injected child calls
(`callChild`) would wait that mutex out on every step. Its dozens of calls would
queue the client's own. One `take_screenshot` stuck on a background tab
would freeze the loop with no way to tell stuck from queued. There is also
nothing to call: upstream has no single-call viewport snapshot and no click that
checks what is under the pointer (its bundled puppeteer never calls
`elementFromPoint`). And `evaluate_script` answers in prose around a fenced
JSON block, the load-bearing-prose shape #75 already paid for once.

A socket of our own has none of that. Nothing queues in front of a command, so
a per-command deadline measures the command itself. That is the one place a
wall clock is honest, and the reason ADR 0006's objection to clocks does not
apply here. A stuck capture elsewhere in the session does not delay a snapshot,
and a snapshot does not delay the client.

## What it costs, and the rules that follow

- **Two drivers share one tab.** Chrome accepts any number of DevTools clients.
  The CDP lane's exclusivity (ADR 0005) is per Name between *drivers*, not per
  connection, so the gateway's socket coexists with the child's and with a
  `/json/*` read. Interleaving is possible, since a client's `navigate_page`
  can land between our check and our click. The guards are what make that
  safe. A row is executed only if, at execution time, its node's guard and
  the page key (or, for fill/scroll/wait, the whole-page marker) still equal
  what the read recorded, and the node's centre is not covered. Otherwise
  nothing is input and the page as it now is comes back with the refusal.
  `itest/act-guards.mjs` holds jev-ultrafast's guard cases against a real
  Browser.
- **The child does not see our navigation.** A click of ours that navigates
  leaves the nav watchdog's view (`navNewest.selected`) on the old URL. So the
  session remembers the tab it last read, by target id, together with the
  child's nav and selection counters at that moment. A later read stays on
  that tab while both counters are unchanged, and defers to the child's report
  once either moves. The memory is dropped on every child swap.
- **Gateway-owned does not mean free.** These tools bypass forwarding, so they
  must do by hand what forwarding does: be gated by identity, provision lazily
  and stamp browser activity. `isBrowserWork` admits the `owned` frame action
  beside `forward`, so the slot, the reap clock and the gate cannot disagree.
- **One owned call at a time per session.** Snapshot and act share a queue, so
  an act never runs against a read still in flight.
- **An input that landed is never reported as retryable.** Once input has been
  sent, a failure to read the page afterwards is reported as "done, read it
  again", never as an error. A caller told to retry a click clicks twice. A
  transport failure *between* the press and the release is the residual: it
  surfaces as a retryable error, and the socket dying there means the container
  is going away.
- **The page's main world carries our state.** `window.__jevFast` (node identity
  and guard closures) lives where the page and `evaluate_script` can see it.
  That is upstream's capability class already: `evaluate_script` runs in the
  same world. But a page could tamper with it to steer a guard. An isolated world
  (`Page.createIsolatedWorld`) is the fix if that ever matters.

## Considered options

- **Gateway-owned socket per call (chosen).** Above.
- **Compose from injected child calls (rejected).** It inherits the mutex, the
  prose parsing and the unbounded-call residual of ADR 0006, and loses the
  occlusion check.
- **Contribute a viewport snapshot and a hit-tested click upstream (deferred).**
  Worth doing, but chikin pins chrome-devtools-mcp for format stability (#75).
  Tool schemas are fixed per MCP session, and it would not give chikin the
  loop.
- **An owned background tab per loop (deferred).** jev-ultrafast acts in a tab it
  creates. Here that tab would appear in the child's `list_pages` with an id the
  client might select, and a background tab gets no animation frames under Xvfb.
  The act slice acts on the tab the client is already using instead.
