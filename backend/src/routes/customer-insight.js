const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

function segmenByValue(total) {
  if (total >= 10000000) return 'VIP';
  if (total >= 5000000)  return 'Gold';
  if (total >= 1000000)  return 'Silver';
  return 'Bronze';
}

function segmenByRecency(lastDate) {
  if (!lastDate) return 'Churned';
  const days = Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000);
  if (days <= 30)  return 'Active';
  if (days <= 90)  return 'Regular';
  if (days <= 180) return 'Dormant';
  return 'Churned';
}

// Build date range for periode filter (WIB-aware: UTC+7)
function periodeRange(periode, tanggal) {
  const d = tanggal ? new Date(tanggal) : new Date();
  if (periode === 'hari') {
    const ds = d.toISOString().slice(0, 10);
    return [ds + ' 00:00:00', ds + ' 23:59:59'];
  }
  if (periode === 'minggu') {
    const day = d.getDay();
    const start = new Date(d); start.setDate(d.getDate() - day);
    const end   = new Date(d); end.setDate(d.getDate() + (6 - day));
    return [start.toISOString().slice(0, 10) + ' 00:00:00', end.toISOString().slice(0, 10) + ' 23:59:59'];
  }
  if (periode === 'tahun') {
    const y = d.getFullYear();
    return [y + '-01-01 00:00:00', y + '-12-31 23:59:59'];
  }
  // default: bulan
  const ym = d.toISOString().slice(0, 7);
  return [ym + '-01 00:00:00', ym + '-31 23:59:59'];
}

// ══════════════════════════════════════════════════════════════════════
// 1. GET /api/customer-insight/:id/lifetime-value
// ══════════════════════════════════════════════════════════════════════
router.get('/:id/lifetime-value', auth(), async (req, res) => {
  try {
    const custId = parseInt(req.params.id);

    // Verify customer exists
    const [[cust]] = await db.query(
      'SELECT id, nama, nama_toko, telepon, kode FROM customer WHERE id=?', [custId]);
    if (!cust) return res.status(404).json({ success: false, message: 'Customer tidak ditemukan.' });

    // Invoice totals
    const [[invTotals]] = await db.query(`
      SELECT COUNT(*) as total_transaksi,
             COALESCE(SUM(total), 0) as total_belanja,
             MIN(tanggal) as first_transaction,
             MAX(tanggal) as last_transaction
      FROM invoice
      WHERE customer_id = ? AND status != 'draft'`, [custId]);

    // POS totals (via member -> customer is not linked; use invoice only as primary)
    // Also count POS if member has matching no_hp
    const [[posTotals]] = await db.query(`
      SELECT COUNT(*) as total_transaksi,
             COALESCE(SUM(pt.total), 0) as total_belanja,
             MIN(pt.created_at) as first_pos,
             MAX(pt.created_at) as last_pos
      FROM pos_transaksi pt
      JOIN member m ON m.id = pt.member_id
      WHERE m.no_hp = (SELECT COALESCE(NULLIF(no_hp,''), NULLIF(telepon,'')) FROM customer WHERE id = ?)
        AND pt.status = 'selesai'`, [custId]);

    const totalBelanja   = parseFloat(invTotals.total_belanja) + parseFloat(posTotals.total_belanja);
    const totalTransaksi = parseInt(invTotals.total_transaksi) + parseInt(posTotals.total_transaksi);

    // Combined first/last dates
    const dates = [invTotals.first_transaction, posTotals.first_pos].filter(Boolean);
    const datesLast = [invTotals.last_transaction, posTotals.last_pos].filter(Boolean);
    const firstTransaction = dates.length ? dates.sort()[0] : null;
    const lastTransaction  = datesLast.length ? datesLast.sort().reverse()[0] : null;

    const avgPerTransaksi = totalTransaksi > 0 ? Math.round(totalBelanja / totalTransaksi) : 0;

    // Average days between transactions (frequency)
    const [allDates] = await db.query(`
      SELECT tanggal as d FROM invoice
      WHERE customer_id = ? AND status != 'draft'
      UNION ALL
      SELECT DATE(pt.created_at) as d
      FROM pos_transaksi pt
      JOIN member m ON m.id = pt.member_id
      WHERE m.no_hp = (SELECT COALESCE(NULLIF(no_hp,''), NULLIF(telepon,'')) FROM customer WHERE id = ?)
        AND pt.status = 'selesai'
      ORDER BY d ASC`, [custId, custId]);

    let avgDaysBetween = null;
    if (allDates.length >= 2) {
      let totalGap = 0;
      for (let i = 1; i < allDates.length; i++) {
        totalGap += Math.abs(new Date(allDates[i].d) - new Date(allDates[i - 1].d)) / 86400000;
      }
      avgDaysBetween = Math.round(totalGap / (allDates.length - 1));
    }

    // Top 5 most purchased products (from invoice_item)
    const [topProducts] = await db.query(`
      SELECT ii.produk_id, COALESCE(pp.nama, ii.nama_produk) as nama_produk,
             SUM(ii.qty) as total_qty, SUM(ii.subtotal) as total_value
      FROM invoice_item ii
      JOIN invoice i ON i.id = ii.invoice_id
      LEFT JOIN pos_produk pp ON pp.id = ii.produk_id
      WHERE i.customer_id = ? AND i.status != 'draft'
      GROUP BY ii.produk_id, nama_produk
      ORDER BY total_qty DESC
      LIMIT 5`, [custId]);

    const segment = segmenByValue(totalBelanja);
    const recency = segmenByRecency(lastTransaction);

    res.json({
      success: true,
      data: {
        customer: cust,
        total_belanja: totalBelanja,
        total_transaksi: totalTransaksi,
        first_transaction: firstTransaction,
        last_transaction: lastTransaction,
        avg_per_transaksi: avgPerTransaksi,
        avg_days_between: avgDaysBetween,
        segment,
        recency,
        top_products: topProducts,
        breakdown: {
          invoice: {
            total: parseFloat(invTotals.total_belanja),
            count: parseInt(invTotals.total_transaksi)
          },
          pos: {
            total: parseFloat(posTotals.total_belanja),
            count: parseInt(posTotals.total_transaksi)
          }
        }
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 2. GET /api/customer-insight/segmentasi
// ══════════════════════════════════════════════════════════════════════
router.get('/segmentasi', auth(), async (req, res) => {
  try {
    // All customers with their lifetime value and last transaction
    const [rows] = await db.query(`
      SELECT c.id,
             COALESCE(inv.total_belanja, 0) as total_belanja,
             inv.last_transaction
      FROM customer c
      LEFT JOIN (
        SELECT customer_id,
               SUM(total) as total_belanja,
               MAX(tanggal) as last_transaction
        FROM invoice
        WHERE status != 'draft'
        GROUP BY customer_id
      ) inv ON inv.customer_id = c.id`);

    // Segment by value
    const valueSegments = { VIP: { count: 0, total: 0 }, Gold: { count: 0, total: 0 }, Silver: { count: 0, total: 0 }, Bronze: { count: 0, total: 0 } };
    // Segment by recency
    const recencySegments = { Active: { count: 0, total: 0 }, Regular: { count: 0, total: 0 }, Dormant: { count: 0, total: 0 }, Churned: { count: 0, total: 0 } };
    // Cross-tabulation
    const cross = {};
    for (const vs of ['VIP', 'Gold', 'Silver', 'Bronze']) {
      cross[vs] = {};
      for (const rs of ['Active', 'Regular', 'Dormant', 'Churned']) {
        cross[vs][rs] = { count: 0, total: 0 };
      }
    }

    for (const r of rows) {
      const total = parseFloat(r.total_belanja);
      const vs = segmenByValue(total);
      const rs = segmenByRecency(r.last_transaction);

      valueSegments[vs].count++;
      valueSegments[vs].total += total;
      recencySegments[rs].count++;
      recencySegments[rs].total += total;
      cross[vs][rs].count++;
      cross[vs][rs].total += total;
    }

    res.json({
      success: true,
      data: {
        total_customer: rows.length,
        by_value: valueSegments,
        by_recency: recencySegments,
        cross_tabulation: cross
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 3. GET /api/customer-insight/top?limit=20&periode=bulan&tanggal=2026-04-07
// ══════════════════════════════════════════════════════════════════════
router.get('/top', auth(), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const periode = req.query.periode || 'bulan';
    const [dari, sampai] = periodeRange(periode, req.query.tanggal);

    const [rows] = await db.query(`
      SELECT c.id, c.kode, c.nama, c.nama_toko, c.kategori,
             COALESCE(SUM(i.total), 0) as total_belanja,
             COUNT(i.id) as total_transaksi,
             ROUND(COALESCE(SUM(i.total) / NULLIF(COUNT(i.id), 0), 0)) as avg_per_transaksi,
             MAX(i.tanggal) as last_transaction_date
      FROM customer c
      JOIN invoice i ON i.customer_id = c.id
      WHERE i.status != 'draft'
        AND i.tanggal BETWEEN ? AND ?
      GROUP BY c.id, c.kode, c.nama, c.nama_toko, c.kategori
      ORDER BY total_belanja DESC
      LIMIT ?`, [dari, sampai, limit]);

    res.json({
      success: true,
      data: {
        periode,
        dari: dari.slice(0, 10),
        sampai: sampai.slice(0, 10),
        customers: rows.map(r => ({
          ...r,
          total_belanja: parseFloat(r.total_belanja),
          avg_per_transaksi: parseFloat(r.avg_per_transaksi),
          segment: segmenByValue(parseFloat(r.total_belanja))
        }))
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 4. GET /api/customer-insight/churn-risk
// ══════════════════════════════════════════════════════════════════════
router.get('/churn-risk', auth(), async (req, res) => {
  try {
    // Customers with at least 2 transactions, last transaction > 60 days ago
    const [rows] = await db.query(`
      SELECT c.id, c.kode, c.nama, c.nama_toko, c.telepon, c.no_hp, c.kategori,
             COUNT(i.id) as total_transaksi,
             COALESCE(SUM(i.total), 0) as total_belanja,
             MAX(i.tanggal) as last_transaction,
             MIN(i.tanggal) as first_transaction,
             DATEDIFF(CURDATE(), MAX(i.tanggal)) as days_inactive
      FROM customer c
      JOIN invoice i ON i.customer_id = c.id
      WHERE i.status != 'draft'
      GROUP BY c.id, c.kode, c.nama, c.nama_toko, c.telepon, c.no_hp, c.kategori
      HAVING total_transaksi >= 2
         AND days_inactive >= 60
      ORDER BY days_inactive DESC`);

    const result = rows.map(r => {
      const totalBelanja = parseFloat(r.total_belanja);
      const totalTrx = parseInt(r.total_transaksi);
      const first = new Date(r.first_transaction);
      const last  = new Date(r.last_transaction);
      const spanDays = Math.max(1, Math.floor((last - first) / 86400000));
      const avgFrequency = Math.round(spanDays / (totalTrx - 1));
      // Estimated next transaction would have been at last + avgFrequency
      const estimatedChurn = new Date(last.getTime() + avgFrequency * 86400000);

      return {
        id: r.id,
        kode: r.kode,
        nama: r.nama,
        nama_toko: r.nama_toko,
        telepon: r.telepon || r.no_hp,
        kategori: r.kategori,
        total_transaksi: totalTrx,
        total_belanja: totalBelanja,
        segment: segmenByValue(totalBelanja),
        last_transaction: r.last_transaction,
        days_inactive: parseInt(r.days_inactive),
        avg_frequency_days: avgFrequency,
        estimated_churn_date: estimatedChurn.toISOString().slice(0, 10),
        days_overdue: Math.max(0, Math.floor((Date.now() - estimatedChurn.getTime()) / 86400000))
      };
    });

    res.json({
      success: true,
      data: {
        total: result.length,
        customers: result
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
