const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { getCabangAkses } = require('../middleware/cabangFilter');

router.get('/kategori', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM pengeluaran_kategori ORDER BY divisi, nama');
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.get('/', auth(), async (req, res) => {
  try {
    const akses = await getCabangAkses(req.user);
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.divisi)    { where += ' AND pk.divisi=?'; params.push(req.query.divisi); }
    if (req.query.cabang_id) { where += ' AND p.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    if (req.query.bulan)     { where += " AND DATE_FORMAT(p.tanggal,'%Y-%m')=?"; params.push(req.query.bulan); }
    if (akses !== null) {
      if (akses.length === 0) return res.json({ success:true, data:[] });
      where += ` AND p.cabang_id IN (${akses.map(()=>'?').join(',')})`;
      params.push(...akses);
    }
    const [rows] = await db.query(
      `SELECT p.*, c.nama as nama_cabang, pk.nama as nama_kategori, pk.divisi
       FROM pengeluaran p
       LEFT JOIN cabang c ON p.cabang_id = c.id
       LEFT JOIN pengeluaran_kategori pk ON p.kategori_id = pk.id
       ${where} ORDER BY p.tanggal DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(), async (req, res) => {
  try {
    const { cabang_id, kategori_id, tanggal, nominal, keterangan } = req.body;
    if (!cabang_id||!kategori_id||!tanggal||!nominal)
      return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      'INSERT INTO pengeluaran (cabang_id, kategori_id, user_id, tanggal, nominal, keterangan) VALUES (?,?,?,?,?,?)',
      [cabang_id, kategori_id, req.user.id, tanggal, nominal, keterangan||'']
    );
    res.json({ success:true, message:'Pengeluaran berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.patch('/:id/status', auth(['owner','manajer','head_operational','finance']), async (req, res) => {
  try {
    const { status } = req.body;
    await db.query('UPDATE pengeluaran SET status=?, approved_by=? WHERE id=?', [status, req.user.id, req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;

// PATCH /api/pengeluaran/:id - edit pengeluaran (owner & admin_pusat)
router.patch('/:id', auth(), async (req, res) => {
  try {
    const allowed = ['owner','admin_pusat'];
    if (!allowed.includes(req.user?.role)) return res.status(403).json({success:false,message:'Akses ditolak.'});
    const [[old]] = await db.query('SELECT * FROM pengeluaran WHERE id=?', [req.params.id]);
    if (!old) return res.status(404).json({success:false,message:'Data tidak ditemukan.'});
    const {cabang_id,kategori_id,tanggal,nominal,keterangan,status} = req.body;
    await db.query(
      'UPDATE pengeluaran SET cabang_id=?,kategori_id=?,tanggal=?,nominal=?,keterangan=?,status=? WHERE id=?',
      [cabang_id||old.cabang_id, kategori_id||old.kategori_id, tanggal||old.tanggal, nominal||old.nominal, keterangan||old.keterangan, status||old.status, req.params.id]
    );
    // Log perubahan
    const fields = {cabang_id,kategori_id,tanggal,nominal,keterangan,status};
    const changes = Object.entries(fields).filter(([k,v]) => v !== undefined && String(v) !== String(old[k]));
    for (const [field, newVal] of changes) {
      await db.query(
        'INSERT INTO pengeluaran_log (pengeluaran_id,user_id,aksi,field_berubah,nilai_lama,nilai_baru) VALUES (?,?,?,?,?,?)',
        [req.params.id, req.user.id, 'edit', field, old[field], newVal]
      );
    }
    res.json({success:true,message:'Pengeluaran berhasil diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/pengeluaran/:id - hapus pengeluaran (owner only)
router.delete('/:id', auth(), async (req, res) => {
  try {
    if (req.user?.role !== 'owner') return res.status(403).json({success:false,message:'Hanya owner yang bisa menghapus.'});
    const [[old]] = await db.query('SELECT * FROM pengeluaran WHERE id=?', [req.params.id]);
    if (!old) return res.status(404).json({success:false,message:'Data tidak ditemukan.'});
    await db.query(
      'INSERT INTO pengeluaran_log (pengeluaran_id,user_id,aksi,nilai_lama) VALUES (?,?,?,?)',
      [req.params.id, req.user.id, 'hapus', JSON.stringify(old)]
    );
    await db.query('DELETE FROM pengeluaran WHERE id=?', [req.params.id]);
    res.json({success:true,message:'Pengeluaran berhasil dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});
