const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// Gudang IDs to exclude from velocity calculations (warehouses, not retail)
const GUDANG_IDS = [3, 4];

// ── GET /velocity — Sales velocity per produk ──
// Query: cabang_id (required), periode (default 30 days)
router.get('/velocity', auth(), async (req, res) => {
  try {
    const cabang_id = parseInt(req.query.cabang_id);
    const periode   = parseInt(req.query.periode) || 30;
    if (!cabang_id) return res.status(400).json({ success: false, message: 'cabang_id wajib.' });
    if (GUDANG_IDS.includes(cabang_id)) {
      return res.status(400).json({ success: false, message: 'Gudang tidak memiliki data velocity penjualan.' });
    }

    const [rows] = await db.query(`
      SELECT
        p.id          AS produk_id,
        p.nama,
        p.sku,
        p.kategori,
        p.harga_modal,
        p.harga_jual,
        p.stok_minimum,
        COALESCE(s.qty, 0)  AS stok_sekarang,
        COALESCE(v.total_terjual, 0) AS total_terjual,
        ROUND(COALESCE(v.total_terjual, 0) / ?, 2) AS avg_harian,
        CASE
          WHEN COALESCE(v.total_terjual, 0) = 0 THEN 9999
          ELSE ROUND(COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?), 1)
        END AS hari_tersisa
      FROM pos_produk p
      INNER JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
      LEFT JOIN (
        SELECT ti.produk_id, SUM(ti.qty) AS total_terjual
        FROM pos_transaksi_item ti
        INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
        WHERE t.cabang_id = ?
          AND t.status = 'selesai'
          AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY ti.produk_id
      ) v ON v.produk_id = p.id
      WHERE p.aktif = 1
      ORDER BY hari_tersisa ASC, p.nama ASC
    `, [periode, periode, cabang_id, cabang_id, periode]);

    // Add status label
    const data = rows.map(r => ({
      ...r,
      status: r.hari_tersisa < 7 ? 'kritis' : r.hari_tersisa < 14 ? 'warning' : 'aman'
    }));

    res.json({ success: true, data, periode });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /reorder — Auto-reorder suggestions ──
// Query: cabang_id (required)
router.get('/reorder', auth(), async (req, res) => {
  try {
    const cabang_id = parseInt(req.query.cabang_id);
    if (!cabang_id) return res.status(400).json({ success: false, message: 'cabang_id wajib.' });

    const periode = 30; // base calculation on last 30 days

    const [rows] = await db.query(`
      SELECT
        p.id          AS produk_id,
        p.nama,
        p.sku,
        p.kategori,
        p.harga_modal,
        p.harga_jual,
        p.stok_minimum,
        COALESCE(s.qty, 0)  AS stok_sekarang,
        COALESCE(v.total_terjual, 0) AS total_terjual,
        ROUND(COALESCE(v.total_terjual, 0) / ?, 2) AS avg_harian,
        CASE
          WHEN COALESCE(v.total_terjual, 0) = 0 THEN 9999
          ELSE ROUND(COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?), 1)
        END AS hari_tersisa
      FROM pos_produk p
      INNER JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
      LEFT JOIN (
        SELECT ti.produk_id, SUM(ti.qty) AS total_terjual
        FROM pos_transaksi_item ti
        INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
        WHERE t.cabang_id = ?
          AND t.status = 'selesai'
          AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY ti.produk_id
      ) v ON v.produk_id = p.id
      WHERE p.aktif = 1
        AND (
          COALESCE(s.qty, 0) <= p.stok_minimum
          OR (
            COALESCE(v.total_terjual, 0) > 0
            AND COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?) < 7
          )
        )
      ORDER BY p.kategori ASC, p.nama ASC
    `, [periode, periode, cabang_id, cabang_id, periode, periode]);

    // Calculate suggested reorder qty and attach last supplier
    const produkIds = rows.map(r => r.produk_id);
    let supplierMap = {};
    if (produkIds.length) {
      const placeholders = produkIds.map(() => '?').join(',');
      const [supplierRows] = await db.query(`
        SELECT bi.produk_id,
               pb.supplier_id,
               pb.nama_supplier,
               sup.no_hp AS supplier_hp,
               pb.tanggal AS last_order_date
        FROM pembelian_barang_item bi
        INNER JOIN pembelian_barang pb ON bi.pembelian_id = pb.id
        LEFT JOIN supplier sup ON pb.supplier_id = sup.id
        WHERE bi.produk_id IN (${placeholders})
          AND pb.status = 'diterima'
        ORDER BY pb.tanggal DESC
      `, produkIds);

      // Keep only the most recent supplier per produk
      for (const sr of supplierRows) {
        if (!supplierMap[sr.produk_id]) {
          supplierMap[sr.produk_id] = {
            supplier_id: sr.supplier_id,
            nama_supplier: sr.nama_supplier,
            supplier_hp: sr.supplier_hp,
            last_order_date: sr.last_order_date
          };
        }
      }
    }

    const data = rows.map(r => {
      const reorder_qty = Math.max(0, Math.ceil(r.avg_harian * 30) - r.stok_sekarang);
      const nilai_reorder = reorder_qty * r.harga_modal;
      return {
        ...r,
        status: r.hari_tersisa < 7 ? 'kritis' : 'warning',
        reorder_qty,
        nilai_reorder,
        supplier: supplierMap[r.produk_id] || null
      };
    });

    // Group by supplier for easy ordering
    const bySupplier = {};
    for (const item of data) {
      const key = item.supplier?.nama_supplier || 'Tanpa Supplier';
      if (!bySupplier[key]) {
        bySupplier[key] = {
          supplier_id: item.supplier?.supplier_id || null,
          nama_supplier: key,
          supplier_hp: item.supplier?.supplier_hp || null,
          items: [],
          total_nilai: 0
        };
      }
      bySupplier[key].items.push(item);
      bySupplier[key].total_nilai += item.nilai_reorder;
    }

    res.json({
      success: true,
      data,
      by_supplier: Object.values(bySupplier),
      summary: {
        total_produk: data.length,
        total_nilai: data.reduce((s, r) => s + r.nilai_reorder, 0),
        kritis: data.filter(r => r.status === 'kritis').length,
        warning: data.filter(r => r.status === 'warning').length
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /trend — Sales trend for specific product ──
// Query: produk_id (required), cabang_id (required), periode (default 90 days)
router.get('/trend', auth(), async (req, res) => {
  try {
    const produk_id = parseInt(req.query.produk_id);
    const cabang_id = parseInt(req.query.cabang_id);
    const periode   = parseInt(req.query.periode) || 90;
    if (!produk_id || !cabang_id) {
      return res.status(400).json({ success: false, message: 'produk_id dan cabang_id wajib.' });
    }

    // Weekly aggregation
    const [weeks] = await db.query(`
      SELECT
        YEARWEEK(t.created_at, 1) AS minggu,
        MIN(DATE(t.created_at))   AS week_start,
        MAX(DATE(t.created_at))   AS week_end,
        SUM(ti.qty)               AS total_qty,
        SUM(ti.subtotal)          AS total_revenue
      FROM pos_transaksi_item ti
      INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
      WHERE ti.produk_id = ?
        AND t.cabang_id = ?
        AND t.status = 'selesai'
        AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY YEARWEEK(t.created_at, 1)
      ORDER BY minggu ASC
    `, [produk_id, cabang_id, periode]);

    // Determine direction: compare last 2 weeks avg vs previous 2 weeks avg
    let direction = 'stable';
    if (weeks.length >= 4) {
      const recent  = (weeks[weeks.length - 1].total_qty + weeks[weeks.length - 2].total_qty) / 2;
      const earlier = (weeks[weeks.length - 3].total_qty + weeks[weeks.length - 4].total_qty) / 2;
      if (earlier > 0) {
        const change = (recent - earlier) / earlier;
        if (change > 0.15)       direction = 'rising';
        else if (change < -0.15) direction = 'declining';
      } else if (recent > 0) {
        direction = 'rising';
      }
    } else if (weeks.length >= 2) {
      const recent  = weeks[weeks.length - 1].total_qty;
      const earlier = weeks[0].total_qty;
      if (earlier > 0) {
        const change = (recent - earlier) / earlier;
        if (change > 0.15)       direction = 'rising';
        else if (change < -0.15) direction = 'declining';
      } else if (recent > 0) {
        direction = 'rising';
      }
    }

    // Get product info
    const [[produk]] = await db.query(
      `SELECT p.nama, p.sku, p.kategori, COALESCE(s.qty,0) AS stok_sekarang
       FROM pos_produk p
       LEFT JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
       WHERE p.id = ?`, [cabang_id, produk_id]
    );

    res.json({
      success: true,
      produk: produk || null,
      direction,
      weeks,
      periode
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /stockout-risk — Products at risk within 7 days ──
// Query: cabang_id (required)
router.get('/stockout-risk', auth(), async (req, res) => {
  try {
    const cabang_id = parseInt(req.query.cabang_id);
    if (!cabang_id) return res.status(400).json({ success: false, message: 'cabang_id wajib.' });
    if (GUDANG_IDS.includes(cabang_id)) {
      return res.status(400).json({ success: false, message: 'Gudang tidak memiliki data stockout risk.' });
    }

    const periode = 30;

    const [rows] = await db.query(`
      SELECT
        p.id          AS produk_id,
        p.nama,
        p.sku,
        p.kategori,
        p.harga_modal,
        COALESCE(s.qty, 0) AS stok_sekarang,
        ROUND(COALESCE(v.total_terjual, 0) / ?, 2) AS avg_harian,
        CASE
          WHEN COALESCE(v.total_terjual, 0) = 0 THEN 9999
          ELSE ROUND(COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?), 1)
        END AS hari_tersisa
      FROM pos_produk p
      INNER JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
      LEFT JOIN (
        SELECT ti.produk_id, SUM(ti.qty) AS total_terjual
        FROM pos_transaksi_item ti
        INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
        WHERE t.cabang_id = ?
          AND t.status = 'selesai'
          AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY ti.produk_id
      ) v ON v.produk_id = p.id
      WHERE p.aktif = 1
      HAVING hari_tersisa < 7 AND hari_tersisa != 9999
      ORDER BY hari_tersisa ASC
    `, [periode, periode, cabang_id, cabang_id, periode]);

    // Count per category
    const byKategori = {};
    let totalNilai = 0;
    for (const r of rows) {
      const kat = r.kategori || 'Tanpa Kategori';
      if (!byKategori[kat]) byKategori[kat] = { kategori: kat, count: 0, nilai_at_risk: 0 };
      byKategori[kat].count++;
      byKategori[kat].nilai_at_risk += r.stok_sekarang * r.harga_modal;
      totalNilai += r.stok_sekarang * r.harga_modal;
    }

    res.json({
      success: true,
      data: rows,
      by_kategori: Object.values(byKategori).sort((a, b) => b.count - a.count),
      summary: {
        total_at_risk: rows.length,
        total_nilai_stok: totalNilai
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /cabang-summary — Overview across all branches ──
router.get('/cabang-summary', auth(), async (req, res) => {
  try {
    const periode = 30;

    // Get all active retail branches (exclude gudang)
    const [cabangList] = await db.query(
      `SELECT id, kode, nama FROM cabang WHERE aktif = 1 AND id NOT IN (${GUDANG_IDS.join(',')}) ORDER BY kode ASC`
    );

    const results = [];
    for (const cab of cabangList) {
      const [[summary]] = await db.query(`
        SELECT
          COUNT(*) AS total_produk,
          SUM(CASE WHEN hari_tersisa < 7 AND hari_tersisa != 9999 THEN 1 ELSE 0 END) AS kritis,
          SUM(CASE WHEN hari_tersisa >= 7 AND hari_tersisa < 14 THEN 1 ELSE 0 END) AS warning,
          SUM(CASE WHEN hari_tersisa < 7 AND hari_tersisa != 9999 THEN stok_sekarang * harga_modal ELSE 0 END) AS nilai_kritis
        FROM (
          SELECT
            COALESCE(s.qty, 0) AS stok_sekarang,
            p.harga_modal,
            CASE
              WHEN COALESCE(v.total_terjual, 0) = 0 THEN 9999
              ELSE COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?)
            END AS hari_tersisa
          FROM pos_produk p
          INNER JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
          LEFT JOIN (
            SELECT ti.produk_id, SUM(ti.qty) AS total_terjual
            FROM pos_transaksi_item ti
            INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
            WHERE t.cabang_id = ?
              AND t.status = 'selesai'
              AND t.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY ti.produk_id
          ) v ON v.produk_id = p.id
          WHERE p.aktif = 1
        ) sub
      `, [periode, cab.id, cab.id, periode]);

      results.push({
        cabang_id: cab.id,
        kode: cab.kode,
        nama: cab.nama,
        total_produk: summary.total_produk || 0,
        kritis: summary.kritis || 0,
        warning: summary.warning || 0,
        nilai_kritis: summary.nilai_kritis || 0
      });
    }

    // Sort by kritis count desc
    results.sort((a, b) => b.kritis - a.kritis);

    res.json({
      success: true,
      data: results,
      summary: {
        total_cabang: results.length,
        total_kritis: results.reduce((s, r) => s + r.kritis, 0),
        total_warning: results.reduce((s, r) => s + r.warning, 0),
        total_nilai_kritis: results.reduce((s, r) => s + r.nilai_kritis, 0)
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
