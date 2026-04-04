const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/stats', auth(), async (req, res) => {
  try {
    const [[cab]]  = await db.query('SELECT COUNT(*) as n FROM cabang WHERE aktif=1');
    const [[inv]]  = await db.query("SELECT COUNT(*) as n FROM invoice WHERE MONTH(tanggal)=MONTH(NOW()) AND YEAR(tanggal)=YEAR(NOW())");
    const [[cust]] = await db.query('SELECT COUNT(*) as n FROM customer');
    const [[reqB]]  = await db.query("SELECT COUNT(*) as n FROM request_barang WHERE status='Sedang Dicarikan'");
    res.json({ success:true, data:{ cabang:cab.n, invoice:inv.n, customer:cust.n, request:reqB.n }});
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/dashboard/owner — rich dashboard for owner/management
router.get('/owner', auth(['owner','manajer','manajer_area','head_operational','admin_pusat']), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const d7ago = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const bulanIni = today.slice(0,7)+'-01';

    // ═══ ALL QUERIES IN PARALLEL — single Promise.all ═══
    const [
      [omzetTodayPOS_], [invToday_],
      [omzetYestPOS_], [invYest_],
      [omzetBulanPOS_], [invBulan_],
      trend7pos_, trend7inv_,
      topCabangPOS_, topCabangInv_,
      topProduk_, topKasir_,
      [returPending_], [returSupPending_],
      [pglBulan_]
    ] = await Promise.all([
      // 1. Omzet hari ini POS
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx,
        COALESCE(SUM(CASE WHEN metode_bayar='cash' THEN total ELSE 0 END),0) as cash,
        COALESCE(SUM(CASE WHEN metode_bayar IN ('transfer','qris') THEN total ELSE 0 END),0) as non_cash
        FROM pos_transaksi WHERE status='selesai' AND created_at>=? AND created_at<=?`,
        [today+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // 1b. Invoice hari ini
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
        FROM invoice WHERE status IN ('diterbitkan','lunas') AND tanggal=?`, [today]).then(r=>r[0]),
      // 2. Omzet kemarin POS
      db.query(`SELECT COALESCE(SUM(total),0) as omzet FROM pos_transaksi
        WHERE status='selesai' AND created_at>=? AND created_at<=?`,
        [yesterday+' 00:00:00', yesterday+' 23:59:59']).then(r=>r[0]),
      // 2b. Invoice kemarin
      db.query(`SELECT COALESCE(SUM(total),0) as omzet FROM invoice
        WHERE status IN ('diterbitkan','lunas') AND tanggal=?`, [yesterday]).then(r=>r[0]),
      // 3. Omzet bulan ini POS
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx FROM pos_transaksi
        WHERE status='selesai' AND created_at>=? AND created_at<=?`,
        [bulanIni+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // 3b. Invoice bulan ini
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt FROM invoice
        WHERE status IN ('diterbitkan','lunas') AND tanggal>=? AND tanggal<=?`, [bulanIni, today]).then(r=>r[0]),
      // 4. Trend 7 hari POS (omzet + trx + hpp)
      db.query(`SELECT DATE(t.created_at) as tgl, COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx,
        COALESCE(SUM(hpp_sub.hpp),0) as hpp
        FROM pos_transaksi t
        LEFT JOIN (SELECT transaksi_id, SUM(harga_modal * qty) as hpp FROM pos_transaksi_item GROUP BY transaksi_id) hpp_sub ON hpp_sub.transaksi_id=t.id
        WHERE t.status='selesai' AND t.created_at>=?
        GROUP BY DATE(t.created_at) ORDER BY tgl ASC`, [d7ago+' 00:00:00']).then(r=>r[0]),
      // 4b. Trend 7 hari invoice
      db.query(`SELECT tanggal as tgl, COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
        FROM invoice WHERE status IN ('diterbitkan','lunas') AND tanggal>=?
        GROUP BY tanggal ORDER BY tgl ASC`, [d7ago]).then(r=>r[0]),
      // 5. Top cabang POS
      db.query(`SELECT t.cabang_id, c.nama, c.kode, COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi t JOIN cabang c ON c.id=t.cabang_id
        WHERE t.status='selesai' AND t.created_at>=? AND t.created_at<=?
        GROUP BY t.cabang_id, c.nama, c.kode`, [today+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // 5b. Top cabang invoice
      db.query(`SELECT COALESCE(u.cabang_id, 3) as cabang_id, c.nama, c.kode,
        COALESCE(SUM(i.total),0) as omzet, COUNT(*) as trx
        FROM invoice i JOIN users u ON u.id=i.sales_id
        JOIN cabang c ON c.id=COALESCE(u.cabang_id, 3)
        WHERE i.status IN ('diterbitkan','lunas') AND i.tanggal=?
        GROUP BY COALESCE(u.cabang_id, 3), c.nama, c.kode`, [today]).then(r=>r[0]),
      // 6. Top produk bulan ini
      db.query(`SELECT ti.nama_produk, SUM(ti.qty) as total_qty, SUM(ti.subtotal) as total_omzet
        FROM pos_transaksi_item ti JOIN pos_transaksi t ON t.id=ti.transaksi_id
        WHERE t.status='selesai' AND t.created_at>=?
        GROUP BY ti.produk_id, ti.nama_produk ORDER BY total_qty DESC LIMIT 5`,
        [bulanIni+' 00:00:00']).then(r=>r[0]),
      // 7. Top kasir hari ini
      db.query(`SELECT t.kasir_id, u.nama_lengkap, c.nama as nama_cabang,
        COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi t LEFT JOIN users u ON u.id=t.kasir_id LEFT JOIN cabang c ON c.id=t.cabang_id
        WHERE t.status='selesai' AND t.created_at>=? AND t.created_at<=?
        GROUP BY t.kasir_id, u.nama_lengkap, c.nama ORDER BY omzet DESC LIMIT 5`,
        [today+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // 8. Retur pending
      db.query(`SELECT COUNT(*) as customer FROM retur_customer WHERE status='draft'`).then(r=>r[0]),
      db.query(`SELECT COUNT(*) as supplier FROM retur_supplier WHERE status='draft'`).then(r=>r[0]),
      // 9. Pengeluaran bulan ini
      db.query(`SELECT COALESCE(SUM(nominal),0) as total FROM pengeluaran
        WHERE status='approved' AND tanggal>=?`, [bulanIni]).then(r=>r[0]),
    ]);

    // ── Merge results ──
    const omzetToday = {
      omzet: parseFloat(omzetTodayPOS_.omzet) + parseFloat(invToday_.omzet),
      trx: parseInt(omzetTodayPOS_.trx) + parseInt(invToday_.cnt),
      cash: parseFloat(omzetTodayPOS_.cash),
      non_cash: parseFloat(omzetTodayPOS_.non_cash) + parseFloat(invToday_.omzet)
    };
    const omzetYesterday = { omzet: parseFloat(omzetYestPOS_.omzet) + parseFloat(invYest_.omzet) };
    const omzetBulan = {
      omzet: parseFloat(omzetBulanPOS_.omzet) + parseFloat(invBulan_.omzet),
      trx: parseInt(omzetBulanPOS_.trx) + parseInt(invBulan_.cnt)
    };

    const trendMap = {};
    trend7pos_.forEach(r => { const d = r.tgl instanceof Date ? r.tgl.toISOString().slice(0,10) : String(r.tgl); trendMap[d] = { omzet: parseFloat(r.omzet), trx: parseInt(r.trx), hpp: parseFloat(r.hpp||0) }; });
    trend7inv_.forEach(r => { const d = r.tgl instanceof Date ? r.tgl.toISOString().slice(0,10) : String(r.tgl); if (!trendMap[d]) trendMap[d] = { omzet:0, trx:0, hpp:0 }; trendMap[d].omzet += parseFloat(r.omzet); trendMap[d].trx += parseInt(r.cnt); });
    const trend7 = Object.keys(trendMap).sort().map(tgl => ({ tgl, omzet: trendMap[tgl].omzet, trx: trendMap[tgl].trx, hpp: trendMap[tgl].hpp, keuntungan: trendMap[tgl].omzet - trendMap[tgl].hpp }));

    const topMap = {};
    topCabangPOS_.forEach(r => { topMap[r.cabang_id] = { cabang_id: r.cabang_id, nama: r.nama, kode: r.kode, omzet: parseFloat(r.omzet), trx: parseInt(r.trx) }; });
    topCabangInv_.forEach(r => { if (!topMap[r.cabang_id]) topMap[r.cabang_id] = { cabang_id: r.cabang_id, nama: r.nama, kode: r.kode, omzet: 0, trx: 0 }; topMap[r.cabang_id].omzet += parseFloat(r.omzet); topMap[r.cabang_id].trx += parseInt(r.trx); });
    const topCabang = Object.values(topMap).sort((a,b) => b.omzet - a.omzet).slice(0, 5);

    const topProduk = topProduk_;
    const topKasir = topKasir_;
    const returPending = returPending_;
    const returSupPending = returSupPending_;
    const pglBulan = pglBulan_;

    // 10. Staff hadir hari ini — dari cache lokal dulu (cepat), Kerjoo sebagai background
    let staffHadir = 0;
    const [[staffFromLocal]] = await db.query(`
      SELECT COUNT(*) as c FROM absensi_hari_ini WHERE tanggal=? AND status IN ('hadir','pulang')`, [today]);
    staffHadir = parseInt(staffFromLocal.c) || 0;
    // Fallback jika cache kosong: hitung dari POS transaksi hari ini (lebih cepat dari Kerjoo)
    if (staffHadir === 0) {
      const [[staffTrx]] = await db.query(`
        SELECT COUNT(DISTINCT kasir_id) as aktif FROM pos_transaksi
        WHERE status='selesai' AND created_at>=? AND created_at<=?`,
        [today+' 00:00:00', today+' 23:59:59']);
      staffHadir = parseInt(staffTrx.aktif);
    }
    const [[staffTotalRow]] = await db.query(`
      SELECT COUNT(*) as total FROM users WHERE aktif=1 AND role IN ('kasir','kasir_sales','vaporista','kepala_cabang')`);

    res.json({success:true, data:{
      omzet_hari_ini: parseFloat(omzetToday.omzet),
      trx_hari_ini: parseInt(omzetToday.trx),
      cash_hari_ini: parseFloat(omzetToday.cash),
      non_cash_hari_ini: parseFloat(omzetToday.non_cash),
      omzet_kemarin: parseFloat(omzetYesterday.omzet),
      omzet_bulan_ini: parseFloat(omzetBulan.omzet),
      trx_bulan_ini: parseInt(omzetBulan.trx),
      growth_vs_kemarin: omzetYesterday.omzet > 0
        ? Math.round((omzetToday.omzet - omzetYesterday.omzet) / omzetYesterday.omzet * 100) : null,
      trend_7_hari: trend7.map(r => ({tgl:r.tgl, omzet:parseFloat(r.omzet), trx:parseInt(r.trx), hpp:parseFloat(r.hpp), keuntungan:parseFloat(r.keuntungan)})),
      top_cabang: topCabang.map(r => ({...r, omzet:parseFloat(r.omzet)})),
      top_produk: topProduk.map(r => ({...r, total_omzet:parseFloat(r.total_omzet), total_qty:parseInt(r.total_qty)})),
      top_kasir: topKasir.map(r => ({...r, omzet:parseFloat(r.omzet)})),
      retur_pending: parseInt(returPending.customer) + parseInt(returSupPending.supplier),
      pengeluaran_bulan: parseFloat(pglBulan.total),
      staff_hadir: staffHadir,
      staff_total: parseInt(staffTotalRow.total)
    }});
  } catch(e) {
    console.error('dashboard owner:', e);
    res.status(500).json({success:false, message:e.message});
  }
});

// GET /api/dashboard/leaderboard-retail — leaderboard omzet & poin kasir seluruh cabang retail
router.get('/leaderboard-retail', auth(), async (req, res) => {
  try {
    const GUDANG_IDS = [3, 4]; // exclude GUDANG-S, GUDANG-R
    const today = new Date().toISOString().slice(0,10);
    const ph = GUDANG_IDS.map(() => '?').join(',');

    // Leaderboard omzet per kasir hari ini (semua cabang retail)
    const [omzetRows] = await db.query(`
      SELECT t.kasir_id, MAX(u.nama_lengkap) as nama_lengkap, MAX(c.nama) as nama_cabang, MAX(c.kode) as kode_cabang,
             COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
      FROM pos_transaksi t
      LEFT JOIN users u ON u.id=t.kasir_id
      LEFT JOIN cabang c ON c.id=t.cabang_id
      WHERE t.status='selesai' AND t.cabang_id NOT IN (${ph})
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.kasir_id ORDER BY omzet DESC LIMIT 20`,
      [...GUDANG_IDS, today+' 00:00:00', today+' 23:59:59']);

    // Leaderboard omzet per toko hari ini
    const [tokoRows] = await db.query(`
      SELECT t.cabang_id, MAX(c.nama) as nama_cabang, MAX(c.kode) as kode_cabang,
             COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
      FROM pos_transaksi t
      LEFT JOIN cabang c ON c.id=t.cabang_id
      WHERE t.status='selesai' AND t.cabang_id NOT IN (${ph})
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.cabang_id ORDER BY omzet DESC LIMIT 20`,
      [...GUDANG_IDS, today+' 00:00:00', today+' 23:59:59']);

    // Leaderboard poin per kasir hari ini
    const [poinRows] = await db.query(`
      SELECT t.kasir_id, MAX(u.nama_lengkap) as nama_lengkap, MAX(c.nama) as nama_cabang,
             COALESCE(SUM(ti.komisi_poin * ti.qty),0) as total_poin
      FROM pos_transaksi t
      JOIN pos_transaksi_item ti ON ti.transaksi_id=t.id
      LEFT JOIN users u ON u.id=t.kasir_id
      LEFT JOIN cabang c ON c.id=t.cabang_id
      WHERE t.status='selesai' AND t.cabang_id NOT IN (${ph})
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.kasir_id HAVING total_poin > 0
      ORDER BY total_poin DESC LIMIT 20`,
      [...GUDANG_IDS, today+' 00:00:00', today+' 23:59:59']);

    const userId = req.user.id;
    const fmt = rows => rows.map(r => ({
      ...r, omzet: parseFloat(r.omzet||0), trx: parseInt(r.trx||0),
      total_poin: parseInt(r.total_poin||0), is_me: r.kasir_id === userId || r.cabang_id === req.user.cabang_id
    }));

    res.json({ success: true, data: {
      top_kasir: fmt(omzetRows),
      top_toko: fmt(tokoRows),
      top_poin: fmt(poinRows),
    }});
  } catch(e) {
    console.error('leaderboard-retail:', e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// GET /api/dashboard/sales — dashboard khusus kasir_sales & sales (GUDANG SALES)
router.get('/sales', auth(), async (req, res) => {
  try {
    const userId = req.user.id;
    const GUDANG_ID = 3;
    const today = new Date().toISOString().slice(0,10);
    const now = new Date();
    const bulanDari = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-01';
    const { dari, sampai } = req.query;
    const customDari = dari || bulanDari;
    const customSampai = sampai || today;

    const [
      [myPosToday_], [myInvToday_],
      [myPosBulan_], [myInvBulan_],
      [myPosCustom_], [myInvCustom_],
      topKasirToday_, topKasirBulan_,
      topInvToday_, topInvBulan_,
    ] = await Promise.all([
      // Omzet POS pribadi hari ini
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi WHERE kasir_id=? AND status='selesai'
        AND created_at>=? AND created_at<=?`, [userId, today+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // Omzet invoice pribadi hari ini
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
        FROM invoice WHERE sales_id=? AND status IN ('diterbitkan','lunas') AND tanggal=?`, [userId, today]).then(r=>r[0]),
      // Omzet POS pribadi bulan ini
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi WHERE kasir_id=? AND status='selesai'
        AND created_at>=? AND created_at<=?`, [userId, bulanDari+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // Omzet invoice pribadi bulan ini
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
        FROM invoice WHERE sales_id=? AND status IN ('diterbitkan','lunas')
        AND tanggal>=? AND tanggal<=?`, [userId, bulanDari, today]).then(r=>r[0]),
      // Omzet POS custom period
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi WHERE kasir_id=? AND status='selesai'
        AND created_at>=? AND created_at<=?`, [userId, customDari+' 00:00:00', customSampai+' 23:59:59']).then(r=>r[0]),
      // Omzet invoice custom period
      db.query(`SELECT COALESCE(SUM(total),0) as omzet, COUNT(*) as cnt
        FROM invoice WHERE sales_id=? AND status IN ('diterbitkan','lunas')
        AND tanggal>=? AND tanggal<=?`, [userId, customDari, customSampai]).then(r=>r[0]),
      // Top kasir gudang hari ini (POS)
      db.query(`SELECT t.kasir_id, u.nama_lengkap, COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi t LEFT JOIN users u ON u.id=t.kasir_id
        WHERE t.cabang_id=? AND t.status='selesai' AND t.created_at>=? AND t.created_at<=?
        GROUP BY t.kasir_id ORDER BY omzet DESC LIMIT 10`,
        [GUDANG_ID, today+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // Top kasir gudang bulan ini (POS)
      db.query(`SELECT t.kasir_id, u.nama_lengkap, COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
        FROM pos_transaksi t LEFT JOIN users u ON u.id=t.kasir_id
        WHERE t.cabang_id=? AND t.status='selesai' AND t.created_at>=? AND t.created_at<=?
        GROUP BY t.kasir_id ORDER BY omzet DESC LIMIT 10`,
        [GUDANG_ID, bulanDari+' 00:00:00', today+' 23:59:59']).then(r=>r[0]),
      // Top sales invoice hari ini
      db.query(`SELECT i.sales_id, u.nama_lengkap, COALESCE(SUM(i.total),0) as omzet, COUNT(*) as cnt
        FROM invoice i LEFT JOIN users u ON u.id=i.sales_id
        WHERE i.status IN ('diterbitkan','lunas') AND i.tanggal=?
        GROUP BY i.sales_id ORDER BY omzet DESC LIMIT 10`, [today]).then(r=>r[0]),
      // Top sales invoice bulan ini
      db.query(`SELECT i.sales_id, u.nama_lengkap, COALESCE(SUM(i.total),0) as omzet, COUNT(*) as cnt
        FROM invoice i LEFT JOIN users u ON u.id=i.sales_id
        WHERE i.status IN ('diterbitkan','lunas') AND i.tanggal>=? AND i.tanggal<=?
        GROUP BY i.sales_id ORDER BY omzet DESC LIMIT 10`, [bulanDari, today]).then(r=>r[0]),
    ]);

    // Top produk dari GUDANG SALES — multi period
    const periods = {
      hari_ini: [today+' 00:00:00', today+' 23:59:59'],
      '7_hari': [new Date(Date.now()-6*86400000).toISOString().slice(0,10)+' 00:00:00', today+' 23:59:59'],
      bulan_ini: [bulanDari+' 00:00:00', today+' 23:59:59'],
      tahun_ini: [now.getFullYear()+'-01-01 00:00:00', today+' 23:59:59'],
    };
    const topProduk = {};
    for (const [key, [d1, d2]] of Object.entries(periods)) {
      const [rows] = await db.query(`SELECT ti.nama_produk, SUM(ti.qty) as total_qty, COALESCE(SUM(ti.harga_jual*ti.qty),0) as total_omzet
        FROM pos_transaksi_item ti JOIN pos_transaksi t ON t.id=ti.transaksi_id
        WHERE t.cabang_id=? AND t.status='selesai' AND t.created_at>=? AND t.created_at<=?
        GROUP BY ti.produk_id, ti.nama_produk ORDER BY total_qty DESC LIMIT 10`, [GUDANG_ID, d1, d2]);
      topProduk[key] = rows.map(r => ({nama:r.nama_produk, qty:parseInt(r.total_qty), omzet:parseFloat(r.total_omzet)}));
    }

    // Merge top kasir + invoice menjadi leaderboard
    const mergeLeaderboard = (posRows, invRows) => {
      const map = {};
      posRows.forEach(r => { map[r.kasir_id] = { nama: r.nama_lengkap, omzet_pos: parseFloat(r.omzet), trx_pos: parseInt(r.trx), omzet_inv: 0, cnt_inv: 0 }; });
      invRows.forEach(r => {
        if (!map[r.sales_id]) map[r.sales_id] = { nama: r.nama_lengkap, omzet_pos: 0, trx_pos: 0, omzet_inv: 0, cnt_inv: 0 };
        map[r.sales_id].omzet_inv = parseFloat(r.omzet);
        map[r.sales_id].cnt_inv = parseInt(r.cnt);
      });
      return Object.entries(map).map(([id, d]) => ({
        user_id: parseInt(id), nama: d.nama,
        omzet_pos: d.omzet_pos, trx_pos: d.trx_pos,
        omzet_inv: d.omzet_inv, cnt_inv: d.cnt_inv,
        total: d.omzet_pos + d.omzet_inv,
        is_me: parseInt(id) === userId
      })).sort((a,b) => b.total - a.total);
    };

    res.json({success:true, data:{
      omzet_pribadi: {
        hari_ini:  { pos: parseFloat(myPosToday_.omzet), inv: parseFloat(myInvToday_.omzet), trx: parseInt(myPosToday_.trx), cnt_inv: parseInt(myInvToday_.cnt) },
        bulan_ini: { pos: parseFloat(myPosBulan_.omzet), inv: parseFloat(myInvBulan_.omzet), trx: parseInt(myPosBulan_.trx), cnt_inv: parseInt(myInvBulan_.cnt) },
        custom:    { pos: parseFloat(myPosCustom_.omzet), inv: parseFloat(myInvCustom_.omzet), trx: parseInt(myPosCustom_.trx), cnt_inv: parseInt(myInvCustom_.cnt), dari: customDari, sampai: customSampai },
      },
      leaderboard_hari_ini: mergeLeaderboard(topKasirToday_, topInvToday_),
      leaderboard_bulan_ini: mergeLeaderboard(topKasirBulan_, topInvBulan_),
      top_produk: topProduk,
    }});
  } catch(e) {
    console.error('dashboard sales:', e);
    res.status(500).json({success:false, message:e.message});
  }
});

// GET /api/dashboard/backups — status backup
router.get('/backups', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [logs] = await db.query('SELECT * FROM backup_log ORDER BY created_at DESC LIMIT 10');
    const fs = require('fs');
    const dir = '/var/www/rajavavapor/backups';
    let files = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.gz')).map(f => {
        const stat = fs.statSync(dir+'/'+f);
        return { filename:f, size:stat.size, date:stat.mtime };
      }).sort((a,b) => b.date - a.date);
    } catch(e) {}
    res.json({success:true, data:{logs, files, total_files:files.length}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/dashboard/backup-now — manual backup trigger
router.post('/backup-now', auth(['owner']), async (req, res) => {
  try {
    const { execSync } = require('child_process');
    execSync('/bin/bash /var/www/rajavavapor/backup.sh', {timeout:60000});
    res.json({success:true, message:'Backup selesai!'});
  } catch(e) { res.status(500).json({success:false, message:'Backup gagal: '+e.message}); }
});

module.exports = router;
