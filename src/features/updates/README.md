# Updates

Looks for a newer version of Pomelo, and installs it from inside the app when the user presses the button. Nothing here runs unless the user clicks "Check for updates" or has switched on "Check automatically" (off by default); Pomelo makes no other network request of its own.

## How it works

1. **Check** (`check.js`). `check({ current })` asks the release feed: GitHub `releases/latest` for the repository in `package.json` (`pomelo.updateRepo`), or the JSON feed in `pomelo.updateFeed`. It returns `{ state: 'unconfigured' | 'uptodate' | 'available' | 'error', ... }`. For a GitHub release it picks the `setup...exe` asset and its published SHA-256 `digest`. No Electron here: the fetch function and the running version are arguments.
2. **Automatic check** (`auto-check.js`). `AutoUpdate` schedules a check shortly after start and then once a day, retries after two hours when offline, and tells the app once per version. It only tells; it never downloads.
3. **Install** (`install.js`, started from `updates.ipc.js`). `download` fetches the installer, follows redirects by hand so every hop is checked against `url-policy.js` (https, GitHub's hosts or the feed's own host), and throws the file away unless its size and SHA-256 match. `launch` runs it with `/SILENT /SUPPRESSMSGBOXES /NORESTART /TASKS=` and starts Pomelo again with `--hidden --updated=<version>`. A release without a published checksum is not installed from here; the browser download page opens instead.
4. **After** (`post-update.js`). A start with `--updated` says whether the new version is the one that was wanted, and deletes the downloaded installer.

## Files

| File | Role |
|---|---|
| `index.js` | `check`, `AutoUpdate`, `cleanup`, `reportUpdate`, `registerUpdatesIpc` |
| `check.js` | The release check, version comparison, `openDownload` |
| `auto-check.js` | The scheduler |
| `install.js` | Download, verify, launch |
| `url-policy.js` | `allowedUrl` |
| `post-update.js` | The notice after an update |
| `updates.ipc.js` | The Settings buttons |

## Contracts

- The silent-install command line in `installCommand`, and the release asset name `Pomelo-Setup-x64.exe` (any `setup...exe` is accepted).
- GitHub `releases/latest`, the asset `digest`, and `POMELO_UPDATE_FEED` (tests only: a local feed, plain http allowed to that host).
- `--updated[=version]`.
- IPC channels: `updates:check`, `updates:download`, `updates:install`; `updates:progress` and `updates:found` go to the page.

## Known limits

`compareVersions` ranks a pre-release equal to its release (`1.0.0-beta.1` equals `1.0.0`). The test records it as known behaviour; fix it before a beta channel exists.

## Testing

`node test/unit/updates/check.test.js`, `auto-check.test.js` and `install.test.js` (local servers and fakes, about a second together). The in-place update itself is exercised only by CI's installer test and by hand.
