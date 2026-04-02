const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { getCabangAkses } = require('../middleware/cabangFilter');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','arsip');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const ALLOWED_EXT = ['.pdf','.jpg','.jpeg','.png','.gif','.webp','.doc','.docx','.xls','.xlsx','.csv'];
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Tipe file tidak diizinkan: ' + ext));
  }
});

router.get('/', auth(), async (req, res) => {
  try {
    const akses = await getCabangAkses(req.user);
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.cabang_id) { where += ' AND a.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    if (akses !== null) {
      if (akses.length === 0) return res.json({ success:true, data:[] });
      where += ` AND a.cabang_id IN (${akses.map(()=>'?').join(',')})`;
      params.push(...akses);
    }
    const [rows] = await db.query(
      `SELECT a.*, c.nama as nama_cabang FROM arsip a
       LEFT JOIN cabang c ON a.cabang_id = c.id
       ${where} ORDER BY a.created_at DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, message:'File tidak ditemukan.' });
  try {
    const { cabang_id, invoice_id, keterangan } = req.body;
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.','');
    await db.query(
      'INSERT INTO arsip (invoice_id, cabang_id, nama_file, path_file, tipe_file, ukuran_file, keterangan, user_id) VALUES (?,?,?,?,?,?,?,?)',
      [invoice_id||null, cabang_id, req.file.originalname, 'arsip/'+req.file.filename, ext, req.file.size, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'File berhasil diupload.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT path_file FROM arsip WHERE id=?', [req.params.id]);
    if (row) {
      const fp = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads', row.path_file);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await db.query('DELETE FROM arsip WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
