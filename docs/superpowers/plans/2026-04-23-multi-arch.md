# Multi-arch chikin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ghcr.io/jra3/chikin:latest` as a multi-arch manifest list covering `linux/amd64` (Google Chrome) and `linux/arm64` (Debian Chromium), tested natively on both.

**Architecture:** One Dockerfile branches installs via `ARG TARGETARCH`. On arm64 we install Debian's `chromium` and symlink `/usr/local/bin/google-chrome → /usr/bin/chromium` so `entrypoint.sh` stays arch-agnostic. The `window.chrome` probe check is demoted from required to informational (it's a weak signal now that `--headless=new` defines `window.chrome`). CI becomes a two-job workflow: a matrix across `ubuntu-24.04` and `ubuntu-24.04-arm` that builds, tests, and pushes each arch by digest, and a merge job that stitches digests into the final manifest list.

**Tech Stack:** Docker (`buildx`), GitHub Actions (native arm64 runners), Node ≥20 (verify), `chrome-remote-interface`.

**Spec:** `docs/superpowers/specs/2026-04-23-multi-arch-design.md`

---

## File Map

| File | Change |
|---|---|
| `verify/probe.js` | Demote `windowChrome` row: `required: false`, `status: "info"`; update label. |
| `verify/test/probe.test.js` | Update assertions for the new informational row. |
| `Dockerfile` | Add `ARG TARGETARCH`; branch Chrome vs Chromium install; create symlink on arm64. |
| `.github/workflows/build.yml` | Replace single-job with matrix `build` + `merge` jobs; push-by-digest + manifest list. |
| `README.md` | Add "Prerequisites" above Quickstart; add "Architecture & platforms" subsection; soften `window.chrome` line. |

Unchanged by this plan: `entrypoint.sh`, `docker-compose.yml`, `verify/verify.js`, `verify/args.js`, `verify/format.js`, `.github/workflows/sannysoft-canary.yml`.

---

### Task 1: Demote `window.chrome` to informational (TDD)

**Files:**
- Modify: `verify/test/probe.test.js`
- Modify: `verify/probe.js`

- [ ] **Step 1: Inspect current test assertions for `windowChrome`**

Run: `grep -n "windowChrome\|window.chrome\|hasWindowChrome" verify/test/probe.test.js verify/probe.js`

Expected: at least one assertion in `probe.test.js` that checks `required: true` and `status: "pass"`/`"fail"` for the `windowChrome` row.

- [ ] **Step 2: Update the test to assert the new informational behavior**

In `verify/test/probe.test.js`, find the test block that covers `windowChrome` and replace the relevant assertions. The row should always be `{ status: "info", required: false }` regardless of `hasWindowChrome` value; the `value` field should still reflect the input boolean.

Complete replacement for the `windowChrome`-specific test. If the existing test is named differently, keep the name but use this body:

```js
test("interpretProbe: windowChrome is always informational", () => {
  const raw = {
    userAgent: "Mozilla/5.0 Chrome/120 Safari/537.36",
    webdriver: undefined,
    pluginsLength: 1,
    languages: ["en-US"],
    hasWindowChrome: true,
    hasWindowChromeRuntime: false,
    webglVendor: null,
    webglRenderer: null,
  };
  const rows = interpretProbe(raw);
  const chromeRow = rows.find((r) => r.id === "windowChrome");
  assert.equal(chromeRow.status, "info");
  assert.equal(chromeRow.required, false);
  assert.equal(chromeRow.value, true);

  const rawMissing = { ...raw, hasWindowChrome: false };
  const rowsMissing = interpretProbe(rawMissing);
  const chromeRowMissing = rowsMissing.find((r) => r.id === "windowChrome");
  assert.equal(chromeRowMissing.status, "info");
  assert.equal(chromeRowMissing.required, false);
  assert.equal(chromeRowMissing.value, false);
});
```

Also scan the rest of `probe.test.js` for any test that asserts the overall `required` count or that `windowChrome` is required; update those to match the new count. The required rows after this change are exactly: `userAgent`, `webdriver`, `plugins`, `languages`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd verify && npm test`

Expected: failure in the `windowChrome` test — current `probe.js` still returns `status: "pass"` or `"fail"` with `required: true`.

- [ ] **Step 4: Update `probe.js`**

In `verify/probe.js`, replace the `windowChrome` block (currently uses `chromeOk`) with:

```js
  // Informational: window.chrome is defined on headed Chrome, Chromium, and
  // modern --headless=new. It is undefined only on legacy --headless (pre-2023),
  // which is a shrinking attack surface. The UA substring check above is the
  // strong, version-stable signal.
  rows.push({
    id: "windowChrome",
    label: "window.chrome is defined (informational — undefined only on legacy --headless)",
    status: "info",
    required: false,
    value: raw.hasWindowChrome,
  });
```

Delete the now-unused `chromeOk` local.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd verify && npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add verify/probe.js verify/test/probe.test.js
git commit -m "verify: demote window.chrome to informational

--headless=new also defines window.chrome, so the check catches only
legacy --headless. Keep reporting the value; stop gating on it. This
also removes a uncertainty for arm64 Chromium."
```

---

### Task 2: Multi-arch Dockerfile via `TARGETARCH`

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Rewrite `Dockerfile` with arch branching**

Replace the entire contents of `Dockerfile` with:

```dockerfile
FROM debian:bookworm-slim

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates tini xvfb socat \
      fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 \
      libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
      libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 \
      libxrender1 libxss1 libxtst6 xdg-utils \
  && if [ "$TARGETARCH" = "amd64" ]; then \
       wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
         | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
       echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
         > /etc/apt/sources.list.d/google-chrome.list && \
       apt-get update && apt-get install -y --no-install-recommends google-chrome-stable; \
     elif [ "$TARGETARCH" = "arm64" ]; then \
       apt-get install -y --no-install-recommends chromium && \
       ln -sf /usr/bin/chromium /usr/local/bin/google-chrome; \
     else \
       echo "chikin: unsupported TARGETARCH=$TARGETARCH" >&2 && exit 1; \
     fi \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r chrome \
 && useradd -r -m -d /home/chrome -g chrome -G audio,video chrome \
 && mkdir -p /data && chown -R chrome:chrome /data \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY --chmod=0755 entrypoint.sh /entrypoint.sh

USER chrome
WORKDIR /data

EXPOSE 9222

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]
```

Key notes for the reader:
- `ARG TARGETARCH` is auto-populated by `buildx` during multi-platform builds. For a plain `docker build` on an amd64 host it resolves to `amd64`.
- `google-chrome-stable`'s `.deb` is only published for amd64; that's why we branch.
- The symlink is `/usr/local/bin/google-chrome → /usr/bin/chromium`. `/usr/local/bin` is before `/usr/bin` in most $PATHs, but using an absolute path in the entrypoint would be equally safe — we keep the command `google-chrome` for arch symmetry and $PATH lookup.
- `chromium` on Debian bookworm installs the binary at `/usr/bin/chromium`. If the implementer finds it under `chromium-browser`, adjust the `ln -sf` target; the rest of the plan is unchanged.

- [ ] **Step 2: Build locally for amd64 and smoke-test**

Run:
```bash
docker compose build
docker compose up -d
for i in $(seq 1 30); do curl -fs http://localhost:9322/json/version >/dev/null && break; sleep 1; done
curl -s http://localhost:9322/json/version | grep -i chrome
```

Expected: final `curl` prints a JSON `Browser` field containing `Chrome/…` (not `HeadlessChrome/…`).

- [ ] **Step 3: Run verify against the live container**

Run: `cd verify && npm ci && node verify.js --skip-sannysoft`

Expected: exit code 0; all four required checks pass; `windowChrome` row shows `[INFO]`.

- [ ] **Step 4: Tear down**

Run: `docker compose down`

- [ ] **Step 5: Optional — cross-build arm64 via buildx emulation to verify the Chromium install step parses**

This is a slow sanity check (QEMU); skip if time-constrained. Real arm64 testing happens in CI.

```bash
docker buildx create --use --name chikin-multiarch 2>/dev/null || docker buildx use chikin-multiarch
docker buildx build --platform linux/arm64 -t chikin:arm64-test --load .
```

Expected: build completes without error. The `apt-get install chromium` step should succeed.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "feat: multi-arch Dockerfile — Chrome on amd64, Chromium on arm64

Google doesn't publish google-chrome-stable for linux/arm64. Install
Debian's chromium package there and symlink google-chrome → chromium
so entrypoint.sh stays arch-agnostic."
```

---

### Task 3: CI matrix + manifest-list merge

**Files:**
- Modify: `.github/workflows/build.yml`

- [ ] **Step 1: Replace `.github/workflows/build.yml` contents**

Overwrite the file with:

```yaml
name: build

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:

permissions:
  contents: read
  packages: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: linux/amd64
            runner: ubuntu-24.04
            short: amd64
          - platform: linux/arm64
            runner: ubuntu-24.04-arm
            short: arm64
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        if: github.event_name != 'pull_request'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build for testing (load into local docker)
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: ${{ matrix.platform }}
          load: true
          tags: chikin:ci
          cache-from: type=gha,scope=${{ matrix.short }}
          cache-to: type=gha,mode=max,scope=${{ matrix.short }}

      - name: Run container
        run: |
          docker run -d \
            --name chikin \
            --shm-size=2g \
            -p 127.0.0.1:9322:9222 \
            chikin:ci

      - name: Wait for healthy
        run: |
          for i in $(seq 1 30); do
            if curl -fs http://localhost:9322/json/version > /dev/null; then
              echo "CDP up after ${i}s"
              exit 0
            fi
            sleep 1
          done
          echo "CDP did not come up in 30s"
          docker logs chikin
          exit 1

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Unit tests (verify)
        working-directory: verify
        run: |
          npm ci
          npm test

      - name: Integration test (verify against live container)
        working-directory: verify
        run: node verify.js --skip-sannysoft

      - name: Dump container logs
        if: always()
        run: docker logs chikin > chrome.log 2>&1 || true

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: chrome-logs-${{ matrix.short }}
          path: chrome.log

      - name: Stop test container
        if: always()
        run: docker rm -f chikin || true

      - name: Push image by digest
        if: github.event_name != 'pull_request'
        id: push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: ${{ matrix.platform }}
          cache-from: type=gha,scope=${{ matrix.short }}
          outputs: type=image,name=ghcr.io/${{ github.repository }},push-by-digest=true,name-canonical=true,push=true

      - name: Export digest
        if: github.event_name != 'pull_request'
        run: |
          mkdir -p /tmp/digests
          digest="${{ steps.push.outputs.digest }}"
          touch "/tmp/digests/${digest#sha256:}"

      - name: Upload digest artifact
        if: github.event_name != 'pull_request'
        uses: actions/upload-artifact@v4
        with:
          name: digests-${{ matrix.short }}
          path: /tmp/digests/*
          if-no-files-found: error
          retention-days: 1

  merge:
    if: github.event_name != 'pull_request'
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Download digests
        uses: actions/download-artifact@v4
        with:
          path: /tmp/digests
          pattern: digests-*
          merge-multiple: true

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=sha,format=short
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Create manifest list and push
        working-directory: /tmp/digests
        run: |
          docker buildx imagetools create \
            $(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON") \
            $(printf 'ghcr.io/${{ github.repository }}@sha256:%s ' *)

      - name: Inspect result
        run: |
          docker buildx imagetools inspect \
            ghcr.io/${{ github.repository }}:${{ steps.meta.outputs.version }}
```

Key notes for the reader:
- The build-push-action is called twice: once with `load: true` so we can `docker run` it for testing, once with `push-by-digest` for GHCR. Both share GHA cache via `scope=${{ matrix.short }}` to keep amd64/arm64 caches separate.
- `push-by-digest=true` uploads unnamed image blobs. The `merge` job names them via `imagetools create -t <tag>`.
- `fail-fast: false` so an arm64 issue doesn't abort the amd64 run mid-debug.
- On PRs we skip login, push, and merge entirely — PR builds test both arches but don't touch the registry.

- [ ] **Step 2: Commit (do not push yet)**

```bash
git add .github/workflows/build.yml
git commit -m "ci: matrix build across amd64 + arm64 native runners

Each matrix leg builds, tests, and pushes its platform by digest.
A merge job stitches digests into the final tagged manifest list.
No QEMU."
```

---

### Task 4: README — Prerequisites + Architecture & platforms + soften `window.chrome`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add "Prerequisites" block above Quickstart**

In `README.md`, find the `## Quickstart` heading. Immediately before it, insert:

```markdown
## Prerequisites

- Docker 20.10+ with Compose v2 (the `docker compose` subcommand, not the older `docker-compose` standalone).
- Node.js ≥ 20 for `verify.js` (host-side, not inside the container).
- ~1.5 GB disk for the first build. First `docker compose up -d` takes 2–4 minutes to install Chrome/Chromium; subsequent starts are instant.

```

- [ ] **Step 2: Add "Architecture & platforms" subsection**

Find the `## What you do NOT get` section. Immediately after its closing bullet list, insert:

```markdown
## Architecture & platforms

The image is published as a multi-arch manifest covering:

- **linux/amd64** — Google Chrome stable. The default path; behaves exactly as Google ships Chrome on Linux.
- **linux/arm64** — Debian's Chromium package. Google does not publish `google-chrome-stable` for Linux arm64, so true-native arm64 means Chromium. The User-Agent says `Chromium/<ver>` instead of `Chrome/<ver>`, and the proprietary codecs Google bundles (H.264, AAC) are absent. The anti-detection signals chikin actually targets — absence of `HeadlessChrome`, `navigator.webdriver`, `navigator.plugins` populated — are upstream Blink and behave identically.

On **Apple Silicon Macs**, `docker compose up` pulls the arm64 image natively; no Rosetta emulation. On **Linux ARM**, same thing.

If you specifically need Google-branded Chrome on arm64 (e.g. a site that checks the UA for `Chrome/`), that's outside chikin's scope — you'd need a different base or a client-side UA override.

```

- [ ] **Step 3: Soften the `window.chrome` claim in "What you get"**

In `README.md`, find the bullet:

```
- `window.chrome` is defined (headless Chrome leaves it undefined).
```

Replace with:

```
- `window.chrome` is defined. Note: modern `--headless=new` also defines this, so it's no longer a reliable headless/headed discriminator — the UA check above is the strong signal.
```

- [ ] **Step 4: Verify the README renders cleanly**

Run: `grep -n '^## ' README.md`

Expected: clean ordered list of sections with no duplicates or out-of-order headings. Open the file and skim for broken markdown.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: prerequisites, arch & platforms, soften window.chrome claim"
```

---

### Task 5: Push and verify CI

**Files:** none.

- [ ] **Step 1: Push to `main`**

Run: `git push`

- [ ] **Step 2: Watch the CI run to completion**

Run: `gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status`

Expected: both `build (linux/amd64)` and `build (linux/arm64)` legs pass; `merge` job succeeds; manifest list inspect prints both platforms.

- [ ] **Step 3: Verify manifest list is live on GHCR**

Run:
```bash
TOKEN=$(curl -s 'https://ghcr.io/token?scope=repository:jra3/chikin:pull' | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://ghcr.io/v2/jra3/chikin/manifests/latest | jq '.manifests[] | {platform: .platform, digest: .digest}'
```

Expected: two manifests listed, one with `platform.architecture: amd64` and one with `platform.architecture: arm64`.

- [ ] **Step 4: Smoke-test the pulled arm64 image** (optional, requires arm64 host)

On an Apple Silicon Mac or Linux arm64 host:
```bash
docker run --rm --platform linux/arm64 --entrypoint google-chrome ghcr.io/jra3/chikin:latest --version
```

Expected: prints a Chromium version string.

- [ ] **Step 5: Done**

No commit in this task — just verification.

---

## Self-review notes

- **Spec coverage**: Every spec section maps to a task — Dockerfile → Task 2, probe demotion → Task 1, CI matrix → Task 3, README updates → Task 4, push/verify → Task 5. Non-goals from the spec (canary matrix, entrypoint changes, new probes) are absent from the plan as intended.
- **No placeholders**: Every code step has full content. The one "optional" step (arm64 smoke-test on a remote host) is optional by design, not a placeholder.
- **Type consistency**: Row `id: "windowChrome"` used consistently in both the test and the probe source. `TARGETARCH` literal values (`amd64`, `arm64`) match what `buildx` emits. Matrix `short` values (`amd64`, `arm64`) match cache scope keys and artifact suffixes consistently.
