const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.cabang_id) { where += ' AND p.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    const [rows] = await db.query(
      `SELECT p.*, c.nama as nama_cabang FROM pemasukan p
       LEFT JOIN cabang c ON p.cabang_id = c.id
       ${where} ORDER BY p.tanggal DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(['owner','admin_pusat','finance']), async (req, res) => {
  try {
    const { cabang_id, tanggal, nominal, keterangan } = req.body;
    if (!cabang_id||!tanggal||!nominal) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      'INSERT INTO pemasukan (cabang_id, tanggal, nominal, keterangan, user_id) VALUES (?,?,?,?,?)',
      [cabang_id, tanggal, nominal, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Pemasukan berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(['owner','finance']), async (req, res) => {
  try {
    await db.query('DELETE FROM pemasukan WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
