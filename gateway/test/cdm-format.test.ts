import test from "node:test";
import assert from "node:assert/strict";
import { McpResponse } from "chrome-devtools-mcp/build/src/McpResponse.js";
import { reportedPages, navVerdict } from "../src/bridge.js";

/**
 * The nav watchdog (issue #15) reads chrome-devtools-mcp's own reply to decide
 * whether the child is wedged, which means it depends on that reply's SHAPE —
 * knowingly fragile, and accepted only because the child's view is the one
 * signal that separates a wedged child from a healthy one that no-op'd on a
 * redirect.
 *
 * bridge.test.ts pins the format with literals. This pins it against the
 * DEPENDENCY: replies here are rendered by the vendored formatter itself
 * (`McpResponse.format`, the code path that produces every real page-scoped
 * reply), so bumping chrome-devtools-mcp off 1.1.1 in a way that changes the
 * page block or `structuredContent.pages` fails the build instead of silently
 * retiring the watchdog.
 */

const page = (url: string) => ({ url: () => url });

/** A real page-scoped reply from the pinned chrome-devtools-mcp. */
function realReply(urls: string[], selected: string, opts: { isolated?: Record<string, string> } = {}) {
  const pages = urls.map(page);
  const context = {
    getPages: () => pages,
    getPageId: (p: { url(): string }) => pages.indexOf(p as ReturnType<typeof page>),
    isPageSelected: (p: { url(): string }) => p.url() === selected,
    getIsolatedContextName: (p: { url(): string }) => opts.isolated?.[p.url()],
    getExtensionServiceWorkers: () => [],
  };
  const r = new McpResponse({ categoryExtensions: true } as never);
  r.setIncludePages(true);
  r.appendResponseLine("Navigated page successfully.");
  return r.format("navigate_page", context as never, {} as never) as {
    content: Array<{ type: string; text?: string }>;
    structuredContent: Record<string, unknown>;
  };
}

/** The same reply as a client that supports no structured output would see it. */
const textOnly = (reply: { content: unknown[] }) => ({ content: reply.content });

test("the pinned chrome-devtools-mcp still emits the page block the watchdog reads", () => {
  const reply = realReply(["https://example.com/", "https://www.iana.org/help/example-domains"], "https://www.iana.org/help/example-domains");
  // Fail loudly, and legibly, if upstream ever restyles this.
  assert.equal(
    reply.content[0].text,
    "Navigated page successfully.\n" +
      "## Pages\n" +
      "0: https://example.com/\n" +
      "1: https://www.iana.org/help/example-domains [selected]",
  );
  const expected = {
    pages: ["https://example.com/", "https://www.iana.org/help/example-domains"],
    selected: "https://www.iana.org/help/example-domains",
  };
  assert.deepEqual(reportedPages(reply), expected, "structuredContent path");
  assert.deepEqual(reportedPages(textOnly(reply)), expected, "text-block fallback path");
});

test("the isolatedContext label upstream appends does not blind the parser", () => {
  const reply = realReply(["https://example.com/", "https://example.org/"], "https://example.org/", {
    isolated: { "https://example.com/": "scratch", "https://example.org/": "work" },
  });
  assert.match(reply.content[0].text!, /1: https:\/\/example\.org\/ \[selected\] isolatedContext=work/);
  const expected = {
    pages: ["https://example.com/", "https://example.org/"],
    selected: "https://example.org/",
  };
  assert.deepEqual(reportedPages(reply), expected);
  assert.deepEqual(reportedPages(textOnly(reply)), expected);
});

test("extension pages are not mistaken for the pages the child acts on", () => {
  // Upstream puts them in their own "## Extension Pages" section, numbered the
  // same way; counting them as real pages would let a wedge read as healthy.
  const reply = realReply(
    ["https://example.com/", "chrome-extension://abcdef/popup.html"],
    "https://example.com/",
  );
  assert.match(reply.content[0].text!, /## Extension Pages\n1: chrome-extension:\/\/abcdef\/popup\.html/);
  assert.deepEqual(reportedPages(textOnly(reply)), {
    pages: ["https://example.com/"],
    selected: "https://example.com/",
  });
});

test("the live false positive and the live wedge, judged from real replies", () => {
  // Both replies below are what the child really sends; the only difference is
  // whether the browser still has the page it names. That is the whole fix.
  const canonical = "https://www.iana.org/help/example-domains";
  const redirected = realReply([canonical], canonical); // nav to the http:// form landed here
  assert.equal(navVerdict(reportedPages(redirected), [canonical]), "ok");

  const wedged = realReply(["https://app.example/stale"], "https://app.example/stale");
  assert.equal(navVerdict(reportedPages(wedged), ["https://app.example/moved"]), "wedge");
});
