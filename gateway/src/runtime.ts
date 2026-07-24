import { config } from "./config.js";
import { log } from "./log.js";
import type { Provisioner } from "./provisioner.js";

/**
 * The effective runtime configuration of the RUNNING gateway.
 *
 * Container env is frozen at `docker create` time, so a correct `.env` on disk
 * proves nothing about the process: a gateway created from a directory where
 * compose never read that `.env` runs with entirely different values, and no
 * `docker restart` can ever fix it (only a recreate). Profile seeding was
 * silently OFF for ~7 weeks exactly that way — every check of the config on
 * disk said "configured", and diagnosing it needed a `docker exec`.
 *
 * So the gateway reports what IT actually has, on /healthz and the dashboard.
 * Both surfaces are unauthenticated (loopback + Host guard), so this must stay
 * free of secrets: GATEWAY_TOKEN is reported as a boolean, never its value.
 */
export interface RuntimeConfig {
  /** "" means seeding is OFF — new browsers get a blank (logged-out) profile. */
  seedVolume: string;
  seedingOn: boolean;
  chromeImage: string;
  sandbox: string;
  maxFleet: number;
  idleTtlSec: number;
  /**
   * Grace period for a browser whose client is still attached but which has run
   * no browser tool call. 0 means attached browsers are never reaped (the
   * pre-#57 behaviour). This is the knob an operator retunes when the fleet
   * saturates with idle sessions, so it has to be readable from the process.
   */
  attachedIdleTtlSec: number;
  /** Whether the startup sweep reclaims orphaned chikin-profile-inst-* volumes. */
  volumeGc: boolean;
  network: string;
  egressNetwork: string;
  sharedDir: string;
  windowSize: string;
  logLevel: string;
  /** Whether GATEWAY_TOKEN is set. Never the token itself. */
  authEnabled: boolean;
  extraOrigins: string;
  cdmExtraArgs: string[];
}

export function runtimeConfig(): RuntimeConfig {
  return {
    seedVolume: config.seedVolume,
    seedingOn: config.seedVolume !== "",
    chromeImage: config.image,
    sandbox: config.sandbox,
    maxFleet: config.maxFleet,
    idleTtlSec: Math.round(config.idleTtlMs / 1000),
    attachedIdleTtlSec: Math.round(config.attachedIdleTtlMs / 1000),
    volumeGc: config.volumeGc,
    network: config.network,
    egressNetwork: config.egressNetwork,
    sharedDir: config.sharedDir,
    windowSize: config.windowSize,
    logLevel: config.logLevel,
    authEnabled: config.token !== "",
    extraOrigins: config.extraOrigins,
    cdmExtraArgs: config.cdmExtraArgs,
  };
}

/** One unambiguous line stating whether new browsers are seeded. */
export function seedingLine(rc: RuntimeConfig = runtimeConfig()): string {
  return rc.seedingOn
    ? `seeding: ON (volume=${rc.seedVolume}) — every NEW browser is cloned from it`
    : "seeding: OFF (SEED_VOLUME unset — new browsers get blank profiles and start LOGGED OUT)";
}

/**
 * Config states that are almost certainly unintended. Pure so it can be tested
 * without Docker; `seedVolumes` is what the host actually has (see
 * Provisioner.findSeedVolumes).
 */
export function configWarningsFor(rc: RuntimeConfig, seedVolumes: string[]): string[] {
  const warnings: string[] = [];
  if (!rc.seedingOn && seedVolumes.length) {
    warnings.push(
      `SEED_VOLUME is unset in this gateway's environment, but seed volume(s) exist on the host ` +
        `(${seedVolumes.join(", ")}) — seeding is OFF and every new browser starts logged out. ` +
        `Set SEED_VOLUME in .env and RECREATE the gateway (docker compose up -d --force-recreate gateway); ` +
        `container env is fixed at create time, so 'docker restart' cannot pick up an .env change.`,
    );
  }
  return warnings;
}

// Warnings computed once at startup and rendered on /healthz + the dashboard.
// Empty until reportRuntimeConfig() runs (tests build the app without it).
let warnings: string[] = [];

export function configWarnings(): string[] {
  return warnings;
}

/**
 * Startup banner: dump the effective config and shout about seeding either way.
 * Also asks Docker whether a seed volume exists while SEED_VOLUME is unset —
 * the exact silent misconfiguration that wasted ~7 weeks — and records any
 * warnings for the operator-facing surfaces.
 */
export async function reportRuntimeConfig(provisioner: Provisioner): Promise<void> {
  const rc = runtimeConfig();

  // Seeding first and on its own line: this is the state that failed silently.
  if (rc.seedingOn) log.info(`config: ${seedingLine(rc)}`);
  else log.warn(`config: ${seedingLine(rc)}`);

  log.info("config: effective runtime configuration (this process, not .env on disk)", rc);

  let seedVolumes: string[] = [];
  try {
    seedVolumes = await provisioner.findSeedVolumes();
  } catch (e) {
    log.debug(`config: could not list volumes for the seed check: ${String(e)}`);
  }
  warnings = configWarningsFor(rc, seedVolumes);
  for (const w of warnings) log.warn(`config: ${w}`);
}
