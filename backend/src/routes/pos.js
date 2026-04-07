const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');
const { requireModule } = require('../middleware/moduleAccess');
const rp_plain = v => 'Rp '+(v||0).toLocaleString('id-ID');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','pos_produk');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now()+path.extname(file.originalname))
});
const upload  = multer({ storage, limits:{ fileSize:5*1024*1024 }});
const XLSX    = require('xlsx');
const upload2 = multer({ dest: '/tmp/' });

// Helper: tambahkan sheet Info identitas cabang/sistem ke workbook
function addInfoSheet(wb, label) {
  const info = [
    ['Sistem', 'Raja Vapor - poinraja.com'],
    ['Data', label || 'Semua Cabang'],
    ['Tanggal Export', new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'})],
    ['', ''],
    ['PERHATIAN', 'Pastikan file ini diimport ke sistem/cabang yang benar!']
  ];
  const is = XLSX.utils.aoa_to_sheet(info);
  is['!cols'] = [{wch:18},{wch:40}];
  XLSX.utils.book_append_sheet(wb, is, 'Info');
}

// Helper: tambahkan sheet Kategori ke workbook sebagai referensi
async function addKategoriSheet(wb) {
  const [cats] = await db.query("SELECT DISTINCT kategori FROM pos_produk WHERE kategori IS NOT NULL AND kategori != '' ORDER BY kategori");
  const kategoriList = cats.map(c => c.kategori);
  if (!kategoriList.length) return;
  const ksData = [['Kategori'], ...kategoriList.map(k => [k])];
  const ks = XLSX.utils.aoa_to_sheet(ksData);
  ks['!cols'] = [{wch:25}];
  XLSX.utils.book_append_sheet(wb, ks, 'Kategori');
}

// ── PRODUK ──────────────────────────────
// GET /api/pos/produk?cabang_id=&q=&kategori=
router.get('/produk', auth(), async (req, res) => {
  try {
    const { cabang_id, q, kategori, aktif, page, per_page, sort, dir } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (aktif !== undefined && aktif !== '') { where += ' AND p.aktif=?'; params.push(parseInt(aktif)); }
    else { where += ' AND p.aktif=1'; }
    if (q) {
      const words = q.trim().split(/\s+/).filter(w => w);
      for (const w of words) {
        where += ' AND (p.nama LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)';
        params.push('%'+w+'%','%'+w+'%','%'+w+'%');
      }
    }
    if (kategori) { where += ' AND p.kategori=?'; params.push(kategori); }

    const limit  = parseInt(per_page) || 100;
    const pg     = parseInt(page) || 1;
    const offset = (pg - 1) * limit;

    // cabang_id=0 → total stok semua cabang, else stok cabang tertentu (INNER JOIN = hanya produk yg ada di cabang)
    const cabId = parseInt(cabang_id)||0;
    const stokJoin = cabId > 0
      ? `INNER JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=?`
      : `LEFT JOIN (SELECT produk_id, SUM(qty) as qty FROM pos_stok GROUP BY produk_id) s ON s.produk_id=p.id`;
    const stokParams = cabId > 0 ? [cabId] : [];

    // Count total — pakai join yang sama supaya akurat
    const [[{total}]] = cabId > 0
      ? await db.query(`SELECT COUNT(*) as total FROM pos_produk p INNER JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? ${where}`, [cabId, ...params])
      : await db.query(`SELECT COUNT(*) as total FROM pos_produk p ${where}`, [...params]);

    // Server-side sort
    const allowedSort = {nama:'p.nama', stok:'stok', harga_jual:'p.harga_jual', harga_modal:'p.harga_modal', komisi:'p.komisi', kategori:'p.kategori'};
    const sortCol = allowedSort[sort] || 'p.nama';
    const sortDir = dir === 'asc' ? 'ASC' : dir === 'desc' ? 'DESC' : 'ASC';

    const [rows] = await db.query(`
      SELECT p.*, COALESCE(s.qty,0) as stok
      FROM pos_produk p
      ${stokJoin}
      ${where}
      ORDER BY ${sortCol} ${sortDir}, p.nama ASC LIMIT ? OFFSET ?`, [...stokParams, ...params, limit, offset]);
    res.json({success:true, data:rows, total, page:pg, per_page:limit, total_pages:Math.ceil(total/limit)});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.post('/produk', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { sku, nama, kategori, harga_jual, harga_modal, satuan, komisi, komisi_poin } = req.body;
    if (!sku||!nama) return res.status(400).json({success:false,message:'SKU dan nama wajib.'});
    const [result] = await conn.query('INSERT INTO pos_produk (sku,nama,kategori,harga_jual,harga_modal,satuan,komisi,komisi_poin) VALUES (?,?,?,?,?,?,?,?)',
      [sku,nama,kategori||null,harga_jual||0,harga_modal||0,satuan||'pcs',komisi||0,komisi_poin||0]);
    const produkId = result.insertId;

    // Auto-init: pos_stok qty=0 di semua cabang aktif
    const [cabangList] = await conn.query('SELECT id FROM cabang WHERE aktif=1');
    if (cabangList.length) {
      const ph = cabangList.map(() => '(?,?,0)').join(',');
      const vals = cabangList.flatMap(c => [produkId, c.id]);
      await conn.query(`INSERT IGNORE INTO pos_stok (produk_id, cabang_id, qty) VALUES ${ph}`, vals);
    }

    await conn.commit();
    res.json({success:true,message:'Produk ditambahkan.'});
  } catch(e) {
    await conn.rollback();
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({success:false,message:'SKU sudah ada.'});
    res.status(500).json({success:false,message:e.message});
  } finally { conn.release(); }
});

router.patch('/produk/:id', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { sku, nama, kategori, harga_jual, harga_modal, satuan, komisi, komisi_poin, aktif, stok_minimum } = req.body;
    await db.query('UPDATE pos_produk SET sku=?,nama=?,kategori=?,harga_jual=?,harga_modal=?,satuan=?,komisi=?,komisi_poin=?,aktif=?,stok_minimum=? WHERE id=?',
      [sku,nama,kategori||null,harga_jual||0,harga_modal||0,satuan||'pcs',komisi||0,komisi_poin||0,aktif??1,stok_minimum||0,req.params.id]);
    audit(req, 'update', 'produk', req.params.id, nama, {sku,harga_jual,harga_modal,stok_minimum});
    res.json({success:true,message:'Produk diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.post('/produk/:id/foto', auth(['owner','admin_pusat','head_operational']), upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({success:false,message:'File tidak ditemukan.'});

    // Auto-compress to WebP
    const sharp = require('sharp');
    const webpName = req.file.filename.replace(/\.[^.]+$/, '.webp');
    const webpPath = path.join(req.file.destination, webpName);
    await sharp(req.file.path)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(webpPath);
    // Remove original if different from webp
    if (req.file.path !== webpPath) fs.unlinkSync(req.file.path);

    const fotoUrl = '/uploads/pos_produk/' + webpName;
    const [[old]] = await db.query('SELECT foto_url FROM pos_produk WHERE id=?', [req.params.id]);
    if (old?.foto_url) {
      const oldPath = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','pos_produk',path.basename(old.foto_url));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await db.query('UPDATE pos_produk SET foto_url=? WHERE id=?', [fotoUrl, req.params.id]);
    res.json({success:true, foto_url: fotoUrl});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.delete('/produk/:id/foto', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT foto_url FROM pos_produk WHERE id=?', [req.params.id]);
    if (row?.foto_url) {
      const oldPath = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','pos_produk',path.basename(row.foto_url));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await db.query('UPDATE pos_produk SET foto_url=NULL WHERE id=?', [req.params.id]);
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE produk (owner only)
// Dengan ?cabang_id=X → hapus produk dari cabang itu (stok + min stok dihapus, produk hilang dari cabang)
// Tanpa cabang_id   → hapus master produk + semua stok di semua cabang
router.delete('/produk/:id', auth(['owner']), async (req, res) => {
  try {
    const cabang_id = req.query.cabang_id ? parseInt(req.query.cabang_id) : 0;
    const [[p]] = await db.query('SELECT id,nama FROM pos_produk WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({success:false,message:'Produk tidak ditemukan.'});

    if (cabang_id > 0) {
      // Hapus produk dari cabang ini (stok + minimum dihapus → produk hilang dari daftar cabang ini)
      await db.query('DELETE FROM pos_stok WHERE produk_id=? AND cabang_id=?', [req.params.id, cabang_id]);
      await db.query('DELETE FROM pos_stok_minimum_cabang WHERE produk_id=? AND cabang_id=?', [req.params.id, cabang_id]);
      const [[cab]] = await db.query('SELECT nama FROM cabang WHERE id=?', [cabang_id]);
      audit(req, 'delete', 'produk_cabang', req.params.id, `${p.nama} @ ${cab?.nama||cabang_id}`, {cabang_id});
      return res.json({success:true, message:`"${p.nama}" dihapus dari ${cab?.nama||'cabang '+cabang_id}.`});
    }

    // Tanpa cabang → hapus total
    const [[used]] = await db.query('SELECT COUNT(*) as c FROM pos_transaksi_item WHERE produk_id=?', [req.params.id]);
    if (used.c > 0) return res.status(400).json({success:false,message:`Produk "${p.nama}" sudah ada ${used.c} transaksi. Nonaktifkan saja, tidak bisa dihapus.`});
    await db.query('DELETE FROM pos_paket_item WHERE produk_id=?', [req.params.id]);
    await db.query('DELETE FROM stock_opname_item WHERE produk_id=?', [req.params.id]);
    await db.query('DELETE FROM pos_stok_minimum_cabang WHERE produk_id=?', [req.params.id]);
    await db.query('DELETE FROM pos_stok WHERE produk_id=?', [req.params.id]);
    await db.query('DELETE FROM pos_stok_log WHERE produk_id=?', [req.params.id]);
    await db.query('DELETE FROM pos_produk WHERE id=?', [req.params.id]);
    audit(req, 'delete', 'produk', req.params.id, p.nama);
    res.json({success:true,message:`Produk "${p.nama}" dihapus dari semua cabang.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST bulk delete produk (owner only)
// Dengan cabang_id → hapus produk dari cabang itu saja
// Tanpa cabang_id  → hapus master + semua stok
router.post('/produk/bulk-delete', auth(['owner']), async (req, res) => {
  try {
    const { ids, cabang_id } = req.body;
    if (!ids?.length) return res.status(400).json({success:false,message:'Pilih produk yang akan dihapus.'});
    const cid = cabang_id ? parseInt(cabang_id) : 0;

    if (cid > 0) {
      // Hapus produk dari cabang ini saja
      const ph = ids.map(()=>'?').join(',');
      const [delResult] = await db.query(`DELETE FROM pos_stok WHERE produk_id IN (${ph}) AND cabang_id=?`, [...ids, cid]);
      await db.query(`DELETE FROM pos_stok_minimum_cabang WHERE produk_id IN (${ph}) AND cabang_id=?`, [...ids, cid]);
      const [[cab]] = await db.query('SELECT nama FROM cabang WHERE id=?', [cid]);
      audit(req, 'delete', 'produk_cabang', null, `Bulk hapus ${ids.length} produk @ ${cab?.nama||cid}`, {ids, cabang_id:cid});
      return res.json({success:true, message:`${delResult.affectedRows} produk dihapus dari ${cab?.nama||'cabang '+cid}.`, deleted:delResult.affectedRows});
    }

    // Tanpa cabang → hapus master total
    const ph = ids.map(()=>'?').join(',');
    const [used] = await db.query(`SELECT produk_id, COUNT(*) as c FROM pos_transaksi_item WHERE produk_id IN (${ph}) GROUP BY produk_id`, ids);
    const usedIds = new Set(used.map(u=>u.produk_id));
    const deletable = ids.filter(id => !usedIds.has(id));
    const skipped = ids.length - deletable.length;
    if (deletable.length > 0) {
      const ph2 = deletable.map(()=>'?').join(',');
      await db.query(`DELETE FROM pos_paket_item WHERE produk_id IN (${ph2})`, deletable);
      await db.query(`DELETE FROM stock_opname_item WHERE produk_id IN (${ph2})`, deletable);
      await db.query(`DELETE FROM pos_stok_minimum_cabang WHERE produk_id IN (${ph2})`, deletable);
      await db.query(`DELETE FROM pos_stok WHERE produk_id IN (${ph2})`, deletable);
      await db.query(`DELETE FROM pos_stok_log WHERE produk_id IN (${ph2})`, deletable);
      await db.query(`DELETE FROM pos_produk WHERE id IN (${ph2})`, deletable);
      audit(req, 'delete', 'produk', null, `Bulk delete ${deletable.length} produk`, {ids:deletable});
    }
    let msg = `${deletable.length} produk dihapus dari semua cabang.`;
    if (skipped > 0) msg += ` ${skipped} produk dilewati (sudah ada transaksi).`;
    res.json({success:true, message:msg, deleted:deletable.length, skipped});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── PAKET (BUNDLE) ──────────────────────────────
// GET /api/pos/paket — list semua paket + items
router.get('/paket', auth(), async (req, res) => {
  try {
    const [pakets] = await db.query(`SELECT * FROM pos_paket ORDER BY nama`);
    for (const pk of pakets) {
      const [items] = await db.query(
        `SELECT pi.*, p.nama as nama_produk, p.sku as sku_produk, p.harga_modal as harga_modal_produk
         FROM pos_paket_item pi LEFT JOIN pos_produk p ON pi.produk_id=p.id WHERE pi.paket_id=?`, [pk.id]);
      pk.items = items;
    }
    res.json({success:true, data:pakets});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// POST /api/pos/paket — buat paket baru
router.post('/paket', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { sku, nama, kategori, harga_jual, harga_modal, komisi, komisi_poin, items } = req.body;
    if (!sku || !nama || !items?.length) return res.status(400).json({success:false, message:'SKU, nama, dan items wajib diisi.'});
    const [result] = await conn.query(
      `INSERT INTO pos_paket (sku, nama, kategori, harga_jual, harga_modal, komisi, komisi_poin) VALUES (?,?,?,?,?,?,?)`,
      [sku, nama, kategori||'Paket', harga_jual||0, harga_modal||0, komisi||0, komisi_poin||0]);
    const paketId = result.insertId;
    for (const item of items) {
      await conn.query('INSERT INTO pos_paket_item (paket_id, produk_id, qty) VALUES (?,?,?)',
        [paketId, item.produk_id, item.qty||1]);
    }
    await conn.commit();
    audit(req, 'create', 'paket', paketId, nama, {sku, items_count: items.length});
    res.json({success:true, message:'Paket berhasil dibuat.', id:paketId});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false, message:e.message}); }
  finally { conn.release(); }
});

// PATCH /api/pos/paket/:id — edit paket
router.patch('/paket/:id', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { sku, nama, kategori, harga_jual, harga_modal, komisi, komisi_poin, aktif, items } = req.body;
    await conn.query(
      `UPDATE pos_paket SET sku=?, nama=?, kategori=?, harga_jual=?, harga_modal=?, komisi=?, komisi_poin=?, aktif=? WHERE id=?`,
      [sku, nama, kategori||'Paket', harga_jual||0, harga_modal||0, komisi||0, komisi_poin||0, aktif!==undefined?aktif:1, req.params.id]);
    if (items) {
      await conn.query('DELETE FROM pos_paket_item WHERE paket_id=?', [req.params.id]);
      for (const item of items) {
        await conn.query('INSERT INTO pos_paket_item (paket_id, produk_id, qty) VALUES (?,?,?)',
          [req.params.id, item.produk_id, item.qty||1]);
      }
    }
    await conn.commit();
    audit(req, 'update', 'paket', req.params.id, nama, {sku});
    res.json({success:true, message:'Paket berhasil diupdate.'});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false, message:e.message}); }
  finally { conn.release(); }
});

// DELETE /api/pos/paket/:id
router.delete('/paket/:id', auth(['owner']), async (req, res) => {
  try {
    const [[pk]] = await db.query('SELECT nama FROM pos_paket WHERE id=?', [req.params.id]);
    if (!pk) return res.status(404).json({success:false, message:'Paket tidak ditemukan.'});
    await db.query('DELETE FROM pos_paket WHERE id=?', [req.params.id]);
    audit(req, 'delete', 'paket', req.params.id, pk.nama);
    res.json({success:true, message:`Paket "${pk.nama}" dihapus.`});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// ── STOK ──────────────────────────────
// GET /api/pos/stok?cabang_id=
router.get('/stok', auth(), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    // Produk biasa — default: hanya stok>0 untuk kasir, ?semua=1 untuk lihat semua
    const showSemua = req.query.semua === '1';
    const stokFilter = showSemua ? '' : 'AND s.qty > 0';
    const [rows] = await db.query(`
      SELECT p.id, p.sku, p.barcode, p.nama, p.kategori, p.harga_jual, p.satuan, p.komisi, p.komisi_poin,
             p.foto_url, p.stok_minimum, p.harga_modal,
             s.qty, 0 as is_paket
      FROM pos_produk p
      INNER JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=?
      WHERE p.aktif=1 ${stokFilter}
      ORDER BY p.kategori, p.nama`, [cabang_id]);

    // Paket — hitung stok dari komponen
    const [pakets] = await db.query(`SELECT * FROM pos_paket WHERE aktif=1 ORDER BY nama`);
    for (const pk of pakets) {
      const [items] = await db.query(
        `SELECT pi.produk_id, pi.qty as qty_needed, p.nama as nama_produk, p.sku as sku_produk,
                COALESCE(s.qty,0) as stok_produk
         FROM pos_paket_item pi
         LEFT JOIN pos_produk p ON pi.produk_id=p.id
         LEFT JOIN pos_stok s ON s.produk_id=pi.produk_id AND s.cabang_id=?
         WHERE pi.paket_id=?`, [cabang_id, pk.id]);
      // Stok paket = minimum dari floor(stok_komponen / qty_needed)
      const stokPaket = items.length ? Math.min(...items.map(it => Math.floor(it.stok_produk / it.qty_needed))) : 0;
      rows.push({
        id: pk.id, sku: pk.sku, nama: pk.nama, kategori: pk.kategori||'Paket',
        harga_jual: pk.harga_jual, harga_modal: pk.harga_modal, satuan: 'paket',
        komisi: pk.komisi, komisi_poin: pk.komisi_poin, foto_url: pk.foto_url,
        stok_minimum: 0, qty: stokPaket, is_paket: 1,
        paket_items: items.map(it => ({produk_id:it.produk_id, qty:it.qty_needed, nama_produk:it.nama_produk}))
      });
    }

    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/pos/stok - update stok manual
router.patch('/stok', auth(['owner','admin_pusat','head_operational','manajer']), async (req, res) => {
  try {
    const { produk_id, cabang_id, qty } = req.body;
    const [[_os]] = await db.query('SELECT qty FROM pos_stok WHERE produk_id=? AND cabang_id=?', [produk_id, cabang_id]);
    const _oldQty = _os ? _os.qty : 0;
    const _sel = qty - _oldQty;
    await db.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE qty=VALUES(qty)`, [produk_id, cabang_id, qty]);
    if (_sel !== 0) { await db.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,?,?,?,?)`, [produk_id, cabang_id, _sel>0?'masuk':'keluar', Math.abs(_sel), 'Penyesuaian stok manual', req.user.id]).catch(()=>{}); }
    audit(req, 'update', 'stok', produk_id, `Cabang ${cabang_id}`, {old_qty:_oldQty, new_qty:qty, selisih:_sel});
    res.json({success:true,message:'Stok diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos/stok/transfer - transfer stok gudang ke toko
router.post('/stok/transfer', auth(['owner','admin_pusat','head_operational','manajer']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { dari_cabang_id, ke_cabang_id, items } = req.body;
    if (!items?.length) return res.status(400).json({success:false,message:'Items kosong.'});
    const [[dariCab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [dari_cabang_id]);
    const [[keCab]]   = await conn.query('SELECT nama FROM cabang WHERE id=?', [ke_cabang_id]);
    const dariNama = dariCab?.nama || ('Cabang #'+dari_cabang_id);
    const keNama   = keCab?.nama   || ('Cabang #'+ke_cabang_id);
    // items: [{produk_id, qty}]
    for (const item of items) {
      // Kurangi stok asal
      await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,0)
        ON DUPLICATE KEY UPDATE qty=GREATEST(0,qty-?)`,
        [item.produk_id, dari_cabang_id, item.qty]);
      // Tambah stok tujuan
      await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE qty=qty+?`,
        [item.produk_id, ke_cabang_id, item.qty, item.qty]);
      // Log stok (non-critical)
      await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,'transfer_keluar',?,?,?)`,
        [item.produk_id, dari_cabang_id, item.qty, 'Transfer ke '+keNama, req.user.id]).catch(()=>{});
      await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,'transfer_masuk',?,?,?)`,
        [item.produk_id, ke_cabang_id, item.qty, 'Transfer dari '+dariNama, req.user.id]).catch(()=>{});
    }
    await conn.commit();
    audit(req, 'create', 'transfer_stok', null, `${dariNama} → ${keNama}`, {items_count:items.length});
    res.json({success:true,message:`Transfer ${items.length} produk berhasil.`});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// ── SHIFT ──────────────────────────────
router.get('/shift/aktif', auth(), async (req, res) => {
  try {
    const cabang_id = req.query.cabang_id || req.user.cabang_id;
    const [[shift]] = await db.query(`
      SELECT s.*, u.nama_lengkap as nama_kasir
      FROM pos_shift s JOIN users u ON u.id=s.kasir_id
      WHERE s.cabang_id=? AND s.status='buka'
      ORDER BY s.waktu_buka DESC LIMIT 1`, [cabang_id]);
    res.json({success:true, data:shift||null});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.post('/shift/buka', auth(), async (req, res) => {
  try {
    const cabang_id = req.body.cabang_id || req.user.cabang_id;
    const { modal_awal } = req.body;
    // Cek tidak ada shift aktif
    const [[existing]] = await db.query('SELECT id FROM pos_shift WHERE cabang_id=? AND status="buka"', [cabang_id]);
    if (existing) return res.status(400).json({success:false,message:'Masih ada shift aktif.'});
    const [result] = await db.query('INSERT INTO pos_shift (cabang_id,kasir_id,modal_awal) VALUES (?,?,?)',
      [cabang_id, req.user.id, modal_awal||0]);
    res.json({success:true,message:'Shift dibuka.',shift_id:result.insertId});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.post('/shift/tutup', auth(), async (req, res) => {
  try {
    const { shift_id, catatan_tutup } = req.body;
    // Hitung total penjualan shift ini
    const [[totals]] = await db.query(`
      SELECT COUNT(*) as total_transaksi, COALESCE(SUM(total),0) as total_penjualan,
             COALESCE(SUM(ti.komisi_total),0) as total_komisi
      FROM pos_transaksi t
      LEFT JOIN (SELECT transaksi_id, SUM(komisi*qty) as komisi_total FROM pos_transaksi_item GROUP BY transaksi_id) ti
        ON ti.transaksi_id=t.id
      WHERE t.cabang_id=(SELECT cabang_id FROM pos_shift WHERE id=?)
        AND t.created_at>=(SELECT waktu_buka FROM pos_shift WHERE id=?)
        AND t.status='selesai'`, [shift_id, shift_id]);
    await db.query(`UPDATE pos_shift SET status='tutup', waktu_tutup=NOW(),
      total_transaksi=?, total_penjualan=?, total_komisi=?, catatan_tutup=? WHERE id=?`,
      [totals.total_transaksi, totals.total_penjualan, totals.total_komisi, catatan_tutup||'', shift_id]);
    res.json({success:true,message:'Shift ditutup.', totals});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── TRANSAKSI ──────────────────────────────
router.post('/transaksi', auth(), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // ── Validasi absensi: DISABLED sementara — sedang investigasi bug ──
    // Kasir terblokir padahal sudah absen. Root cause: race condition sync + status downgrade.
    // TODO: re-enable setelah fix sync logic
    /*
    const GUDANG_IDS = [3, 4];
    const DEBUG_USERS = ['kasirtes'];
    const _cabTrx = req.body.cabang_id || req.user.cabang_id;
    if (['kasir','kasir_sales','vaporista','kepala_cabang'].includes(req.user.role)
        && !GUDANG_IDS.includes(_cabTrx) && req.user.personnel_id
        && !DEBUG_USERS.includes(req.user.username)) {
      const tgl = new Date().toISOString().slice(0,10);
      const [[absen]] = await conn.query(
        'SELECT status FROM absensi_hari_ini WHERE user_id=? AND tanggal=?',
        [req.user.id, tgl]);
      if (!absen || absen.status === 'tidak_hadir') {
        conn.release();
        return res.status(403).json({success:false, message:'Anda belum absen masuk hari ini. Silakan absen di Kerjoo terlebih dahulu.', kode:'BELUM_ABSEN'});
      }
      if (absen.status === 'pulang') {
        conn.release();
        return res.status(403).json({success:false, message:'Shift Anda sudah berakhir (sudah absen pulang). Tidak dapat melakukan transaksi.', kode:'SUDAH_PULANG'});
      }
    }
    */

    const { cabang_id, items, metode_bayar, bayar, diskon, catatan, pembayaran, member_id } = req.body;
    // pembayaran: [{metode:'cash',nominal:50000},{metode:'transfer',nominal:30000}] — untuk split payment
    if (!items?.length) return res.status(400).json({success:false,message:'Items kosong.'});

    // Hitung total
    let subtotal = 0;
    for (const item of items) subtotal += item.harga_jual * item.qty;
    const totalDiskon = diskon || 0;
    const total   = subtotal - totalDiskon;
    const kembalian = (bayar||0) - total;
    const id = 'TRX-'+Date.now()+'-'+Math.random().toString(36).slice(2,5).toUpperCase();

    // Tentukan metode: jika ada pembayaran array > 1 jenis → split
    let metodeEfektif = metode_bayar || 'cash';
    if (pembayaran?.length > 1) {
      const metodes = new Set(pembayaran.map(p => p.metode));
      if (metodes.size > 1) metodeEfektif = 'split';
    }

    // Insert transaksi
    await conn.query(`INSERT INTO pos_transaksi (id,cabang_id,kasir_id,subtotal,diskon,total,bayar,kembalian,metode_bayar,catatan,member_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, cabang_id||req.user.cabang_id, req.user.id, subtotal, totalDiskon, total, bayar||total, kembalian, metodeEfektif, catatan||'', member_id||null]);

    // Insert detail pembayaran (jika split)
    if (pembayaran?.length) {
      for (const pb of pembayaran) {
        if (pb.nominal > 0) {
          await conn.query('INSERT INTO pos_transaksi_bayar (transaksi_id,metode,nominal) VALUES (?,?,?)',
            [id, pb.metode, pb.nominal]);
        }
      }
    }

    // Insert items + kurangi stok
    let totalKomisi = 0, totalPoin = 0, totalItemQty = 0;
    const _cab = cabang_id||req.user.cabang_id;
    for (const item of items) {
      const komisiPoin = item.komisi_poin||0;
      await conn.query(`INSERT INTO pos_transaksi_item (transaksi_id,produk_id,paket_id,nama_produk,qty,harga_jual,harga_modal,diskon_item,subtotal,komisi,komisi_poin)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, item.is_paket ? null : item.produk_id, item.is_paket ? item.produk_id : null, item.nama_produk, item.qty, item.harga_jual, item.harga_modal||0, item.diskon_item||0, item.harga_jual*item.qty, item.komisi||0, komisiPoin]);
      totalKomisi += (item.komisi||0) * item.qty;
      totalPoin   += komisiPoin * item.qty;
      totalItemQty += item.qty;

      if (item.is_paket) {
        // Paket: kurangi stok semua komponen
        const [paketItems] = await conn.query('SELECT produk_id, qty FROM pos_paket_item WHERE paket_id=?', [item.produk_id]);
        for (const pi of paketItems) {
          const reduceQty = pi.qty * item.qty;
          await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,'penjualan',?,?,?)`,
            [pi.produk_id, _cab, reduceQty, `Paket ${item.nama_produk} - Transaksi ${id}`, req.user.id]).catch((e)=>console.error('stok_log err:',e.message));
          await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,0)
            ON DUPLICATE KEY UPDATE qty=GREATEST(0,qty-?)`, [pi.produk_id, _cab, reduceQty]);
        }
      } else {
        // Produk biasa: kurangi stok langsung
        await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,'penjualan',?,?,?)`, [item.produk_id, _cab, item.qty, 'Transaksi '+id, req.user.id]).catch((e)=>console.error('stok_log err:',e.message));
        await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,0)
          ON DUPLICATE KEY UPDATE qty=GREATEST(0,qty-?)`,
          [item.produk_id, _cab, item.qty]);
      }
    }

    // Auto-update staff_rekap_harian
    const _tglRekap = new Date().toISOString().slice(0,10);
    let _cashAdd = 0, _trfAdd = 0, _qrisAdd = 0;
    if (pembayaran?.length) {
      // Split payment — hitung per metode
      pembayaran.forEach(pb => {
        if (pb.metode==='cash') _cashAdd += parseFloat(pb.nominal)||0;
        else if (pb.metode==='transfer') _trfAdd += parseFloat(pb.nominal)||0;
        else if (pb.metode==='qris') _qrisAdd += parseFloat(pb.nominal)||0;
      });
    } else {
      // Single payment
      const _metode = metodeEfektif;
      _cashAdd = _metode==='cash' ? total : 0;
      _trfAdd  = _metode==='transfer' ? total : 0;
      _qrisAdd = _metode==='qris' ? total : 0;
    }
    await conn.query(`INSERT INTO staff_rekap_harian (user_id,cabang_id,tanggal,total_trx,omzet_cash,omzet_transfer,omzet_qris,total_komisi,total_poin,total_item)
      VALUES (?,?,?,1,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE total_trx=total_trx+1, omzet_cash=omzet_cash+?, omzet_transfer=omzet_transfer+?, omzet_qris=omzet_qris+?,
        total_komisi=total_komisi+?, total_poin=total_poin+?, total_item=total_item+?`,
      [req.user.id, _cab, _tglRekap, _cashAdd, _trfAdd, _qrisAdd, totalKomisi, totalPoin, totalItemQty,
       _cashAdd, _trfAdd, _qrisAdd, totalKomisi, totalPoin, totalItemQty]).catch(e=>console.error('rekap err:',e.message));

    // Auto-insert pemasukan harian untuk cabang retail (bukan gudang)
    if (![3, 4].includes(_cab)) {
      const [[_omzHari]] = await conn.query(
        `SELECT COALESCE(SUM(total),0) as t FROM pos_transaksi WHERE cabang_id=? AND status='selesai' AND created_at>=? AND created_at<=?`,
        [_cab, _tglRekap+' 00:00:00', _tglRekap+' 23:59:59']);
      await conn.query(`INSERT INTO pemasukan (cabang_id, tanggal, nominal, keterangan, sumber, user_id)
        VALUES (?, ?, ?, CONCAT('Omzet POS ',?), 'pos_otomatis', ?)
        ON DUPLICATE KEY UPDATE nominal=VALUES(nominal)`,
        [_cab, _tglRekap, parseFloat(_omzHari.t), _tglRekap, req.user.id]).catch(e=>console.error('pemasukan auto err:',e.message));
    }

    await conn.commit();
    audit(req, 'create', 'transaksi', id, `${rp_plain(total)} (${metodeEfektif})`, {total, items_count:items.length, cabang_id:_cab});

    // Broadcast realtime SSE ke semua dashboard yang terhubung
    try {
      const { broadcast } = require('../utils/eventBus');
      broadcast('trx', {
        id, cabang_id: _cab, kasir_id: req.user.id,
        kasir_nama: req.user.nama_lengkap || req.user.username,
        total, komisi: totalKomisi, poin: totalPoin,
        items_count: items.length, metode: metodeEfektif,
        ts: Date.now()
      });
    } catch(e) {}

    res.json({success:true, id, total, kembalian, message:'Transaksi berhasil.'});
  } catch(e) {
    await conn.rollback();
    res.status(500).json({success:false,message:e.message});
  } finally { conn.release(); }
});

// GET /api/pos/history — history transaksi lengkap dengan filter, pagination, summary
router.get('/history', auth(), async (req, res) => {
  try {
    const { getCabangAkses } = require('../middleware/cabangFilter');
    const { dari, sampai, cabang_id, kasir_id, metode, q, page, per_page } = req.query;

    let where = 'WHERE t.status="selesai"';
    const params = [];

    // Date range
    if (dari) { where += ' AND t.created_at >= ?'; params.push(dari + ' 00:00:00'); }
    if (sampai) { where += ' AND t.created_at <= ?'; params.push(sampai + ' 23:59:59'); }

    // Cabang filter — akses control
    if (cabang_id) {
      where += ' AND t.cabang_id=?'; params.push(parseInt(cabang_id));
    } else {
      const akses = await getCabangAkses(req.user);
      if (akses !== null && akses.length > 0) {
        where += ` AND t.cabang_id IN (${akses.map(()=>'?').join(',')})`;
        params.push(...akses);
      } else if (akses !== null && akses.length === 0) {
        return res.json({ success:true, data:[], summary:{}, total:0 });
      }
    }

    // Kasir filter
    if (kasir_id) { where += ' AND t.kasir_id=?'; params.push(parseInt(kasir_id)); }

    // Metode bayar filter
    if (metode) { where += ' AND t.metode_bayar=?'; params.push(metode); }

    // Search by trx ID
    if (q) { where += ' AND t.id LIKE ?'; params.push('%' + q + '%'); }

    // Summary
    const [[summary]] = await db.query(`
      SELECT COUNT(*) as total_trx,
        COALESCE(SUM(t.subtotal),0) as total_bruto,
        COALESCE(SUM(t.diskon),0) as total_diskon,
        COALESCE(SUM(t.total),0) as total_omzet,
        COALESCE(SUM(CASE WHEN t.metode_bayar='cash' THEN t.total ELSE 0 END),0) as total_cash,
        COALESCE(SUM(CASE WHEN t.metode_bayar='transfer' THEN t.total ELSE 0 END),0) as total_transfer,
        COALESCE(SUM(CASE WHEN t.metode_bayar='qris' THEN t.total ELSE 0 END),0) as total_qris,
        COALESCE(SUM(CASE WHEN t.metode_bayar='split' THEN t.total ELSE 0 END),0) as total_split
      FROM pos_transaksi t ${where}`, params);

    // Pagination
    const lmt = Math.min(parseInt(per_page) || 50, 200);
    const pg = parseInt(page) || 1;
    const offset = (pg - 1) * lmt;
    const total = parseInt(summary.total_trx);

    // Fetch rows
    const [rows] = await db.query(`
      SELECT t.*, c.nama as nama_cabang, c.kode as kode_cabang, u.nama_lengkap as nama_kasir
      FROM pos_transaksi t
      LEFT JOIN cabang c ON c.id=t.cabang_id
      LEFT JOIN users u ON u.id=t.kasir_id
      ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, [...params, lmt, offset]);

    res.json({
      success: true, data: rows, summary,
      total, page: pg, per_page: lmt, total_pages: Math.ceil(total / lmt)
    });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/pos/transaksi?cabang_id=&tgl=
router.get('/transaksi', auth(), async (req, res) => {
  try {
    const { cabang_id, tgl, limit } = req.query;
    let where = 'WHERE t.status="selesai"';
    const params = [];
    if (cabang_id) { where += ' AND t.cabang_id=?'; params.push(cabang_id); }
    if (tgl) { where += ' AND t.created_at>=? AND t.created_at<?'; params.push(tgl+' 00:00:00', tgl+' 23:59:59'); }
    const lmt = limit ? parseInt(limit) : 50;
    const [rows] = await db.query(`
      SELECT t.*, c.nama as nama_cabang, u.nama_lengkap as nama_kasir
      FROM pos_transaksi t
      LEFT JOIN cabang c ON c.id=t.cabang_id
      LEFT JOIN users u ON u.id=t.kasir_id
      ${where} ORDER BY t.created_at DESC LIMIT ?`, [...params, lmt]);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos/transaksi/:id - detail dengan items
router.get('/transaksi/:id', auth(), async (req, res) => {
  try {
    const [[trx]] = await db.query(`SELECT t.*,c.nama as nama_cabang,u.nama_lengkap as nama_kasir
      FROM pos_transaksi t LEFT JOIN cabang c ON c.id=t.cabang_id LEFT JOIN users u ON u.id=t.kasir_id
      WHERE t.id=?`, [req.params.id]);
    if (!trx) return res.status(404).json({success:false,message:'Transaksi tidak ditemukan.'});
    const [items] = await db.query('SELECT * FROM pos_transaksi_item WHERE transaksi_id=?', [req.params.id]);
    const [pembayaran] = await db.query('SELECT metode, nominal FROM pos_transaksi_bayar WHERE transaksi_id=?', [req.params.id]);
    res.json({success:true, data:{...trx, items, pembayaran}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/pos/transaksi/:id/batal
router.patch('/transaksi/:id/batal', auth(['owner','admin_pusat','manajer']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[trx]] = await conn.query('SELECT * FROM pos_transaksi WHERE id=?', [req.params.id]);
    if (!trx || trx.status!=='selesai') return res.status(400).json({success:false,message:'Transaksi tidak bisa dibatalkan.'});
    // Kembalikan stok
    const [items] = await conn.query('SELECT * FROM pos_transaksi_item WHERE transaksi_id=?', [req.params.id]);
    let bKomisi=0, bPoin=0, bItemQty=0;
    for (const item of items) {
      if (item.paket_id) {
        // Paket: kembalikan stok semua komponen
        const [paketItems] = await conn.query('SELECT produk_id, qty FROM pos_paket_item WHERE paket_id=?', [item.paket_id]);
        for (const pi of paketItems) {
          const restoreQty = pi.qty * item.qty;
          await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?)
            ON DUPLICATE KEY UPDATE qty=qty+?`, [pi.produk_id, trx.cabang_id, restoreQty, restoreQty]);
        }
      } else {
        // Produk biasa
        await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?)
          ON DUPLICATE KEY UPDATE qty=qty+?`, [item.produk_id, trx.cabang_id, item.qty, item.qty]);
      }
      bKomisi  += (item.komisi||0) * item.qty;
      bPoin    += (item.komisi_poin||0) * item.qty;
      bItemQty += item.qty;
    }
    await conn.query('UPDATE pos_transaksi SET status="batal" WHERE id=?', [req.params.id]);
    // Reverse staff_rekap_harian
    const _bTgl = trx.created_at ? new Date(trx.created_at).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
    const _bCash = trx.metode_bayar==='cash' ? parseFloat(trx.total) : 0;
    const _bTrf  = trx.metode_bayar==='transfer' ? parseFloat(trx.total) : 0;
    const _bQris = trx.metode_bayar==='qris' ? parseFloat(trx.total) : 0;
    await conn.query(`UPDATE staff_rekap_harian SET total_trx=GREATEST(0,total_trx-1),
      omzet_cash=GREATEST(0,omzet_cash-?), omzet_transfer=GREATEST(0,omzet_transfer-?), omzet_qris=GREATEST(0,omzet_qris-?),
      total_komisi=GREATEST(0,total_komisi-?), total_poin=GREATEST(0,total_poin-?), total_item=GREATEST(0,total_item-?)
      WHERE user_id=? AND cabang_id=? AND tanggal=?`,
      [_bCash, _bTrf, _bQris, bKomisi, bPoin, bItemQty, trx.kasir_id, trx.cabang_id, _bTgl]).catch(()=>{});
    // Update pemasukan otomatis (recalculate dari total transaksi selesai)
    const _GUDANG_IDS = [3, 4];
    if (!_GUDANG_IDS.includes(trx.cabang_id)) {
      await conn.query(`UPDATE pemasukan SET nominal = (
        SELECT COALESCE(SUM(total),0) FROM pos_transaksi
        WHERE cabang_id=? AND status='selesai'
          AND created_at >= CONCAT(?,' 00:00:00') AND created_at <= CONCAT(?,' 23:59:59')
      ) WHERE cabang_id=? AND tanggal=? AND sumber='pos_otomatis'`,
        [trx.cabang_id, _bTgl, _bTgl, trx.cabang_id, _bTgl]).catch(()=>{});
    }
    await conn.commit();
    audit(req, 'batal', 'transaksi', req.params.id, `Batal ${rp_plain(trx.total)}`, {cabang_id:trx.cabang_id});
    res.json({success:true,message:'Transaksi dibatalkan dan stok dikembalikan.'});
  } catch(e) {
    await conn.rollback();
    res.status(500).json({success:false,message:e.message});
  } finally { conn.release(); }
});

// ── LAPORAN ──────────────────────────────
router.get('/laporan/harian', auth(), async (req, res) => {
  try {
    const { cabang_id, tgl } = req.query;
    const tanggal = tgl || new Date().toISOString().slice(0,10);
    const tglStart = tanggal+' 00:00:00', tglEnd = tanggal+' 23:59:59';
    const [summary] = await db.query(`
      SELECT COUNT(*) as total_transaksi, COALESCE(SUM(total),0) as total_omzet,
             COALESCE(SUM(diskon),0) as total_diskon,
             metode_bayar, COUNT(*) as jumlah
      FROM pos_transaksi
      WHERE cabang_id=? AND created_at>=? AND created_at<=? AND status='selesai'
      GROUP BY metode_bayar`, [cabang_id, tglStart, tglEnd]);
    const [produkLaris] = await db.query(`
      SELECT ti.nama_produk, SUM(ti.qty) as total_qty, SUM(ti.subtotal) as total_omzet,
             SUM(ti.komisi*ti.qty) as total_komisi
      FROM pos_transaksi_item ti
      JOIN pos_transaksi t ON t.id=ti.transaksi_id
      WHERE t.cabang_id=? AND t.created_at>=? AND t.created_at<=? AND t.status='selesai'
      GROUP BY ti.produk_id, ti.nama_produk
      ORDER BY total_qty DESC LIMIT 10`, [cabang_id, tglStart, tglEnd]);
    res.json({success:true, summary, produk_laris:produkLaris, tanggal});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});


// GET /produk/export - export produk + stok semua cabang
router.get('/produk/export-stok', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const xlsx = require('xlsx');
    // Ambil semua produk
    const [produk] = await db.query('SELECT * FROM pos_produk ORDER BY kategori, nama');
    // Ambil semua cabang aktif
    const [cabang] = await db.query('SELECT id, kode, nama FROM cabang WHERE aktif=1 ORDER BY kode');
    // Ambil semua stok
    const [stok] = await db.query('SELECT produk_id, cabang_id, qty FROM pos_stok');
    const stokMap = {};
    stok.forEach(s => { stokMap[s.produk_id+'_'+s.cabang_id] = s.qty; });

    const header = ['SKU','Nama','Kategori','Harga Jual','Harga Modal','Komisi','Poin','Satuan','Status',
      ...cabang.map(c => 'Stok_'+c.nama)];
    const rows = produk.map(p => [
      p.sku, p.nama, p.kategori||'', p.harga_jual, p.harga_modal, p.komisi||0, p.komisi_poin||0, p.satuan||'pcs', p.aktif?'Aktif':'Nonaktif',
      ...cabang.map(c => stokMap[p.id+'_'+c.id]||0)
    ]);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([header, ...rows]);
    xlsx.utils.book_append_sheet(wb, ws, 'Produk - Raja Vapor');
    addInfoSheet(wb, 'Semua Cabang (Stok)');
    await addKategoriSheet(wb);
    const buf = xlsx.write(wb, {type:'buffer', bookType:'xlsx'});
    res.setHeader('Content-Disposition','attachment; filename="produk_stok_RajaVapor.xlsx"');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /produk/import-stok - import produk + stok dari excel
router.post('/produk/import-stok', auth(['owner','admin_pusat','head_operational']), upload2.single('file'), async (req, res) => {
  try {
    const xlsx = require('xlsx');
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});
    const wb = xlsx.read(req.file.buffer||require('fs').readFileSync(req.file.path), {type:'buffer'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, {header:1});
    if (rows.length < 2) return res.status(400).json({success:false,message:'File kosong.'});

    const header = rows[0].map(h => String(h||'').trim());
    // Cari kolom stok (format Stok_NAMA atau Stok_KODE)
    const stokCols = [];
    const [cabang] = await db.query('SELECT id, kode, nama FROM cabang WHERE aktif=1');
    header.forEach((h, idx) => {
      const val = h.replace(/^stok[_ ]?/i,'').trim().toUpperCase();
      const cab = cabang.find(c => c.nama.toUpperCase() === val || c.kode.toUpperCase() === val);
      if (cab) stokCols.push({idx, cabang_id: cab.id});
    });

    // Deteksi kolom Poin dari header
    const poinIdx = header.findIndex(h => h.toLowerCase()==='poin' || h.toLowerCase()==='komisi poin');

    let updated=0, created=0, stokUpdated=0;
    for (let i=1; i<rows.length; i++) {
      const r = rows[i];
      if (!r || !r[1]) continue;
      const sku=String(r[0]||'').trim(), nama=String(r[1]||'').trim(),
            kat=String(r[2]||''), hj=parseFloat(r[3])||0, hm=parseFloat(r[4])||0,
            kom=parseFloat(r[5])||0, poin=poinIdx>=0?(parseInt(r[poinIdx])||0):0,
            sat=String(r[poinIdx>=0?7:6]||'pcs'), aktif=String(r[poinIdx>=0?8:7]||'Aktif').toLowerCase()==='aktif'?1:0;
      if (!nama) continue;
      const [[ex]] = await db.query('SELECT id FROM pos_produk WHERE sku=? OR nama=?',[sku,nama]);
      let produkId;
      if (ex) {
        await db.query('UPDATE pos_produk SET sku=?,nama=?,kategori=?,harga_jual=?,harga_modal=?,komisi=?,komisi_poin=?,satuan=?,aktif=? WHERE id=?',
          [sku,nama,kat,hj,hm,kom,poin,sat,aktif,ex.id]);
        produkId=ex.id; updated++;
      } else {
        const [ins] = await db.query('INSERT INTO pos_produk (sku,nama,kategori,harga_jual,harga_modal,komisi,komisi_poin,satuan,aktif) VALUES (?,?,?,?,?,?,?,?,?)',
          [sku,nama,kat,hj,hm,kom,poin,sat,aktif]);
        produkId=ins.insertId; created++;
      }
      // Update stok per cabang
      for (const sc of stokCols) {
        const qty = parseInt(r[sc.idx])||0;
        await db.query('INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=VALUES(qty)',
          [produkId, sc.cabang_id, qty]);
        stokUpdated++;
      }
    }
    res.json({success:true, message:`${created} produk baru, ${updated} diupdate, ${stokUpdated} stok diupdate.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── IMPORT/EXPORT PRODUK ──────────────────────────────
// POST /api/pos/produk/import — import produk + stok (jika ada kolom Stok_KODE)
router.post('/produk/import', auth(['owner','admin_pusat','head_operational']), upload2.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});
    const wb   = XLSX.readFile(req.file.path);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(ws, {header:1});
    fs.unlinkSync(req.file.path);
    if (rawRows.length < 2) return res.status(400).json({success:false,message:'File kosong.'});

    // cabang_id opsional dari form data (untuk import stok kolom "Stok" biasa)
    const targetCabangId = parseInt(req.body.cabang_id) || 0;

    // Deteksi kolom stok dari header (format: Stok_KODE, Stok KODE, Stok_NAMA)
    const header = rawRows[0].map(h => String(h||'').trim());
    const stokCols = [];
    const [cabangList] = await db.query('SELECT id, kode, nama FROM cabang WHERE aktif=1');
    header.forEach((h, idx) => {
      const m = h.match(/^stok[_ ](.+)$/i);
      if (m) {
        const val = m[1].trim().toUpperCase();
        const cab = cabangList.find(c => c.nama.toUpperCase() === val || c.kode.toUpperCase() === val);
        if (cab) stokCols.push({idx, cabang_id: cab.id});
      }
    });

    // Deteksi kolom berdasarkan header
    const colIdx = {};
    header.forEach((h, i) => {
      const hl = h.toLowerCase();
      if (hl==='sku')                         colIdx.sku = i;
      else if (hl==='nama')                   colIdx.nama = i;
      else if (hl==='kategori')               colIdx.kategori = i;
      else if (hl==='harga jual')             colIdx.harga_jual = i;
      else if (hl==='harga modal')            colIdx.harga_modal = i;
      else if (hl==='satuan')                 colIdx.satuan = i;
      else if (hl==='komisi')                 colIdx.komisi = i;
      else if (hl==='poin'||hl==='komisi poin') colIdx.poin = i;
      else if (hl==='status')                 colIdx.status = i;
      else if (hl==='total stok'||hl==='stok') colIdx.total_stok = i;
      else if (hl==='stok minimum'||hl==='min stok') colIdx.stok_minimum = i;
    });

    let inserted=0, updated=0, skipped=0, stokUpdated=0;
    for (let i=1; i<rawRows.length; i++) {
      const r = rawRows[i];
      if (!r) continue;
      const sku        = String(r[colIdx.sku]||r[0]||'').trim();
      const nama       = String(r[colIdx.nama]||r[1]||'').trim();
      const kategori   = String(r[colIdx.kategori!=null?colIdx.kategori:2]||'').trim()||null;
      const harga_jual = parseInt(r[colIdx.harga_jual!=null?colIdx.harga_jual:3])||0;
      const harga_modal= parseInt(r[colIdx.harga_modal!=null?colIdx.harga_modal:4])||0;
      const satuan     = String(r[colIdx.satuan!=null?colIdx.satuan:5]||'pcs').trim();
      const komisi     = parseInt(r[colIdx.komisi!=null?colIdx.komisi:6])||0;
      const poin       = colIdx.poin!=null ? (parseInt(r[colIdx.poin])||0) : 0;
      const aktif      = colIdx.status!=null ? (String(r[colIdx.status]||'Aktif').toLowerCase()==='aktif'?1:0) : 1;
      const stokMin    = colIdx.stok_minimum!=null ? (parseInt(r[colIdx.stok_minimum])||0) : null;
      if (!sku||!nama) { skipped++; continue; }
      try {
        const [[ex]] = await db.query('SELECT id FROM pos_produk WHERE sku=?',[sku]);
        let produkId;
        if (ex) {
          await db.query(`UPDATE pos_produk SET nama=?,kategori=?,harga_jual=?,harga_modal=?,satuan=?,komisi=?,komisi_poin=?,aktif=?${stokMin!==null?',stok_minimum=?':''} WHERE id=?`,
            stokMin!==null ? [nama,kategori,harga_jual,harga_modal,satuan,komisi,poin,aktif,stokMin,ex.id]
                           : [nama,kategori,harga_jual,harga_modal,satuan,komisi,poin,aktif,ex.id]);
          produkId = ex.id; updated++;
        } else {
          const [ins] = await db.query(`INSERT INTO pos_produk (sku,nama,kategori,harga_jual,harga_modal,satuan,komisi,komisi_poin,aktif,stok_minimum) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [sku,nama,kategori,harga_jual,harga_modal,satuan,komisi,poin,aktif,stokMin||0]);
          produkId = ins.insertId; inserted++;
          // Auto-init pos_stok qty=0 di semua cabang aktif (sama seperti tambah produk satuan)
          if (cabangList.length) {
            const ph = cabangList.map(() => '(?,?,0)').join(',');
            const vals = cabangList.flatMap(c => [produkId, c.id]);
            await db.query(`INSERT IGNORE INTO pos_stok (produk_id, cabang_id, qty) VALUES ${ph}`, vals);
          }
        }
        // Update stok per cabang jika ada kolom Stok_NAMA (multi-cabang)
        for (const sc of stokCols) {
          const qty = parseInt(r[sc.idx])||0;
          await db.query('INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=VALUES(qty)',
            [produkId, sc.cabang_id, qty]);
          stokUpdated++;
        }
        // Update stok dari kolom "Stok"/"Total Stok" biasa jika ada cabang_id target
        if (targetCabangId > 0 && colIdx.total_stok != null && !stokCols.length) {
          const qty = parseInt(r[colIdx.total_stok])||0;
          await db.query('INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=VALUES(qty)',
            [produkId, targetCabangId, qty]);
          stokUpdated++;
        }
      } catch(e) { skipped++; }
    }
    let msg = `Import selesai: ${inserted} produk baru, ${updated} diupdate, ${skipped} dilewati.`;
    if (stokUpdated) msg += ` ${stokUpdated} stok diupdate.`;
    if (!stokCols.length && !targetCabangId && colIdx.total_stok != null) msg += ' (Kolom Stok terdeteksi tapi cabang belum dipilih — pilih cabang untuk import stok)';
    if (!stokCols.length && colIdx.total_stok == null) msg += ' (Tidak ada kolom stok terdeteksi — tambahkan kolom Stok di Excel untuk import stok)';
    res.json({success:true, message:msg});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos/produk/export
router.get('/produk/export', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const [produk] = await db.query('SELECT * FROM pos_produk ORDER BY kategori, nama');
    const [cabang] = await db.query('SELECT id, kode, nama FROM cabang WHERE aktif=1 ORDER BY kode');
    const [stok]   = await db.query('SELECT produk_id, cabang_id, qty FROM pos_stok');
    const stokMap = {};
    stok.forEach(s => { stokMap[s.produk_id+'_'+s.cabang_id] = s.qty; });

    const rows = produk.map(p => {
      const row = {
        SKU: p.sku, Nama: p.nama, Kategori: p.kategori||'',
        'Harga Jual': p.harga_jual, 'Harga Modal': p.harga_modal,
        Satuan: p.satuan||'pcs', Komisi: p.komisi||0, Poin: p.komisi_poin||0,
        Status: p.aktif ? 'Aktif' : 'Nonaktif',
        'Stok Minimum': p.stok_minimum||0
      };
      let totalStok = 0;
      cabang.forEach(c => {
        const qty = stokMap[p.id+'_'+c.id]||0;
        row['Stok_'+c.nama] = qty;
        totalStok += qty;
      });
      row['Total Stok'] = totalStok;
      return row;
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    const colWidths = [{wch:15},{wch:40},{wch:15},{wch:12},{wch:12},{wch:8},{wch:8},{wch:6},{wch:10}];
    cabang.forEach(() => colWidths.push({wch:10}));
    colWidths.push({wch:10});
    ws['!cols'] = colWidths;
    XLSX.utils.book_append_sheet(wb, ws, 'Produk POS - Raja Vapor');
    addInfoSheet(wb, 'Semua Cabang');
    await addKategoriSheet(wb);
    const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Disposition','attachment; filename=produk_pos_RajaVapor.xlsx');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos/produk/template - download template Excel kosong
router.get('/produk/template', auth(), async (req, res) => {
  try {
    const ws = XLSX.utils.aoa_to_sheet([
      ['SKU','Nama','Kategori','Harga Jual','Harga Modal','Satuan','Komisi','Poin','Stok'],
      ['LQ001','FOOM Ice Tea 30ml','Freebase',35000,25000,'pcs',500,10,100],
      ['LQ002','VGOD Cubano 60ml','Freebase',85000,60000,'pcs',1000,20,50],
      ['SN001','Saltnic Sample 30ml','Saltnic',45000,32000,'pcs',500,10,75],
    ]);
    ws['!cols'] = [{wch:15},{wch:40},{wch:15},{wch:12},{wch:12},{wch:8},{wch:8},{wch:6},{wch:8}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    addInfoSheet(wb, 'Template Import');
    await addKategoriSheet(wb);
    const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Disposition','attachment; filename=template_produk_pos.xlsx');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos/stok/cari?q=&cabang_id= - cari stok di semua cabang
router.get('/stok/cari', auth(), async (req, res) => {
  try {
    const { q, cabang_id } = req.query;
    if (!q) return res.status(400).json({success:false,message:'Query wajib.'});
    const words = q.trim().split(/\s+/).filter(w => w);
    let smartWhere = '';
    const smartParams = [];
    for (const w of words) {
      smartWhere += ' AND (p.nama LIKE ? OR p.sku LIKE ?)';
      smartParams.push('%'+w+'%','%'+w+'%');
    }
    const [rows] = await db.query(`
      SELECT p.id, p.sku, p.nama, p.kategori, p.harga_jual, p.satuan,
             c.id as cabang_id, c.nama as nama_cabang, c.kode,
             COALESCE(s.qty,0) as qty
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.qty>0
      JOIN cabang c ON c.id=s.cabang_id
      WHERE p.aktif=1${smartWhere}
      ORDER BY s.qty DESC`, smartParams);

    // Jika ada cabang_id, tandai cabang terdekat berdasarkan urutan kode
    // (Cabang dengan kode numerik terdekat dianggap terdekat secara geografis)
    if (cabang_id) {
      const [[myCabang]] = await db.query('SELECT kode FROM cabang WHERE id=?', [cabang_id]);
      const myNum = parseInt((myCabang?.kode||'').replace(/\D/g,''))||0;
      rows.forEach(r => {
        const num = parseInt((r.kode||'').replace(/\D/g,''))||999;
        r.jarak_kode = Math.abs(num - myNum);
      });
      rows.sort((a,b) => a.jarak_kode - b.jarak_kode);
    }

    // Group by produk
    const produkMap = {};
    rows.forEach(r => {
      if (!produkMap[r.id]) produkMap[r.id] = {
        id:r.id, sku:r.sku, nama:r.nama, kategori:r.kategori,
        harga_jual:r.harga_jual, satuan:r.satuan, cabang_list:[]
      };
      produkMap[r.id].cabang_list.push({
        cabang_id:r.cabang_id, nama_cabang:r.nama_cabang,
        kode:r.kode, qty:r.qty, jarak:r.jarak_kode
      });
    });

    res.json({success:true, data:Object.values(produkMap)});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── LAPORAN ──────────────────────────────
router.get('/laporan/penjualan', auth(), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    const dStart = dari+' 00:00:00', dEnd = sampai+' 23:59:59';
    const [summary] = await db.query(`
      SELECT COUNT(*) as total_transaksi,
             COALESCE(SUM(total),0) as total_omzet,
             COALESCE(SUM(diskon),0) as total_diskon,
             COALESCE(AVG(total),0) as rata_rata
      FROM pos_transaksi
      WHERE cabang_id=? AND created_at>=? AND created_at<=? AND status='selesai'
    `,[cabang_id,dStart,dEnd]);
    const [harian] = await db.query(`
      SELECT DATE(created_at) as tgl, COUNT(*) as trx,
             SUM(total) as omzet, SUM(diskon) as diskon,
             SUM(total-diskon) as neto
      FROM pos_transaksi
      WHERE cabang_id=? AND created_at>=? AND created_at<=? AND status='selesai'
      GROUP BY DATE(created_at) ORDER BY tgl DESC
    `,[cabang_id,dStart,dEnd]);
    res.json({success:true, data:{...summary[0], harian}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.get('/laporan/terlaris', auth(), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    const dStart = dari+' 00:00:00', dEnd = sampai+' 23:59:59';
    const [rows] = await db.query(`
      SELECT ti.nama_produk, p.kategori, SUM(ti.qty) as total_qty,
             SUM(ti.subtotal) as total_omzet
      FROM pos_transaksi_item ti
      JOIN pos_transaksi t ON t.id=ti.transaksi_id
      LEFT JOIN pos_produk p ON p.id=ti.produk_id
      WHERE t.cabang_id=? AND t.created_at>=? AND t.created_at<=? AND t.status='selesai'
      GROUP BY ti.produk_id, ti.nama_produk, p.kategori
      ORDER BY total_qty DESC LIMIT 20
    `,[cabang_id,dStart,dEnd]);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.get('/laporan/komisi', auth(), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    const dStart = dari+' 00:00:00', dEnd = sampai+' 23:59:59';
    const [rows] = await db.query(`
      SELECT ti.nama_produk, SUM(ti.qty) as total_qty,
             ti.komisi as komisi_per_item,
             SUM(ti.komisi*ti.qty) as total_komisi
      FROM pos_transaksi_item ti
      JOIN pos_transaksi t ON t.id=ti.transaksi_id
      WHERE t.cabang_id=? AND t.created_at>=? AND t.created_at<=? AND t.status='selesai' AND ti.komisi>0
      GROUP BY ti.produk_id, ti.nama_produk, ti.komisi
      ORDER BY total_komisi DESC
    `,[cabang_id,dStart,dEnd]);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos/laporan/per-kasir — omzet split per kasir/sales
router.get('/laporan/per-kasir', auth(), requireModule('lap_per_kasir'), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    if (!dari || !sampai) return res.status(400).json({success:false,message:'dari & sampai wajib.'});
    const dStart = dari+' 00:00:00', dEnd = sampai+' 23:59:59';

    let where = "t.created_at>=? AND t.created_at<=? AND t.status='selesai'";
    const params = [dStart, dEnd];
    if (cabang_id) { where += ' AND t.cabang_id=?'; params.push(cabang_id); }

    // Summary per kasir
    const [perKasir] = await db.query(`
      SELECT t.kasir_id,
             u.nama_lengkap as nama_kasir,
             u.role,
             c.nama as nama_cabang,
             c.kode as kode_cabang,
             COUNT(*) as total_transaksi,
             COALESCE(SUM(t.total),0) as total_omzet,
             COALESCE(SUM(t.diskon),0) as total_diskon,
             COALESCE(SUM(t.total - t.diskon),0) as omzet_bersih,
             COALESCE(SUM(CASE WHEN t.metode_bayar='cash' THEN t.total ELSE 0 END),0) as omzet_cash,
             COALESCE(SUM(CASE WHEN t.metode_bayar='transfer' THEN t.total ELSE 0 END),0) as omzet_transfer,
             COALESCE(SUM(CASE WHEN t.metode_bayar='qris' THEN t.total ELSE 0 END),0) as omzet_qris
      FROM pos_transaksi t
      LEFT JOIN users u ON u.id=t.kasir_id
      LEFT JOIN cabang c ON c.id=t.cabang_id
      WHERE ${where}
      GROUP BY t.kasir_id, u.nama_lengkap, u.role, c.nama, c.kode
      ORDER BY total_omzet DESC
    `, params);

    // Detail harian per kasir
    const [harianPerKasir] = await db.query(`
      SELECT t.kasir_id,
             DATE(t.created_at) as tgl,
             COUNT(*) as trx,
             COALESCE(SUM(t.total),0) as omzet,
             COALESCE(SUM(t.diskon),0) as diskon
      FROM pos_transaksi t
      WHERE ${where}
      GROUP BY t.kasir_id, DATE(t.created_at)
      ORDER BY tgl DESC
    `, params);

    // Komisi & poin per kasir
    const [komisiPerKasir] = await db.query(`
      SELECT t.kasir_id,
             COALESCE(SUM(ti.komisi * ti.qty),0) as total_komisi,
             COALESCE(SUM(ti.komisi_poin * ti.qty),0) as total_poin,
             SUM(ti.qty) as total_item
      FROM pos_transaksi t
      JOIN pos_transaksi_item ti ON ti.transaksi_id=t.id
      WHERE ${where}
      GROUP BY t.kasir_id
    `, params);

    // ── Invoice sales (diterbitkan/lunas) per sales_id ──
    let invWhere = "i.status IN ('diterbitkan','lunas') AND i.tanggal BETWEEN ? AND ?";
    const invParams = [dari, sampai];
    if (cabang_id) { invWhere += ' AND COALESCE(u2.cabang_id,3)=?'; invParams.push(cabang_id); }

    const [invoicePerSales] = await db.query(`
      SELECT i.sales_id,
             u2.nama_lengkap as nama_sales,
             u2.role as sales_role,
             COALESCE(c2.nama,'GUDANG SALES') as nama_cabang,
             COALESCE(c2.kode,'GUDANG-S') as kode_cabang,
             COUNT(*) as inv_count,
             COALESCE(SUM(i.total),0) as inv_total
      FROM invoice i
      JOIN users u2 ON u2.id = i.sales_id
      LEFT JOIN cabang c2 ON c2.id = u2.cabang_id
      WHERE ${invWhere}
      GROUP BY i.sales_id, u2.nama_lengkap, u2.role, c2.nama, c2.kode
      ORDER BY inv_total DESC
    `, invParams);

    // Gabungkan komisi ke perKasir
    const komisiMap = {};
    komisiPerKasir.forEach(k => { komisiMap[k.kasir_id] = k; });

    const harianMap = {};
    harianPerKasir.forEach(h => {
      if (!harianMap[h.kasir_id]) harianMap[h.kasir_id] = [];
      harianMap[h.kasir_id].push(h);
    });

    // Build invoice map by sales_id
    const invoiceMap = {};
    invoicePerSales.forEach(iv => { invoiceMap[iv.sales_id] = iv; });

    // Konversi semua angka dari string MySQL ke number
    const result = perKasir.map(k => ({
      kasir_id: k.kasir_id,
      nama_kasir: k.nama_kasir,
      role: k.role,
      nama_cabang: k.nama_cabang,
      kode_cabang: k.kode_cabang,
      total_transaksi: parseInt(k.total_transaksi)||0,
      total_omzet: parseInt(k.total_omzet)||0,
      total_diskon: parseInt(k.total_diskon)||0,
      omzet_bersih: parseInt(k.omzet_bersih)||0,
      omzet_cash: parseInt(k.omzet_cash)||0,
      omzet_transfer: parseInt(k.omzet_transfer)||0,
      omzet_qris: parseInt(k.omzet_qris)||0,
      omzet_invoice: parseInt(invoiceMap[k.kasir_id]?.inv_total)||0,
      inv_count: parseInt(invoiceMap[k.kasir_id]?.inv_count)||0,
      total_komisi: parseInt(komisiMap[k.kasir_id]?.total_komisi)||0,
      total_poin: parseInt(komisiMap[k.kasir_id]?.total_poin)||0,
      total_item: parseInt(komisiMap[k.kasir_id]?.total_item)||0,
      harian: (harianMap[k.kasir_id]||[]).map(h => ({
        tgl: h.tgl,
        trx: parseInt(h.trx)||0,
        omzet: parseInt(h.omzet)||0,
        diskon: parseInt(h.diskon)||0
      }))
    }));

    // Tambahkan sales yang HANYA punya invoice (tidak ada POS transaksi)
    invoicePerSales.forEach(iv => {
      if (!result.find(r => r.kasir_id === iv.sales_id)) {
        result.push({
          kasir_id: iv.sales_id,
          nama_kasir: iv.nama_sales,
          role: iv.sales_role,
          nama_cabang: iv.nama_cabang,
          kode_cabang: iv.kode_cabang,
          total_transaksi: 0,
          total_omzet: 0,
          total_diskon: 0,
          omzet_bersih: 0,
          omzet_cash: 0,
          omzet_transfer: 0,
          omzet_qris: 0,
          omzet_invoice: parseInt(iv.inv_total)||0,
          inv_count: parseInt(iv.inv_count)||0,
          total_komisi: 0,
          total_poin: 0,
          total_item: 0,
          harian: []
        });
      }
    });

    // Re-sort by total combined omzet (POS + invoice)
    result.sort((a,b) => (b.total_omzet + b.omzet_invoice) - (a.total_omzet + a.omzet_invoice));

    // Grand total
    const grandTotal = {
      total_transaksi: result.reduce((s,k) => s + k.total_transaksi, 0),
      total_omzet: result.reduce((s,k) => s + k.total_omzet, 0),
      total_diskon: result.reduce((s,k) => s + k.total_diskon, 0),
      omzet_bersih: result.reduce((s,k) => s + k.omzet_bersih, 0),
      omzet_cash: result.reduce((s,k) => s + k.omzet_cash, 0),
      omzet_transfer: result.reduce((s,k) => s + k.omzet_transfer, 0),
      omzet_qris: result.reduce((s,k) => s + k.omzet_qris, 0),
      omzet_invoice: result.reduce((s,k) => s + k.omzet_invoice, 0),
      total_komisi: result.reduce((s,k) => s + k.total_komisi, 0),
      total_poin: result.reduce((s,k) => s + k.total_poin, 0),
      total_kasir: result.length
    };

    res.json({success:true, data: result, grand_total: grandTotal});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

router.get('/laporan/labarugi', auth(), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    const dStart = dari+' 00:00:00', dEnd = sampai+' 23:59:59';
    const [[data]] = await db.query(`
      SELECT COALESCE(SUM(t.total),0) as total_omzet,
             COALESCE(SUM(t.diskon),0) as total_diskon,
             COALESCE(SUM(ti.harga_modal*ti.qty),0) as total_modal
      FROM pos_transaksi t
      JOIN pos_transaksi_item ti ON ti.transaksi_id=t.id
      WHERE t.cabang_id=? AND t.created_at>=? AND t.created_at<=? AND t.status='selesai'
    `,[cabang_id,dStart,dEnd]);
    res.json({success:true, data});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET log barang
router.get('/stok/log', auth(), async (req, res) => {
  try {
    const { cabang_id, produk_id, tipe, dari, sampai } = req.query;
    let q = `
      SELECT l.*, p.nama as nama_produk, p.sku,
             c.nama as nama_cabang,
             u.nama_lengkap as nama_user
      FROM pos_stok_log l
      LEFT JOIN pos_produk p ON p.id = l.produk_id
      LEFT JOIN cabang c ON c.id = l.cabang_id
      LEFT JOIN users u ON u.id = l.user_id
      WHERE 1=1`;
    const params = [];
    if (produk_id) { q += ' AND l.produk_id=?'; params.push(produk_id); }
    if (cabang_id) { q += ' AND l.cabang_id=?'; params.push(cabang_id); }
    if (tipe)      { q += ' AND l.tipe=?';      params.push(tipe); }
    if (dari)      { q += ' AND l.created_at>=?'; params.push(dari+' 00:00:00'); }
    if (sampai)    { q += ' AND l.created_at<=?'; params.push(sampai+' 23:59:59'); }
    q += ' ORDER BY l.created_at DESC LIMIT 1000';
    const [rows] = await db.query(q, params);
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── EXPORT PRODUK PER CABANG ──────────────────────────────
router.get('/produk/export-cabang', auth(['owner']), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    const [[cab]] = await db.query('SELECT id,nama,kode FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(404).json({success:false,message:'Cabang tidak ditemukan.'});

    const [produk] = await db.query(`
      SELECT p.*, COALESCE(s.qty,0) as stok
      FROM pos_produk p
      LEFT JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=?
      WHERE p.aktif=1
      ORDER BY p.kategori, p.nama`, [cabang_id]);

    const rows = produk.map(p => ({
      SKU: p.sku, Nama: p.nama, Kategori: p.kategori||'',
      'Harga Jual': p.harga_jual, 'Harga Modal': p.harga_modal,
      Satuan: p.satuan||'pcs', Komisi: p.komisi||0, Poin: p.komisi_poin||0,
      Stok: p.stok
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{wch:15},{wch:40},{wch:15},{wch:12},{wch:12},{wch:8},{wch:8},{wch:6},{wch:10}];
    XLSX.utils.book_append_sheet(wb, ws, 'Produk - '+cab.nama);
    addInfoSheet(wb, cab.nama + ' (' + (cab.kode||'') + ')');
    await addKategoriSheet(wb);
    const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Disposition',`attachment; filename=produk_${cab.kode||cab.nama}.xlsx`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── IMPORT PRODUK PER CABANG ──────────────────────────────
router.post('/produk/import-cabang', auth(['owner']), upload2.single('file'), async (req, res) => {
  try {
    const cabang_id = req.body.cabang_id;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});
    const wb = XLSX.read(req.file.buffer||fs.readFileSync(req.file.path), {type:'buffer'});
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(ws, {header:1});
    if (req.file.path) fs.unlink(req.file.path, ()=>{});
    if (rawRows.length < 2) return res.status(400).json({success:false,message:'File kosong.'});

    const header = rawRows[0].map(h => String(h||'').trim());
    const colIdx = {};
    header.forEach((h, i) => {
      const hl = h.toLowerCase();
      if (hl==='sku')            colIdx.sku = i;
      else if (hl==='nama')      colIdx.nama = i;
      else if (hl==='kategori')  colIdx.kategori = i;
      else if (hl==='harga jual')colIdx.harga_jual = i;
      else if (hl==='harga modal')colIdx.harga_modal = i;
      else if (hl==='satuan')    colIdx.satuan = i;
      else if (hl==='komisi')    colIdx.komisi = i;
      else if (hl==='poin'||hl==='komisi poin') colIdx.poin = i;
      else if (hl==='stok')      colIdx.stok = i;
    });

    // Ambil kategori yang sudah ada di DB untuk normalisasi case
    const [existingKats] = await db.query("SELECT DISTINCT kategori FROM pos_produk WHERE kategori IS NOT NULL AND kategori != ''");
    const katMap = {};
    existingKats.forEach(r => { katMap[r.kategori.toLowerCase()] = r.kategori; });

    let inserted=0, updated=0, skipped=0, stokUpdated=0;
    for (let i=1; i<rawRows.length; i++) {
      const r = rawRows[i];
      if (!r) continue;
      const sku  = String(r[colIdx.sku!=null?colIdx.sku:0]||'').trim();
      const nama = String(r[colIdx.nama!=null?colIdx.nama:1]||'').trim();
      const katRaw     = String(r[colIdx.kategori!=null?colIdx.kategori:2]||'').trim()||null;
      const kategori   = katRaw ? (katMap[katRaw.toLowerCase()] || katRaw) : null;
      const harga_jual = parseInt(r[colIdx.harga_jual!=null?colIdx.harga_jual:3])||0;
      const harga_modal= parseInt(r[colIdx.harga_modal!=null?colIdx.harga_modal:4])||0;
      const satuan     = String(r[colIdx.satuan!=null?colIdx.satuan:5]||'pcs').trim();
      const komisi     = parseInt(r[colIdx.komisi!=null?colIdx.komisi:6])||0;
      const poin       = colIdx.poin!=null ? (parseInt(r[colIdx.poin])||0) : 0;
      const stok       = parseInt(r[colIdx.stok!=null?colIdx.stok:colIdx.poin!=null?8:7])||0;
      if (!sku||!nama) { skipped++; continue; }
      // Simpan kategori baru ke map supaya row berikutnya konsisten
      if (kategori && !katMap[kategori.toLowerCase()]) katMap[kategori.toLowerCase()] = kategori;
      try {
        const [[ex]] = await db.query('SELECT id FROM pos_produk WHERE sku=?',[sku]);
        let produkId;
        if (ex) {
          await db.query('UPDATE pos_produk SET nama=?,kategori=?,harga_jual=?,harga_modal=?,satuan=?,komisi=?,komisi_poin=? WHERE id=?',
            [nama,kategori,harga_jual,harga_modal,satuan,komisi,poin,ex.id]);
          produkId=ex.id; updated++;
        } else {
          const [ins] = await db.query('INSERT INTO pos_produk (sku,nama,kategori,harga_jual,harga_modal,satuan,komisi,komisi_poin,aktif) VALUES (?,?,?,?,?,?,?,?,1)',
            [sku,nama,kategori,harga_jual,harga_modal,satuan,komisi,poin]);
          produkId=ins.insertId; inserted++;
        }
        if (stok >= 0) {
          await db.query('INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=VALUES(qty)',
            [produkId, cabang_id, stok]);
          stokUpdated++;
        }
      } catch(e) { skipped++; }
    }
    res.json({success:true, message:`Import selesai: ${inserted} baru, ${updated} diupdate, ${stokUpdated} stok diupdate, ${skipped} dilewati.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── PINDAH CABANG (BULK TRANSFER) ──────────────────────────────
router.post('/stok/pindah-cabang', auth(['owner']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { dari_cabang_id, ke_cabang_id, produk_ids } = req.body;
    if (!dari_cabang_id||!ke_cabang_id||!produk_ids?.length)
      return res.status(400).json({success:false,message:'Cabang asal, tujuan, dan produk wajib.'});
    if (dari_cabang_id==ke_cabang_id)
      return res.status(400).json({success:false,message:'Cabang asal dan tujuan tidak boleh sama.'});

    const [[dariCab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [dari_cabang_id]);
    const [[keCab]]   = await conn.query('SELECT nama FROM cabang WHERE id=?', [ke_cabang_id]);
    const dariNama = dariCab?.nama || ('Cabang #'+dari_cabang_id);
    const keNama   = keCab?.nama   || ('Cabang #'+ke_cabang_id);

    let moved = 0;
    for (const pid of produk_ids) {
      const [[stok]] = await conn.query('SELECT qty FROM pos_stok WHERE produk_id=? AND cabang_id=?', [pid, dari_cabang_id]);
      const qty = stok?.qty || 0;
      if (qty <= 0) continue;

      // Kurangi stok asal (ke 0)
      await conn.query('UPDATE pos_stok SET qty=0 WHERE produk_id=? AND cabang_id=?', [pid, dari_cabang_id]);
      // Tambah stok tujuan
      await conn.query('INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=qty+?',
        [pid, ke_cabang_id, qty, qty]);
      // Log
      await conn.query('INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,?,?,?,?)',
        [pid, dari_cabang_id, 'transfer_keluar', qty, 'Pindah cabang ke '+keNama, req.user.id]).catch(()=>{});
      await conn.query('INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,?,?,?,?)',
        [pid, ke_cabang_id, 'transfer_masuk', qty, 'Pindah cabang dari '+dariNama, req.user.id]).catch(()=>{});
      moved++;
    }

    await conn.commit();
    res.json({success:true, message:`${moved} produk dipindahkan dari ${dariNama} ke ${keNama}.`});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// ── PERSEDIAAN / MODAL ──────────────────────────────
router.get('/persediaan', auth(), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});

    // Total persediaan cabang
    const [[totals]] = await db.query(`
      SELECT COUNT(DISTINCT p.id) as total_produk,
             COALESCE(SUM(s.qty),0) as total_stok,
             COALESCE(SUM(s.qty * p.harga_modal),0) as total_modal,
             COALESCE(SUM(s.qty * p.harga_jual),0) as total_nilai_jual
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1`, [cabang_id]);

    // Per kategori
    const [perKategori] = await db.query(`
      SELECT COALESCE(p.kategori,'Tanpa Kategori') as kategori,
             COUNT(DISTINCT p.id) as jumlah_produk,
             SUM(s.qty) as total_stok,
             SUM(s.qty * p.harga_modal) as total_modal,
             SUM(s.qty * p.harga_jual) as total_nilai_jual
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1
      GROUP BY p.kategori
      ORDER BY total_modal DESC`, [cabang_id]);

    // Per barang (yang ada stok)
    const [perBarang] = await db.query(`
      SELECT p.sku, p.nama, COALESCE(p.kategori,'Tanpa Kategori') as kategori,
             s.qty as stok, p.harga_modal, p.harga_jual,
             (s.qty * p.harga_modal) as modal,
             (s.qty * p.harga_jual) as nilai_jual
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1
      ORDER BY modal DESC`, [cabang_id]);

    res.json({success:true, data:{totals, perKategori, perBarang}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos/persediaan/export
router.get('/persediaan/export', auth(), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    const [[cab]] = await db.query('SELECT id,nama,kode FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(404).json({success:false,message:'Cabang tidak ditemukan.'});

    const [[totals]] = await db.query(`
      SELECT COUNT(DISTINCT p.id) as total_produk, COALESCE(SUM(s.qty),0) as total_stok,
             COALESCE(SUM(s.qty * p.harga_modal),0) as total_modal,
             COALESCE(SUM(s.qty * p.harga_jual),0) as total_nilai_jual
      FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1`, [cabang_id]);

    const [perKategori] = await db.query(`
      SELECT COALESCE(p.kategori,'Tanpa Kategori') as kategori, COUNT(DISTINCT p.id) as jumlah_produk,
             SUM(s.qty) as total_stok, SUM(s.qty * p.harga_modal) as total_modal, SUM(s.qty * p.harga_jual) as total_nilai_jual
      FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1 GROUP BY p.kategori ORDER BY total_modal DESC`, [cabang_id]);

    const [perBarang] = await db.query(`
      SELECT p.sku, p.nama, COALESCE(p.kategori,'Tanpa Kategori') as kategori,
             s.qty as stok, p.harga_modal, p.harga_jual,
             (s.qty * p.harga_modal) as modal, (s.qty * p.harga_jual) as nilai_jual
      FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1 ORDER BY modal DESC`, [cabang_id]);

    const potensiLaba = totals.total_nilai_jual - totals.total_modal;
    const rows = [
      [`Laporan Persediaan — Raja Vapor ${cab.nama}`],
      [`Tanggal: ${new Date().toLocaleDateString('id-ID',{timeZone:'Asia/Jakarta'})}`],
      [],
      ['Total Modal', totals.total_modal],
      ['Total Nilai Jual', totals.total_nilai_jual],
      ['Potensi Laba', potensiLaba],
      ['Total Produk', totals.total_produk],
      ['Total Item Stok', totals.total_stok],
      [],
      ['MODAL PER KATEGORI'],
      ['Kategori','Jumlah Produk','Total Stok','Total Modal','Total Nilai Jual'],
      ...perKategori.map(k => [k.kategori, k.jumlah_produk, k.total_stok, k.total_modal, k.total_nilai_jual]),
      [],
      ['DETAIL PER BARANG'],
      ['SKU','Nama','Kategori','Stok','Harga Modal','Harga Jual','Total Modal','Total Nilai Jual'],
      ...perBarang.map(b => [b.sku, b.nama, b.kategori, b.stok, b.harga_modal, b.harga_jual, b.modal, b.nilai_jual])
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:20},{wch:40},{wch:15},{wch:10},{wch:15},{wch:15},{wch:15},{wch:15}];
    ws['!merges'] = [{s:{r:0,c:0},e:{r:0,c:7}}];
    XLSX.utils.book_append_sheet(wb, ws, 'Persediaan - '+cab.nama);
    const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Disposition',`attachment; filename=persediaan_${cab.kode||cab.nama}.xlsx`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── STOCK OPNAME ──────────────────────────────
// Helper: buat signature sederhana untuk validasi file opname
function opnameSignature(cabangId, cabangNama, totalProduk) {
  const raw = `SO|${cabangId}|${cabangNama}|${totalProduk}|rajavapor`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0; }
  return 'SO' + Math.abs(hash).toString(36).toUpperCase();
}

// GET /api/pos/stock-opname/download?cabang_id=
router.get('/stock-opname/download', auth(['owner','admin_pusat','head_operational','manajer']), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    const [[cab]] = await db.query('SELECT id,nama,kode FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(404).json({success:false,message:'Cabang tidak ditemukan.'});

    const [produk] = await db.query(`
      SELECT p.sku, p.nama, p.kategori
      FROM pos_produk p
      LEFT JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=?
      WHERE p.aktif=1 AND COALESCE(s.qty,0) >= 0
      ORDER BY p.kategori, p.nama`, [cabang_id]);

    const tglExport = new Date().toLocaleString('id-ID', {timeZone:'Asia/Jakarta'});
    const sign = opnameSignature(cab.id, cab.nama, produk.length);

    // Sheet utama: judul cabang di baris 1-3, header di baris 4, data mulai baris 5
    const titleRows = [
      [`STOCK OPNAME — Raja Vapor ${cab.nama}`, '', '', ''],
      [`Tanggal cetak: ${tglExport}  |  Total produk: ${produk.length}  |  Kode: ${cab.kode||'-'}`, '', '', ''],
      ['', '', '', ''],
      ['SKU', 'Nama Barang', 'Kategori', 'Stok Fisik']
    ];
    const dataRows = produk.map(p => [p.sku, p.nama, p.kategori || '', '']);
    const ws = XLSX.utils.aoa_to_sheet([...titleRows, ...dataRows]);
    ws['!cols'] = [{wch:15},{wch:45},{wch:15},{wch:14}];
    // Merge title row
    ws['!merges'] = [
      {s:{r:0,c:0},e:{r:0,c:3}},
      {s:{r:1,c:0},e:{r:1,c:3}}
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Opname');

    // Sheet validasi (tersembunyi — jangan diubah user)
    const vs = XLSX.utils.aoa_to_sheet([
      ['JANGAN HAPUS/UBAH SHEET INI — digunakan untuk validasi'],
      ['cabang_id', String(cab.id)],
      ['cabang_nama', cab.nama],
      ['cabang_kode', cab.kode || ''],
      ['tanggal', new Date().toISOString()],
      ['total_produk', produk.length],
      ['signature', sign]
    ]);
    vs['!cols'] = [{wch:20},{wch:40}];
    XLSX.utils.book_append_sheet(wb, vs, '_validasi');

    const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
    res.setHeader('Content-Disposition',`attachment; filename=stock_opname_${cab.kode||cab.nama}.xlsx`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos/stock-opname/upload
router.post('/stock-opname/upload', auth(['owner','admin_pusat','head_operational','manajer']), upload2.single('file'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const cabang_id = parseInt(req.body.cabang_id);
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});

    const [[cab]] = await conn.query('SELECT id,nama,kode FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(400).json({success:false,message:'Cabang tidak ditemukan.'});

    const wb = XLSX.read(req.file.buffer || fs.readFileSync(req.file.path), {type:'buffer'});
    if (req.file.path) fs.unlink(req.file.path, ()=>{});

    // ── PROTEKSI 1: Cek sheet _validasi ada ──
    const vsSheet = wb.Sheets['_validasi'];
    if (!vsSheet) {
      return res.status(400).json({success:false,
        message:'File tidak valid — sheet _validasi tidak ditemukan. Gunakan file yang didownload dari sistem, jangan buat manual.'});
    }
    const vsRows = XLSX.utils.sheet_to_json(vsSheet, {header:1});
    const vsMap = {};
    vsRows.forEach(r => { if (r[0] && r[1] !== undefined) vsMap[String(r[0]).trim()] = String(r[1]).trim(); });

    // ── PROTEKSI 2: Cek cabang_id cocok ──
    const fileCabangId = parseInt(vsMap['cabang_id']) || 0;
    const fileCabangNama = vsMap['cabang_nama'] || '';
    if (fileCabangId !== cabang_id) {
      return res.status(400).json({success:false,
        message:`File ini untuk cabang "${fileCabangNama}" (ID:${fileCabangId}), tapi Anda memilih "${cab.nama}" (ID:${cabang_id}). Pastikan cabang yang dipilih sesuai dengan file yang diupload.`});
    }

    // ── PROTEKSI 3: Cek signature (file tidak dimanipulasi) ──
    const fileTotalProduk = parseInt(vsMap['total_produk']) || 0;
    const fileSignature = vsMap['signature'] || '';
    const expectedSign = opnameSignature(fileCabangId, fileCabangNama, fileTotalProduk);
    if (fileSignature !== expectedSign) {
      return res.status(400).json({success:false,
        message:'File rusak atau sudah dimanipulasi — signature tidak cocok. Download ulang form opname dari sistem.'});
    }

    // ── PROTEKSI 4: Cek judul sheet utama cocok dengan cabang ──
    const mainSheet = wb.Sheets[wb.SheetNames[0]];
    const mainRows = XLSX.utils.sheet_to_json(mainSheet, {header:1});
    if (mainRows.length < 4) return res.status(400).json({success:false,message:'File kosong atau format tidak sesuai.'});

    const titleRow = String(mainRows[0][0] || '').toUpperCase();
    const cabNamaUpper = cab.nama.toUpperCase();
    if (!titleRow.includes(cabNamaUpper)) {
      return res.status(400).json({success:false,
        message:`Judul file "${mainRows[0][0]}" tidak mengandung nama cabang "${cab.nama}". File ini bukan untuk cabang yang dipilih.`});
    }

    // ── PROTEKSI 5: Cek file tidak terlalu lama (max 7 hari) ──
    const fileTanggal = vsMap['tanggal'] ? new Date(vsMap['tanggal']) : null;
    if (fileTanggal) {
      const diffDays = (Date.now() - fileTanggal.getTime()) / (1000*60*60*24);
      if (diffDays > 7) {
        return res.status(400).json({success:false,
          message:`File ini digenerate ${Math.floor(diffDays)} hari lalu. Maksimal 7 hari. Download form opname baru untuk data produk terkini.`});
      }
    }

    // ── PROTEKSI 6: Cari header data (baris yang mengandung SKU) ──
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(mainRows.length, 10); i++) {
      const cells = (mainRows[i]||[]).map(c => String(c||'').trim().toLowerCase());
      if (cells.includes('sku') && (cells.includes('stok fisik') || cells.includes('stok opname') || cells.includes('stok'))) {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx < 0) {
      return res.status(400).json({success:false,message:'Header kolom (SKU, Stok Fisik) tidak ditemukan. Jangan ubah struktur header di Excel.'});
    }

    const header = mainRows[headerRowIdx].map(h => String(h||'').trim().toLowerCase());
    const skuIdx  = header.indexOf('sku');
    const stokIdx = header.findIndex(h => h === 'stok fisik' || h === 'stok opname' || h === 'stok');

    // ── PROTEKSI 7: Cek duplikat SKU dalam file ──
    const skuSeen = new Set();
    const dupSkus = [];
    for (let i = headerRowIdx + 1; i < mainRows.length; i++) {
      const r = mainRows[i];
      if (!r) continue;
      const sku = String(r[skuIdx]||'').trim();
      if (!sku) continue;
      if (skuSeen.has(sku)) dupSkus.push(sku);
      skuSeen.add(sku);
    }
    if (dupSkus.length) {
      return res.status(400).json({success:false,
        message:`Ditemukan SKU duplikat di file: ${dupSkus.slice(0,5).join(', ')}${dupSkus.length>5?'...(+'+(dupSkus.length-5)+' lagi)':''}. Pastikan setiap SKU hanya muncul satu kali.`});
    }

    // ── PROTEKSI 8: Cek jumlah produk masih konsisten ──
    const dataRowCount = mainRows.length - headerRowIdx - 1;
    if (fileTotalProduk > 0 && Math.abs(dataRowCount - fileTotalProduk) > fileTotalProduk * 0.1) {
      return res.status(400).json({success:false,
        message:`Jumlah baris data (${dataRowCount}) berbeda signifikan dari form asli (${fileTotalProduk} produk). Jangan menambah/menghapus baris produk — hanya isi kolom Stok Fisik.`});
    }

    // ── Proses opname ──
    let updated=0, skipped=0, plus=0, minus=0;
    const details = [];
    const errors = [];

    for (let i = headerRowIdx + 1; i < mainRows.length; i++) {
      const r = mainRows[i];
      if (!r) continue;
      const sku = String(r[skuIdx]||'').trim();
      const stokFisikRaw = r[stokIdx];
      const rowNum = i + 1;

      // Baris belum diisi → skip
      if (!sku || stokFisikRaw === '' || stokFisikRaw === null || stokFisikRaw === undefined) { skipped++; continue; }

      const stokFisik = parseInt(stokFisikRaw);

      // PROTEKSI 9: Validasi angka stok
      if (isNaN(stokFisik)) {
        errors.push(`Baris ${rowNum} (${sku}): "${stokFisikRaw}" bukan angka valid.`);
        continue;
      }
      if (stokFisik < 0) {
        errors.push(`Baris ${rowNum} (${sku}): stok negatif (${stokFisik}) tidak diperbolehkan.`);
        continue;
      }
      if (stokFisik > 99999) {
        errors.push(`Baris ${rowNum} (${sku}): stok ${stokFisik} terlalu besar (maks 99999).`);
        continue;
      }

      // Cari produk
      const [[produk]] = await conn.query('SELECT id,nama FROM pos_produk WHERE sku=?', [sku]);
      if (!produk) {
        errors.push(`Baris ${rowNum}: SKU "${sku}" tidak ditemukan di database.`);
        continue;
      }

      // Ambil stok saat ini di cabang
      const [[stokRow]] = await conn.query('SELECT qty FROM pos_stok WHERE produk_id=? AND cabang_id=?', [produk.id, cabang_id]);
      const stokDB = stokRow ? stokRow.qty : 0;
      const selisih = stokFisik - stokDB;

      if (selisih === 0) { skipped++; continue; }

      // Update stok
      await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE qty=VALUES(qty)`, [produk.id, cabang_id, stokFisik]);

      // Log
      const tipe = selisih > 0 ? 'opname_plus' : 'opname_minus';
      await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id)
        VALUES (?,?,?,?,?,?)`,
        [produk.id, cabang_id, tipe, Math.abs(selisih),
         `Stock Opname: sistem ${stokDB} → fisik ${stokFisik} (${selisih>0?'+':''}${selisih})`,
         req.user.id]);

      if (selisih > 0) plus++; else minus++;
      updated++;
      details.push({sku, nama:produk.nama, stok_sistem:stokDB, stok_fisik:stokFisik, selisih});
    }

    // PROTEKSI 10: Jika ada error validasi tapi belum ada update, rollback
    if (errors.length && updated === 0) {
      await conn.rollback();
      return res.status(400).json({success:false,
        message:`Tidak ada data yang bisa diproses. Ditemukan ${errors.length} error:\n${errors.slice(0,10).join('\n')}`,
        data: { errors }});
    }

    await conn.commit();
    let msg = `Stock opname ${cab.nama} selesai: ${updated} produk diupdate (${plus} plus, ${minus} minus), ${skipped} dilewati.`;
    if (errors.length) msg += ` ${errors.length} baris bermasalah.`;
    res.json({
      success:true, message:msg,
      data: { updated, skipped, plus, minus, details, errors }
    });
  } catch(e) { await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// ── BARCODE ──────────────────────────────
// GET /api/pos/barcode/:barcode — cari produk by barcode
router.get('/barcode/:barcode', auth(), async (req, res) => {
  try {
    const [[p]] = await db.query(
      `SELECT p.*, COALESCE(s.qty,0) as stok FROM pos_produk p
       LEFT JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=?
       WHERE p.barcode=?`, [req.query.cabang_id||0, req.params.barcode]);
    if (!p) return res.status(404).json({success:false, message:'Produk dengan barcode ini tidak ditemukan.'});
    res.json({success:true, data:p});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// PUT /api/pos/produk/:id/barcode — assign/update/clear barcode
router.put('/produk/:id/barcode', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { barcode } = req.body;
    // Allow clearing barcode
    if (barcode === '' || barcode === null) {
      await db.query('UPDATE pos_produk SET barcode=NULL WHERE id=?', [req.params.id]);
      return res.json({success:true, message:'Barcode berhasil dihapus.'});
    }
    if (!barcode) return res.status(400).json({success:false, message:'Barcode wajib diisi.'});
    // Cek duplikat
    const [[dup]] = await db.query('SELECT id,nama FROM pos_produk WHERE barcode=? AND id!=?', [barcode, req.params.id]);
    if (dup) return res.status(400).json({success:false, message:`Barcode sudah dipakai oleh "${dup.nama}".`});
    await db.query('UPDATE pos_produk SET barcode=? WHERE id=?', [barcode, req.params.id]);
    res.json({success:true, message:'Barcode berhasil disimpan.'});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// ── MANAGEMENT POIN ──
// GET /api/pos/poin-management — list semua produk aktif dengan komisi_poin
router.get('/poin-management', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, sku, nama, kategori, komisi_poin, komisi, harga_jual
       FROM pos_produk WHERE aktif=1 ORDER BY nama`);
    const totalPoin = rows.filter(r => r.komisi_poin > 0).length;
    res.json({ success:true, data:rows, total:rows.length, total_poin:totalPoin });
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// PATCH /api/pos/poin-management — bulk set komisi_poin
router.patch('/poin-management', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { items } = req.body; // [{id, poin}]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({success:false, message:'Data kosong.'});
    let updated = 0;
    for (const it of items) {
      const poin = Math.max(0, parseInt(it.poin) || 0);
      await db.query('UPDATE pos_produk SET komisi_poin=? WHERE id=?', [poin, it.id]);
      updated++;
    }
    res.json({ success:true, message:`${updated} produk diupdate.`, updated });
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// DELETE /api/pos/poin-management/:id — reset poin ke 0
router.delete('/poin-management/:id', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    await db.query('UPDATE pos_produk SET komisi_poin=0 WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Poin direset ke 0.' });
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// Helper: generate slug barcode dari nama produk
// Target: 8-12 karakter, mudah discan pada label 40x30mm
// "LUNAR HEXOHM 80W SILVER" → "LNRHXH80W"
function _slugBarcode(nama) {
  let s = (nama||'').toUpperCase()
    .replace(/\b(THE|AND|FOR|WITH|DARI|DAN|UNTUK|BY|EDITION|SERIES|VERSION|AUTHENTIC|ORIGINAL|NEW|MG|OHM)\b/gi, '')
    .replace(/[^A-Z0-9\s]/g, '')
    .trim();
  const words = s.split(/\s+/).filter(w => w);
  if (!words.length) return null;
  // Ambil max 4 kata paling penting (skip ukuran/volume di tengah)
  const important = [];
  const numbers = [];
  for (const w of words) {
    if (/^\d+\w*$/.test(w)) { numbers.push(w.slice(0,4)); continue; }
    if (important.length < 3) important.push(w);
  }
  // Tiap kata: ambil 3 konsonan pertama (atau 3 huruf pertama jika vokal semua)
  const parts = important.map(w => {
    if (w.length <= 2) return w;
    const c = w.replace(/[AEIOU]/g, '');
    return (c.length >= 2 ? c : w).slice(0, 3);
  });
  // Tambah 1 angka paling relevan (ukuran/volume)
  if (numbers.length) parts.push(numbers[0]);
  return parts.join('').slice(0, 10);
}

// Generate unique barcode — tambah suffix angka jika duplikat
async function _uniqueBarcode(db, slug) {
  let candidate = slug;
  let suffix = 0;
  while (true) {
    const [[dup]] = await db.query('SELECT id FROM pos_produk WHERE barcode=?', [candidate]);
    if (!dup) return candidate;
    suffix++;
    candidate = slug.slice(0, 8) + String(suffix).padStart(2, '0');
  }
}

// GET /api/pos/produk/:id/generate-barcode — generate barcode dari slug nama produk
router.get('/produk/:id/generate-barcode', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const [[p]] = await db.query('SELECT id,nama,barcode FROM pos_produk WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({success:false, message:'Produk tidak ditemukan.'});
    if (p.barcode) return res.json({success:true, barcode:p.barcode, message:'Sudah punya barcode.'});
    const slug = _slugBarcode(p.nama);
    if (!slug) return res.status(400).json({success:false, message:'Nama produk tidak valid untuk barcode.'});
    const barcode = await _uniqueBarcode(db, slug);
    await db.query('UPDATE pos_produk SET barcode=? WHERE id=?', [barcode, p.id]);
    res.json({success:true, barcode, message:'Barcode berhasil digenerate.'});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// POST /api/pos/barcode/generate-all — generate barcode untuk semua produk tanpa barcode
router.post('/barcode/generate-all', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id,nama FROM pos_produk WHERE (barcode IS NULL OR barcode="") AND aktif=1 ORDER BY id');
    let count = 0;
    for (const r of rows) {
      const slug = _slugBarcode(r.nama);
      if (!slug) continue;
      const barcode = await _uniqueBarcode(db, slug);
      await db.query('UPDATE pos_produk SET barcode=? WHERE id=?', [barcode, r.id]);
      count++;
    }
    res.json({success:true, message:`${count} produk diberi barcode otomatis.`, count});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// ── STOCK OPNAME SESI (SCAN-BASED) ──────────────────────────────
// POST /api/pos/opname — buat sesi opname baru
router.post('/opname', auth(['owner','admin_pusat','head_operational','manajer','kepala_cabang','spv_area']), async (req, res) => {
  try {
    const { cabang_id, catatan } = req.body;
    if (!cabang_id) return res.status(400).json({success:false, message:'cabang_id wajib.'});
    // Cek ada sesi draft/proses yang belum selesai
    const [[aktif]] = await db.query(
      `SELECT id,kode_opname FROM stock_opname_sesi WHERE cabang_id=? AND status IN ('draft','proses')`, [cabang_id]);
    if (aktif) return res.status(400).json({success:false, message:`Masih ada sesi opname aktif (${aktif.kode_opname}). Selesaikan atau batalkan dulu.`});
    const kode = 'SO-' + Date.now();
    const tanggal = new Date().toISOString().slice(0,10);
    const [result] = await db.query(
      `INSERT INTO stock_opname_sesi (kode_opname,cabang_id,tanggal,status,catatan,user_id) VALUES (?,?,?,'proses',?,?)`,
      [kode, cabang_id, tanggal, catatan||'', req.user.id]);
    // Auto-populate produk yang punya stok di cabang ini (qty > 0)
    const [produk] = await db.query(
      `SELECT p.id, p.barcode, p.nama, s.qty as stok
       FROM pos_produk p
       JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=?
       WHERE p.aktif=1 AND s.qty > 0`, [cabang_id]);
    for (const p of produk) {
      await db.query(
        `INSERT INTO stock_opname_item (opname_id,produk_id,barcode,nama_produk,stok_sistem,stok_fisik) VALUES (?,?,?,?,?,0)`,
        [result.insertId, p.id, p.barcode||null, p.nama, p.stok]);
    }
    audit(req, 'create', 'opname', result.insertId, kode, {cabang_id, produk_count:produk.length});
    res.json({success:true, message:`Sesi opname ${kode} dibuat dengan ${produk.length} produk.`, id:result.insertId, kode});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// GET /api/pos/opname — list semua sesi
router.get('/opname', auth(), async (req, res) => {
  try {
    const q = req.query.cabang_id ? 'AND s.cabang_id=?' : '';
    const params = req.query.cabang_id ? [req.query.cabang_id] : [];
    const [rows] = await db.query(
      `SELECT s.*, c.nama as nama_cabang, u.nama_lengkap as nama_user,
              (SELECT COUNT(*) FROM stock_opname_item WHERE opname_id=s.id) as total_item,
              (SELECT COUNT(*) FROM stock_opname_item WHERE opname_id=s.id AND scanned_at IS NOT NULL) as total_scan,
              (SELECT COALESCE(SUM(stok_sistem),0) FROM stock_opname_item WHERE opname_id=s.id) as total_qty_sistem,
              (SELECT COALESCE(SUM(stok_fisik),0) FROM stock_opname_item WHERE opname_id=s.id AND scanned_at IS NOT NULL) as total_qty_fisik
       FROM stock_opname_sesi s
       LEFT JOIN cabang c ON s.cabang_id=c.id
       LEFT JOIN users u ON s.user_id=u.id
       WHERE 1=1 ${q} ORDER BY s.created_at DESC LIMIT 50`, params);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// GET /api/pos/opname/:id — detail sesi + items
router.get('/opname/:id', auth(), async (req, res) => {
  try {
    const [[sesi]] = await db.query(
      `SELECT s.*, c.nama as nama_cabang, u.nama_lengkap as nama_user
       FROM stock_opname_sesi s LEFT JOIN cabang c ON s.cabang_id=c.id LEFT JOIN users u ON s.user_id=u.id
       WHERE s.id=?`, [req.params.id]);
    if (!sesi) return res.status(404).json({success:false, message:'Sesi opname tidak ditemukan.'});
    const [items] = await db.query(
      `SELECT * FROM stock_opname_item WHERE opname_id=? ORDER BY scanned_at IS NULL, nama_produk`, [req.params.id]);
    sesi.items = items;
    res.json({success:true, data:sesi});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// POST /api/pos/opname/:id/scan — scan barcode, input stok fisik
// LIVE OPNAME: catat stok DB realtime saat scan (bukan snapshot awal)
router.post('/opname/:id/scan', auth(), async (req, res) => {
  try {
    const { barcode, produk_id, stok_fisik, keterangan } = req.body;
    const [[sesi]] = await db.query('SELECT * FROM stock_opname_sesi WHERE id=? AND status="proses"', [req.params.id]);
    if (!sesi) return res.status(400).json({success:false, message:'Sesi opname tidak aktif.'});

    // Cari produk by barcode atau produk_id
    let produk;
    if (barcode) {
      const [[p]] = await db.query('SELECT id,nama,barcode FROM pos_produk WHERE barcode=?', [barcode]);
      if (!p) return res.status(404).json({success:false, message:`Barcode "${barcode}" tidak ditemukan.`});
      produk = p;
    } else if (produk_id) {
      const [[p]] = await db.query('SELECT id,nama,barcode FROM pos_produk WHERE id=?', [produk_id]);
      if (!p) return res.status(404).json({success:false, message:'Produk tidak ditemukan.'});
      produk = p;
    } else {
      return res.status(400).json({success:false, message:'Barcode atau produk_id wajib diisi.'});
    }

    // Ambil stok DB SAAT INI (realtime, bukan snapshot awal)
    const [[stokNow]] = await db.query('SELECT qty FROM pos_stok WHERE produk_id=? AND cabang_id=?', [produk.id, sesi.cabang_id]);
    const stokRealtime = stokNow?.qty || 0;

    // Cek item sudah ada di sesi ini
    const [[existing]] = await db.query(
      'SELECT id FROM stock_opname_item WHERE opname_id=? AND produk_id=?', [req.params.id, produk.id]);

    const fisik = parseInt(stok_fisik)||0;
    if (existing) {
      // Update: refresh stok_saat_scan ke realtime DB
      await db.query(
        `UPDATE stock_opname_item SET stok_fisik=?, stok_saat_scan=?, keterangan=?, scanned_at=NOW() WHERE id=?`,
        [fisik, stokRealtime, keterangan||null, existing.id]);
    } else {
      // Auto-tambah (produk baru yang belum di-populate)
      await db.query(
        `INSERT INTO stock_opname_item (opname_id,produk_id,barcode,nama_produk,stok_sistem,stok_fisik,stok_saat_scan,keterangan,scanned_at) VALUES (?,?,?,?,?,?,?,?,NOW())`,
        [req.params.id, produk.id, produk.barcode||null, produk.nama, stokRealtime, fisik, stokRealtime, keterangan||null]);
    }

    // Return updated counts
    const [[counts]] = await db.query(
      `SELECT COUNT(*) as total, SUM(scanned_at IS NOT NULL) as scanned FROM stock_opname_item WHERE opname_id=?`, [req.params.id]);
    res.json({success:true, message:`${produk.nama} — stok fisik: ${fisik} (sistem: ${stokRealtime})`, produk_nama:produk.nama, stok_sistem:stokRealtime, total:counts.total, scanned:counts.scanned});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// PUT /api/pos/opname/:id/items/:itemId — update stok fisik manual
// LIVE OPNAME: refresh stok DB realtime saat update
router.put('/opname/:id/items/:itemId', auth(), async (req, res) => {
  try {
    const { stok_fisik, keterangan } = req.body;
    const fisik = parseInt(stok_fisik)||0;
    // Ambil produk_id & cabang dari item + sesi
    const [[item]] = await db.query('SELECT produk_id FROM stock_opname_item WHERE id=? AND opname_id=?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({success:false, message:'Item tidak ditemukan.'});
    const [[sesi]] = await db.query('SELECT cabang_id FROM stock_opname_sesi WHERE id=?', [req.params.id]);
    const [[stokNow]] = await db.query('SELECT qty FROM pos_stok WHERE produk_id=? AND cabang_id=?', [item.produk_id, sesi.cabang_id]);
    await db.query(
      `UPDATE stock_opname_item SET stok_fisik=?, stok_saat_scan=?, keterangan=?, scanned_at=NOW() WHERE id=? AND opname_id=?`,
      [fisik, stokNow?.qty||0, keterangan||null, req.params.itemId, req.params.id]);
    res.json({success:true, message:'Stok fisik diupdate.'});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// POST /api/pos/opname/:id/selesai — finalisasi opname, update stok
// LIVE OPNAME: pakai DELTA (adjustment), bukan overwrite
// Rumus: stok_baru = stok_db_saat_ini + (stok_fisik - stok_saat_scan)
// Ini mempertahankan semua transaksi yang terjadi SETELAH item discan
router.post('/opname/:id/selesai', auth(['owner','admin_pusat','head_operational','manajer','kepala_cabang']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[sesi]] = await conn.query('SELECT * FROM stock_opname_sesi WHERE id=? AND status="proses"', [req.params.id]);
    if (!sesi) return res.status(400).json({success:false, message:'Sesi opname tidak aktif atau sudah selesai.'});

    // Hitung transaksi POS yang terjadi selama opname berlangsung
    const [[trxCount]] = await conn.query(
      `SELECT COUNT(*) as c FROM pos_transaksi WHERE cabang_id=? AND status='selesai' AND created_at>=?`,
      [sesi.cabang_id, sesi.created_at]);

    const [items] = await conn.query('SELECT * FROM stock_opname_item WHERE opname_id=? AND scanned_at IS NOT NULL', [req.params.id]);
    let updated=0, plus=0, minus=0, sama=0;
    const details = [];

    for (const item of items) {
      // stok_saat_scan = stok DB pada saat item discan (realtime)
      // Jika null (data lama), fallback ke stok_sistem (snapshot awal)
      const baseline = item.stok_saat_scan !== null ? item.stok_saat_scan : item.stok_sistem;
      const adjustment = item.stok_fisik - baseline; // selisih nyata saat dihitung

      if (adjustment === 0) { sama++; continue; }

      // Ambil stok DB terkini (mungkin sudah berubah karena transaksi setelah scan)
      const [[stokNow]] = await conn.query('SELECT qty FROM pos_stok WHERE produk_id=? AND cabang_id=?', [item.produk_id, sesi.cabang_id]);
      const stokSekarang = stokNow?.qty || 0;

      // DELTA: apply adjustment ke stok saat ini, bukan overwrite
      const stokBaru = Math.max(0, stokSekarang + adjustment);

      await conn.query(`INSERT INTO pos_stok (produk_id,cabang_id,qty) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE qty=?`, [item.produk_id, sesi.cabang_id, stokBaru, stokBaru]);

      const tipe = adjustment > 0 ? 'opname_plus' : 'opname_minus';
      await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id) VALUES (?,?,?,?,?,?)`,
        [item.produk_id, sesi.cabang_id, tipe, Math.abs(adjustment),
         `Opname ${sesi.kode_opname}: scan(${baseline}) fisik(${item.stok_fisik}) adj(${adjustment>0?'+':''}${adjustment}) → DB(${stokSekarang}→${stokBaru})`,
         req.user.id]);

      if (adjustment > 0) plus++; else minus++;
      updated++;
      details.push({nama:item.nama_produk, baseline, fisik:item.stok_fisik, adjustment, stok_before:stokSekarang, stok_after:stokBaru});
    }

    await conn.query('UPDATE stock_opname_sesi SET status="selesai", finished_at=NOW(), trx_selama_opname=? WHERE id=?',
      [trxCount.c, req.params.id]);
    await conn.commit();

    audit(req, 'selesai', 'opname', req.params.id, sesi.kode_opname, {updated,plus,minus,sama,trx_selama:trxCount.c});
    let msg = `Opname selesai: ${updated} produk diadjust (${plus} plus, ${minus} minus), ${sama} sesuai.`;
    if (trxCount.c > 0) msg += ` ${trxCount.c} transaksi POS terjadi selama opname — stok tetap akurat.`;
    res.json({success:true, message:msg, data:{updated,plus,minus,sama,trx_selama_opname:trxCount.c, details}});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false, message:e.message}); }
  finally { conn.release(); }
});

// POST /api/pos/opname/:id/batal — batalkan sesi (soft-delete: status=batal, tetap di history)
router.post('/opname/:id/batal', auth(['owner','admin_pusat','head_operational','manajer','kepala_cabang','spv_area']), async (req, res) => {
  try {
    const [[sesi]] = await db.query('SELECT * FROM stock_opname_sesi WHERE id=?', [req.params.id]);
    if (!sesi) return res.status(404).json({success:false, message:'Sesi tidak ditemukan.'});
    if (sesi.status === 'selesai') return res.status(400).json({success:false, message:'Sesi sudah selesai, tidak bisa dibatalkan.'});
    await db.query("UPDATE stock_opname_sesi SET status='batal', finished_at=NOW() WHERE id=?", [req.params.id]);
    res.json({success:true, message:'Sesi opname dibatalkan.'});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// GET /api/pos/opname/:id/export — export CSV
router.get('/opname/:id/export', auth(), async (req, res) => {
  try {
    const [[sesi]] = await db.query(
      `SELECT s.*, c.nama as nama_cabang FROM stock_opname_sesi s LEFT JOIN cabang c ON s.cabang_id=c.id WHERE s.id=?`, [req.params.id]);
    if (!sesi) return res.status(404).json({success:false, message:'Sesi tidak ditemukan.'});
    const [items] = await db.query('SELECT * FROM stock_opname_item WHERE opname_id=? ORDER BY nama_produk', [req.params.id]);
    let csv = 'Barcode,Nama Produk,Stok Sistem,Stok Fisik,Selisih,Keterangan,Waktu Scan\n';
    for (const it of items) {
      csv += `"${it.barcode||''}","${(it.nama_produk||'').replace(/"/g,'""')}",${it.stok_sistem},${it.stok_fisik},${it.selisih},"${(it.keterangan||'').replace(/"/g,'""')}","${it.scanned_at||''}"\n`;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=opname_${sesi.kode_opname}_${sesi.nama_cabang||''}.csv`);
    res.send(csv);
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// ── HAPUS SEMUA STOK CABANG ──────────────────────────────
router.delete('/stok/hapus-cabang', auth(['owner']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { cabang_id } = req.body;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});

    const [[cab]] = await conn.query('SELECT id,nama FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(404).json({success:false,message:'Cabang tidak ditemukan.'});

    // Hitung stok sebelum hapus
    const [[info]] = await conn.query(
      `SELECT COUNT(*) as total_produk, COALESCE(SUM(qty),0) as total_stok
       FROM pos_stok WHERE cabang_id=? AND qty>0`, [cabang_id]);

    // Log penghapusan
    const [stokRows] = await conn.query(
      'SELECT produk_id, qty FROM pos_stok WHERE cabang_id=? AND qty>0', [cabang_id]);
    for (const s of stokRows) {
      await conn.query(
        `INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id)
         VALUES (?,?,'hapus_data',?,?,?)`,
        [s.produk_id, cabang_id, s.qty, `Hapus semua data cabang ${cab.nama}`, req.user.id]).catch(()=>{});
    }

    // Reset semua stok ke 0
    await conn.query('UPDATE pos_stok SET qty=0 WHERE cabang_id=?', [cabang_id]);

    // Hapus transaksi POS cabang ini
    const [trxList] = await conn.query('SELECT id FROM pos_transaksi WHERE cabang_id=?', [cabang_id]);
    if (trxList.length) {
      const trxIds = trxList.map(t => t.id);
      await conn.query(`DELETE FROM pos_transaksi_item WHERE transaksi_id IN (${trxIds.map(()=>'?').join(',')})`, trxIds);
      await conn.query('DELETE FROM pos_transaksi WHERE cabang_id=?', [cabang_id]);
    }

    // Hapus shift POS
    await conn.query('DELETE FROM pos_shift WHERE cabang_id=?', [cabang_id]);

    // Hapus stok log cabang ini
    await conn.query('DELETE FROM pos_stok_log WHERE cabang_id=?', [cabang_id]);

    await conn.commit();
    res.json({success:true,
      message:`Data cabang ${cab.nama} berhasil dihapus: ${info.total_produk} produk (${info.total_stok} item stok), transaksi, shift, dan log direset.`});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// ── ALERT STOK MENIPIS ──────────────────────────────

// GET /api/pos/stok/alert?cabang_id= — produk di bawah stok minimum
router.get('/stok/alert', auth(), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    let where = 'p.aktif=1 AND p.stok_minimum > 0';
    const params = [];

    if (cabang_id) {
      // Alert per cabang tertentu
      const [rows] = await db.query(`
        SELECT p.id, p.sku, p.nama, p.kategori, p.stok_minimum,
               COALESCE(s.qty, 0) as stok_sekarang,
               c.id as cabang_id, c.nama as nama_cabang, c.kode as kode_cabang,
               COALESCE(smc.stok_minimum, p.stok_minimum) as min_efektif
        FROM pos_produk p
        LEFT JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
        LEFT JOIN pos_stok_minimum_cabang smc ON smc.produk_id = p.id AND smc.cabang_id = ?
        LEFT JOIN cabang c ON c.id = ?
        WHERE p.aktif = 1
          AND COALESCE(smc.stok_minimum, p.stok_minimum) > 0
          AND COALESCE(s.qty, 0) < COALESCE(smc.stok_minimum, p.stok_minimum)
        ORDER BY (COALESCE(s.qty, 0) / COALESCE(smc.stok_minimum, p.stok_minimum)) ASC, p.nama`,
        [cabang_id, cabang_id, cabang_id]);
      res.json({success:true, data:rows, total:rows.length});
    } else {
      // Alert semua cabang — summary per cabang
      const [rows] = await db.query(`
        SELECT c.id as cabang_id, c.kode, c.nama as nama_cabang,
               COUNT(*) as produk_menipis,
               SUM(CASE WHEN COALESCE(s.qty,0) = 0 THEN 1 ELSE 0 END) as produk_habis
        FROM pos_produk p
        JOIN cabang c ON c.aktif = 1
        LEFT JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = c.id
        LEFT JOIN pos_stok_minimum_cabang smc ON smc.produk_id = p.id AND smc.cabang_id = c.id
        WHERE p.aktif = 1
          AND COALESCE(smc.stok_minimum, p.stok_minimum) > 0
          AND COALESCE(s.qty, 0) < COALESCE(smc.stok_minimum, p.stok_minimum)
        GROUP BY c.id, c.kode, c.nama
        ORDER BY produk_menipis DESC`);

      const totalMenipis = rows.reduce((s,r) => s + r.produk_menipis, 0);
      const totalHabis = rows.reduce((s,r) => s + r.produk_habis, 0);
      res.json({success:true, data:rows, summary:{total_menipis:totalMenipis, total_habis:totalHabis, cabang_terdampak:rows.length}});
    }
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos/stok/set-minimum — bulk set stok minimum
router.post('/stok/set-minimum', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { items } = req.body; // [{produk_id, stok_minimum, cabang_id?}]
    if (!items?.length) return res.status(400).json({success:false,message:'items wajib.'});
    let updated = 0;
    for (const item of items) {
      if (item.cabang_id) {
        // Per-cabang override
        await db.query(`INSERT INTO pos_stok_minimum_cabang (produk_id, cabang_id, stok_minimum)
          VALUES (?,?,?) ON DUPLICATE KEY UPDATE stok_minimum=VALUES(stok_minimum)`,
          [item.produk_id, item.cabang_id, item.stok_minimum||0]);
      } else {
        // Global default
        await db.query('UPDATE pos_produk SET stok_minimum=? WHERE id=?', [item.stok_minimum||0, item.produk_id]);
      }
      updated++;
    }
    res.json({success:true, message:`${updated} stok minimum diupdate.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos/stok/set-minimum-bulk-kategori — set minimum per kategori
router.post('/stok/set-minimum-bulk', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { stok_minimum, kategori, produk_ids } = req.body;
    if (stok_minimum === undefined) return res.status(400).json({success:false,message:'stok_minimum wajib.'});
    let affected = 0;
    if (produk_ids?.length) {
      const ph = produk_ids.map(()=>'?').join(',');
      const [r] = await db.query(`UPDATE pos_produk SET stok_minimum=? WHERE id IN (${ph})`, [stok_minimum, ...produk_ids]);
      affected = r.affectedRows;
    } else if (kategori) {
      const [r] = await db.query('UPDATE pos_produk SET stok_minimum=? WHERE kategori=? AND aktif=1', [stok_minimum, kategori]);
      affected = r.affectedRows;
    } else {
      const [r] = await db.query('UPDATE pos_produk SET stok_minimum=? WHERE aktif=1', [stok_minimum]);
      affected = r.affectedRows;
    }
    res.json({success:true, message:`${affected} produk diupdate.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
