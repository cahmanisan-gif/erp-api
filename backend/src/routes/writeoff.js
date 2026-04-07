const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

const WRITE_ROLES = ['owner','manajer','head_operational','admin_pusat'];

// ══════════════════════════════════════════════
// GET /api/writeoff — list writeoffs with filters
// ══════════════════════════════════════════════
router.get('/', auth(), async (req, res) => {
  try {
    const { cabang_id, bulan, tipe, page, limit: lim } = req.query;
    let where = '1=1';
    const params = [];

    if (cabang_id) { where += ' AND w.cabang_id=?'; params.push(cabang_id); }
    if (bulan)     { where += ' AND DATE_FORMAT(w.tanggal, "%Y-%m")=?'; params.push(bulan); }
    if (tipe)      { where += ' AND w.tipe=?'; params.push(tipe); }

    const limit  = Math.min(parseInt(lim) || 50, 200);
    const offset = ((parseInt(page) || 1) - 1) * limit;

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM stok_writeoff w WHERE ${where}`, params
    );

    const [rows] = await db.query(`
      SELECT w.*, p.nama AS produk_nama, p.sku, c.nama AS cabang_nama, u.nama_lengkap AS user_nama
      FROM stok_writeoff w
      LEFT JOIN pos_produk p ON p.id=w.produk_id
      LEFT JOIN cabang c ON c.id=w.cabang_id
      LEFT JOIN users u ON u.id=w.user_id
      WHERE ${where}
      ORDER BY w.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({ success: true, data: rows, total, page: parseInt(page)||1, limit });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// GET /api/writeoff/rekap — summary by tipe & cabang
// ══════════════════════════════════════════════
router.get('/rekap', auth(), async (req, res) => {
  try {
    const { bulan } = req.query;
    let where = '1=1';
    const params = [];
    if (bulan) { where += ' AND DATE_FORMAT(w.tanggal, "%Y-%m")=?'; params.push(bulan); }

    // Group by tipe
    const [byTipe] = await db.query(`
      SELECT w.tipe, SUM(w.qty) AS total_qty, SUM(w.nilai_kerugian) AS total_kerugian, COUNT(*) AS jumlah
      FROM stok_writeoff w
      WHERE ${where}
      GROUP BY w.tipe
      ORDER BY total_kerugian DESC
    `, params);

    // Group by cabang
    const [byCabang] = await db.query(`
      SELECT w.cabang_id, c.nama AS cabang_nama, SUM(w.qty) AS total_qty,
             SUM(w.nilai_kerugian) AS total_kerugian, COUNT(*) AS jumlah
      FROM stok_writeoff w
      LEFT JOIN cabang c ON c.id=w.cabang_id
      WHERE ${where}
      GROUP BY w.cabang_id
      ORDER BY total_kerugian DESC
    `, params);

    // Grand total
    const totalQty      = byTipe.reduce((s, r) => s + (Number(r.total_qty) || 0), 0);
    const totalKerugian = byTipe.reduce((s, r) => s + (Number(r.total_kerugian) || 0), 0);

    res.json({
      success: true,
      data: { total_qty: totalQty, total_kerugian: totalKerugian, by_tipe: byTipe, by_cabang: byCabang }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// GET /api/writeoff/:id — detail single writeoff
// ══════════════════════════════════════════════
router.get('/:id', auth(), async (req, res) => {
  try {
    const [[row]] = await db.query(`
      SELECT w.*, p.nama AS produk_nama, p.sku, p.harga_modal, p.harga_jual,
             c.nama AS cabang_nama, u.nama_lengkap AS user_nama
      FROM stok_writeoff w
      LEFT JOIN pos_produk p ON p.id=w.produk_id
      LEFT JOIN cabang c ON c.id=w.cabang_id
      LEFT JOIN users u ON u.id=w.user_id
      WHERE w.id=?
    `, [req.params.id]);
    if (!row) return res.status(404).json({ success: false, message: 'Write-off tidak ditemukan.' });
    res.json({ success: true, data: row });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// POST /api/writeoff — create writeoff (batch)
// ══════════════════════════════════════════════
router.post('/', auth(WRITE_ROLES), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { cabang_id, items } = req.body;

    if (!cabang_id) return res.status(400).json({ success: false, message: 'Cabang wajib diisi.' });
    if (!items?.length) return res.status(400).json({ success: false, message: 'Items kosong.' });

    const [[cab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(400).json({ success: false, message: 'Cabang tidak ditemukan.' });

    const tanggal = new Date().toISOString().slice(0, 10);
    const insertedIds = [];
    let totalKerugian = 0;

    for (const item of items) {
      const produk_id = parseInt(item.produk_id);
      const qty       = parseInt(item.qty) || 0;
      const tipe      = item.tipe;
      const alasan    = item.alasan || null;

      if (!produk_id || qty <= 0) continue;
      if (!['expired','rusak','hilang','lainnya'].includes(tipe)) continue;

      // Get harga_modal for nilai_kerugian
      const [[produk]] = await conn.query('SELECT nama, harga_modal FROM pos_produk WHERE id=?', [produk_id]);
      if (!produk) continue;

      const nilai_kerugian = qty * (produk.harga_modal || 0);
      totalKerugian += nilai_kerugian;

      // Insert writeoff record
      const [result] = await conn.query(
        `INSERT INTO stok_writeoff (cabang_id, produk_id, qty, tipe, alasan, nilai_kerugian, user_id, tanggal)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cabang_id, produk_id, qty, tipe, alasan, nilai_kerugian, req.user.id, tanggal]
      );
      insertedIds.push(result.insertId);

      // Reduce pos_stok
      await conn.query(
        `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,0) ON DUPLICATE KEY UPDATE qty=GREATEST(0, qty-?)`,
        [produk_id, cabang_id, qty]
      );

      // Log to pos_stok_log
      await conn.query(
        `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id) VALUES (?,?,'keluar',?,?,?)`,
        [produk_id, cabang_id, qty, `Write-off ${tipe}: ${produk.nama} (${alasan || '-'})`, req.user.id]
      ).catch(() => {});
    }

    if (!insertedIds.length) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Tidak ada item valid untuk di-writeoff.' });
    }

    await conn.commit();
    audit(req, 'create', 'writeoff', insertedIds.join(','), `${insertedIds.length} item writeoff`, {
      cabang_id, cabang_nama: cab.nama, jumlah_item: insertedIds.length, total_kerugian: totalKerugian
    });
    res.json({
      success: true,
      message: `${insertedIds.length} item berhasil di-writeoff. Total kerugian: Rp ${totalKerugian.toLocaleString('id-ID')}.`,
      data: { ids: insertedIds, total_kerugian: totalKerugian }
    });
  } catch(e) { await conn.rollback(); res.status(500).json({ success: false, message: e.message }); }
  finally { conn.release(); }
});

module.exports = router;
