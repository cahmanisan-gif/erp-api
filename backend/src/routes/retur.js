const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

// ── NOMOR GENERATOR ──
async function genNomorRC() {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth()+1).padStart(2,'0');
  const [[r]] = await db.query("SELECT COUNT(*) as c FROM retur_customer WHERE nomor LIKE ?", [`RC-${y}${m}-%`]);
  return `RC-${y}${m}-${String((r.c||0)+1).padStart(4,'0')}`;
}
async function genNomorRS() {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth()+1).padStart(2,'0');
  const [[r]] = await db.query("SELECT COUNT(*) as c FROM retur_supplier WHERE nomor LIKE ?", [`RS-${y}${m}-%`]);
  return `RS-${y}${m}-${String((r.c||0)+1).padStart(4,'0')}`;
}

// ══════════════════════════════════════
// RETUR CUSTOMER
// ══════════════════════════════════════

// GET /api/retur/customer?cabang_id=&status=&dari=&sampai=
router.get('/customer', auth(), async (req, res) => {
  try {
    const {cabang_id, status, dari, sampai} = req.query;
    let q = `SELECT r.*, c.nama as nama_cabang, u.nama_lengkap as nama_user
             FROM retur_customer r
             LEFT JOIN cabang c ON c.id=r.cabang_id
             LEFT JOIN users u ON u.id=r.created_by WHERE 1=1`;
    const p = [];
    if (cabang_id) { q+=' AND r.cabang_id=?'; p.push(cabang_id); }
    if (status)    { q+=' AND r.status=?';    p.push(status); }
    if (dari)      { q+=' AND r.tanggal>=?';  p.push(dari); }
    if (sampai)    { q+=' AND r.tanggal<=?';  p.push(sampai); }
    q += ' ORDER BY r.created_at DESC LIMIT 200';
    const [rows] = await db.query(q, p);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/retur/customer/:id — detail + items
router.get('/customer/:id', auth(), async (req, res) => {
  try {
    const [[retur]] = await db.query(`SELECT r.*, c.nama as nama_cabang FROM retur_customer r LEFT JOIN cabang c ON c.id=r.cabang_id WHERE r.id=?`, [req.params.id]);
    if (!retur) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    const [items] = await db.query('SELECT * FROM retur_customer_item WHERE retur_id=?', [req.params.id]);
    res.json({success:true, data:{...retur, items}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/retur/customer — buat retur baru (draft)
router.post('/customer', auth(), async (req, res) => {
  try {
    const {transaksi_id, cabang_id, tanggal, alasan, catatan, metode_refund, items} = req.body;
    if (!cabang_id || !items?.length) return res.status(400).json({success:false,message:'Cabang dan items wajib.'});

    const nomor = await genNomorRC();
    const subtotal = items.reduce((s,i) => s + (i.qty * i.harga), 0);

    const [ins] = await db.query(`INSERT INTO retur_customer
      (nomor, transaksi_id, cabang_id, tanggal, alasan, catatan, subtotal, metode_refund, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [nomor, transaksi_id||null, cabang_id, tanggal||new Date().toISOString().slice(0,10),
       alasan||'cacat', catatan||null, subtotal, metode_refund||'cash', req.user.id]);
    const returId = ins.insertId;

    for (const item of items) {
      await db.query(`INSERT INTO retur_customer_item (retur_id, produk_id, nama_produk, qty, harga, subtotal)
        VALUES (?,?,?,?,?,?)`,
        [returId, item.produk_id||null, item.nama_produk, item.qty, item.harga||0, (item.qty*(item.harga||0))]);
    }
    audit(req, 'create', 'retur_customer', returId, nomor, {subtotal, alasan, cabang_id});
    res.json({success:true, message:'Retur customer dibuat.', id:returId, nomor});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/retur/customer/:id/setujui — approve: stok kembali + catat pengeluaran refund
router.post('/customer/:id/setujui', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[retur]] = await conn.query('SELECT * FROM retur_customer WHERE id=?', [req.params.id]);
    if (!retur) { conn.release(); return res.status(404).json({success:false,message:'Tidak ditemukan.'}); }
    if (retur.status !== 'draft') { conn.release(); return res.status(400).json({success:false,message:'Retur sudah diproses.'}); }

    const [items] = await conn.query('SELECT * FROM retur_customer_item WHERE retur_id=?', [req.params.id]);

    // 1. Kembalikan stok
    for (const item of items) {
      if (!item.produk_id) continue;
      await conn.query(`INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE qty=qty+?`, [item.produk_id, retur.cabang_id, item.qty, item.qty]);
      await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id)
        VALUES (?,?,'retur_masuk',?,?,?)`,
        [item.produk_id, retur.cabang_id, item.qty, 'Retur customer '+retur.nomor, req.user.id]).catch(()=>{});
    }

    // 2. Catat pengeluaran refund (jika bukan tukar barang)
    if (retur.metode_refund !== 'tukar_barang' && retur.subtotal > 0) {
      const [[katRetur]] = await conn.query("SELECT id FROM pengeluaran_kategori WHERE nama LIKE '%retur%' LIMIT 1");
      if (katRetur) {
        await conn.query(`INSERT INTO pengeluaran (cabang_id,kategori_id,user_id,tanggal,nominal,keterangan,status)
          VALUES (?,?,?,?,?,?,'approved')`,
          [retur.cabang_id, katRetur.id, req.user.id, retur.tanggal, retur.subtotal,
           `Refund retur ${retur.nomor} (${retur.metode_refund})`]).catch(()=>{});
      }
    }

    // 3. Update status
    await conn.query("UPDATE retur_customer SET status='disetujui', approved_by=? WHERE id=?", [req.user.id, req.params.id]);
    await conn.commit();
    audit(req, 'approve', 'retur_customer', req.params.id, retur.nomor, {subtotal:retur.subtotal, metode_refund:retur.metode_refund});
    res.json({success:true, message:`Retur ${retur.nomor} disetujui. Stok dikembalikan${retur.metode_refund!=='tukar_barang'?', refund dicatat.':'.'}`});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// POST /api/retur/customer/:id/tolak
router.post('/customer/:id/tolak', auth(['owner','manajer','head_operational']), async (req, res) => {
  try {
    await db.query("UPDATE retur_customer SET status='ditolak' WHERE id=? AND status='draft'", [req.params.id]);
    res.json({success:true, message:'Retur ditolak.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/retur/customer/:id — hapus draft
router.delete('/customer/:id', auth(['owner']), async (req, res) => {
  try {
    const [[r]] = await db.query('SELECT status FROM retur_customer WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    if (r.status !== 'draft') return res.status(400).json({success:false,message:'Hanya draft yang bisa dihapus.'});
    await db.query('DELETE FROM retur_customer WHERE id=?', [req.params.id]);
    res.json({success:true, message:'Draft retur dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ══════════════════════════════════════
// RETUR SUPPLIER
// ══════════════════════════════════════

// GET /api/retur/supplier?cabang_id=&status=
router.get('/supplier', auth(), async (req, res) => {
  try {
    const {cabang_id, status, dari, sampai} = req.query;
    let q = `SELECT r.*, c.nama as nama_cabang, u.nama_lengkap as nama_user
             FROM retur_supplier r
             LEFT JOIN cabang c ON c.id=r.cabang_id
             LEFT JOIN users u ON u.id=r.created_by WHERE 1=1`;
    const p = [];
    if (cabang_id) { q+=' AND r.cabang_id=?'; p.push(cabang_id); }
    if (status)    { q+=' AND r.status=?';    p.push(status); }
    if (dari)      { q+=' AND r.tanggal>=?';  p.push(dari); }
    if (sampai)    { q+=' AND r.tanggal<=?';  p.push(sampai); }
    q += ' ORDER BY r.created_at DESC LIMIT 200';
    const [rows] = await db.query(q, p);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/retur/supplier/:id
router.get('/supplier/:id', auth(), async (req, res) => {
  try {
    const [[retur]] = await db.query('SELECT r.*, c.nama as nama_cabang FROM retur_supplier r LEFT JOIN cabang c ON c.id=r.cabang_id WHERE r.id=?', [req.params.id]);
    if (!retur) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    const [items] = await db.query('SELECT * FROM retur_supplier_item WHERE retur_id=?', [req.params.id]);
    res.json({success:true, data:{...retur, items}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/retur/supplier — buat retur supplier
router.post('/supplier', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const {pembelian_id, supplier_id, nama_supplier, cabang_id, tanggal, alasan, catatan, items} = req.body;
    if (!cabang_id || !items?.length) return res.status(400).json({success:false,message:'Cabang dan items wajib.'});

    const nomor = await genNomorRS();
    const subtotal = items.reduce((s,i) => s + (i.qty * (i.harga_modal||0)), 0);

    const [ins] = await db.query(`INSERT INTO retur_supplier
      (nomor, pembelian_id, supplier_id, nama_supplier, cabang_id, tanggal, alasan, catatan, subtotal, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [nomor, pembelian_id||null, supplier_id||null, nama_supplier||'',
       cabang_id, tanggal||new Date().toISOString().slice(0,10),
       alasan||'cacat', catatan||null, subtotal, req.user.id]);
    const returId = ins.insertId;

    for (const item of items) {
      await db.query(`INSERT INTO retur_supplier_item (retur_id, produk_id, nama_produk, qty, harga_modal, subtotal)
        VALUES (?,?,?,?,?,?)`,
        [returId, item.produk_id||null, item.nama_produk, item.qty, item.harga_modal||0, item.qty*(item.harga_modal||0)]);
    }
    audit(req, 'create', 'retur_supplier', returId, nomor, {subtotal, nama_supplier, cabang_id});
    res.json({success:true, message:'Retur supplier dibuat.', id:returId, nomor});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/retur/supplier/:id/kirim — proses: stok dikurangi + status dikirim
router.post('/supplier/:id/kirim', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[retur]] = await conn.query('SELECT * FROM retur_supplier WHERE id=?', [req.params.id]);
    if (!retur) { conn.release(); return res.status(404).json({success:false,message:'Tidak ditemukan.'}); }
    if (retur.status !== 'draft') { conn.release(); return res.status(400).json({success:false,message:'Retur sudah diproses.'}); }

    const [items] = await conn.query('SELECT * FROM retur_supplier_item WHERE retur_id=?', [req.params.id]);

    // Kurangi stok
    for (const item of items) {
      if (!item.produk_id) continue;
      await conn.query(`UPDATE pos_stok SET qty=GREATEST(0,qty-?) WHERE produk_id=? AND cabang_id=?`,
        [item.qty, item.produk_id, retur.cabang_id]);
      await conn.query(`INSERT INTO pos_stok_log (produk_id,cabang_id,tipe,qty,keterangan,user_id)
        VALUES (?,?,'retur_keluar',?,?,?)`,
        [item.produk_id, retur.cabang_id, item.qty, 'Retur supplier '+retur.nomor, req.user.id]).catch(()=>{});
    }

    await conn.query("UPDATE retur_supplier SET status='dikirim' WHERE id=?", [req.params.id]);
    await conn.commit();
    audit(req, 'update', 'retur_supplier', req.params.id, retur.nomor+' → dikirim', {subtotal:retur.subtotal});
    res.json({success:true, message:`Retur ${retur.nomor} diproses. Stok dikurangi.`});
  } catch(e) { await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// POST /api/retur/supplier/:id/selesai — tandai selesai (supplier sudah ganti/credit)
router.post('/supplier/:id/selesai', auth(['owner','manajer','head_operational']), async (req, res) => {
  try {
    await db.query("UPDATE retur_supplier SET status='selesai' WHERE id=? AND status='dikirim'", [req.params.id]);
    res.json({success:true, message:'Retur supplier selesai.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/retur/supplier/:id
router.delete('/supplier/:id', auth(['owner']), async (req, res) => {
  try {
    const [[r]] = await db.query('SELECT status FROM retur_supplier WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    if (r.status !== 'draft') return res.status(400).json({success:false,message:'Hanya draft yang bisa dihapus.'});
    await db.query('DELETE FROM retur_supplier WHERE id=?', [req.params.id]);
    res.json({success:true, message:'Draft retur dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/retur/summary — summary untuk dashboard
router.get('/summary', auth(), async (req, res) => {
  try {
    const tgl30 = new Date(Date.now()-30*24*3600000).toISOString().slice(0,10);
    const [[cust]] = await db.query(`SELECT COUNT(*) as total, SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) as pending,
      COALESCE(SUM(CASE WHEN status='disetujui' THEN subtotal ELSE 0 END),0) as total_refund
      FROM retur_customer WHERE tanggal>=?`, [tgl30]);
    const [[supp]] = await db.query(`SELECT COUNT(*) as total, SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) as pending,
      COALESCE(SUM(CASE WHEN status IN ('dikirim','selesai') THEN subtotal ELSE 0 END),0) as total_retur
      FROM retur_supplier WHERE tanggal>=?`, [tgl30]);
    res.json({success:true, data:{customer:cust, supplier:supp}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
