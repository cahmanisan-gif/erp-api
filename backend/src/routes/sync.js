const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/sync/numbers — return angka mentah untuk realtime ticker
router.get('/numbers', auth(), async (req, res) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) res.json({ success: true, data: null, stale: true });
  }, 800);

  try {
    const today    = new Date().toISOString().slice(0, 10);
    const bulanIni = today.slice(0, 7) + '-01';

    const [
      [omzetHariPOS], [invHari], [itemsHariRow],
      [omzetBulanPOS], [invBulan],
      [pglBulan], [hppHari], [hppBulan], [pglHari],
    ] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx,
                COALESCE(SUM(CASE WHEN metode_bayar='cash' THEN total ELSE 0 END),0) as cash
                FROM pos_transaksi WHERE status='selesai' AND created_at>=? AND created_at<=?`,
                [today+' 00:00:00', today+' 23:59:59']),
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
                FROM invoice WHERE status IN ('diterbitkan','lunas') AND tanggal=?`, [today]),
      db.query(`SELECT COALESCE(SUM(i.qty),0) as qty FROM pos_transaksi_item i
                JOIN pos_transaksi t ON t.id=i.transaksi_id
                WHERE t.status='selesai' AND t.created_at>=? AND t.created_at<=?`,
                [today+' 00:00:00', today+' 23:59:59']),
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx
                FROM pos_transaksi WHERE status='selesai' AND created_at>=? AND created_at<=?`,
                [bulanIni+' 00:00:00', today+' 23:59:59']),
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
                FROM invoice WHERE status IN ('diterbitkan','lunas') AND tanggal>=? AND tanggal<=?`,
                [bulanIni, today]),
      db.query(`SELECT COALESCE(SUM(nominal),0) as total FROM pengeluaran
                WHERE status='approved' AND tanggal>=?`, [bulanIni]),
      db.query(`SELECT COALESCE(SUM(i.harga_modal * i.qty),0) as hpp
                FROM pos_transaksi_item i JOIN pos_transaksi t ON t.id=i.transaksi_id
                WHERE t.status='selesai' AND t.created_at>=? AND t.created_at<=?`,
                [today+' 00:00:00', today+' 23:59:59']),
      db.query(`SELECT COALESCE(SUM(i.harga_modal * i.qty),0) as hpp
                FROM pos_transaksi_item i JOIN pos_transaksi t ON t.id=i.transaksi_id
                WHERE t.status='selesai' AND t.created_at>=? AND t.created_at<=?`,
                [bulanIni+' 00:00:00', today+' 23:59:59']),
      db.query(`SELECT COALESCE(SUM(nominal),0) as total FROM pengeluaran
                WHERE status='approved' AND tanggal=?`, [today]),
    ]);

    clearTimeout(timeout);
    const p = v => parseFloat(v) || 0;

    const omzetHari  = p(omzetHariPOS[0].omzet) + p(invHari[0].omzet);
    const trxHari    = parseInt(omzetHariPOS[0].trx) + parseInt(invHari[0].cnt);
    const cashHari   = p(omzetHariPOS[0].cash);
    const itemsHari  = parseInt(itemsHariRow[0].qty);
    const omzetBulan = p(omzetBulanPOS[0].omzet) + p(invBulan[0].omzet);
    const trxBulan   = parseInt(omzetBulanPOS[0].trx) + parseInt(invBulan[0].cnt);
    const pglBulanV  = p(pglBulan[0].total);
    const hppHariV   = p(hppHari[0].hpp);
    const hppBulanV  = p(hppBulan[0].hpp);
    const pglHariV   = p(pglHari[0].total);
    const labaHari   = omzetHari - hppHariV - pglHariV;
    const labaBulan  = omzetBulan - hppBulanV - pglBulanV;

    if (!res.headersSent) {
      // Semua angka mentah — formatting di frontend
      res.json({ success: true, data: {
        omzet_hari: omzetHari, trx_hari: trxHari, cash_hari: cashHari,
        items_hari: itemsHari, omzet_bulan: omzetBulan, trx_bulan: trxBulan,
        pengeluaran_bulan: pglBulanV, hpp_hari: hppHariV,
        laba_hari: labaHari, laba_bulan: labaBulan,
        margin_hari: omzetHari > 0 ? Math.round(labaHari / omzetHari * 1000) / 10 : 0,
        ts: Date.now()
      }});
    }
  } catch (e) {
    clearTimeout(timeout);
    console.error('sync/numbers:', e.message);
    if (!res.headersSent) res.json({ success: true, data: null, stale: true });
  }
});

// GET /api/sync/stream — SSE endpoint untuk realtime push
const { addClient, getClientCount } = require('../utils/eventBus');

router.get('/stream', auth(), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: jangan buffer SSE
  });

  // Kirim heartbeat awal supaya client tahu koneksi berhasil
  res.write(`event: connected\ndata: ${JSON.stringify({ts: Date.now(), clients: getClientCount()+1})}\n\n`);

  addClient(res);

  // Heartbeat tiap 30 detik supaya koneksi tidak ditutup proxy/firewall
  const hb = setInterval(() => {
    try { res.write(`event: heartbeat\ndata: ${JSON.stringify({ts:Date.now()})}\n\n`); }
    catch(e) { clearInterval(hb); }
  }, 30000);

  req.on('close', () => clearInterval(hb));
});

module.exports = router;
