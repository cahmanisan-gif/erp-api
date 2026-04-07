const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { getCabangAkses } = require('../middleware/cabangFilter');

// ─── GET /api/best-seller ────────────────────────────────────────
// Barang terlaris global (semua cabang atau filter cabang_id)
// Query: ?periode=hari|bulan|tahun &tanggal=2026-04-07 &cabang_id=6 &limit=20
router.get('/', auth(), async (req, res) => {
  try {
    const { periode = 'bulan', tanggal, limit: lim = 20 } = req.query;
    const tgl = tanggal || nowWIB();
    const maxRows = Math.min(parseInt(lim) || 20, 100);

    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);
    const { cabangWhere, cabangParams } = await buildCabangFilter(req);

    const [rows] = await db.query(`
      SELECT ti.produk_id,
             ti.nama_produk,
             p.sku, p.kategori, p.foto_url,
             SUM(ti.qty)                         AS total_qty,
             SUM(ti.subtotal)                    AS total_omzet,
             COUNT(DISTINCT t.id)                AS total_transaksi,
             COUNT(DISTINCT t.cabang_id)         AS jumlah_cabang
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        LEFT JOIN pos_produk p ON p.id = ti.produk_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
       GROUP BY ti.produk_id, ti.nama_produk, p.sku, p.kategori, p.foto_url
       ORDER BY total_qty DESC
       LIMIT ?
    `, [...dateParams, ...cabangParams, maxRows]);

    res.json({ success: true, data: rows, periode, tanggal: tgl });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/best-seller/:produk_id/detail ──────────────────────
// Detail barang terlaris: breakdown per cabang + per hari/bulan/tahun
// Query: ?periode=bulan &tanggal=2026-04-07 &cabang_id=6
router.get('/:produk_id/detail', auth(), async (req, res) => {
  try {
    const { produk_id } = req.params;
    const { periode = 'bulan', tanggal } = req.query;
    const tgl = tanggal || nowWIB();

    const { cabangWhere, cabangParams } = await buildCabangFilter(req);

    // Info produk
    const [[produk]] = await db.query(
      'SELECT id, sku, nama, kategori, harga_jual, harga_modal, foto_url FROM pos_produk WHERE id=?',
      [produk_id]);
    if (!produk) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });

    // 1) Per Cabang (dalam periode yang dipilih)
    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);
    const [perCabang] = await db.query(`
      SELECT t.cabang_id,
             c.nama     AS nama_cabang,
             c.kode     AS kode_cabang,
             SUM(ti.qty)      AS total_qty,
             SUM(ti.subtotal) AS total_omzet,
             COUNT(DISTINCT t.id) AS total_transaksi
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        JOIN cabang c        ON c.id = t.cabang_id
       WHERE t.status = 'selesai'
         AND ti.produk_id = ?
         ${dateFilter}
         ${cabangWhere}
       GROUP BY t.cabang_id, c.nama, c.kode
       ORDER BY total_qty DESC
    `, [produk_id, ...dateParams, ...cabangParams]);

    // 2) Per Hari (30 hari terakhir dari tanggal)
    const [perHari] = await db.query(`
      SELECT DATE(CONVERT_TZ(t.created_at,'+00:00','+07:00')) AS tanggal,
             SUM(ti.qty)      AS total_qty,
             SUM(ti.subtotal) AS total_omzet
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
       WHERE t.status = 'selesai'
         AND ti.produk_id = ?
         AND t.created_at >= CONVERT_TZ(DATE_SUB(?, INTERVAL 29 DAY),'+07:00','+00:00')
         AND t.created_at <  CONVERT_TZ(DATE_ADD(?, INTERVAL 1 DAY),'+07:00','+00:00')
         ${cabangWhere}
       GROUP BY tanggal
       ORDER BY tanggal ASC
    `, [produk_id, tgl, tgl, ...cabangParams]);

    // 3) Per Bulan (12 bulan terakhir)
    const [perBulan] = await db.query(`
      SELECT DATE_FORMAT(CONVERT_TZ(t.created_at,'+00:00','+07:00'), '%Y-%m') AS bulan,
             SUM(ti.qty)      AS total_qty,
             SUM(ti.subtotal) AS total_omzet
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
       WHERE t.status = 'selesai'
         AND ti.produk_id = ?
         AND t.created_at >= CONVERT_TZ(DATE_FORMAT(DATE_SUB(?, INTERVAL 11 MONTH), '%Y-%m-01'),'+07:00','+00:00')
         AND t.created_at <  CONVERT_TZ(DATE_ADD(?, INTERVAL 1 DAY),'+07:00','+00:00')
         ${cabangWhere}
       GROUP BY bulan
       ORDER BY bulan ASC
    `, [produk_id, tgl, tgl, ...cabangParams]);

    // 4) Per Tahun (semua data)
    const [perTahun] = await db.query(`
      SELECT YEAR(CONVERT_TZ(t.created_at,'+00:00','+07:00')) AS tahun,
             SUM(ti.qty)      AS total_qty,
             SUM(ti.subtotal) AS total_omzet
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
       WHERE t.status = 'selesai'
         AND ti.produk_id = ?
         ${cabangWhere}
       GROUP BY tahun
       ORDER BY tahun ASC
    `, [produk_id, ...cabangParams]);

    // 5) Ringkasan total (dalam periode) — SUM() returns string dari mysql2
    const totalQty   = perCabang.reduce((s, r) => s + Number(r.total_qty), 0);
    const totalOmzet = perCabang.reduce((s, r) => s + Number(r.total_omzet), 0);
    const totalTrx   = perCabang.reduce((s, r) => s + Number(r.total_transaksi), 0);

    res.json({
      success: true,
      data: {
        produk,
        ringkasan: { total_qty: totalQty, total_omzet: totalOmzet, total_transaksi: totalTrx },
        per_cabang: perCabang,
        per_hari:   perHari,
        per_bulan:  perBulan,
        per_tahun:  perTahun,
      },
      periode,
      tanggal: tgl,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/best-seller/cabang/:cabang_id ──────────────────────
// Top produk terlaris untuk 1 cabang tertentu
// Query: ?periode=bulan &tanggal=2026-04-07 &limit=20
router.get('/cabang/:cabang_id', auth(), async (req, res) => {
  try {
    const { cabang_id } = req.params;
    const { periode = 'bulan', tanggal, limit: lim = 20 } = req.query;
    const tgl = tanggal || nowWIB();
    const maxRows = Math.min(parseInt(lim) || 20, 100);

    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);

    // Nama cabang
    const [[cab]] = await db.query('SELECT id, kode, nama FROM cabang WHERE id=?', [cabang_id]);
    if (!cab) return res.status(404).json({ success: false, message: 'Cabang tidak ditemukan.' });

    const [rows] = await db.query(`
      SELECT ti.produk_id,
             ti.nama_produk,
             p.sku, p.kategori, p.foto_url,
             SUM(ti.qty)                   AS total_qty,
             SUM(ti.subtotal)              AS total_omzet,
             COUNT(DISTINCT t.id)          AS total_transaksi
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        LEFT JOIN pos_produk p ON p.id = ti.produk_id
       WHERE t.status = 'selesai'
         AND t.cabang_id = ?
         ${dateFilter}
       GROUP BY ti.produk_id, ti.nama_produk, p.sku, p.kategori, p.foto_url
       ORDER BY total_qty DESC
       LIMIT ?
    `, [cabang_id, ...dateParams, maxRows]);

    res.json({ success: true, data: rows, cabang: cab, periode, tanggal: tgl });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════

// Tanggal hari ini dalam WIB (server di UTC)
function nowWIB() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

function buildDateFilter(periode, tgl) {
  switch (periode) {
    case 'hari':
      return {
        dateFilter: `AND t.created_at >= CONVERT_TZ(?,'+07:00','+00:00')
                      AND t.created_at <  CONVERT_TZ(DATE_ADD(?, INTERVAL 1 DAY),'+07:00','+00:00')`,
        params: [tgl, tgl],
      };
    case 'tahun': {
      const y = tgl.slice(0, 4);
      return {
        dateFilter: `AND t.created_at >= CONVERT_TZ(?,'+07:00','+00:00')
                      AND t.created_at <  CONVERT_TZ(?,'+07:00','+00:00')`,
        params: [`${y}-01-01`, `${parseInt(y) + 1}-01-01`],
      };
    }
    case 'bulan':
    default: {
      const ym = tgl.slice(0, 7);
      const [yr, mo] = ym.split('-').map(Number);
      const nextMonth = mo === 12 ? `${yr + 1}-01-01` : `${yr}-${String(mo + 1).padStart(2, '0')}-01`;
      return {
        dateFilter: `AND t.created_at >= CONVERT_TZ(?,'+07:00','+00:00')
                      AND t.created_at <  CONVERT_TZ(?,'+07:00','+00:00')`,
        params: [`${ym}-01`, nextMonth],
      };
    }
  }
}

// Filter cabang berdasarkan hak akses user + optional query cabang_id
async function buildCabangFilter(req) {
  // Jika ada query cabang_id spesifik, gunakan itu
  if (req.query.cabang_id) {
    return { cabangWhere: 'AND t.cabang_id = ?', cabangParams: [parseInt(req.query.cabang_id)] };
  }
  // Pakai hak akses dari cabangFilter middleware
  const allowed = await getCabangAkses(req.user);
  if (allowed === null) {
    // null = semua cabang (owner/admin)
    return { cabangWhere: '', cabangParams: [] };
  }
  if (!allowed.length) {
    return { cabangWhere: 'AND 1=0', cabangParams: [] }; // no access
  }
  const ph = allowed.map(() => '?').join(',');
  return { cabangWhere: `AND t.cabang_id IN (${ph})`, cabangParams: allowed };
}

module.exports = router;
