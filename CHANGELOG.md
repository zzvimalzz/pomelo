# Changelog

All notable changes to Pomelo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Convert from the right-click menu.** Right-click a file or folder and choose **Convert with Pomelo**; the format wheel opens at the pointer and you click a format. The drag gesture works exactly as before. On Windows 11 the entry is under **Show more options**. Pomelo adds it for your user account the first time it starts and removes it when you uninstall.
- **A guide.** The first time Pomelo starts it opens a short guide with an animation of drag, tap Ctrl and drop, and a few questions and answers, with step-by-step instructions and pictures of where Pomelo sits in the tray and where the right-click entry is. The new **?** button next to the name in Settings opens it again; the animation shows a document, a spreadsheet and a picture being converted in turn.
- **Save conversions to a folder you choose.** Settings has a new **Save conversions to** dropdown. Leave it on **Default** and files are saved next to the original, as before; choose a folder and every conversion lands there, all in one place. If the folder you picked is gone, Pomelo says so and saves next to the original instead. Your original files are never changed.
- Settings has an Appearance control with System, Light and Dark. System follows Windows, as before; Light and Dark apply to every Pomelo window.
- Advanced settings has a link to the source code and licences, and the third-party notices say where the source of FFmpeg and 7-Zip can be downloaded.

### Changed
- **The wheel's centre is now a Pomelo file.** While you hold a file over the wheel, its centre shows the file as a coloured icon with its format on it and a picture of its own: every format Pomelo reads (DOCX, XLSX, PNG, JPG, MP4, MP3, ZIP and the rest) has a different one, and a folder shows as a folder. Dragging several files shows a small stack with a count. Pointing at a format on the ring adds "to PDF" under the icon.
- **The trigger key is always Ctrl.** The Trigger key setting is gone from Settings, because Pomelo will use other keys for other gestures later. Drag a file and tap Ctrl, as before.
- **A cleaner update.** With **Check automatically** on, the toast now says "Update your Pomelo to v...", and clicking it opens Settings with the **Download update** button showing. Pressing the button opens a small **Pomelo Downloader** window with the stage, the percentage, the size and time left, and a Cancel button; you can minimise it. The installer's own window no longer appears. When the update is in, Pomelo reopens by itself (with Settings open again if you had it open) and a toast says it is now on the new version.
- An update that adds an engine to the PDF components you already have (as 0.1.3 did with OCR) now adds it for you, in the same window, instead of leaving you to press Install in Settings.

### Fixed
- On some PCs the format wheel opened behind the folder you were dragging from, so only the part outside that window showed. It now always opens on top.
- A command window flashed on screen for a moment while Pomelo updated itself. The installer now waits for Pomelo to close on its own instead of using the pause that opened it.

## [0.1.4] - 05-11-2026

### Fixed
- PDF to PowerPoint left text in the slide's background picture, where it cannot be edited, whenever it held a curly quote, a dash or a CJK character. It is now real text on the slide. Only Hebrew, Arabic and other right-to-left text, which cannot be drawn correctly as editable text, stays in the picture.
- Converting a scanned PDF to text, Markdown, HTML, EPUB or Excel left a temporary copy of the PDF in the temp folder every time. Pomelo now deletes it, and tries again if Windows still holds the file.
- PDF conversion failed on PCs where the `PYTHONSAFEPATH` environment variable is set. The PDF engine now runs the same way whatever that variable says.

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
