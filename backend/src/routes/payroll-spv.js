const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/payroll-spv/mapping - daftar SPV dan toko yang dihandle
router.get('/mapping', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT sc.id, sc.personnel_id, sc.nama, sc.cabang_id, c.nama AS nama_cabang, c.kode
       FROM spv_cabang sc
       LEFT JOIN cabang c ON c.id = sc.cabang_id
       ORDER BY sc.nama, c.nama`
    );
    // Group by SPV
    const spvMap = {};
    rows.forEach(r => {
      if (!spvMap[r.personnel_id]) spvMap[r.personnel_id] = { personnel_id:r.personnel_id, nama:r.nama, cabang:[] };
      spvMap[r.personnel_id].cabang.push({ id:r.cabang_id, nama:r.nama_cabang, kode:r.kode });
    });
    res.json({ success:true, data:Object.values(spvMap) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/payroll-spv/mapping - set mapping SPV ke toko
router.post('/mapping', auth(['owner']), async (req, res) => {
  try {
    const { personnel_id, nama, cabang_ids } = req.body;
    if (!personnel_id || !cabang_ids?.length) return res.status(400).json({success:false,message:'Data tidak lengkap.'});
    // Hapus mapping lama
    await db.query('DELETE FROM spv_cabang WHERE personnel_id=?', [personnel_id]);
    // Insert mapping baru
    for (const cid of cabang_ids) {
      await db.query('INSERT INTO spv_cabang (personnel_id,nama,cabang_id) VALUES (?,?,?)', [personnel_id, nama, cid]);
    }
    res.json({ success:true, message:'Mapping SPV disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/payroll-spv/kalkulasi?bulan=2026-03
router.get('/kalkulasi', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const GAJI_POKOK    = 2500000;
    const UANG_BENSIN   = 500000;
    const PCT_OMZET     = 0.005; // 0.5%
    const BONUS_POIN    = 200000; // per vaporista >= 1000 poin
    const BONUS_ULASAN  = 200000; // per 100 ulasan per toko

    // Ambil semua SPV dan toko mereka
    const [spvRows] = await db.query(
      `SELECT sc.personnel_id, sc.nama, sc.cabang_id, c.nama AS nama_cabang
       FROM spv_cabang sc JOIN cabang c ON c.id=sc.cabang_id`
    );

    // Ambil omzet per cabang bulan ini
    const [omzetRows] = await db.query(
      `SELECT cabang_id, SUM(omzet_total) AS total_omzet
       FROM omzet_cabang WHERE DATE_FORMAT(tanggal,'%Y-%m')=?
       GROUP BY cabang_id`, [bulan]
    );
    const omzetMap = {};
    omzetRows.forEach(r => { omzetMap[r.cabang_id] = parseFloat(r.total_omzet||0); });

    // Ambil input poin vaporista bulan ini
    const [inputRows] = await db.query(
      `SELECT cabang_id, poin, ulasan_google FROM payroll_toko_input WHERE bulan=?`, [bulan]
    );
    // Group by cabang
    const tokoInputMap = {};
    inputRows.forEach(r => {
      if (!tokoInputMap[r.cabang_id]) tokoInputMap[r.cabang_id] = { poin_list:[], ulasan_total:0 };
      tokoInputMap[r.cabang_id].poin_list.push(parseInt(r.poin||0));
      tokoInputMap[r.cabang_id].ulasan_total += parseInt(r.ulasan_google||0);
    });

    // Ambil lembur SPV bulan ini
    const [lemburRows] = await db.query(
      `SELECT personnel_id, SUM(total_lembur) AS total FROM payroll_toko_lembur
       WHERE bulan=? GROUP BY personnel_id`, [bulan]
    );
    const lemburMap = {};
    lemburRows.forEach(r => { lemburMap[r.personnel_id] = parseFloat(r.total||0); });

    // Group SPV
    const spvMap = {};
    spvRows.forEach(r => {
      if (!spvMap[r.personnel_id]) spvMap[r.personnel_id] = { personnel_id:r.personnel_id, nama:r.nama, cabang:[] };
      spvMap[r.personnel_id].cabang.push({ cabang_id:r.cabang_id, nama_cabang:r.nama_cabang });
    });

    const hasil = Object.values(spvMap).map(spv => {
      let bonus_omzet = 0, bonus_poin = 0, bonus_ulasan = 0;
      const detail = [];

      spv.cabang.forEach(c => {
        const omzet  = omzetMap[c.cabang_id] || 0;
        const input  = tokoInputMap[c.cabang_id] || { poin_list:[], ulasan_total:0 };

        // Bonus omzet 0.5%
        const bo = Math.round(omzet * PCT_OMZET);
        bonus_omzet += bo;

        // Bonus poin: per vaporista >= 1000 poin
        const vaporista1000 = input.poin_list.filter(p => p >= 1000).length;
        const bp = vaporista1000 * BONUS_POIN;
        bonus_poin += bp;

        // Bonus ulasan: per 100 ulasan per toko
        const ulasanBlok = Math.floor(input.ulasan_total / 100);
        const bu = ulasanBlok * BONUS_ULASAN;
        bonus_ulasan += bu;

        detail.push({
          cabang_id: c.cabang_id, nama_cabang: c.nama_cabang,
          omzet, bonus_omzet: bo,
          vaporista_1000: vaporista1000, bonus_poin: bp,
          ulasan_total: input.ulasan_total, bonus_ulasan: bu
        });
      });

      const lembur = lemburMap[spv.personnel_id] || 0;
      const total_gaji = GAJI_POKOK + UANG_BENSIN + bonus_omzet + bonus_poin + bonus_ulasan + lembur;

      return {
        personnel_id: spv.personnel_id,
        nama: spv.nama,
        bulan,
        gaji_pokok: GAJI_POKOK,
        uang_bensin: UANG_BENSIN,
        bonus_omzet,
        bonus_poin_vaporista: bonus_poin,
        bonus_ulasan,
        lembur,
        total_gaji,
        detail
      };
    });

    res.json({ success:true, data:hasil, bulan });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
