const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().getMonth()+1;
    const tahun = req.query.tahun || new Date().getFullYear();
    const [rows] = await db.query(
      `SELECT t.*, u.nama_lengkap, u.username FROM target_sales t
       JOIN users u ON t.sales_id = u.id
       WHERE t.bulan=? AND t.tahun=? ORDER BY t.pencapaian_nominal DESC`,
      [bulan, tahun]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
