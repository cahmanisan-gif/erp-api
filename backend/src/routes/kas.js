const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

const ROLES = ['owner'];

// GET semua akun + saldo real-time
router.get('/akun', auth(ROLES), async (req, res) => {
  try {
    const [akun] = await db.query('SELECT * FROM kas_akun WHERE aktif=1 ORDER BY nama_bank');
    for (const a of akun) {
      const [[s]] = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tipe IN ('masuk','transfer_in')  THEN nominal ELSE 0 END),0) AS total_masuk,
           COALESCE(SUM(CASE WHEN tipe IN ('keluar','transfer_out') THEN nominal ELSE 0 END),0) AS total_keluar
         FROM kas_mutasi WHERE akun_id=?`, [a.id]
      );
      a.total_masuk  = parseFloat(s.total_masuk);
      a.total_keluar = parseFloat(s.total_keluar);
      a.saldo        = parseFloat(a.saldo_awal) + a.total_masuk - a.total_keluar;
    }
    res.json({ success:true, data:akun });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST tambah akun
router.post('/akun', auth(ROLES), async (req, res) => {
  try {
    const { nama_akun, nama_bank, no_rekening, atas_nama, saldo_awal, keterangan } = req.body;
    if (!nama_akun||!nama_bank) return res.status(400).json({ success:false, message:'Nama akun dan bank wajib diisi.' });
    await db.query(
      'INSERT INTO kas_akun (nama_akun,nama_bank,no_rekening,atas_nama,saldo_awal,keterangan) VALUES (?,?,?,?,?,?)',
      [nama_akun, nama_bank, no_rekening||'', atas_nama||'', parseFloat(saldo_awal)||0, keterangan||'']
    );
    res.json({ success:true, message:'Akun berhasil ditambahkan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH edit akun
router.patch('/akun/:id', auth(ROLES), async (req, res) => {
  try {
    const { nama_akun, nama_bank, no_rekening, atas_nama, saldo_awal, keterangan } = req.body;
    await db.query(
      'UPDATE kas_akun SET nama_akun=?,nama_bank=?,no_rekening=?,atas_nama=?,saldo_awal=?,keterangan=? WHERE id=?',
      [nama_akun, nama_bank, no_rekening||'', atas_nama||'', parseFloat(saldo_awal)||0, keterangan||'', req.params.id]
    );
    res.json({ success:true, message:'Akun diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE akun (soft)
router.delete('/akun/:id', auth(ROLES), async (req, res) => {
  try {
    await db.query('UPDATE kas_akun SET aktif=0 WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET mutasi per akun
router.get('/mutasi', auth(ROLES), async (req, res) => {
  try {
    const { akun_id, bulan, tahun } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (akun_id) { where += ' AND m.akun_id=?'; params.push(parseInt(akun_id)); }
    if (bulan && tahun) { where += ' AND MONTH(m.tanggal)=? AND YEAR(m.tanggal)=?'; params.push(parseInt(bulan), parseInt(tahun)); }
    else if (tahun) { where += ' AND YEAR(m.tanggal)=?'; params.push(parseInt(tahun)); }
    const [rows] = await db.query(
      `SELECT m.*, a.nama_akun, a.nama_bank,
              ra.nama_akun as ref_nama_akun, ra.nama_bank as ref_nama_bank,
              u.nama_lengkap as nama_creator
       FROM kas_mutasi m
       JOIN kas_akun a ON m.akun_id=a.id
       LEFT JOIN kas_akun ra ON m.ref_akun_id=ra.id
       LEFT JOIN users u ON m.created_by=u.id
       ${where} ORDER BY m.tanggal DESC, m.id DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST tambah mutasi
router.post('/mutasi', auth(ROLES), async (req, res) => {
  try {
    const { akun_id, tanggal, tipe, nominal, keterangan, ref_akun_id } = req.body;
    if (!akun_id||!tanggal||!tipe||!nominal) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    // Jika transfer, buat 2 entri
    if (tipe==='transfer') {
      if (!ref_akun_id) return res.status(400).json({ success:false, message:'Akun tujuan wajib diisi untuk transfer.' });
      await db.query(
        'INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,ref_akun_id,created_by) VALUES (?,?,?,?,?,?,?)',
        [akun_id, tanggal, 'transfer_out', parseFloat(nominal), keterangan||'Transfer', ref_akun_id, req.user.id]
      );
      await db.query(
        'INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,ref_akun_id,created_by) VALUES (?,?,?,?,?,?,?)',
        [ref_akun_id, tanggal, 'transfer_in', parseFloat(nominal), keterangan||'Transfer', akun_id, req.user.id]
      );
    } else {
      await db.query(
        'INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by) VALUES (?,?,?,?,?,?)',
        [akun_id, tanggal, tipe, parseFloat(nominal), keterangan||'', req.user.id]
      );
    }
    res.json({ success:true, message:'Mutasi berhasil dicatat.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE mutasi
router.delete('/mutasi/:id', auth(ROLES), async (req, res) => {
  try {
    // Jika transfer, hapus pasangannya juga
    const [[m]] = await db.query('SELECT * FROM kas_mutasi WHERE id=?', [req.params.id]);
    if (m && ['transfer_in','transfer_out'].includes(m.tipe)) {
      const pasangan = m.tipe==='transfer_out' ? 'transfer_in' : 'transfer_out';
      await db.query(
        'DELETE FROM kas_mutasi WHERE akun_id=? AND ref_akun_id=? AND tipe=? AND tanggal=? AND nominal=? AND id!=?',
        [m.ref_akun_id, m.akun_id, pasangan, m.tanggal, m.nominal, req.params.id]
      );
    }
    await db.query('DELETE FROM kas_mutasi WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
