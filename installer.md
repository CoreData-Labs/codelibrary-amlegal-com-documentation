# Deploying `codelibrary-amlegal-com-documentation` as a Linux Background Service

**This guide runs everything as `root`, by request** — no dedicated service user. The systemd units are kept minimal: no memory/CPU limits, no filesystem sandboxing directives.

**Assumption used throughout:** the repo lives at `/codelibrary-amlegal-com-documentation` (a subfolder directly under `/`).

**Browser strategy:** Puppeteer downloads and manages its **own** matching Chrome build during `npm install` — nothing forces it to use a system-installed Chrome. This is deliberate: if you pin Puppeteer at a system Chrome via `PUPPETEER_EXECUTABLE_PATH`, that Chrome auto-updates independently via `apt` and can drift out of sync with the exact Chrome-for-Testing build Puppeteer was written and tested against, causing subtle automation failures when versions mismatch. Letting Puppeteer manage its own browser means the version it launches is always the one it actually expects.

---

# Part 1: The Scraper Service (`main.js`)

## 0. What you're actually deploying

`main.js` is a **Puppeteer-driven Node.js scraper**. It launches a browser, authenticates against `codelibrary.amlegal.com`, discovers regions/clients, submits export jobs, polls them, and downloads the resulting `.txt` files into `./assets/<state>/`. It runs one full pass and **exits** — it's not a web server and doesn't listen on a port. A naive `systemd` unit with `Restart=always` and no delay would relaunch it the instant it exits — an infinite tight loop hammering amlegal.com. The service below re-runs it on a controlled interval instead.

---

## 1. Detect your CPU architecture

```bash
ARCH=$(dpkg --print-architecture)
echo "Detected architecture: $ARCH"
```

Returns `amd64` (Intel/AMD — most EC2 `t3`/`m5`/`c5` instances) or `arm64` (AWS Graviton `t4g`/`m6g`/`m7g`, Raspberry Pi 4+, Ampere). Kept for step 9's note on a known ARM64 gap in Puppeteer's own browser downloads — set `$ARCH` in every new shell session before continuing.

---

## 2. Update the package index

```bash
apt-get update -y
```

---

## 3. Install base system dependencies

```bash
apt-get install -y \
  ca-certificates curl gnupg xvfb fonts-liberation zip unzip sudo bash coreutils \
  libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libpangocairo-1.0-0 libpango-1.0-0 libgtk-3-0
```

All multi-arch, available on both `amd64` and `arm64` — no per-arch changes needed.

> **⚠️ Ubuntu 24.04+ "t64" note:** `libasound2` was renamed `libasound2t64`; on 24.04+ the old name is an ambiguous virtual package and errors with "no installation candidate." Already using the correct name above. On older Ubuntu (22.04/20.04), fall back with:
>
> ```bash
> apt-get install -y libasound2t64 || apt-get install -y libasound2
> ```

| Package                                                                                                                                                                                                                                | Reason                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ca-certificates`                                                                                                                                                                                                                      | Root certificates so `curl`/npm can validate HTTPS connections.                                                                                                                                                                                                                                                                                                                                                     |
| `curl`                                                                                                                                                                                                                                 | Fetches the NodeSource install script (step 5).                                                                                                                                                                                                                                                                                                                                                                     |
| `gnupg`                                                                                                                                                                                                                                | Verifies GPG signing keys for added repos.                                                                                                                                                                                                                                                                                                                                                                          |
| `xvfb`                                                                                                                                                                                                                                 | Virtual display — lets the browser run headed against a virtual screen on a headless box.                                                                                                                                                                                                                                                                                                                           |
| `fonts-liberation`                                                                                                                                                                                                                     | Without fonts, pages render with missing glyphs, breaking layout-dependent scraping.                                                                                                                                                                                                                                                                                                                                |
| **`zip`, `unzip`**                                                                                                                                                                                                                     | **Required for Puppeteer's own browser install (step 8).** Chrome-for-Testing builds are distributed as `.zip` archives on every platform, including Linux — without `unzip` present, Puppeteer's post-install browser download step fails or silently leaves no usable browser behind, which then surfaces later as a confusing "Could not find browser" error at runtime instead of a clear install-time failure. |
| `sudo`                                                                                                                                                                                                                                 | Allows users to run commands with administrator/root privileges.                                                                                                                                                                                                                                                                                                                                                    |
| `bash`                                                                                                                                                                                                                                 | Bourne Again SHell — a command-line shell used to execute commands and shell scripts.                                                                                                                                                                                                                                                                                                                               |
| `coreutils`                                                                                                                                                                                                                            | Provides the basic utilities this guide leans on throughout (`date`, `wc`, `tail`, `find`, etc.). Present on nearly every Ubuntu base image already, but installing explicitly guards against a minimal/stripped-down image that omits it.                                                                                                                                                                          |
| `libnss3`, `libatk-bridge2.0-0`, `libatk1.0-0`, `libcups2`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libasound2t64`, `libpangocairo-1.0-0`, `libpango-1.0-0`, `libgtk-3-0` | Shared libraries the browser binary is dynamically linked against. A minimal server image doesn't ship these by default; without them the browser fails with `error while loading shared libraries` — this applies to Puppeteer's downloaded Chrome exactly as much as a system-installed one                                                                                                                       |

---

## 4. Verify available disk space

```bash
df -h /
```

Confirm at least 5 GB free — Puppeteer's downloaded Chrome build (~200–350 MB), Node dependencies, and the growing `.txt` output all add up over time.

---

## 5. Install Node.js and `npm`

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs npm
```

NodeSource serves both `amd64` and `arm64` builds automatically.

**Two gotchas:**

1. On newer Ubuntu, the distro's own `nodejs` may already be newer than NodeSource's pinned `20.x` — `apt` keeps the newer one and reports "already the newest version." Fine, any Node v18+ works here.
2. `npm` is a **separate package** from `nodejs` on Debian/Ubuntu in either repo — always install both explicitly.

**Verify and resolve the actual binary paths — don't assume `/usr/bin/`:**

```bash
NODE_BIN=$(command -v node)
NPM_BIN=$(command -v npm)
XVFB_RUN_BIN=$(command -v xvfb-run)
SUDO_BIN=$(command -v sudo)
BASH_BIN=$(command -v bash)

for var in NODE_BIN NPM_BIN XVFB_RUN_BIN SUDO_BIN BASH_BIN; do
  if [ -z "${!var}" ]; then
    echo "ERROR: $var not found on PATH — install step for it failed or didn't complete."
  else
    echo "$var = ${!var}"
  fi
done

"$NODE_BIN" --version
"$NPM_BIN" --version
```

If any of these come back empty, stop here and fix that install step before continuing — the systemd unit in step 11 uses these resolved paths directly, instead of assuming fixed locations like `/usr/bin/node`.

---

## 6. Set the application directory

```bash
APP_DIR=/codelibrary-amlegal-com-documentation
```

At this point your shell should have `$ARCH`, `$NODE_BIN`, `$NPM_BIN`, and `$XVFB_RUN_BIN` all set.

---

## 7. Clone the repository

```bash
git clone https://github.com/CoreData-Labs/codelibrary-amlegal-com-documentation.git "$APP_DIR"
```

(`git clone <url> /` fails outright — always give it a destination folder name, not `/` itself.)

---

## 8. Install Node dependencies (this is where Puppeteer downloads its own Chrome)

```bash
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --prefix "$APP_DIR" --omit=dev
fi
```

- `npm ci` is preferred when a lockfile exists — installs exactly what `package-lock.json` specifies, no version drift.
- `--omit=dev` — skips `devDependencies` for a leaner production install.
- **No `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` is set** — this is intentional. Puppeteer's post-install step downloads its own Chrome-for-Testing build (~200 MB) into `node_modules/.cache/puppeteer/` (or similar), matched exactly to the Puppeteer version pinned in `package.json`. This is the browser that will actually run — nothing later in this guide overrides it with a system browser.

**Confirm it actually downloaded a browser:**

```bash
find "$APP_DIR/node_modules" -iname "*chrome*" -type f -perm -u+x 2>/dev/null | head -5
```

You should see a Chrome binary path under Puppeteer's cache directory. If this comes back empty, `zip`/`unzip` from step 3 is the first thing to check — re-run `apt-get install -y zip unzip` and then `npm ci`/`npm install` again to retrigger the download.

**Known ARM64 gap:** Puppeteer's Chrome-for-Testing downloads are not officially published for Linux ARM64 — a long-standing upstream limitation, not something this guide can work around. If you're on `arm64` (check `$ARCH`) and the command above finds nothing, see the fallback note in step 9.

---

## 9. Manual test run before wiring up systemd

**Always verify interactively before automating** — far easier to debug a visible failure here than in `journalctl` later.

```bash
cd "$APP_DIR"
"$XVFB_RUN_BIN" -a "$NODE_BIN" main.js
```

- `cd "$APP_DIR"` — **required.** `main.js` creates/writes `./assets/` using a path relative to the process's working directory. Running from the wrong directory (e.g. `/`) causes `EACCES: permission denied, mkdir 'assets'`.
- No `PUPPETEER_EXECUTABLE_PATH` is set — Puppeteer launches the browser it downloaded in step 8 on its own.

Let it run for a few minutes and confirm files are actually appearing:

```bash
find "$APP_DIR/assets" -name "*.txt" | wc -l
```

**ARM64 fallback, only if step 8 found no downloaded browser:** install a system Chromium and point Puppeteer at it manually, just for this case:

```bash
apt-get install -y chromium
CHROME_BIN=$(readlink -f "$(command -v chromium || command -v chromium-browser)")
echo "$CHROME_BIN"
[[ "$CHROME_BIN" == /snap/* ]] && echo "Warning: this is a snap-confined Chromium, not a plain binary — see note below" || echo "Real binary — OK to use."
PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN" "$XVFB_RUN_BIN" -a "$NODE_BIN" main.js
```

If `$CHROME_BIN` resolves under `/snap/`: Ubuntu's `chromium` package is often a transitional snap redirect rather than a real binary. Either use Debian's own `chromium` package (a genuine `.deb`) if you can switch base image, or install `snapd` and accept the snap-confined version as-is. This fallback path is the _only_ place in this guide `PUPPETEER_EXECUTABLE_PATH` gets set — and only because Puppeteer's own download isn't available at all on this architecture, not as a general preference.

---

## 10. The systemd service file

```bash
tee /etc/systemd/system/codelibrary-scraper.service > /dev/null <<EOF
[Unit]
Description=AM Legal Codelibrary Scraper (codelibrary-amlegal-com-documentation)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=$XVFB_RUN_BIN -a $NODE_BIN $APP_DIR/main.js
Restart=always
RestartSec=3600
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codelibrary-scraper

[Install]
WantedBy=multi-user.target
EOF
```

**Directive-by-directive explanation:**

| Directive                                 | Why it's set this way                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `After=`/`Wants=network-online.target`    | Don't start before the network is usable.                                                                                                                                                                                                      |
| `Type=simple`                             | The process in `ExecStart` _is_ the main process.                                                                                                                                                                                              |
| _(no `User=`/`Group=`)_                   | Runs as `root`, systemd's default — the deliberate simplification for this deployment.                                                                                                                                                         |
| `WorkingDirectory=`                       | `main.js` writes to the relative path `./assets/` — must point at the repo root.                                                                                                                                                               |
| _(no `PUPPETEER_EXECUTABLE_PATH`)_        | Deliberately absent — Puppeteer launches its own downloaded Chrome from step 8, matched to the exact version it expects, instead of whatever system Chrome happens to be installed.                                                            |
| `ExecStart=`                              | `$XVFB_RUN_BIN` and `$NODE_BIN` are the actual resolved paths from step 5 (via `command -v`), substituted into this heredoc at generation time — not assumed fixed locations. `main.js` stays relative, resolving against `WorkingDirectory=`. |
| `Restart=always` + `RestartSec=3600`      | `main.js` finishes and exits normally — this is what makes it a continuous "service," re-running an hour after each pass. **The one setting worth tuning** to your desired re-scrape frequency.                                                |
| `StandardOutput=`/`StandardError=journal` | Logs go to `journalctl` — filterable, timestamped, rotated automatically.                                                                                                                                                                      |
| `SyslogIdentifier=`                       | Tags log lines for `journalctl -t codelibrary-scraper`.                                                                                                                                                                                        |
| `WantedBy=multi-user.target`              | Starts automatically at boot.                                                                                                                                                                                                                  |

**If you're on the arm64 fallback from step 9:** add `Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN` back into `[Service]` above — that's the one architecture where forcing a system browser is actually necessary, not just possible.

**Optional — adding resource limits later, if you ever need to:** `MemoryMax=2G`, `CPUQuota=150%`, and `LimitNOFILE=65536` under `[Service]` cover it without any other changes. Not included by default here.

---

## 11. Reload systemd and start the service

```bash
systemctl daemon-reload
systemctl enable --now codelibrary-scraper.service
```

---

## 12. Verifying it's actually working

```bash
systemctl status codelibrary-scraper.service
journalctl -u codelibrary-scraper.service -f
watch -n 30 'find /codelibrary-amlegal-com-documentation/assets -name "*.txt" | wc -l'
```

---

## 13. Production monitoring (independent of the service file itself)

**Log rotation:** `journalctl --disk-usage` periodically; cap with `SystemMaxUse=500M` under `[Journal]` in `/etc/systemd/journald.conf` if needed.

**Disk space alerting**, since `./assets/` grows unbounded:

```bash
# /etc/cron.d/disk-space-check
0 * * * * root df / | awk 'NR==2 && $5+0 > 85 {print "Disk usage high: "$5}' | logger -t disk-check
```

**Keeping Puppeteer's browser current:** since Puppeteer manages its own Chrome now rather than relying on `apt`'s auto-updated system Chrome, security patches come from bumping the Puppeteer version in `package.json` and re-running `npm ci`/`npm install` — not from `unattended-upgrades`. Worth a periodic `npm outdated` check or Dependabot-style automation on the repo.

**Cron-style schedule instead of a restarting daemon:** for a fixed time (e.g. nightly 2 AM) instead of "an hour after the last run," switch `Type=simple`+`Restart=always` to `Type=oneshot` (drop `Restart=`/`RestartSec=`) and pair with a `.timer` unit using `OnCalendar=*-*-* 02:00:00`.

---

## 14. Troubleshooting

| Symptom                                                                                                              | Likely cause / fix                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E: Package 'libasound2' has no installation candidate`                                                              | Ubuntu 24.04+ t64 rename — use `libasound2t64` (step 3).                                                                                                     |
| `fatal: destination path '/' already exists and is not an empty directory`                                           | Targeted `/` instead of a subdirectory for `git clone` — use `$APP_DIR` (step 7).                                                                            |
| `error while loading shared libraries`                                                                               | A browser dependency from step 3 is missing — re-run the `apt-get install` list.                                                                             |
| `command not found: npm` even after `apt-get install nodejs`                                                         | `nodejs`/`npm` are separate packages — install `npm` explicitly (step 5).                                                                                    |
| Puppeteer's browser download silently fails or `node_modules` has no chrome binary (step 8's check comes back empty) | `zip`/`unzip` missing — re-run `apt-get install -y zip unzip`, then `npm ci`/`npm install` again.                                                            |
| `Could not find browser revision ...` / `Failed to launch the browser process` at runtime                            | No browser was actually downloaded during `npm install` — re-check step 8's verification command; on `arm64`, this is expected (see the fallback in step 9). |
| `EACCES: permission denied, mkdir 'assets'`                                                                          | Wrong working directory — `cd "$APP_DIR"` first when running manually (step 9).                                                                              |
| `Failed to move to new namespace` / sandbox errors                                                                   | Common in containers/restricted kernels — last resort, add `--no-sandbox` to Puppeteer's launch args in `main.js`.                                           |
| No files under `assets/` despite "running"                                                                           | Confirm `WorkingDirectory=$APP_DIR` matches where you cloned it.                                                                                             |

---

## 15. Ongoing maintenance

```bash
# Restart on demand
systemctl restart codelibrary-scraper.service

# Update code and deps (re-downloads Puppeteer's browser if the pinned version changed)
cd "$APP_DIR"
git pull
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --prefix "$APP_DIR" --omit=dev; fi
systemctl restart codelibrary-scraper.service

# Stop / fully remove
systemctl stop codelibrary-scraper.service
systemctl disable --now codelibrary-scraper.service
rm /etc/systemd/system/codelibrary-scraper.service
systemctl daemon-reload
```

---

# Part 2: The Auto-Uploader Service (`uploader.sh`)

## 16. What `uploader.sh` actually does

A bash script with an internal `while true` loop that **never exits under normal operation** — unlike `main.js`, this one already is the long-running process. Every 60 seconds it checks `git status --porcelain -uall`, and triggers a sync when either **100+ files have changed** or **30 minutes have passed** since the last push, whichever comes first: `git pull --rebase --autostash`, `git add -A`, commit, push. Failures are logged and the loop continues.

No browser dependency — this half of the guide is unaffected by the Chrome/Chromium changes above. Because the script's own loop is the scheduler, `Restart=on-failure` with a short `RestartSec` is correct, not the hourly-restart pattern the scraper needed.

---

## 17. Prerequisite: git identity and push authentication

**A. Git commit identity:**

```bash
git config --global user.name "Codelibrary Auto-Sync Bot"
git config --global user.email "your-email-or-noreply@users.noreply.github.com"
```

**B. Push authentication — choose one:**

**SSH deploy key** (recommended):

```bash
ssh-keygen -t ed25519 -C "codelibrary-uploader" -f /root/.ssh/codelibrary_deploy_key -N ""
cat /root/.ssh/codelibrary_deploy_key.pub
```

Add the printed key to the repo's GitHub **Settings → Deploy keys** with **Write access**, then:

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

**Or HTTPS + Personal Access Token:**

```bash
git config --global credential.helper store
cd "$APP_DIR"
git remote set-url origin https://github.com/CoreData-Labs/codelibrary-amlegal-com-documentation.git
git pull
```

Prompts once for username + PAT (`repo` write scope), stores it in `/root/.git-credentials`.

Test with a manual `git pull`/`git push` before handing it to systemd.

---

## 18. Manual test run

```bash
BASH_BIN=$(command -v bash)
GIT_BIN=$(command -v git)
SUDO_BIN=$(command -v sudo)
echo "bash = $BASH_BIN"
echo "git  = $GIT_BIN"
echo "sudo = $SUDO_BIN"

cd "$APP_DIR"
"$BASH_BIN" uploader.sh
```

`bash` and `git` are resolved the same way as the scraper's binaries — `uploader.sh` calls `git` internally, so confirming it resolves here catches a missing/broken git install before systemd tries to run the loop. `$BASH_BIN` is what gets used in the systemd unit's `ExecStart` next.

Let it run one 60-second loop, watch for the "Repository Status Report" output, `Ctrl+C` once confirmed.

---

## 19. The systemd service file for the uploader

```bash
tee /etc/systemd/system/codelibrary-uploader.service > /dev/null <<EOF
[Unit]
Description=AM Legal Codelibrary Auto-Uploader (git auto-sync)
After=network-online.target codelibrary-scraper.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=HOME=/root
ExecStart=$SUDO_BIN $BASH_BIN $APP_DIR/uploader.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codelibrary-uploader

[Install]
WantedBy=multi-user.target
EOF
```

| Directive                                  | Why it differs from the scraper service                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `After=...codelibrary-scraper.service`     | Soft ordering hint, not a hard dependency.                                                  |
| `ExecStart=$BASH_BIN $APP_DIR/uploader.sh` | `$BASH_BIN` is the resolved path from step 18, not an assumed `/bin/bash`.                  |
| `Restart=on-failure` + `RestartSec=10`     | The script already loops forever internally — restart quickly only if it actually crashes.  |
| `Environment=HOME=/root`                   | Ensures git reliably finds `~/.gitconfig`/`~/.git-credentials`/`~/.ssh` for authentication. |
| No Chrome/Puppeteer env vars               | This service never touches a browser.                                                       |

---

## 20. Enable, start, and verify

```bash
systemctl daemon-reload
systemctl enable --now codelibrary-uploader.service
systemctl status codelibrary-uploader.service
journalctl -u codelibrary-uploader.service -f
```

Confirm a real commit lands on GitHub after a trigger condition is met.

---

## 21. Troubleshooting — uploader-specific

| Symptom                                                              | Likely cause / fix                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Author identity unknown` on commit                                  | Git identity not configured for root — step 17A.                                                                                           |
| `Permission denied (publickey)` on push                              | Deploy key not added with Write access, or the key file isn't readable.                                                                    |
| `remote: Support for password authentication was removed`            | Using HTTPS with a password instead of a PAT — step 17B.                                                                                   |
| Works manually, fails under `systemd` with `could not read Username` | `HOME` not reaching the service — confirm `Environment=HOME=/root` is present.                                                             |
| `fatal: detected dubious ownership in repository`                    | `git config --global --add safe.directory $APP_DIR`                                                                                        |
| Commits contain partially-written files                              | Known limitation of running scraper + uploader concurrently — `git add -A` can catch a file mid-write. Not fixable in the uploader itself. |

---

## 22. Running both services together

- Both target `$APP_DIR`: scraper writes, uploader commits/pushes. No hard dependency required beyond both enabled.
- Check both: `systemctl status codelibrary-scraper.service codelibrary-uploader.service`
- Combined logs: `journalctl -u codelibrary-scraper.service -u codelibrary-uploader.service -f`

---

## Production readiness checklist

**Browser (Puppeteer-managed):**

- [ ] `zip`/`unzip` installed (step 3)
- [ ] Step 8's verification command finds a downloaded Chrome binary under `node_modules`
- [ ] On `arm64`: confirmed whether Puppeteer's own download works; if not, fallback Chromium installed and confirmed not a snap wrapper
- [ ] No `PUPPETEER_EXECUTABLE_PATH` set unless on the arm64 fallback

**Scraper:**

- [ ] Manual test run produces files under `assets/`, run from `$APP_DIR`
- [ ] `npm ci` used if `package-lock.json` present
- [ ] `journalctl -u codelibrary-scraper.service -f` shows clean, ongoing output
- [ ] `RestartSec` tuned to your desired re-scrape interval

**Uploader:**

- [ ] Git identity configured for root
- [ ] Push authentication configured and manually verified
- [ ] A real commit confirmed landing on GitHub after a trigger condition

**Shared:**

- [ ] Disk space monitoring in place
- [ ] Log rotation confirmed
- [ ] Plan in place for keeping Puppeteer's Chrome version current (bump Puppeteer, re-run `npm ci`)
- [ ] Consciously accepted running as root, unconstrained on memory/CPU
