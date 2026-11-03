# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through GitHub:

<https://github.com/zzvimalzz/pomelo/security/advisories/new>

Include what you found, how to reproduce it, and the Pomelo version (Settings > Updates shows it). You will get an answer as soon as a maintainer can look at it, and we will credit you in the fix unless you prefer otherwise.

## What Pomelo does with your input

Knowing the design helps when judging what is and is not a vulnerability:

- **Global input hook.** `native/pomelo-input.cs` (built as `pomelo-input.exe`) installs a Windows low-level mouse/keyboard hook. It reports only the left mouse button, the mouse position while that button is held, and the trigger key (Ctrl, Alt or Shift) and Esc while that button is held. It never records other keys, stores or logs nothing, and has no network access. The source is the whole implementation.
- **Offline by design.** Files are converted on your machine. The PDF print window and Pandoc are blocked from fetching remote resources. The only network request Pomelo itself makes is the update check, and only when you click **Check for updates**.
- **Helper programs.** LibreOffice, Pandoc, FFmpeg, 7-Zip and the Python PDF tools run as separate processes with the file you chose as input. Archives are checked after extraction so they cannot write outside their target folder.

Reports about weaknesses in these areas are especially welcome.

## Supported versions

Until 1.0, only the latest release receives security fixes.
