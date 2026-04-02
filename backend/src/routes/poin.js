const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (['kasir','kasir_sales'].includes(req.user.role)) {
      where += ' AND p.user_id = ?';
      params.push(req.user.id);
    }
    const [rows] = await db.query(
      `SELECT p.*, u.nama_lengkap, pr.nama as nama_produk FROM poin p
       JOIN users u ON p.user_id = u.id
       JOIN produk pr ON p.produk_id = pr.id
       ${where} ORDER BY p.created_at DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
