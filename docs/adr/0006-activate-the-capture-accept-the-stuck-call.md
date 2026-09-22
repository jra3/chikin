# Activate a capture's tab; accept that a stuck child call still freezes its session

`take_screenshot` is forwarded only after the gateway has brought its target tab
to the front, by injecting `list_pages` and `select_page{bringToFront}` on the
child's own stdio. Nothing bounds a child tool call that blocks anyway. A stuck
call still holds `chrome-devtools-mcp`'s per-session tool mutex until Puppeteer's
180s `protocolTimeout`, and every other call on that session still queues behind
it. That residual is **knowingly accepted here** and tracked as issue #90.

## Why the gateway activates, and not upstream

Chrome runs headful under Xvfb, so only a window's active tab is composited, and
`Page.captureScreenshot` defaults to `fromSurface: true`. A capture aimed at any
other tab waits for a frame that tab never produces. `chrome-devtools-mcp` never
activates the tab it captures: `bringToFront` appears only in `select_page`, in
the pinned 1.1.1 and still in 1.9.0, so a version bump does not fix it. Upstream
is aware of the mutex hazard in a neighbouring path, `WaitForHelper.js` caps an
evaluation "to avoid hanging until protocolTimeout while the tool mutex is
held", but the screenshot path has no such cap.

The gateway already intercepts tool families for other reasons and already reads
the child's `## Pages` block, so fronting the page before forwarding the capture
closes this for every client without a workflow rule nobody remembers.

## Why the tab is named by the id upstream printed

`McpContext.createPagesSnapshot` assigns `new McpPage(page, this.#nextPageId++)`
once per page object. Ids start at 1, are never reused, and are never renumbered,
and `getPageById` throws `No page found` for a retired one. So an id is unrelated
to a row's position in the block as soon as any tab has been closed. Counting
rows would front somebody else's tab and report success.

## Why not a deadline that replaces the child

A wall-clock deadline that failed the request and respawned the child was built
and backed out. It cannot distinguish a capture that is stuck from one that is
merely slow or merely queued, and every way of teaching it that distinction from
outside the child was wrong in a different way:

- **Retry amplification.** Failing retryably invites the client to retry into the
  same wall. Each respawn discards the child's MCP state, so page ids restart,
  the selection resets, prior `take_snapshot` uids are invalidated, and console
  and network history are lost. The session degrades on every attempt and the
  call never completes, where before it returned slowly.
- **The wrong interval.** Wall time from forwarding is not execution time. A
  `navigate_page{timeout: 60000}` holding the mutex made a healthy sibling
  capture's timer fire and respawn the child, failing both calls. A regression on
  ordinary batched calls.
- **Progress is not observable from here.** Counting any id-bearing child reply
  as progress counts the client bridge's 120s `ping`, which the MCP SDK answers
  from a default handler without ever reaching the tool mutex.
- **Behind looks like ahead.** Requests the client sends after the stuck call are
  queued behind it and can never complete, so they keep a re-arming rescue alive
  and push the respawn far past its intended bound.

Four defects in two review rounds, on a guard the issue itself offered only as a
fallback "in case the bridge is the wrong seam". The bridge was not the wrong
seam. Shipping the cure without the fallback is the smaller, truer change.

## The injected calls carry no clock either

The activation's own `list_pages` and `select_page` wait indefinitely for the
child to answer. They were first written with a 5s timeout, which is the same
mistake one section up: a clock started at send cannot see the tool mutex, so
the only call it can ever fire on is one that was merely queued behind an
ordinary long one. And firing bought nothing. On expiry the capture was
forwarded into the same FIFO behind the same injected `list_pages`, so the
client waited exactly as long either way — the timer's only effect was to lose
the activation and hand the capture the 180s hang this change exists to close.
Writing that into the fix, one section below where this document condemns it, is
the part worth recording.

So an injected call is settled by exactly three things: its reply,
`clearChildState()` at a child swap, and `clearChildState()` at session close.
No timing constant remains anywhere in the activation path.

## What a guard would have to satisfy

**This section runs ahead of the code.** Issue #90 lands it, and nothing in
`gateway/src` implements it today.

- Measure execution time. A call is executing only once every `tools/call`
  forwarded before it has replied, so that is when the clock starts.
- Count only `tools/call` replies as progress.
- Fix the set of calls ahead of the guarded one when the clock starts, rather
  than recomputing it from live state.
- Never make a slow but healthy call worse than it is now. Returning at 180s
  beats never returning.

## Why a capture that names its own page is left alone

`CDM_EXTRA_ARGS=--experimentalPageIdRouting` makes upstream route a page-scoped
tool by `params.pageId` rather than by the selected page (`ToolHandler.js`), so
a `take_screenshot{pageId}` reads a tab the activation was never aiming at.
Those captures are forwarded untouched.

Fronting the routed tab is not on offer. `select_page` is the only activation
upstream exposes, and its handler calls `context.selectPage(page)` before it
honours `bringToFront` (`tools/pages.js`), so it cannot bring a tab forward
without also selecting it. Honouring the routed target would move the session's
selection for good, and every later `take_snapshot`, `click` or `navigate_page`
that named no id would act on a page the client never chose. That was built
during #89 and reverted for exactly this.

Leaving it alone is also the only choice that cannot make things worse. The
routed tab is frequently the front one already, in which case fronting the
SELECTED tab takes the compositor frame away and hangs a capture that used to
return. Supporting routed captures properly needs a path that fronts without
selecting, which means CDP `Target.activateTarget` rather than a tool call. The
flag is off by default and nothing ships needing it, so that is not built.

## Considered options

- **Activate before forwarding (chosen).** One injected `list_pages` plus one
  `select_page{bringToFront}`, on the child's own tool mutex so nothing of the
  client's can overtake the pair. One pass in the common case and up to
  `ACTIVATION_PASSES` (three) when an id was retired under it or the client
  picked a page itself mid-activation. Fail-open everywhere: an unactivated
  capture is the old behaviour, a dropped one would be a new bug.
- **Bump `chrome-devtools-mcp`.** Checked against the 1.6.0 and 1.9.0 tarballs.
  `take_screenshot` still does not activate its page, so this does nothing.
- **Activate over CDP instead**, with `/json/activate/<targetId>`. It touches no
  child state, which is attractive, but the child reports its selection by URL
  and the gateway would have to guess which target that is when two tabs share a
  URL. Guessing wrong leaves the bug unfixed and silently so.
- **Chrome flags** such as `--disable-backgrounding-occluded-windows`. These
  govern window occlusion and renderer priority, not tab compositing. An inactive
  tab has no surface for any flag to keep warm.
- **A per-call deadline.** Backed out, for the reasons above. Issue #90.
