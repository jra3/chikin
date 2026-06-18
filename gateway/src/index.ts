import http from "node:http";
import { config } from "./config.js";
import { log } from "./log.js";
import { Registry } from "./registry.js";
import { Provisioner } from "./provisioner.js";
import { Reaper } from "./reaper.js";
import { createApp, makeUpgradeHandler } from "./server.js";

async function main(): Promise<void> {
  if (!config.token) {
    log.warn("GATEWAY_TOKEN is empty — bearer auth is DISABLED. Set it in production.");
  }

  const registry = new Registry();
  const provisioner = new Provisioner();

  // Fail fast if the fleet image is missing or the docker proxy is unreachable.
  try {
    await provisioner.checkImage();
    log.info(`fleet image '${config.image}' present`);
  } catch (e) {
    log.error("startup check failed", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // Clear leftover exited fleet containers from a previous run / reboot / crash
  // before they count against MAX_FLEET and block new browsers. Volumes are kept.
  try {
    const n = await provisioner.gcExited();
    if (n) log.info(`startup: removed ${n} leftover exited fleet container(s)`);
  } catch (e) {
    log.warn("startup: gc of exited containers failed", e instanceof Error ? e.message : String(e));
  }

  const reaper = new Reaper(registry, provisioner);
  reaper.start();

  const app = createApp({ registry, provisioner });
  const server = http.createServer(app);
  server.on("upgrade", makeUpgradeHandler());

  server.listen(config.port, config.host, () => {
    log.info(`gateway listening on http://${config.host}:${config.port}`);
    log.info(`  MCP:       POST http://${config.host}:${config.port}/b/<name>/`);
    log.info(`  dashboard: http://${config.host}:${config.port}/`);
  });

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    reaper.stop();
    server.close(() => process.exit(0));
    // Hard-exit backstop.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
