const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');

const upload = multer({ dest: '/tmp/' });

// GET /api/request-produk - daftar semua produk master
router.get('/', auth(), async (req, res) => {
  try {
    const { aktif, jenis } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (aktif !== undefined) { where += ' AND aktif=?'; params.push(aktif); }
    if (jenis) { where += ' AND jenis=?'; params.push(jenis); }
    const [rows] = await db.query(`SELECT * FROM request_produk_master ${where} ORDER BY jenis, nama`, params);
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/request-produk - tambah produk
router.post('/', auth(['owner','admin_pusat','manajer']), async (req, res) => {
  try {
    const { nama, jenis, satuan } = req.body;
    if (!nama) return res.status(400).json({success:false,message:'Nama wajib diisi.'});
    await db.query('INSERT INTO request_produk_master (nama,jenis,satuan) VALUES (?,?,?)', [nama.trim(), jenis||null, satuan||'pcs']);
    res.json({success:true, message:'Produk ditambahkan.'});
  } catch(e) {
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({success:false,message:'Produk sudah ada.'});
    res.status(500).json({success:false,message:e.message});
  }
});

// PATCH /api/request-produk/:id
router.patch('/:id', auth(['owner','admin_pusat','manajer']), async (req, res) => {
  try {
    const { nama, jenis, satuan, aktif } = req.body;
    await db.query('UPDATE request_produk_master SET nama=?,jenis=?,satuan=?,aktif=? WHERE id=?',
      [nama, jenis||null, satuan||'pcs', aktif??1, req.params.id]);
    res.json({success:true, message:'Produk diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/request-produk/:id
router.delete('/:id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    await db.query('DELETE FROM request_produk_master WHERE id=?', [req.params.id]);
    res.json({success:true, message:'Produk dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/request-produk/import - import dari Excel
router.post('/import', auth(['owner','admin_pusat']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({success:false,message:'File wajib diupload.'});
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    fs.unlinkSync(req.file.path);

    let inserted = 0, skipped = 0;
    for (const row of rows) {
      const nama  = (row['Nama'] || row['nama'] || '').toString().trim();
      const jenis = (row['Jenis'] || row['jenis'] || '').toString().trim() || null;
      const satuan= (row['Satuan'] || row['satuan'] || 'pcs').toString().trim();
      if (!nama) { skipped++; continue; }
      try {
        await db.query('INSERT INTO request_produk_master (nama,jenis,satuan) VALUES (?,?,?)', [nama, jenis, satuan]);
        inserted++;
      } catch(e) { if (e.code==='ER_DUP_ENTRY') skipped++; else throw e; }
    }
    res.json({success:true, message:`Import selesai: ${inserted} ditambah, ${skipped} dilewati.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/request-produk/export - export ke Excel
router.get('/export', auth(['owner','admin_pusat','manajer']), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT nama as Nama, jenis as Jenis, satuan as Satuan, aktif as Aktif FROM request_produk_master ORDER BY jenis, nama');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{wch:30},{wch:15},{wch:10},{wch:8}];
    XLSX.utils.book_append_sheet(wb, ws, 'Master Produk Request');
    const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
    res.setHeader('Content-Disposition', 'attachment; filename=master_produk_request.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
