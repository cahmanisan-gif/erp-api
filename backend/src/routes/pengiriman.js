const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

const WRITE_ROLES = ['owner','manajer','head_operational','admin_pusat'];

// ══════════════════════════════════════════════
// GET /api/pengiriman/transit — all in-transit deliveries
// ══════════════════════════════════════════════
router.get('/transit', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT sj.*, c1.nama AS dari_cabang, c2.nama AS ke_cabang,
             u.nama_lengkap AS pengirim_nama,
             TIMESTAMPDIFF(HOUR, sj.waktu_kirim, NOW()) AS jam_transit,
             TIMESTAMPDIFF(DAY, sj.waktu_kirim, NOW()) AS hari_transit
      FROM surat_jalan sj
      LEFT JOIN cabang c1 ON c1.id=sj.dari_cabang_id
      LEFT JOIN cabang c2 ON c2.id=sj.ke_cabang_id
      LEFT JOIN users u ON u.id=sj.pengirim_id
      WHERE sj.status='dikirim'
      ORDER BY sj.waktu_kirim ASC
    `);
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// GET /api/pengiriman/dashboard — delivery stats
// ══════════════════════════════════════════════
router.get('/dashboard', auth(), async (req, res) => {
  try {
    const bulanIni = new Date().toISOString().slice(0, 7); // YYYY-MM

    // Status counts
    const [[counts]] = await db.query(`
      SELECT
        SUM(status='disiapkan') AS total_disiapkan,
        SUM(status='dikirim')   AS total_dikirim,
        SUM(status='diterima' AND DATE_FORMAT(waktu_terima, '%Y-%m')=?) AS total_diterima_bulan_ini,
        SUM(status='batal')     AS total_batal
      FROM surat_jalan
    `, [bulanIni]);

    // Average delivery time (hours) for completed deliveries this month
    const [[avgRow]] = await db.query(`
      SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, waktu_kirim, waktu_terima)), 1) AS avg_jam_pengiriman
      FROM surat_jalan
      WHERE status='diterima' AND waktu_kirim IS NOT NULL AND waktu_terima IS NOT NULL
        AND DATE_FORMAT(waktu_terima, '%Y-%m')=?
    `, [bulanIni]);

    // Shrinkage: total items where qty_diterima < qty
    const [[shrinkRow]] = await db.query(`
      SELECT COALESCE(SUM(si.qty - si.qty_diterima), 0) AS total_shrinkage
      FROM surat_jalan_item si
      JOIN surat_jalan sj ON sj.id=si.surat_jalan_id
      WHERE sj.status='diterima' AND si.qty_diterima IS NOT NULL AND si.qty_diterima < si.qty
        AND DATE_FORMAT(sj.waktu_terima, '%Y-%m')=?
    `, [bulanIni]);

    res.json({
      success: true,
      data: {
        total_disiapkan: Number(counts.total_disiapkan) || 0,
        total_dikirim: Number(counts.total_dikirim) || 0,
        total_diterima_bulan_ini: Number(counts.total_diterima_bulan_ini) || 0,
        total_batal: Number(counts.total_batal) || 0,
        avg_jam_pengiriman: Number(avgRow.avg_jam_pengiriman) || 0,
        total_shrinkage: Number(shrinkRow.total_shrinkage) || 0
      }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// GET /api/pengiriman/shrinkage — shrinkage detail by product
// ══════════════════════════════════════════════
router.get('/shrinkage', auth(), async (req, res) => {
  try {
    const { bulan } = req.query;
    let where = `sj.status='diterima' AND si.qty_diterima IS NOT NULL AND si.qty_diterima < si.qty`;
    const params = [];
    if (bulan) { where += ` AND DATE_FORMAT(sj.waktu_terima, '%Y-%m')=?`; params.push(bulan); }

    const [rows] = await db.query(`
      SELECT si.produk_id, p.nama AS produk_nama, p.sku, p.harga_modal,
             SUM(si.qty) AS total_kirim,
             SUM(si.qty_diterima) AS total_terima,
             SUM(si.qty - si.qty_diterima) AS total_selisih,
             SUM((si.qty - si.qty_diterima) * p.harga_modal) AS nilai_kerugian,
             COUNT(DISTINCT sj.id) AS jumlah_sj
      FROM surat_jalan_item si
      JOIN surat_jalan sj ON sj.id=si.surat_jalan_id
      LEFT JOIN pos_produk p ON p.id=si.produk_id
      WHERE ${where}
      GROUP BY si.produk_id
      ORDER BY total_selisih DESC
    `, params);

    const totalSelisih  = rows.reduce((s, r) => s + (Number(r.total_selisih) || 0), 0);
    const totalKerugian = rows.reduce((s, r) => s + (Number(r.nilai_kerugian) || 0), 0);

    res.json({
      success: true,
      data: rows,
      summary: { total_selisih: totalSelisih, total_kerugian: totalKerugian }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// PATCH /api/pengiriman/:id/kirim — mark as sent + deduct stock
// ══════════════════════════════════════════════
router.patch('/:id/kirim', auth(WRITE_ROLES), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[sj]] = await conn.query('SELECT * FROM surat_jalan WHERE id=?', [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });
    if (sj.status !== 'disiapkan') return res.status(400).json({ success: false, message: `Tidak bisa kirim, status: ${sj.status}.` });

    const [[keCab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [sj.ke_cabang_id]);
    const keNama = keCab?.nama || ('Cabang #' + sj.ke_cabang_id);

    // Get items
    const [items] = await conn.query('SELECT * FROM surat_jalan_item WHERE surat_jalan_id=?', [sj.id]);

    // Deduct stock from dari_cabang_id
    for (const item of items) {
      await conn.query(
        `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,0) ON DUPLICATE KEY UPDATE qty=GREATEST(0, qty-?)`,
        [item.produk_id, sj.dari_cabang_id, item.qty]
      );
      await conn.query(
        `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id, referensi_id) VALUES (?,?,'transfer_keluar',?,?,?,?)`,
        [item.produk_id, sj.dari_cabang_id, item.qty, `SJ ${sj.nomor} kirim ke ${keNama}`, req.user.id, sj.nomor]
      ).catch(() => {});
    }

    // Update status
    await conn.query(
      `UPDATE surat_jalan SET status='dikirim', waktu_kirim=NOW(), pengirim_id=? WHERE id=?`,
      [req.user.id, sj.id]
    );

    await conn.commit();
    audit(req, 'update', 'pengiriman', sj.id, sj.nomor, { aksi: 'kirim', items_count: items.length });
    res.json({ success: true, message: `Surat jalan ${sj.nomor} dikirim. Stok asal dikurangi.` });
  } catch(e) { await conn.rollback(); res.status(500).json({ success: false, message: e.message }); }
  finally { conn.release(); }
});

// ══════════════════════════════════════════════
// PATCH /api/pengiriman/:id/terima — receive + add stock + log shrinkage
// ══════════════════════════════════════════════
router.patch('/:id/terima', auth(), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[sj]] = await conn.query('SELECT * FROM surat_jalan WHERE id=?', [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });
    if (sj.status !== 'dikirim') return res.status(400).json({ success: false, message: `Tidak bisa terima, status: ${sj.status}.` });

    const [[dariCab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [sj.dari_cabang_id]);
    const dariNama = dariCab?.nama || ('Cabang #' + sj.dari_cabang_id);

    // Get items
    const [items] = await conn.query('SELECT * FROM surat_jalan_item WHERE surat_jalan_id=?', [sj.id]);

    // Build map from request body
    const terimaMap = {};
    if (req.body.items?.length) {
      for (const it of req.body.items) {
        terimaMap[it.surat_jalan_item_id] = parseInt(it.qty_diterima) || 0;
      }
    }

    let totalShrinkage = 0;

    for (const item of items) {
      const qtyTerima = terimaMap[item.id] !== undefined ? terimaMap[item.id] : item.qty;
      const finalQty  = Math.max(0, Math.min(qtyTerima, item.qty));

      // Update qty_diterima
      await conn.query('UPDATE surat_jalan_item SET qty_diterima=? WHERE id=?', [finalQty, item.id]);

      // Add stock to ke_cabang_id
      if (finalQty > 0) {
        await conn.query(
          `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=qty+?`,
          [item.produk_id, sj.ke_cabang_id, finalQty, finalQty]
        );
        await conn.query(
          `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id, referensi_id) VALUES (?,?,'transfer_masuk',?,?,?,?)`,
          [item.produk_id, sj.ke_cabang_id, finalQty, `SJ ${sj.nomor} terima dari ${dariNama}`, req.user.id, sj.nomor]
        ).catch(() => {});
      }

      // Log shrinkage if any
      const selisih = item.qty - finalQty;
      if (selisih > 0) {
        totalShrinkage += selisih;
        await conn.query(
          `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id, referensi_id) VALUES (?,?,'keluar',?,?,?,?)`,
          [item.produk_id, sj.ke_cabang_id, selisih, `Shrinkage SJ ${sj.nomor}: kirim ${item.qty} terima ${finalQty}`, req.user.id, sj.nomor]
        ).catch(() => {});
      }
    }

    // Update surat jalan status
    await conn.query(
      `UPDATE surat_jalan SET status='diterima', waktu_terima=NOW(), penerima_id=? WHERE id=?`,
      [req.user.id, sj.id]
    );

    await conn.commit();
    audit(req, 'update', 'pengiriman', sj.id, sj.nomor, {
      aksi: 'terima', penerima: req.user.id, total_shrinkage: totalShrinkage
    });
    res.json({
      success: true,
      message: `Surat jalan ${sj.nomor} diterima.${totalShrinkage > 0 ? ` Shrinkage: ${totalShrinkage} item.` : ''}`,
      data: { total_shrinkage: totalShrinkage }
    });
  } catch(e) { await conn.rollback(); res.status(500).json({ success: false, message: e.message }); }
  finally { conn.release(); }
});

module.exports = router;
