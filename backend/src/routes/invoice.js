const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/var/www/rajavavapor/uploads/invoice_bukti';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, Date.now()+'-'+safeName);
  }
});
const upload = multer({
  storage, limits:{fileSize:10*1024*1024},
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg','.jpeg','.png','.gif','.webp','.pdf'].includes(ext)) cb(null, true);
    else cb(new Error('Hanya file gambar atau PDF yang diizinkan.'));
  }
});

const GUDANG_SALES_ID = 3;

// Helper: validasi stok cukup sebelum buat/edit invoice
async function validasiStokInvoice(conn, items, cabangId) {
  const kurang = [];
  for (const item of items) {
    if (!item.produk_id) continue;
    const [[stok]] = await conn.query(
      'SELECT COALESCE(qty,0) as qty FROM pos_stok WHERE produk_id=? AND cabang_id=?',
      [item.produk_id, cabangId]);
    const tersedia = stok ? stok.qty : 0;
    if (tersedia < item.qty) {
      const [[prod]] = await conn.query('SELECT nama FROM pos_produk WHERE id=?', [item.produk_id]);
      kurang.push(`${prod?.nama || 'Produk #'+item.produk_id}: stok ${tersedia}, diminta ${item.qty}`);
    }
  }
  return kurang;
}

// Helper: kurangi stok gudang sales + log (produk_id = pos_produk.id langsung)
async function kurangiStokDraft(conn, items, invoiceNomor, userId, cabangId) {
  for (const item of items) {
    if (!item.produk_id) continue;
    await conn.query(
      `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,0)
       ON DUPLICATE KEY UPDATE qty = qty - ?`,
      [item.produk_id, cabangId, item.qty]);
    await conn.query(
      `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id)
       VALUES (?,?,'invoice_draft',?,?,?)`,
      [item.produk_id, cabangId, item.qty, `Dimasukkan draft ${invoiceNomor}`, userId]).catch(()=>{});
  }
}

// Helper: kembalikan stok gudang sales + log
async function kembalikanStokDraft(conn, invoiceId, invoiceNomor, userId, cabangId) {
  const [items] = await conn.query('SELECT produk_id, qty FROM invoice_item WHERE invoice_id=?', [invoiceId]);
  for (const item of items) {
    if (!item.produk_id) continue;
    await conn.query(
      `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE qty = qty + ?`,
      [item.produk_id, cabangId, item.qty, item.qty]);
    await conn.query(
      `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id)
       VALUES (?,?,'invoice_batal',?,?,?)`,
      [item.produk_id, cabangId, item.qty, `Draft batal/hapus ${invoiceNomor}`, userId]).catch(()=>{});
  }
}

// Helper: tentukan cabang gudang untuk user
async function getGudangCabang(conn, userId) {
  const [[user]] = await conn.query('SELECT cabang_id FROM users WHERE id=?', [userId]);
  return (user && user.cabang_id) ? user.cabang_id : GUDANG_SALES_ID;
}

// Auto-cleanup draft > 7 hari
router.delete('/cleanup/draft-expired', auth(['owner','manajer','admin_pusat','sales','kasir','kasir_sales']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [expired] = await conn.query(
      `SELECT i.id, i.nomor, i.sales_id FROM invoice i
       WHERE i.status='draft' AND i.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`);
    if (!expired.length) { await conn.commit(); return res.json({success:true, deleted:0, message:'Tidak ada draft expired.'}); }

    for (const inv of expired) {
      const cabId = await getGudangCabang(conn, inv.sales_id);
      await kembalikanStokDraft(conn, inv.id, inv.nomor, inv.sales_id, cabId);
    }

    const ids = expired.map(e => e.id);
    const ph = ids.map(()=>'?').join(',');
    await conn.query(`DELETE FROM invoice_item WHERE invoice_id IN (${ph})`, ids);
    await conn.query(`DELETE FROM invoice WHERE id IN (${ph})`, ids);

    await conn.commit();
    res.json({success:true, deleted:expired.length,
      message:`${expired.length} draft invoice dihapus otomatis (lebih dari 7 hari). Stok dikembalikan.`,
      items: expired.map(e => e.nomor)});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false, message:e.message}); }
  finally { conn.release(); }
});

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.status) { where += ' AND i.status=?'; params.push(req.query.status); }
    if (req.user.role === 'sales') { where += ' AND i.sales_id=?'; params.push(req.user.id); }
    const lmt = req.query.limit ? parseInt(req.query.limit) : 500;
    const [rows] = await db.query(
      `SELECT i.*, c.nama as nama_customer, c.nama_toko, c.nama_owner, c.no_hp as no_hp_customer,
              c.alamat as alamat_customer, u.nama_lengkap as nama_sales,
              COALESCE(ii.total_qty, 0) as total_qty
       FROM invoice i
       LEFT JOIN customer c ON i.customer_id = c.id
       LEFT JOIN users u ON i.sales_id = u.id
       LEFT JOIN (SELECT invoice_id, SUM(qty) as total_qty FROM invoice_item GROUP BY invoice_id) ii ON ii.invoice_id = i.id
       ${where} ORDER BY i.created_at DESC LIMIT ?`, [...params, lmt]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET daftar bank untuk dropdown lunas (harus sebelum /:id)
router.get('/ref/bank', auth(), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, nama_akun, nama_bank, no_rekening, atas_nama FROM kas_akun WHERE aktif=1 ORDER BY nama_bank, nama_akun');
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

router.get('/:id', auth(), async (req, res) => {
  try {
    const [[inv]] = await db.query(
      `SELECT i.*, c.nama as nama_customer, c.nama_toko, c.nama_owner,
              c.no_hp as no_hp_customer, c.alamat as alamat_customer, u.nama_lengkap as nama_sales
       FROM invoice i
       LEFT JOIN customer c ON i.customer_id=c.id
       LEFT JOIN users u ON i.sales_id=u.id
       WHERE i.id=?`, [req.params.id]
    );
    if (!inv) return res.status(404).json({ success:false, message:'Invoice tidak ditemukan.' });
    const [items] = await db.query(
      `SELECT ii.*, COALESCE(ii.nama_produk, p.nama) as nama_produk, p.sku FROM invoice_item ii
       LEFT JOIN pos_produk p ON ii.produk_id=p.id WHERE ii.invoice_id=?`, [req.params.id]
    );
    inv.items = items;
    res.json({ success:true, data:inv });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST — buat invoice baru (stok langsung dikurangi saat draft)
router.post('/', auth(['owner','manajer','admin_pusat','sales','kasir','kasir_sales']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { customer_id, entitas_id, tanggal, jatuh_tempo, keterangan, status, items, ongkir } = req.body;
    if (!customer_id || !tanggal || !items || !items.length)
      return res.status(400).json({ success:false, message:'Customer, tanggal, dan item wajib diisi.' });
    const subtotal = items.reduce((s,i) => s + parseFloat(i.subtotal||0), 0);
    const ongkirVal = parseFloat(ongkir)||0;
    const total = subtotal + ongkirVal;
    const nomor = 'INV-' + Date.now();
    const [result] = await conn.query(
      'INSERT INTO invoice (nomor, customer_id, entitas_id, sales_id, tanggal, jatuh_tempo, total, ongkir, status, keterangan) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [nomor, customer_id, entitas_id||null, req.user.id, tanggal, jatuh_tempo||null, total, ongkirVal, status||'draft', keterangan||'']
    );
    const invId = result.insertId;
    for (const item of items) {
      // Ambil nama produk saat ini untuk disimpan sebagai snapshot
      let namaProduk = item.nama_produk || null;
      if (!namaProduk && item.produk_id) {
        const [[prod]] = await conn.query('SELECT nama FROM pos_produk WHERE id=?', [item.produk_id]);
        if (prod) namaProduk = prod.nama;
      }
      await conn.query(
        'INSERT INTO invoice_item (invoice_id, produk_id, nama_produk, varian, qty, harga, diskon, subtotal) VALUES (?,?,?,?,?,?,?,?)',
        [invId, item.produk_id, namaProduk, item.varian||null, item.qty, item.harga, item.diskon||0, item.subtotal]
      );
    }

    // Validasi & kurangi stok gudang
    const cabId = await getGudangCabang(conn, req.user.id);
    const kurang = await validasiStokInvoice(conn, items, cabId);
    if (kurang.length) {
      await conn.rollback();
      return res.status(400).json({ success:false, message:'Stok tidak cukup:\n' + kurang.join('\n') });
    }
    await kurangiStokDraft(conn, items, nomor, req.user.id, cabId);

    await conn.commit();
    res.json({ success:true, message:'Invoice berhasil dibuat. Stok gudang dikurangi.', id:invId, nomor });
  } catch(e) { await conn.rollback(); res.status(500).json({ success:false, message:e.message }); }
  finally { conn.release(); }
});

// PATCH /:id — edit draft invoice (kembalikan stok lama, kurangi stok baru)
router.patch('/:id', auth(['owner','manajer','admin_pusat','sales','kasir','kasir_sales']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[inv]] = await conn.query('SELECT * FROM invoice WHERE id=?', [req.params.id]);
    if (!inv) return res.status(404).json({success:false, message:'Invoice tidak ditemukan.'});
    if (inv.status !== 'draft') return res.status(400).json({success:false, message:'Hanya invoice draft yang bisa diedit.'});

    const { customer_id, entitas_id, tanggal, jatuh_tempo, keterangan, items, ongkir } = req.body;
    if (!customer_id || !tanggal || !items || !items.length)
      return res.status(400).json({success:false, message:'Customer, tanggal, dan item wajib diisi.'});

    const subtotal = items.reduce((s,i) => s + parseFloat(i.subtotal||0), 0);
    const ongkirVal = parseFloat(ongkir)||0;
    const total = subtotal + ongkirVal;

    // 1. Kembalikan stok lama
    const cabId = await getGudangCabang(conn, inv.sales_id);
    await kembalikanStokDraft(conn, inv.id, inv.nomor, req.user.id, cabId);

    // 2. Update header
    await conn.query(
      `UPDATE invoice SET customer_id=?, entitas_id=?, tanggal=?, jatuh_tempo=?, total=?, ongkir=?, keterangan=? WHERE id=?`,
      [customer_id, entitas_id||null, tanggal, jatuh_tempo||null, total, ongkirVal, keterangan||'', req.params.id]
    );

    // 3. Replace items
    await conn.query('DELETE FROM invoice_item WHERE invoice_id=?', [req.params.id]);
    for (const item of items) {
      let namaProduk = item.nama_produk || null;
      if (!namaProduk && item.produk_id) {
        const [[prod]] = await conn.query('SELECT nama FROM pos_produk WHERE id=?', [item.produk_id]);
        if (prod) namaProduk = prod.nama;
      }
      await conn.query(
        'INSERT INTO invoice_item (invoice_id, produk_id, nama_produk, varian, qty, harga, diskon, subtotal) VALUES (?,?,?,?,?,?,?,?)',
        [req.params.id, item.produk_id, namaProduk, item.varian||null, item.qty, item.harga, item.diskon||0, item.subtotal]
      );
    }

    // 4. Validasi & kurangi stok baru
    const kurang = await validasiStokInvoice(conn, items, cabId);
    if (kurang.length) {
      await conn.rollback();
      return res.status(400).json({ success:false, message:'Stok tidak cukup:\n' + kurang.join('\n') });
    }
    await kurangiStokDraft(conn, items, inv.nomor, req.user.id, cabId);

    await conn.commit();
    res.json({success:true, message:'Invoice draft berhasil diupdate. Stok disesuaikan.'});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false, message:e.message}); }
  finally { conn.release(); }
});

router.patch('/:id/status', auth(['owner','manajer','admin_pusat','sales','kasir','kasir_sales']), async (req, res) => {
  try {
    const { status } = req.body;
    await db.query('UPDATE invoice SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ success:true, message:'Status invoice diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /:id/lunas — tandai lunas dengan bukti transfer + pilihan bank
router.post('/:id/lunas', auth(['owner','manajer','admin_pusat','sales','kasir','kasir_sales']), upload.single('bukti'), async (req, res) => {
  try {
    const [[inv]] = await db.query('SELECT * FROM invoice WHERE id=?', [req.params.id]);
    if (!inv) return res.status(404).json({success:false, message:'Invoice tidak ditemukan.'});
    if (inv.status === 'lunas') return res.status(400).json({success:false, message:'Invoice sudah lunas.'});
    if (inv.status !== 'diterbitkan') return res.status(400).json({success:false, message:'Invoice harus berstatus diterbitkan untuk dilunasi.'});

    if (!req.file) return res.status(400).json({success:false, message:'Bukti transfer wajib diupload.'});
    const kas_akun_id = req.body.kas_akun_id;
    if (!kas_akun_id) return res.status(400).json({success:false, message:'Pilih rekening bank tujuan.'});

    const buktiUrl = '/uploads/invoice_bukti/' + req.file.filename;
    const tanggalLunas = req.body.tanggal_lunas || new Date().toISOString().slice(0,10);

    await db.query(
      `UPDATE invoice SET status='lunas', bukti_lunas=?, kas_akun_id=?, tanggal_lunas=? WHERE id=?`,
      [buktiUrl, kas_akun_id, tanggalLunas, req.params.id]);

    res.json({success:true, message:'Invoice ditandai lunas. Bukti transfer tersimpan.'});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// DELETE — hapus invoice (kembalikan stok jika masih draft)
router.delete('/:id', auth(['owner']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[inv]] = await conn.query('SELECT id, nomor, status, sales_id FROM invoice WHERE id=?', [req.params.id]);
    if (!inv) return res.status(404).json({success:false, message:'Invoice tidak ditemukan.'});

    // Kembalikan stok jika draft (stok sudah dikurangi saat buat draft)
    if (inv.status === 'draft') {
      const cabId = await getGudangCabang(conn, inv.sales_id);
      await kembalikanStokDraft(conn, inv.id, inv.nomor, inv.sales_id, cabId);
    }

    await conn.query('DELETE FROM invoice_item WHERE invoice_id=?', [req.params.id]);
    await conn.query('DELETE FROM invoice WHERE id=?', [req.params.id]);
    await conn.commit();
    res.json({ success:true, message:'Invoice dihapus.' + (inv.status==='draft'?' Stok dikembalikan.':'') });
  } catch(e) { await conn.rollback(); res.status(500).json({ success:false, message:e.message }); }
  finally { conn.release(); }
});

module.exports = router;
