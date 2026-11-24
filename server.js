'use strict';
/**
 * Le Mur — livre d'or vivant pour soirées.
 * Serveur autonome : Express + stockage fichiers (aucune base de données).
 *
 * Variables d'environnement :
 *   PORT         port d'écoute (défaut 3100)
 *   EVENT_NAME   nom affiché (défaut "La soirée")
 *   ADMIN_KEY    clé d'accès à /admin (OBLIGATOIRE en production)
 *   BASE_URL     URL publique, utilisée pour le QR code (ex. https://mur.exemple.com)
 *   DATA_DIR     dossier des données (défaut ./data)
 *   PURGE_DAYS   suppression automatique après N jours (défaut 30, 0 = jamais)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT || '3100', 10);
const EVENT_NAME = (process.env.EVENT_NAME || 'La soirée').slice(0, 60);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'posts.json');
const PURGE_DAYS = parseInt(process.env.PURGE_DAYS || '30', 10);
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
let ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) {
  ADMIN_KEY = crypto.randomBytes(6).toString('hex');
  console.warn('[le-mur] ADMIN_KEY absente : clé temporaire générée -> ' + ADMIN_KEY);
}

const REACTIONS = ['❤️', '😂', '🔥', '👏', '😮'];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- Stockage ---------- */
let posts = [];
try {
  posts = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!Array.isArray(posts)) posts = [];
} catch (_) { posts = []; }

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(posts));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('[le-mur] écriture impossible', e.message); }
  }, 150);
}
function flushNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(posts));
  fs.renameSync(tmp, DB_FILE);
}
process.on('SIGTERM', () => { try { flushNow(); } catch (_) {} process.exit(0); });
process.on('SIGINT', () => { try { flushNow(); } catch (_) {} process.exit(0); });

const pub = (p) => ({
  id: p.id, name: p.name, text: p.text, image: p.image ? '/uploads/' + p.image : null,
  createdAt: p.createdAt, reactions: p.reactions || {}
});

function removePost(id) {
  const i = posts.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const [p] = posts.splice(i, 1);
  if (p.image) fs.unlink(path.join(UPLOADS, p.image), () => {});
  saveSoon();
  broadcast('delete', { id });
  return true;
}

/* ---------- Temps réel (SSE) ---------- */
const clients = new Set();
function broadcast(type, data) {
  const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(msg); } catch (_) { clients.delete(res); } }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (_) { clients.delete(res); } } }, 25000);

/* ---------- Limitation de débit (par IP) ---------- */
const hits = new Map();
function limiter(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Doucement ! Réessaie dans un instant.' });
    arr.push(now); hits.set(key, arr); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 120000)) hits.delete(k); }, 60000);

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Accel-Buffering', 'no');
  next();
});
app.use(express.json({ limit: '5mb' }));

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isAdmin = (req) => {
  const k = String(req.get('x-admin-key') || req.query.key || '');
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

app.get('/api/config', (req, res) => res.json({ eventName: EVENT_NAME, reactions: REACTIONS, purgeDays: PURGE_DAYS }));

app.get('/api/posts', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(posts.map(pub));
});

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/posts', limiter(12, 60000), (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 30) || 'Anonyme';
  const text = clean(b.text, 280);
  const owner = clean(b.owner, 64);
  let file = null;
  if (b.image) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image));
    if (!m) return res.status(400).json({ error: 'Image invalide.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES || buf.length < 100) return res.status(400).json({ error: 'Image trop lourde.' });
    const okMagic = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) ||
      (m[1] === 'png' && buf[0] === 0x89 && buf[1] === 0x50) ||
      (m[1] === 'webp' && buf.slice(0, 4).toString() === 'RIFF');
    if (!okMagic) return res.status(400).json({ error: 'Image invalide.' });
    file = crypto.randomBytes(9).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(UPLOADS, file), buf);
  }
  if (!file && !text) return res.status(400).json({ error: 'Rien à poster.' });
  if (posts.length >= 3000) return res.status(507).json({ error: 'Le mur est plein.' });
  const post = {
    id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    name, text, image: file, createdAt: Date.now(), reactions: {},
    ownerHash: owner ? crypto.createHash('sha256').update(owner).digest('hex') : null
  };
  posts.push(post);
  saveSoon();
  broadcast('post', pub(post));
  res.json({ ok: true, post: pub(post) });
});

app.post('/api/posts/:id/react', limiter(60, 60000), (req, res) => {
  const emoji = String((req.body || {}).emoji || '');
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Réaction inconnue.' });
  const p = posts.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Introuvable.' });
  p.reactions = p.reactions || {};
  p.reactions[emoji] = (p.reactions[emoji] || 0) + 1;
  saveSoon();
  broadcast('react', { id: p.id, reactions: p.reactions });
  res.json({ ok: true });
});

app.delete('/api/posts/:id', limiter(30, 60000), (req, res) => {
  const p = posts.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Introuvable.' });
  const owner = clean(req.get('x-owner-token'), 64);
  const mine = owner && p.ownerHash && crypto.createHash('sha256').update(owner).digest('hex') === p.ownerHash;
  if (!mine && !isAdmin(req)) return res.status(403).json({ error: 'Interdit.' });
  removePost(p.id);
  res.json({ ok: true });
});

/* ---------- Admin ---------- */
app.get('/api/admin/check', (req, res) => res.status(isAdmin(req) ? 200 : 403).json({ ok: isAdmin(req), count: posts.length }));

app.get('/admin/export.zip', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Interdit');
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="le-mur-export.zip"' });
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', () => res.end());
  zip.pipe(res);
  zip.append(JSON.stringify(posts.map((p) => ({ ...pub(p), ownerHash: undefined })), null, 2), { name: 'posts.json' });
  for (const p of posts) if (p.image) zip.file(path.join(UPLOADS, p.image), { name: 'photos/' + p.image });
  zip.finalize();
});

app.post('/api/admin/purge', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Interdit.' });
  if ((req.body || {}).confirm !== 'EFFACER') return res.status(400).json({ error: 'Confirmation manquante.' });
  for (const p of [...posts]) removePost(p.id);
  res.json({ ok: true });
});

/* ---------- QR code ---------- */
app.get('/qr.svg', async (req, res) => {
  const base = BASE_URL || (req.protocol + '://' + req.get('host'));
  try {
    const svg = await QRCode.toString(base + '/', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' }).send(svg);
  } catch (e) { res.status(500).end(); }
});

/* ---------- Fichiers ---------- */
app.use('/uploads', express.static(UPLOADS, { maxAge: '7d', immutable: true, index: false, dotfiles: 'deny' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('/healthz', (req, res) => res.json({ ok: true, posts: posts.length }));

/* ---------- Purge automatique ---------- */
function autoPurge() {
  if (!PURGE_DAYS || PURGE_DAYS < 1) return;
  const limit = Date.now() - PURGE_DAYS * 86400000;
  for (const p of [...posts]) if (p.createdAt < limit) removePost(p.id);
}
autoPurge();
setInterval(autoPurge, 3600000);

app.listen(PORT, () => console.log('[le-mur] http://localhost:' + PORT + '  (' + EVENT_NAME + ', ' + posts.length + ' posts)'));
