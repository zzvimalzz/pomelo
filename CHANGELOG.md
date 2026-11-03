# Changelog

All notable changes to Pomelo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- PDF to Word is now exact by default: every page keeps its size, positions, fonts, sizes, colours, spacing, links, pictures, shapes, rules and backgrounds. Text stays editable in place; whatever is not text (pictures, shapes, gradients, rules) sits behind it as the page background, and text that cannot be re-typed faithfully (right-to-left, rotated, symbol-font glyphs) stays in that background so it still looks right. A new **PDF to Word > Layout** setting (Advanced) switches to **Editable**, which rebuilds flowing paragraphs; designed pages (shapes or pictures behind text, columns, rotated text) are still converted exactly.
- The built-in DOCX to PDF (used without LibreOffice) now takes the page size, margins, default font and size from the document and no longer prints to the very edge of the sheet; Markdown, text and HTML copies get proper page margins too.
- Every toast now shows how far a conversion has got: the percentage in the middle of the ring (the cancel X appears when you point at it), the percentage in the text, and about how long is left. Engines that can measure their progress report it (video and audio, pages of a PDF, archives); for the rest (LibreOffice and friends) the figure is an estimate that follows the clock, learned from how long that kind of conversion has taken on this PC before. The ring no longer just spins.
- PDF to Markdown, HTML, text and EPUB are read by one new reader (PyMuPDF): all text in reading order, columns in order, headings, lists, tables, links, bold and italic, code and pictures. The old Markdown route (pymupdf4llm) dropped text (a résumé lost 5%, an invoice a third) and is gone, along with its pinned install.
- PDF to Excel no longer fails on a PDF without ruled tables: it finds borderless grids, and otherwise gives each page's text lines in a sheet.
- PDF to PowerPoint is exact: text boxes at the original positions on a picture of everything else, links kept (links were lost before). PDF to RTF uses the flowing rebuild, since LibreOffice folded every page of an exact layout into one.

### Fixed
- Editable PDF to Word: hyperlinks were written inside text runs, which the file format forbids, so link text vanished in LibreOffice and could trip Word. Bullet lists and skill lines were turned into fixed-height two-column tables that clipped text (about 7% of the words in a test résumé); lone spaces between styled words were dropped (Stack:PHP); bullets are now real Word lists.

### Added
- A fidelity harness, `npm run fidelity:samples` then `npm run test:fidelity`, that converts PDFs, prints the result back to PDF and scores text, positions, fonts, colours, links and look against the original.

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
