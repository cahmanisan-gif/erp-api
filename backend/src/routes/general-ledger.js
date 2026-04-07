const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

// ══════════════════════════════════════════════════════════════════════
// 1. GET /api/general-ledger/coa
//    List all accounts, ordered by kode, with calculated saldo
// ══════════════════════════════════════════════════════════════════════
router.get('/coa', auth(), async (req, res) => {
  try {
    const [accounts] = await db.query(`
      SELECT a.id, a.kode, a.nama, a.tipe, a.saldo_normal, a.parent_id, a.level, a.aktif,
             COALESCE(SUM(jd.debet), 0) as total_debet,
             COALESCE(SUM(jd.kredit), 0) as total_kredit
      FROM akun_coa a
      LEFT JOIN jurnal_detail jd ON jd.akun_id = a.id
      GROUP BY a.id, a.kode, a.nama, a.tipe, a.saldo_normal, a.parent_id, a.level, a.aktif
      ORDER BY a.kode`);

    const data = accounts.map(a => {
      const debet  = parseInt(a.total_debet);
      const kredit = parseInt(a.total_kredit);
      // Saldo depends on saldo_normal: debet accounts = debet - kredit, kredit accounts = kredit - debet
      const saldo = a.saldo_normal === 'debet' ? debet - kredit : kredit - debet;
      return {
        id: a.id,
        kode: a.kode,
        nama: a.nama,
        tipe: a.tipe,
        saldo_normal: a.saldo_normal,
        parent_id: a.parent_id,
        level: a.level,
        aktif: a.aktif,
        total_debet: debet,
        total_kredit: kredit,
        saldo
      };
    });

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 2. POST /api/general-ledger/coa
//    Create new account
// ══════════════════════════════════════════════════════════════════════
router.post('/coa', auth(['owner', 'manajer', 'admin_pusat']), async (req, res) => {
  try {
    const { kode, nama, tipe, saldo_normal, parent_id } = req.body;
    if (!kode || !nama || !tipe || !saldo_normal) {
      return res.status(400).json({ success: false, message: 'Kode, nama, tipe, dan saldo_normal wajib diisi.' });
    }

    const validTipe = ['aset', 'kewajiban', 'ekuitas', 'pendapatan', 'beban'];
    if (!validTipe.includes(tipe)) {
      return res.status(400).json({ success: false, message: 'Tipe harus salah satu: ' + validTipe.join(', ') });
    }
    if (!['debet', 'kredit'].includes(saldo_normal)) {
      return res.status(400).json({ success: false, message: 'Saldo normal harus debet atau kredit.' });
    }

    // Determine level from parent
    let level = 1;
    if (parent_id) {
      const [[parent]] = await db.query('SELECT level FROM akun_coa WHERE id=?', [parent_id]);
      if (!parent) return res.status(400).json({ success: false, message: 'Parent account tidak ditemukan.' });
      level = parent.level + 1;
    }

    const [result] = await db.query(
      'INSERT INTO akun_coa (kode, nama, tipe, saldo_normal, parent_id, level) VALUES (?,?,?,?,?,?)',
      [kode, nama, tipe, saldo_normal, parent_id || null, level]
    );

    await audit(req, 'create', 'coa', result.insertId, `${kode} - ${nama}`, { kode, nama, tipe, saldo_normal });

    res.json({ success: true, message: 'Akun berhasil ditambahkan.', id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Kode akun sudah ada.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// 3. GET /api/general-ledger/jurnal?bulan=2026-04&modul=pos&cabang_id=6
//    List journal entries with details
// ══════════════════════════════════════════════════════════════════════
router.get('/jurnal', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];

    if (req.query.bulan) {
      where += ' AND DATE_FORMAT(ju.tanggal, "%Y-%m") = ?';
      params.push(req.query.bulan);
    }
    if (req.query.modul) {
      where += ' AND ju.modul = ?';
      params.push(req.query.modul);
    }
    if (req.query.cabang_id) {
      where += ' AND ju.cabang_id = ?';
      params.push(parseInt(req.query.cabang_id));
    }

    const [jurnals] = await db.query(`
      SELECT ju.id, ju.tanggal, ju.nomor_bukti, ju.keterangan, ju.modul, ju.ref_id,
             ju.cabang_id, ju.user_id, ju.created_at,
             u.nama_lengkap as nama_user,
             cb.nama as nama_cabang
      FROM jurnal_umum ju
      LEFT JOIN users u ON u.id = ju.user_id
      LEFT JOIN cabang cb ON cb.id = ju.cabang_id
      ${where}
      ORDER BY ju.tanggal DESC, ju.id DESC`, params);

    if (!jurnals.length) {
      return res.json({ success: true, data: [] });
    }

    // Fetch all details for these jurnals in one query
    const jurnalIds = jurnals.map(j => j.id);
    const [details] = await db.query(`
      SELECT jd.id, jd.jurnal_id, jd.akun_id, jd.debet, jd.kredit, jd.keterangan,
             ac.kode as akun_kode, ac.nama as akun_nama
      FROM jurnal_detail jd
      JOIN akun_coa ac ON ac.id = jd.akun_id
      WHERE jd.jurnal_id IN (?)
      ORDER BY jd.id`, [jurnalIds]);

    // Group details by jurnal_id
    const detailMap = {};
    for (const d of details) {
      if (!detailMap[d.jurnal_id]) detailMap[d.jurnal_id] = [];
      detailMap[d.jurnal_id].push({
        id: d.id,
        akun_id: d.akun_id,
        akun_kode: d.akun_kode,
        akun_nama: d.akun_nama,
        debet: parseInt(d.debet),
        kredit: parseInt(d.kredit),
        keterangan: d.keterangan
      });
    }

    const data = jurnals.map(j => ({
      ...j,
      details: detailMap[j.id] || [],
      total_debet: (detailMap[j.id] || []).reduce((s, d) => s + d.debet, 0),
      total_kredit: (detailMap[j.id] || []).reduce((s, d) => s + d.kredit, 0)
    }));

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 4. POST /api/general-ledger/jurnal
//    Create journal entry (double-entry, must balance)
// ══════════════════════════════════════════════════════════════════════
router.post('/jurnal', auth(['owner', 'manajer', 'admin_pusat']), async (req, res) => {
  try {
    const { tanggal, keterangan, modul, ref_id, cabang_id, details } = req.body;

    if (!tanggal || !details || !Array.isArray(details) || details.length < 2) {
      return res.status(400).json({ success: false, message: 'Tanggal dan minimal 2 baris jurnal detail wajib diisi.' });
    }

    // Validate balance
    let totalDebet = 0, totalKredit = 0;
    for (const d of details) {
      if (!d.akun_id) return res.status(400).json({ success: false, message: 'Setiap baris harus memiliki akun_id.' });
      totalDebet  += parseInt(d.debet) || 0;
      totalKredit += parseInt(d.kredit) || 0;
    }
    if (totalDebet !== totalKredit) {
      return res.status(400).json({
        success: false,
        message: `Jurnal tidak balance. Debet: ${totalDebet.toLocaleString('id-ID')}, Kredit: ${totalKredit.toLocaleString('id-ID')}`
      });
    }
    if (totalDebet === 0) {
      return res.status(400).json({ success: false, message: 'Total debet dan kredit tidak boleh nol.' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Auto-generate nomor_bukti: JU-YYYYMM-XXXX
      const bulan = tanggal.slice(0, 7).replace('-', '');
      const [[lastNum]] = await conn.query(
        `SELECT nomor_bukti FROM jurnal_umum
         WHERE nomor_bukti LIKE ? ORDER BY id DESC LIMIT 1`,
        [`JU-${bulan}-%`]);
      let seq = 1;
      if (lastNum) {
        const parts = lastNum.nomor_bukti.split('-');
        seq = parseInt(parts[2]) + 1;
      }
      const nomorBukti = `JU-${bulan}-${String(seq).padStart(4, '0')}`;

      // Insert header
      const [result] = await conn.query(
        `INSERT INTO jurnal_umum (tanggal, nomor_bukti, keterangan, modul, ref_id, cabang_id, user_id)
         VALUES (?,?,?,?,?,?,?)`,
        [tanggal, nomorBukti, keterangan || '', modul || null, ref_id || null, cabang_id || null, req.user.id]
      );
      const jurnalId = result.insertId;

      // Insert detail lines
      for (const d of details) {
        await conn.query(
          'INSERT INTO jurnal_detail (jurnal_id, akun_id, debet, kredit, keterangan) VALUES (?,?,?,?,?)',
          [jurnalId, d.akun_id, parseInt(d.debet) || 0, parseInt(d.kredit) || 0, d.keterangan || null]
        );
      }

      await conn.commit();

      await audit(req, 'create', 'jurnal', jurnalId, nomorBukti, {
        tanggal, modul, cabang_id, total_debet: totalDebet, lines: details.length
      });

      res.json({ success: true, message: 'Jurnal berhasil dibuat.', id: jurnalId, nomor_bukti: nomorBukti });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 5. GET /api/general-ledger/buku-besar?akun_id=1&dari=2026-04-01&sampai=2026-04-30
//    Ledger for specific account with running balance
// ══════════════════════════════════════════════════════════════════════
router.get('/buku-besar', auth(), async (req, res) => {
  try {
    const { akun_id, dari, sampai } = req.query;
    if (!akun_id) return res.status(400).json({ success: false, message: 'akun_id wajib diisi.' });

    // Get account info
    const [[akun]] = await db.query('SELECT * FROM akun_coa WHERE id=?', [parseInt(akun_id)]);
    if (!akun) return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });

    // Calculate opening balance (before dari)
    let saldoAwal = 0;
    if (dari) {
      const [[opening]] = await db.query(`
        SELECT COALESCE(SUM(jd.debet), 0) as total_debet,
               COALESCE(SUM(jd.kredit), 0) as total_kredit
        FROM jurnal_detail jd
        JOIN jurnal_umum ju ON ju.id = jd.jurnal_id
        WHERE jd.akun_id = ? AND ju.tanggal < ?`, [parseInt(akun_id), dari]);
      saldoAwal = akun.saldo_normal === 'debet'
        ? parseInt(opening.total_debet) - parseInt(opening.total_kredit)
        : parseInt(opening.total_kredit) - parseInt(opening.total_debet);
    }

    // Fetch entries in date range
    let where = 'WHERE jd.akun_id = ?';
    const params = [parseInt(akun_id)];
    if (dari) { where += ' AND ju.tanggal >= ?'; params.push(dari); }
    if (sampai) { where += ' AND ju.tanggal <= ?'; params.push(sampai); }

    const [rows] = await db.query(`
      SELECT ju.id as jurnal_id, ju.tanggal, ju.nomor_bukti, ju.keterangan as jurnal_keterangan,
             ju.modul, ju.ref_id,
             jd.id as detail_id, jd.debet, jd.kredit, jd.keterangan
      FROM jurnal_detail jd
      JOIN jurnal_umum ju ON ju.id = jd.jurnal_id
      ${where}
      ORDER BY ju.tanggal ASC, ju.id ASC, jd.id ASC`, params);

    // Build running balance
    let saldoBerjalan = saldoAwal;
    const entries = rows.map(r => {
      const debet  = parseInt(r.debet);
      const kredit = parseInt(r.kredit);
      if (akun.saldo_normal === 'debet') {
        saldoBerjalan += debet - kredit;
      } else {
        saldoBerjalan += kredit - debet;
      }
      return {
        jurnal_id: r.jurnal_id,
        tanggal: r.tanggal,
        nomor_bukti: r.nomor_bukti,
        keterangan: r.keterangan || r.jurnal_keterangan,
        modul: r.modul,
        ref_id: r.ref_id,
        debet,
        kredit,
        saldo: saldoBerjalan
      };
    });

    res.json({
      success: true,
      data: {
        akun: { id: akun.id, kode: akun.kode, nama: akun.nama, tipe: akun.tipe, saldo_normal: akun.saldo_normal },
        dari: dari || null,
        sampai: sampai || null,
        saldo_awal: saldoAwal,
        entries,
        saldo_akhir: saldoBerjalan
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 6. GET /api/general-ledger/neraca?tanggal=2026-04-07
//    Balance sheet: Aset = Kewajiban + Ekuitas
// ══════════════════════════════════════════════════════════════════════
router.get('/neraca', auth(), async (req, res) => {
  try {
    const tanggal = req.query.tanggal || new Date().toISOString().slice(0, 10);

    // Sum all journal entries up to tanggal, grouped by account
    const [rows] = await db.query(`
      SELECT ac.id, ac.kode, ac.nama, ac.tipe, ac.saldo_normal, ac.parent_id, ac.level,
             COALESCE(SUM(jd.debet), 0) as total_debet,
             COALESCE(SUM(jd.kredit), 0) as total_kredit
      FROM akun_coa ac
      LEFT JOIN jurnal_detail jd ON jd.akun_id = ac.id
      LEFT JOIN jurnal_umum ju ON ju.id = jd.jurnal_id AND ju.tanggal <= ?
      WHERE ac.aktif = 1
      GROUP BY ac.id, ac.kode, ac.nama, ac.tipe, ac.saldo_normal, ac.parent_id, ac.level
      ORDER BY ac.kode`, [tanggal]);

    const grouped = { aset: [], kewajiban: [], ekuitas: [] };
    const totals  = { aset: 0, kewajiban: 0, ekuitas: 0 };

    for (const r of rows) {
      if (!['aset', 'kewajiban', 'ekuitas'].includes(r.tipe)) continue;
      const debet  = parseInt(r.total_debet);
      const kredit = parseInt(r.total_kredit);
      const saldo = r.saldo_normal === 'debet' ? debet - kredit : kredit - debet;

      grouped[r.tipe].push({
        id: r.id, kode: r.kode, nama: r.nama,
        level: r.level, parent_id: r.parent_id,
        total_debet: debet, total_kredit: kredit, saldo
      });
      totals[r.tipe] += saldo;
    }

    // Include laba berjalan (pendapatan - beban up to tanggal) as part of ekuitas
    const [[labaRow]] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN ac.tipe='pendapatan' THEN jd.kredit - jd.debet ELSE 0 END), 0) as pendapatan,
        COALESCE(SUM(CASE WHEN ac.tipe='beban' THEN jd.debet - jd.kredit ELSE 0 END), 0) as beban
      FROM jurnal_detail jd
      JOIN jurnal_umum ju ON ju.id = jd.jurnal_id
      JOIN akun_coa ac ON ac.id = jd.akun_id
      WHERE ju.tanggal <= ? AND ac.tipe IN ('pendapatan','beban')`, [tanggal]);

    const labaBerjalan = parseInt(labaRow.pendapatan) - parseInt(labaRow.beban);
    totals.ekuitas += labaBerjalan;

    const balanced = totals.aset === (totals.kewajiban + totals.ekuitas);

    res.json({
      success: true,
      data: {
        tanggal,
        aset: { accounts: grouped.aset, total: totals.aset },
        kewajiban: { accounts: grouped.kewajiban, total: totals.kewajiban },
        ekuitas: {
          accounts: grouped.ekuitas,
          laba_berjalan: labaBerjalan,
          total: totals.ekuitas
        },
        balanced,
        check: {
          total_aset: totals.aset,
          total_kewajiban_ekuitas: totals.kewajiban + totals.ekuitas
        }
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// 7. GET /api/general-ledger/laba-rugi?dari=2026-04-01&sampai=2026-04-30
//    Income statement: Pendapatan - Beban = Laba/Rugi
// ══════════════════════════════════════════════════════════════════════
router.get('/laba-rugi', auth(), async (req, res) => {
  try {
    const now = new Date();
    const dari   = req.query.dari   || now.toISOString().slice(0, 7) + '-01';
    const sampai = req.query.sampai || now.toISOString().slice(0, 10);

    const [rows] = await db.query(`
      SELECT ac.id, ac.kode, ac.nama, ac.tipe, ac.saldo_normal, ac.level, ac.parent_id,
             COALESCE(SUM(jd.debet), 0) as total_debet,
             COALESCE(SUM(jd.kredit), 0) as total_kredit
      FROM akun_coa ac
      LEFT JOIN jurnal_detail jd ON jd.akun_id = ac.id
      LEFT JOIN jurnal_umum ju ON ju.id = jd.jurnal_id AND ju.tanggal BETWEEN ? AND ?
      WHERE ac.aktif = 1 AND ac.tipe IN ('pendapatan','beban')
      GROUP BY ac.id, ac.kode, ac.nama, ac.tipe, ac.saldo_normal, ac.level, ac.parent_id
      ORDER BY ac.kode`, [dari, sampai]);

    const pendapatanAccounts = [];
    const bebanAccounts = [];
    let totalPendapatan = 0, totalBeban = 0;

    for (const r of rows) {
      const debet  = parseInt(r.total_debet);
      const kredit = parseInt(r.total_kredit);
      // Pendapatan: saldo_normal kredit => kredit - debet
      // Beban: saldo_normal debet => debet - kredit
      const saldo = r.saldo_normal === 'debet' ? debet - kredit : kredit - debet;

      const entry = {
        id: r.id, kode: r.kode, nama: r.nama,
        level: r.level, parent_id: r.parent_id,
        total_debet: debet, total_kredit: kredit, saldo
      };

      if (r.tipe === 'pendapatan') {
        pendapatanAccounts.push(entry);
        totalPendapatan += saldo;
      } else {
        bebanAccounts.push(entry);
        totalBeban += saldo;
      }
    }

    const labaRugi = totalPendapatan - totalBeban;

    res.json({
      success: true,
      data: {
        dari,
        sampai,
        pendapatan: { accounts: pendapatanAccounts, total: totalPendapatan },
        beban: { accounts: bebanAccounts, total: totalBeban },
        laba_rugi: labaRugi,
        status: labaRugi >= 0 ? 'Laba' : 'Rugi'
      }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
