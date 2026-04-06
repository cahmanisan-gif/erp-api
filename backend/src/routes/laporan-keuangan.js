const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { requireModule } = require('../middleware/moduleAccess');

// Helper: safely query a table that may not exist — returns empty array
async function safeQuery(sql, params = []) {
  try {
    const [rows] = await db.query(sql, params);
    return rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146) return [];
    throw e;
  }
}

// Helper: extract single numeric value from safeQuery result
function sumVal(rows, col = 'total') {
  if (!rows.length) return 0;
  return parseFloat(rows[0][col]) || 0;
}

// ══════════════════════════════════════════════════════════════════════
// GET /api/laporan-keuangan/neraca?tanggal=YYYY-MM-DD
// Balance Sheet (Neraca) — snapshot pada tanggal tertentu
// ══════════════════════════════════════════════════════════════════════
router.get('/neraca', auth(), requireModule('laba_rugi'), async (req, res) => {
  try {
    const tanggal = req.query.tanggal || new Date().toISOString().slice(0, 10);

    // ── ASET ──

    // 1. Kas & Bank: saldo_awal + mutasi masuk - mutasi keluar s/d tanggal
    const kasRows = await safeQuery(`
      SELECT ka.id, ka.nama_akun, ka.nama_bank, ka.saldo_awal,
             COALESCE(m_in.total_masuk, 0) AS total_masuk,
             COALESCE(m_out.total_keluar, 0) AS total_keluar
      FROM kas_akun ka
      LEFT JOIN (
        SELECT akun_id, SUM(nominal) AS total_masuk
        FROM kas_mutasi
        WHERE tipe IN ('masuk','transfer_in') AND tanggal <= ?
        GROUP BY akun_id
      ) m_in ON m_in.akun_id = ka.id
      LEFT JOIN (
        SELECT akun_id, SUM(nominal) AS total_keluar
        FROM kas_mutasi
        WHERE tipe IN ('keluar','transfer_out') AND tanggal <= ?
        GROUP BY akun_id
      ) m_out ON m_out.akun_id = ka.id
      WHERE ka.aktif = 1`, [tanggal, tanggal]);

    const kasDetail = kasRows.map(r => ({
      id: r.id,
      nama_akun: r.nama_akun,
      nama_bank: r.nama_bank,
      saldo_awal: parseFloat(r.saldo_awal),
      mutasi_masuk: parseFloat(r.total_masuk),
      mutasi_keluar: parseFloat(r.total_keluar),
      saldo: parseFloat(r.saldo_awal) + parseFloat(r.total_masuk) - parseFloat(r.total_keluar)
    }));
    const totalKasBank = kasDetail.reduce((s, r) => s + r.saldo, 0);

    // 2. Piutang Usaha: outstanding piutang s/d tanggal
    const piutangRows = await safeQuery(`
      SELECT COALESCE(SUM(total - terbayar), 0) AS total
      FROM piutang
      WHERE status = 'belum_lunas' AND created_at <= ?`,
      [tanggal + ' 23:59:59']);
    const totalPiutang = sumVal(piutangRows);

    // 3. Persediaan: SUM(qty * harga_modal) all branches
    const persediaanRows = await safeQuery(`
      SELECT COALESCE(SUM(s.qty * p.harga_modal), 0) AS total
      FROM pos_stok s
      JOIN pos_produk p ON p.id = s.produk_id
      WHERE p.aktif = 1 AND s.qty > 0`);
    const totalPersediaan = sumVal(persediaanRows);

    // 4. Aset Tetap: SUM nilai_sisa from aset_cabang yang aktif
    const asetRows = await safeQuery(`
      SELECT COALESCE(SUM(nilai_sisa), 0) AS total
      FROM aset_cabang
      WHERE aktif = 1`);
    const totalAsetTetap = sumVal(asetRows);

    const totalAset = totalKasBank + totalPiutang + totalPersediaan + totalAsetTetap;

    // ── KEWAJIBAN ──

    // 5. Hutang Supplier (table may not exist)
    const hutangRows = await safeQuery(`
      SELECT COALESCE(SUM(total - terbayar), 0) AS total
      FROM hutang_supplier
      WHERE status = 'belum_lunas'`);
    const totalHutangSupplier = sumVal(hutangRows);

    const totalKewajiban = totalHutangSupplier;

    // ── EKUITAS ──
    const totalEkuitas = totalAset - totalKewajiban;

    res.json({
      success: true,
      tanggal,
      neraca: {
        aset: {
          kas_bank: { detail: kasDetail, total: totalKasBank },
          piutang_usaha: totalPiutang,
          persediaan: totalPersediaan,
          aset_tetap: totalAsetTetap,
          total: totalAset
        },
        kewajiban: {
          hutang_supplier: totalHutangSupplier,
          total: totalKewajiban
        },
        ekuitas: {
          total: totalEkuitas
        },
        balance_check: Math.abs(totalAset - totalKewajiban - totalEkuitas) < 0.01
      }
    });
  } catch (e) {
    console.error('neraca error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/laporan-keuangan/arus-kas?dari=YYYY-MM-DD&sampai=YYYY-MM-DD
// Cash Flow Statement (Arus Kas)
// ══════════════════════════════════════════════════════════════════════
router.get('/arus-kas', auth(), requireModule('laba_rugi'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dari   = req.query.dari   || today.slice(0, 8) + '01';
    const sampai = req.query.sampai || today;

    // ── OPERASIONAL ──

    // 1. Penerimaan dari penjualan POS
    const posRows = await safeQuery(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pos_transaksi
      WHERE status = 'selesai'
        AND created_at >= ? AND created_at <= ?`,
      [dari + ' 00:00:00', sampai + ' 23:59:59']);
    const penerimaanPOS = sumVal(posRows);

    // 2. Penerimaan dari invoice
    const invRows = await safeQuery(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM invoice
      WHERE status = 'lunas'
        AND tanggal_lunas BETWEEN ? AND ?`,
      [dari, sampai]);
    const penerimaanInvoice = sumVal(invRows);

    // 3. Pemasukan lain
    const pemasukanRows = await safeQuery(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM pemasukan
      WHERE tanggal BETWEEN ? AND ?`,
      [dari, sampai]);
    const pemasukanLain = sumVal(pemasukanRows);

    const totalPenerimaan = penerimaanPOS + penerimaanInvoice + pemasukanLain;

    // 4. Pembayaran ke supplier (kas_mutasi keluar yang terkait pembelian)
    const supplierRows = await safeQuery(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM kas_mutasi
      WHERE tipe = 'keluar' AND keterangan LIKE '%Pembelian%'
        AND tanggal BETWEEN ? AND ?`,
      [dari, sampai]);
    const bayarSupplier = sumVal(supplierRows);

    // 5. Pengeluaran operasional (approved, exclude pembelian aset & pembelian barang)
    const pglRows = await safeQuery(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM pengeluaran
      WHERE status = 'approved'
        AND kategori_id NOT IN (21, 26, 27)
        AND tanggal BETWEEN ? AND ?`,
      [dari, sampai]);
    const pengeluaranOps = sumVal(pglRows);

    // 6. Pembayaran gaji (kas_mutasi)
    const gajiRows = await safeQuery(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM kas_mutasi
      WHERE tipe = 'keluar'
        AND (LOWER(keterangan) LIKE '%gaji%' OR LOWER(keterangan) LIKE '%payroll%')
        AND tanggal BETWEEN ? AND ?`,
      [dari, sampai]);
    const bayarGaji = sumVal(gajiRows);

    const totalPengeluaranOps = bayarSupplier + pengeluaranOps + bayarGaji;
    const arusKasOperasional = totalPenerimaan - totalPengeluaranOps;

    // ── INVESTASI ──

    // 7. Pembelian aset (kategori_id=21 = Pembelian Aset)
    const asetRows = await safeQuery(`
      SELECT COALESCE(SUM(nominal), 0) AS total
      FROM pengeluaran
      WHERE status = 'approved' AND kategori_id = 21
        AND tanggal BETWEEN ? AND ?`,
      [dari, sampai]);
    const pembelianAset = sumVal(asetRows);

    const arusKasInvestasi = -pembelianAset;

    // ── TOTAL ──
    const totalArusKas = arusKasOperasional + arusKasInvestasi;

    // ── Saldo kas awal & akhir ──
    const saldoAwalRows = await safeQuery(`
      SELECT COALESCE(SUM(ka.saldo_awal), 0)
             + COALESCE((SELECT SUM(nominal) FROM kas_mutasi WHERE tipe IN ('masuk','transfer_in') AND tanggal < ?), 0)
             - COALESCE((SELECT SUM(nominal) FROM kas_mutasi WHERE tipe IN ('keluar','transfer_out') AND tanggal < ?), 0)
             AS total
      FROM kas_akun ka WHERE ka.aktif = 1`,
      [dari, dari]);
    const saldoKasAwal = sumVal(saldoAwalRows);
    const saldoKasAkhir = saldoKasAwal + totalArusKas;

    res.json({
      success: true,
      periode: { dari, sampai },
      arus_kas: {
        operasional: {
          penerimaan: {
            penjualan_pos: penerimaanPOS,
            invoice_lunas: penerimaanInvoice,
            pemasukan_lain: pemasukanLain,
            total: totalPenerimaan
          },
          pengeluaran: {
            bayar_supplier: bayarSupplier,
            operasional: pengeluaranOps,
            gaji: bayarGaji,
            total: totalPengeluaranOps
          },
          neto: arusKasOperasional
        },
        investasi: {
          pembelian_aset: pembelianAset,
          neto: arusKasInvestasi
        },
        total_arus_kas: totalArusKas,
        saldo_kas_awal: saldoKasAwal,
        saldo_kas_akhir: saldoKasAkhir
      }
    });
  } catch (e) {
    console.error('arus-kas error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/laporan-keuangan/aging-piutang?per_tanggal=YYYY-MM-DD
// Piutang Aging Report — breakdown by age bucket per customer
// ══════════════════════════════════════════════════════════════════════
router.get('/aging-piutang', auth(), requireModule('laba_rugi'), async (req, res) => {
  try {
    const perTanggal = req.query.per_tanggal || new Date().toISOString().slice(0, 10);

    const rows = await safeQuery(`
      SELECT p.id, p.nama_pelanggan, p.no_hp, p.cabang_id,
             c.kode AS cabang_kode, c.nama AS cabang_nama,
             p.total, p.terbayar, (p.total - p.terbayar) AS sisa,
             p.jatuh_tempo, p.created_at,
             CASE
               WHEN p.jatuh_tempo IS NULL THEN 'no_due_date'
               WHEN p.jatuh_tempo >= ? THEN 'current'
               WHEN DATEDIFF(?, p.jatuh_tempo) BETWEEN 1 AND 30 THEN '1_30'
               WHEN DATEDIFF(?, p.jatuh_tempo) BETWEEN 31 AND 60 THEN '31_60'
               WHEN DATEDIFF(?, p.jatuh_tempo) BETWEEN 61 AND 90 THEN '61_90'
               ELSE 'over_90'
             END AS bucket
      FROM piutang p
      LEFT JOIN cabang c ON c.id = p.cabang_id
      WHERE p.status = 'belum_lunas'
      ORDER BY p.jatuh_tempo ASC, p.nama_pelanggan`,
      [perTanggal, perTanggal, perTanggal, perTanggal]);

    // Build per-customer detail grouped by bucket
    const buckets = {
      current:    { label: 'Belum Jatuh Tempo', items: [], total: 0 },
      '1_30':     { label: '1-30 Hari', items: [], total: 0 },
      '31_60':    { label: '31-60 Hari', items: [], total: 0 },
      '61_90':    { label: '61-90 Hari', items: [], total: 0 },
      over_90:    { label: '> 90 Hari', items: [], total: 0 },
      no_due_date:{ label: 'Tanpa Jatuh Tempo', items: [], total: 0 }
    };

    let grandTotal = 0;
    rows.forEach(r => {
      const sisa = parseFloat(r.sisa);
      const b = buckets[r.bucket];
      if (b) {
        b.items.push({
          id: r.id,
          nama_pelanggan: r.nama_pelanggan,
          no_hp: r.no_hp,
          cabang: r.cabang_kode ? `${r.cabang_kode} - ${r.cabang_nama}` : null,
          total: parseFloat(r.total),
          terbayar: parseFloat(r.terbayar),
          sisa,
          jatuh_tempo: r.jatuh_tempo,
          created_at: r.created_at
        });
        b.total += sisa;
      }
      grandTotal += sisa;
    });

    // Summary
    const summary = {};
    for (const [key, val] of Object.entries(buckets)) {
      summary[key] = { label: val.label, jumlah: val.items.length, total: val.total };
    }

    res.json({
      success: true,
      per_tanggal: perTanggal,
      grand_total: grandTotal,
      jumlah_piutang: rows.length,
      summary,
      detail: buckets
    });
  } catch (e) {
    console.error('aging-piutang error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/laporan-keuangan/ringkasan?bulan=YYYY-MM
// Monthly Financial Summary with previous month comparison
// ══════════════════════════════════════════════════════════════════════
router.get('/ringkasan', auth(), requireModule('laba_rugi'), async (req, res) => {
  try {
    const today = new Date();
    const bulan = req.query.bulan || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

    // Parse current & previous month
    const [yr, mo] = bulan.split('-').map(Number);
    const dateFrom = `${yr}-${String(mo).padStart(2, '0')}-01`;
    const lastDay  = new Date(yr, mo, 0).getDate();
    const dateTo   = `${yr}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const prevDate = new Date(yr, mo - 2, 1); // mo-2 because mo is 1-based, Date months are 0-based
    const prevYr   = prevDate.getFullYear();
    const prevMo   = prevDate.getMonth() + 1;
    const prevFrom = `${prevYr}-${String(prevMo).padStart(2, '0')}-01`;
    const prevLastDay = new Date(prevYr, prevMo, 0).getDate();
    const prevTo   = `${prevYr}-${String(prevMo).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`;

    // Fetch data for a given period
    async function fetchPeriod(from, to) {
      // Pendapatan POS
      const posR = await safeQuery(`
        SELECT COALESCE(SUM(total), 0) AS total
        FROM pos_transaksi
        WHERE status = 'selesai' AND created_at >= ? AND created_at <= ?`,
        [from + ' 00:00:00', to + ' 23:59:59']);

      // Pendapatan Invoice
      const invR = await safeQuery(`
        SELECT COALESCE(SUM(total), 0) AS total
        FROM invoice
        WHERE status IN ('diterbitkan','lunas') AND tanggal BETWEEN ? AND ?`,
        [from, to]);

      // Pemasukan lain
      const pmkR = await safeQuery(`
        SELECT COALESCE(SUM(nominal), 0) AS total
        FROM pemasukan WHERE tanggal BETWEEN ? AND ?`,
        [from, to]);

      const pendapatanPOS     = sumVal(posR);
      const pendapatanInvoice = sumVal(invR);
      const pendapatanLain    = sumVal(pmkR);
      const totalPendapatan   = pendapatanPOS + pendapatanInvoice + pendapatanLain;

      // HPP POS
      const hppPosR = await safeQuery(`
        SELECT COALESCE(SUM(ti.harga_modal * ti.qty), 0) AS total
        FROM pos_transaksi t
        JOIN pos_transaksi_item ti ON ti.transaksi_id = t.id
        WHERE t.status = 'selesai' AND t.created_at >= ? AND t.created_at <= ?`,
        [from + ' 00:00:00', to + ' 23:59:59']);

      // HPP Invoice
      const hppInvR = await safeQuery(`
        SELECT COALESCE(SUM(p.harga_modal * ii.qty), 0) AS total
        FROM invoice i
        JOIN invoice_item ii ON ii.invoice_id = i.id
        LEFT JOIN pos_produk p ON p.id = ii.produk_id
        WHERE i.status IN ('diterbitkan','lunas') AND i.tanggal BETWEEN ? AND ?`,
        [from, to]);

      const totalHPP = sumVal(hppPosR) + sumVal(hppInvR);

      // Beban operasional
      const bebanR = await safeQuery(`
        SELECT COALESCE(SUM(nominal), 0) AS total
        FROM pengeluaran
        WHERE status = 'approved' AND kategori_id NOT IN (26, 27, 28)
          AND tanggal BETWEEN ? AND ?`,
        [from, to]);
      const totalBeban = sumVal(bebanR);

      const labaBersih = totalPendapatan - totalHPP - totalBeban;

      return {
        pendapatan: {
          pos: pendapatanPOS,
          invoice: pendapatanInvoice,
          lain: pendapatanLain,
          total: totalPendapatan
        },
        hpp: totalHPP,
        beban_operasional: totalBeban,
        laba_bersih: labaBersih
      };
    }

    // Fetch current & previous month in parallel
    const [current, prev] = await Promise.all([
      fetchPeriod(dateFrom, dateTo),
      fetchPeriod(prevFrom, prevTo)
    ]);

    // Kas & Bank (snapshot at end of current month)
    const kasR = await safeQuery(`
      SELECT COALESCE(SUM(ka.saldo_awal), 0)
             + COALESCE((SELECT SUM(nominal) FROM kas_mutasi WHERE tipe IN ('masuk','transfer_in') AND tanggal <= ?), 0)
             - COALESCE((SELECT SUM(nominal) FROM kas_mutasi WHERE tipe IN ('keluar','transfer_out') AND tanggal <= ?), 0)
             AS total
      FROM kas_akun ka WHERE ka.aktif = 1`,
      [dateTo, dateTo]);
    const totalKasBank = sumVal(kasR);

    // Piutang outstanding
    const piutangR = await safeQuery(`
      SELECT COALESCE(SUM(total - terbayar), 0) AS total
      FROM piutang WHERE status = 'belum_lunas'`);
    const totalPiutang = sumVal(piutangR);

    // Persediaan
    const persediaanR = await safeQuery(`
      SELECT COALESCE(SUM(s.qty * p.harga_modal), 0) AS total
      FROM pos_stok s
      JOIN pos_produk p ON p.id = s.produk_id
      WHERE p.aktif = 1 AND s.qty > 0`);
    const totalPersediaan = sumVal(persediaanR);

    // Growth % calculation
    function growth(cur, prv) {
      if (prv === 0) return cur > 0 ? 100 : 0;
      return Math.round((cur - prv) / Math.abs(prv) * 1000) / 10;
    }

    res.json({
      success: true,
      bulan,
      periode: { dari: dateFrom, sampai: dateTo },
      bulan_sebelumnya: { dari: prevFrom, sampai: prevTo },
      ringkasan: {
        pendapatan:        { nilai: current.pendapatan.total,  prev: prev.pendapatan.total,  growth: growth(current.pendapatan.total, prev.pendapatan.total) },
        hpp:               { nilai: current.hpp,               prev: prev.hpp,               growth: growth(current.hpp, prev.hpp) },
        beban_operasional: { nilai: current.beban_operasional, prev: prev.beban_operasional, growth: growth(current.beban_operasional, prev.beban_operasional) },
        laba_bersih:       { nilai: current.laba_bersih,       prev: prev.laba_bersih,       growth: growth(current.laba_bersih, prev.laba_bersih) },
        kas_bank:          totalKasBank,
        piutang:           totalPiutang,
        persediaan:        totalPersediaan
      },
      detail_pendapatan: current.pendapatan,
      perbandingan: {
        pendapatan_prev: prev.pendapatan,
        hpp_prev: prev.hpp,
        beban_prev: prev.beban_operasional,
        laba_bersih_prev: prev.laba_bersih
      }
    });
  } catch (e) {
    console.error('ringkasan error:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
