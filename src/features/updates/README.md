# Updates

Looks for a newer version of Pomelo, and installs it from inside the app when the user presses the button, with a small window ("Pomelo Downloader") that shows the progress. Nothing here runs unless the user clicks "Check for updates" or has switched on "Check automatically" (off by default); Pomelo makes no other network request of its own.

## How it works

1. **Check** (`check.js`). `check({ current })` asks the release feed: GitHub `releases/latest` for the repository in `package.json` (`pomelo.updateRepo`), or the JSON feed in `pomelo.updateFeed`. It returns `{ state: 'unconfigured' | 'uptodate' | 'available' | 'error', ... }`. For a GitHub release it picks the `setup...exe` asset and its published SHA-256 `digest`. No Electron here: the fetch function and the running version are arguments.
2. **Automatic check** (`auto-check.js`). `AutoUpdate` schedules a check shortly after start and then once a day, retries after two hours when offline, and tells the app once per version. It only tells; it never downloads. The app turns that into a toast ("Update your Pomelo to v...") that opens Settings when clicked, where the Download button is showing.
3. **Install** (`install.js`, started from `updates.ipc.js`). Pressing the button opens the Downloader window. `download` fetches the installer, follows redirects by hand so every hop is checked against `url-policy.js` (https, GitHub's hosts or the feed's own host), and throws the file away unless its size and SHA-256 match; Cancel stops it. `launch` runs the installer with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=` (no installer window) and starts Pomelo again with `--updated=<version>`, plus `--hidden` unless Settings was open. A release without a published checksum is not installed from here; the browser download page opens instead.
4. **Hand-over.** Windows cannot replace a running program, so Pomelo exits about a second and a half after saying "Installing". It passes its process id as `/WAITPID`, and the installer waits for that process to end before it looks for a running copy to stop. The command runs under `cmd` (which has to outlive Pomelo), so it must not contain a console program: Windows opens a visible window for each one.
5. **After** (`post-update.js`). A start with `--updated` says whether the new version is the one that was wanted and deletes the downloaded installer. When it landed, the PDF, OCR and HEIC environment Pomelo built is checked for engines the new version expects and does not find (`createInstaller().pending`, see `engine-setup`); those are added in the Downloader window, which closes itself when they are in. Then a toast says "Pomelo is now on version ...". Only an environment Pomelo built is touched, and only after an update the user started; LibreOffice and Pandoc are never added.

## Files

| File | Role |
|---|---|
| `index.js` | `check`, `AutoUpdate`, `cleanup`, `reportUpdate`, `registerUpdatesIpc` |
| `check.js` | The release check, version comparison, `openDownload` |
| `auto-check.js` | The scheduler |
| `install.js` | Download, verify, launch |
| `downloader.window.js` | The Pomelo Downloader window |
| `ui/` | The Downloader's page: `downloader.html`, `downloader.css`, `downloader.js`, `preload.js` |
| `url-policy.js` | `allowedUrl` |
| `post-update.js` | After the restart: add engines, then the notice |
| `updates.ipc.js` | The update buttons of Settings and the Downloader |

## Contracts

- The silent-install command line in `installCommand` (including `/WAITPID`, which `installer/pomelo.iss` reads), and the release asset name `Pomelo-Setup-x64.exe` (any `setup...exe` is accepted).
- GitHub `releases/latest`, the asset `digest`, and `POMELO_UPDATE_FEED` (tests only: a local feed, plain http allowed to that host).
- `--updated[=version]`.
- IPC channels: `updates:check`, `updates:download`, `updates:install`, `updates:cancel`, `updates:close`, `updates:ready`; `updates:progress` and `updates:found` go to Settings, `updates:state` to the Downloader.

## Known limits

`compareVersions` ranks a pre-release equal to its release (`1.0.0-beta.1` equals `1.0.0`). The test records it as the current behaviour.

## Testing

`node test/unit/updates/check.test.js`, `auto-check.test.js`, `install.test.js` and `post-update.test.js` (local servers and fakes, about a second together); `npx electron test/ui/downloader-shot.js` opens the real Downloader window in every state and saves screenshots (about 15 s). The in-place update itself, with the installer waiting for Pomelo to exit, is exercised only by CI's installer test and by hand.
