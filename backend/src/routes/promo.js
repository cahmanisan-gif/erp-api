const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

// GET /api/promo — list semua promo (owner: semua, kasir: yg berlaku di cabangnya)
router.get('/', auth(), async (req, res) => {
  try {
    const { aktif } = req.query;
    let where = '1=1';
    const params = [];
    if (aktif !== undefined) { where += ' AND aktif=?'; params.push(parseInt(aktif)); }
    const [rows] = await db.query(`SELECT * FROM promo WHERE ${where} ORDER BY created_at DESC`, params);

    // Filter by cabang jika bukan management
    const isManagement = ['owner','admin_pusat','head_operational','manajer'].includes(req.user.role);
    const cabangId = req.user.cabang_id;
    const filtered = isManagement ? rows : rows.filter(p => {
      if (!p.cabang_ids) return true; // null = semua cabang
      try {
        const ids = typeof p.cabang_ids === 'string' ? JSON.parse(p.cabang_ids) : p.cabang_ids;
        return !ids.length || ids.includes(cabangId);
      } catch(e) { return true; }
    });

    res.json({success:true, data:filtered});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/promo — buat promo baru
router.post('/', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const {nama, kode, tipe, nilai, maks_diskon, min_belanja, beli_qty, gratis_qty, bundle_harga,
           tanggal_mulai, tanggal_selesai, scope, scope_kategori, scope_produk_ids,
           cabang_ids, maks_penggunaan} = req.body;
    if (!nama || !tipe) return res.status(400).json({success:false,message:'Nama dan tipe wajib.'});

    const [ins] = await db.query(`INSERT INTO promo
      (nama,kode,tipe,nilai,maks_diskon,min_belanja,beli_qty,gratis_qty,bundle_harga,
       tanggal_mulai,tanggal_selesai,scope,scope_kategori,scope_produk_ids,cabang_ids,maks_penggunaan,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [nama, kode||null, tipe, nilai||0, maks_diskon||0, min_belanja||0,
       beli_qty||0, gratis_qty||0, bundle_harga||0,
       tanggal_mulai||null, tanggal_selesai||null,
       scope||'semua', scope_kategori||null,
       scope_produk_ids ? JSON.stringify(scope_produk_ids) : null,
       cabang_ids ? JSON.stringify(cabang_ids) : null,
       maks_penggunaan||0, req.user.id]);

    audit(req, 'create', 'promo', ins.insertId, nama, {tipe, nilai, kode});
    res.json({success:true, message:'Promo dibuat.', id:ins.insertId});
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({success:false,message:'Kode promo sudah ada.'});
    res.status(500).json({success:false,message:e.message});
  }
});

// PATCH /api/promo/:id — update promo
router.patch('/:id', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const {nama, kode, tipe, nilai, maks_diskon, min_belanja, beli_qty, gratis_qty, bundle_harga,
           tanggal_mulai, tanggal_selesai, scope, scope_kategori, scope_produk_ids,
           cabang_ids, maks_penggunaan, aktif} = req.body;
    await db.query(`UPDATE promo SET nama=?,kode=?,tipe=?,nilai=?,maks_diskon=?,min_belanja=?,
      beli_qty=?,gratis_qty=?,bundle_harga=?,tanggal_mulai=?,tanggal_selesai=?,
      scope=?,scope_kategori=?,scope_produk_ids=?,cabang_ids=?,maks_penggunaan=?,aktif=? WHERE id=?`,
      [nama, kode||null, tipe, nilai||0, maks_diskon||0, min_belanja||0,
       beli_qty||0, gratis_qty||0, bundle_harga||0,
       tanggal_mulai||null, tanggal_selesai||null,
       scope||'semua', scope_kategori||null,
       scope_produk_ids ? JSON.stringify(scope_produk_ids) : null,
       cabang_ids ? JSON.stringify(cabang_ids) : null,
       maks_penggunaan||0, aktif??1, req.params.id]);
    audit(req, 'update', 'promo', req.params.id, nama);
    res.json({success:true, message:'Promo diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/promo/:id
router.delete('/:id', auth(['owner']), async (req, res) => {
  try {
    const [[p]] = await db.query('SELECT nama FROM promo WHERE id=?', [req.params.id]);
    await db.query('DELETE FROM promo WHERE id=?', [req.params.id]);
    audit(req, 'delete', 'promo', req.params.id, p?.nama);
    res.json({success:true, message:'Promo dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/promo/validate — validasi & hitung diskon (dipanggil dari kasir)
router.post('/validate', auth(), async (req, res) => {
  try {
    const { kode, cabang_id, items, total_belanja } = req.body;
    // items: [{produk_id, nama, kategori, qty, harga_jual}]
    if (!kode) return res.status(400).json({success:false,message:'Kode promo wajib.'});

    const today = new Date().toISOString().slice(0,10);
    const [[promo]] = await db.query(
      `SELECT * FROM promo WHERE kode=? AND aktif=1`, [kode.trim().toUpperCase()]);

    if (!promo) return res.json({success:false, message:'Kode promo tidak ditemukan.'});

    // Cek periode
    if (promo.tanggal_mulai && today < promo.tanggal_mulai)
      return res.json({success:false, message:'Promo belum dimulai.'});
    if (promo.tanggal_selesai && today > promo.tanggal_selesai)
      return res.json({success:false, message:'Promo sudah berakhir.'});

    // Cek cabang
    if (promo.cabang_ids) {
      const ids = typeof promo.cabang_ids === 'string' ? JSON.parse(promo.cabang_ids) : promo.cabang_ids;
      if (ids.length && !ids.includes(parseInt(cabang_id)))
        return res.json({success:false, message:'Promo tidak berlaku di cabang ini.'});
    }

    // Cek limit penggunaan
    if (promo.maks_penggunaan > 0 && promo.sudah_digunakan >= promo.maks_penggunaan)
      return res.json({success:false, message:'Kuota promo sudah habis.'});

    // Cek minimum belanja
    if (promo.min_belanja > 0 && total_belanja < promo.min_belanja)
      return res.json({success:false, message:`Minimum belanja ${promo.min_belanja.toLocaleString('id-ID')} untuk promo ini.`});

    // Hitung diskon
    let diskon = 0;
    const tipe = promo.tipe;

    if (tipe === 'diskon_persen') {
      diskon = Math.round(total_belanja * promo.nilai / 100);
      if (promo.maks_diskon > 0) diskon = Math.min(diskon, promo.maks_diskon);
    } else if (tipe === 'diskon_nominal') {
      diskon = promo.nilai;
    } else if (tipe === 'beli_x_gratis_y') {
      // Cari item yang applicable (scope)
      const applicable = filterByScope(items, promo);
      const totalQty = applicable.reduce((s,i) => s + i.qty, 0);
      if (totalQty >= promo.beli_qty + promo.gratis_qty) {
        // Gratis item termurah
        const sorted = [...applicable].sort((a,b) => a.harga_jual - b.harga_jual);
        let gratisLeft = promo.gratis_qty;
        for (const item of sorted) {
          if (gratisLeft <= 0) break;
          const gratis = Math.min(gratisLeft, item.qty);
          diskon += gratis * item.harga_jual;
          gratisLeft -= gratis;
        }
      }
    } else if (tipe === 'bundle_harga') {
      const applicable = filterByScope(items, promo);
      const normalTotal = applicable.reduce((s,i) => s + i.harga_jual * i.qty, 0);
      if (normalTotal > promo.bundle_harga) diskon = normalTotal - promo.bundle_harga;
    }

    res.json({success:true, data:{
      promo_id: promo.id,
      nama: promo.nama,
      tipe: promo.tipe,
      diskon: Math.round(diskon),
      message: diskon > 0 ? `Promo "${promo.nama}" berlaku! Diskon Rp ${diskon.toLocaleString('id-ID')}` : 'Promo tidak applicable untuk item ini.'
    }});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/promo/use — catat penggunaan promo (dipanggil setelah transaksi sukses)
router.post('/use', auth(), async (req, res) => {
  try {
    const { promo_id, transaksi_id, cabang_id, diskon_applied } = req.body;
    if (!promo_id || !transaksi_id) return res.json({success:true});
    await db.query('INSERT INTO promo_usage (promo_id,transaksi_id,cabang_id,user_id,diskon_applied) VALUES (?,?,?,?,?)',
      [promo_id, transaksi_id, cabang_id, req.user.id, diskon_applied||0]);
    await db.query('UPDATE promo SET sudah_digunakan=sudah_digunakan+1 WHERE id=?', [promo_id]);
    res.json({success:true});
  } catch(e) { res.json({success:true}); /* non-critical */ }
});

function filterByScope(items, promo) {
  if (promo.scope === 'semua') return items;
  if (promo.scope === 'kategori' && promo.scope_kategori) {
    return items.filter(i => i.kategori === promo.scope_kategori);
  }
  if (promo.scope === 'produk' && promo.scope_produk_ids) {
    const ids = typeof promo.scope_produk_ids === 'string' ? JSON.parse(promo.scope_produk_ids) : promo.scope_produk_ids;
    return items.filter(i => ids.includes(i.produk_id));
  }
  return items;
}

module.exports = router;
