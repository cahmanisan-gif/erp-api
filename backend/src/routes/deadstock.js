const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { getCabangAkses } = require('../middleware/cabangFilter');

router.get('/', auth(), async (req, res) => {
  try {
    const akses = await getCabangAkses(req.user);
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.cabang_id) { where += ' AND d.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    if (akses !== null) {
      if (akses.length === 0) return res.json({ success:true, data:[] });
      where += ` AND d.cabang_id IN (${akses.map(()=>'?').join(',')})`;
      params.push(...akses);
    }
    const [rows] = await db.query(
      `SELECT d.*, c.nama as nama_cabang, p.nama as nama_produk, p.kategori
       FROM deadstock d
       JOIN cabang c ON d.cabang_id = c.id
       JOIN produk p ON d.produk_id = p.id
       ${where} ORDER BY c.nama, p.nama`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(), async (req, res) => {
  try {
    const { cabang_id, produk_id, tipe, qty, keterangan } = req.body;
    if (!cabang_id||!produk_id||!tipe||!qty) return res.status(400).json({ success:false, message:'Semua field wajib.' });
    const q = parseInt(qty);
    const [exist] = await db.query('SELECT id, qty FROM deadstock WHERE cabang_id=? AND produk_id=?', [cabang_id, produk_id]);
    if (exist.length) {
      let newQty = exist[0].qty;
      if (tipe==='masuk') newQty += q;
      else if (tipe==='keluar') newQty -= q;
      else newQty = q;
      await db.query('UPDATE deadstock SET qty=? WHERE id=?', [newQty, exist[0].id]);
    } else {
      await db.query('INSERT INTO deadstock (cabang_id, produk_id, qty) VALUES (?,?,?)', [cabang_id, produk_id, tipe==='masuk'?q:0]);
    }
    await db.query(
      'INSERT INTO deadstock_log (cabang_id, produk_id, tipe, qty, keterangan, user_id) VALUES (?,?,?,?,?,?)',
      [cabang_id, produk_id, tipe, q, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Stok berhasil diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
