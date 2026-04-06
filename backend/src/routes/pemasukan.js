const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.cabang_id) { where += ' AND p.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    const [rows] = await db.query(
      `SELECT p.*, c.nama as nama_cabang, COALESCE(p.sumber,'manual') as sumber FROM pemasukan p
       LEFT JOIN cabang c ON p.cabang_id = c.id
       ${where} ORDER BY p.tanggal DESC`, params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(['owner','admin_pusat','finance']), async (req, res) => {
  try {
    const { cabang_id, tanggal, nominal, keterangan } = req.body;
    if (!cabang_id||!tanggal||!nominal) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      'INSERT INTO pemasukan (cabang_id, tanggal, nominal, keterangan, user_id) VALUES (?,?,?,?,?)',
      [cabang_id, tanggal, nominal, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Pemasukan berhasil disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH edit pemasukan (revisi — termasuk yang pos_otomatis)
router.patch('/:id', auth(['owner','admin_pusat','finance']), async (req, res) => {
  try {
    const { nominal, keterangan } = req.body;
    const sets = [], vals = [];
    if (nominal !== undefined) { sets.push('nominal=?'); vals.push(nominal); }
    if (keterangan !== undefined) { sets.push('keterangan=?'); vals.push(keterangan); }
    if (!sets.length) return res.status(400).json({ success:false, message:'Tidak ada perubahan.' });
    // Jika edit pos_otomatis, ubah sumber jadi manual agar tidak di-overwrite transaksi berikutnya
    sets.push("sumber='manual'");
    vals.push(req.params.id);
    await db.query(`UPDATE pemasukan SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ success:true, message:'Pemasukan diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(['owner','finance']), async (req, res) => {
  try {
    await db.query('DELETE FROM pemasukan WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/pemasukan/sync-pos — backfill pemasukan otomatis dari data POS historis
router.post('/sync-pos', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { dari, sampai } = req.body;
    if (!dari || !sampai) return res.status(400).json({ success:false, message:'dari & sampai wajib (YYYY-MM-DD).' });
    const GUDANG_IDS = [3, 4];

    // Hitung omzet per cabang per hari
    const [rows] = await db.query(`
      SELECT t.cabang_id, DATE(t.created_at) as tgl, SUM(t.total) as omzet
      FROM pos_transaksi t
      WHERE t.status='selesai' AND t.cabang_id NOT IN (${GUDANG_IDS.join(',')})
        AND t.created_at >= ? AND t.created_at <= ?
      GROUP BY t.cabang_id, DATE(t.created_at)`,
      [dari + ' 00:00:00', sampai + ' 23:59:59']);

    let inserted = 0, updated = 0;
    for (const r of rows) {
      const tgl = r.tgl instanceof Date ? r.tgl.toISOString().slice(0,10) : String(r.tgl);
      const [result] = await db.query(`INSERT INTO pemasukan (cabang_id, tanggal, nominal, keterangan, sumber, user_id)
        VALUES (?, ?, ?, CONCAT('Omzet POS ', DATE_FORMAT(?,'%d/%m/%Y')), 'pos_otomatis', ?)
        ON DUPLICATE KEY UPDATE nominal=VALUES(nominal)`,
        [r.cabang_id, tgl, parseFloat(r.omzet), tgl, req.user.id]);
      if (result.affectedRows === 1) inserted++;
      else if (result.affectedRows === 2) updated++;
    }

    res.json({ success:true, message:`Sync selesai: ${inserted} baru, ${updated} diupdate dari ${rows.length} data.` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
