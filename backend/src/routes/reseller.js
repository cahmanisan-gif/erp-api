const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// Helper: sales hanya lihat data sendiri, owner lihat semua
async function getResellerAkses(user) {
  if (user.role === 'owner' || user.role === 'manajer') return null; // null = semua
  return user.id; // sales = hanya miliknya
}

// GET /api/reseller
router.get('/', auth(), async (req, res) => {
  try {
    const salesFilter = await getResellerAkses(req.user);
    const where = salesFilter ? 'WHERE r.sales_id = ?' : 'WHERE 1=1';
    const params = salesFilter ? [salesFilter] : [];
    const [rows] = await db.query(
      `SELECT r.*, u.nama_lengkap AS nama_sales,
        (SELECT COUNT(*) FROM reseller_transaksi rt WHERE rt.reseller_id = r.id) AS trx_manual,
        (SELECT COALESCE(SUM(nominal),0) FROM reseller_transaksi rt WHERE rt.reseller_id = r.id) AS omzet_manual,
        (SELECT COUNT(*) FROM invoice iv WHERE iv.customer_id = r.customer_id AND iv.status IN ('diterbitkan','lunas')) AS trx_invoice,
        (SELECT COALESCE(SUM(total),0) FROM invoice iv WHERE iv.customer_id = r.customer_id AND iv.status IN ('diterbitkan','lunas')) AS omzet_invoice
       FROM reseller r
       LEFT JOIN users u ON u.id = r.sales_id
       ${where} AND r.aktif=1 ORDER BY r.nama_toko`, params);
    // Combine: total_omzet = manual + invoice, total_trx = manual + invoice
    rows.forEach(r => {
      r.total_omzet = parseFloat(r.omzet_manual||0) + parseFloat(r.omzet_invoice||0);
      r.total_trx   = (r.trx_manual||0) + (r.trx_invoice||0);
    });
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Helper: generate kode customer unik untuk reseller
async function genKodeReseller(conn) {
  const c = conn || db;
  const [[row]] = await c.query("SELECT MAX(CAST(REPLACE(kode,'RS-','') AS UNSIGNED)) as mx FROM customer WHERE kode LIKE 'RS-%'");
  const next = (row.mx || 0) + 1;
  return 'RS-' + String(next).padStart(4, '0');
}

// Helper: sync reseller → customer (buat/update record di tabel customer)
async function syncResellerToCustomer(conn, resellerId, data, salesId) {
  const [[existing]] = await conn.query('SELECT customer_id FROM reseller WHERE id=?', [resellerId]);
  if (existing && existing.customer_id) {
    // Update customer yang sudah ada
    await conn.query(
      `UPDATE customer SET nama=?, nama_toko=?, nama_owner=?, no_hp=?, alamat=? WHERE id=?`,
      [data.nama_toko, data.nama_toko, data.nama_pemilik||'', data.no_hp||'', data.alamat||'', existing.customer_id]
    );
    return existing.customer_id;
  } else {
    // Cek apakah sudah ada customer dengan nama_toko & sales_id yang sama (hindari duplikat)
    const [[dup]] = await conn.query(
      "SELECT id FROM customer WHERE nama_toko=? AND sales_id=? AND tipe='reseller' LIMIT 1",
      [data.nama_toko, salesId]
    );
    if (dup) {
      await conn.query('UPDATE reseller SET customer_id=? WHERE id=?', [dup.id, resellerId]);
      await conn.query(
        `UPDATE customer SET nama=?, nama_owner=?, no_hp=?, alamat=? WHERE id=?`,
        [data.nama_toko, data.nama_pemilik||'', data.no_hp||'', data.alamat||'', dup.id]
      );
      return dup.id;
    }
    // Buat customer baru
    const kode = await genKodeReseller(conn);
    const [ins] = await conn.query(
      `INSERT INTO customer (kode, nama, nama_toko, nama_owner, no_hp, alamat, tipe, sales_id) VALUES (?,?,?,?,?,?,?,?)`,
      [kode, data.nama_toko, data.nama_toko, data.nama_pemilik||'', data.no_hp||'', data.alamat||'', 'reseller', salesId]
    );
    await conn.query('UPDATE reseller SET customer_id=? WHERE id=?', [ins.insertId, resellerId]);
    return ins.insertId;
  }
}

// POST /api/reseller
router.post('/', auth(), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { nama_toko, nama_pemilik, no_hp, alamat, catatan } = req.body;
    if (!nama_toko) return res.status(400).json({ success:false, message:'Nama toko wajib diisi.' });
    const [result] = await conn.query(
      'INSERT INTO reseller (sales_id, nama_toko, nama_pemilik, no_hp, alamat, catatan) VALUES (?,?,?,?,?,?)',
      [req.user.id, nama_toko, nama_pemilik||'', no_hp||'', alamat||'', catatan||'']);
    // Sync ke tabel customer agar muncul di invoice
    await syncResellerToCustomer(conn, result.insertId, { nama_toko, nama_pemilik, no_hp, alamat }, req.user.id);
    await conn.commit();
    res.json({ success:true, message:'Reseller berhasil ditambahkan.' });
  } catch(e) { await conn.rollback(); res.status(500).json({ success:false, message:e.message }); }
  finally { conn.release(); }
});

// PATCH /api/reseller/:id
router.patch('/:id', auth(), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const salesFilter = await getResellerAkses(req.user);
    const where = salesFilter ? 'WHERE id=? AND sales_id=?' : 'WHERE id=?';
    const params = salesFilter ? [req.params.id, salesFilter] : [req.params.id];
    const [[existing]] = await conn.query('SELECT id, sales_id FROM reseller '+where, params);
    if (!existing) return res.status(403).json({ success:false, message:'Akses ditolak.' });
    const { nama_toko, nama_pemilik, no_hp, alamat, catatan } = req.body;
    await conn.query(
      'UPDATE reseller SET nama_toko=?, nama_pemilik=?, no_hp=?, alamat=?, catatan=? WHERE id=?',
      [nama_toko, nama_pemilik||'', no_hp||'', alamat||'', catatan||'', req.params.id]);
    // Sync update ke customer
    await syncResellerToCustomer(conn, req.params.id, { nama_toko, nama_pemilik, no_hp, alamat }, existing.sales_id);
    await conn.commit();
    res.json({ success:true, message:'Reseller berhasil diupdate.' });
  } catch(e) { await conn.rollback(); res.status(500).json({ success:false, message:e.message }); }
  finally { conn.release(); }
});

// DELETE /api/reseller/:id
router.delete('/:id', auth(), async (req, res) => {
  try {
    const salesFilter = await getResellerAkses(req.user);
    const where = salesFilter ? 'WHERE id=? AND sales_id=?' : 'WHERE id=?';
    const params = salesFilter ? [req.params.id, salesFilter] : [req.params.id];
    const [[existing]] = await db.query('SELECT id FROM reseller '+where, params);
    if (!existing) return res.status(403).json({ success:false, message:'Akses ditolak.' });
    await db.query('UPDATE reseller SET aktif=0 WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Reseller dinonaktifkan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/reseller/:id/transaksi
router.get('/:id/transaksi', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM reseller_transaksi WHERE reseller_id=? ORDER BY tanggal DESC', [req.params.id]);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/reseller/:id/transaksi
router.post('/:id/transaksi', auth(), async (req, res) => {
  try {
    const { tanggal, nominal, keterangan } = req.body;
    if (!tanggal||!nominal) return res.status(400).json({ success:false, message:'Tanggal dan nominal wajib.' });
    await db.query(
      'INSERT INTO reseller_transaksi (reseller_id, sales_id, tanggal, nominal, keterangan) VALUES (?,?,?,?,?)',
      [req.params.id, req.user.id, tanggal, nominal, keterangan||'']);
    res.json({ success:true, message:'Transaksi berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE /api/reseller/transaksi/:id
router.delete('/transaksi/:id', auth(), async (req, res) => {
  try {
    await db.query('DELETE FROM reseller_transaksi WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
