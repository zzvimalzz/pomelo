// SPDX-License-Identifier: AGPL-3.0-or-later
// Video and audio through FFmpeg (the ffmpeg-static build, GPL-3.0+, or a system FFmpeg). Runs as a separate process.
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { uniquePath, killOnCancel, currentContext, CancelledError } = require('../convert/util');
const { track } = require('../../shared/node/process');
const { VIDEO, VIDEO_SOURCES, AUDIO, AUDIO_SOURCES } = require('../formats');
const { bundled } = require('../../shared/node/paths');
const { where } = require('../../shared/node/which');

function detect() {
  try {
    const p = require('ffmpeg-static');
    const unpacked = p && bundled(p);
    if (unpacked && fs.existsSync(unpacked)) return unpacked;
  } catch { /* package not installed */ }
  return where('ffmpeg.exe');
}

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';                              // H.264 + yuv420p need even dimensions
const H264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', EVEN];

// A GIF has no compression to speak of, so longer clips get fewer frames per second and a smaller picture to keep the file usable.
const GIF_MAX_SECONDS = 300;
function gifFilter(duration) {
  const [fps, width] = !duration ? [12, 640] : duration <= 10 ? [15, 720] : duration <= 30 ? [12, 640] : duration <= 90 ? [10, 480] : [8, 360];
  return `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
}

// Per-target encoder settings. Audio targets drop any video stream (-vn).
const ARGS = {
  mp4: [...H264, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  mov: [...H264, '-c:a', 'aac', '-b:a', '160k'],
  mkv: [...H264, '-c:a', 'aac', '-b:a', '160k'],
  webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k'],
  avi: ['-c:v', 'mpeg4', '-q:v', '3', '-vf', EVEN, '-c:a', 'libmp3lame', '-q:a', '3'],
  wmv: ['-c:v', 'wmv2', '-b:v', '3000k', '-c:a', 'wmav2', '-b:a', '160k'],
  gif: ['-an', '-loop', '0'],                                                       // -vf is added per clip, see gifFilter
  mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
  wav: ['-vn', '-c:a', 'pcm_s16le'],
  ogg: ['-vn', '-c:a', 'libvorbis', '-q:a', '5'],
  m4a: ['-vn', '-c:a', 'aac', '-b:a', '192k'],
  flac: ['-vn', '-c:a', 'flac'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '128k'],
  aiff: ['-vn', '-c:a', 'pcm_s16be'],
  wma: ['-vn', '-c:a', 'wmav2', '-b:a', '192k'],
};

const seconds = (h, m, s) => +h * 3600 + +m * 60 + parseFloat(s);

// Length of a media file in seconds (0 if FFmpeg cannot tell). `ffmpeg -i` prints it and exits with an error, which is fine here.
const probeDuration = (bin, src) => new Promise((resolve) => {
  const child = execFile(bin, ['-hide_banner', '-nostdin', '-i', src], { windowsHide: true, timeout: 20000 }, (_err, _out, stderr) => {
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr || '');
    resolve(m ? seconds(m[1], m[2], m[3]) : 0);
  });
  track(child);
});

module.exports = {
  name: 'ffmpeg',
  detect,
  supports(from, to, engines) {
    if (!engines.ffmpeg || from === to || !ARGS[to]) return false;
    if (VIDEO_SOURCES.includes(from)) return VIDEO.includes(to) || to === 'gif' || AUDIO.includes(to);
    if (AUDIO_SOURCES.includes(from)) return AUDIO.includes(to);
    return false;
  },
  async run({ src, to, dir, base, engines, onProgress }) {
    let extra = [];
    if (to === 'gif') {
      const length = await probeDuration(engines.ffmpeg, src);
      if (length > GIF_MAX_SECONDS) throw new Error(`This video is ${Math.round(length / 60)} minutes long, too long for a GIF (limit ${GIF_MAX_SECONDS / 60} minutes). Convert a shorter clip.`);
      extra = ['-vf', gifFilter(length)];
    }
    const out = uniquePath(dir, base, to);
    const args = ['-hide_banner', '-nostdin', '-y', '-i', src, ...ARGS[to], ...extra, '-map_metadata', '0', '-progress', 'pipe:1', '-nostats', out];
    return new Promise((resolve, reject) => {
      const child = track(spawn(engines.ffmpeg, args, { windowsHide: true }));
      const stopListening = killOnCancel(child);
      let duration = 0;
      let tail = [];
      let lastReport = 0;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(d);
        if (m && !duration) duration = seconds(m[1], m[2], m[3]);
        tail = [...tail, ...d.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean)].slice(-12);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        const m = /out_time_(?:us|ms)=(\d+)/.exec(d);
        if (!m || !duration || !onProgress) return;
        const now = Date.now();
        if (now - lastReport < 250) return;
        lastReport = now;
        onProgress(Math.min(0.99, +m[1] / 1e6 / duration));
      });
      child.on('error', reject);
      child.on('close', (code) => {
        stopListening();
        if (currentContext()?.signal?.aborted) { fs.rmSync(out, { force: true }); return reject(new CancelledError()); }
        if (code === 0 && fs.existsSync(out)) return resolve([out]);
        fs.rmSync(out, { force: true });
        reject(new Error(tail.filter((l) => !/^(frame|size|time|bitrate|speed|progress)=/.test(l)).pop() || `ffmpeg exited with code ${code}`));
      });
    });
  },
};
