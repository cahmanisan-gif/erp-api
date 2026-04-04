const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { MODULE_DEFS } = require('../middleware/moduleAccess');

// GET /api/module-akses — daftar modul + siapa saja yang punya akses
router.get('/', auth(['owner']), async (req, res) => {
  try {
    // Ambil semua akses
    const [rows] = await db.query(
      `SELECT ma.module_key, ma.user_id, u.nama_lengkap, u.username, u.role, c.nama as nama_cabang
       FROM module_akses ma
       LEFT JOIN users u ON u.id = ma.user_id
       LEFT JOIN cabang c ON c.id = u.cabang_id
       ORDER BY ma.module_key, u.nama_lengkap`
    );

    // Group per modul
    const aksesMap = {};
    rows.forEach(r => {
      if (!aksesMap[r.module_key]) aksesMap[r.module_key] = [];
      aksesMap[r.module_key].push({
        user_id: r.user_id,
        nama: r.nama_lengkap,
        username: r.username,
        role: r.role,
        cabang: r.nama_cabang
      });
    });

    const data = MODULE_DEFS.map(m => ({
      ...m,
      users: aksesMap[m.key] || []
    }));

    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/module-akses/users — daftar user non-owner untuk dropdown
router.get('/users', auth(['owner']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.nama_lengkap, u.role, c.nama as nama_cabang
       FROM users u LEFT JOIN cabang c ON c.id = u.cabang_id
       WHERE u.aktif=1 AND u.role != 'owner'
       ORDER BY FIELD(u.role,'manajer','head_operational','admin_pusat','manajer_area','spv_area','finance','kepala_cabang','sales','kasir','kasir_sales','vaporista'), u.nama_lengkap`
    );
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/module-akses — grant akses
router.post('/', auth(['owner']), async (req, res) => {
  try {
    const { module_key, user_ids } = req.body;
    if (!module_key || !user_ids?.length)
      return res.status(400).json({ success: false, message: 'module_key dan user_ids wajib.' });

    // Validasi module_key
    if (!MODULE_DEFS.find(m => m.key === module_key))
      return res.status(400).json({ success: false, message: 'Modul tidak valid.' });

    let added = 0;
    for (const uid of user_ids) {
      await db.query(
        'INSERT IGNORE INTO module_akses (module_key, user_id, created_by) VALUES (?,?,?)',
        [module_key, uid, req.user.id]
      );
      added++;
    }
    res.json({ success: true, message: `${added} user ditambahkan ke modul.` });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/module-akses — revoke akses
router.delete('/', auth(['owner']), async (req, res) => {
  try {
    const { module_key, user_id } = req.body;
    if (!module_key || !user_id)
      return res.status(400).json({ success: false, message: 'module_key dan user_id wajib.' });

    await db.query('DELETE FROM module_akses WHERE module_key=? AND user_id=?', [module_key, user_id]);
    res.json({ success: true, message: 'Akses dicabut.' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/module-akses/bulk — set semua user untuk satu modul sekaligus (replace)
router.put('/bulk', auth(['owner']), async (req, res) => {
  try {
    const { module_key, user_ids } = req.body;
    if (!module_key)
      return res.status(400).json({ success: false, message: 'module_key wajib.' });
    if (!MODULE_DEFS.find(m => m.key === module_key))
      return res.status(400).json({ success: false, message: 'Modul tidak valid.' });

    // Hapus semua akses modul ini, lalu insert ulang
    await db.query('DELETE FROM module_akses WHERE module_key=?', [module_key]);
    const ids = user_ids || [];
    for (const uid of ids) {
      await db.query(
        'INSERT INTO module_akses (module_key, user_id, created_by) VALUES (?,?,?)',
        [module_key, uid, req.user.id]
      );
    }
    res.json({ success: true, message: `Modul "${module_key}": ${ids.length} user diset.` });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/module-akses/my — modul apa saja yang user login punya akses
router.get('/my', auth(), async (req, res) => {
  try {
    if (req.user.role === 'owner') {
      // Owner punya semua
      return res.json({ success: true, data: MODULE_DEFS.map(m => m.key) });
    }
    const [rows] = await db.query(
      'SELECT module_key FROM module_akses WHERE user_id=?', [req.user.id]
    );
    res.json({ success: true, data: rows.map(r => r.module_key) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
