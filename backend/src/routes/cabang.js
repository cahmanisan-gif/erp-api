const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { getCabangAkses } = require('../middleware/cabangFilter');

router.get('/', async (req, res) => {
  try {
    let where = 'WHERE c.aktif = 1';
    const params = [];
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const jwt = require('jsonwebtoken');
      try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        const akses = await getCabangAkses(user);
        if (akses !== null && akses.length > 0) {
          where += ` AND c.id IN (${akses.map(()=>'?').join(',')})`;
          params.push(...akses);
        }
        else if (akses !== null && akses.length === 0) return res.json({ success:true, data:[] });
      } catch(e) {}
    }
    const [rows] = await db.query(
      `SELECT c.*,
        u1.nama_lengkap as nama_pengelola,
        u2.nama_lengkap as nama_spv,
        u3.nama_lengkap as nama_manajer_area,
        u3.id           as manajer_area_id
       FROM cabang c
       LEFT JOIN users u1 ON c.pengelola_id   = u1.id
       LEFT JOIN users u2 ON c.spv_id         = u2.id
       LEFT JOIN users u3 ON c.manajer_area_id = u3.id
       ${where} ORDER BY u3.nama_lengkap, u2.nama_lengkap, c.nama`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(['owner','head_operational','admin_pusat']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { kode, nama, nama_toko, kecamatan, kabupaten, telepon, pengelola_id, spv_id, manajer_area_id, lat, lng } = req.body;
    if (!kode||!nama) return res.status(400).json({ success:false, message:'Kode dan nama wajib diisi.' });

    const [result] = await conn.query(
      'INSERT INTO cabang (kode, nama, nama_toko, kecamatan, kabupaten, telepon, pengelola_id, spv_id, manajer_area_id, lat, lng) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [kode.toUpperCase().trim(), nama.trim(), nama_toko||'', kecamatan||'', kabupaten||'', telepon||'', pengelola_id||null, spv_id||null, manajer_area_id||null,
       lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null]
    );
    const cabangId = result.insertId;

    // Auto-init: pos_stok qty=0 dari produk yang ada di GUDANG RETAIL (cabang_id=4)
    const GUDANG_RETAIL_ID = 4;
    const [produkList] = await conn.query(
      `SELECT s.produk_id FROM pos_stok s
       JOIN pos_produk p ON p.id = s.produk_id AND p.aktif = 1
       WHERE s.cabang_id = ?`, [GUDANG_RETAIL_ID]);
    if (produkList.length) {
      const ph = produkList.map(() => '(?,?,0)').join(',');
      const vals = produkList.flatMap(p => [p.produk_id, cabangId]);
      await conn.query(`INSERT IGNORE INTO pos_stok (produk_id, cabang_id, qty) VALUES ${ph}`, vals);
    }

    // Auto-init: snapshot modal hari ini
    await conn.query(
      `INSERT IGNORE INTO pos_modal_snapshot (tanggal, cabang_id, total_produk, total_stok, total_modal, total_nilai_jual)
       VALUES (CURDATE(), ?, 0, 0, 0, 0)`, [cabangId]);

    await conn.commit();
    res.json({ success:true, message:`Cabang berhasil ditambahkan. ${produkList.length} produk diinisialisasi (stok 0).` });
  } catch(e) {
    await conn.rollback();
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({ success:false, message:'Kode cabang sudah ada.' });
    res.status(500).json({ success:false, message:e.message });
  } finally { conn.release(); }
});

router.patch('/:id', auth(['owner','head_operational','admin_pusat']), async (req, res) => {
  try {
    const { kode, nama, nama_toko, kecamatan, kabupaten, telepon, pengelola_id, spv_id, manajer_area_id, aktif, tanggal_buka, lat, lng } = req.body;
    await db.query(
      'UPDATE cabang SET kode=?, nama=?, nama_toko=?, kecamatan=?, kabupaten=?, telepon=?, pengelola_id=?, spv_id=?, manajer_area_id=?, aktif=?, tanggal_buka=?, lat=?, lng=? WHERE id=?',
      [kode, nama, nama_toko||'', kecamatan||'', kabupaten||'', telepon||'', pengelola_id||null, spv_id||null, manajer_area_id||null, aktif??1, tanggal_buka||null,
       (lat !== undefined && lat !== '') ? parseFloat(lat) : null,
       (lng !== undefined && lng !== '') ? parseFloat(lng) : null,
       req.params.id]
    );
    res.json({ success:true, message:'Cabang berhasil diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(['owner']), async (req, res) => {
  try {
    await db.query('UPDATE cabang SET aktif=0 WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'Cabang dinonaktifkan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;

// GET /api/cabang/target - daftar target omzet per cabang
router.get('/target', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.kode, c.nama, COALESCE(t.target_bulanan,0) AS target_bulanan
       FROM cabang c
       LEFT JOIN target_omzet_cabang t ON t.cabang_id = c.id
       WHERE c.aktif=1 ORDER BY c.nama`
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/cabang/target - set target omzet cabang
router.post('/target', auth(['owner']), async (req, res) => {
  try {
    const { cabang_id, target_bulanan } = req.body;
    if (!cabang_id) return res.status(400).json({ success:false, message:'cabang_id wajib.' });
    await db.query(
      `INSERT INTO target_omzet_cabang (cabang_id, target_bulanan)
       VALUES (?,?) ON DUPLICATE KEY UPDATE target_bulanan=VALUES(target_bulanan)`,
      [cabang_id, target_bulanan||0]
    );
    res.json({ success:true, message:'Target disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
