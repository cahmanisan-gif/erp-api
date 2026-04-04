const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/target — list target + pencapaian realtime dari invoice
router.get('/', auth(), async (req, res) => {
  try {
    const bulan = parseInt(req.query.bulan) || (new Date().getMonth()+1);
    const tahun = parseInt(req.query.tahun) || new Date().getFullYear();
    const bulanStr = `${tahun}-${String(bulan).padStart(2,'0')}`;

    // Get all sales users
    const [salesUsers] = await db.query(
      `SELECT id, username, nama_lengkap FROM users WHERE role='sales' AND aktif=1 ORDER BY nama_lengkap`
    );

    // Get existing targets
    const [targets] = await db.query(
      `SELECT * FROM target_sales WHERE bulan=? AND tahun=?`, [bulan, tahun]
    );
    const targetMap = {};
    targets.forEach(t => { targetMap[t.sales_id] = t; });

    // Get realtime pencapaian dari invoice
    const [pencapaian] = await db.query(
      `SELECT sales_id,
              COALESCE(SUM(CASE WHEN status IN ('diterbitkan','lunas') THEN total ELSE 0 END),0) as omzet,
              COALESCE(SUM(CASE WHEN status='lunas' THEN total ELSE 0 END),0) as omzet_lunas,
              COUNT(CASE WHEN status IN ('diterbitkan','lunas') THEN 1 END) as inv_count,
              COUNT(CASE WHEN status='lunas' THEN 1 END) as inv_lunas
       FROM invoice WHERE tanggal LIKE ? GROUP BY sales_id`, [bulanStr+'%']
    );
    const pencMap = {};
    pencapaian.forEach(p => { pencMap[p.sales_id] = p; });

    // Merge: every sales user gets a row
    const data = salesUsers.map(u => {
      const t = targetMap[u.id];
      const p = pencMap[u.id] || { omzet:0, omzet_lunas:0, inv_count:0, inv_lunas:0 };
      const target_nominal = t ? parseFloat(t.target_nominal) : 300000000;
      const target_invoice = t ? parseInt(t.target_invoice) : 0;
      const pencapaian_nominal = parseFloat(p.omzet);
      const pencapaian_lunas = parseFloat(p.omzet_lunas);
      const pct = target_nominal > 0 ? Math.round(pencapaian_nominal / target_nominal * 10000) / 100 : 0;
      return {
        sales_id: u.id,
        nama_lengkap: u.nama_lengkap,
        username: u.username,
        target_nominal,
        target_invoice,
        pencapaian_nominal,
        pencapaian_lunas,
        invoice_count: parseInt(p.inv_count),
        invoice_lunas: parseInt(p.inv_lunas),
        persentase: pct,
        sisa: Math.max(0, target_nominal - pencapaian_nominal),
        has_target: !!t,
      };
    });

    // Summary
    const totalTarget = data.reduce((s,d) => s + d.target_nominal, 0);
    const totalPencapaian = data.reduce((s,d) => s + d.pencapaian_nominal, 0);
    const totalInvoice = data.reduce((s,d) => s + d.invoice_count, 0);
    const achieved = data.filter(d => d.persentase >= 100).length;

    res.json({ success:true, data, summary:{
      total_sales: data.length,
      total_target: totalTarget,
      total_pencapaian: totalPencapaian,
      total_invoice: totalInvoice,
      pct_overall: totalTarget > 0 ? Math.round(totalPencapaian / totalTarget * 10000) / 100 : 0,
      achieved,
      bulan, tahun
    }});
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/target — set/update target for a sales
router.post('/', auth(['owner','manajer','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { sales_id, bulan, tahun, target_nominal, target_invoice } = req.body;
    if (!sales_id || !bulan || !tahun) return res.status(400).json({success:false, message:'sales_id, bulan, tahun wajib.'});

    const nominal = parseFloat(target_nominal) || 300000000;
    const inv = parseInt(target_invoice) || 0;

    // Upsert
    const [[existing]] = await db.query(
      'SELECT id FROM target_sales WHERE sales_id=? AND bulan=? AND tahun=?', [sales_id, bulan, tahun]
    );
    if (existing) {
      await db.query('UPDATE target_sales SET target_nominal=?, target_invoice=? WHERE id=?',
        [nominal, inv, existing.id]);
    } else {
      await db.query('INSERT INTO target_sales (sales_id,bulan,tahun,target_nominal,target_invoice) VALUES (?,?,?,?,?)',
        [sales_id, bulan, tahun, nominal, inv]);
    }
    res.json({success:true, message:'Target berhasil disimpan.'});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// POST /api/target/bulk — set target for all sales at once
router.post('/bulk', auth(['owner','manajer','admin_pusat','head_operational']), async (req, res) => {
  try {
    const { bulan, tahun, target_nominal } = req.body;
    if (!bulan || !tahun || !target_nominal) return res.status(400).json({success:false, message:'bulan, tahun, target_nominal wajib.'});

    const [salesUsers] = await db.query(`SELECT id FROM users WHERE role='sales' AND aktif=1`);
    const nominal = parseFloat(target_nominal);

    for (const u of salesUsers) {
      const [[existing]] = await db.query(
        'SELECT id FROM target_sales WHERE sales_id=? AND bulan=? AND tahun=?', [u.id, bulan, tahun]
      );
      if (existing) {
        await db.query('UPDATE target_sales SET target_nominal=? WHERE id=?', [nominal, existing.id]);
      } else {
        await db.query('INSERT INTO target_sales (sales_id,bulan,tahun,target_nominal) VALUES (?,?,?,?)',
          [u.id, bulan, tahun, nominal]);
      }
    }
    res.json({success:true, message:`Target ${salesUsers.length} sales berhasil di-set.`});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// GET /api/target/sales-users — list sales users for dropdown
router.get('/sales-users', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT id, username, nama_lengkap FROM users WHERE role='sales' AND aktif=1 ORDER BY nama_lengkap`);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

module.exports = router;
