const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','entitas');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.fieldname+'-'+Date.now()+path.extname(file.originalname))
});
const ALLOWED_IMG_EXT = ['.jpg','.jpeg','.png','.gif','.webp'];
const upload = multer({
  storage, limits:{ fileSize:5*1024*1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMG_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Hanya file gambar yang diizinkan.'));
  }
});

// GET semua entitas
router.get('/', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT e.*, u.nama_lengkap as nama_sales, u.username
       FROM entitas_bisnis e JOIN users u ON e.sales_id = u.id
       ORDER BY u.nama_lengkap`
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET entitas milik sales sendiri
router.get('/my', auth(['sales']), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT * FROM entitas_bisnis WHERE sales_id=?', [req.user.id]);
    res.json({ success:true, data:row||null });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST / PUT upsert entitas (owner setup, atau sales edit milik sendiri)
router.post('/', auth(['owner','manajer']), async (req, res) => {
  try {
    const { sales_id, nama_usaha, alamat, telepon, email, nama_ttd, jabatan_ttd, nomor_rekening, nama_bank, atas_nama, catatan_invoice } = req.body;
    if (!sales_id||!nama_usaha) return res.status(400).json({ success:false, message:'Sales dan nama usaha wajib.' });
    await db.query(
      `INSERT INTO entitas_bisnis (sales_id,nama_usaha,alamat,telepon,email,nama_ttd,jabatan_ttd,nomor_rekening,nama_bank,atas_nama,catatan_invoice)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE nama_usaha=VALUES(nama_usaha),alamat=VALUES(alamat),telepon=VALUES(telepon),
       email=VALUES(email),nama_ttd=VALUES(nama_ttd),jabatan_ttd=VALUES(jabatan_ttd),
       nomor_rekening=VALUES(nomor_rekening),nama_bank=VALUES(nama_bank),atas_nama=VALUES(atas_nama),catatan_invoice=VALUES(catatan_invoice)`,
      [sales_id, nama_usaha, alamat||'', telepon||'', email||'', nama_ttd||'', jabatan_ttd||'', nomor_rekening||'', nama_bank||'', atas_nama||'', catatan_invoice||'']
    );
    res.json({ success:true, message:'Entitas bisnis berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH update tampilan invoice
router.patch('/:id/tampilan', auth(['owner','manajer','sales']), async (req, res) => {
  try {
    const { inv_warna_primer, inv_warna_aksen, inv_warna_teks, inv_footer_text, inv_show_logo, inv_show_ttd, inv_show_rekening, inv_border_style, inv_font } = req.body;
    await db.query(
      `UPDATE entitas_bisnis SET inv_warna_primer=?, inv_warna_aksen=?, inv_warna_teks=?,
       inv_footer_text=?, inv_show_logo=?, inv_show_ttd=?, inv_show_rekening=?, inv_border_style=?, inv_font=? WHERE id=?`,
      [inv_warna_primer||'#1a237e', inv_warna_aksen||'#283593', inv_warna_teks||'#222222',
       inv_footer_text||'', inv_show_logo??1, inv_show_ttd??1, inv_show_rekening??1,
       inv_border_style||'solid', inv_font||'Segoe UI', req.params.id]
    );
    res.json({ success:true, message:'Tampilan invoice berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST upload logo
router.post('/:id/logo', auth(['owner','manajer','sales']), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, message:'File tidak ditemukan.' });
  try {
    const [[old]] = await db.query('SELECT logo_url FROM entitas_bisnis WHERE id=?', [req.params.id]);
    if (old?.logo_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',old.logo_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
    const url = 'entitas/'+req.file.filename;
    await db.query('UPDATE entitas_bisnis SET logo_url=? WHERE id=?', [url, req.params.id]);
    res.json({ success:true, logo_url:'/uploads/'+url });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST upload tanda tangan
router.post('/:id/ttd', auth(['owner','manajer','sales']), upload.single('ttd'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success:false, message:'File tidak ditemukan.' });
  try {
    const [[old]] = await db.query('SELECT ttd_url FROM entitas_bisnis WHERE id=?', [req.params.id]);
    if (old?.ttd_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',old.ttd_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
    const url = 'entitas/'+req.file.filename;
    await db.query('UPDATE entitas_bisnis SET ttd_url=? WHERE id=?', [url, req.params.id]);
    res.json({ success:true, ttd_url:'/uploads/'+url });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
