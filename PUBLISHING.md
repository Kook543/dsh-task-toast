# Publishing dsh-task-toast

This is the release checklist for making the plugin installable by other people. The DSH runtime
has no central "upload" button: distribution is a public package (GitHub, optionally npm) plus an
entry in the curated [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
catalog, which powers the community `dshmarket` plugin and the `awesome-dsh-plugin.com` site. The
official Discover page reads index sources that users configure (`plugin-market.indexes`), so a
catalog entry is the practical way to be listed.

Target repository: `https://github.com/Kook543/dsh-task-toast` (already set in `package.json`).

## 0. Before you start

- Windows 10/11 test machine with DSH Desktop installed.
- The public GitHub repository above created at least **1 day** before the catalog PR, with the
  **`dsh-plugin`** topic.
- An npm account if you publish to npm (optional but recommended: prebuilt installs skip the
  build-approval step and the catalog shows download counts).
- `npm login` (2FA enabled) and `git` available locally.

## 1. Create the repository and push

On GitHub, create the repository **without** README, `.gitignore` or license (all three already
exist here, and initializing them on GitHub makes the first push conflict). Name:
`dsh-task-toast`; visibility: **Public**.

Then push this directory:

```powershell
cd C:\path\to\dsh-task-toast
git init -b main
git config user.name  "your-github-user"
git config user.email "you@users.noreply.github.com"
git add .
git commit -m "dsh-task-toast 0.3.0"
git remote add origin https://github.com/Kook543/dsh-task-toast.git
git push -u origin main
```

The first push opens Git Credential Manager in a browser; sign in to GitHub and approve it. If the
account or repository name changes, update `repository`, `homepage` and `bugs` in `package.json`
first.

Then on the repository page add the **`dsh-plugin`** topic (About section 鈫?gear 鈫?Topics).
Optional: a square PNG/JPG/WebP icon (GitHub-hosted, ~96 px) and a `screenshots.json` next to
`package.json`:

```jsonc
["assets/screenshot-1.png"]
```

## 2. Verify the package

```powershell
cd C:\path\to\dsh-task-toast
npm pack --dry-run
```

Expected contents (about 30 KB tarball, ~80 KB unpacked):

```
package.json  cordis.patch.yml  README.md  PUBLISHING.md  LICENSE  icon.svg
locale/en.json  locale/zh.json
lib/index.js  lib/focus.js  client.js
scripts/toast.ps1  scripts/focus.ps1  scripts/register.ps1  scripts/click-launcher.vbs
_smoke.mjs  _smoke-click.mjs  _smoke-client.mjs
```

Then run the local tests and a package-only test:

```powershell
npm test
npm pack --pack-destination $env:TEMP
```

Install the produced tarball into a **throwaway profile** (never test against your daily profile).
`dsh plugin add` selects a bundle automatically when the package declares `dsh.bundle`:

```powershell
dsh plugin --profile toast-smoke add "$env:TEMP\dsh-task-toast-0.3.0.tgz"
dsh --profile toast-smoke --dump-config | Select-String "dsh-task-toast"
Remove-Item "$env:DSH_HOME\profiles\toast-smoke" -Recurse -Force
```

Manual acceptance test on the test profile or the daily one:

1. Every notification type pops (鉁?/ 鈿狅笍 / 鈴?/ 鉂?.
2. Clicking each one lands on the exact originating session, with no PowerShell/terminal window.
3. Minimized window restores; with DSH closed the app starts and then jumps (5-minute queue TTL).
4. `HKCU\Software\Classes\dsh-task-toast\shell\open\command` points at
   `%LOCALAPPDATA%\dsh-task-toast\bin\click-launcher.vbs` (through `wscript.exe`).
5. Reboot DSH once: the handler is re-registered and still windowless.

## 3. Publish to npm (optional, recommended)

```powershell
npm version patch        # or minor for new features
npm publish --access public
npm view dsh-task-toast version
```

Notes:

- `dsh.bundle` must stay in `package.json` 鈥?the catalog's CI rejects entries that only declare
  `dsh.client`.
- No install scripts are used; `files` already excludes local artefacts.
- Keep `dsh.bundle.platforms: ["win32"]` and `dsh.engines.dsh` in sync with what you actually
  tested. The runtime checks `engines.dsh` with `semver.satisfies(..., { includePrerelease: true })`;
  use a range that also matches under strict semver (the current range has a prerelease comparator
  on the tested tuple for exactly this reason).
- If the repo cannot be installed from source, attach a prebuilt `.tgz` to a GitHub Release and add
  the optional `tarball:` field to the catalog entry instead.

## 4. Submit to the catalog

Open a PR against [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
that adds **one file**, `data/plugins/Kook543__dsh-task-toast.yml` (the file name must match the
repo):

```yaml
url: https://github.com/Kook543/dsh-task-toast
name: Kook543/dsh-task-toast
category: notify
description:
  en: 'Windows 10/11 desktop notifications for DeepSeek Harness: approval requests, interruptions, questions, and completed tasks. Clicking a notification opens the session that produced it.'
  zh: '閫傜敤浜?Windows 10/11銆侱SH 浠诲姟闇€瑕佸鎵广€佽涓柇銆佹彁闂垨瀹屾垚鏃跺脊鍑烘闈㈤€氱煡锛岀偣鍑婚€氱煡鍥炲埌瀵瑰簲浼氳瘽銆?
# optional, GitHub-hosted raster image, ~96 px square
# icon: https://raw.githubusercontent.com/Kook543/dsh-task-toast/main/assets/icon-180.png
```

Rules that apply here (from the catalog's `contributing.md`):

- The repo must declare `dsh.bundle` (this one does), contain real working code, be at least one
  day old, and carry the `dsh-plugin` topic.
- `description.en` is required and must be accurate; no marketing/superlatives. Reviewers read the
  source and check every claim (including counts/APIs mentioned).
- One entry per PR file; do not edit the generated READMEs by hand.
- The PR CI checks `dsh.bundle`, repo age, formatting and README regeneration; a maintainer then
  reads the code.

After merge the site and `dshmarket` pick the entry up automatically (usually within a day).

## 5. Optional: an official-Discover index

The official Discover tab / `plugin_market` tool reads **index format 1** JSON from index sources
configured by the user (`plugin-market.indexes`, default empty). If you want a listing there, host
an `index.json` for your plugin (served over https) and tell users to add it under
**Plugins 鈫?Discover 鈫?Index sources**, or publish a small index package. There is no central
upload endpoint to call.

## 6. What reviewers will look at

Be explicit in the README (already covered there) about:

- the per-user HKCU protocol registration performed on every DSH start;
- the `wscript`/VBScript click launcher copied to `%LOCALAPPDATA%\dsh-task-toast\bin`, the URI
  validation it performs, and why it is a script (`wscript.exe` is signed; Windows 11 Smart App
  Control blocks locally built unsigned executables);
- reading local session titles to label notifications;
- the loopback HTTP route and the local queue file;
- Windows/DSH-version requirements and the `platforms`/`engines` declarations.

## 7. Version bump checklist

- `package.json` version
- `dsh.engines.dsh` against the DSH versions actually tested
- `npm test` and `npm pack --dry-run`
- tag the GitHub release (`vX.Y.Z`) and update the catalog entry only if the URL/description changed
  (npm versions are picked up automatically; do not add a hand-written `npm:` key)
