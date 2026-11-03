# Changelog

All notable changes to Pomelo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Drag a file, folder or desktop icon, tap Ctrl, and drop it on a format wheel to convert it next to the original.
- Conversions for images (incl. HEIC), video, audio, PDF, documents, EPUB, slides, spreadsheets, subtitles, archives (ZIP, 7Z, TAR, GZIP, RAR input) and folders.
- High-fidelity PDF to Word, Excel and Markdown through optional Python engines; LibreOffice and Pandoc used when installed.
- Parallel conversions with a toast stack in the bottom-right corner that folds into one progress ring beyond three.
- Settings window with an everyday view and an Advanced view; Check for updates.
- Cancel button (✕ in the middle of the progress ring) on every running conversion and on the summary toast; helper programs are stopped and partial files deleted.
- One-click **Install** for optional engines (PDF fidelity, HEIC export, LibreOffice, Pandoc) in Settings > Advanced, and an **Uninstall** button that removes Pomelo and only the engines Pomelo installed.
- Start with Windows is on by default.

- Windows installer (Inno Setup): per-user, no administrator rights, three screens (location, optional conversion engines, shortcuts). Silent install: `/SILENT`, optionally `/ENGINES=pdf2docx,soffice,pandoc`.
- Headless `Pomelo.exe --install-engines=...` and `--uninstall-engines`, used by the installer and uninstaller.
- Release workflow that builds the installer from a version tag into a draft GitHub release, with a SHA-256 checksum and a build attestation.

### Changed
- LibreOffice is no longer installed with winget. Its official MSI is downloaded (hash-checked) and unpacked into Pomelo's own folder, so there is no administrator prompt and no desktop shortcut, and uninstalling is deleting the folder.
- The installer shows live progress while it installs the engines (which engine, how far, how long), and its finish page says which one to retry if an engine fails.
- Uninstalling from inside Pomelo opens the Windows uninstaller with its progress window, instead of a hidden command-line step.
- The desktop shortcut option is on by default.
- Drag detection now runs in a small native helper (`pomelo-input.exe`) instead of a PowerShell script. It reports the trigger key and Esc only while the left mouse button is held, and no longer writes into Explorer's memory to find desktop icons.
- New flat, minimal logo and icon set.
- Renamed to Pomelo, with a pomelo-pink and rind-green look and a new logo.
- GIF export keeps the whole clip (frame rate and size scale down for longer clips, 5 minute limit) and animated GIF/WebP keep their animation when converted to each other.
