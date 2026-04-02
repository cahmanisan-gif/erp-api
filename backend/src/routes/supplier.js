const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req,res) => {
  try {
    const [rows] = await db.query('SELECT * FROM supplier ORDER BY aktif DESC, nama ASC');
    res.json({success:true, data:rows});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

router.post('/', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  try {
    const {nama,pic,no_hp,email,kota,alamat,produk,catatan,aktif} = req.body;
    if (!nama) return res.status(400).json({success:false,message:'Nama supplier wajib.'});
    await db.query('INSERT INTO supplier (nama,pic,no_hp,email,kota,alamat,produk,catatan,aktif) VALUES (?,?,?,?,?,?,?,?,?)',
      [nama,pic||null,no_hp||null,email||null,kota||null,alamat||null,produk||null,catatan||null,aktif??1]);
    res.json({success:true,message:'Supplier ditambahkan.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

router.patch('/:id', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  try {
    const {nama,pic,no_hp,email,kota,alamat,produk,catatan,aktif} = req.body;
    await db.query('UPDATE supplier SET nama=?,pic=?,no_hp=?,email=?,kota=?,alamat=?,produk=?,catatan=?,aktif=? WHERE id=?',
      [nama,pic||null,no_hp||null,email||null,kota||null,alamat||null,produk||null,catatan||null,aktif??1,req.params.id]);
    res.json({success:true,message:'Supplier diupdate.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

router.delete('/:id', auth(['owner']), async (req,res) => {
  try {
    await db.query('DELETE FROM supplier WHERE id=?',[req.params.id]);
    res.json({success:true,message:'Supplier dihapus.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

module.exports = router;
