# Changelog

All notable changes to Pomelo are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

Every entry starts with a bold headline, then the detail. The release history in Pomelo's Settings is read from this file: it shows the headlines and leaves out the **Internal** section, so write the headline for a user and keep the detail for developers.

## [Unreleased]

### Added
- **Release history in Updates.** Settings > Updates lists every release, newest first, as a folding card with its date; the version you are running is marked **Installed** and the search box finds entries inside releases. It shows the headline of each entry and nothing else, so this file keeps the detail and the history stays short. `CHANGELOG.md` now ships with the app and `src/features/updates/changelog.js` parses it when the page opens, so a new version brings its own history and nothing is edited per release. An entry without a bold headline is shown as its first sentence.

### Changed
- **A new Settings window.** Settings is one 880 x 600 window with a sidebar (General, Appearance, Engines, Updates, How Pomelo works, Diagnostics and About) and a search box that finds any setting or question. The Advanced button that made the page longer is gone and the window keeps its size. Appearance has a card for System, Light and Dark, and Engines shows how many engines are ready. The title bar is part of the page, with Windows drawing the minimise and close buttons in colours that follow the theme.
- **The guide is part of Settings.** The animation and the questions live under **How Pomelo works**, where each question is marked Q and its answer sits on its own panel. The separate guide window and the **?** button are gone; a new install opens Settings on that page.
- **A fuller tray menu.** It shows whether Pomelo is running or paused and has switches for Enabled and Start with Windows, then Settings, How Pomelo works (opens that page), Check for updates (opens Updates and checks) and Quit. The tray icon turns grey while Pomelo is paused, and the update toast now opens Settings on Updates.

### Fixed
- **PDF to Word files print from Word.** A page whose content started left of the sheet gave the Word file a negative margin, and Word could not print it. No page margin is negative any more.
- **Justified text stays in paragraphs.** Justified lines that the PDF stores word by word came out as one paragraph per word, each indented further than the last. The words of such a line are joined again, the paragraph is justified, and a paragraph with an indented first line is no longer read as right-aligned. Rows of figures, tag pills and table cells stay apart.
- **Backgrounds stay on their page.** The background and the photos behind the text are anchored in the first paragraph of a page instead of its last one (or in its first table cell, when that cell has no fill and a table starts the page), so a page that runs over by a line no longer sends its background to the next sheet.
- **Pages stored sideways keep their size and stay editable.** A PDF page with a rotation, such as a form scanned sideways, is read upright and placed in a text box the size of the sheet, turned the way the PDF shows it. The text stays real text and the page keeps its size and orientation. Before, its text was read at the wrong coordinates and scattered over extra pages.
- **A photo at the foot of a page stays on its page.** A wide picture near the bottom, with its caption, is placed on the page instead of in the text, so a Word page whose text runs a little longer no longer pushes it onto a new sheet.
- **Photos cropped to a circle keep their shape.** The photo is kept as a real picture, cropped and shown as an ellipse, instead of a square picture plus a second copy of the same photo.
- **Cards with a soft shadow are no longer black.** A transparent shadow under a card was read as a solid black fill when the cards were found as a table.
- **Page footers and charts stay on their page.** Text in the bottom tenth of an upright page, well clear of the rest, is placed at its position on the sheet instead of after a long gap, and a picture that gridlines cross, or that text wraps right up against, is placed on the page instead of in the text. A Word page whose text runs a little longer no longer sends its footer to a sheet of its own or stacks a chart's labels under its picture.
- **Columns no longer wrap early in Word.** A paragraph in a table cell gave up 10 pt on its right that the cell did not have, and a line that filled its cell wrapped on any rounding. Cells keep no spare room now, a line that fills its cell is set 1 twip a character narrower, and a line that Word would set wider than the PDF is condensed by at most 0.8 pt a character.
- **Fonts missing from your PC are replaced by a close match.** A PDF font that is not installed is written as an installed serif, sans or mono family of about the same width (Cambria, Times New Roman, Georgia, Calibri, Arial, Segoe UI, Consolas or Courier New) and its lines are measured in that family, instead of leaving the choice to Word, which fell back to Times New Roman. The installed list comes from the registry and only font files inside the Windows fonts folders are read; a font file that cannot be opened is skipped.
- **Tables with an inset tint keep their figures as text.** A table whose cells are an outer colour with a lighter rectangle inset in each, as Word's table styles print, left thin strips between the two. The table finder dropped the whole grid because of them, and the figures of its two-line rows ended up in a picture. Cells narrower or lower than 8 pt are no longer cells, so the table is one real table.
- **Centred titles no longer start left of the page.** A centred paragraph on two lines was given a hanging indent from the different left edges of its lines, and Word cut off its first letters. A centred paragraph gets no first-line or hanging indent.
- **Letter-spaced titles stay on one line.** Word adds the letter spacing after the last letter too, so a large spaced title that filled its column broke inside the word and pushed the page down. The last letter of such a line is a run of its own without the spacing.
- **Outlined boxes keep their frames.** Two outlined boxes a few points apart were read as the rows of one table that kept only the top and bottom lines. They stay two boxes with four sides, and the edge of an outlined box is no longer also written as a separate rule.
- **A number that opens a paragraph is no longer a list item.** `(1) The Supplier ...` followed by lines set flush with the number was made a list with a hanging indent and its first line split off. It is one paragraph now, justified when the PDF's is, and a line that begins with a word starting in o (`of`, `on`, `or`, `one`) no longer loses that word to a bullet: only a lone `o` or a bullet glyph is a list marker.
- **Tall panels no longer lose text.** A table row more than half a sheet high may split across sheets; Word clipped such a row and the words in the clipped part were lost.

### Internal
- **Pages are classified.** `POMELO_DEBUG=1` prints, for each page the converter handles, whether it is a design page (pictures or colour over more than 40 % of the sheet, a coloured background, or many short pieces of text at scattered positions) or a document page, and why. It is a log line only; the output does not depend on it.
- **Check PDF to Word with Microsoft Word.** `node test/fidelity/run.js --word` prints each converted DOCX with Microsoft Word and reports pages, recall, order and visual similarity against the original, with a 120 s limit per file and a Word of its own for every file. `compare.py --docx-words` counts how many source words the DOCX holds, treating tabs as spaces, and runs without Word. `--out` moves the results out of `test/fidelity/out`.
- **Settings accepts only known values.** `settings:set` keeps `enabled`, `openAtLogin` and `autoUpdate` (booleans), `theme` (`system`, `light` or `dark`) and `outputDir` only as `''`; anything else in a patch, including the update checker's keys, is dropped.
- **Packaging ships the changelog.** `tools/package.js` no longer excludes `CHANGELOG.md`.

## [0.1.5] - 06-11-2026

### Added
- **Convert from the right-click menu.** Right-click a file or folder and choose **Convert with Pomelo**; the format wheel opens at the pointer and you click a format. The drag gesture works exactly as before. On Windows 11 the entry is under **Show more options**. Pomelo adds it for your user account the first time it starts and removes it when you uninstall.
- **A guide for new users.** The first time Pomelo starts it opens a short guide with an animation of drag, tap Ctrl and drop, and a few questions and answers, with step-by-step instructions and pictures of where Pomelo sits in the tray and where the right-click entry is. The new **?** button next to the name in Settings opens it again; the animation shows a document, a spreadsheet and a picture being converted in turn.
- **Save conversions to a folder you choose.** Settings has a new **Save conversions to** dropdown. Leave it on **Default** and files are saved next to the original, as before; choose a folder and every conversion lands there, all in one place. If the folder you picked is gone, Pomelo says so and saves next to the original instead. Your original files are never changed.
- **Light and dark themes.** Settings has an Appearance control with System, Light and Dark. System follows Windows, as before; Light and Dark apply to every Pomelo window.
- **Source code and licences.** Advanced settings has a link to the source code and licences, and the third-party notices say where the source of FFmpeg and 7-Zip can be downloaded.

### Changed
- **The wheel's centre is now a Pomelo file.** While you hold a file over the wheel, its centre shows the file as a coloured icon with its format on it and a picture of its own: every format Pomelo reads (DOCX, XLSX, PNG, JPG, MP4, MP3, ZIP and the rest) has a different one, and a folder shows as a folder. Dragging several files shows a small stack with a count. Pointing at a format on the ring adds "to PDF" under the icon.
- **The trigger key is always Ctrl.** The Trigger key setting is gone from Settings, because Pomelo will use other keys for other gestures later. Drag a file and tap Ctrl, as before.
- **A cleaner update.** With **Check automatically** on, the toast now says "Update your Pomelo to v...", and clicking it opens Settings with the **Download update** button showing. Pressing the button opens a small **Pomelo Downloader** window with the stage, the percentage, the size and time left, and a Cancel button; you can minimise it. The installer's own window no longer appears. When the update is in, Pomelo reopens by itself (with Settings open again if you had it open) and a toast says it is now on the new version.
- **New engine parts install with an update.** An update that adds an engine to the PDF components you already have (as 0.1.3 did with OCR) now adds it for you, in the same window, instead of leaving you to press Install in Settings.

### Fixed
- **The wheel always opens on top.** On some PCs the format wheel opened behind the folder you were dragging from, so only the part outside that window showed.
- **No command window during an update.** A command window flashed on screen for a moment while Pomelo updated itself. The installer now waits for Pomelo to close on its own instead of using the pause that opened it.

## [0.1.4] - 05-11-2026

### Fixed
- **PDF to PowerPoint keeps text editable.** Text was left in the slide's background picture, where it cannot be edited, whenever it held a curly quote, a dash or a CJK character. It is now real text on the slide. Only Hebrew, Arabic and other right-to-left text, which cannot be drawn correctly as editable text, stays in the picture.
- **Scanned PDFs leave nothing behind.** Converting a scanned PDF to text, Markdown, HTML, EPUB or Excel left a temporary copy of the PDF in the temp folder every time. Pomelo now deletes it, and tries again if Windows still holds the file.
- **PDF conversion works on more PCs.** It failed where the `PYTHONSAFEPATH` environment variable is set. The PDF engine now runs the same way whatever that variable says.

## [0.1.3] - 04-11-2026

### Changed
- **PDF to Word is always editable.** The new converter rebuilds every page as real paragraphs (indents, alignment, line spacing, fonts, colours, underline, highlight), real bullet and numbered lists, real Word tables (ruled tables, tables drawn with shaded rows, and side-by-side blocks such as columns as borderless tables), shaded and outlined boxes, hyperlinks, a stretched colour for a full-page background, and pictures. Pictures, charts, logos and gradients stay pictures; text on a picture is a positioned paragraph you can still retype. The old "exact" mode, which wrote every line as its own frame, and the **PDF to Word > Layout** switch in Settings are gone.
- **Scanned PDFs are read with OCR.** RapidOCR runs offline, with models fetched once at install. A page that is only a picture is turned into text first, so PDF to Word, Excel, PowerPoint, Markdown, HTML, text and EPUB all work on scans.
- **A smaller PDF engine.** It is now PyMuPDF (pinned to 1.28.2), python-docx, RapidOCR and pillow-heif. A fresh install used to pull in PyMuPDF 2.x with its layout-analysis stack and `pdf2docx` (435 MB on disk); it is now 360 MB including OCR. **Settings > Advanced > Conversion engines** has a new **OCR** row; an existing PDF engine is rebuilt when you press Install.
- **A clearer engine page in the installer.** It says what the PDF choice contains (PDF to Word and more, OCR, HEIC; about 320 MB).
- **Failures report the best reason.** A conversion that fails reports the reason from the best engine instead of the last fallback's.

### Fixed
- **PDF to Word is much faster on text pages.** Every page that has nothing but text took 5 to 12 seconds (a per-pixel blank-page check in Python): 30 such pages took 161 seconds and a 110-page document hit the ten-minute limit. 40 pages now convert in about 6 seconds, and the time limit grows with the size of the PDF.
- **Scanned PDFs give real text.** A scanned PDF "converted" to a Word file with no text in it. It is now read with OCR, or says plainly that it needs the OCR component.
- **Plain reasons for failures.** A password-protected PDF and a damaged file each say so, without file paths or Python errors.
- **Fewer lost letters in PDF to Word.** Rotated text over other text lost letters ("PAID" became "PAI"), letter-spaced capitals came out with spaces inside the words ("I NVO I C E"), and white text on a shaded header disappeared.

### Internal
- **The installer is tested for real in CI.** The installer test installs, updates and uninstalls the real installer.

## [0.1.2] - 03-11-2026

### Changed
- **Update now installs the update for you.** Updating no longer sends you to the browser to run the installer again. Pomelo downloads the new version itself (with progress and time left), checks it against the SHA-256 published with the release, installs it quietly over the current one and starts again. It only downloads from GitHub, follows redirects only to GitHub's own hosts, throws away a download that is incomplete or does not match, and falls back to the download page when a release has no checksum. Settings, shortcuts and engines are left as they are.

### Fixed
- **The new version replaces the old one.** Installing over an older Pomelo could leave the old version running: a copy started from somewhere else (or not called `Pomelo.exe`) kept Pomelo's "only one copy" lock, so opening the new one just showed the old one's window and its old version number. The installer now stops whichever process holds that lock, and stops with a clear message if it cannot.
- **The installer says when Pomelo is already installed.** It shows which version, where, and that it will be updated (or reinstalled). An update goes into the folder Pomelo is already in and no longer asks about the folder or the conversion engines again; settings, shortcuts and engines are kept.

## [0.1.1] - 03-11-2026

### Added
- **Automatic update checks.** **Check automatically** in Settings (off by default). When on, Pomelo looks for a newer version 30 seconds after it starts and then once a day, and says so in a toast and on the tray icon when one exists. It never downloads or installs anything: the download starts only when you press **Download update**. A failed check is silent and retried a couple of hours later.
- **A PDF to Word layout choice.** **PDF to Word > Layout** in Settings > Advanced: **Exact** (the default) or **Editable**.

### Changed
- **PDF to Word is exact by default.** Every page keeps its size, positions, fonts, sizes, colours, spacing, links, pictures, shapes, rules and backgrounds. Text stays editable in place; whatever is not text (pictures, shapes, gradients, rules) sits behind it as the page background, and text that cannot be re-typed faithfully (right-to-left, rotated, symbol-font glyphs) stays in that background so it still looks right. A new **PDF to Word > Layout** setting (Advanced) switches to **Editable**, which rebuilds flowing paragraphs; designed pages (shapes or pictures behind text, columns, rotated text) are still converted exactly.
- **Progress on every toast.** The ring fills as a conversion goes (the cancel X stays in its middle), and the text beside it gives the percentage and about how long is left. Engines that can measure their progress report it (video and audio, pages of a PDF, archives); for the rest (LibreOffice and friends) the figure is an estimate that follows the clock, learned from how long that kind of conversion has taken on this PC before. The ring no longer just spins.
- **A better PDF reader for text formats.** PDF to Markdown, HTML, text and EPUB are read by one new reader (PyMuPDF): all text in reading order, columns in order, headings, lists, tables, links, bold and italic, code and pictures. The old Markdown route (pymupdf4llm) dropped text (a résumé lost 5%, an invoice a third) and is gone, along with its pinned install.
- **PDF to Excel works without ruled tables.** It finds borderless grids, and otherwise gives each page's text lines in a sheet.
- **PDF to PowerPoint keeps positions and links.** Text boxes sit at the original positions on a picture of everything else, and links are kept (they were lost before). PDF to RTF uses the flowing rebuild, since LibreOffice folded every page of an exact layout into one.
- **Better DOCX to PDF without LibreOffice.** The built-in conversion takes the page size, margins, default font and size from the document and no longer prints to the very edge of the sheet; Markdown, text and HTML copies get proper page margins too.
- **A smaller PDF engine download.** The optional PDF engine no longer installs `pymupdf4llm`, so it is smaller to download and carries one less licence to track.

### Fixed
- **Editable PDF to Word opens cleanly.** Hyperlinks were written inside text runs, which the file format forbids, so link text vanished in LibreOffice and could trip Word. Bullet lists and skill lines were turned into fixed-height two-column tables that clipped text (about 7% of the words in a test résumé); lone spaces between styled words were dropped (Stack:PHP); bullets are now real Word lists.

### Internal
- **A fidelity harness.** `npm run fidelity:samples` then `npm run test:fidelity` convert PDFs, print the result back to PDF and score text, positions, fonts, colours, links and look against the original.

## [0.1.0] - 03-11-2026

### Added
- **Drag, tap Ctrl, drop.** Drag a file, folder or desktop icon, tap Ctrl, and drop it on a format wheel to convert it next to the original.
- **Many formats.** Conversions for images (incl. HEIC), video, audio, PDF, documents, EPUB, slides, spreadsheets, subtitles, archives (ZIP, 7Z, TAR, GZIP, RAR input) and folders.
- **High-fidelity PDF conversion.** PDF to Word, Excel and Markdown through optional Python engines; LibreOffice and Pandoc are used when installed.
- **Parallel conversions.** A toast stack in the bottom-right corner folds into one progress ring beyond three.
- **A Settings window.** An everyday view and an Advanced view, with Check for updates.
- **Cancel any conversion.** A cancel button (✕ in the middle of the progress ring) on every running conversion and on the summary toast; helper programs are stopped and partial files deleted.
- **One-click engine installs.** **Install** for optional engines (PDF fidelity, HEIC export, LibreOffice, Pandoc) in Settings > Advanced, and an **Uninstall** button that removes Pomelo and only the engines Pomelo installed.
- **Start with Windows.** On by default.
- **A Windows installer.** Inno Setup, per-user, no administrator rights, three screens (location, optional conversion engines, shortcuts). Silent install: `/SILENT`, optionally `/ENGINES=pdf2docx,soffice,pandoc`.

### Changed
- **LibreOffice installs without administrator rights.** It is no longer installed with winget. Its official MSI is downloaded (hash-checked) and unpacked into Pomelo's own folder, so there is no administrator prompt and no desktop shortcut, and uninstalling is deleting the folder.
- **Live progress in the installer.** It shows which engine is installing, how far and how long, and its finish page says which one to retry if an engine fails.
- **Uninstalling from Pomelo shows the Windows uninstaller.** It opens with its progress window, instead of a hidden command-line step.
- **A desktop shortcut by default.** The desktop shortcut option is on by default.
- **A native drag helper.** Drag detection now runs in a small native helper (`pomelo-input.exe`) instead of a PowerShell script. It reports the trigger key and Esc only while the left mouse button is held, and no longer writes into Explorer's memory to find desktop icons.
- **A new logo and icon set.** Flat and minimal.
- **Renamed to Pomelo.** With a pomelo-pink and rind-green look and a new logo.
- **Better GIF export.** GIF export keeps the whole clip (frame rate and size scale down for longer clips, 5 minute limit) and animated GIF/WebP keep their animation when converted to each other.

### Internal
- **Engine commands.** Headless `Pomelo.exe --install-engines=...` and `--uninstall-engines`, used by the installer and uninstaller.
- **A release workflow.** It builds the installer from a version tag into a draft GitHub release, with a SHA-256 checksum and a build attestation.

[Unreleased]: https://github.com/zzvimalzz/pomelo/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/zzvimalzz/pomelo/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/zzvimalzz/pomelo/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/zzvimalzz/pomelo/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/zzvimalzz/pomelo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zzvimalzz/pomelo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zzvimalzz/pomelo/releases/tag/v0.1.0
