# Deploying `codelibrary-amlegal-com-documentation` as a Linux Background Service

**This guide runs everything as `root`, by request** — no dedicated service user. That's simpler to operate but worth being clear-eyed about: this scraper downloads and executes a full browser engine against untrusted, remote content. Running it as root means a Chrome exploit or a malicious page has full-system reach instead of being contained to one low-privilege account. The systemd hardening directives kept throughout this guide (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, etc.) still meaningfully restrict what the process can touch even as root — a mitigation, not a substitute for the isolation a dedicated user would give you.

**Assumption used throughout:** the repo lives at `/codelibrary-amlegal-com-documentation` (a subfolder directly under `/`).

**Architecture support:** this guide now explicitly detects and branches on CPU architecture (`amd64` vs `arm64`), since **Google Chrome has no official Linux ARM64 build** — a real gap that breaks the original Chrome-based approach on ARM instances (AWS Graviton `t4g`/`m6g`/`m7g`, Raspberry Pi, Ampere, etc.). If you're on `amd64`, nothing about your workflow changes from before; the branching is there for when this ever gets deployed on ARM.

---

# Part 1: The Scraper Service (`main.js`)

## 0. What you're actually deploying

`main.js` is a **Puppeteer-driven Node.js scraper**. It launches a browser, authenticates against `codelibrary.amlegal.com`, discovers regions/clients, submits export jobs, polls them, and downloads the resulting `.txt` files into `./assets/<state>/`. It runs one full pass and **exits** — it's not a web server and doesn't listen on a port. A naive `systemd` unit with `Restart=always` and no delay would relaunch it the instant it exits — an infinite tight loop hammering amlegal.com. The service below re-runs it on a controlled interval instead.

**Target OS:** written and verified against recent Ubuntu (24.04+). Where a behavior is version- or architecture-dependent, it's called out explicitly.

---

## 1. Detect your CPU architecture

```bash
ARCH=$(dpkg --print-architecture)
echo "Detected architecture: $ARCH"
```

This returns `amd64` (Intel/AMD 64-bit — most EC2 `t3`/`m5`/`c5` instances, most desktops) or `arm64` (AWS Graviton `t4g`/`m6g`/`m7g`, Raspberry Pi 4+, Apple Silicon VMs, Ampere). `$ARCH` is referenced by name throughout the rest of this guide — set it now in every new shell session before continuing. (`dpkg --print-architecture` is used instead of `uname -m` because it returns the exact strings — `amd64`/`arm64` — that `apt` and Debian package names use; `uname -m` would return `x86_64`/`aarch64`, which don't match package-naming conventions directly.)

---

## 2. Update the package index

```bash
apt-get update -y
```

**What it does:** refreshes `apt`'s local cache of available packages. **Why:** you're about to add a new repo and install packages — skipping this risks a stale version or a 404 on a rotated mirror.

---

## 3. Install base system dependencies

```bash
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg xvfb fonts-liberation \
  libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libpangocairo-1.0-0 libpango-1.0-0 libgtk-3-0
```

**Architecture note:** every package in this list is multi-arch and available on both `amd64` and `arm64` from the standard Ubuntu repos — `apt` automatically pulls the correct build for your system's architecture. No per-arch changes needed here.

> **⚠️ Ubuntu 24.04+ "t64" note:** many libraries were renamed with a `t64` suffix in a 64-bit time-type migration (`libasound2` → `libasound2t64`). Most packages above auto-substitute via `apt` with a harmless `Note, selecting 'X64' instead of 'X'`. `libasound2` is the exception — on 24.04+ it's a _virtual_ package with two competing providers, so `apt` refuses to guess and errors with "no installation candidate" unless you name `libasound2t64` directly, as done above. On **older** Ubuntu (22.04/20.04, pre-t64) use this fallback instead:
>
> ```bash
> apt-get install -y --no-install-recommends libasound2t64 || apt-get install -y --no-install-recommends libasound2
> ```

| Package                                                                                                                                                                                                                                | Reason                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ca-certificates`                                                                                                                                                                                                                      | Root certificates so `curl`/npm/Chrome can validate HTTPS connections.                                                                                                                               |
| `curl`                                                                                                                                                                                                                                 | Fetches signing keys and install scripts (steps 5–6).                                                                                                                                                |
| `gnupg`                                                                                                                                                                                                                                | Verifies/converts GPG signing keys so `apt` trusts added repos.                                                                                                                                      |
| `xvfb`                                                                                                                                                                                                                                 | Virtual framebuffer/display server — lets Chrome/Chromium run against a real (virtual) display on a headless box, since some sites behave differently or block true `--headless` mode.               |
| `fonts-liberation`                                                                                                                                                                                                                     | Without any fonts installed, the browser renders pages with missing glyphs, which can break layout-dependent scraping.                                                                               |
| `libnss3`, `libatk-bridge2.0-0`, `libatk1.0-0`, `libcups2`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libasound2t64`, `libpangocairo-1.0-0`, `libpango-1.0-0`, `libgtk-3-0` | Shared libraries the browser binary is dynamically linked against. A minimal server image doesn't ship these by default; without them the browser fails with `error while loading shared libraries`. |

---

## 4. Verify available disk space

```bash
df -h /
```

**Why:** the browser (~200–350 MB), Node + `node_modules` (including Puppeteer's own bundled Chromium download on `amd64` — see step 6's note), and the scraped `.txt` output (43 regions — this will grow into the GBs over time) all add up. Confirm at least **5 GB free**, and set up the disk monitoring in step 15 so you find out from an alert, not a failed scrape.

---

## 5. Install the browser (architecture-dependent)

### If `$ARCH` = `amd64`: install Google Chrome

Google only publishes Chrome for `amd64` Linux, through its own repo:

```bash
if [ "$ARCH" = "amd64" ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
  CHROME_BIN=/usr/bin/google-chrome-stable
fi
```

The `arch=amd64` restriction in the repo line is deliberate and correct — it's _why_ this repo is skipped entirely on an `arm64` host rather than erroring.

### If `$ARCH` = `arm64`: install Chromium instead

There is no Google Chrome ARM64 Linux build — full stop, this isn't a workaround-able gap. Use the open-source Chromium build instead:

```bash
if [ "$ARCH" = "arm64" ]; then
  apt-get install -y chromium
  CHROME_BIN=$(readlink -f "$(command -v chromium || command -v chromium-browser)")
fi
```

**Critical check for this branch — Ubuntu's `chromium` package is often a snap wrapper, not a real binary:** since Ubuntu 19.10+, `apt install chromium` on stock Ubuntu frequently installs a thin transitional package that pulls the actual browser from the Snap Store on first run. A snap-confined browser is a poor fit here — it needs `snapd` running, uses its own sandboxing that can conflict with this guide's `systemd` hardening (`ProtectSystem=strict` in particular), and its binary path isn't a stable, predictable location. Check which you got:

```bash
echo "$CHROME_BIN"
if [[ "$CHROME_BIN" == /snap/* ]]; then
  echo "This is a snap-confined Chromium -- see the note below before continuing."
else
  echo "Real binary -- proceed as normal."
fi
```

If it resolves under `/snap/`, you have two real options, in order of preference:

1. **Use a non-snap Chromium source** — Debian's own `chromium` package (as opposed to Ubuntu's) is a genuine `.deb`, not a snap wrapper. If you're deploying on Debian rather than Ubuntu, or can switch base images, this sidesteps the issue entirely.
2. **Allow the snap and adjust the systemd unit** — install `snapd`, let `chromium` run confined, and drop `ProtectSystem=strict` down to `ProtectSystem=false` (or carefully allowlist the snap's mount points) in step 12's service file, since strict filesystem protection and snap's own confinement don't coexist cleanly. This trades away some of the sandboxing this guide otherwise relies on.

Test whichever binary you land on works before moving further:

```bash
"$CHROME_BIN" --version
```

### Verify (either architecture)

```bash
echo "Using browser binary: $CHROME_BIN"
"$CHROME_BIN" --version
```

---

## 6. Install Node.js and `npm`

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs npm
```

NodeSource's install script and repo serve both `amd64` and `arm64` builds automatically based on your system's architecture — no branching needed here.

**Two gotchas this addresses (both hit during setup of this exact deployment):**

1. **NodeSource vs. distro-provided Node:** older Ubuntu releases often carry a Node version a year+ out of date, which is why NodeSource is used. On newer releases where Ubuntu's own repo already ships a newer Node than NodeSource's pinned `20.x`, `apt` keeps the distro package and reports `nodejs is already the newest version` — that's fine, a newer Node still satisfies this project's requirements.
2. **`npm` is a separate package from `nodejs`** on Debian/Ubuntu, in either repo. Installing `nodejs` alone does not install `npm`.

**Verify:**

```bash
which -a node
which -a npm
/usr/bin/node --version
/usr/bin/npm --version
```

Any Node v18+ is fine.

**Note on Puppeteer's bundled Chromium download:** on `amd64`, `npm install` (step 9) will download Puppeteer's own bundled Chromium (~200 MB) since this repo doesn't set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` — harmless, it just goes unused since `PUPPETEER_EXECUTABLE_PATH` points at system Chrome instead. On `arm64`, Puppeteer's Chrome-for-Testing downloads are **not officially published for Linux ARM64** (a long-standing upstream gap) — the download step may simply fail or silently skip depending on Puppeteer's version. Either way this doesn't block you: `CHROME_BIN`/`PUPPETEER_EXECUTABLE_PATH` overrides it regardless of whether the bundled download succeeded.

---

## 7. Set the application directory

```bash
APP_DIR=/codelibrary-amlegal-com-documentation
```

Every command below references `$APP_DIR` and `$ARCH`/`$CHROME_BIN` — set these in your current shell before continuing (and again in any new shell session).

---

## 8. Clone the repository

```bash
git clone https://github.com/CoreData-Labs/codelibrary-amlegal-com-documentation.git "$APP_DIR"
```

`git clone <url> /` fails outright — `git clone` refuses to clone into a non-empty directory, and root's filesystem obviously isn't empty. Give it a destination folder name, not `/` itself. No `chown` step is needed since everything runs as root and root already owns the cloned files.

---

## 9. Install Node dependencies

```bash
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --prefix "$APP_DIR" --omit=dev
fi
```

- **`npm ci` over `npm install` when a lockfile exists** — this is a real production-readiness upgrade over earlier versions of this guide. `npm ci` installs exactly what `package-lock.json` specifies (no version drift, no silent upgrades), deletes and rebuilds `node_modules` from scratch for a clean state, and is faster in CI/deployment contexts. `npm install` is kept as a fallback only if the repo doesn't ship a lockfile.
- `--omit=dev` — skips `devDependencies` (test/lint tooling) for a leaner production install.

**Note on running as root:** modern `npm` runs package lifecycle scripts fine as root; the old `--unsafe-perm` flag is no longer needed for this to work in current npm versions. If you do see permission-related install failures on some native-module build script, retry with `--unsafe-perm=true` appended.

---

## 10. Manual test run before wiring up systemd

**Always verify interactively before automating** — far easier to debug a visible failure here than in `journalctl` later.

```bash
cd "$APP_DIR"
PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN" xvfb-run -a --server-args="-screen 0 1920x1080x24" node "$APP_DIR/main.js"
```

- `cd "$APP_DIR"` — **required.** `main.js` creates/writes `./assets/` using a path relative to the process's working directory. Running from the wrong directory (e.g. `/`) makes it try to create `assets/` there instead, which fails with `EACCES: permission denied, mkdir 'assets'`.
- `PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"` — points Puppeteer at whichever browser binary step 5 resolved for your architecture, instead of a bundled copy.
- `xvfb-run -a` — auto-selects a free virtual display, runs the command against it, tears the display down on exit.
- `--server-args="-screen 0 1920x1080x24"` — 1920×1080 at 24-bit color, so responsive/viewport-dependent pages render like a normal desktop browser.

Let it run for a few minutes and confirm files are actually appearing:

```bash
ls -la "$APP_DIR/assets/" | head -20
find "$APP_DIR/assets" -name "*.txt" | wc -l
```

---

## 11. Production tuning: memory, file descriptors, startup time

A few settings worth setting deliberately rather than relying on defaults, especially since browser automation is memory- and file-descriptor-hungry:

- **`NODE_OPTIONS=--max-old-space-size=1536`** — caps Node's own heap below the service's hard `MemoryMax` (step 12). Without this, Node only realizes it's out of memory when the OS OOM-kills the whole process abruptly; with a heap ceiling set below the systemd limit, Node's own garbage collector gets a chance to react first, which tends to fail more gracefully (an in-process error you can log and handle) rather than a hard kill mid-write.
- **`LimitNOFILE=65536`** — headless Chrome/Chromium can open a surprising number of file descriptors (sockets, shared memory segments, temp files) under sustained load. The default per-process limit (often 1024) can cause obscure `EMFILE`/`too many open files` failures deep into a long scrape run that look unrelated to the real cause.
- **`TimeoutStartSec=120`** — browser startup can be slow on constrained instances, especially burstable ARM types (`t4g`) once CPU credits are exhausted. The systemd default startup timeout (90s) can be tight; 120s gives more headroom before systemd considers the start attempt failed.
- **Burstable instance CPU credits (`t3`/`t4g` families):** if this runs on a burstable EC2 type, sustained scraping can exhaust CPU credits, causing throttled performance and inconsistent Puppeteer timing later in a run than at the start. Worth monitoring `CPUCreditBalance` in CloudWatch if you're on one of these, or sizing to a non-burstable type if consistent throughput matters more than cost.

These are folded into the systemd unit in the next step.

---

## 12. The systemd service file

```bash
tee /etc/systemd/system/codelibrary-scraper.service > /dev/null <<EOF
[Unit]
Description=AM Legal Codelibrary Scraper (codelibrary-amlegal-com-documentation)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=86400
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=1536
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1920x1080x24" /usr/bin/node $APP_DIR/main.js
Restart=always
RestartSec=3600
TimeoutStartSec=120
TimeoutStopSec=30
LimitNOFILE=65536
MemoryMax=2G
CPUQuota=150%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codelibrary-scraper

[Install]
WantedBy=multi-user.target
EOF
```

**Directive-by-directive explanation:**

| Directive                                            | Why it's set this way                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `After=`/`Wants=network-online.target`               | Prevents starting before the network is usable.                                                                                                               |
| `StartLimitIntervalSec=86400` / `StartLimitBurst=10` | If the process keeps crashing immediately, systemd gives up after 10 restarts within 24h instead of looping forever.                                          |
| `Type=simple`                                        | The process in `ExecStart` _is_ the main process.                                                                                                             |
| _(no `User=`/`Group=`)_                              | Runs as `root`, systemd's default when these are omitted — the deliberate simplification for this deployment.                                                 |
| `WorkingDirectory=`                                  | `main.js` writes to the relative path `./assets/` — this must point at the repo root.                                                                         |
| `Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN`  | Resolved per-architecture in step 5 — Google Chrome on `amd64`, Chromium on `arm64`.                                                                          |
| `Environment=NODE_OPTIONS=--max-old-space-size=1536` | Caps Node's heap below `MemoryMax`, so Node's own GC gets a chance to react to memory pressure before a hard OOM kill.                                        |
| `ExecStart=`                                         | Identical to the step 10 manual test, with absolute paths — systemd doesn't use your shell's `$PATH`.                                                         |
| `Restart=always` + `RestartSec=3600`                 | `main.js` finishes a pass and exits normally; this is what makes the "service" continuous — systemd waits an hour, then restarts it. **Primary tuning knob.** |
| `TimeoutStartSec=120`                                | Gives slower/burstable instances enough headroom to finish browser startup before systemd considers the attempt failed.                                       |
| `TimeoutStopSec=30`                                  | Caps how long systemd waits for graceful exit before force-killing.                                                                                           |
| `LimitNOFILE=65536`                                  | Raises the file-descriptor ceiling for sustained browser automation workloads.                                                                                |
| `MemoryMax=2G`                                       | Hard ceiling; OOM-killed (then restarted) rather than starving the host. Adjust to instance size.                                                             |
| `CPUQuota=150%`                                      | Caps CPU to 1.5 cores' worth. Raise/remove on a dedicated instance.                                                                                           |
| `NoNewPrivileges=true`                               | Blocks privilege escalation — a no-cost precaution even as root.                                                                                              |
| `PrivateTmp=true`                                    | Isolated `/tmp`, invisible to other processes.                                                                                                                |
| `ProtectSystem=strict`                               | Filesystem read-only except explicitly listed paths.                                                                                                          |
| `ProtectHome=true`                                   | Makes `/home`, `/root`, `/run/user` inaccessible.                                                                                                             |
| `ReadWritePaths=$APP_DIR`                            | The one exception to `ProtectSystem=strict`.                                                                                                                  |
| `StandardOutput=`/`StandardError=journal`            | Routes output into `systemd`'s journal.                                                                                                                       |
| `SyslogIdentifier=`                                  | Tags log lines for `journalctl -t codelibrary-scraper`.                                                                                                       |
| `WantedBy=multi-user.target`                         | Starts automatically at boot.                                                                                                                                 |

> **If you ended up on the arm64-snap branch in step 5:** change `ProtectSystem=strict` to `ProtectSystem=false` in this unit, since strict filesystem protection conflicts with snap's own confinement mounts.

---

## 13. Reload systemd and start the service

```bash
systemctl daemon-reload
systemctl enable --now codelibrary-scraper.service
```

---

## 14. Verifying it's actually working

```bash
systemctl status codelibrary-scraper.service
journalctl -u codelibrary-scraper.service -f
watch -n 30 'find /codelibrary-amlegal-com-documentation/assets -name "*.txt" | wc -l'
```

---

## 15. Production hardening & monitoring

**Log rotation:** check `journalctl --disk-usage` periodically; cap it with `SystemMaxUse=500M` under `[Journal]` in `/etc/systemd/journald.conf` if disk is a concern, then `systemctl restart systemd-journald`.

**Disk space alerting**, since `./assets/` grows unbounded:

```bash
# /etc/cron.d/disk-space-check
0 * * * * root df / | awk 'NR==2 && $5+0 > 85 {print "Disk usage high: "$5}' | logger -t disk-check
```

**Failure alerting:** add `OnFailure=notify-failure@%n.service` under `[Unit]` if you want to be paged on repeated failures (requires authoring a small unit that curls a webhook/Slack/PagerDuty).

**Automatic browser security updates:**

```bash
apt-get install -y unattended-upgrades
dpkg-reconfigure --priority=low unattended-upgrades
```

**Cron-style schedule instead of a restarting daemon:** for a fixed time instead of "an hour after the last run finished," switch `Type=simple`+`Restart=always` to `Type=oneshot` (remove `Restart=`/`RestartSec=`), pair with a `.timer` unit using `OnCalendar=*-*-* 02:00:00`.

**Chaining `main.go` (cleaner):** not included above since it's unclear if it should run after every scrape pass or on its own schedule — add as an `ExecStartPost=` line, or a separate `.service`/`.timer` pair if independent.

---

## 16. Troubleshooting

| Symptom                                                                           | Likely cause / fix                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E: Unable to locate package google-chrome-stable`                                | You're on `arm64` — Google doesn't publish Chrome for Linux ARM64 at all. Use the Chromium branch in step 5 instead.                                                                                                             |
| `E: Package 'libasound2' has no installation candidate`                           | Ubuntu 24.04+ t64 rename — use `libasound2t64` (step 3).                                                                                                                                                                         |
| `fatal: destination path '/' already exists and is not an empty directory`        | You targeted `/` instead of a subdirectory for `git clone` — use `$APP_DIR` (step 8).                                                                                                                                            |
| `error while loading shared libraries: libX.so.N: cannot open shared object file` | A browser dependency from step 3's table is missing — re-run the full `apt-get install` list.                                                                                                                                    |
| `command not found: npm` even after `apt-get install nodejs` succeeds             | `nodejs` and `npm` are separate packages — install `npm` explicitly (step 6).                                                                                                                                                    |
| `EACCES: permission denied, mkdir 'assets'`                                       | Wrong working directory — always `cd "$APP_DIR"` first when running manually (step 10); the systemd service avoids this via `WorkingDirectory=`.                                                                                 |
| Chromium launches but is actually a snap wrapper (`arm64`)                        | Check `readlink -f $(which chromium)` for a `/snap/` path — see step 5's snap handling.                                                                                                                                          |
| Service shows `failed (Result: start-limit-hit)`                                  | Crashed and restarted more than `StartLimitBurst` times within `StartLimitIntervalSec`. Check `journalctl -u codelibrary-scraper.service -n 100`, fix the real error, then `systemctl reset-failed codelibrary-scraper.service`. |
| `Failed to move to new namespace` / sandbox errors                                | Common in containers/restricted kernels. Last resort: add `--no-sandbox` to Puppeteer's launch args in `main.js` — prefer fixing the environment where possible.                                                                 |
| `EMFILE: too many open files` mid-run                                             | File descriptor limit too low — confirm `LimitNOFILE=65536` is present in the unit (step 12).                                                                                                                                    |
| Service killed abruptly with no clean error, `journalctl` shows `oom-kill`        | `MemoryMax` was hit before `NODE_OPTIONS`'s heap ceiling gave Node a chance to react — lower `--max-old-space-size` further below `MemoryMax`, or raise `MemoryMax` if the instance has headroom.                                |
| No files appearing under `assets/` despite "running"                              | Confirm `WorkingDirectory=$APP_DIR` matches where you cloned it, and `ReadWritePaths=$APP_DIR` is correct — `ProtectSystem=strict` silently denies writes elsewhere, even for root.                                              |

---

## 17. Ongoing maintenance

```bash
# Restart on demand (e.g. after a code update)
systemctl restart codelibrary-scraper.service

# Pull latest code and reinstall deps
cd "$APP_DIR"
git pull
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --prefix "$APP_DIR" --omit=dev; fi
systemctl restart codelibrary-scraper.service

# Stop without disabling (still starts on next boot)
systemctl stop codelibrary-scraper.service

# Fully disable and remove
systemctl disable --now codelibrary-scraper.service
rm /etc/systemd/system/codelibrary-scraper.service
systemctl daemon-reload
```

---

# Part 2: The Auto-Uploader Service (`uploader.sh`)

## 18. What `uploader.sh` actually does

It's a bash script with an internal `while true` loop that **never exits under normal operation** — unlike `main.js`, this one already is the long-running background process. Every 60 seconds (`CHECK_INTERVAL_SECONDS`) it checks `git status --porcelain -uall` for a changed-file count, and triggers a sync when either **100+ files have changed** (`MIN_FILE_CHANGE_THRESHOLD`) or **30 minutes have passed** (`MIN_WAIT_SECONDS=1800`) since the last successful push, whichever comes first. On trigger: `git pull --rebase --autostash`, `git add -A`, commit with a UTC timestamp message, push. Failures at any step are logged and the loop continues to the next 60-second check rather than crashing.

This script has no browser dependency at all — no architecture branching needed for this half.

**Why this changes the systemd design compared to the scraper:** the script's own loop is the scheduler, so `Restart=on-failure` with a short `RestartSec` is correct here, not the hourly-restart pattern `main.js` needed.

---

## 19. Prerequisite: git identity and push authentication

**A. Git commit identity** (root has none by default):

```bash
git config --global user.name "Codelibrary Auto-Sync Bot"
git config --global user.email "your-email-or-noreply@users.noreply.github.com"
```

**B. Push authentication — choose one:**

**Option 1 — SSH deploy key** (recommended for a single-repo bot account):

```bash
ssh-keygen -t ed25519 -C "codelibrary-uploader" -f /root/.ssh/codelibrary_deploy_key -N ""
cat /root/.ssh/codelibrary_deploy_key.pub
```

Add the printed public key to the repo's GitHub **Settings → Deploy keys**, with **Write access** enabled:

```bash
cd "$APP_DIR"
git remote set-url origin git@github.com:CoreData-Labs/codelibrary-amlegal-com-documentation.git
cat >> /root/.ssh/config <<'EOF'
Host github.com
  IdentityFile /root/.ssh/codelibrary_deploy_key
  IdentitiesOnly yes
EOF
ssh -T git@github.com
```

**Option 2 — HTTPS + Personal Access Token:**

```bash
git config --global credential.helper store
cd "$APP_DIR"
git remote set-url origin https://github.com/CoreData-Labs/codelibrary-amlegal-com-documentation.git
git pull
```

Prompts once for username + PAT (`repo` write scope), stores it in `/root/.git-credentials` (plaintext — fine on a locked-down single-purpose server).

Do one manual `git pull`/`git push` by hand first to confirm auth works before handing it to systemd.

---

## 20. Manual test run

```bash
cd "$APP_DIR"
bash uploader.sh
```

Let it run at least one 60-second loop iteration, watch for the "Repository Status Report" output. `Ctrl+C` to stop once confirmed.

---

## 21. The systemd service file for the uploader

```bash
tee /etc/systemd/system/codelibrary-uploader.service > /dev/null <<EOF
[Unit]
Description=AM Legal Codelibrary Auto-Uploader (git auto-sync)
After=network-online.target codelibrary-scraper.service
Wants=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=20

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=HOME=/root
ExecStart=/bin/bash $APP_DIR/uploader.sh
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
LimitNOFILE=4096
MemoryMax=256M
CPUQuota=50%
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codelibrary-uploader

[Install]
WantedBy=multi-user.target
EOF
```

| Directive                                           | Why it differs from the scraper service                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `After=...codelibrary-scraper.service`              | Soft ordering hint, not a hard `Requires=`.                                                                                |
| `Restart=on-failure` + `RestartSec=10`              | `uploader.sh` already loops forever internally — restart quickly (10s) only if it actually crashes.                        |
| `StartLimitIntervalSec=3600` / `StartLimitBurst=20` | Looser than the scraper's since this should be continuously up.                                                            |
| `LimitNOFILE=4096`                                  | Lighter than the scraper's — this is bash/git, not a browser.                                                              |
| `MemoryMax=256M` / `CPUQuota=50%`                   | Bash + git is far lighter than a browser-driving Node process.                                                             |
| `ProtectHome=read-only` (not `true`)                | Git needs to _read_ `/root/.gitconfig`/`/root/.git-credentials`/`/root/.ssh/` for auth — `true` would block that entirely. |
| `Environment=HOME=/root`                            | Ensures git reliably finds credential files regardless of systemd's default environment.                                   |
| No Chrome/Puppeteer env vars                        | This service never touches a browser.                                                                                      |

---

## 22. Enable, start, and verify

```bash
systemctl daemon-reload
systemctl enable --now codelibrary-uploader.service
systemctl status codelibrary-uploader.service
journalctl -u codelibrary-uploader.service -f
```

Confirm a real commit lands on GitHub after a trigger condition (100+ files or 30 minutes) is met.

---

## 23. Troubleshooting — uploader-specific

| Symptom                                                              | Likely cause / fix                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Author identity unknown` on commit                                  | Git identity not configured for root — step 19A.                                                                                           |
| `Permission denied (publickey)` on push                              | Deploy key not added with Write access, or `ProtectHome` set to `true` instead of `read-only` blocking key access.                         |
| `remote: Support for password authentication was removed`            | Using HTTPS with a password instead of a PAT — step 19B, Option 2.                                                                         |
| Works manually, fails under `systemd` with `could not read Username` | `HOME` not set for the service — confirm `Environment=HOME=/root`.                                                                         |
| `fatal: detected dubious ownership in repository`                    | Repo ownership doesn't match the running user — `git config --global --add safe.directory $APP_DIR`.                                       |
| Commits contain partially-written files                              | Known limitation of running scraper + uploader concurrently — `git add -A` can catch a file mid-write. Not fixable in the uploader itself. |
| `git pull --rebase` fails repeatedly despite `--autostash`           | Check file ownership/permissions under `$APP_DIR`.                                                                                         |

---

## 24. Running both services together

- Both target `$APP_DIR`: scraper writes, uploader commits/pushes. No hard dependency required beyond both enabled.
- Check both: `systemctl status codelibrary-scraper.service codelibrary-uploader.service`
- Combined logs: `journalctl -u codelibrary-scraper.service -u codelibrary-uploader.service -f`

---

## Production readiness checklist

**Architecture:**

- [ ] `$ARCH` detected correctly (`dpkg --print-architecture`)
- [ ] On `amd64`: Google Chrome installed and `--version` succeeds
- [ ] On `arm64`: Chromium installed, confirmed **not** a snap wrapper (or snap path deliberately accepted with `ProtectSystem` adjusted)
- [ ] `$CHROME_BIN` resolves to a real, working binary

**Scraper (`codelibrary-scraper.service`):**

- [ ] `apt-get install` completes cleanly with no missing-candidate errors
- [ ] Manual test run (step 10) produces files under `assets/`, run from `$APP_DIR`
- [ ] `npm ci` used if `package-lock.json` present, for reproducible installs
- [ ] `journalctl -u codelibrary-scraper.service -f` shows clean, ongoing log output
- [ ] `RestartSec`, `MemoryMax`, `CPUQuota`, `LimitNOFILE` tuned for your instance size
- [ ] `NODE_OPTIONS` heap ceiling set below `MemoryMax`

**Uploader (`codelibrary-uploader.service`):**

- [ ] Git identity configured for root
- [ ] Push authentication configured and manually verified
- [ ] Manual test run (step 20) shows a clean status-report loop
- [ ] A real commit confirmed landing on GitHub after a trigger condition

**Shared / overall:**

- [ ] Disk space monitoring in place (unbounded `assets/` growth)
- [ ] Log rotation confirmed
- [ ] Decision made on `main.go` chaining, if applicable
- [ ] Unattended security updates enabled
- [ ] Burstable instance CPU credits monitored, if applicable (`t3`/`t4g`)
- [ ] Consciously accepted running as root
