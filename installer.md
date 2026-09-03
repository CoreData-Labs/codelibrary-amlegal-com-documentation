# Deploying `codelibrary-amlegal-com-documentation` as a Linux Background Service

**This guide runs everything as `root`, by request** — no dedicated service user. The systemd units below are kept intentionally minimal: no memory/CPU limits, no filesystem sandboxing directives. Fewer moving parts means less to configure, less to explain, and less that can silently cap something you didn't mean to cap. If you later want ceilings back (e.g. if the browser ever runs away with memory on a shared box), see the short optional note at the end of step 11 — it's a small addition, not a redesign.

**Assumption used throughout:** the repo lives at `/codelibrary-amlegal-com-documentation` (a subfolder directly under `/`).

**Architecture support:** this guide detects and branches on CPU architecture (`amd64` vs `arm64`), since **Google Chrome has no official Linux ARM64 build**. If you're on `amd64`, nothing about your workflow changes; the branching exists for when this runs on ARM (AWS Graviton, etc.).

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

Returns `amd64` (Intel/AMD — most EC2 `t3`/`m5`/`c5` instances) or `arm64` (AWS Graviton `t4g`/`m6g`/`m7g`, Raspberry Pi 4+, Ampere). `$ARCH` is used throughout — set it in every new shell session before continuing.

---

## 2. Update the package index

```bash
apt-get update -y
```

---

## 3. Install base system dependencies

```bash
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg xvfb fonts-liberation \
  libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2t64 libpangocairo-1.0-0 libpango-1.0-0 libgtk-3-0
```

All multi-arch, available on both `amd64` and `arm64` — no per-arch changes needed.

> **⚠️ Ubuntu 24.04+ "t64" note:** `libasound2` was renamed `libasound2t64`; on 24.04+ the old name is an ambiguous virtual package and errors with "no installation candidate." Already using the correct name above. On older Ubuntu (22.04/20.04), fall back with:
>
> ```bash
> apt-get install -y --no-install-recommends libasound2t64 || apt-get install -y --no-install-recommends libasound2
> ```

| Package                                                                                                                                                                                                                                | Reason                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ca-certificates`                                                                                                                                                                                                                      | Root certificates so `curl`/npm/Chrome can validate HTTPS connections.                                   |
| `curl`                                                                                                                                                                                                                                 | Fetches signing keys and install scripts.                                                                |
| `gnupg`                                                                                                                                                                                                                                | Verifies GPG signing keys so `apt` trusts added repos.                                                   |
| `xvfb`                                                                                                                                                                                                                                 | Virtual display — lets the browser run headed against a virtual screen on a headless box.                |
| `fonts-liberation`                                                                                                                                                                                                                     | Without fonts, pages render with missing glyphs, breaking layout-dependent scraping.                     |
| `libnss3`, `libatk-bridge2.0-0`, `libatk1.0-0`, `libcups2`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libasound2t64`, `libpangocairo-1.0-0`, `libpango-1.0-0`, `libgtk-3-0` | Shared libraries the browser is dynamically linked against; missing on minimal server images by default. |

---

## 4. Verify available disk space

```bash
df -h /
```

Confirm at least 5 GB free — the browser, Node dependencies, and the growing `.txt` output all add up over time.

---

## 5. Install the browser (architecture-dependent)

### If `$ARCH` = `amd64`: install Google Chrome

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

### If `$ARCH` = `arm64`: install Chromium instead

Google doesn't publish Chrome for Linux ARM64 at all — use Chromium:

```bash
if [ "$ARCH" = "arm64" ]; then
  apt-get install -y chromium
  CHROME_BIN=$(readlink -f "$(command -v chromium || command -v chromium-browser)")
fi
```

**Check it's a real binary, not a snap wrapper** (Ubuntu's `chromium` package is often a transitional snap redirect):

```bash
echo "$CHROME_BIN"
[[ "$CHROME_BIN" == /snap/* ]] && echo "This is a snap-confined Chromium — see note below" || echo "Real binary — proceed."
```

If it resolves under `/snap/`: either use Debian's own `chromium` package (a genuine `.deb`, not a snap) if you can switch base image, or install `snapd` and let it run confined as-is — it'll work, just with a less predictable binary path.

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

NodeSource serves both `amd64` and `arm64` builds automatically.

**Two gotchas:**

1. On newer Ubuntu, the distro's own `nodejs` may already be newer than NodeSource's pinned `20.x` — `apt` keeps the newer one and reports "already the newest version." Fine, any Node v18+ works here.
2. `npm` is a **separate package** from `nodejs` on Debian/Ubuntu in either repo — always install both explicitly.

**Verify:**

```bash
/usr/bin/node --version
/usr/bin/npm --version
```

---

## 7. Set the application directory

```bash
APP_DIR=/codelibrary-amlegal-com-documentation
```

---

## 8. Clone the repository

```bash
git clone https://github.com/CoreData-Labs/codelibrary-amlegal-com-documentation.git "$APP_DIR"
```

(`git clone <url> /` fails outright — always give it a destination folder name, not `/` itself.)

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

`npm ci` is preferred when a lockfile exists — installs exactly what `package-lock.json` specifies, no version drift.

---

## 10. Manual test run before wiring up systemd

```bash
cd "$APP_DIR"
PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN" xvfb-run -a node main.js
```

`cd "$APP_DIR"` is required — `main.js` writes `./assets/` relative to the working directory; running from the wrong place causes `EACCES: permission denied, mkdir 'assets'`.

Confirm files appear:

```bash
find "$APP_DIR/assets" -name "*.txt" | wc -l
```

---

## 11. The systemd service file

```bash
tee /etc/systemd/system/codelibrary-scraper.service > /dev/null <<EOF
[Unit]
Description=AM Legal Codelibrary Scraper (codelibrary-amlegal-com-documentation)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN
Environment=NODE_ENV=production
ExecStart=/usr/bin/xvfb-run -a node main.js
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

| Directive                                           | Why it's set this way                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `After=`/`Wants=network-online.target`              | Don't start before the network is usable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Type=simple`                                       | The process in `ExecStart` _is_ the main process.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| _(no `User=`/`Group=`)_                             | Runs as `root`, systemd's default — the deliberate simplification for this deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `WorkingDirectory=`                                 | `main.js` writes to the relative path `./assets/` — must point at the repo root.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN` | Resolved per-architecture in step 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ExecStart=`                                        | Same command as the step 10 manual test. `xvfb-run` is given as an absolute path since systemd doesn't use your shell's `$PATH` for the executable itself — but its own arguments (`node main.js`) are passed through as-is: `node` resolves fine because systemd's default `PATH` includes `/usr/bin`, and `main.js` resolves against `WorkingDirectory=` above. Uses `xvfb-run`'s default virtual screen size (no `--server-args`) — add that flag back if a specific resolution ever turns out to matter for how the pages render. |
| `Restart=always` + `RestartSec=3600`                | `main.js` finishes and exits normally — this is what makes it a continuous "service," re-running an hour after each pass. **This is the one setting worth tuning** to your desired re-scrape frequency.                                                                                                                                                                                                                                                                                                                               |
| `StandardOutput=`/`StandardError=journal`           | Logs go to `journalctl` — filterable, timestamped, rotated automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SyslogIdentifier=`                                 | Tags log lines for `journalctl -t codelibrary-scraper`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `WantedBy=multi-user.target`                        | Starts automatically at boot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Optional — adding resource limits back later, if you ever need to:** if the browser starts consuming more memory/CPU than you'd like on a shared box, three lines under `[Service]` cover it without any other changes:

```ini
MemoryMax=2G
CPUQuota=150%
LimitNOFILE=65536
```

Not included by default here, per your call to keep this unconstrained.

---

## 12. Reload systemd and start the service

```bash
systemctl daemon-reload
systemctl enable --now codelibrary-scraper.service
```

---

## 13. Verifying it's actually working

```bash
systemctl status codelibrary-scraper.service
journalctl -u codelibrary-scraper.service -f
watch -n 30 'find /codelibrary-amlegal-com-documentation/assets -name "*.txt" | wc -l'
```

---

## 14. Production monitoring (independent of the service file itself)

These are operational add-ons, not part of the unit file:

**Log rotation:** `journalctl --disk-usage` periodically; cap with `SystemMaxUse=500M` under `[Journal]` in `/etc/systemd/journald.conf` if needed.

**Disk space alerting**, since `./assets/` grows unbounded:

```bash
# /etc/cron.d/disk-space-check
0 * * * * root df / | awk 'NR==2 && $5+0 > 85 {print "Disk usage high: "$5}' | logger -t disk-check
```

**Automatic browser security updates:**

```bash
apt-get install -y unattended-upgrades
dpkg-reconfigure --priority=low unattended-upgrades
```

**Cron-style schedule instead of a restarting daemon:** for a fixed time (e.g. nightly 2 AM) instead of "an hour after the last run," switch `Type=simple`+`Restart=always` to `Type=oneshot` (drop `Restart=`/`RestartSec=`) and pair with a `.timer` unit using `OnCalendar=*-*-* 02:00:00`.

---

## 15. Troubleshooting

| Symptom                                                                    | Likely cause / fix                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `E: Unable to locate package google-chrome-stable`                         | You're on `arm64` — Google doesn't publish Chrome for Linux ARM64. Use the Chromium branch in step 5.              |
| `E: Package 'libasound2' has no installation candidate`                    | Ubuntu 24.04+ t64 rename — use `libasound2t64` (step 3).                                                           |
| `fatal: destination path '/' already exists and is not an empty directory` | Targeted `/` instead of a subdirectory for `git clone` — use `$APP_DIR` (step 8).                                  |
| `error while loading shared libraries`                                     | A browser dependency from step 3 is missing — re-run the `apt-get install` list.                                   |
| `command not found: npm` even after `apt-get install nodejs`               | `nodejs`/`npm` are separate packages — install `npm` explicitly (step 6).                                          |
| `EACCES: permission denied, mkdir 'assets'`                                | Wrong working directory — `cd "$APP_DIR"` first when running manually (step 10).                                   |
| Chromium is actually a snap wrapper (`arm64`)                              | `readlink -f $(which chromium)` shows `/snap/` — see step 5's snap note.                                           |
| `Failed to move to new namespace` / sandbox errors                         | Common in containers/restricted kernels — last resort, add `--no-sandbox` to Puppeteer's launch args in `main.js`. |
| No files under `assets/` despite "running"                                 | Confirm `WorkingDirectory=$APP_DIR` matches where you cloned it.                                                   |

---

## 16. Ongoing maintenance

```bash
# Restart on demand
systemctl restart codelibrary-scraper.service

# Update code and deps
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

## 17. What `uploader.sh` actually does

A bash script with an internal `while true` loop that **never exits under normal operation** — unlike `main.js`, this one already is the long-running process. Every 60 seconds it checks `git status --porcelain -uall`, and triggers a sync when either **100+ files have changed** or **30 minutes have passed** since the last push, whichever comes first: `git pull --rebase --autostash`, `git add -A`, commit, push. Failures are logged and the loop continues.

No browser dependency — no architecture branching needed here. And because the script's own loop is the scheduler, `Restart=on-failure` with a short `RestartSec` is correct, not the hourly-restart pattern the scraper needed.

---

## 18. Prerequisite: git identity and push authentication

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

## 19. Manual test run

```bash
cd "$APP_DIR"
bash uploader.sh
```

Let it run one 60-second loop, watch for the "Repository Status Report" output, `Ctrl+C` once confirmed.

---

## 20. The systemd service file for the uploader

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
ExecStart=/bin/bash $APP_DIR/uploader.sh
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=codelibrary-uploader

[Install]
WantedBy=multi-user.target
EOF
```

| Directive                              | Why it differs from the scraper service                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `After=...codelibrary-scraper.service` | Soft ordering hint, not a hard dependency.                                                  |
| `Restart=on-failure` + `RestartSec=10` | The script already loops forever internally — restart quickly only if it actually crashes.  |
| `Environment=HOME=/root`               | Ensures git reliably finds `~/.gitconfig`/`~/.git-credentials`/`~/.ssh` for authentication. |
| No Chrome/Puppeteer env vars           | This service never touches a browser.                                                       |

---

## 21. Enable, start, and verify

```bash
systemctl daemon-reload
systemctl enable --now codelibrary-uploader.service
systemctl status codelibrary-uploader.service
journalctl -u codelibrary-uploader.service -f
```

Confirm a real commit lands on GitHub after a trigger condition is met.

---

## 22. Troubleshooting — uploader-specific

| Symptom                                                              | Likely cause / fix                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Author identity unknown` on commit                                  | Git identity not configured for root — step 18A.                                                                                           |
| `Permission denied (publickey)` on push                              | Deploy key not added with Write access, or the key file isn't readable.                                                                    |
| `remote: Support for password authentication was removed`            | Using HTTPS with a password instead of a PAT — step 18B.                                                                                   |
| Works manually, fails under `systemd` with `could not read Username` | `HOME` not reaching the service — confirm `Environment=HOME=/root` is present.                                                             |
| `fatal: detected dubious ownership in repository`                    | `git config --global --add safe.directory $APP_DIR`                                                                                        |
| Commits contain partially-written files                              | Known limitation of running scraper + uploader concurrently — `git add -A` can catch a file mid-write. Not fixable in the uploader itself. |

---

## 23. Running both services together

- Both target `$APP_DIR`: scraper writes, uploader commits/pushes. No hard dependency required beyond both enabled.
- Check both: `systemctl status codelibrary-scraper.service codelibrary-uploader.service`
- Combined logs: `journalctl -u codelibrary-scraper.service -u codelibrary-uploader.service -f`

---

## Production readiness checklist

**Architecture:**

- [ ] `$ARCH` detected correctly
- [ ] Correct browser installed for your architecture and `--version` succeeds
- [ ] On `arm64`: confirmed Chromium isn't a snap wrapper (or deliberately accepted)

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
- [ ] Unattended security updates enabled
- [ ] Consciously accepted running as root, unconstrained on memory/CPU
