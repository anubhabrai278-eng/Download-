'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = BASE_URL.startsWith('https://');
const MAX_UPLOAD_MB = Number(env.MAX_UPLOAD_MB) || 2048;

for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ADMIN_PASSWORD', 'SESSION_SECRET']) {
  if (!env[k]) { console.error(`Missing ${k}. Copy .env.example to .env and fill it in.`); process.exit(1); }
}
if (env.SESSION_SECRET.length < 24) { console.error('SESSION_SECRET must be at least 24 characters.'); process.exit(1); }

/* ------------------------------------------------------------------ */
/* Storage (single JSON file, no native dependencies)                  */
/* ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_PATH = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(FILES_DIR, { recursive: true });

const DEFAULTS = {
  config: {
    siteTitle: 'LOOT VAULT',
    tagline: 'Clear every quest to crack the vault.',
    rewardName: 'Mystery Loot',
    videoId: '',
    channelId: '',
    watchPercent: 90,
    require: { watch: true, subscribe: true, like: true, comment: true },
    download: { mode: 'file', fileName: '', fileSize: 0, url: '' },
    linkTtlMinutes: 10,
    maxDownloadsPerUser: 3
  },
  unlocks: [],
  blocked: [],
  stats: { logins: 0, verifyRuns: 0, unlocks: 0, downloads: 0, fails: { watch: 0, subscribe: 0, like: 0, comment: 0 } }
};
const clone = o => JSON.parse(JSON.stringify(o));

function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const dc = d.config || {};
    return {
      unlocks: d.unlocks || [],
      blocked: d.blocked || [],
      config: {
        ...DEFAULTS.config, ...dc,
        require: { ...DEFAULTS.config.require, ...(dc.require || {}) },
        download: { ...DEFAULTS.config.download, ...(dc.download || {}) }
      },
      stats: { ...DEFAULTS.stats, ...(d.stats || {}), fails: { ...DEFAULTS.stats.fails, ...((d.stats || {}).fails || {}) } }
    };
  } catch { return clone(DEFAULTS); }
}
const db = loadDb();

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

/* ------------------------------------------------------------------ */
/* Cookies, sessions, rate limiting                                    */
/* ------------------------------------------------------------------ */
const sign = v => crypto.createHmac('sha256', env.SESSION_SECRET).update(v).digest('base64url');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const signed = value + '.' + sign(value);
  res.append('Set-Cookie', `${name}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`);
}
function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? '; Secure' : ''}`);
}
function readSigned(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const v = raw.slice(0, i), mac = raw.slice(i + 1), exp = sign(v);
  if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
  return v;
}

const sessions = new Map();       // player sessions (in memory)
const adminSessions = new Map();  // admin sessions
const tokens = new Map();         // one-time download tokens
const SESSION_MS = 55 * 60 * 1000; // Google access tokens last ~1 hour

function createSession(res, data) {
  const id = crypto.randomBytes(24).toString('base64url');
  const s = { ...data, id, expires: Date.now() + SESSION_MS, watchSeconds: 0, lastBeat: 0, lastPlaying: false, steps: {} };
  sessions.set(id, s);
  setCookie(res, 'sid', id, SESSION_MS / 1000);
  return s;
}
function getSession(req) {
  const id = readSigned(req, 'sid');
  const s = id && sessions.get(id);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(id); return null; }
  return s;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  for (const [k, v] of adminSessions) if (v.expires < now) adminSessions.delete(k);
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
}, 60 * 1000).unref();

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

const isBlocked = id => db.blocked.some(b => b.channelId === id);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* YouTube / Google helpers                                            */
/* ------------------------------------------------------------------ */
async function yt(token, endpoint, params) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + endpoint + '?' + new URLSearchParams(params), {
    headers: { Authorization: 'Bearer ' + token }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
    if (reason === 'quotaExceeded') throw new Error('YouTube API quota reached. Try again later.');
    if (reason === 'commentsDisabled') throw new Error('Comments are turned off on this video.');
    throw new Error((j.error && j.error.message) || 'YouTube API error');
  }
  return j;
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const videoCache = new Map();
async function videoDuration(token) {
  const id = db.config.videoId;
  const hit = videoCache.get(id);
  if (hit && hit.at > Date.now() - 3600e3) return hit.duration;
  const j = await yt(token, 'videos', { part: 'contentDetails', id });
  const item = j.items && j.items[0];
  if (!item) throw new Error('Video not found. Check the Video ID in the admin panel.');
  const duration = parseDuration(item.contentDetails.duration);
  videoCache.set(id, { duration, at: Date.now() });
  return duration;
}

/* ---- The four quest checks (all run on the server) ---- */
async function checkWatch(s) {
  const duration = await videoDuration(s.token);
  if (!duration) return { ok: false, msg: 'This video length cannot be tracked.' };
  const need = Math.ceil(duration * db.config.watchPercent / 100);
  const have = Math.floor(s.watchSeconds);
  return have >= need ? { ok: true } : { ok: false, msg: `Keep watching: ${have}s of ${need}s tracked.` };
}
async function checkSubscribe(s) {
  const j = await yt(s.token, 'subscriptions', { part: 'id', mine: 'true', forChannelId: db.config.channelId });
  return (j.items || []).length ? { ok: true } : { ok: false, msg: 'No subscription found for this channel.' };
}
async function checkLike(s) {
  const j = await yt(s.token, 'videos/getRating', { id: db.config.videoId });
  return j.items && j.items[0] && j.items[0].rating === 'like' ? { ok: true } : { ok: false, msg: 'This video is not liked yet.' };
}
async function checkComment(s) {
  let pageToken = '';
  for (let i = 0; i < 10; i++) { // scans the newest 1000 top-level comments
    const p = { part: 'snippet', videoId: db.config.videoId, maxResults: '100', order: 'time' };
    if (pageToken) p.pageToken = pageToken;
    const j = await yt(s.token, 'commentThreads', p);
    const found = (j.items || []).some(t => {
      const a = t.snippet.topLevelComment.snippet.authorChannelId;
      return a && a.value === s.channelId;
    });
    if (found) return { ok: true };
    pageToken = j.nextPageToken;
    if (!pageToken) break;
  }
  return { ok: false, msg: 'No comment from you was found on this video.' };
}
const CHECKS = { watch: checkWatch, subscribe: checkSubscribe, like: checkLike, comment: checkComment };

/* ------------------------------------------------------------------ */
/* App + security headers                                              */
/* ------------------------------------------------------------------ */
const app = express();
if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; " +
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com; " +
    "img-src 'self' data: https://*.ggpht.com https://*.googleusercontent.com https://i.ytimg.com; " +
    "style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/* ------------------------------------------------------------------ */
/* Player auth (Google OAuth, read-only YouTube scope)                 */
/* ------------------------------------------------------------------ */
app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('base64url');
  setCookie(res, 'oauth_state', state, 600);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: BASE_URL + '/auth/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    state,
    prompt: 'select_account'
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q);
});

app.get('/auth/callback', wrap(async (req, res) => {
  const fail = msg => res.redirect('/?error=' + encodeURIComponent(msg));
  const expected = readSigned(req, 'oauth_state');
  clearCookie(res, 'oauth_state');
  if (req.query.error) return fail('Sign-in was cancelled.');
  if (!expected || expected !== req.query.state || !req.query.code) return fail('Sign-in check failed. Please try again.');

  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: String(req.query.code),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: BASE_URL + '/auth/callback',
      grant_type: 'authorization_code'
    })
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.access_token) return fail('Google rejected the sign-in. Please try again.');

  let me;
  try { me = await yt(tj.access_token, 'channels', { part: 'snippet', mine: 'true' }); }
  catch (e) { return fail(e.message); }
  const ch = me.items && me.items[0];
  if (!ch) return fail('This Google account has no YouTube channel.');
  if (isBlocked(ch.id)) return fail('This account is blocked.');

  const old = getSession(req); if (old) sessions.delete(old.id);
  createSession(res, {
    token: tj.access_token,
    channelId: ch.id,
    name: ch.snippet.title,
    avatar: ch.snippet.thumbnails && (ch.snippet.thumbnails.default || {}).url || ''
  });
  db.stats.logins++; save();
  res.redirect('/');
}));

app.get('/auth/logout', (req, res) => {
  const s = getSession(req);
  if (s) sessions.delete(s.id);
  clearCookie(res, 'sid');
  res.redirect('/');
});

/* ------------------------------------------------------------------ */
/* Player API                                                          */
/* ------------------------------------------------------------------ */
function needUser(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Sign in to continue.' });
  if (isBlocked(s.channelId)) return res.status(403).json({ error: 'This account is blocked.' });
  req.sess = s; next();
}

app.get('/api/state', wrap(async (req, res) => {
  const c = db.config, s = getSession(req);
  const out = {
    configured: !!(c.videoId && c.channelId),
    config: {
      siteTitle: c.siteTitle, tagline: c.tagline, rewardName: c.rewardName,
      videoId: c.videoId, channelId: c.channelId, require: c.require, watchPercent: c.watchPercent
    },
    user: s ? { name: s.name, avatar: s.avatar } : null,
    progress: null
  };
  if (s) {
    let required = null;
    try { if (c.videoId) required = Math.ceil(await videoDuration(s.token) * c.watchPercent / 100); } catch { /* shown on verify */ }
    out.progress = { watchSeconds: Math.floor(s.watchSeconds), requiredSeconds: required, steps: s.steps };
  }
  res.json(out);
}));

// Watch heartbeat: credit is based on SERVER time between beats, so spamming gains nothing.
app.post('/api/beat', needUser, wrap(async (req, res) => {
  const s = req.sess, now = Date.now();
  const playing = !!(req.body && req.body.playing);
  if (s.lastPlaying && playing && s.lastBeat) {
    const delta = (now - s.lastBeat) / 1000;
    s.watchSeconds += Math.min(delta, 7);
  }
  s.lastPlaying = playing;
  s.lastBeat = now;
  let required = null;
  try { required = Math.ceil(await videoDuration(s.token) * db.config.watchPercent / 100); } catch { /* ignore */ }
  res.json({ watchSeconds: Math.floor(s.watchSeconds), requiredSeconds: required });
}));

app.post('/api/verify', needUser, wrap(async (req, res) => {
  const s = req.sess, c = db.config;
  if (limited('verify:' + s.id, 6, 60e3)) return res.status(429).json({ error: 'Slow down a little, then try again.' });
  if (!c.videoId || !c.channelId) return res.status(503).json({ error: 'The vault is not set up yet.' });

  db.stats.verifyRuns++;
  const keys = Object.keys(CHECKS).filter(k => c.require[k]);
  const out = {};
  await Promise.all(keys.map(async k => {
    try { out[k] = await CHECKS[k](s); } catch (e) { out[k] = { ok: false, msg: e.message }; }
  }));
  keys.forEach(k => { if (!out[k].ok) db.stats.fails[k]++; });
  s.steps = out;

  if (!keys.every(k => out[k].ok)) { save(); return res.json({ steps: out, unlocked: false }); }

  const now = new Date().toISOString();
  let u = db.unlocks.find(x => x.channelId === s.channelId);
  if (!u) {
    u = { channelId: s.channelId, name: s.name, avatar: s.avatar, firstUnlockedAt: now, lastUnlockedAt: now, downloads: 0 };
    db.unlocks.push(u); db.stats.unlocks++;
  } else { u.lastUnlockedAt = now; u.name = s.name; }
  save();

  if (u.downloads >= c.maxDownloadsPerUser) {
    return res.status(403).json({ steps: out, unlocked: false, error: 'Download limit reached for this account.' });
  }
  const token = crypto.randomBytes(24).toString('base64url');
  tokens.set(token, { channelId: s.channelId, expires: Date.now() + c.linkTtlMinutes * 60e3, uses: 0 });
  res.json({ steps: out, unlocked: true, downloadUrl: '/d/' + token, ttlMinutes: c.linkTtlMinutes });
}));

/* ---- Protected download ---- */
app.get('/d/:token', wrap(async (req, res) => {
  const t = tokens.get(req.params.token);
  if (!t || t.expires < Date.now() || t.uses >= 3) return res.status(410).type('text').send('This link has expired. Go back and verify your quests again.');
  if (isBlocked(t.channelId)) return res.status(403).type('text').send('This account is blocked.');
  const d = db.config.download;

  if (t.uses === 0) {
    const u = db.unlocks.find(x => x.channelId === t.channelId);
    if (u) u.downloads++;
    db.stats.downloads++; save();
  }
  t.uses++; // up to 3 hits per link so a browser can resume an interrupted download

  if (d.mode === 'url' && d.url) return res.redirect(d.url);
  const file = path.join(FILES_DIR, path.basename(d.fileName || ''));
  if (!d.fileName || !file.startsWith(FILES_DIR) || !fs.existsSync(file)) return res.status(404).type('text').send('The file is not available yet.');
  res.download(file, d.fileName);
}));

/* ------------------------------------------------------------------ */
/* Admin API                                                           */
/* ------------------------------------------------------------------ */
const sha = v => crypto.createHash('sha256').update(String(v)).digest();

function adminOnly(req, res, next) {
  const id = readSigned(req, 'asid');
  const a = id && adminSessions.get(id);
  if (!a || a.expires < Date.now()) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

app.post('/admin/api/login', (req, res) => {
  if (limited('login:' + req.ip, 5, 15 * 60e3)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const pass = req.body && req.body.password;
  if (!pass || !crypto.timingSafeEqual(sha(pass), sha(env.ADMIN_PASSWORD))) return res.status(401).json({ error: 'Wrong password.' });
  const id = crypto.randomBytes(24).toString('base64url');
  adminSessions.set(id, { expires: Date.now() + 8 * 3600e3 });
  setCookie(res, 'asid', id, 8 * 3600);
  res.json({ ok: true });
});

app.post('/admin/api/logout', (req, res) => {
  const id = readSigned(req, 'asid'); if (id) adminSessions.delete(id);
  clearCookie(res, 'asid'); res.json({ ok: true });
});

app.get('/admin/api/overview', adminOnly, (req, res) => {
  res.json({
    config: db.config,
    stats: db.stats,
    unlocks: [...db.unlocks].sort((a, b) => b.lastUnlockedAt.localeCompare(a.lastUnlockedAt)).slice(0, 300),
    blocked: db.blocked,
    activeSessions: sessions.size,
    maxUploadMb: MAX_UPLOAD_MB
  });
});

function parseVideoId(v) {
  v = String(v || '').trim();
  const m = v.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(v) ? v : '');
}
const clamp = (n, lo, hi, d) => { n = Math.round(Number(n)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

app.put('/admin/api/config', adminOnly, (req, res) => {
  const b = req.body || {}, c = db.config;
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if ('siteTitle' in b) c.siteTitle = str(b.siteTitle, 40) || DEFAULTS.config.siteTitle;
  if ('tagline' in b) c.tagline = str(b.tagline, 140);
  if ('rewardName' in b) c.rewardName = str(b.rewardName, 60) || DEFAULTS.config.rewardName;
  if ('videoId' in b) {
    const id = parseVideoId(b.videoId);
    if (b.videoId && !id) return res.status(400).json({ error: 'That is not a valid YouTube video ID or link.' });
    c.videoId = id;
  }
  if ('channelId' in b) {
    const id = str(b.channelId, 40);
    if (id && !/^UC[\w-]{22}$/.test(id)) return res.status(400).json({ error: 'Channel ID must start with UC and be 24 characters.' });
    c.channelId = id;
  }
  if ('watchPercent' in b) c.watchPercent = clamp(b.watchPercent, 10, 100, 90);
  if ('linkTtlMinutes' in b) c.linkTtlMinutes = clamp(b.linkTtlMinutes, 1, 120, 10);
  if ('maxDownloadsPerUser' in b) c.maxDownloadsPerUser = clamp(b.maxDownloadsPerUser, 1, 50, 3);
  if (b.require) for (const k of Object.keys(c.require)) if (k in b.require) c.require[k] = !!b.require[k];
  if (b.download) {
    if (b.download.mode === 'file' || b.download.mode === 'url') c.download.mode = b.download.mode;
    if ('url' in b.download) {
      const u = str(b.download.url, 2000);
      if (u && !/^https:\/\//i.test(u)) return res.status(400).json({ error: 'Download URL must start with https://' });
      c.download.url = u;
    }
  }
  videoCache.clear();
  saveNow();
  res.json({ ok: true, config: c });
});

app.put('/admin/api/upload', adminOnly, (req, res) => {
  const name = path.basename(String(req.query.name || 'file')).replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'file';
  const dest = path.join(FILES_DIR, name), tmp = dest + '.part';
  const max = MAX_UPLOAD_MB * 1024 * 1024;
  let size = 0, aborted = false;
  const out = fs.createWriteStream(tmp);
  const abort = (code, msg) => {
    if (aborted) return; aborted = true;
    out.destroy(); fs.unlink(tmp, () => {});
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  req.on('data', chunk => { size += chunk.length; if (size > max) abort(413, `File is larger than ${MAX_UPLOAD_MB} MB.`); });
  req.on('error', () => abort(400, 'Upload interrupted.'));
  out.on('error', () => abort(500, 'Could not write the file.'));
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    const old = db.config.download.fileName;
    fs.renameSync(tmp, dest);
    if (old && old !== name) fs.unlink(path.join(FILES_DIR, path.basename(old)), () => {});
    db.config.download.mode = 'file';
    db.config.download.fileName = name;
    db.config.download.fileSize = size;
    saveNow();
    res.json({ ok: true, name, size });
  });
});

app.delete('/admin/api/file', adminOnly, (req, res) => {
  const d = db.config.download;
  if (d.fileName) fs.unlink(path.join(FILES_DIR, path.basename(d.fileName)), () => {});
  d.fileName = ''; d.fileSize = 0; saveNow();
  res.json({ ok: true });
});

app.post('/admin/api/block', adminOnly, (req, res) => {
  const id = String((req.body && req.body.channelId) || '').trim();
  if (!/^UC[\w-]{22}$/.test(id)) return res.status(400).json({ error: 'Invalid channel ID.' });
  if (!isBlocked(id)) {
    const u = db.unlocks.find(x => x.channelId === id);
    db.blocked.push({ channelId: id, name: (u && u.name) || String(req.body.name || '').slice(0, 80), at: new Date().toISOString() });
  }
  for (const [k, v] of sessions) if (v.channelId === id) sessions.delete(k);
  saveNow(); res.json({ ok: true });
});

app.delete('/admin/api/block/:id', adminOnly, (req, res) => {
  db.blocked = db.blocked.filter(b => b.channelId !== req.params.id);
  saveNow(); res.json({ ok: true });
});

app.delete('/admin/api/unlocks/:id', adminOnly, (req, res) => {
  db.unlocks = db.unlocks.filter(u => u.channelId !== req.params.id);
  for (const [k, v] of tokens) if (v.channelId === req.params.id) tokens.delete(k);
  saveNow(); res.json({ ok: true });
});

app.get('/admin/api/export.csv', adminOnly, (req, res) => {
  const cell = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [['channel_id', 'name', 'first_unlocked', 'last_unlocked', 'downloads']]
    .concat(db.unlocks.map(u => [u.channelId, u.name, u.firstUnlockedAt, u.lastUnlockedAt, u.downloads]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="unlocks.csv"');
  res.send(rows.map(r => r.map(cell).join(',')).join('\n'));
});

/* ------------------------------------------------------------------ */
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, () => {
  console.log(`Loot Vault running at ${BASE_URL}`);
  console.log(`Admin panel:       ${BASE_URL}/admin`);
});
