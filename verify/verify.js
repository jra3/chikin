#!/usr/bin/env node
import CDP from "chrome-remote-interface";
import { URL } from "node:url";
import { parseArgs } from "./args.js";
import { interpretProbe, PROBE_EXPRESSION } from "./probe.js";
import { formatPretty, formatJson } from "./format.js";

const SANNYSOFT_URL = "https://bot.sannysoft.com";

const SCRAPE_EXPRESSION = `
  (() => {
    const rows = [];
    document.querySelectorAll("table tr").forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      if (cells.length >= 2) {
        rows.push({
          label: cells[0].innerText.trim(),
          result: cells[1].innerText.trim(),
        });
      }
    });
    return rows;
  })()
`;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function runProbe(client) {
  const { Runtime } = client;
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: PROBE_EXPRESSION,
    returnByValue: true,
    awaitPromise: false,
  });
  if (exceptionDetails) {
    throw new Error(`probe eval failed: ${exceptionDetails.text}`);
  }
  return result.value;
}

async function scrapeSannysoft(hostPortOpts) {
  // Dedicated target. A fresh target avoids state from prior runs and
  // hangs on Page.enable() against the default target.
  const target = await CDP.New(hostPortOpts);
  const tab = await CDP({ ...hostPortOpts, target: target.id });
  try {
    await withTimeout(tab.Page.enable(), 5000, "Page.enable");
    await withTimeout(
      tab.Page.navigate({ url: SANNYSOFT_URL }),
      5000,
      "Page.navigate",
    );
    // Wait for load; if the event never fires, fall through after a cap.
    await Promise.race([
      tab.Page.loadEventFired(),
      new Promise((r) => setTimeout(r, 15000)),
    ]);
    await new Promise((r) => setTimeout(r, 2000));
    const { result } = await withTimeout(
      tab.Runtime.evaluate({ expression: SCRAPE_EXPRESSION, returnByValue: true }),
      5000,
      "scrape evaluate",
    );
    return result.value;
  } finally {
    try {
      await tab.close();
    } catch {}
    try {
      await CDP.Close({ ...hostPortOpts, id: target.id });
    } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = new URL(args.host);
  const hostPortOpts = {
    host: url.hostname,
    port: Number(url.port) || 9322,
  };

  let client;
  try {
    client = await CDP(hostPortOpts);
  } catch (e) {
    console.error(`could not connect to CDP at ${args.host}: ${e.message}`);
    console.error("is the chikin container running? try: docker compose ps");
    process.exit(2);
  }

  try {
    const raw = await runProbe(client);
    const rows = interpretProbe(raw);

    let sannysoft = null;
    if (!args.skipSannysoft) {
      try {
        sannysoft = await scrapeSannysoft(hostPortOpts);
      } catch (e) {
        console.error(`sannysoft check failed (continuing): ${e.message}`);
      }
    }

    const result = { rows, sannysoft };
    const out = args.json ? formatJson(result) : formatPretty(result);
    console.log(out);

    const required = rows.filter((r) => r.required);
    const allRequiredPass = required.every((r) => r.status === "pass");
    process.exit(allRequiredPass ? 0 : 1);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(3);
});
