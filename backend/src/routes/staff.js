const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── REKAP STAFF (dari staff_rekap_harian) ──

// GET /api/staff/rekap?cabang_id=&dari=&sampai=  — rekap semua staff di cabang
router.get('/rekap', auth(), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    if (!dari || !sampai) return res.status(400).json({success:false,message:'dari & sampai wajib.'});

    let where = 'r.tanggal BETWEEN ? AND ?';
    const params = [dari, sampai];
    if (cabang_id) { where += ' AND r.cabang_id=?'; params.push(cabang_id); }

    const [rows] = await db.query(`
      SELECT r.user_id, u.nama_lengkap, u.role, u.cabang_id as user_cabang_id,
             c.nama as nama_cabang, c.kode as kode_cabang,
             SUM(r.total_trx) as total_trx,
             SUM(r.omzet_cash) as omzet_cash,
             SUM(r.omzet_transfer) as omzet_transfer,
             SUM(r.omzet_qris) as omzet_qris,
             SUM(r.omzet_total) as omzet_total,
             SUM(r.total_komisi) as total_komisi,
             SUM(r.total_poin) as total_poin,
             SUM(r.total_item) as total_item,
             COUNT(DISTINCT r.tanggal) as hari_kerja
      FROM staff_rekap_harian r
      LEFT JOIN users u ON u.id=r.user_id
      LEFT JOIN cabang c ON c.id=r.cabang_id
      WHERE ${where}
      GROUP BY r.user_id, u.nama_lengkap, u.role, u.cabang_id, c.nama, c.kode
      ORDER BY omzet_total DESC`, params);

    // Ambil target bulan ini jika range dalam 1 bulan
    const bulan = dari.slice(0,7);
    const [targets] = await db.query('SELECT user_id, target_omzet, target_poin, target_trx FROM staff_target_omzet WHERE bulan=?', [bulan]);
    const targetMap = {};
    targets.forEach(t => { targetMap[t.user_id] = t; });

    const data = rows.map(r => ({
      ...r,
      omzet_total: parseFloat(r.omzet_total||0),
      omzet_cash: parseFloat(r.omzet_cash||0),
      omzet_transfer: parseFloat(r.omzet_transfer||0),
      omzet_qris: parseFloat(r.omzet_qris||0),
      total_komisi: parseFloat(r.total_komisi||0),
      total_poin: parseInt(r.total_poin||0),
      total_trx: parseInt(r.total_trx||0),
      total_item: parseInt(r.total_item||0),
      hari_kerja: parseInt(r.hari_kerja||0),
      target_omzet: parseFloat(targetMap[r.user_id]?.target_omzet||0),
      target_poin: parseInt(targetMap[r.user_id]?.target_poin||0),
      target_trx: parseInt(targetMap[r.user_id]?.target_trx||0),
      persen_target: targetMap[r.user_id]?.target_omzet > 0
        ? Math.round(parseFloat(r.omzet_total||0) / parseFloat(targetMap[r.user_id].target_omzet) * 100)
        : null,
      persen_poin: targetMap[r.user_id]?.target_poin > 0
        ? Math.round(parseInt(r.total_poin||0) / parseInt(targetMap[r.user_id].target_poin) * 100)
        : null
    }));

    // Grand total
    const grand = {
      total_trx: data.reduce((s,d) => s + d.total_trx, 0),
      omzet_total: data.reduce((s,d) => s + d.omzet_total, 0),
      omzet_cash: data.reduce((s,d) => s + d.omzet_cash, 0),
      omzet_transfer: data.reduce((s,d) => s + d.omzet_transfer, 0),
      omzet_qris: data.reduce((s,d) => s + d.omzet_qris, 0),
      total_komisi: data.reduce((s,d) => s + d.total_komisi, 0),
      total_poin: data.reduce((s,d) => s + d.total_poin, 0),
      total_staff: data.length
    };

    res.json({success:true, data, grand_total: grand});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/staff/rekap/saya?dari=&sampai=  — rekap diri sendiri
router.get('/rekap/saya', auth(), async (req, res) => {
  try {
    const { dari, sampai } = req.query;
    if (!dari || !sampai) return res.status(400).json({success:false,message:'dari & sampai wajib.'});

    const [[data]] = await db.query(`
      SELECT SUM(total_trx) as total_trx,
             SUM(omzet_cash) as omzet_cash, SUM(omzet_transfer) as omzet_transfer,
             SUM(omzet_qris) as omzet_qris, SUM(omzet_total) as omzet_total,
             SUM(total_komisi) as total_komisi, SUM(total_poin) as total_poin,
             SUM(total_item) as total_item, COUNT(DISTINCT tanggal) as hari_kerja
      FROM staff_rekap_harian WHERE user_id=? AND tanggal BETWEEN ? AND ?`,
      [req.user.id, dari, sampai]);

    // Target bulan
    const bulan = dari.slice(0,7);
    const [[target]] = await db.query('SELECT target_omzet, target_poin, target_trx FROM staff_target_omzet WHERE user_id=? AND bulan=?', [req.user.id, bulan]);

    // Harian detail
    const [harian] = await db.query(`
      SELECT tanggal, total_trx, omzet_total, total_komisi, total_poin
      FROM staff_rekap_harian WHERE user_id=? AND tanggal BETWEEN ? AND ?
      ORDER BY tanggal DESC`, [req.user.id, dari, sampai]);

    res.json({success:true, data:{
      ...data,
      target_omzet: parseFloat(target?.target_omzet||0),
      target_poin: parseInt(target?.target_poin||0),
      target_trx: parseInt(target?.target_trx||0),
      persen_target: target?.target_omzet > 0
        ? Math.round(parseFloat(data?.omzet_total||0) / parseFloat(target.target_omzet) * 100) : null,
      persen_poin: target?.target_poin > 0
        ? Math.round(parseInt(data?.total_poin||0) / parseInt(target.target_poin) * 100) : null,
      harian
    }});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/staff/rekap/cabang/:cabang_id?dari=&sampai=  — rekap staff per cabang (untuk monitoring omzet detail)
router.get('/rekap/cabang/:cabang_id', auth(), async (req, res) => {
  try {
    const { dari, sampai } = req.query;
    if (!dari || !sampai) return res.status(400).json({success:false,message:'dari & sampai wajib.'});

    const [rows] = await db.query(`
      SELECT r.user_id, u.nama_lengkap, u.role,
             SUM(r.total_trx) as total_trx,
             SUM(r.omzet_total) as omzet_total,
             SUM(r.omzet_cash) as omzet_cash,
             SUM(r.omzet_transfer) as omzet_transfer,
             SUM(r.omzet_qris) as omzet_qris,
             SUM(r.total_komisi) as total_komisi,
             SUM(r.total_poin) as total_poin,
             SUM(r.total_item) as total_item
      FROM staff_rekap_harian r
      LEFT JOIN users u ON u.id=r.user_id
      WHERE r.cabang_id=? AND r.tanggal BETWEEN ? AND ?
      GROUP BY r.user_id, u.nama_lengkap, u.role
      ORDER BY omzet_total DESC`,
      [req.params.cabang_id, dari, sampai]);

    res.json({success:true, data: rows.map(r => ({
      ...r,
      omzet_total: parseFloat(r.omzet_total||0),
      total_komisi: parseFloat(r.total_komisi||0),
      total_poin: parseInt(r.total_poin||0),
      total_trx: parseInt(r.total_trx||0)
    }))});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── TARGET OMZET PER STAFF ──

// GET /api/staff/target?bulan=YYYY-MM&cabang_id=
router.get('/target', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    let where = 't.bulan=?';
    const params = [bulan];
    if (req.query.cabang_id) { where += ' AND t.cabang_id=?'; params.push(req.query.cabang_id); }

    const [rows] = await db.query(`
      SELECT t.*, u.nama_lengkap, u.role, c.nama as nama_cabang
      FROM staff_target_omzet t
      LEFT JOIN users u ON u.id=t.user_id
      LEFT JOIN cabang c ON c.id=t.cabang_id
      WHERE ${where} ORDER BY t.target_omzet DESC`, params);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/staff/target — set/update target (bulk, atau staff set target sendiri)
router.post('/target', auth(), async (req, res) => {
  try {
    const { targets } = req.body; // [{user_id, cabang_id, bulan, target_omzet, target_trx, catatan}]
    if (!targets?.length) return res.status(400).json({success:false,message:'targets wajib.'});

    const isManager = ['owner','admin_pusat','head_operational','manajer','manajer_area'].includes(req.user.role);
    let updated = 0;
    for (const t of targets) {
      if (!t.user_id || !t.bulan) continue;
      // Non-manager hanya boleh set target diri sendiri
      if (!isManager && t.user_id !== req.user.id) continue;
      await db.query(`INSERT INTO staff_target_omzet (user_id,cabang_id,bulan,target_omzet,target_poin,target_trx,catatan,created_by)
        VALUES (?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE target_omzet=VALUES(target_omzet), target_poin=VALUES(target_poin), target_trx=VALUES(target_trx),
          cabang_id=VALUES(cabang_id), catatan=VALUES(catatan)`,
        [t.user_id, t.cabang_id||0, t.bulan, t.target_omzet||0, t.target_poin||0, t.target_trx||0, t.catatan||null, req.user.id]);
      updated++;
    }
    res.json({success:true, message:`${updated} target disimpan.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── KPI DASHBOARD ──

// GET /api/staff/kpi?bulan=YYYY-MM&cabang_id=
router.get('/kpi', auth(['owner','manajer','manajer_area','head_operational','admin_pusat','spv_area','finance']), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const [y, m] = bulan.split('-').map(Number);
    const dari = `${bulan}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const sampai = `${bulan}-${String(lastDay).padStart(2,'0')}`;

    // Filter cabang
    const kpiRoles = ['kasir','kasir_sales','vaporista','kepala_cabang'];
    let cabangWhere = `WHERE u.aktif=1 AND u.role IN (${kpiRoles.map(()=>'?').join(',')})`;
    const cabangParams = [...kpiRoles];
    if (req.query.cabang_id) { cabangWhere += ' AND u.cabang_id=?'; cabangParams.push(parseInt(req.query.cabang_id)); }

    // Cabang akses check
    const { getCabangAkses } = require('../middleware/cabangFilter');
    const akses = await getCabangAkses(req.user);
    if (akses !== null) {
      if (akses.length === 0) return res.json({ success:true, data:[], summary:{} });
      cabangWhere += ` AND u.cabang_id IN (${akses.map(()=>'?').join(',')})`;
      cabangParams.push(...akses);
    }

    // All KPI staff
    const [staffList] = await db.query(`
      SELECT u.id, u.nama_lengkap, u.role, u.cabang_id, c.kode as kode_cabang, c.nama as nama_cabang
      FROM users u
      LEFT JOIN cabang c ON c.id=u.cabang_id
      ${cabangWhere}
      ORDER BY c.kode, u.nama_lengkap`, cabangParams);

    if (!staffList.length) return res.json({ success:true, data:[], summary:{} });

    const userIds = staffList.map(s => s.id);
    const ph = userIds.map(()=>'?').join(',');

    // Actual rekap
    const [rekapRows] = await db.query(`
      SELECT user_id,
             SUM(total_trx) as total_trx,
             SUM(omzet_total) as omzet_total,
             SUM(total_poin) as total_poin,
             SUM(total_komisi) as total_komisi,
             COUNT(DISTINCT tanggal) as hari_kerja
      FROM staff_rekap_harian
      WHERE user_id IN (${ph}) AND tanggal BETWEEN ? AND ?
      GROUP BY user_id`, [...userIds, dari, sampai]);

    const rekapMap = {};
    rekapRows.forEach(r => { rekapMap[r.user_id] = r; });

    // Targets
    const [targetRows] = await db.query(`
      SELECT user_id, target_omzet, target_poin, target_trx
      FROM staff_target_omzet
      WHERE user_id IN (${ph}) AND bulan=?`, [...userIds, bulan]);

    const targetMap = {};
    targetRows.forEach(t => { targetMap[t.user_id] = t; });

    // Build data
    const data = staffList.map(s => {
      const r = rekapMap[s.id] || {};
      const t = targetMap[s.id] || {};
      const omzet = parseFloat(r.omzet_total || 0);
      const poin  = parseInt(r.total_poin || 0);
      const tOmzet = parseFloat(t.target_omzet || 0);
      const tPoin  = parseInt(t.target_poin || 0);
      const pctOmzet = tOmzet > 0 ? Math.round(omzet / tOmzet * 100) : null;
      const pctPoin  = tPoin > 0 ? Math.round(poin / tPoin * 100) : null;

      // Skor KPI: rata-rata dari persen omzet & persen poin (jika ada target)
      let skor = null;
      const scores = [];
      if (pctOmzet !== null) scores.push(pctOmzet);
      if (pctPoin !== null) scores.push(pctPoin);
      if (scores.length) skor = Math.round(scores.reduce((a,b)=>a+b,0) / scores.length);

      return {
        user_id: s.id,
        nama: s.nama_lengkap,
        role: s.role,
        cabang_id: s.cabang_id,
        kode_cabang: s.kode_cabang,
        nama_cabang: s.nama_cabang,
        omzet: omzet,
        poin: poin,
        trx: parseInt(r.total_trx || 0),
        komisi: parseFloat(r.total_komisi || 0),
        hari_kerja: parseInt(r.hari_kerja || 0),
        target_omzet: tOmzet,
        target_poin: tPoin,
        pct_omzet: pctOmzet,
        pct_poin: pctPoin,
        skor: skor
      };
    });

    // Sort by skor (highest first), null skor at bottom
    data.sort((a, b) => {
      if (a.skor === null && b.skor === null) return b.omzet - a.omzet;
      if (a.skor === null) return 1;
      if (b.skor === null) return -1;
      return b.skor - a.skor;
    });

    // Grade distribution
    let grade_a = 0, grade_b = 0, grade_c = 0, grade_d = 0, no_target = 0;
    data.forEach(d => {
      if (d.skor === null) { no_target++; return; }
      if (d.skor >= 100) grade_a++;
      else if (d.skor >= 80) grade_b++;
      else if (d.skor >= 60) grade_c++;
      else grade_d++;
    });

    const summary = {
      total_staff: data.length,
      total_omzet: data.reduce((s,d) => s+d.omzet, 0),
      total_poin: data.reduce((s,d) => s+d.poin, 0),
      grade_a, grade_b, grade_c, grade_d, no_target
    };

    res.json({ success:true, data, summary, bulan });
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/staff/target/:id
router.delete('/target/:id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    await db.query('DELETE FROM staff_target_omzet WHERE id=?', [req.params.id]);
    res.json({success:true, message:'Target dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
