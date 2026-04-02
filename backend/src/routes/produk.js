const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const xlsx    = require('xlsx');
const path    = require('path');
const fs      = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','produk');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now()+path.extname(file.originalname))
});
const upload = multer({ storage, limits:{ fileSize:10*1024*1024 }});

const TIER_QTY = [3,5,10,30,50,100,200,500,1000];

// ── STATIC ROUTES DULU (sebelum /:id) ──

// GET template download
router.get('/template/download', (req, res) => {
  const headers = ['Kode','Nama','Kategori','Harga Beli','Harga Jual','Poin','Satuan',...TIER_QTY.map(q=>`Harga ${q}pcs`)];
  const example = ['PRD001','Contoh Produk','Freebase',30000,45000,5,'pcs',...TIER_QTY.map(()=>'')];
  const ws = xlsx.utils.aoa_to_sheet([headers, example]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Produk');
  const buf = xlsx.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Disposition','attachment; filename=template-import-produk.xlsx');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// POST import bulk
router.post('/import', auth(['owner','admin_pusat','manajer','head_operational']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, message:'File tidak ditemukan.' });
  try {
    const wb   = xlsx.readFile(req.file.path);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { defval:'' });
    let inserted=0, updated=0, errors=[];
    for (const [i, row] of rows.entries()) {
      try {
        const kode     = String(row['Kode']||row['kode']||'').trim();
        const nama     = String(row['Nama']||row['nama']||'').trim();
        const kategori = String(row['Kategori']||row['kategori']||row['Jenis']||'').trim();
        const harga_beli  = parseFloat(row['Harga Beli']||row['harga_beli']||0)||0;
        const harga_jual  = parseFloat(row['Harga Jual']||row['harga_jual']||0)||0;
        const poin_komisi = parseFloat(row['Poin']||row['poin_komisi']||0)||0;
        const satuan      = String(row['Satuan']||row['satuan']||'pcs').trim();
        if (!kode||!nama) { errors.push(`Baris ${i+2}: kode/nama kosong`); continue; }
        const [exist] = await db.query('SELECT id FROM produk WHERE kode=?', [kode]);
        let produkId;
        if (exist.length) {
          await db.query('UPDATE produk SET nama=?,kategori=?,harga_beli=?,harga_jual=?,poin_komisi=?,satuan=? WHERE kode=?',
            [nama, kategori||'Accessories', harga_beli, harga_jual, poin_komisi, satuan, kode]);
          produkId = exist[0].id; updated++;
        } else {
          const [r] = await db.query('INSERT INTO produk (kode,nama,kategori,harga_beli,harga_jual,poin_komisi,satuan) VALUES (?,?,?,?,?,?,?)',
            [kode, nama, kategori||'Accessories', harga_beli, harga_jual, poin_komisi, satuan]);
          produkId = r.insertId; inserted++;
        }
        await db.query('DELETE FROM produk_harga_tier WHERE produk_id=? AND cabang_id IS NULL', [produkId]);
        for (const qty of TIER_QTY) {
          const h = parseFloat(row[`Harga ${qty}pcs`]||0)||0;
          if (h > 0) await db.query('INSERT INTO produk_harga_tier (produk_id,cabang_id,qty_min,harga) VALUES (?,NULL,?,?)', [produkId, qty, h]);
        }
      } catch(e2) { errors.push(`Baris ${i+2}: ${e2.message}`); }
    }
    fs.unlinkSync(req.file.path);
    res.json({ success:true, message:`Import selesai. ${inserted} ditambahkan, ${updated} diupdate.`, errors });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── DYNAMIC ROUTES (/:id) ──

// GET semua produk
router.get('/', async (req, res) => {
  try {
    const where = req.query.aktif ? 'WHERE aktif=1' : '';
    const [rows] = await db.query(`SELECT * FROM produk ${where} ORDER BY kategori, nama`);
    const [tiers] = await db.query('SELECT * FROM produk_harga_tier WHERE cabang_id IS NULL ORDER BY produk_id, qty_min');
    const tierMap = {};
    tiers.forEach(t => {
      if (!tierMap[t.produk_id]) tierMap[t.produk_id] = {};
      tierMap[t.produk_id][t.qty_min] = t.harga;
    });
    rows.forEach(r => { r.tangga_harga = tierMap[r.id] || {}; });
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET satu produk
router.get('/:id', async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT * FROM produk WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ success:false, message:'Produk tidak ditemukan.' });
    const [tiers] = await db.query('SELECT * FROM produk_harga_tier WHERE produk_id=? AND cabang_id IS NULL ORDER BY qty_min', [req.params.id]);
    row.tangga_harga = {};
    tiers.forEach(t => { row.tangga_harga[t.qty_min] = t.harga; });
    res.json({ success:true, data:row });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST tambah produk
router.post('/', auth(['owner','admin_pusat','manajer','head_operational']), async (req, res) => {
  try {
    const { kode, nama, kategori, harga_beli, harga_jual, poin_komisi, satuan, deskripsi, tangga_harga } = req.body;
    if (!kode||!nama||!kategori) return res.status(400).json({ success:false, message:'Kode, nama, dan kategori wajib.' });
    const [result] = await db.query(
      'INSERT INTO produk (kode,nama,kategori,harga_beli,harga_jual,poin_komisi,satuan,deskripsi) VALUES (?,?,?,?,?,?,?,?)',
      [kode.trim(), nama.trim(), kategori, harga_beli||0, harga_jual||0, poin_komisi||0, satuan||'pcs', deskripsi||'']
    );
    const produkId = result.insertId;
    if (tangga_harga && typeof tangga_harga === 'object') {
      for (const [qty, harga] of Object.entries(tangga_harga)) {
        if (harga && parseFloat(harga) > 0) {
          await db.query(
            'INSERT INTO produk_harga_tier (produk_id,cabang_id,qty_min,harga) VALUES (?,NULL,?,?) ON DUPLICATE KEY UPDATE harga=VALUES(harga)',
            [produkId, parseInt(qty), parseFloat(harga)]
          );
        }
      }
    }
    res.json({ success:true, message:'Produk berhasil ditambahkan.', id:produkId });
  } catch(e) {
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({ success:false, message:'Kode produk sudah ada.' });
    res.status(500).json({ success:false, message:e.message });
  }
});

// POST upload foto
router.post('/:id/foto', auth(['owner','admin_pusat','manajer','head_operational']), upload.single('foto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, message:'File tidak ditemukan.' });
  try {
    // Auto-compress to WebP
    const sharp = require('sharp');
    const webpName = req.file.filename.replace(/\.[^.]+$/, '.webp');
    const webpPath = path.join(req.file.destination, webpName);
    await sharp(req.file.path)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(webpPath);
    if (req.file.path !== webpPath) fs.unlinkSync(req.file.path);

    const [[old]] = await db.query('SELECT foto_url FROM produk WHERE id=?', [req.params.id]);
    if (old?.foto_url) {
      const oldPath = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads', old.foto_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const fotoUrl = 'produk/' + webpName;
    await db.query('UPDATE produk SET foto_url=? WHERE id=?', [fotoUrl, req.params.id]);
    res.json({ success:true, message:'Foto berhasil diupload.', foto_url:'/uploads/'+fotoUrl });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH edit produk
router.patch('/:id', auth(['owner','admin_pusat','manajer','head_operational']), async (req, res) => {
  try {
    const { kode, nama, kategori, harga_beli, harga_jual, poin_komisi, satuan, deskripsi, aktif, tangga_harga } = req.body;
    await db.query(
      'UPDATE produk SET kode=?,nama=?,kategori=?,harga_beli=?,harga_jual=?,poin_komisi=?,satuan=?,deskripsi=?,aktif=? WHERE id=?',
      [kode, nama, kategori, harga_beli||0, harga_jual||0, poin_komisi||0, satuan||'pcs', deskripsi||'', aktif??1, req.params.id]
    );
    if (tangga_harga && typeof tangga_harga === 'object') {
      await db.query('DELETE FROM produk_harga_tier WHERE produk_id=? AND cabang_id IS NULL', [req.params.id]);
      for (const [qty, harga] of Object.entries(tangga_harga)) {
        if (harga && parseFloat(harga) > 0) {
          await db.query('INSERT INTO produk_harga_tier (produk_id,cabang_id,qty_min,harga) VALUES (?,NULL,?,?)',
            [req.params.id, parseInt(qty), parseFloat(harga)]);
        }
      }
    }
    res.json({ success:true, message:'Produk berhasil diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE foto
router.delete('/:id/foto', auth(['owner','admin_pusat','manajer','head_operational']), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT foto_url FROM produk WHERE id=?', [req.params.id]);
    if (row?.foto_url) {
      const fp = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads', row.foto_url);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await db.query('UPDATE produk SET foto_url=NULL WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Foto dihapus.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE produk
router.delete('/:id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    await db.query('UPDATE produk SET aktif=0 WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
