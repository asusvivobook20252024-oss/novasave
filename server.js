// ============================================
//  NovaSave - Backend Server v2
//  Uses yt-dlp — No API key needed
//  By Rajeev Singh
// ============================================

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { exec } = require('child_process');
const fs       = require('fs');
const https    = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── yt-dlp binary path ────────────────────────
// On Render/Railway: installed via pip → 'yt-dlp'
// Local fallback: ./yt-dlp binary
let YT_DLP = 'yt-dlp';
const LOCAL_BIN = path.join(__dirname, 'yt-dlp');
if (fs.existsSync(LOCAL_BIN)) YT_DLP = LOCAL_BIN;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, ytdlp: YT_DLP }));

// ── Frontend ──────────────────────────────────
app.get('/', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ==============================================
//  POST /api/fetch  →  main endpoint
// ==============================================
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const platform = detectPlatform(url);
  if (!platform)
    return res.status(400).json({ error: 'Unsupported platform. YouTube, Instagram, TikTok etc. try karein.' });

  console.log(`[NovaSave] ${platform} → ${url}`);

  try {
    const info = await getVideoInfo(url);
    if (!info)
      return res.status(500).json({ error: 'Video info nahi mili. Public video ka link paste karein.' });

    return res.json({ success: true, platform, ...info });
  } catch (e) {
    console.error('[fetch error]', e.message);
    return res.status(500).json({ error: 'Server error. Dobara try karein.' });
  }
});

// ==============================================
//  yt-dlp  — extract info without downloading
// ==============================================
function getVideoInfo(url) {
  return new Promise((resolve) => {

    // --dump-json = metadata only (no download)
    // --no-playlist = single video only
    // -f "bestvideo[ext=mp4]+bestaudio/best" = merged formats preferred
    const cmd = [
      YT_DLP,
      '--dump-json',
      '--no-playlist',
      '--socket-timeout 20',
      '--no-warnings',
      `"${url}"`
    ].join(' ');

    exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {

      if (err || !stdout.trim()) {
        console.warn('[yt-dlp]', (stderr || err?.message || '').slice(0, 400));
        return resolve(null);
      }

      let info;
      try { info = JSON.parse(stdout.trim()); }
      catch { return resolve(null); }

      // ── Quality list ────────────────────────
      const LABELS = {
        2160: '2160p (4K)',   1440: '1440p (2K)',
        1080: '1080p (Full HD)', 720: '720p (HD)',
        480:  '480p',         360:  '360p',
        240:  '240p',         144:  '144p'
      };

      const seen = new Set();
      const qualities = [];

      // Prefer merged video+audio mp4 formats
      const fmts = (info.formats || [])
        .filter(f =>
          f.url &&
          f.vcodec && f.vcodec !== 'none' &&
          f.acodec && f.acodec !== 'none'
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      for (const f of fmts) {
        const h     = f.height || 0;
        const label = LABELS[h] || (h ? `${h}p` : (f.format_note || 'Best Quality'));
        if (seen.has(label)) continue;
        seen.add(label);

        const bytes = f.filesize || f.filesize_approx || 0;
        const size  = bytes ? (bytes / 1048576).toFixed(1) + ' MB' : '';

        qualities.push({ label, size, url: f.url });
        if (qualities.length >= 5) break;
      }

      // Fallback: use top-level url if no merged formats
      if (qualities.length === 0) {
        const fallbackUrl = info.url ||
          (info.formats || []).slice(-1)[0]?.url || '';
        if (fallbackUrl)
          qualities.push({ label: 'Best Quality', size: '', url: fallbackUrl });
      }

      // ── Audio-only URL ──────────────────────
      const audioFmt = (info.formats || [])
        .filter(f => f.url && f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      const audioUrl = audioFmt?.url || qualities[0]?.url || '';

      resolve({
        title:     info.title     || 'Video',
        thumbnail: info.thumbnail || '',
        duration:  secToMin(info.duration),
        qualities,
        audioUrl,
        audioLabel: 'Audio Only',
        audioSub:   'MP3'
      });
    });
  });
}

// ==============================================
//  Helpers
// ==============================================
function detectPlatform(url) {
  const map = [
    { key: 'YouTube',   p: ['youtube.com', 'youtu.be'] },
    { key: 'Instagram', p: ['instagram.com'] },
    { key: 'Facebook',  p: ['facebook.com', 'fb.watch', 'fb.com'] },
    { key: 'TikTok',    p: ['tiktok.com'] },
    { key: 'Twitter/X', p: ['twitter.com', 'x.com'] },
    { key: 'Vimeo',     p: ['vimeo.com'] },
    { key: 'Pinterest', p: ['pinterest.com', 'pin.it'] }
  ];
  for (const c of map) if (c.p.some(p => url.includes(p))) return c.key;
  return null;
}

function secToMin(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ==============================================
//  Auto-install yt-dlp if not present
// ==============================================
function installYtdlp() {
  return new Promise((resolve) => {
    // Check if already available
    exec(`${YT_DLP} --version`, (err, out) => {
      if (!err && out.trim()) {
        console.log(`✅ yt-dlp ${out.trim()} ready`);
        return resolve();
      }

      console.log('⬇️  yt-dlp not found. Installing via pip...');
      exec('pip3 install -q yt-dlp || pip install -q yt-dlp', (e2) => {
        if (!e2) {
          console.log('✅ yt-dlp installed via pip');
          return resolve();
        }
        // Download binary directly
        console.log('⬇️  Downloading yt-dlp binary...');
        const dest = path.join(__dirname, 'yt-dlp');
        const file = fs.createWriteStream(dest);
        const dlUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

        const get = (u) => https.get(u, (r) => {
          if ([301,302].includes(r.statusCode)) return get(r.headers.location);
          r.pipe(file);
          file.on('finish', () => {
            file.close();
            fs.chmodSync(dest, 0o755);
            YT_DLP = dest;
            console.log('✅ yt-dlp binary ready');
            resolve();
          });
        }).on('error', (e3) => {
          console.error('❌ yt-dlp install failed:', e3.message);
          resolve(); // continue anyway — will fail gracefully per request
        });

        get(dlUrl);
      });
    });
  });
}

// ==============================================
//  Bootstrap
// ==============================================
installYtdlp().then(() => {
  app.listen(PORT, () =>
    console.log(`🚀 NovaSave running → http://localhost:${PORT}`)
  );
});
