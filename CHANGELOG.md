# Changelog

All notable changes to Pomelo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 05-11-2026

### Changed
- **Reorganised, same behaviour.** The code is now organised by feature (conversion, jobs, gesture, settings, engine setup, updates, uninstall). Every conversion Pomelo offers was run on 0.1.3 and on this version: all of them succeed and the results match, apart from the PowerPoint fix below. Dragging, the wheel, the toast and Settings work as before.
- The PDF to Word converter is split into smaller parts. The Word files it writes are unchanged on the nine sample documents it is tested against.
- For contributors: `npm run check` also enforces the import rules and flags stray notes, `npm test` runs one list of suites with time limits, and `CONTRIBUTING.md` describes the layout and how to add a format or an engine.

### Fixed
- PDF to PowerPoint left any text with a curly quote, a dash or a CJK character in the background picture of the slide. Only Hebrew, Arabic and the like (which cannot be drawn right as editable text) stay in the picture now.
- Converting a scanned PDF to text, Markdown, HTML, EPUB or Excel left a temporary copy of it in the temp folder every time. Pomelo now removes it, and tries again if Windows still holds the file.
- PDF conversion failed on PCs where the `PYTHONSAFEPATH` environment variable is set.

## [0.1.3] - 04-11-2026

### Changed
- **PDF to Word is always editable.** The new converter rebuilds every page as real paragraphs (indents, alignment, line spacing, fonts, colours, underline, highlight), real bullet and numbered lists, real Word tables (ruled tables, tables drawn with shaded rows, and side-by-side blocks such as columns as borderless tables), shaded and outlined boxes, hyperlinks, a stretched colour for a full-page background, and pictures. Pictures, charts, logos and gradients stay pictures; text on a picture is a positioned paragraph you can still retype. The old "exact" mode, which wrote every line as its own frame, and the **PDF to Word > Layout** switch in Settings are gone.
- **Scanned PDFs are read with OCR** (RapidOCR, offline, models fetched once at install). A page that is only a picture is turned into text first, so PDF to Word, Excel, PowerPoint, Markdown, HTML, text and EPUB all work on scans.
- The PDF engine is now PyMuPDF (pinned to 1.28.2), python-docx, RapidOCR and pillow-heif. A fresh install used to pull in PyMuPDF 2.x with its layout-analysis stack and `pdf2docx` (435 MB on disk); it is now 360 MB including OCR. **Settings > Advanced > Conversion engines** has a new **OCR** row; an existing PDF engine is rebuilt when you press Install.
- The installer's engine page says what the PDF choice contains (PDF to Word and more, OCR, HEIC; about 320 MB).
- A conversion that fails reports the reason from the best engine instead of the last fallback's.

### Fixed
- PDF to Word took 5 to 12 seconds for every page that has nothing but text (a per-pixel blank-page check in Python): 30 such pages took 161 seconds and a 110-page document hit the ten-minute limit. 40 pages now convert in about 6 seconds, and the time limit grows with the size of the PDF.
- A scanned PDF "converted" to a Word file with no text in it. It is now read with OCR, or says plainly that it needs the OCR component.
- Reasons for failures are plain: a password-protected PDF and a damaged file each say so, without file paths or Python errors.
- Rotated text over other text lost letters ("PAID" became "PAI"), letter-spaced capitals came out with spaces inside the words ("I NVO I C E"), and white text on a shaded header disappeared.
- The installer test now installs, updates and uninstalls the real installer in CI.

## [0.1.2] - 03-11-2026

### Changed
- **Update now**: updating no longer sends you to the browser to run the installer again. Pomelo downloads the new version itself (with progress and time left), checks it against the SHA-256 published with the release, installs it quietly over the current one and starts again. It only downloads from GitHub, follows redirects only to GitHub's own hosts, throws away a download that is incomplete or does not match, and falls back to the download page when a release has no checksum. Settings, shortcuts and engines are left as they are.

### Fixed
- Installing over an older Pomelo could leave the old version running: a copy started from somewhere else (or not called `Pomelo.exe`) kept Pomelo's "only one copy" lock, so opening the new one just showed the old one's window and its old version number. The installer now stops whichever process holds that lock, and stops with a clear message if it cannot.
- The installer now says when Pomelo is already installed: which version, where, and that it will be updated (or reinstalled). An update goes into the folder Pomelo is already in and no longer asks about the folder or the conversion engines again; settings, shortcuts and engines are kept.

## [0.1.1] - 03-11-2026

### Added
- **Check automatically** in Settings (off by default). When on, Pomelo looks for a newer version 30 seconds after it starts and then once a day, and says so in a toast and on the tray icon when one exists. It never downloads or installs anything: the download starts only when you press **Download update**. A failed check is silent and retried a couple of hours later.
- **PDF to Word > Layout** in Settings > Advanced: **Exact** (the default) or **Editable**.
- A fidelity harness, `npm run fidelity:samples` then `npm run test:fidelity`, that converts PDFs, prints the result back to PDF and scores text, positions, fonts, colours, links and look against the original.

### Changed
- PDF to Word is now exact by default: every page keeps its size, positions, fonts, sizes, colours, spacing, links, pictures, shapes, rules and backgrounds. Text stays editable in place; whatever is not text (pictures, shapes, gradients, rules) sits behind it as the page background, and text that cannot be re-typed faithfully (right-to-left, rotated, symbol-font glyphs) stays in that background so it still looks right. A new **PDF to Word > Layout** setting (Advanced) switches to **Editable**, which rebuilds flowing paragraphs; designed pages (shapes or pictures behind text, columns, rotated text) are still converted exactly.
- Every toast now shows how far a conversion has got: the ring fills as it goes (the cancel X stays in its middle), and the text beside it gives the percentage and about how long is left. Engines that can measure their progress report it (video and audio, pages of a PDF, archives); for the rest (LibreOffice and friends) the figure is an estimate that follows the clock, learned from how long that kind of conversion has taken on this PC before. The ring no longer just spins.
- PDF to Markdown, HTML, text and EPUB are read by one new reader (PyMuPDF): all text in reading order, columns in order, headings, lists, tables, links, bold and italic, code and pictures. The old Markdown route (pymupdf4llm) dropped text (a résumé lost 5%, an invoice a third) and is gone, along with its pinned install.
- PDF to Excel no longer fails on a PDF without ruled tables: it finds borderless grids, and otherwise gives each page's text lines in a sheet.
- PDF to PowerPoint is exact: text boxes at the original positions on a picture of everything else, links kept (links were lost before). PDF to RTF uses the flowing rebuild, since LibreOffice folded every page of an exact layout into one.
- The built-in DOCX to PDF (used without LibreOffice) now takes the page size, margins, default font and size from the document and no longer prints to the very edge of the sheet; Markdown, text and HTML copies get proper page margins too.
- The optional PDF engine no longer installs `pymupdf4llm`, so it is smaller to download and carries one less licence to track.

### Fixed
- Editable PDF to Word: hyperlinks were written inside text runs, which the file format forbids, so link text vanished in LibreOffice and could trip Word. Bullet lists and skill lines were turned into fixed-height two-column tables that clipped text (about 7% of the words in a test résumé); lone spaces between styled words were dropped (Stack:PHP); bullets are now real Word lists.

## [0.1.0] - 03-11-2026

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
