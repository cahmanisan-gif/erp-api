const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

const ROLES = ['owner','head_operational'];

// Hitung status & komisi/denda
function hitungKomisi(item, logs) {
  const terjualTotal = logs.reduce((s,l) => s+l.qty_terjual, 0);
  const qtyAwal = item.qty_awal;
  const sudahHabis = terjualTotal >= qtyAwal;
  const bulanTerakhir = logs.length;
  const tglMasuk = new Date(item.tgl_masuk);
  const now = new Date();
  const bulanBerjalan = Math.floor((now - tglMasuk) / (1000*60*60*24*30.44));

  let status = 'aktif';
  let komisi = 0;
  let denda  = 0;
  let info   = '';

  if (sudahHabis) {
    if (bulanTerakhir <= 6) {
      komisi = terjualTotal * 1500;
      status = 'selesai';
      info   = `✅ Habis dalam ${bulanTerakhir} bulan — Komisi Rp1.500/pcs`;
    } else {
      komisi = terjualTotal * 1000;
      status = 'selesai';
      info   = `✅ Habis dalam ${bulanTerakhir} bulan — Komisi Rp1.000/pcs`;
    }
  } else if (bulanBerjalan > 12) {
    const qtyTersisa = qtyAwal - terjualTotal;
    denda  = qtyAwal * 1000;
    status = 'denda';
    info   = `❌ Lewat 12 bulan, sisa ${qtyTersisa} pcs — Denda Rp1.000 x ${qtyAwal} pcs`;
  } else {
    const qtyTersisa = qtyAwal - terjualTotal;
    info = `🕐 Berjalan ${bulanBerjalan} bulan, sisa ${qtyTersisa} pcs`;
  }

  return { status, komisi, denda, info, terjualTotal, qtyTersisa: qtyAwal - terjualTotal };
}

// GET semua item deadstock management
router.get('/', auth(ROLES), async (req, res) => {
  try {
    const [items] = await db.query(
      `SELECT d.*, p.nama as nama_produk, p.kategori, u.nama_lengkap as nama_creator
       FROM deadstock_management d
       LEFT JOIN produk p ON d.produk_id = p.id
       LEFT JOIN users u ON d.created_by = u.id
       ORDER BY d.tgl_masuk DESC`
    );
    // Ambil semua log sekaligus
    const [allLogs] = await db.query('SELECT * FROM deadstock_management_log ORDER BY dsm_id, bulan_ke');
    const logMap = {};
    allLogs.forEach(l => {
      if (!logMap[l.dsm_id]) logMap[l.dsm_id] = [];
      logMap[l.dsm_id].push(l);
    });
    items.forEach(item => {
      const logs = logMap[item.id] || [];
      item.logs   = logs;
      item.kalkulasi = hitungKomisi(item, logs);
    });
    res.json({ success:true, data:items });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET satu item + logs
router.get('/:id', auth(ROLES), async (req, res) => {
  try {
    const [[item]] = await db.query(
      `SELECT d.*, p.nama as nama_produk FROM deadstock_management d
       LEFT JOIN produk p ON d.produk_id = p.id WHERE d.id=?`, [req.params.id]
    );
    if (!item) return res.status(404).json({ success:false, message:'Data tidak ditemukan.' });
    const [logs] = await db.query('SELECT * FROM deadstock_management_log WHERE dsm_id=? ORDER BY bulan_ke', [req.params.id]);
    item.logs = logs;
    item.kalkulasi = hitungKomisi(item, logs);
    res.json({ success:true, data:item });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST tambah item
router.post('/', auth(ROLES), async (req, res) => {
  try {
    const { produk_id, nama_barang, tgl_masuk, qty_awal, satuan, keterangan } = req.body;
    if (!nama_barang||!tgl_masuk||!qty_awal) return res.status(400).json({ success:false, message:'Nama barang, tanggal masuk, dan qty wajib diisi.' });
    const [result] = await db.query(
      'INSERT INTO deadstock_management (produk_id, nama_barang, tgl_masuk, qty_awal, satuan, keterangan, created_by) VALUES (?,?,?,?,?,?,?)',
      [produk_id||null, nama_barang, tgl_masuk, qty_awal, satuan||'pcs', keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Item deadstock berhasil ditambahkan.', id:result.insertId });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST input penjualan bulanan
router.post('/:id/log', auth(ROLES), async (req, res) => {
  try {
    const { bulan_ke, periode, qty_terjual, catatan } = req.body;
    if (!bulan_ke||!periode||qty_terjual===undefined) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    // Ambil data item untuk hitung qty_sisa
    const [[item]] = await db.query('SELECT * FROM deadstock_management WHERE id=?', [req.params.id]);
    const [prevLogs] = await db.query('SELECT SUM(qty_terjual) as total FROM deadstock_management_log WHERE dsm_id=? AND bulan_ke < ?', [req.params.id, bulan_ke]);
    const prevTotal = prevLogs[0].total || 0;
    const qty_sisa = item.qty_awal - prevTotal - parseInt(qty_terjual);
    await db.query(
      'INSERT INTO deadstock_management_log (dsm_id, bulan_ke, periode, qty_terjual, qty_sisa, catatan, input_by) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE qty_terjual=VALUES(qty_terjual), qty_sisa=VALUES(qty_sisa), catatan=VALUES(catatan)',
      [req.params.id, bulan_ke, periode, parseInt(qty_terjual), qty_sisa, catatan||'', req.user.id]
    );
    // Update status jika sudah selesai/denda
    const [allLogs] = await db.query('SELECT * FROM deadstock_management_log WHERE dsm_id=? ORDER BY bulan_ke', [req.params.id]);
    const calc = hitungKomisi(item, allLogs);
    if (calc.status !== 'aktif') {
      await db.query('UPDATE deadstock_management SET status=?, tgl_selesai=CURDATE() WHERE id=?', [calc.status, req.params.id]);
    }
    res.json({ success:true, message:'Data penjualan berhasil disimpan.', kalkulasi:calc });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// PATCH edit item
router.patch('/:id', auth(ROLES), async (req, res) => {
  try {
    const { nama_barang, tgl_masuk, qty_awal, satuan, keterangan } = req.body;
    await db.query(
      'UPDATE deadstock_management SET nama_barang=?, tgl_masuk=?, qty_awal=?, satuan=?, keterangan=? WHERE id=?',
      [nama_barang, tgl_masuk, qty_awal, satuan||'pcs', keterangan||'', req.params.id]
    );
    res.json({ success:true, message:'Data berhasil diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE item
router.delete('/:id', auth(['owner']), async (req, res) => {
  try {
    await db.query('DELETE FROM deadstock_management WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
