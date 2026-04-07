const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { getCabangAkses } = require('../middleware/cabangFilter');

// ─── GET /api/margin/produk ─────────────────────────────────────
// Profit margin per produk
// Query: ?periode=bulan&tanggal=2026-04-07&cabang_id=6&limit=50
router.get('/produk', auth(), async (req, res) => {
  try {
    const { periode = 'bulan', tanggal, limit: lim = 50 } = req.query;
    const tgl = tanggal || nowWIB();
    const maxRows = Math.min(parseInt(lim) || 50, 200);

    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);
    const { cabangWhere, cabangParams } = await buildCabangFilter(req);

    const [rows] = await db.query(`
      SELECT ti.produk_id,
             ti.nama_produk,
             p.sku,
             p.kategori,
             SUM(ti.qty)                              AS total_qty,
             SUM(ti.subtotal)                         AS total_omzet,
             SUM(ti.harga_modal * ti.qty)             AS total_hpp,
             SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        LEFT JOIN pos_produk p ON p.id = ti.produk_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
       GROUP BY ti.produk_id, ti.nama_produk, p.sku, p.kategori
       ORDER BY laba_kotor DESC
       LIMIT ?
    `, [...dateParams, ...cabangParams, maxRows]);

    res.json({ success: true, data: rows, periode, tanggal: tgl });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/margin/kategori ───────────────────────────────────
// Profit margin per kategori
// Query: ?periode=bulan&tanggal=2026-04-07&cabang_id=6
router.get('/kategori', auth(), async (req, res) => {
  try {
    const { periode = 'bulan', tanggal } = req.query;
    const tgl = tanggal || nowWIB();

    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);
    const { cabangWhere, cabangParams } = await buildCabangFilter(req);

    const [rows] = await db.query(`
      SELECT COALESCE(p.kategori, 'Tanpa Kategori')  AS kategori,
             COUNT(DISTINCT ti.produk_id)             AS jumlah_produk,
             SUM(ti.qty)                              AS total_qty,
             SUM(ti.subtotal)                         AS total_omzet,
             SUM(ti.harga_modal * ti.qty)             AS total_hpp,
             SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        LEFT JOIN pos_produk p ON p.id = ti.produk_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
       GROUP BY p.kategori
       ORDER BY laba_kotor DESC
    `, [...dateParams, ...cabangParams]);

    res.json({ success: true, data: rows, periode, tanggal: tgl });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/margin/cabang ─────────────────────────────────────
// Profit margin per cabang
// Query: ?periode=bulan&tanggal=2026-04-07
router.get('/cabang', auth(), async (req, res) => {
  try {
    const { periode = 'bulan', tanggal } = req.query;
    const tgl = tanggal || nowWIB();

    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);
    const { cabangWhere, cabangParams } = await buildCabangFilter(req);

    const [rows] = await db.query(`
      SELECT t.cabang_id,
             c.kode                                   AS kode_cabang,
             c.nama                                   AS nama_cabang,
             COUNT(DISTINCT t.id)                     AS total_transaksi,
             SUM(ti.qty)                              AS total_qty,
             SUM(ti.subtotal)                         AS total_omzet,
             SUM(ti.harga_modal * ti.qty)             AS total_hpp,
             SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        JOIN cabang c        ON c.id = t.cabang_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
       GROUP BY t.cabang_id, c.kode, c.nama
       ORDER BY laba_kotor DESC
    `, [...dateParams, ...cabangParams]);

    res.json({ success: true, data: rows, periode, tanggal: tgl });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── GET /api/margin/ringkasan ──────────────────────────────────
// Grand total + top/bottom 5 + comparison with previous period
// Query: ?periode=bulan&tanggal=2026-04-07&cabang_id=6
router.get('/ringkasan', auth(), async (req, res) => {
  try {
    const { periode = 'bulan', tanggal } = req.query;
    const tgl = tanggal || nowWIB();

    const { dateFilter, params: dateParams } = buildDateFilter(periode, tgl);
    const { cabangWhere, cabangParams } = await buildCabangFilter(req);

    // 1) Grand total current period
    const [[grand]] = await db.query(`
      SELECT COUNT(DISTINCT t.id)                     AS total_transaksi,
             COALESCE(SUM(ti.qty), 0)                 AS total_qty,
             COALESCE(SUM(ti.subtotal), 0)            AS total_omzet,
             COALESCE(SUM(ti.harga_modal * ti.qty), 0) AS total_hpp,
             COALESCE(SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty), 0) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
    `, [...dateParams, ...cabangParams]);

    // 2) Top 5 most profitable products (by laba_kotor)
    const [top5] = await db.query(`
      SELECT ti.produk_id,
             ti.nama_produk,
             p.sku,
             p.kategori,
             SUM(ti.qty)                              AS total_qty,
             SUM(ti.subtotal)                         AS total_omzet,
             SUM(ti.harga_modal * ti.qty)             AS total_hpp,
             SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        LEFT JOIN pos_produk p ON p.id = ti.produk_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
       GROUP BY ti.produk_id, ti.nama_produk, p.sku, p.kategori
       ORDER BY laba_kotor DESC
       LIMIT 5
    `, [...dateParams, ...cabangParams]);

    // 3) Top 5 least profitable (lowest margin %, min 1 qty sold)
    const [bottom5] = await db.query(`
      SELECT ti.produk_id,
             ti.nama_produk,
             p.sku,
             p.kategori,
             SUM(ti.qty)                              AS total_qty,
             SUM(ti.subtotal)                         AS total_omzet,
             SUM(ti.harga_modal * ti.qty)             AS total_hpp,
             SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        LEFT JOIN pos_produk p ON p.id = ti.produk_id
       WHERE t.status = 'selesai'
         ${dateFilter}
         ${cabangWhere}
       GROUP BY ti.produk_id, ti.nama_produk, p.sku, p.kategori
       HAVING SUM(ti.qty) > 0
       ORDER BY margin_persen ASC
       LIMIT 5
    `, [...dateParams, ...cabangParams]);

    // 4) Previous period comparison
    const prevTgl = getPreviousPeriodDate(periode, tgl);
    const { dateFilter: prevDateFilter, params: prevDateParams } = buildDateFilter(periode, prevTgl);

    const [[prevGrand]] = await db.query(`
      SELECT COUNT(DISTINCT t.id)                     AS total_transaksi,
             COALESCE(SUM(ti.qty), 0)                 AS total_qty,
             COALESCE(SUM(ti.subtotal), 0)            AS total_omzet,
             COALESCE(SUM(ti.harga_modal * ti.qty), 0) AS total_hpp,
             COALESCE(SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty), 0) AS laba_kotor,
             CASE WHEN SUM(ti.subtotal) > 0
                  THEN ROUND((SUM(ti.subtotal) - SUM(ti.harga_modal * ti.qty)) / SUM(ti.subtotal) * 100, 2)
                  ELSE 0 END                          AS margin_persen
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
       WHERE t.status = 'selesai'
         ${prevDateFilter}
         ${cabangWhere}
    `, [...prevDateParams, ...cabangParams]);

    // Build comparison
    const perbandingan = {
      periode_sebelumnya: prevTgl,
      total_omzet:    Number(prevGrand.total_omzet),
      total_hpp:      Number(prevGrand.total_hpp),
      laba_kotor:     Number(prevGrand.laba_kotor),
      margin_persen:  Number(prevGrand.margin_persen),
      total_transaksi: Number(prevGrand.total_transaksi),
      selisih_omzet:      Number(grand.total_omzet)   - Number(prevGrand.total_omzet),
      selisih_laba_kotor: Number(grand.laba_kotor)     - Number(prevGrand.laba_kotor),
      selisih_margin:     Number(grand.margin_persen)  - Number(prevGrand.margin_persen),
      persen_perubahan_omzet: Number(prevGrand.total_omzet) > 0
        ? Math.round((Number(grand.total_omzet) - Number(prevGrand.total_omzet)) / Number(prevGrand.total_omzet) * 10000) / 100
        : null,
      persen_perubahan_laba: Number(prevGrand.laba_kotor) > 0
        ? Math.round((Number(grand.laba_kotor) - Number(prevGrand.laba_kotor)) / Number(prevGrand.laba_kotor) * 10000) / 100
        : null,
    };

    res.json({
      success: true,
      data: {
        ...grand,
        top5_laba:       top5,
        bottom5_margin:  bottom5,
        perbandingan,
      },
      periode,
      tanggal: tgl,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════

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

async function buildCabangFilter(req) {
  if (req.query.cabang_id) {
    return { cabangWhere: 'AND t.cabang_id = ?', cabangParams: [parseInt(req.query.cabang_id)] };
  }
  const allowed = await getCabangAkses(req.user);
  if (allowed === null) {
    return { cabangWhere: '', cabangParams: [] };
  }
  if (!allowed.length) {
    return { cabangWhere: 'AND 1=0', cabangParams: [] };
  }
  const ph = allowed.map(() => '?').join(',');
  return { cabangWhere: `AND t.cabang_id IN (${ph})`, cabangParams: allowed };
}

function getPreviousPeriodDate(periode, tgl) {
  switch (periode) {
    case 'hari': {
      const d = new Date(tgl + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    case 'tahun': {
      const y = parseInt(tgl.slice(0, 4));
      return `${y - 1}-01-01`;
    }
    case 'bulan':
    default: {
      const [yr, mo] = tgl.slice(0, 7).split('-').map(Number);
      const prevMo = mo === 1 ? 12 : mo - 1;
      const prevYr = mo === 1 ? yr - 1 : yr;
      return `${prevYr}-${String(prevMo).padStart(2, '0')}-01`;
    }
  }
}

module.exports = router;
