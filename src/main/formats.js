// SPDX-License-Identifier: AGPL-3.0-or-later
// Format registry: what each extension is, and which targets the wheel offers for it.
const fs = require('fs');
const path = require('path');

const ALIASES = {
  jpeg: 'jpg', htm: 'html', markdown: 'md', tif: 'tiff', xlsm: 'xlsx', text: 'txt', heif: 'heic', aif: 'aiff',
  oga: 'ogg', tgz: 'gz', mpeg: 'mpg', '3gp': 'mp4',
};

const VIDEO = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv'];                      // wheel targets for video
const VIDEO_SOURCES = [...VIDEO, 'm4v', 'mpg', 'flv'];                          // also readable
const AUDIO = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus', 'aiff', 'wma'];
const AUDIO_SOURCES = [...AUDIO, 'aac'];

const GROUP_OF = {
  docx: 'doc', doc: 'doc', rtf: 'doc', odt: 'doc', txt: 'doc', md: 'doc', html: 'doc', epub: 'doc',
  pdf: 'pdf',
  xlsx: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  pptx: 'slide', ppt: 'slide',
  png: 'image', jpg: 'image', webp: 'image', bmp: 'image', gif: 'image', tiff: 'image', avif: 'image', svg: 'image', heic: 'image',
  srt: 'subtitle', vtt: 'subtitle',
  zip: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', rar: 'archive', folder: 'folder',
  ...Object.fromEntries(VIDEO_SOURCES.map((e) => [e, 'video'])),
  ...Object.fromEntries(AUDIO_SOURCES.map((e) => [e, 'audio'])),
};

// Every extension of a group, in the order GROUP_OF lists them.
const extsInGroup = (group) => Object.keys(GROUP_OF).filter((e) => GROUP_OF[e] === group);

// The Office formats LibreOffice opens and saves, by kind.
const OFFICE = { doc: ['docx', 'doc', 'rtf', 'odt'], sheet: ['xlsx', 'xls', 'ods'], slide: ['pptx', 'ppt'] };

const without = (list, ext) => list.filter((e) => e !== ext);

// Preferred wheel order per source format. The wheel shows the first 8 that are actually possible.
const TARGET_ORDER = {
  // documents
  docx: ['pdf', 'md', 'txt', 'html', 'epub', 'png', 'jpg', 'rtf', 'doc', 'odt'],
  doc: ['docx', 'pdf', 'md', 'txt', 'html', 'epub', 'png', 'jpg', 'rtf', 'odt'],
  rtf: ['docx', 'pdf', 'md', 'txt', 'html', 'epub', 'png', 'jpg', 'odt', 'doc'],
  odt: ['docx', 'pdf', 'md', 'txt', 'html', 'epub', 'png', 'jpg', 'rtf', 'doc'],
  txt: ['pdf', 'docx', 'md', 'html', 'epub', 'png', 'jpg', 'rtf'],
  md: ['pdf', 'docx', 'html', 'txt', 'epub', 'png', 'jpg'],
  html: ['pdf', 'docx', 'md', 'txt', 'epub', 'png', 'jpg'],
  epub: ['pdf', 'docx', 'md', 'txt', 'html', 'png', 'jpg'],
  pdf: ['docx', 'pptx', 'xlsx', 'png', 'jpg', 'txt', 'md', 'epub', 'html', 'doc'],
  // spreadsheets
  xlsx: ['pdf', 'csv', 'xls', 'ods', 'tsv', 'html', 'json'],
  xls: ['xlsx', 'pdf', 'csv', 'ods', 'tsv', 'html', 'json'],
  ods: ['xlsx', 'pdf', 'csv', 'xls', 'tsv', 'html', 'json'],
  csv: ['xlsx', 'pdf', 'tsv', 'xls', 'ods', 'html', 'json'],
  tsv: ['xlsx', 'pdf', 'csv', 'xls', 'ods', 'html', 'json'],
  // slides
  pptx: ['pdf', 'png', 'jpg', 'ppt'],
  ppt: ['pdf', 'png', 'jpg', 'pptx'],
  // images
  png: ['jpg', 'webp', 'heic', 'tiff', 'avif', 'bmp', 'pdf', 'gif'],
  jpg: ['png', 'webp', 'heic', 'tiff', 'avif', 'bmp', 'pdf', 'gif'],
  webp: ['png', 'jpg', 'heic', 'tiff', 'avif', 'bmp', 'pdf', 'gif'],
  bmp: ['png', 'jpg', 'webp', 'heic', 'tiff', 'avif', 'pdf', 'gif'],
  gif: ['png', 'jpg', 'webp', 'heic', 'tiff', 'avif', 'bmp', 'pdf'],
  tiff: ['png', 'jpg', 'webp', 'heic', 'avif', 'bmp', 'pdf', 'gif'],
  avif: ['png', 'jpg', 'webp', 'heic', 'tiff', 'bmp', 'pdf', 'gif'],
  heic: ['jpg', 'png', 'webp', 'tiff', 'avif', 'bmp', 'pdf', 'gif'],
  svg: ['png', 'jpg', 'webp', 'pdf'],
  // subtitles
  srt: ['vtt', 'txt'],
  vtt: ['srt', 'txt'],
  // archives
  zip: ['folder', '7z', 'tar', 'gz'],        // "folder" = extract next to the archive
  '7z': ['folder', 'zip', 'tar', 'gz'],
  tar: ['folder', 'zip', '7z', 'gz'],
  gz: ['folder', 'zip', '7z', 'tar'],
  rar: ['folder', 'zip', '7z', 'tar', 'gz'],
  folder: ['zip', '7z', 'tar', 'gz'],        // compress a folder
  // video and audio
  ...Object.fromEntries(VIDEO_SOURCES.map((e) => [e, [...without(VIDEO, e), 'gif', 'mp3']])),
  ...Object.fromEntries(AUDIO_SOURCES.map((e) => [e, without(AUDIO, e)])),
};

const LABELS = {
  pdf: ['PDF', 'Portable doc'], docx: ['DOCX', 'Word'], doc: ['DOC', 'Word 97'], rtf: ['RTF', 'Rich text'],
  odt: ['ODT', 'OpenDocument'], txt: ['TXT', 'Plain text'], md: ['MD', 'Markdown'], html: ['HTML', 'Web page'], epub: ['EPUB', 'E-book'],
  xlsx: ['XLSX', 'Excel'], xls: ['XLS', 'Excel 97'], ods: ['ODS', 'OpenDocument'], csv: ['CSV', 'Comma-separated'],
  tsv: ['TSV', 'Tab-separated'], json: ['JSON', 'Data'], pptx: ['PPTX', 'PowerPoint'], ppt: ['PPT', 'PowerPoint 97'],
  png: ['PNG', 'Image'], jpg: ['JPG', 'Image'], webp: ['WEBP', 'Image'], bmp: ['BMP', 'Image'], gif: ['GIF', 'Animated'],
  tiff: ['TIFF', 'Image'], avif: ['AVIF', 'Image'], svg: ['SVG', 'Vector'], heic: ['HEIC', 'Image'],
  mp4: ['MP4', 'Video'], mov: ['MOV', 'Video'], mkv: ['MKV', 'Video'], webm: ['WEBM', 'Video'], avi: ['AVI', 'Video'], wmv: ['WMV', 'Video'],
  m4v: ['M4V', 'Video'], mpg: ['MPG', 'Video'], flv: ['FLV', 'Video'],
  mp3: ['MP3', 'Audio'], wav: ['WAV', 'Lossless'], ogg: ['OGG', 'Audio'], m4a: ['M4A', 'Audio'], flac: ['FLAC', 'Lossless'],
  opus: ['OPUS', 'Audio'], aiff: ['AIFF', 'Lossless'], wma: ['WMA', 'Audio'], aac: ['AAC', 'Audio'],
  srt: ['SRT', 'Subtitles'], vtt: ['VTT', 'Subtitles'],
  zip: ['ZIP', 'Archive'], '7z': ['7Z', 'Archive'], tar: ['TAR', 'Archive'], gz: ['GZIP', 'tar.gz'], rar: ['RAR', 'Archive'], folder: ['FOLDER', 'Extract'],
};

const MAX_SEGMENTS = 8;

function extOf(file) {
  try { if (fs.statSync(file).isDirectory()) return 'folder'; } catch { /* not on disk: go by the name */ }
  const e = path.extname(file).slice(1).toLowerCase();
  return ALIASES[e] || e;
}

// File name without its (possibly double) extension: "photos.tar.gz" -> "photos".
function baseOf(file) {
  const name = path.basename(file);
  if (extOf(file) === 'folder') return name;                 // "Project v1.2" has no extension to strip
  const m = /\.tar\.(gz|bz2|xz)$/i.exec(name);
  return m ? name.slice(0, -m[0].length) : name.slice(0, name.length - path.extname(name).length);
}

const groupOf = (ext) => GROUP_OF[ext] || null;
const labelOf = (ext) => (LABELS[ext] || [ext.toUpperCase(), ''])[0];
const subOf = (ext) => (LABELS[ext] || ['', ''])[1];

// canConvert(from, to) -> bool, for the engines that are actually available (see convert/index.js)
function targetsForExt(from, canConvert) {
  return (TARGET_ORDER[from] || []).filter((to) => to !== from && canConvert(from, to));
}

// Targets that every selected file can be converted to, in the first file's preferred order.
function targetsForFiles(files, canConvert) {
  const exts = files.map(extOf);
  if (!exts.length) return [];
  let common = targetsForExt(exts[0], canConvert);
  for (const e of exts.slice(1)) {
    const these = new Set(targetsForExt(e, canConvert));
    common = common.filter((t) => these.has(t));
  }
  return common.slice(0, MAX_SEGMENTS).map((ext) => ({ id: ext, ext, label: labelOf(ext), sub: subOf(ext) }));
}

module.exports = { extOf, baseOf, groupOf, labelOf, targetsForFiles, extsInGroup, ALIASES, TARGET_ORDER, VIDEO, VIDEO_SOURCES, AUDIO, AUDIO_SOURCES, OFFICE };
