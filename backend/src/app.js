const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const app     = express();

// Trust proxy (behind nginx reverse proxy)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS — hanya domain yang diizinkan
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://poinraja.com').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Body size limits
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Compression — gzip API responses
const compression = require('compression');
app.use(compression({ threshold: 512 }));

app.use('/api/auth',        require('./routes/auth'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/cabang',      require('./routes/cabang'));
app.use('/api/produk',      require('./routes/produk'));
app.use('/api/deadstock',   require('./routes/deadstock'));
app.use('/api/customer',    require('./routes/customer'));
app.use('/api/invoice',     require('./routes/invoice'));
app.use('/api/forecast',    require('./routes/forecast'));
app.use('/api/pengeluaran', require('./routes/pengeluaran'));
app.use('/api/pemasukan',   require('./routes/pemasukan'));
app.use('/api/arsip',       require('./routes/arsip'));
app.use('/api/poin',        require('./routes/poin'));
app.use('/api/request',     require('./routes/request'));
app.use('/api/target',      require('./routes/target'));
app.use('/api/deadstock-mgmt', require('./routes/deadstock_mgmt'));
app.use('/api/entitas', require('./routes/entitas'));
app.use('/api/omzet', require('./routes/omzet'));
app.use('/api/sewa', require('./routes/sewa'));
app.use('/api/aset', require('./routes/aset'));
app.use('/api/kerjoo', require('./routes/kerjoo'));
app.use('/api/reseller', require('./routes/reseller'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/payroll-toko', require('./routes/payroll-toko'));
app.use('/api/payroll-spv', require('./routes/payroll-spv'));
app.use('/api/konten', require('./routes/konten'));
app.use('/api/request-produk', require('./routes/request-produk'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/supplier', require('./routes/supplier'));
app.use('/api/pembelian', require('./routes/pembelian'));
app.use('/api/piutang', require('./routes/piutang'));
app.use('/api/pos-settings', require('./routes/pos-settings'));
app.use('/api/kas', require('./routes/kas'));
app.use('/api/monitoring', require('./routes/monitoring'));
app.use('/api/staff',         require('./routes/staff'));
app.use('/api/manajer-area',  require('./routes/manajer-area'));
app.use('/api/retur',         require('./routes/retur'));
app.use('/api/audit',         require('./routes/audit'));
app.use('/api/promo',         require('./routes/promo'));
app.use('/api/notifikasi',   require('./routes/notifikasi'));
app.use('/api/member',       require('./routes/member'));
app.use('/api/laporan-pdf', require('./routes/laporan-pdf'));
app.use('/api/dashboard',   require('./routes/dashboard'));
app.use('/api/sync',        require('./routes/sync'));
app.use('/api/footer-config', require('./routes/footer-config'));

app.get('/api/ping', (req, res) => res.json({ success:true, message:'Server Raja Vapor aktif!' }));

// ═══ THUMBNAIL ON-DEMAND: /api/thumb/<w>x<h>/uploads/... ═══
// Generates WebP thumbnails on first request, caches to disk for subsequent requests.
// Example: /api/thumb/200x200/uploads/pos_produk/123.png → 200x200 webp
const sharp = require('sharp');
const _path = require('path');
const _fs   = require('fs');
const UPLOAD_ROOT = process.env.UPLOAD_PATH || '/var/www/rajavavapor/uploads';
const THUMB_ROOT  = _path.join(UPLOAD_ROOT, '_thumbs');

app.get('/api/thumb/:size/:dir/:file', async (req, res) => {
  try {
    const sizeMatch = req.params.size.match(/^(\d+)x(\d+)$/);
    if (!sizeMatch) return res.status(400).send('Invalid size. Use WxH format.');
    const w = Math.min(parseInt(sizeMatch[1]), 800);
    const h = Math.min(parseInt(sizeMatch[2]), 800);

    // e.g. /api/thumb/200x200/pos_produk/123.png → dir=pos_produk, file=123.png
    const relPath = req.params.dir + '/' + req.params.file;
    const srcFile = _path.join(UPLOAD_ROOT, relPath);

    if (!_fs.existsSync(srcFile)) return res.status(404).send('Not found');

    // Cache dir: _thumbs/<w>x<h>/<relPath>.webp
    const thumbRelPath = relPath.replace(/\.[^.]+$/, '.webp');
    const thumbFile = _path.join(THUMB_ROOT, `${w}x${h}`, thumbRelPath);
    const thumbDir  = _path.dirname(thumbFile);

    // Serve cached thumbnail if exists
    if (_fs.existsSync(thumbFile)) {
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      return res.sendFile(thumbFile);
    }

    // Generate thumbnail
    if (!_fs.existsSync(thumbDir)) _fs.mkdirSync(thumbDir, { recursive: true });
    await sharp(srcFile)
      .resize(w, h, { fit: 'cover', position: 'center' })
      .webp({ quality: 75 })
      .toFile(thumbFile);

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.sendFile(thumbFile);
  } catch(e) {
    console.error('Thumb error:', e.message);
    res.status(500).send('Thumbnail generation failed');
  }
});

module.exports = app;
