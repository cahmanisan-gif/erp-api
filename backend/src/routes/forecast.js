const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.cabang_id) { where += ' AND f.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    if (req.query.bulan)     { where += ' AND f.bulan=?'; params.push(req.query.bulan); }
    if (req.user.role === 'kepala_cabang') { where += ' AND f.cabang_id=?'; params.push(req.user.cabang_id); }
    const [rows] = await db.query(
      `SELECT f.*, c.nama as nama_cabang, p.nama as nama_produk
       FROM forecast f
       LEFT JOIN cabang c ON f.cabang_id = c.id
       LEFT JOIN produk p ON f.produk_id = p.id
       ${where} ORDER BY f.tahun DESC, f.bulan DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(), async (req, res) => {
  try {
    const { cabang_id, produk_id, bulan, tahun, qty_forecast } = req.body;
    if (!cabang_id||!produk_id||!bulan||!qty_forecast) return res.status(400).json({ success:false, message:'Semua field wajib diisi.' });
    await db.query(
      'INSERT INTO forecast (cabang_id, produk_id, bulan, tahun, qty_forecast, user_id) VALUES (?,?,?,?,?,?)',
      [cabang_id, produk_id, bulan, tahun||new Date().getFullYear(), qty_forecast, req.user.id]
    );
    res.json({ success:true, message:'Forecast berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.patch('/:id/status', auth(['owner','manajer','admin_pusat']), async (req, res) => {
  try {
    const { status } = req.body;
    const approved_by = status === 'approved' ? req.user.id : null;
    await db.query('UPDATE forecast SET status=?, approved_by=? WHERE id=?', [status, approved_by, req.params.id]);
    res.json({ success:true, message:'Status diperbarui.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
