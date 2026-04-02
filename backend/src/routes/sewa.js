const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const ROLES = ['owner','manajer','head_operational','admin_pusat'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','kwitansi');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'kwt-'+Date.now()+path.extname(file.originalname))
});
const upload = multer({ storage, limits:{ fileSize:10*1024*1024 }});

// GET semua sewa (dengan filter cabang akses)
router.get('/', auth(ROLES), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    // Auto update status
    await db.query(`UPDATE sewa_cabang SET status='selesai' WHERE tgl_selesai < ? AND status != 'selesai'`, [today]);
    await db.query(`UPDATE sewa_cabang SET status='akan_jatuh_tempo' WHERE tgl_selesai BETWEEN ? AND DATE_ADD(?, INTERVAL 30 DAY) AND status = 'aktif'`, [today, today]);

    let cabangFilter = '';
    const params = [];
    if (req.query.cabang_id) { cabangFilter = 'AND s.cabang_id = ?'; params.push(parseInt(req.query.cabang_id)); }
    const [rows] = await db.query(
      `SELECT s.*, c.nama as nama_cabang, c.kode as kode_cabang,
              c.nama_pemilik, c.hp_pemilik,
              DATEDIFF(s.tgl_selesai, CURDATE()) as sisa_hari,
              u.nama_lengkap as nama_creator
       FROM sewa_cabang s
       JOIN cabang c ON s.cabang_id = c.id
       LEFT JOIN users u ON s.created_by = u.id
       WHERE 1=1 ${cabangFilter}
       ORDER BY s.tgl_selesai ASC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET reminder jatuh tempo (untuk dashboard)
router.get('/reminder', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, c.nama as nama_cabang, DATEDIFF(s.tgl_selesai, CURDATE()) as sisa_hari
       FROM sewa_cabang s JOIN cabang c ON s.cabang_id = c.id
       WHERE s.tgl_selesai >= CURDATE()
       AND s.tgl_selesai <= DATE_ADD(CURDATE(), INTERVAL 60 DAY)
       AND s.status != 'selesai'
       ORDER BY s.tgl_selesai ASC`
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST tambah sewa
router.post('/', auth(ROLES), upload.single('kwitansi'), async (req, res) => {
  try {
    const { cabang_id, tgl_mulai, tgl_selesai, nominal, periode_ket, catatan, nama_pemilik, hp_pemilik } = req.body;
    if (!cabang_id||!tgl_mulai||!tgl_selesai||!nominal)
      return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    const kwitansi_url = req.file ? 'kwitansi/'+req.file.filename : null;
    // Update info pemilik di tabel cabang jika diisi
    if (nama_pemilik||hp_pemilik) {
      await db.query('UPDATE cabang SET nama_pemilik=COALESCE(?,nama_pemilik), hp_pemilik=COALESCE(?,hp_pemilik) WHERE id=?',
        [nama_pemilik||null, hp_pemilik||null, cabang_id]);
    }
    const today = new Date().toISOString().slice(0,10);
    const diffDays = Math.ceil((new Date(tgl_selesai)-new Date(today))/(1000*60*60*24));
    const status = diffDays < 0 ? 'selesai' : diffDays <= 30 ? 'akan_jatuh_tempo' : 'aktif';
    const [result] = await db.query(
      'INSERT INTO sewa_cabang (cabang_id,tgl_mulai,tgl_selesai,nominal,periode_ket,kwitansi_url,catatan,status,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [cabang_id, tgl_mulai, tgl_selesai, nominal, periode_ket||'', kwitansi_url, catatan||'', status, req.user.id]
    );
    res.json({ success:true, message:'Data sewa berhasil disimpan.', id:result.insertId });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH edit sewa
router.patch('/:id', auth(ROLES), upload.single('kwitansi'), async (req, res) => {
  try {
    const { tgl_mulai, tgl_selesai, nominal, periode_ket, catatan } = req.body;
    const [[old]] = await db.query('SELECT kwitansi_url FROM sewa_cabang WHERE id=?', [req.params.id]);
    let kwitansi_url = old?.kwitansi_url || null;
    if (req.file) {
      if (kwitansi_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',kwitansi_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
      kwitansi_url = 'kwitansi/'+req.file.filename;
    }
    const today = new Date().toISOString().slice(0,10);
    const diffDays = Math.ceil((new Date(tgl_selesai)-new Date(today))/(1000*60*60*24));
    const status = diffDays < 0 ? 'selesai' : diffDays <= 30 ? 'akan_jatuh_tempo' : 'aktif';
    await db.query(
      'UPDATE sewa_cabang SET tgl_mulai=?,tgl_selesai=?,nominal=?,periode_ket=?,kwitansi_url=?,catatan=?,status=? WHERE id=?',
      [tgl_mulai, tgl_selesai, nominal, periode_ket||'', kwitansi_url, catatan||'', status, req.params.id]
    );
    res.json({ success:true, message:'Data sewa diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE sewa
router.delete('/:id', auth(['owner']), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT kwitansi_url FROM sewa_cabang WHERE id=?', [req.params.id]);
    if (row?.kwitansi_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',row.kwitansi_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
    await db.query('DELETE FROM sewa_cabang WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
