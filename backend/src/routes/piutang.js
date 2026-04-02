const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET semua piutang
router.get('/', auth(), async (req,res) => {
  try {
    const {cabang_id, status} = req.query;
    let q = `SELECT p.*, c.nama as nama_cabang FROM piutang p LEFT JOIN cabang c ON c.id=p.cabang_id WHERE 1=1`;
    const params = [];
    if (cabang_id) { q+=' AND p.cabang_id=?'; params.push(cabang_id); }
    if (status)    { q+=' AND p.status=?'; params.push(status); }
    q += ' ORDER BY p.status ASC, p.jatuh_tempo ASC, p.created_at DESC';
    const [rows] = await db.query(q, params);
    res.json({success:true, data:rows});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// GET satu piutang
router.get('/:id', auth(), async (req,res) => {
  try {
    const [[row]] = await db.query('SELECT p.*, c.nama as nama_cabang FROM piutang p LEFT JOIN cabang c ON c.id=p.cabang_id WHERE p.id=?',[req.params.id]);
    res.json({success:true, data:row||null});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST tambah piutang
router.post('/', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  try {
    const {nama_pelanggan,no_hp,cabang_id,keterangan,total,jatuh_tempo} = req.body;
    await db.query('INSERT INTO piutang (nama_pelanggan,no_hp,cabang_id,keterangan,total,jatuh_tempo) VALUES (?,?,?,?,?,?)',
      [nama_pelanggan,no_hp||null,cabang_id||null,keterangan||null,total,jatuh_tempo||null]);
    res.json({success:true,message:'Piutang ditambahkan.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// PATCH edit piutang
router.patch('/:id', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  try {
    const {nama_pelanggan,no_hp,cabang_id,keterangan,total,jatuh_tempo} = req.body;
    await db.query('UPDATE piutang SET nama_pelanggan=?,no_hp=?,cabang_id=?,keterangan=?,total=?,jatuh_tempo=? WHERE id=?',
      [nama_pelanggan,no_hp||null,cabang_id||null,keterangan||null,total,jatuh_tempo||null,req.params.id]);
    res.json({success:true,message:'Piutang diupdate.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// DELETE hapus piutang
router.delete('/:id', auth(['owner']), async (req,res) => {
  try {
    await db.query('DELETE FROM piutang WHERE id=?',[req.params.id]);
    res.json({success:true,message:'Piutang dihapus.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// GET riwayat pembayaran
router.get('/:id/pembayaran', auth(), async (req,res) => {
  try {
    const [rows] = await db.query('SELECT * FROM piutang_pembayaran WHERE piutang_id=? ORDER BY tanggal DESC',[req.params.id]);
    res.json({success:true,data:rows});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST tambah pembayaran
router.post('/:id/pembayaran', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  try {
    const {jumlah,tanggal,catatan} = req.body;
    await db.query('INSERT INTO piutang_pembayaran (piutang_id,jumlah,tanggal,catatan) VALUES (?,?,?,?)',
      [req.params.id,jumlah,tanggal,catatan||null]);
    // Update terbayar dan status
    const [[p]] = await db.query('SELECT p.total, COALESCE(SUM(pp.jumlah),0) as ttl_bayar FROM piutang p LEFT JOIN piutang_pembayaran pp ON pp.piutang_id=p.id WHERE p.id=? GROUP BY p.id, p.total',[req.params.id]);
    const terbayar = parseFloat(p.ttl_bayar||0);
    const status = terbayar >= parseFloat(p.total) ? 'lunas' : 'belum_lunas';
    await db.query('UPDATE piutang SET terbayar=?,status=? WHERE id=?',[terbayar,status,req.params.id]);
    res.json({success:true,message:'Pembayaran disimpan.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// DELETE hapus pembayaran
router.delete('/pembayaran/:id', auth(['owner']), async (req,res) => {
  try {
    const [[bp]] = await db.query('SELECT piutang_id FROM piutang_pembayaran WHERE id=?',[req.params.id]);
    await db.query('DELETE FROM piutang_pembayaran WHERE id=?',[req.params.id]);
    if (bp) {
      const [[p]] = await db.query('SELECT p.total, COALESCE(SUM(pp.jumlah),0) as ttl_bayar FROM piutang p LEFT JOIN piutang_pembayaran pp ON pp.piutang_id=p.id WHERE p.id=? GROUP BY p.id, p.total',[bp.piutang_id]);
      const terbayar = parseFloat(p?.ttl_bayar||0);
      const status = terbayar >= parseFloat(p?.total||0) ? 'lunas' : 'belum_lunas';
      await db.query('UPDATE piutang SET terbayar=?,status=? WHERE id=?',[terbayar,status,bp.piutang_id]);
    }
    res.json({success:true,message:'Pembayaran dihapus.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

module.exports = router;
