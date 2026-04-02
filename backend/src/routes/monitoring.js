const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/monitoring/omzet?periode=bulan-ini|bulan-lalu|tahun-lalu|custom&dari=YYYY-MM-DD&sampai=YYYY-MM-DD
// Sumber utama: pos_transaksi (data real POS). Fallback: omzet_cabang (input manual).
// Pengeluaran: tabel pengeluaran (approved).
router.get('/omzet', auth(['owner','manajer','manajer_area','spv_area','head_operational']), async (req, res) => {
  try {
    const { periode, dari, sampai } = req.query;
    const today    = new Date();
    const todayStr = today.toISOString().slice(0,10);

    // ── Tentukan rentang tanggal ──
    let dateFrom, dateTo, periodeLabel;

    if (periode === 'bulan-lalu') {
      const d  = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const y  = d.getFullYear();
      const m  = String(d.getMonth()+1).padStart(2,'0');
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
      dateFrom     = `${y}-${m}-01`;
      dateTo       = `${y}-${m}-${String(lastDay).padStart(2,'0')}`;
      periodeLabel = `Bulan Lalu — ${d.toLocaleString('id-ID',{month:'long',year:'numeric'})}`;
    } else if (periode === 'tahun-lalu') {
      dateFrom     = `${today.getFullYear()-1}-01-01`;
      dateTo       = `${today.getFullYear()-1}-12-31`;
      periodeLabel = `Tahun Lalu — ${today.getFullYear()-1}`;
    } else if (periode === 'custom' && dari && sampai) {
      dateFrom     = dari;
      dateTo       = sampai;
      periodeLabel = `${dari} s/d ${sampai}`;
    } else {
      // bulan-ini (default)
      const y  = today.getFullYear();
      const m  = String(today.getMonth()+1).padStart(2,'0');
      dateFrom     = `${y}-${m}-01`;
      dateTo       = todayStr;
      periodeLabel = `Bulan Ini — ${today.toLocaleString('id-ID',{month:'long',year:'numeric'})}`;
    }

    // ── Tentukan cabang yang boleh diakses ──
    const { getCabangAkses } = require('../middleware/cabangFilter');
    const aksesOmzet = await getCabangAkses(req.user);

    let cabangWhere  = 'WHERE aktif=1';
    const cabangParams = [];
    if (aksesOmzet !== null) {
      if (aksesOmzet.length === 0) return res.json({ success:true, data:[], dateFrom, dateTo, periodeLabel });
      cabangWhere += ` AND id IN (${aksesOmzet.map(()=>'?').join(',')})`;
      cabangParams.push(...aksesOmzet);
    }

    const [cabangList] = await db.query(
      `SELECT id, kode, nama, kecamatan, kabupaten FROM cabang ${cabangWhere} ORDER BY kode`,
      cabangParams
    );

    if (!cabangList.length) {
      return res.json({ success:true, data:[], dateFrom, dateTo, periodeLabel });
    }

    const cabangIds = cabangList.map(c => c.id);
    const ph        = cabangIds.map(() => '?').join(',');

    // ── 1. SUMBER UTAMA: Agregat dari pos_transaksi (data real POS) ──
    const [posAgg] = await db.query(`
      SELECT cabang_id,
             COALESCE(SUM(CASE WHEN metode_bayar='cash' THEN total ELSE 0 END),0) AS pos_cash,
             COALESCE(SUM(CASE WHEN metode_bayar IN ('transfer','qris') THEN total ELSE 0 END),0) AS pos_transfer,
             COALESCE(SUM(total),0) AS pos_total,
             COUNT(DISTINCT DATE(created_at)) AS pos_hari
      FROM pos_transaksi
      WHERE cabang_id IN (${ph}) AND status='selesai'
        AND created_at >= ? AND created_at <= ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']
    );

    // ── 1b. Invoice sales (diterbitkan/lunas) → masuk sebagai omzet gudang sales ──
    const [invoiceAgg] = await db.query(`
      SELECT COALESCE(u.cabang_id, 3) AS cabang_id,
             COALESCE(SUM(i.total),0) AS inv_total,
             COUNT(*) AS inv_count,
             COUNT(DISTINCT DATE(i.tanggal)) AS inv_hari
      FROM invoice i
      JOIN users u ON u.id = i.sales_id
      WHERE i.status IN ('diterbitkan','lunas')
        AND i.tanggal BETWEEN ? AND ?
        AND COALESCE(u.cabang_id, 3) IN (${ph})
      GROUP BY COALESCE(u.cabang_id, 3)`,
      [dateFrom, dateTo, ...cabangIds]
    );

    // ── 2. Detail harian POS ──
    const [posDailyRows] = await db.query(`
      SELECT cabang_id,
             DATE_FORMAT(tgl,'%Y-%m-%d') AS tanggal,
             COALESCE(SUM(CASE WHEN metode_bayar='cash' THEN total ELSE 0 END),0) AS omzet_cash,
             COALESCE(SUM(CASE WHEN metode_bayar IN ('transfer','qris') THEN total ELSE 0 END),0) AS omzet_transfer,
             COALESCE(SUM(total),0) AS omzet_pos,
             COUNT(*) AS trx_count
      FROM (SELECT cabang_id, metode_bayar, total, DATE(created_at) AS tgl FROM pos_transaksi
            WHERE cabang_id IN (${ph}) AND status='selesai'
              AND created_at >= ? AND created_at <= ?) sub
      GROUP BY cabang_id, tgl
      ORDER BY cabang_id, tanggal`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']
    );

    // ── 2b. Detail harian invoice ──
    const [invoiceDailyRows] = await db.query(`
      SELECT COALESCE(u.cabang_id, 3) AS cabang_id,
             DATE_FORMAT(i.tanggal,'%Y-%m-%d') AS tanggal,
             COALESCE(SUM(i.total),0) AS inv_total,
             COUNT(*) AS inv_count
      FROM invoice i
      JOIN users u ON u.id = i.sales_id
      WHERE i.status IN ('diterbitkan','lunas')
        AND i.tanggal BETWEEN ? AND ?
        AND COALESCE(u.cabang_id, 3) IN (${ph})
      GROUP BY COALESCE(u.cabang_id, 3), DATE_FORMAT(i.tanggal,'%Y-%m-%d')
      ORDER BY cabang_id, tanggal`,
      [dateFrom, dateTo, ...cabangIds]
    );

    // ── 3. Data manual omzet_cabang (sebagai supplement/fallback jika POS belum ada) ──
    const [manualAgg] = await db.query(`
      SELECT cabang_id,
             COALESCE(SUM(omzet_cash),0)     AS manual_cash,
             COALESCE(SUM(omzet_transfer),0) AS manual_transfer,
             COALESCE(SUM(omzet_pos),0)      AS manual_pos,
             COUNT(*)                         AS manual_hari,
             COALESCE(SUM(fraud_flag),0)      AS fraud_count
      FROM omzet_cabang
      WHERE cabang_id IN (${ph}) AND tanggal BETWEEN ? AND ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom, dateTo]
    );

    // ── 4. Detail harian manual (untuk hari yang tidak ada data POS) ──
    const [manualDailyRows] = await db.query(`
      SELECT o.id, o.cabang_id,
             DATE_FORMAT(o.tanggal,'%Y-%m-%d') AS tanggal,
             o.omzet_cash, o.omzet_transfer, o.omzet_pos,
             o.fraud_flag, o.catatan,
             COALESCE(
               (SELECT SUM(p.nominal) FROM omzet_pengeluaran p WHERE p.omzet_id = o.id), 0
             ) AS total_pengeluaran
      FROM omzet_cabang o
      WHERE o.cabang_id IN (${ph}) AND o.tanggal BETWEEN ? AND ?
      ORDER BY o.cabang_id, o.tanggal`,
      [...cabangIds, dateFrom, dateTo]
    );

    // ── 5. Pengeluaran dari tabel pengeluaran (approved) — sumber utama ──
    const [pglAgg] = await db.query(`
      SELECT cabang_id, COALESCE(SUM(nominal),0) AS total_pengeluaran
      FROM pengeluaran
      WHERE cabang_id IN (${ph}) AND status='approved'
        AND tanggal BETWEEN ? AND ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom, dateTo]
    );

    // ── 5b. Pengeluaran harian dari tabel pengeluaran ──
    const [pglDailyRows] = await db.query(`
      SELECT cabang_id, DATE_FORMAT(tanggal,'%Y-%m-%d') AS tanggal,
             COALESCE(SUM(nominal),0) AS total_pengeluaran
      FROM pengeluaran
      WHERE cabang_id IN (${ph}) AND status='approved'
        AND tanggal BETWEEN ? AND ?
      GROUP BY cabang_id, tanggal`,
      [...cabangIds, dateFrom, dateTo]
    );

    // ── 6. Breakdown per staff per cabang (dari pos_transaksi) ──
    const [staffRows] = await db.query(`
      SELECT t.cabang_id, t.kasir_id as user_id, u.nama_lengkap, u.role,
             COUNT(*) as total_trx,
             COALESCE(SUM(t.total),0) as omzet_total,
             COALESCE(SUM(CASE WHEN t.metode_bayar='cash' THEN t.total ELSE 0 END),0) as omzet_cash,
             COALESCE(SUM(CASE WHEN t.metode_bayar IN ('transfer','qris') THEN t.total ELSE 0 END),0) as omzet_transfer
      FROM pos_transaksi t
      LEFT JOIN users u ON u.id=t.kasir_id
      WHERE t.cabang_id IN (${ph}) AND t.status='selesai'
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.cabang_id, t.kasir_id, u.nama_lengkap, u.role
      ORDER BY t.cabang_id, omzet_total DESC`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']
    );

    // Komisi & poin per staff
    const [staffKomisiRows] = await db.query(`
      SELECT t.cabang_id, t.kasir_id as user_id,
             COALESCE(SUM(ti.komisi * ti.qty),0) as total_komisi,
             COALESCE(SUM(ti.komisi_poin * ti.qty),0) as total_poin
      FROM pos_transaksi t
      JOIN pos_transaksi_item ti ON ti.transaksi_id=t.id
      WHERE t.cabang_id IN (${ph}) AND t.status='selesai'
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.cabang_id, t.kasir_id`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']
    );

    // Build staff map per cabang
    const staffMap = {};
    staffRows.forEach(r => {
      if (!staffMap[r.cabang_id]) staffMap[r.cabang_id] = [];
      staffMap[r.cabang_id].push({
        user_id: r.user_id, nama: r.nama_lengkap, role: r.role,
        total_trx: parseInt(r.total_trx), omzet_total: parseFloat(r.omzet_total),
        omzet_cash: parseFloat(r.omzet_cash), omzet_transfer: parseFloat(r.omzet_transfer),
        total_komisi: 0, total_poin: 0
      });
    });
    staffKomisiRows.forEach(r => {
      const list = staffMap[r.cabang_id] || [];
      const s = list.find(x => x.user_id === r.user_id);
      if (s) { s.total_komisi = parseFloat(r.total_komisi); s.total_poin = parseInt(r.total_poin); }
    });

    // ── Build maps ──
    const posMap = {};
    posAgg.forEach(r => { posMap[r.cabang_id] = r; });

    const invoiceMap = {};
    invoiceAgg.forEach(r => { invoiceMap[r.cabang_id] = r; });

    const manualMap = {};
    manualAgg.forEach(r => { manualMap[r.cabang_id] = r; });

    const pglMap = {};
    pglAgg.forEach(r => { pglMap[r.cabang_id] = parseFloat(r.total_pengeluaran); });

    // POS daily per cabang
    const posDailyMap = {};
    posDailyRows.forEach(r => {
      if (!posDailyMap[r.cabang_id]) posDailyMap[r.cabang_id] = {};
      posDailyMap[r.cabang_id][r.tanggal] = r;
    });

    // Invoice daily per cabang
    const invoiceDailyMap = {};
    invoiceDailyRows.forEach(r => {
      if (!invoiceDailyMap[r.cabang_id]) invoiceDailyMap[r.cabang_id] = {};
      invoiceDailyMap[r.cabang_id][r.tanggal] = r;
    });

    // Manual daily per cabang
    const manualDailyMap = {};
    manualDailyRows.forEach(r => {
      if (!manualDailyMap[r.cabang_id]) manualDailyMap[r.cabang_id] = {};
      manualDailyMap[r.cabang_id][r.tanggal] = r;
    });

    // Pengeluaran daily per cabang
    const pglDailyMap = {};
    pglDailyRows.forEach(r => {
      if (!pglDailyMap[r.cabang_id]) pglDailyMap[r.cabang_id] = {};
      pglDailyMap[r.cabang_id][r.tanggal] = parseFloat(r.total_pengeluaran);
    });

    // ── Gabungkan: POS sebagai utama, manual sebagai fallback, + invoice sales ──
    const result = cabangList.map(cab => {
      const pos    = posMap[cab.id]    || {};
      const inv    = invoiceMap[cab.id] || {};
      const manual = manualMap[cab.id] || {};
      const hasPOS = parseFloat(pos.pos_total || 0) > 0;
      const invTotal = parseFloat(inv.inv_total || 0);

      // Jika ada data POS → pakai POS sebagai sumber omzet
      // Jika tidak ada POS → fallback ke manual
      const totalCash     = hasPOS ? parseFloat(pos.pos_cash     || 0) : parseFloat(manual.manual_cash     || 0);
      const totalTransfer = hasPOS ? parseFloat(pos.pos_transfer || 0) : parseFloat(manual.manual_transfer || 0);
      // Invoice (diterbitkan/lunas) ditambahkan ke omzet sebagai transfer (karena bayar via bank)
      const totalOmzet    = totalCash + totalTransfer + invTotal;
      const totalPgl      = pglMap[cab.id] || 0;
      const hariData      = hasPOS ? parseInt(pos.pos_hari || 0) : parseInt(manual.manual_hari || 0);

      // Merge detail harian: prioritas POS, fallback manual, + invoice
      const allDates = new Set();
      if (posDailyMap[cab.id])      Object.keys(posDailyMap[cab.id]).forEach(d => allDates.add(d));
      if (invoiceDailyMap[cab.id])  Object.keys(invoiceDailyMap[cab.id]).forEach(d => allDates.add(d));
      if (manualDailyMap[cab.id])   Object.keys(manualDailyMap[cab.id]).forEach(d => allDates.add(d));

      const detail = [...allDates].sort().map(tgl => {
        const posDay    = posDailyMap[cab.id]?.[tgl];
        const invDay    = invoiceDailyMap[cab.id]?.[tgl];
        const manualDay = manualDailyMap[cab.id]?.[tgl];
        const pglDay    = pglDailyMap[cab.id]?.[tgl] || 0;
        const invDayTotal = invDay ? parseFloat(invDay.inv_total) : 0;

        if (posDay) {
          const cash = parseFloat(posDay.omzet_cash);
          const transfer = parseFloat(posDay.omzet_transfer) + invDayTotal;
          return {
            tanggal: tgl,
            omzet_cash: cash,
            omzet_transfer: transfer,
            omzet_pos: parseFloat(posDay.omzet_pos),
            omzet_invoice: invDayTotal,
            total_pengeluaran: pglDay,
            trx_count: posDay.trx_count,
            inv_count: invDay ? invDay.inv_count : 0,
            sumber: 'pos',
            manual_cash: manualDay ? parseFloat(manualDay.omzet_cash) : null,
            manual_transfer: manualDay ? parseFloat(manualDay.omzet_transfer) : null,
            fraud_flag: manualDay?.fraud_flag || 0,
            catatan: manualDay?.catatan || null
          };
        } else if (invDay && !manualDay) {
          // Hanya data invoice (gudang sales tanpa POS kasir)
          return {
            tanggal: tgl,
            omzet_cash: 0,
            omzet_transfer: invDayTotal,
            omzet_pos: 0,
            omzet_invoice: invDayTotal,
            total_pengeluaran: pglDay,
            trx_count: 0,
            inv_count: invDay.inv_count,
            sumber: 'invoice',
            fraud_flag: 0,
            catatan: null
          };
        } else if (manualDay) {
          return {
            tanggal: tgl,
            omzet_cash: parseFloat(manualDay.omzet_cash),
            omzet_transfer: parseFloat(manualDay.omzet_transfer) + invDayTotal,
            omzet_pos: parseFloat(manualDay.omzet_pos),
            omzet_invoice: invDayTotal,
            total_pengeluaran: pglDay || parseFloat(manualDay.total_pengeluaran || 0),
            inv_count: invDay ? invDay.inv_count : 0,
            sumber: 'manual',
            fraud_flag: manualDay.fraud_flag || 0,
            catatan: manualDay.catatan || null
          };
        }
      }).filter(Boolean);

      return {
        cabang            : { id: cab.id, kode: cab.kode, nama: cab.nama, kota: cab.kabupaten || cab.kecamatan || '-' },
        total_cash        : totalCash,
        total_transfer    : totalTransfer + invTotal,
        total_omzet       : totalOmzet,
        total_pos         : parseFloat(pos.pos_total || 0),
        total_invoice     : invTotal,
        total_pengeluaran : totalPgl,
        net               : totalOmzet - totalPgl,
        hari_masuk        : hariData,
        fraud_count       : parseInt(manual.fraud_count || 0),
        sumber            : hasPOS ? 'pos' : (invTotal > 0 ? 'invoice' : (parseFloat(manual.manual_cash||0) + parseFloat(manual.manual_transfer||0) > 0 ? 'manual' : 'none')),
        detail            : detail,
        staff             : staffMap[cab.id] || []
      };
    });

    res.json({ success:true, data:result, dateFrom, dateTo, periodeLabel });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// GET /api/monitoring/keuntungan?periode=bulan-ini|bulan-lalu|tahun-ini|custom&dari=&sampai=
router.get('/keuntungan', auth(['owner','manajer','manajer_area','spv_area']), async (req, res) => {
  try {
    const { periode, dari, sampai } = req.query;
    const today    = new Date();
    const todayStr = today.toISOString().slice(0,10);

    let dateFrom, dateTo, periodeLabel;
    if (periode === 'bulan-lalu') {
      const d  = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const y  = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0');
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
      dateFrom = `${y}-${m}-01`; dateTo = `${y}-${m}-${String(lastDay).padStart(2,'0')}`;
      periodeLabel = `Bulan Lalu — ${d.toLocaleString('id-ID',{month:'long',year:'numeric'})}`;
    } else if (periode === 'tahun-ini') {
      dateFrom = `${today.getFullYear()}-01-01`; dateTo = todayStr;
      periodeLabel = `Tahun Ini — ${today.getFullYear()}`;
    } else if (periode === 'custom' && dari && sampai) {
      dateFrom = dari; dateTo = sampai;
      periodeLabel = `${dari} s/d ${sampai}`;
    } else {
      const y = today.getFullYear(), m = String(today.getMonth()+1).padStart(2,'0');
      dateFrom = `${y}-${m}-01`; dateTo = todayStr;
      periodeLabel = `Bulan Ini — ${today.toLocaleString('id-ID',{month:'long',year:'numeric'})}`;
    }

    // Tentukan cabang yang boleh diakses (via manajer_cabang / spv_area_cabang)
    const { getCabangAkses: getCabangAksesKeu } = require('../middleware/cabangFilter');
    const aksesKeu = await getCabangAksesKeu(req.user);

    let cabangWhere = 'WHERE aktif=1';
    const cabangParams = [];
    if (aksesKeu !== null) {
      if (aksesKeu.length === 0) return res.json({ success:true, data:[], dateFrom, dateTo, periodeLabel });
      cabangWhere += ` AND id IN (${aksesKeu.map(()=>'?').join(',')})`;
      cabangParams.push(...aksesKeu);
    }
    const [cabangList] = await db.query(
      `SELECT id, kode, nama, kecamatan, kabupaten FROM cabang ${cabangWhere} ORDER BY kode`,
      cabangParams
    );
    if (!cabangList.length) return res.json({ success:true, data:[], dateFrom, dateTo, periodeLabel });

    const cabangIds = cabangList.map(c => c.id);
    const ph = cabangIds.map(() => '?').join(',');

    // 1. Omzet manual (cash + transfer)
    const [omzetRows] = await db.query(`
      SELECT cabang_id,
             COALESCE(SUM(omzet_cash),0)     AS omzet_cash,
             COALESCE(SUM(omzet_transfer),0) AS omzet_transfer
      FROM omzet_cabang
      WHERE cabang_id IN (${ph}) AND tanggal BETWEEN ? AND ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom, dateTo]);

    // 2. Omzet POS (langsung dari pos_transaksi, TANPA join item agar tidak inflate)
    const [posOmzetRows] = await db.query(`
      SELECT cabang_id, COALESCE(SUM(total),0) AS omzet_pos
      FROM pos_transaksi
      WHERE cabang_id IN (${ph}) AND status='selesai'
        AND created_at >= ? AND created_at <= ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']);

    // 2b. HPP dari pos_transaksi_item (terpisah agar tidak inflate omzet)
    const [hppRows] = await db.query(`
      SELECT t.cabang_id,
             COALESCE(SUM(ti.harga_modal * ti.qty),0) AS hpp
      FROM pos_transaksi t
      JOIN pos_transaksi_item ti ON ti.transaksi_id = t.id
      WHERE t.cabang_id IN (${ph}) AND t.status='selesai'
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.cabang_id`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']);

    // 2c. Invoice sales (diterbitkan/lunas) → omzet + HPP gudang sales
    const [invOmzetRows] = await db.query(`
      SELECT COALESCE(u.cabang_id, 3) AS cabang_id,
             COALESCE(SUM(i.total),0) AS inv_total
      FROM invoice i
      JOIN users u ON u.id = i.sales_id
      WHERE i.status IN ('diterbitkan','lunas')
        AND i.tanggal BETWEEN ? AND ?
        AND COALESCE(u.cabang_id, 3) IN (${ph})
      GROUP BY COALESCE(u.cabang_id, 3)`,
      [dateFrom, dateTo, ...cabangIds]);

    // 2d. HPP invoice (dari harga_modal produk * qty item)
    const [invHppRows] = await db.query(`
      SELECT COALESCE(u.cabang_id, 3) AS cabang_id,
             COALESCE(SUM(p.harga_modal * ii.qty),0) AS inv_hpp
      FROM invoice i
      JOIN users u ON u.id = i.sales_id
      JOIN invoice_item ii ON ii.invoice_id = i.id
      LEFT JOIN pos_produk p ON p.id = ii.produk_id
      WHERE i.status IN ('diterbitkan','lunas')
        AND i.tanggal BETWEEN ? AND ?
        AND COALESCE(u.cabang_id, 3) IN (${ph})
      GROUP BY COALESCE(u.cabang_id, 3)`,
      [dateFrom, dateTo, ...cabangIds]);

    // 3. Pengeluaran operasional (semua kategori KECUALI pembelian barang/ongkir/biaya lainnya)
    const [pglOpsRows] = await db.query(`
      SELECT cabang_id, COALESCE(SUM(nominal),0) AS pengeluaran_ops
      FROM pengeluaran
      WHERE cabang_id IN (${ph}) AND status='approved'
        AND tanggal BETWEEN ? AND ?
        AND kategori_id NOT IN (26,27,28)
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom, dateTo]);

    // 4. Pengeluaran total (semua, untuk referensi)
    const [pglTotalRows] = await db.query(`
      SELECT cabang_id, COALESCE(SUM(nominal),0) AS pengeluaran_total
      FROM pengeluaran
      WHERE cabang_id IN (${ph}) AND status='approved'
        AND tanggal BETWEEN ? AND ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom, dateTo]);

    // Build maps
    const omzetMap    = {}; omzetRows.forEach(r    => { omzetMap[r.cabang_id]    = r; });
    const posOmzetMap = {}; posOmzetRows.forEach(r => { posOmzetMap[r.cabang_id] = parseFloat(r.omzet_pos); });
    const hppMap      = {}; hppRows.forEach(r      => { hppMap[r.cabang_id]      = parseFloat(r.hpp); });
    const invOmzetMap = {}; invOmzetRows.forEach(r => { invOmzetMap[r.cabang_id] = parseFloat(r.inv_total); });
    const invHppMap   = {}; invHppRows.forEach(r   => { invHppMap[r.cabang_id]   = parseFloat(r.inv_hpp); });
    const pglOpsMap   = {}; pglOpsRows.forEach(r   => { pglOpsMap[r.cabang_id]   = parseFloat(r.pengeluaran_ops); });
    const pglTotalMap = {}; pglTotalRows.forEach(r => { pglTotalMap[r.cabang_id]  = parseFloat(r.pengeluaran_total); });

    const result = cabangList.map(cab => {
      const om          = omzetMap[cab.id]    || {};
      const omzetCash   = parseFloat(om.omzet_cash     || 0);
      const omzetTrf    = parseFloat(om.omzet_transfer || 0);
      const omzetTotal  = omzetCash + omzetTrf;
      const omzetPos    = posOmzetMap[cab.id] || 0;
      const omzetInv    = invOmzetMap[cab.id] || 0;
      const hppPos      = hppMap[cab.id]      || 0;
      const hppInv      = invHppMap[cab.id]   || 0;
      const hpp         = hppPos + hppInv;
      const pglOps      = pglOpsMap[cab.id]   || 0;
      const pglTotal    = pglTotalMap[cab.id] || 0;

      // Gunakan omzet_pos jika tersedia, fallback ke manual omzet. Invoice selalu ditambahkan.
      const omzetBase   = (omzetPos > 0 ? omzetPos : omzetTotal) + omzetInv;
      const labaKotor   = omzetBase - hpp;
      const labaBersih  = labaKotor - pglOps;
      const marginKotor = omzetBase > 0 ? (labaKotor / omzetBase * 100) : null;
      const marginBersih= omzetBase > 0 ? (labaBersih / omzetBase * 100) : null;

      return {
        cabang         : { id: cab.id, kode: cab.kode, nama: cab.nama, kota: cab.kabupaten || cab.kecamatan || '—' },
        omzet_manual   : omzetTotal,
        omzet_cash     : omzetCash,
        omzet_transfer : omzetTrf,
        omzet_pos      : omzetPos,
        omzet_invoice  : omzetInv,
        omzet_base     : omzetBase,
        hpp            : hpp,
        laba_kotor     : labaKotor,
        pengeluaran_ops: pglOps,
        pengeluaran_total: pglTotal,
        laba_bersih    : labaBersih,
        margin_kotor   : marginKotor,
        margin_bersih  : marginBersih
      };
    });

    res.json({ success:true, data:result, dateFrom, dateTo, periodeLabel });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// GET /api/monitoring/deadstock?cabang_id=&kategori=&periode_bulan=3
// Slow-moving items: stok > 0 dan estimasi habis >= 6 bulan pada velocity saat ini
router.get('/deadstock', auth(['owner','manajer','head_operational','admin_pusat','spv_area']), async (req, res) => {
  try {
    const { getCabangAkses } = require('../middleware/cabangFilter');
    const periodeBulan = Math.max(1, parseInt(req.query.periode_bulan) || 3);
    const hariPeriode  = periodeBulan * 30;

    // Tentukan cabang yang boleh diakses
    const extraWhere = [];
    const extraParams = [];

    const akses = await getCabangAkses(req.user);
    if (akses !== null) {
      if (akses.length === 0) return res.json({ success:true, data:[], summary:{ warn_6_9:0, warn_9_12:0, warn_12_plus:0, total:0 }, periode_bulan: periodeBulan });
      extraWhere.push(`s.cabang_id IN (${akses.map(()=>'?').join(',')})`);
      extraParams.push(...akses);
    }
    if (req.query.cabang_id) {
      extraWhere.push('s.cabang_id = ?');
      extraParams.push(parseInt(req.query.cabang_id));
    }
    if (req.query.kategori) {
      extraWhere.push('p.kategori = ?');
      extraParams.push(req.query.kategori);
    }

    const whereClause = extraWhere.length ? 'AND ' + extraWhere.join(' AND ') : '';

    const [rows] = await db.query(`
      SELECT
        p.id          AS produk_id,
        p.sku,
        p.nama,
        p.kategori,
        p.harga_modal,
        p.harga_jual,
        c.id          AS cabang_id,
        c.nama        AS nama_cabang,
        s.qty         AS stok_sekarang,
        COALESCE(vel.terjual, 0)                             AS terjual_periode,
        ROUND(COALESCE(vel.terjual, 0) / ?, 2)              AS velocity_per_bulan,
        CASE
          WHEN COALESCE(vel.terjual, 0) = 0 THEN 9999
          ELSE ROUND(s.qty / (COALESCE(vel.terjual, 0) / ?), 1)
        END AS estimasi_bulan
      FROM pos_stok s
      JOIN pos_produk p ON p.id = s.produk_id
      JOIN cabang     c ON c.id = s.cabang_id
      LEFT JOIN (
        SELECT ti.produk_id, t.cabang_id, SUM(ti.qty) AS terjual
        FROM pos_transaksi_item ti
        JOIN pos_transaksi t ON t.id = ti.transaksi_id
        WHERE t.status = 'selesai'
          AND t.created_at >= NOW() - INTERVAL ? DAY
        GROUP BY ti.produk_id, t.cabang_id
      ) vel ON vel.produk_id = s.produk_id AND vel.cabang_id = s.cabang_id
      WHERE s.qty > 0 AND c.aktif = 1 AND p.aktif = 1
        ${whereClause}
      HAVING estimasi_bulan >= 6
      ORDER BY estimasi_bulan DESC, s.qty DESC
    `, [periodeBulan, periodeBulan, hariPeriode, ...extraParams]);

    const summary = { warn_6_9:0, warn_9_12:0, warn_12_plus:0, total: rows.length };
    const data = rows.map(r => {
      const est = r.estimasi_bulan >= 9999 ? null : r.estimasi_bulan;
      const level = est === null || est >= 12 ? 'warn_12_plus'
                  : est >= 9 ? 'warn_9_12' : 'warn_6_9';
      summary[level]++;
      return { ...r, estimasi_bulan: est, warning: level };
    });

    res.json({ success:true, data, summary, periode_bulan: periodeBulan });
  } catch(e) {
    console.error('monitoring deadstock:', e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// GET /api/monitoring/modal — monitoring modal seluruh cabang + history
router.get('/modal', auth(['owner','manajer','spv_area']), async (req, res) => {
  try {
    const { getCabangAkses } = require('../middleware/cabangFilter');
    const akses = await getCabangAkses(req.user);

    let cabangWhere = 'WHERE aktif=1';
    const cabangParams = [];
    if (akses !== null) {
      if (akses.length === 0) return res.json({success:true,data:{cabang:[],history:[],totals:{}}});
      cabangWhere += ` AND id IN (${akses.map(()=>'?').join(',')})`;
      cabangParams.push(...akses);
    }
    const [cabangList] = await db.query(`SELECT id,kode,nama,kecamatan,kabupaten FROM cabang ${cabangWhere} ORDER BY kode`, cabangParams);
    if (!cabangList.length) return res.json({success:true,data:{cabang:[],history:[],totals:{}}});

    const cabangIds = cabangList.map(c=>c.id);
    const ph = cabangIds.map(()=>'?').join(',');

    // ── Auto-snapshot hari ini jika belum ada ──
    const todayStr = new Date().toISOString().slice(0,10);
    const [[snapCheck]] = await db.query('SELECT COUNT(*) as c FROM pos_modal_snapshot WHERE tanggal=?',[todayStr]);
    if (snapCheck.c === 0) {
      await db.query(`INSERT IGNORE INTO pos_modal_snapshot (tanggal,cabang_id,total_produk,total_stok,total_modal,total_nilai_jual)
        SELECT ?,s.cabang_id,COUNT(DISTINCT p.id),COALESCE(SUM(s.qty),0),
               COALESCE(SUM(s.qty*p.harga_modal),0),COALESCE(SUM(s.qty*p.harga_jual),0)
        FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.qty>0
        WHERE p.aktif=1 GROUP BY s.cabang_id`,[todayStr]);
    }

    // ── Modal LIVE per cabang ──
    const [modalRows] = await db.query(`
      SELECT s.cabang_id,
             COUNT(DISTINCT p.id) as total_produk,
             COALESCE(SUM(s.qty),0) as total_stok,
             COALESCE(SUM(s.qty*p.harga_modal),0) as total_modal,
             COALESCE(SUM(s.qty*p.harga_jual),0) as total_nilai_jual
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.qty>0 AND s.cabang_id IN (${ph})
      WHERE p.aktif=1
      GROUP BY s.cabang_id`, cabangIds);

    const modalMap = {};
    modalRows.forEach(r => { modalMap[r.cabang_id] = r; });

    // ── Modal per kategori global ──
    const [katRows] = await db.query(`
      SELECT COALESCE(p.kategori,'Tanpa Kategori') as kategori,
             SUM(s.qty) as total_stok,
             SUM(s.qty*p.harga_modal) as total_modal,
             SUM(s.qty*p.harga_jual) as total_nilai_jual
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.qty>0 AND s.cabang_id IN (${ph})
      WHERE p.aktif=1
      GROUP BY p.kategori ORDER BY total_modal DESC`, cabangIds);

    // ── Top 10 produk modal terbesar ──
    const [topProduk] = await db.query(`
      SELECT p.sku, p.nama, p.kategori, p.harga_modal,
             SUM(s.qty) as total_stok,
             SUM(s.qty*p.harga_modal) as total_modal
      FROM pos_produk p
      JOIN pos_stok s ON s.produk_id=p.id AND s.qty>0 AND s.cabang_id IN (${ph})
      WHERE p.aktif=1
      GROUP BY p.id, p.sku, p.nama, p.kategori, p.harga_modal ORDER BY total_modal DESC LIMIT 10`, cabangIds);

    // ── History snapshot (90 hari terakhir, agregat semua cabang) ──
    const [history] = await db.query(`
      SELECT tanggal, SUM(total_modal) as total_modal, SUM(total_nilai_jual) as total_nilai_jual,
             SUM(total_stok) as total_stok
      FROM pos_modal_snapshot
      WHERE cabang_id IN (${ph}) AND tanggal >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      GROUP BY tanggal ORDER BY tanggal ASC`, cabangIds);

    // ── History per cabang (30 hari) — untuk sparkline ──
    const [histCabang] = await db.query(`
      SELECT tanggal, cabang_id, total_modal
      FROM pos_modal_snapshot
      WHERE cabang_id IN (${ph}) AND tanggal >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
      ORDER BY tanggal ASC`, cabangIds);
    const histCabMap = {};
    histCabang.forEach(r => {
      if (!histCabMap[r.cabang_id]) histCabMap[r.cabang_id] = [];
      histCabMap[r.cabang_id].push({tanggal:r.tanggal, modal:r.total_modal});
    });

    // ── Modal bulan lalu untuk growth ──
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth()-1);
    const lmStr = lastMonth.toISOString().slice(0,10);
    const [[prevSnap]] = await db.query(`
      SELECT SUM(total_modal) as total_modal
      FROM pos_modal_snapshot
      WHERE cabang_id IN (${ph}) AND tanggal = (
        SELECT MAX(tanggal) FROM pos_modal_snapshot WHERE tanggal <= ? AND tanggal >= DATE_SUB(?, INTERVAL 7 DAY)
      )`, [...cabangIds, lmStr, lmStr]);

    // ── Build cabang result ──
    let grandModal=0, grandJual=0, grandStok=0, grandProduk=0;
    const cabangResult = cabangList.map(cab => {
      const m = modalMap[cab.id] || {total_produk:0,total_stok:0,total_modal:0,total_nilai_jual:0};
      grandModal  += Number(m.total_modal);
      grandJual   += Number(m.total_nilai_jual);
      grandStok   += Number(m.total_stok);
      grandProduk += Number(m.total_produk);

      // Hitung growth dari history cabang
      const hist = histCabMap[cab.id] || [];
      let growth = null;
      if (hist.length >= 2) {
        const oldest = Number(hist[0].modal);
        const newest = Number(hist[hist.length-1].modal);
        growth = oldest > 0 ? ((newest - oldest) / oldest * 100) : null;
      }

      return {
        cabang: {id:cab.id, kode:cab.kode, nama:cab.nama, kota: cab.kabupaten||cab.kecamatan||'-'},
        total_produk: Number(m.total_produk),
        total_stok: Number(m.total_stok),
        total_modal: Number(m.total_modal),
        total_nilai_jual: Number(m.total_nilai_jual),
        potensi_laba: Number(m.total_nilai_jual) - Number(m.total_modal),
        growth_30d: growth,
        history: hist
      };
    });

    // ── Grand growth ──
    const prevModal = prevSnap?.total_modal ? Number(prevSnap.total_modal) : null;
    const grandGrowth = prevModal && prevModal > 0 ? ((grandModal - prevModal) / prevModal * 100) : null;

    res.json({success:true, data:{
      totals: {
        total_modal: grandModal,
        total_nilai_jual: grandJual,
        potensi_laba: grandJual - grandModal,
        total_stok: grandStok,
        total_produk: grandProduk,
        total_cabang: cabangList.length,
        growth_vs_prev: grandGrowth,
        prev_modal: prevModal,
        avg_modal_per_cabang: cabangList.length > 0 ? Math.round(grandModal / cabangList.length) : 0
      },
      cabang: cabangResult.sort((a,b) => b.total_modal - a.total_modal),
      perKategori: katRows,
      topProduk,
      history: history.map(h => ({
        tanggal: h.tanggal,
        total_modal: Number(h.total_modal),
        total_nilai_jual: Number(h.total_nilai_jual),
        total_stok: Number(h.total_stok)
      }))
    }});
  } catch(e) {
    console.error('monitoring modal:', e);
    res.status(500).json({success:false,message:e.message});
  }
});

// GET /api/monitoring/marketplace — laporan biaya marketplace untuk arsip/DJP
router.get('/marketplace', auth(['owner','manajer','admin_pusat','finance','head_operational']), async (req, res) => {
  try {
    const { dari, sampai, platform } = req.query;
    const today = new Date().toISOString().slice(0,10);
    const bulanIni = today.slice(0,7) + '-01';
    const dateFrom = dari || bulanIni;
    const dateTo   = sampai || today;

    let where = `t.status='selesai' AND t.catatan LIKE 'Marketplace:%' AND t.created_at >= ? AND t.created_at <= ?`;
    const params = [dateFrom + ' 00:00:00', dateTo + ' 23:59:59'];

    if (platform) {
      where += ` AND t.catatan LIKE ?`;
      params.push(`%${platform}%`);
    }

    // 1. Rekap per platform
    const [rekapRows] = await db.query(`
      SELECT
        CASE
          WHEN t.catatan LIKE '%Toped iOS%' THEN 'Tokopedia iOS'
          WHEN t.catatan LIKE '%Tokopedia Android%' OR t.catatan LIKE '%Toped Andro%' THEN 'Tokopedia Android'
          WHEN t.catatan LIKE '%Shopee%' THEN 'Shopee'
          ELSE 'Lainnya'
        END AS platform,
        COUNT(*) AS jumlah_trx,
        COALESCE(SUM(t.subtotal),0) AS omzet_kotor,
        COALESCE(SUM(t.diskon),0) AS biaya_marketplace,
        COALESCE(SUM(t.total),0) AS omzet_net
      FROM pos_transaksi t
      WHERE ${where}
      GROUP BY platform
      ORDER BY biaya_marketplace DESC`, params);

    // 2. Grand total
    const [[ grandTotal ]] = await db.query(`
      SELECT COUNT(*) AS jumlah_trx,
             COALESCE(SUM(t.subtotal),0) AS omzet_kotor,
             COALESCE(SUM(t.diskon),0) AS biaya_marketplace,
             COALESCE(SUM(t.total),0) AS omzet_net
      FROM pos_transaksi t
      WHERE ${where}`, params);

    // 3. Rekap harian
    const [harianRows] = await db.query(`
      SELECT DATE_FORMAT(t.created_at,'%Y-%m-%d') AS tanggal,
        CASE
          WHEN t.catatan LIKE '%Toped iOS%' THEN 'Tokopedia iOS'
          WHEN t.catatan LIKE '%Tokopedia Android%' OR t.catatan LIKE '%Toped Andro%' THEN 'Tokopedia Android'
          WHEN t.catatan LIKE '%Shopee%' THEN 'Shopee'
          ELSE 'Lainnya'
        END AS platform,
        COUNT(*) AS jumlah_trx,
        COALESCE(SUM(t.subtotal),0) AS omzet_kotor,
        COALESCE(SUM(t.diskon),0) AS biaya_marketplace,
        COALESCE(SUM(t.total),0) AS omzet_net
      FROM pos_transaksi t
      WHERE ${where}
      GROUP BY tanggal, platform
      ORDER BY tanggal DESC, platform`, params);

    // 4. Detail per transaksi
    const [detailRows] = await db.query(`
      SELECT t.id, DATE_FORMAT(t.created_at,'%Y-%m-%d %H:%i') AS waktu,
        t.subtotal AS omzet_kotor, t.diskon AS biaya_mp, t.total AS omzet_net,
        t.catatan,
        CASE
          WHEN t.catatan LIKE '%Toped iOS%' THEN 'Tokopedia iOS'
          WHEN t.catatan LIKE '%Tokopedia Android%' OR t.catatan LIKE '%Toped Andro%' THEN 'Tokopedia Android'
          WHEN t.catatan LIKE '%Shopee%' THEN 'Shopee'
          ELSE 'Lainnya'
        END AS platform,
        u.nama_lengkap AS kasir
      FROM pos_transaksi t
      LEFT JOIN users u ON u.id = t.kasir_id
      WHERE ${where}
      ORDER BY t.created_at DESC
      LIMIT 1000`, params);

    res.json({
      success: true,
      data: {
        rekap_platform: rekapRows.map(r => ({
          ...r,
          omzet_kotor: parseFloat(r.omzet_kotor),
          biaya_marketplace: parseFloat(r.biaya_marketplace),
          omzet_net: parseFloat(r.omzet_net),
          persen_fee: parseFloat(r.omzet_kotor) > 0 ? (parseFloat(r.biaya_marketplace) / parseFloat(r.omzet_kotor) * 100) : 0
        })),
        grand_total: {
          jumlah_trx: parseInt(grandTotal.jumlah_trx),
          omzet_kotor: parseFloat(grandTotal.omzet_kotor),
          biaya_marketplace: parseFloat(grandTotal.biaya_marketplace),
          omzet_net: parseFloat(grandTotal.omzet_net),
          persen_fee: parseFloat(grandTotal.omzet_kotor) > 0 ? (parseFloat(grandTotal.biaya_marketplace) / parseFloat(grandTotal.omzet_kotor) * 100) : 0
        },
        rekap_harian: harianRows.map(r => ({
          ...r,
          omzet_kotor: parseFloat(r.omzet_kotor),
          biaya_marketplace: parseFloat(r.biaya_marketplace),
          omzet_net: parseFloat(r.omzet_net)
        })),
        detail: detailRows.map(r => ({
          ...r,
          omzet_kotor: parseFloat(r.omzet_kotor),
          biaya_mp: parseFloat(r.biaya_mp),
          omzet_net: parseFloat(r.omzet_net)
        })),
        dateFrom, dateTo
      }
    });
  } catch(e) {
    console.error('monitoring marketplace:', e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/monitoring/laba-rugi — Laporan Laba Rugi (P&L) per cabang
// ══════════════════════════════════════════════════════════════════════
router.get('/laba-rugi', auth(['owner','manajer','manajer_area','spv_area','finance','head_operational','admin_pusat']), async (req, res) => {
  try {
    const { periode, dari, sampai, cabang_id } = req.query;
    const today    = new Date();
    const todayStr = today.toISOString().slice(0,10);

    // Periode calculation
    let dateFrom, dateTo, periodeLabel;
    if (periode === 'bulan-lalu') {
      const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0');
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
      dateFrom = `${y}-${m}-01`; dateTo = `${y}-${m}-${String(lastDay).padStart(2,'0')}`;
      periodeLabel = `${d.toLocaleString('id-ID',{month:'long',year:'numeric'})}`;
    } else if (periode === 'tahun-ini') {
      dateFrom = `${today.getFullYear()}-01-01`; dateTo = todayStr;
      periodeLabel = `Januari - ${today.toLocaleString('id-ID',{month:'long'})} ${today.getFullYear()}`;
    } else if (periode === 'custom' && dari && sampai) {
      dateFrom = dari; dateTo = sampai;
      periodeLabel = `${dari} s/d ${sampai}`;
    } else {
      const y = today.getFullYear(), m = String(today.getMonth()+1).padStart(2,'0');
      dateFrom = `${y}-${m}-01`; dateTo = todayStr;
      periodeLabel = `${today.toLocaleString('id-ID',{month:'long',year:'numeric'})}`;
    }

    // Cabang akses
    const { getCabangAkses } = require('../middleware/cabangFilter');
    const akses = await getCabangAkses(req.user);

    let cabangWhere = 'WHERE aktif=1';
    const cabangParams = [];
    if (akses !== null) {
      if (akses.length === 0) return res.json({ success:true, data:[], konsolidasi:null, dateFrom, dateTo, periodeLabel });
      cabangWhere += ` AND id IN (${akses.map(()=>'?').join(',')})`;
      cabangParams.push(...akses);
    }
    if (cabang_id) {
      cabangWhere += ' AND id=?';
      cabangParams.push(parseInt(cabang_id));
    }

    const [cabangList] = await db.query(
      `SELECT id, kode, nama, kecamatan, kabupaten FROM cabang ${cabangWhere} ORDER BY kode`,
      cabangParams
    );
    if (!cabangList.length) return res.json({ success:true, data:[], konsolidasi:null, dateFrom, dateTo, periodeLabel });

    const cabangIds = cabangList.map(c => c.id);
    const ph = cabangIds.map(() => '?').join(',');

    // ── PENDAPATAN ──

    // 1. Omzet POS
    const [posRows] = await db.query(`
      SELECT cabang_id, COALESCE(SUM(total),0) AS omzet_pos
      FROM pos_transaksi
      WHERE cabang_id IN (${ph}) AND status='selesai'
        AND created_at >= ? AND created_at <= ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']);

    // 2. Omzet Invoice
    const [invRows] = await db.query(`
      SELECT COALESCE(u.cabang_id, 3) AS cabang_id,
             COALESCE(SUM(i.total),0) AS omzet_inv
      FROM invoice i
      JOIN users u ON u.id = i.sales_id
      WHERE i.status IN ('diterbitkan','lunas')
        AND i.tanggal BETWEEN ? AND ?
        AND COALESCE(u.cabang_id, 3) IN (${ph})
      GROUP BY COALESCE(u.cabang_id, 3)`,
      [dateFrom, dateTo, ...cabangIds]);

    // 3. Pemasukan lain
    const [pemasukanRows] = await db.query(`
      SELECT cabang_id, COALESCE(SUM(nominal),0) AS pemasukan_lain
      FROM pemasukan
      WHERE cabang_id IN (${ph}) AND tanggal BETWEEN ? AND ?
      GROUP BY cabang_id`,
      [...cabangIds, dateFrom, dateTo]);

    // ── HPP ──

    // 4. HPP POS
    const [hppPosRows] = await db.query(`
      SELECT t.cabang_id,
             COALESCE(SUM(ti.harga_modal * ti.qty),0) AS hpp_pos
      FROM pos_transaksi t
      JOIN pos_transaksi_item ti ON ti.transaksi_id = t.id
      WHERE t.cabang_id IN (${ph}) AND t.status='selesai'
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.cabang_id`,
      [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']);

    // 5. HPP Invoice
    const [hppInvRows] = await db.query(`
      SELECT COALESCE(u.cabang_id, 3) AS cabang_id,
             COALESCE(SUM(p.harga_modal * ii.qty),0) AS hpp_inv
      FROM invoice i
      JOIN users u ON u.id = i.sales_id
      JOIN invoice_item ii ON ii.invoice_id = i.id
      LEFT JOIN pos_produk p ON p.id = ii.produk_id
      WHERE i.status IN ('diterbitkan','lunas')
        AND i.tanggal BETWEEN ? AND ?
        AND COALESCE(u.cabang_id, 3) IN (${ph})
      GROUP BY COALESCE(u.cabang_id, 3)`,
      [dateFrom, dateTo, ...cabangIds]);

    // ── BEBAN OPERASIONAL (per kategori) ──

    // 6. Pengeluaran grouped by kategori (exclude pembelian barang/ongkir)
    const [pglRows] = await db.query(`
      SELECT p.cabang_id, p.kategori_id, pk.nama AS nama_kategori,
             COALESCE(SUM(p.nominal),0) AS total
      FROM pengeluaran p
      LEFT JOIN pengeluaran_kategori pk ON pk.id = p.kategori_id
      WHERE p.cabang_id IN (${ph}) AND p.status='approved'
        AND p.tanggal BETWEEN ? AND ?
        AND p.kategori_id NOT IN (26,27,28)
      GROUP BY p.cabang_id, p.kategori_id, pk.nama
      ORDER BY p.cabang_id, pk.nama`,
      [...cabangIds, dateFrom, dateTo]);

    // ── BUILD MAPS ──
    const posMap = {}; posRows.forEach(r => { posMap[r.cabang_id] = parseFloat(r.omzet_pos); });
    const invMap = {}; invRows.forEach(r => { invMap[r.cabang_id] = parseFloat(r.omzet_inv); });
    const pmkMap = {}; pemasukanRows.forEach(r => { pmkMap[r.cabang_id] = parseFloat(r.pemasukan_lain); });
    const hppPosMap = {}; hppPosRows.forEach(r => { hppPosMap[r.cabang_id] = parseFloat(r.hpp_pos); });
    const hppInvMap = {}; hppInvRows.forEach(r => { hppInvMap[r.cabang_id] = parseFloat(r.hpp_inv); });

    // Build pengeluaran per cabang per kategori
    const pglMap = {};
    pglRows.forEach(r => {
      if (!pglMap[r.cabang_id]) pglMap[r.cabang_id] = {};
      pglMap[r.cabang_id][r.nama_kategori || 'Lain-lain'] = parseFloat(r.total);
    });

    // Collect all unique kategori names
    const allKategori = [...new Set(pglRows.map(r => r.nama_kategori || 'Lain-lain'))].sort();

    // ── BUILD RESULT PER CABANG ──
    const data = cabangList.map(cab => {
      const omzetPos  = posMap[cab.id] || 0;
      const omzetInv  = invMap[cab.id] || 0;
      const pemasukan = pmkMap[cab.id] || 0;
      const totalPendapatan = omzetPos + omzetInv + pemasukan;

      const hppPos = hppPosMap[cab.id] || 0;
      const hppInv = hppInvMap[cab.id] || 0;
      const totalHpp = hppPos + hppInv;

      const labaKotor = totalPendapatan - totalHpp;

      // Beban operasional per kategori
      const bebanDetail = {};
      let totalBeban = 0;
      const cabPgl = pglMap[cab.id] || {};
      for (const kat of allKategori) {
        const val = cabPgl[kat] || 0;
        bebanDetail[kat] = val;
        totalBeban += val;
      }

      const labaBersih   = labaKotor - totalBeban;
      const marginKotor  = totalPendapatan > 0 ? Math.round(labaKotor / totalPendapatan * 1000) / 10 : 0;
      const marginBersih = totalPendapatan > 0 ? Math.round(labaBersih / totalPendapatan * 1000) / 10 : 0;

      return {
        cabang: { id: cab.id, kode: cab.kode, nama: cab.nama },
        pendapatan: {
          omzet_pos: omzetPos,
          omzet_invoice: omzetInv,
          pemasukan_lain: pemasukan,
          total: totalPendapatan
        },
        hpp: {
          hpp_pos: hppPos,
          hpp_invoice: hppInv,
          total: totalHpp
        },
        laba_kotor: labaKotor,
        beban_operasional: {
          detail: bebanDetail,
          total: totalBeban
        },
        laba_bersih: labaBersih,
        margin_kotor: marginKotor,
        margin_bersih: marginBersih
      };
    });

    // ── KONSOLIDASI (Total semua cabang) ──
    const kon = {
      pendapatan: { omzet_pos:0, omzet_invoice:0, pemasukan_lain:0, total:0 },
      hpp: { hpp_pos:0, hpp_invoice:0, total:0 },
      laba_kotor: 0,
      beban_operasional: { detail:{}, total:0 },
      laba_bersih: 0,
      margin_kotor: 0,
      margin_bersih: 0,
      jumlah_cabang: data.length,
      cabang_untung: 0,
      cabang_rugi: 0
    };
    for (const kat of allKategori) kon.beban_operasional.detail[kat] = 0;

    data.forEach(d => {
      kon.pendapatan.omzet_pos     += d.pendapatan.omzet_pos;
      kon.pendapatan.omzet_invoice += d.pendapatan.omzet_invoice;
      kon.pendapatan.pemasukan_lain += d.pendapatan.pemasukan_lain;
      kon.pendapatan.total         += d.pendapatan.total;
      kon.hpp.hpp_pos              += d.hpp.hpp_pos;
      kon.hpp.hpp_invoice          += d.hpp.hpp_invoice;
      kon.hpp.total                += d.hpp.total;
      kon.laba_kotor               += d.laba_kotor;
      kon.beban_operasional.total  += d.beban_operasional.total;
      kon.laba_bersih              += d.laba_bersih;
      for (const kat of allKategori) {
        kon.beban_operasional.detail[kat] += (d.beban_operasional.detail[kat] || 0);
      }
      if (d.laba_bersih >= 0) kon.cabang_untung++; else kon.cabang_rugi++;
    });
    kon.margin_kotor  = kon.pendapatan.total > 0 ? Math.round(kon.laba_kotor / kon.pendapatan.total * 1000) / 10 : 0;
    kon.margin_bersih = kon.pendapatan.total > 0 ? Math.round(kon.laba_bersih / kon.pendapatan.total * 1000) / 10 : 0;

    // Sort: cabang paling untung di atas
    data.sort((a,b) => b.laba_bersih - a.laba_bersih);

    res.json({
      success: true,
      data,
      konsolidasi: kon,
      kategori_beban: allKategori,
      dateFrom, dateTo, periodeLabel
    });
  } catch(e) {
    console.error('laba-rugi error:', e);
    res.status(500).json({ success:false, message:e.message });
  }
});

module.exports = router;
