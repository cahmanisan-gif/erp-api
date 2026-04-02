const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/audit?modul=&aksi=&user_id=&dari=&sampai=&page=&per_page=
router.get('/', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { modul, aksi, user_id, dari, sampai, q } = req.query;
    let where = '1=1';
    const params = [];
    if (modul)   { where += ' AND modul=?';   params.push(modul); }
    if (aksi)    { where += ' AND aksi=?';     params.push(aksi); }
    if (user_id) { where += ' AND user_id=?';  params.push(user_id); }
    if (dari)    { where += ' AND created_at>=?'; params.push(dari+' 00:00:00'); }
    if (sampai)  { where += ' AND created_at<=?'; params.push(sampai+' 23:59:59'); }
    if (q)       { where += ' AND (target_label LIKE ? OR user_nama LIKE ? OR modul LIKE ?)'; params.push('%'+q+'%','%'+q+'%','%'+q+'%'); }

    const limit = parseInt(req.query.per_page) || 50;
    const page  = parseInt(req.query.page) || 1;
    const offset = (page-1) * limit;

    const [[{total}]] = await db.query(`SELECT COUNT(*) as total FROM audit_log WHERE ${where}`, params);
    const [rows] = await db.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

    res.json({success:true, data:rows, total, page, per_page:limit, total_pages:Math.ceil(total/limit)});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/audit/moduls — list modul unik
router.get('/moduls', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT DISTINCT modul FROM audit_log ORDER BY modul');
    res.json({success:true, data:rows.map(r=>r.modul)});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
