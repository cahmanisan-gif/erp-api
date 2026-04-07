const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

const DEFAULT_STOK_MINIMUM = 5;
const PERIODE_HARI = 30;

// ── Helper: Generate nomor pembelian (PB-YYYYMM-NNNN) ──
async function genNomor(conn) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `PB-${y}${m}-`;
  const [[row]] = await conn.query(
    "SELECT COUNT(*) as c FROM pembelian_barang WHERE nomor LIKE ?",
    [`${prefix}%`]
  );
  const n = String((row.c || 0) + 1).padStart(4, '0');
  return `${prefix}${n}`;
}

// ═══════════════════════════════════════════════════════════
// GET /api/reorder/suggestion?cabang_id=3
// List products where stock <= stok_minimum with reorder info
// ═══════════════════════════════════════════════════════════
router.get('/suggestion', auth(), async (req, res) => {
  try {
    const cabang_id = parseInt(req.query.cabang_id);
    if (!cabang_id) {
      return res.status(400).json({ success: false, message: 'cabang_id wajib.' });
    }

    // Main query: products at or below minimum stock with sales velocity
    const [rows] = await db.query(`
      SELECT
        p.id            AS produk_id,
        p.nama,
        p.sku,
        p.kategori,
        p.harga_modal,
        p.harga_jual,
        CASE WHEN p.stok_minimum > 0 THEN p.stok_minimum ELSE ? END AS stok_minimum,
        COALESCE(s.qty, 0) AS stok_sekarang,
        COALESCE(v.total_terjual, 0) AS total_terjual_30d,
        ROUND(COALESCE(v.total_terjual, 0) / ?, 2) AS avg_daily_sales,
        CASE
          WHEN COALESCE(v.total_terjual, 0) = 0 THEN 9999
          ELSE ROUND(COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?), 1)
        END AS days_until_empty
      FROM pos_produk p
      LEFT JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
      LEFT JOIN (
        SELECT ti.produk_id, SUM(ti.qty) AS total_terjual
        FROM pos_transaksi_item ti
        INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
        WHERE t.cabang_id = ?
          AND t.status = 'selesai'
          AND CONVERT_TZ(t.created_at, '+00:00', '+07:00') >= DATE_SUB(CONVERT_TZ(NOW(), '+00:00', '+07:00'), INTERVAL ? DAY)
        GROUP BY ti.produk_id
      ) v ON v.produk_id = p.id
      WHERE p.aktif = 1
        AND COALESCE(s.qty, 0) <= CASE WHEN p.stok_minimum > 0 THEN p.stok_minimum ELSE ? END
      ORDER BY
        COALESCE(s.qty, 0) = 0 DESC,
        CASE
          WHEN COALESCE(v.total_terjual, 0) = 0 THEN 9999
          ELSE COALESCE(s.qty, 0) / (COALESCE(v.total_terjual, 0) / ?)
        END ASC,
        p.nama ASC
    `, [
      DEFAULT_STOK_MINIMUM,
      PERIODE_HARI, PERIODE_HARI,
      cabang_id, cabang_id, PERIODE_HARI,
      DEFAULT_STOK_MINIMUM,
      PERIODE_HARI
    ]);

    if (!rows.length) {
      return res.json({ success: true, data: [], message: 'Tidak ada produk yang perlu reorder.' });
    }

    // Fetch last purchase info for all matching products in one query
    const produkIds = rows.map(r => r.produk_id);
    const placeholders = produkIds.map(() => '?').join(',');

    const [lastPurchaseRows] = await db.query(`
      SELECT
        bi.produk_id,
        pb.supplier_id,
        COALESCE(sup.nama, pb.nama_supplier) AS last_supplier,
        bi.harga_modal AS last_harga,
        pb.tanggal AS last_purchase_date
      FROM pembelian_barang_item bi
      INNER JOIN pembelian_barang pb ON bi.pembelian_id = pb.id
      LEFT JOIN supplier sup ON pb.supplier_id = sup.id
      WHERE bi.produk_id IN (${placeholders})
        AND pb.status = 'diterima'
      ORDER BY pb.tanggal DESC, pb.id DESC
    `, produkIds);

    // Keep only the most recent purchase per product
    const purchaseMap = {};
    for (const lp of lastPurchaseRows) {
      if (!purchaseMap[lp.produk_id]) {
        purchaseMap[lp.produk_id] = lp;
      }
    }

    // Build final response
    const data = rows.map(r => {
      const avg_daily = r.avg_daily_sales;
      const saran_qty = Math.max(1, Math.ceil(avg_daily * PERIODE_HARI) - r.stok_sekarang);
      const purchase = purchaseMap[r.produk_id] || null;

      return {
        produk_id:          r.produk_id,
        nama:               r.nama,
        sku:                r.sku,
        kategori:           r.kategori,
        stok_sekarang:      r.stok_sekarang,
        stok_minimum:       r.stok_minimum,
        avg_daily_sales:    avg_daily,
        saran_qty:          saran_qty,
        days_until_empty:   r.days_until_empty,
        last_supplier:      purchase ? purchase.last_supplier : null,
        last_supplier_id:   purchase ? purchase.supplier_id : null,
        last_harga:         purchase ? Number(purchase.last_harga) : null,
        last_purchase_date: purchase ? purchase.last_purchase_date : null
      };
    });

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GET /api/reorder/summary
// Summary across all cabang: habis, kritis, nilai PO saran
// ═══════════════════════════════════════════════════════════
router.get('/summary', auth(), async (req, res) => {
  try {
    const [cabangList] = await db.query(
      "SELECT id, kode, nama FROM cabang WHERE aktif = 1 ORDER BY kode ASC"
    );

    const result = [];

    for (const cab of cabangList) {
      const [[summary]] = await db.query(`
        SELECT
          SUM(CASE WHEN stok_sekarang = 0 THEN 1 ELSE 0 END) AS produk_habis,
          SUM(CASE WHEN stok_sekarang > 0 AND stok_sekarang <= stok_min THEN 1 ELSE 0 END) AS produk_kritis,
          SUM(saran_nilai) AS total_nilai_po
        FROM (
          SELECT
            COALESCE(s.qty, 0) AS stok_sekarang,
            CASE WHEN p.stok_minimum > 0 THEN p.stok_minimum ELSE ? END AS stok_min,
            ROUND(COALESCE(v.total_terjual, 0) / ?, 2) AS avg_daily,
            GREATEST(1, CEIL(COALESCE(v.total_terjual, 0) / ? * ?) - COALESCE(s.qty, 0)) * p.harga_modal AS saran_nilai
          FROM pos_produk p
          LEFT JOIN pos_stok s ON s.produk_id = p.id AND s.cabang_id = ?
          LEFT JOIN (
            SELECT ti.produk_id, SUM(ti.qty) AS total_terjual
            FROM pos_transaksi_item ti
            INNER JOIN pos_transaksi t ON ti.transaksi_id = t.id
            WHERE t.cabang_id = ?
              AND t.status = 'selesai'
              AND CONVERT_TZ(t.created_at, '+00:00', '+07:00') >= DATE_SUB(CONVERT_TZ(NOW(), '+00:00', '+07:00'), INTERVAL ? DAY)
            GROUP BY ti.produk_id
          ) v ON v.produk_id = p.id
          WHERE p.aktif = 1
            AND COALESCE(s.qty, 0) <= CASE WHEN p.stok_minimum > 0 THEN p.stok_minimum ELSE ? END
        ) sub
      `, [
        DEFAULT_STOK_MINIMUM,
        PERIODE_HARI, PERIODE_HARI, PERIODE_HARI,
        cab.id, cab.id, PERIODE_HARI,
        DEFAULT_STOK_MINIMUM
      ]);

      const produk_habis   = summary.produk_habis   || 0;
      const produk_kritis  = summary.produk_kritis   || 0;
      const total_nilai_po = Number(summary.total_nilai_po) || 0;

      // Only include branches that have at least one product needing reorder
      if (produk_habis > 0 || produk_kritis > 0) {
        result.push({
          cabang_id:      cab.id,
          kode:           cab.kode,
          nama:           cab.nama,
          produk_habis,
          produk_kritis,
          total_nilai_po
        });
      }
    }

    // Sort: most urgent first (habis desc, then kritis desc)
    result.sort((a, b) => b.produk_habis - a.produk_habis || b.produk_kritis - a.produk_kritis);

    const grand = {
      total_cabang_butuh_reorder: result.length,
      total_produk_habis:         result.reduce((s, r) => s + r.produk_habis, 0),
      total_produk_kritis:        result.reduce((s, r) => s + r.produk_kritis, 0),
      total_nilai_po:             result.reduce((s, r) => s + r.total_nilai_po, 0)
    };

    res.json({ success: true, data: result, summary: grand });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/reorder/create-po
// Auto-create pembelian_barang draft from reorder suggestion
// Body: { supplier_id, cabang_id, items: [{produk_id, qty, harga}] }
// ═══════════════════════════════════════════════════════════
router.post('/create-po', auth(['owner', 'manajer', 'head_operational', 'admin_pusat']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { supplier_id, cabang_id, items } = req.body;
    if (!cabang_id)     return res.status(400).json({ success: false, message: 'cabang_id wajib.' });
    if (!items?.length) return res.status(400).json({ success: false, message: 'items wajib (min 1).' });

    // Validate supplier
    let nama_supplier = 'Tanpa Supplier';
    if (supplier_id) {
      const [[sup]] = await conn.query('SELECT nama FROM supplier WHERE id = ?', [supplier_id]);
      if (!sup) return res.status(404).json({ success: false, message: 'Supplier tidak ditemukan.' });
      nama_supplier = sup.nama;
    }

    // Validate cabang
    const [[cab]] = await conn.query('SELECT nama FROM cabang WHERE id = ?', [cabang_id]);
    if (!cab) return res.status(404).json({ success: false, message: 'Cabang tidak ditemukan.' });

    // Validate & resolve product names for items
    const resolvedItems = [];
    for (const item of items) {
      if (!item.produk_id || !item.qty || item.qty <= 0) {
        return res.status(400).json({ success: false, message: 'Setiap item harus punya produk_id dan qty > 0.' });
      }
      const [[prod]] = await conn.query('SELECT id, nama, harga_modal FROM pos_produk WHERE id = ?', [item.produk_id]);
      if (!prod) {
        return res.status(404).json({ success: false, message: `Produk id ${item.produk_id} tidak ditemukan.` });
      }
      resolvedItems.push({
        produk_id:   prod.id,
        nama_barang: prod.nama,
        qty:         parseInt(item.qty),
        harga_modal: parseFloat(item.harga) || prod.harga_modal,
        harga_jual:  0
      });
    }

    const nomor    = await genNomor(conn);
    const subtotal = resolvedItems.reduce((s, i) => s + (i.qty * i.harga_modal), 0);
    const tanggal  = new Date().toISOString().slice(0, 10);

    const [ins] = await conn.query(
      `INSERT INTO pembelian_barang
        (nomor, supplier_id, nama_supplier, cabang_id, tanggal, subtotal, total, catatan, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nomor,
        supplier_id || null,
        nama_supplier,
        cabang_id,
        tanggal,
        subtotal,
        subtotal,
        'Auto-generated dari reorder suggestion',
        req.user.id
      ]
    );
    const pbId = ins.insertId;

    for (const item of resolvedItems) {
      await conn.query(
        `INSERT INTO pembelian_barang_item (pembelian_id, produk_id, nama_barang, qty, harga_modal, harga_jual)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pbId, item.produk_id, item.nama_barang, item.qty, item.harga_modal, item.harga_jual]
      );
    }

    await conn.commit();

    audit(req, 'create', 'reorder-po', pbId, nomor, {
      supplier: nama_supplier,
      cabang_id,
      total_items: resolvedItems.length,
      subtotal
    });

    res.json({
      success: true,
      message: `Draft PO ${nomor} berhasil dibuat (${resolvedItems.length} item).`,
      id:     pbId,
      nomor
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ success: false, message: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
