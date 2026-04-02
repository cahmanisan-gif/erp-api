const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.status) { where += ' AND r.status=?'; params.push(req.query.status); }
    if (req.query.bulan)  { where += " AND DATE_FORMAT(r.created_at,'%Y-%m')=?"; params.push(req.query.bulan); }
    if (req.query.cabang_id) { where += ' AND r.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    else if (req.user.role === 'kepala_cabang') { where += ' AND r.cabang_id=?'; params.push(req.user.cabang_id); }
    if (['vaporista','kasir','kasir_sales'].includes(req.user.role)) { where += ' AND r.user_id=?'; params.push(req.user.id); }
    const lmt = req.query.limit ? parseInt(req.query.limit) : 200;
    const [rows] = await db.query(
      `SELECT r.*, c.nama as nama_cabang, u.nama_lengkap as nama_karyawan FROM request_barang r
      LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN cabang c ON r.cabang_id = c.id
       ${where} ORDER BY r.created_at DESC LIMIT ?`, [...params, lmt]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(), async (req, res) => {
  try {
    const { nama_barang, jenis, qty, cabang_id } = req.body;
    if (!nama_barang||!qty) return res.status(400).json({ success:false, message:'Nama barang dan qty wajib.' });
    const id = 'REQ-' + Date.now();

    // Auto-detect cabang dari personnel_id jika belum ada
    let finalCabangId = cabang_id || req.user.cabang_id || null;
    if (!finalCabangId && req.user.personnel_id) {
      try {
        const [[karGrup]] = await db.query('SELECT grup FROM payroll_karyawan WHERE personnel_id=?', [req.user.personnel_id]);
        if (karGrup) {
          const [[cabMapping]] = await db.query('SELECT cabang_id FROM cabang_kerjoo_grup WHERE kerjoo_group_name=?', [karGrup.grup]);
          if (cabMapping) finalCabangId = cabMapping.cabang_id;
        }
      } catch(e2) { console.error('cabang lookup error:', e2.message); }
    }

    await db.query(
      'INSERT INTO request_barang (id, user_id, cabang_id, nama_barang, jenis, qty) VALUES (?,?,?,?,?,?)',
      [id, req.user.id, finalCabangId, nama_barang, jenis||'', parseInt(qty)]
    );
    res.json({ success:true, message:'Request berhasil dikirim.', id });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.patch('/:id', auth(['owner','admin_pusat','manajer','head_operational','spv_area']), async (req, res) => {
  try {
    const { status, catatan } = req.body;
    // Status "Sedang dikirim ke tokomu" boleh diset oleh siapa saja yang bisa transfer barang
    const ALLOWED_STATUS = ['Disetujui','Ditolak','Sudah di Gudang','Dikirim','Sedang dikirim ke tokomu'];
    if (status && !ALLOWED_STATUS.includes(status))
      return res.status(400).json({ success:false, message:'Status tidak valid.' });
    await db.query(
      'UPDATE request_barang SET status=?, catatan=?, approved_by=? WHERE id=?',
      [status, catatan||'', req.user.id, req.params.id]
    );
    res.json({ success:true, message:'Status diperbarui.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;

// GET /api/request/agregasi - aggregasi request per nama barang
router.get('/agregasi', auth(), async (req, res) => {
  try {
    const { status, jenis, include_done } = req.query;
    let where = "WHERE 1=1";
    const params = [];
    if (status) { where += ' AND r.status=?'; params.push(status); }
    else if (!include_done) { where += " AND r.status NOT IN ('Ditolak','Dikirim')"; }
    if (jenis)  { where += ' AND r.jenis=?';  params.push(jenis); }

    const [rows] = await db.query(`
      SELECT 
        r.nama_barang,
        r.jenis,
        SUM(r.qty) AS total_qty,
        COUNT(DISTINCT r.cabang_id) AS jumlah_toko,
        GROUP_CONCAT(
          CONCAT(COALESCE(c.nama,'Pusat'), ':', r.qty, ':', r.status)
          ORDER BY c.nama SEPARATOR '|'
        ) AS detail_toko,
        MIN(r.created_at) AS pertama_request,
        MAX(r.created_at) AS terakhir_request
      FROM request_barang r
      LEFT JOIN cabang c ON c.id = r.cabang_id
      ${where}
      GROUP BY r.nama_barang, r.jenis
      ORDER BY total_qty DESC, r.nama_barang
    `, params);

    // Parse detail_toko
    const data = rows.map(r => ({
      ...r,
      detail: (r.detail_toko||'').split('|').map(d => {
        const [toko, qty, status] = d.split(':');
        return { toko, qty: parseInt(qty), status };
      })
    }));

    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH /api/request/:id - edit request (hanya jika pending & milik sendiri)
router.patch('/:id', auth(), async (req, res) => {
  try {
    const [[r]] = await db.query('SELECT * FROM request_barang WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({success:false,message:'Request tidak ditemukan.'});
    if (r.status !== 'Sedang Dicarikan') return res.status(400).json({success:false,message:'Request sudah diproses, tidak bisa diedit.'});
    if (req.user.role !== 'owner' && r.user_id !== req.user.id) return res.status(403).json({success:false,message:'Bukan request Anda.'});
    const { nama_barang, jenis, qty, catatan } = req.body;
    await db.query(
      'UPDATE request_barang SET nama_barang=?,jenis=?,qty=?,catatan=? WHERE id=?',
      [nama_barang||r.nama_barang, jenis||r.jenis, qty||r.qty, catatan||r.catatan, req.params.id]
    );
    res.json({success:true,message:'Request diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/request/:id
router.delete('/:id', auth(), async (req, res) => {
  try {
    const [[r]] = await db.query('SELECT * FROM request_barang WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({success:false,message:'Request tidak ditemukan.'});
    // Owner bisa hapus semua, vaporista hanya milik sendiri & pending
    if (req.user.role !== 'owner') {
      if (r.user_id !== req.user.id) return res.status(403).json({success:false,message:'Bukan request Anda.'});
      if (r.status !== 'Sedang Dicarikan') return res.status(400).json({success:false,message:'Request sudah diproses.'});
    }
    await db.query('DELETE FROM request_barang WHERE id=?', [req.params.id]);
    res.json({success:true,message:'Request dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/request/bulk-update - update status banyak request sekaligus
router.post('/bulk-update', auth(['owner','admin_pusat','manajer']), async (req, res) => {
  try {
    const { nama_barang, jenis, status, catatan } = req.body;
    if (!nama_barang || !status) return res.status(400).json({success:false,message:'Data tidak lengkap.'});
    const [result] = await db.query(
      `UPDATE request_barang SET status=?, approved_by=?, catatan=COALESCE(NULLIF(?,''),catatan)
       WHERE nama_barang=? AND jenis=? AND status='Sedang Dicarikan'`,
      [status, req.user.id, catatan||'', nama_barang, jenis||'']
    );
    res.json({success:true, message:`${result.affectedRows} request diupdate ke "${status}".`, affected:result.affectedRows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});
