import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyClientFrame,
  identifyRequiredMessage,
  augmentInstructions,
  isBrowserWork,
  browserUnavailableMessage,
  reportedPages,
  navVerdict,
} from "../src/bridge.js";
import { Registry } from "../src/registry.js";
import { FleetFullError, ProvisionError } from "../src/provisioner.js";

// --- gate: which client frames are blocked before identify -----------------

test("gate: browser tools are blocked until identified, allowed after", () => {
  const nav = { method: "tools/call", params: { name: "navigate_page" } };
  assert.equal(classifyClientFrame(nav, false), "block", "browser tool blocked pre-identify");
  assert.equal(classifyClientFrame(nav, true), "forward", "browser tool passes post-identify");
});

test("gate: chikin_identify and chikin_reset are never gated", () => {
  const identify = { method: "tools/call", params: { name: "chikin_identify" } };
  const reset = { method: "tools/call", params: { name: "chikin_reset" } };
  for (const identified of [false, true]) {
    assert.equal(classifyClientFrame(identify, identified), "identify");
    assert.equal(classifyClientFrame(reset, identified), "reset");
  }
});

test("gate: non-tools/call methods always forward (never gated)", () => {
  for (const method of ["initialize", "tools/list", "ping", "notifications/initialized"]) {
    assert.equal(
      classifyClientFrame({ method }, false),
      "forward",
      `${method} must never be gated`,
    );
  }
});

// --- the browser-activity clock (issue #57) --------------------------------
// The plain idle clock is unusable as an activity signal for an attached
// session: client/bridge.mjs fires a JSON-RPC `ping` every 120s for the stated
// purpose of refreshing it, so it never ages past ~2 minutes however long the
// browser sits on about:blank. isBrowserWork is what the attached-tier reap TTL
// is measured against instead.

test("a heartbeat ping is NOT browser work (this is the whole of issue #57)", () => {
  assert.equal(isBrowserWork({ method: "ping" }, true), false, "the keepalive must not count");
  for (const method of ["initialize", "tools/list", "notifications/initialized"]) {
    assert.equal(isBrowserWork({ method }, true), false, `${method} is protocol, not browser work`);
  }
  assert.equal(isBrowserWork(null, true), false);
  assert.equal(isBrowserWork(undefined, true), false);
});

test("a forwarded tools/call IS browser work; gateway-owned and blocked ones are not", () => {
  const nav = { method: "tools/call", params: { name: "navigate_page" } };
  assert.equal(isBrowserWork(nav, true), true, "a real, forwarded tool call counts");

  // Blocked pre-identify: it never reaches the browser, so it is not activity.
  assert.equal(isBrowserWork(nav, false), false, "an identity-blocked call never reaches Chrome");
  // Gateway-owned tools are answered by the gateway itself, browser untouched.
  for (const name of ["chikin_identify", "chikin_reset"]) {
    for (const identified of [false, true]) {
      assert.equal(
        isBrowserWork({ method: "tools/call", params: { name } }, identified),
        false,
        `${name} is handled by the gateway, not the browser`,
      );
    }
  }
});

test("only browser work moves the browser-activity clock (a ping moves only `last`)", () => {
  const reg = new Registry();
  reg.touch("inst-1", 1000); // record created: both clocks start here

  // A heartbeat ping arrives at t=200000 — the pump calls touch() for any frame.
  reg.touch("inst-1", 200_000);
  let a = reg.getActivity("inst-1")!;
  assert.equal(a.last, 200_000, "protocol traffic refreshes the idle clock");
  assert.equal(a.lastBrowserActivity, 1000, "...but NOT the browser-activity clock");

  // Attaching / detaching an SSE stream is not browser work either: clients
  // routinely reopen that stream while idle between tool calls (server.ts).
  reg.streamOpened("inst-1", 300_000);
  reg.streamClosed("inst-1", 400_000);
  assert.equal(reg.getActivity("inst-1")!.lastBrowserActivity, 1000, "stream churn is not work");

  // A forwarded tools/call moves both.
  reg.touchBrowserActivity("inst-1", 500_000);
  a = reg.getActivity("inst-1")!;
  assert.equal(a.lastBrowserActivity, 500_000);
  assert.equal(a.last, 500_000, "real work is protocol traffic too");
});

// --- layer 3: the blocked-call error is actionable -------------------------

test("gating error names chikin_identify, the format, and an example", () => {
  const msg = identifyRequiredMessage("navigate_page");
  assert.match(msg, /chikin_identify/);
  assert.match(msg, /navigate_page/, "names the blocked tool");
  assert.match(msg, /1-32 chars/, "states the handle format");
  assert.match(msg, /"handle"/, "shows a worked example");
});

// --- lazy provisioning: the fleet-full error is now a TOOL error (issue #63) --
// It used to be an HTTP 429 on the MCP handshake, which took the whole session
// with it — and an MCP client fixes its tool registry at session start, so the
// caller could not get the browser lane back even after a slot freed. Now one
// call fails and the session is intact, so the message has to say so.

test("the fleet-full tool error names the cause, the tool, and that the session survived", () => {
  const msg = browserUnavailableMessage("navigate_page", new FleetFullError(8));
  assert.match(msg, /navigate_page/, "names the tool that failed");
  assert.match(msg, /fleet is full/, "and the real reason");
  assert.match(msg, /still registered/, "tells the caller nothing was lost");
  assert.match(msg, /[Rr]etry/, "and that retrying is the fix");
  assert.match(msg, /dashboard/, "fleet-full is the case the slot accounting explains");
});

// Anything that is NOT fleet-full lands here too — a Docker or socket-proxy
// failure. Sending the model to a page listing who holds the slots explains
// nothing when no slot is the problem, so the guidance has to branch.
test("a non-fleet-full failure gets guidance that actually applies", () => {
  const msg = browserUnavailableMessage("navigate_page", new ProvisionError("docker: 400 Bad request"));
  assert.match(msg, /navigate_page/, "names the tool that failed");
  assert.match(msg, /400 Bad request/, "and the real reason");
  assert.doesNotMatch(msg, /dashboard/, "no slot accounting to send it to");
  assert.match(msg, /Docker/, "names what actually failed");
  // Both branches must still say the session survived and the call is retryable
  // — that sentence is the fix for issue #63's reported impact.
  assert.match(msg, /still registered/, "tells the caller nothing was lost");
  assert.match(msg, /[Rr]etry/, "and that retrying is the fix");
});

// --- layer 1: initialize instructions are augmented, upstream preserved ----

test("augmentInstructions prepends chikin contract, preserving upstream text", () => {
  const result: { instructions?: string } = { instructions: "UPSTREAM DOC" };
  augmentInstructions(result);
  assert.match(result.instructions!, /chikin_identify/, "chikin contract present");
  assert.match(result.instructions!, /UPSTREAM DOC/, "upstream text preserved");
  assert.ok(
    result.instructions!.indexOf("chikin_identify") < result.instructions!.indexOf("UPSTREAM DOC"),
    "chikin text comes first",
  );
});

test("augmentInstructions works with no upstream instructions", () => {
  const result: { instructions?: string } = {};
  augmentInstructions(result);
  assert.match(result.instructions!, /chikin_identify/);
});

// --- nav watchdog: the stale-target wedge (issue #15) ----------------------
// The format below is chrome-devtools-mcp's real nav reply. If an upstream bump
// changes it, THIS is the test that fails — not the watchdog, silently.

const navReply = (body: string) => ({ content: [{ type: "text", text: body }] });

test("reportedPages parses the child's page block and the selected page", () => {
  const got = reportedPages(
    navReply(
      "Successfully navigated to https://example.org/.\n" +
        "## Pages\n" +
        "0: https://example.com/\n" +
        "1: https://example.org/ [selected]\n",
    ),
  );
  assert.deepEqual(got, {
    pages: ["https://example.com/", "https://example.org/"],
    selected: "https://example.org/",
  });
});

test("reportedPages returns null when no page block is present", () => {
  assert.equal(reportedPages(navReply("Successfully navigated.")), null);
  assert.equal(reportedPages({}), null);
  assert.equal(reportedPages(undefined), null);
});

test("a redirect landing on the page you're already on is NOT a wedge", () => {
  // The exact false positive that bounced healthy children: requested URL never
  // appears anywhere, and the page set does not move — but the child's view is
  // correct, so it is not wedged. (Observed live on Ancestry's legacy person-URL
  // redirect, reproduced with http->https on iana.org.)
  const reported = reportedPages(
    navReply("## Pages\n2: https://www.iana.org/help/example-domains [selected]\n"),
  );
  const real = ["https://www.iana.org/help/example-domains"];
  assert.equal(navVerdict(reported, real), "ok");
});

test("a child reporting a page the browser does not have IS a wedge", () => {
  const reported = reportedPages(navReply("## Pages\n1: https://old.example/stale [selected]\n"));
  const real = ["https://new.example/current"];
  assert.equal(navVerdict(reported, real), "wedge");
});

test("query and hash differences across a redirect do not count as a wedge", () => {
  const reported = reportedPages(navReply("## Pages\n0: https://example.com/doc?utm=x#frag [selected]\n"));
  assert.equal(navVerdict(reported, ["https://example.com/doc"]), "ok");
});

test("missing evidence is 'unknown', never a strike", () => {
  const reported = reportedPages(navReply("## Pages\n0: https://example.com/ [selected]\n"));
  assert.equal(navVerdict(reported, null), "unknown", "no CDP ground truth");
  assert.equal(navVerdict(null, ["https://example.com/"]), "unknown", "no child page block");
  assert.equal(
    navVerdict({ pages: ["https://example.com/"] }, ["https://other.example/"]),
    "unknown",
    "page block with nothing selected",
  );
});

test("a multi-tab child is judged on its SELECTED page, not the whole set", () => {
  const reported = reportedPages(
    navReply("## Pages\n0: https://a.example/\n1: https://b.example/ [selected]\n"),
  );
  assert.equal(navVerdict(reported, ["https://b.example/", "https://z.example/"]), "ok");
  assert.equal(navVerdict(reported, ["https://a.example/", "https://z.example/"]), "wedge");
});

// structuredContent is the machine-readable twin of the "## Pages" block and is
// what reportedPages reads first; the text parse is only the fallback.

test("reportedPages prefers structuredContent.pages over the text block", () => {
  const got = reportedPages({
    ...navReply("## Pages\n0: https://stale.example/ [selected]\n"),
    structuredContent: {
      pages: [
        { id: 0, url: "https://example.com/", selected: false },
        { id: 1, url: "https://example.org/", selected: true, isolatedContext: "work" },
      ],
    },
  });
  assert.deepEqual(got, {
    pages: ["https://example.com/", "https://example.org/"],
    selected: "https://example.org/",
  });
});

test("reportedPages falls back to the text block when structuredContent is absent or unusable", () => {
  const text = navReply("## Pages\n0: https://example.com/ [selected]\n");
  const expected = { pages: ["https://example.com/"], selected: "https://example.com/" };
  assert.deepEqual(reportedPages(text), expected);
  assert.deepEqual(reportedPages({ ...text, structuredContent: {} }), expected);
  assert.deepEqual(reportedPages({ ...text, structuredContent: { pages: [] } }), expected);
});

test("a structuredContent page list with nothing selected leaves selected unset", () => {
  const got = reportedPages({
    content: [],
    structuredContent: { pages: [{ id: 0, url: "https://example.com/", selected: false }] },
  });
  assert.deepEqual(got, { pages: ["https://example.com/"], selected: undefined });
  assert.equal(navVerdict(got, ["https://example.com/"]), "unknown");
});

test("the text parse tolerates the isolatedContext label upstream appends", () => {
  // 1.1.1 emits "<id>: <url>[ [selected]][ isolatedContext=<name>]". An anchored
  // parse drops such a line entirely, which silently blinds the watchdog for any
  // session using new_page's isolatedContext.
  const got = reportedPages(
    navReply(
      "## Pages\n" +
        "0: https://example.com/ isolatedContext=scratch\n" +
        "1: https://example.org/ [selected] isolatedContext=work\n",
    ),
  );
  assert.deepEqual(got, {
    pages: ["https://example.com/", "https://example.org/"],
    selected: "https://example.org/",
  });
});

test("the text parse reads the '## Pages' section only", () => {
  const got = reportedPages(
    navReply(
      "## Pages\n" +
        "0: https://example.com/ [selected]\n" +
        "## Extension Pages\n" +
        "1: chrome-extension://abc/popup.html\n" +
        "## Network requests\n" +
        "0: https://cdn.example/app.js\n",
    ),
  );
  assert.deepEqual(got, { pages: ["https://example.com/"], selected: "https://example.com/" });
});

// A strike must mean "the child is bound to a target the browser no longer has",
// never "the page moved after we looked" — so the child's view is checked
// against every CDP sample taken, starting with one contemporaneous with the
// reply. Anything else strikes healthy children on client-side redirects.

test("a page that moves on its own after the reply is NOT a wedge", () => {
  // meta refresh / window.location.replace / OAuth bounce / SPA pushState
  // landing inside the verify delay: correct at reply time, moved by the time
  // the delayed sample is taken.
  const reported = reportedPages(navReply("## Pages\n0: https://example.com/start [selected]\n"));
  const atReply = ["https://example.com/start"];
  const later = ["https://example.com/after-redirect"];
  assert.equal(navVerdict(reported, atReply, later), "ok");
});

test("a wedge is only called when the page is in NO sample", () => {
  const reported = reportedPages(navReply("## Pages\n0: https://old.example/stale [selected]\n"));
  assert.equal(
    navVerdict(reported, ["https://new.example/a"], ["https://new.example/b"]),
    "wedge",
  );
  // Ground truth that never arrived must not push the verdict either way.
  assert.equal(navVerdict(reported, null, null), "unknown");
  assert.equal(navVerdict(reported, null, ["https://old.example/stale"]), "ok");
  assert.equal(navVerdict(reported, ["https://old.example/stale"], null), "ok");
});
