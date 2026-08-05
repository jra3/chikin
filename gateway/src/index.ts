import http from "node:http";
import { config } from "./config.js";
import { log } from "./log.js";
import { Registry } from "./registry.js";
import { Provisioner } from "./provisioner.js";
import { Reaper } from "./reaper.js";
import { addRuntimeWarning, reportRuntimeConfig } from "./runtime.js";
import { createApp, makeUpgradeHandler } from "./server.js";
import { planBind } from "./bind.js";

async function main(): Promise<void> {
  // Backstop: a rejected promise outside any request handler (background reaper
  // sweep, bridge SSE pump, provisioner task) must not crash the single shared
  // gateway under Node's default unhandled-rejection policy. Log and carry on.
  // Request-handler rejections are already caught by the Express error backstop
  // in server.ts. See CHK-013.
  process.on("unhandledRejection", (reason) => {
    log.error(
      "unhandledRejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    );
  });

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

  // Say out loud what this PROCESS is configured with (not what .env on disk
  // says) — above all, whether new browsers get seeded profiles. See runtime.ts.
  await reportRuntimeConfig(provisioner);

  // Clear leftover exited fleet containers from a previous run / reboot / crash
  // before they count against MAX_FLEET and block new browsers. Named profile
  // volumes are kept.
  try {
    const n = await provisioner.gcExited();
    if (n) log.info(`startup: removed ${n} leftover exited fleet container(s)`);
  } catch (e) {
    log.warn("startup: gc of exited containers failed", e instanceof Error ? e.message : String(e));
  }

  // Belt and braces for issue #58: reclaim chikin-profile-inst-* volumes whose
  // container is long gone (they leaked at ~200 MB apiece before the reaper
  // removed them). Deliberately after gcExited, so containers it just removed
  // release their volumes in time for this pass. Scoped by NAME to inst-* with
  // no owning container — golden, hermes and named client profiles are never
  // candidates. CHIKIN_VOLUME_GC=0 disables it.
  if (config.volumeGc) {
    try {
      const sweep = await provisioner.sweepOrphanInstanceVolumes();
      if (sweep.removed.length) {
        log.info(
          `startup: reclaimed ${sweep.removed.length} orphaned instance profile volume(s)`,
          sweep.removed.join(" "),
        );
      }
      if (sweep.failed.length) {
        log.warn(`startup: ${sweep.failed.length} instance volume(s) could not be removed`);
      }
    } catch (e) {
      log.warn(
        "startup: orphan instance-volume sweep failed (nothing removed)",
        e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    log.info("startup: orphan instance-volume sweep disabled (CHIKIN_VOLUME_GC=0)");
  }

  const reaper = new Reaper(registry, provisioner);
  reaper.start();

  const app = createApp({ registry, provisioner });

  // Never listen on the browser data plane (CHK-002 / issue #20). HOST=0.0.0.0
  // would include chikin-net, putting this MCP endpoint — no bearer by default,
  // and hostOk is only a rebinding guard — within reach of every browser we
  // provision. See bind.ts. One listener per resolved address; an explicit HOST
  // is honoured as-is.
  const plan = planBind(config.host, await provisioner.selfEgressIp());
  if (plan.warning) {
    log.warn(plan.warning);
    addRuntimeWarning(plan.warning);
  }

  const servers = plan.hosts.map((host) => {
    const server = http.createServer(app);
    server.on("upgrade", makeUpgradeHandler());
    server.listen(config.port, host, () => {
      log.info(`gateway listening on http://${host}:${config.port}`);
    });
    return server;
  });
  log.info(`  MCP:       POST http://<listen-addr>:${config.port}/b/<name>/`);
  log.info(`  dashboard: http://127.0.0.1:${config.port}/`);

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    reaper.stop();
    let left = servers.length;
    for (const server of servers) {
      server.close(() => {
        if (--left === 0) process.exit(0);
      });
    }
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
