# Multi-arch chikin: amd64 (Chrome) + arm64 (Chromium)

**Date:** 2026-04-23
**Status:** Design — approved in chat, awaiting written review.

## Why

Today chikin ships as amd64-only. Apple Silicon users run under Rosetta (works but slow); Linux ARM users get `no matching manifest` and no prebuilt path. Google does not publish `google-chrome-stable` for Linux arm64, so true multi-arch means a hybrid: Google Chrome on amd64, Debian's Chromium on arm64.

The anti-detection signals chikin actually promises — absence of `HeadlessChrome` in UA, `navigator.webdriver` undefined, `navigator.plugins` non-empty, `navigator.languages` non-empty — are upstream Blink behavior and should hold identically on Chromium.

## Architecture

One Dockerfile, one entrypoint. Arch branching is confined to the install step via `ARG TARGETARCH` (Docker sets this automatically during `buildx` multi-platform builds).

### Dockerfile

- Keep the existing base, user, and runtime-lib install unchanged.
- Replace the Chrome-specific section with a conditional install:
  - `TARGETARCH=amd64`: install `google-chrome-stable` from Google's apt repo (status quo).
  - `TARGETARCH=arm64`: install the Debian `chromium` package; symlink `/usr/bin/chromium → /usr/local/bin/google-chrome` so the entrypoint stays arch-agnostic.
- No other Dockerfile changes. All Chrome flags used in `entrypoint.sh` (`--remote-debugging-port`, `--remote-allow-origins`, `--disable-blink-features=AutomationControlled`, `--no-sandbox`, `--disable-dev-shm-usage`, `--no-first-run`, `--window-size`, `--user-data-dir`) are upstream Blink/Chromium flags and work on both.

### entrypoint.sh

No changes. It continues to invoke `google-chrome`; the symlink on arm64 makes that resolve to the Chromium binary.

## Probe change

Demote the `window.chrome` check from required to informational.

### Rationale

`window.chrome` is defined on:
- Headed Chrome / Chromium ✓
- Modern `--headless=new` (default since Chrome 112) ✓

It is undefined only on legacy `--headless` (pre-2023). Gating pass/fail on it catches shrinking real-world attackers while adding uncertainty for the arm64 Chromium path. The `HeadlessChrome` UA substring check is the strong, version-stable signal; keep that as required.

### Changes

- `verify/probe.js`:
  - `windowChrome` row: `required: true → false`, `status: chromeOk ? "pass" : "fail"` → `status: "info"`.
  - Update label to note it is informational and why (legacy `--headless` only).
- `verify/test/probe.test.js`: update assertions to match the new informational status.

Remaining required checks: UA, `navigator.webdriver`, `navigator.plugins`, `navigator.languages`. Informational rows: `window.chrome`, `window.chrome.runtime`, WebGL vendor/renderer.

## CI

Native-runner matrix in `.github/workflows/build.yml`. No QEMU.

### Shape

```
jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: linux/amd64
            runner:   ubuntu-24.04
          - platform: linux/arm64
            runner:   ubuntu-24.04-arm    # GitHub free public-repo runner
    runs-on: ${{ matrix.runner }}
    steps:
      - checkout, setup-buildx, setup-node
      - build (per-platform, push-by-digest=true, push=true on non-PR)
      - run container, wait healthy, unit tests, integration verify
      - upload digest artifact (on non-PR)

  merge:
    needs: build
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - download digest artifacts
      - login to GHCR
      - docker buildx imagetools create — stitch digests into tagged manifest list
      - tags: latest (default branch), main (branch), sha-<short>, v* (semver)
```

### Testing

- Both matrix legs run unit tests and the integration test (`node verify.js --skip-sannysoft`) against their native-arch container. PRs test both; no external dependency.
- Merge only runs on push, same gating as today.

### Canary

`.github/workflows/sannysoft-canary.yml` stays amd64-only. Rationale: weekly external probe, matrixing doubles cost with minimal signal. Revisit if an arm64-only regression is observed in the wild.

## README updates

1. **"What you get"**: remove/soften the `window.chrome` line; it's no longer a pass/fail claim.
2. **New "Architecture & platforms" subsection** (placed near the top, alongside "What you do NOT get"):
   - amd64: Google Chrome stable.
   - arm64: Debian Chromium. UA says `Chromium/…`; no H.264/AAC codecs; anti-detection signals identical.
   - Apple Silicon: pulls arm64 natively — no Rosetta tax.
3. **New "Prerequisites" block** above Quickstart: Docker 20.10+ with Compose v2, Node ≥20 (for `verify.js`), ~1.5 GB disk for first build, note that first build takes 2–4 min.
4. **"Using the prebuilt image"** snippet: mention both arches resolve from the same tag.

## Non-goals

- No matrix on the canary workflow.
- No changes to `entrypoint.sh` logic (only the symlink delivers arch neutrality).
- No new probes (codec detection, mouse entropy, TLS fingerprint). The probe change is a demotion only.
- No attempt to make Chromium "look like" Chrome (UA rewrite, codec spoofing). Users who need that layer reach for `puppeteer-extra-plugin-stealth`.
- No Docker Desktop-specific troubleshooting additions beyond the platforms subsection.

## Open questions / contingencies

- **Chromium binary path**: Debian bookworm ships `chromium` at `/usr/bin/chromium`. Confirm during implementation; if it turns out to be `chromium-browser` (older convention), the symlink target adjusts. Zero impact on design.
- **`ubuntu-24.04-arm` availability**: GitHub made these free for public repos in 2025. If unavailable for any reason, fallback is a single-runner `buildx` with `platforms: linux/amd64,linux/arm64` using QEMU (slower, same result). Not expected to be needed.

## Acceptance criteria

- `docker compose up -d` works verbatim on Linux amd64, Linux arm64, and Apple Silicon macOS.
- `node verify.js --skip-sannysoft` passes on both arches in CI.
- GHCR `ghcr.io/jra3/chikin:latest` is a manifest list covering `linux/amd64` and `linux/arm64`.
- README clearly explains that arm64 = Chromium and why that's fine for the anti-detection use case.
