const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/payroll-toko/input?bulan=2026-03 - daftar input poin per karyawan
router.get('/input', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const [rows] = await db.query(
      `SELECT pti.*, c.nama AS nama_cabang
       FROM payroll_toko_input pti
       LEFT JOIN cabang c ON c.id = pti.cabang_id
       WHERE pti.bulan=? ORDER BY c.nama, pti.nama`,
      [bulan]
    );
    res.json({ success:true, data:rows, bulan });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/payroll-toko/input - simpan/update input poin
router.post('/input', auth(), async (req, res) => {
  try {
    const { personnel_id, nama, cabang_id, bulan, poin, ulasan_google, poin_barang_selected, catatan } = req.body;
    if (!personnel_id||!bulan||!cabang_id) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      `INSERT INTO payroll_toko_input (personnel_id,nama,cabang_id,bulan,poin,ulasan_google,poin_barang_selected,catatan,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE poin=VALUES(poin),ulasan_google=VALUES(ulasan_google),
       poin_barang_selected=VALUES(poin_barang_selected),catatan=VALUES(catatan)`,
      [personnel_id, nama, cabang_id, bulan, poin||0, ulasan_google||0, poin_barang_selected||0, catatan||'', req.user.id]
    );
    res.json({ success:true, message:'Input disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/payroll-toko/kalkulasi?bulan=2026-03 - hitung payroll toko
router.get('/kalkulasi', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const GAJI_POKOK     = 2300000;
    const POTONGAN_PCT   = 0.02;
    const BONUS_POIN_700 = 500000;
    const BONUS_POIN_1000= 1000000;
    const BONUS_ULASAN   = 3000;
    const POIN_PER_RUPIAH= 1000;

    // Ambil omzet per cabang bulan ini — prioritas POS, fallback manual
    const [y1,m1] = bulan.split('-').map(Number);
    const dariTgl = bulan+'-01', sampaiTgl = bulan+'-'+new Date(y1,m1,0).getDate();
    const [posOmzetRows] = await db.query(
      `SELECT cabang_id, COALESCE(SUM(total),0) AS total_omzet
       FROM pos_transaksi WHERE status='selesai' AND created_at>=? AND created_at<=?
       GROUP BY cabang_id`,
      [dariTgl+' 00:00:00', sampaiTgl+' 23:59:59']
    );
    const [manualOmzetRows] = await db.query(
      `SELECT cabang_id, SUM(omzet_total) AS total_omzet
       FROM omzet_cabang WHERE DATE_FORMAT(tanggal,'%Y-%m')=?
       GROUP BY cabang_id`, [bulan]
    );
    // Gabung: prioritas POS jika ada, fallback manual
    const omzetMap = {};
    manualOmzetRows.forEach(r => { omzetMap[r.cabang_id] = parseFloat(r.total_omzet||0); });
    posOmzetRows.forEach(r => { if (parseFloat(r.total_omzet) > 0) omzetMap[r.cabang_id] = parseFloat(r.total_omzet); });
    const omzetRows = Object.entries(omzetMap).map(([k,v]) => ({cabang_id:parseInt(k), total_omzet:v}));

    // Ambil target per cabang (static)
    const [targetRows] = await db.query('SELECT cabang_id, target_bulanan FROM target_omzet_cabang');
    const targetMap = {};
    targetRows.forEach(r => { targetMap[r.cabang_id] = parseFloat(r.target_bulanan||0); });

    // Ambil target per-staff (dari staff_target_omzet — yang di-set di Target Staff)
    const [staffTargetRows] = await db.query('SELECT user_id, target_omzet FROM staff_target_omzet WHERE bulan=?', [bulan]);
    const staffTargetMap = {};
    staffTargetRows.forEach(r => { staffTargetMap[r.user_id] = parseFloat(r.target_omzet||0); });

    // Ambil rekap POS per-staff (omzet + poin individual dari data real POS)
    const [staffRekapRows] = await db.query(
      `SELECT r.user_id, u.personnel_id,
              SUM(r.omzet_total) AS omzet_staff, SUM(r.total_poin) AS poin_pos,
              SUM(r.total_komisi) AS komisi_staff, SUM(r.total_trx) AS trx_staff
       FROM staff_rekap_harian r
       LEFT JOIN users u ON u.id=r.user_id
       WHERE r.tanggal BETWEEN ? AND ?
       GROUP BY r.user_id, u.personnel_id`, [dariTgl, sampaiTgl]
    );
    const staffRekapByPid = {};
    staffRekapRows.forEach(r => { if (r.personnel_id) staffRekapByPid[r.personnel_id] = r; });
    // Also map by user_id for target lookup
    const staffRekapByUid = {};
    staffRekapRows.forEach(r => { if (r.user_id) staffRekapByUid[r.user_id] = r; });
    // Map personnel_id -> user_id
    const [pidUidRows] = await db.query('SELECT id, personnel_id FROM users WHERE personnel_id IS NOT NULL AND aktif=1');
    const pidToUid = {};
    pidUidRows.forEach(r => { pidToUid[r.personnel_id] = r.id; });

    // Hitung hari kerja efektif
    const [y2,m2] = bulan.split('-').map(Number);
    const totalHari2 = new Date(y2,m2,0).getDate();
    const hkEfektif = totalHari2 - Math.floor(totalHari2/7) - (totalHari2%7>0?1:0);
    const RATE_LEMBUR_FIX = 75000;
    const POTONGAN_KONTEN = 10; // poin per konten kurang
    const REWARD_KONTEN = [300000, 200000, 100000];

    // Ambil rekap absensi bulan ini dari kerjoo
    // (Gunakan data hari_hadir dari payroll_toko_input)

    // Ambil kasbon aktif semua karyawan toko
    const [kasbonRows] = await db.query(
      "SELECT * FROM kasbon WHERE status='aktif' AND sisa > 0"
    );
    const kasbonMap = {};
    kasbonRows.forEach(k => {
      if (!kasbonMap[k.personnel_id]) kasbonMap[k.personnel_id] = 0;
      const cicilan = Math.min(parseFloat(k.cicilan_per_bulan), parseFloat(k.sisa));
      kasbonMap[k.personnel_id] += cicilan;
    });

    // Ambil jumlah konten approved per karyawan bulan ini
    const [kontenApproved] = await db.query(
      `SELECT personnel_id, COUNT(*) as jumlah FROM konten_upload
       WHERE bulan=? AND status='approved' GROUP BY personnel_id`, [bulan]
    );
    const kontenApprovedMap = {};
    kontenApproved.forEach(k => { kontenApprovedMap[k.personnel_id] = parseInt(k.jumlah); });

    // Ambil pemenang konten terbaik bulan ini
    const [kontenRows] = await db.query('SELECT * FROM konten_terbaik WHERE bulan=?', [bulan]);
    const kontenMap = {};
    kontenRows.forEach(k => { kontenMap[k.personnel_id] = k.reward; });

    // Ambil lembur moment bulan ini
    const [lemburRows] = await db.query(
      "SELECT * FROM payroll_toko_lembur WHERE bulan=? AND jenis='moment'", [bulan]
    );
    const lemburMomentMap = {};
    lemburRows.forEach(l => {
      if (!lemburMomentMap[l.personnel_id]) lemburMomentMap[l.personnel_id] = 0;
      lemburMomentMap[l.personnel_id] += parseFloat(l.total_lembur||0);
    });

    // Ambil input poin bulan ini
    const [inputRows] = await db.query(
      `SELECT pti.*, c.nama AS nama_cabang
       FROM payroll_toko_input pti
       LEFT JOIN cabang c ON c.id = pti.cabang_id
       WHERE pti.bulan=?`, [bulan]
    );

    // Ambil karyawan dari Kerjoo (dari payroll_karyawan sebagai fallback)
    const [karRows] = await db.query(
      `SELECT pk.*, c.nama AS nama_cabang
       FROM payroll_karyawan pk
       LEFT JOIN cabang c ON c.id = (
         SELECT cabang_id FROM payroll_toko_input WHERE personnel_id=pk.personnel_id AND bulan=? LIMIT 1
       )
       WHERE pk.aktif=1`, [bulan]
    );

    // Hitung per karyawan berdasarkan input
    // Ambil SO otomatis dari pengeluaran kategori 25
    const [soRows] = await db.query(
      `SELECT cabang_id, SUM(nominal) AS total_so
       FROM pengeluaran
       WHERE kategori_id=25 AND DATE_FORMAT(tanggal,'%Y-%m')=? AND status='approved'
       GROUP BY cabang_id`,
      [bulan]
    );
    const soMap = {};
    soRows.forEach(r => { soMap[r.cabang_id] = parseFloat(r.total_so||0); });

    // Hitung jumlah karyawan per cabang dari input
    const karPerCabang = {};
    inputRows.forEach(inp => {
      karPerCabang[inp.cabang_id] = (karPerCabang[inp.cabang_id]||0) + 1;
    });

    const hasil = inputRows.map(inp => {
      const omzet  = omzetMap[inp.cabang_id] || 0;
      const target = targetMap[inp.cabang_id] || 0;

      // Poin: sinkron dari POS (staff_rekap_harian) jika ada, fallback ke manual input
      const posRekap = staffRekapByPid[inp.personnel_id];
      const poinFromPOS = posRekap ? parseInt(posRekap.poin_pos||0) : 0;
      const poinFromInput = parseInt(inp.poin || 0);
      const poin   = Math.max(poinFromPOS, poinFromInput); // Ambil yang lebih besar

      // Omzet individual dari POS
      const omzetStaff = posRekap ? parseFloat(posRekap.omzet_staff||0) : 0;
      const komisiStaff = posRekap ? parseFloat(posRekap.komisi_staff||0) : 0;
      const trxStaff = posRekap ? parseInt(posRekap.trx_staff||0) : 0;

      // Target individual: cek staff_target_omzet dulu, fallback ke target cabang
      const userId = pidToUid[inp.personnel_id] || null;
      const targetStaff = userId ? (staffTargetMap[userId] || 0) : 0;

      const ulasan = parseInt(inp.ulasan_google || 0);
      const poinBarang = parseInt(inp.poin_barang_selected || 0);

      // Potongan target
      let potongan_target = 0;
      if (target > 0 && omzet < target) {
        potongan_target = Math.round((target - omzet) * POTONGAN_PCT);
      }

      // Bonus poin (1 poin = Rp1.000)
      const bonus_poin_nominal = poin * POIN_PER_RUPIAH;

      // Bonus extra poin
      let bonus_extra_poin = 0;
      if (poin >= 1000)      bonus_extra_poin = BONUS_POIN_1000;
      else if (poin >= 700)  bonus_extra_poin = BONUS_POIN_700;

      // Bonus ulasan Google
      const bonus_ulasan = ulasan * BONUS_ULASAN;

      // Potongan SO otomatis (dibagi rata jumlah karyawan toko)
      const totalSoCabang  = soMap[inp.cabang_id] || 0;
      const jumlahKarCabang= karPerCabang[inp.cabang_id] || 1;
      const potongan_so_otomatis = totalSoCabang > 0 ? Math.round(totalSoCabang / jumlahKarCabang) : 0;

      // Lembur fix (hadir lebih dari hari kerja efektif)
      const hariHadir   = parseInt(inp.hari_kerja_efektif || hkEfektif); // fallback ke hk efektif
      const hariLembur  = Math.max(0, parseInt(inp.poin||0) > 0 ? 0 : 0); // dihitung dari absensi
      const bonus_lembur_fix = 0; // TODO: connect ke absensi Kerjoo

      // Lembur moment
      const bonus_lembur_moment = lemburMomentMap[inp.personnel_id] || 0;

      // Potongan konten — ambil dari konten approved (otomatis), fallback ke input manual
      const jumlah_konten = kontenApprovedMap[inp.personnel_id] !== undefined
        ? kontenApprovedMap[inp.personnel_id]
        : parseInt(inp.jumlah_konten || 0);
      const konten_wajib  = hkEfektif;
      const konten_kurang = Math.max(0, konten_wajib - jumlah_konten);
      const potongan_konten_poin = konten_kurang * POTONGAN_KONTEN; // dalam poin
      const potongan_konten_nominal = potongan_konten_poin * POIN_PER_RUPIAH;

      // Reward konten terbaik
      const reward_konten = parseFloat(kontenMap[inp.personnel_id] || 0);

      // Poin total setelah potongan konten
      const poin_efektif = Math.max(0, poin - potongan_konten_poin);
      const bonus_poin_nominal_efektif = poin_efektif * POIN_PER_RUPIAH;

      // Bonus extra poin (berdasarkan poin efektif)
      let bonus_extra_poin_efektif = 0;
      if (poin_efektif >= 1000)      bonus_extra_poin_efektif = BONUS_POIN_1000;
      else if (poin_efektif >= 700)  bonus_extra_poin_efektif = BONUS_POIN_700;

      // Kasbon
      const kasbon = kasbonMap[inp.personnel_id] || 0;

      // Gaji bersih
      const gaji_bersih = GAJI_POKOK - potongan_target - potongan_so_otomatis - kasbon + bonus_poin_nominal_efektif + bonus_extra_poin_efektif + bonus_ulasan + parseFloat(bonus_lembur_moment) + parseFloat(reward_konten);

      return {
        personnel_id      : inp.personnel_id,
        nama              : inp.nama,
        cabang_id         : inp.cabang_id,
        nama_cabang       : inp.nama_cabang,
        bulan,
        omzet_cabang      : omzet,
        target_cabang     : target,
        selisih_omzet     : omzet - target,
        // Data individual dari POS
        omzet_staff       : omzetStaff,
        komisi_staff      : komisiStaff,
        trx_staff         : trxStaff,
        target_staff      : targetStaff,
        poin_dari_pos     : poinFromPOS,
        poin_dari_input   : poinFromInput,
        gaji_pokok        : GAJI_POKOK,
        potongan_target,
        poin,
        poin_barang_selected: poinBarang,
        potongan_so_otomatis,
        kasbon,
        total_so_cabang: totalSoCabang,
        jumlah_kar_cabang: jumlahKarCabang,
        jumlah_konten,
        konten_wajib,
        konten_kurang,
        potongan_konten_poin,
        bonus_poin_nominal  : bonus_poin_nominal_efektif,
        bonus_extra_poin    : bonus_extra_poin_efektif,
        bonus_lembur_moment,
        reward_konten,
        ulasan_google     : ulasan,
        bonus_ulasan,
        gaji_bersih,
        catatan           : inp.catatan || ''
      };
    });

    res.json({ success:true, data:hasil, bulan,
      omzet_summary: omzetRows.map(r => ({
        cabang_id: r.cabang_id,
        omzet: parseFloat(r.total_omzet),
        target: targetMap[r.cabang_id]||0
      }))
    });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;

// GET /api/payroll-toko/karyawan?cabang_id=6 - karyawan toko dari Kerjoo
router.get('/karyawan', auth(), async (req, res) => {
  try {
    const cabang_id = req.query.cabang_id;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});

    // Cek mapping grup Kerjoo
    const [grupRows] = await db.query(
      'SELECT kerjoo_group_name FROM cabang_kerjoo_grup WHERE cabang_id=?', [cabang_id]
    );
    const grups = grupRows.map(r => r.kerjoo_group_name);

    // Ambil karyawan dari payroll_karyawan yang punya cabang mapping
    const [karRows] = await db.query(
      `SELECT pk.* FROM payroll_karyawan pk 
       INNER JOIN cabang_kerjoo_grup ckg ON ckg.cabang_id=?
       WHERE pk.grup = ckg.kerjoo_group_name AND pk.aktif=1`,
      [cabang_id]
    );

    res.json({success:true, data:karRows, grups, has_mapping: grups.length > 0});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/payroll-toko/lembur
router.get('/lembur', auth(), async (req, res) => {
  try {
    const { bulan, cabang_id } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (bulan) { where += ' AND bulan=?'; params.push(bulan); }
    if (cabang_id) { where += ' AND cabang_id=?'; params.push(cabang_id); }
    const [rows] = await db.query(
      `SELECT l.*, c.nama AS nama_cabang FROM payroll_toko_lembur l
       LEFT JOIN cabang c ON c.id=l.cabang_id ${where} ORDER BY l.bulan DESC, l.nama`,
      params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/payroll-toko/lembur
router.post('/lembur', auth(), async (req, res) => {
  try {
    const { personnel_id, nama, cabang_id, bulan, jenis, nama_event, tanggal_event, hari_lembur, rate_lembur, keterangan } = req.body;
    if (!personnel_id||!cabang_id||!bulan) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      `INSERT INTO payroll_toko_lembur (personnel_id,nama,cabang_id,bulan,jenis,nama_event,tanggal_event,hari_lembur,rate_lembur,keterangan,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE jenis=VALUES(jenis),nama_event=VALUES(nama_event),tanggal_event=VALUES(tanggal_event),hari_lembur=VALUES(hari_lembur),rate_lembur=VALUES(rate_lembur),keterangan=VALUES(keterangan)`,
      [personnel_id, nama, cabang_id, bulan, jenis||'fix', nama_event||null, tanggal_event||null, hari_lembur||0, rate_lembur||0, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Lembur disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/payroll-toko/konten-terbaik?bulan=2026-03
router.get('/konten-terbaik', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const [rows] = await db.query('SELECT * FROM konten_terbaik WHERE bulan=? ORDER BY peringkat', [bulan]);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/payroll-toko/konten-terbaik
router.post('/konten-terbaik', auth(), async (req, res) => {
  try {
    const { bulan, pemenang } = req.body; // pemenang = [{peringkat,personnel_id,nama,reward}]
    if (!bulan||!pemenang?.length) return res.status(400).json({success:false,message:'Data tidak lengkap.'});
    for (const p of pemenang) {
      await db.query(
        `INSERT INTO konten_terbaik (bulan,peringkat,personnel_id,nama,reward,created_by)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE personnel_id=VALUES(personnel_id),nama=VALUES(nama),reward=VALUES(reward)`,
        [bulan, p.peringkat, p.personnel_id, p.nama, p.reward, req.user.id]
      );
    }
    res.json({success:true, message:'Pemenang konten disimpan.'});
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/payroll-toko/finalize - finalize payroll toko & catat cicilan kasbon
router.post('/finalize', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { bulan, data } = req.body;
    if (!bulan||!data?.length) return res.status(400).json({success:false,message:'Data tidak lengkap.'});

    for (const row of data) {
      if (!row.kasbon || row.kasbon <= 0) continue;
      // Ambil kasbon aktif karyawan ini
      const [kasbonRows] = await db.query(
        "SELECT * FROM kasbon WHERE personnel_id=? AND status='aktif' AND sisa > 0",
        [row.personnel_id]
      );
      for (const k of kasbonRows) {
        const cicilan = Math.min(parseFloat(k.cicilan_per_bulan), parseFloat(k.sisa));
        const sisaBaru = parseFloat(k.sisa) - cicilan;
        // Catat cicilan
        await db.query(
          'INSERT IGNORE INTO kasbon_cicilan (kasbon_id,personnel_id,bulan,nominal) VALUES (?,?,?,?)',
          [k.id, row.personnel_id, bulan, cicilan]
        );
        // Update sisa
        await db.query(
          'UPDATE kasbon SET sisa=?, status=? WHERE id=?',
          [sisaBaru, sisaBaru<=0?'lunas':'aktif', k.id]
        );
      }
    }
    res.json({success:true, message:'Payroll toko difinalize dan cicilan kasbon dicatat.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST sync jumlah konten approved ke payroll_toko_input
router.post('/sync-konten', auth(), async (req, res) => {
  try {
    const { personnel_id, bulan, jumlah_konten } = req.body;
    if (!personnel_id || !bulan) return res.status(400).json({success:false,message:'personnel_id dan bulan wajib.'});
    // Upsert payroll_toko_input
    await db.query(`
      INSERT INTO payroll_toko_input (personnel_id, cabang_id, bulan, jumlah_konten)
      VALUES (?, (SELECT cabang_id FROM users WHERE personnel_id=? LIMIT 1), ?, ?)
      ON DUPLICATE KEY UPDATE jumlah_konten=VALUES(jumlah_konten)
    `, [personnel_id, personnel_id, bulan, jumlah_konten]);
    res.json({success:true, message:'Jumlah konten diupdate.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});
