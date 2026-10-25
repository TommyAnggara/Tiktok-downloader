const express = require('express');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// --- batas request sederhana: 20 per menit per IP ---
const hits = new Map();
function limiter(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 20) return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' });
  list.push(now);
  hits.set(ip, list);
  next();
}

// --- hanya izinkan domain TikTok ---
const PAGE_HOSTS = ['tiktok.com'];
const CDN_HOSTS = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'tiktokv.us', 'ibytedtos.com', 'byteimg.com', 'muscdn.com', 'tiktok.com'];
const hostOk = (u, list) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && list.some(h => x.hostname === h || x.hostname.endsWith('.' + h));
  } catch { return false; }
};

// cookie per video (dibutuhkan TikTok saat mengunduh file)
const cookies = new Map();
function remember(id, c) {
  if (cookies.size > 500) cookies.delete(cookies.keys().next().value);
  cookies.set(id, c);
}

app.get('/api/info', limiter, async (req, res) => {
  const link = String(req.query.url || '').trim();
  if (!hostOk(link, PAGE_HOSTS)) return res.status(400).json({ error: 'Link harus dari tiktok.com.' });
  try {
    const page = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    const html = await page.text();
    const cookie = (page.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return res.status(502).json({ error: 'Halaman TikTok tidak bisa dibaca. Coba lagi nanti.' });
    const item = JSON.parse(m[1])?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    if (!item) return res.status(404).json({ error: 'Konten tidak ditemukan. Mungkin privat atau sudah dihapus.' });

    remember(item.id, cookie);
    const base = { id: item.id, title: item.desc || '', author: item.author?.uniqueId || '', cover: item.video?.cover || '' };
    const images = item.imagePost?.images;
    if (images?.length) {
      return res.json({ ...base, type: 'photo', items: images.map((im, i) => ({ kind: 'photo', url: im.imageURL.urlList[0], name: `tiktok-${item.id}-${i + 1}.jpg` })) });
    }
    const v = item.video?.downloadAddr || item.video?.playAddr;
    if (!v) return res.status(404).json({ error: 'Tidak ada file yang bisa diunduh.' });
    res.json({ ...base, type: 'video', items: [{ kind: 'video', url: v, name: `tiktok-${item.id}.mp4` }] });
  } catch (e) {
    res.status(500).json({ error: 'Terjadi kesalahan saat mengambil data.' });
  }
});

app.get('/api/download', limiter, async (req, res) => {
  const { u, name = 'tiktok', id = '', inline } = req.query;
  if (!hostOk(String(u), CDN_HOSTS)) return res.status(400).send('URL tidak valid');
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://www.tiktok.com/', Cookie: cookies.get(String(id)) || '' } });
    if (!r.ok || !r.body) return res.status(502).send('Gagal mengambil file');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    const len = r.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    if (!inline) res.setHeader('Content-Disposition', `attachment; filename="${String(name).replace(/[^\w.-]/g, '_')}"`);
    Readable.fromWeb(r.body).pipe(res);
  } catch {
    res.status(500).send('Terjadi kesalahan');
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log('Berjalan di port ' + PORT));
