const express  = require('express');
const router   = express.Router();
const db       = require('../config/database');
const auth     = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/var/www/rajavavapor/uploads/pembelian';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, Date.now()+'-'+safeName);
  }
});
const ALLOWED_PB_EXT = ['.pdf','.jpg','.jpeg','.png','.gif','.webp'];
const upload = multer({
  storage, limits:{fileSize:10*1024*1024},
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_PB_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Tipe file tidak diizinkan.'));
  }
});

// Generate nomor pembelian
async function genNomor() {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth()+1).padStart(2,'0');
  const [[row]] = await db.query("SELECT COUNT(*) as c FROM pembelian_barang WHERE nomor LIKE ?", [`PB-${y}${m}-%`]);
  const n = String((row.c||0)+1).padStart(4,'0');
  return `PB-${y}${m}-${n}`;
}

// GET semua pembelian
router.get('/', auth(), async (req,res) => {
  try {
    const {cabang_id, status, dari, sampai} = req.query;
    let q = `SELECT p.*, c.nama as nama_cabang, u.nama_lengkap as nama_user
             FROM pembelian_barang p
             LEFT JOIN cabang c ON c.id=p.cabang_id
             LEFT JOIN users u ON u.id=p.created_by
             WHERE 1=1`;
    const params = [];
    if (cabang_id) { q+=' AND p.cabang_id=?'; params.push(cabang_id); }
    if (status)    { q+=' AND p.status=?';    params.push(status); }
    if (dari)      { q+=' AND p.tanggal>=?';  params.push(dari); }
    if (sampai)    { q+=' AND p.tanggal<=?';  params.push(sampai); }
    if (req.query.nomor) { q+=' AND p.nomor=?'; params.push(req.query.nomor); }
    q += ' ORDER BY p.created_at DESC LIMIT 200';
    const [rows] = await db.query(q, params);
    res.json({success:true, data:rows});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// GET satu pembelian + items
router.get('/:id', auth(), async (req,res) => {
  try {
    const [[pb]] = await db.query(`SELECT p.*, c.nama as nama_cabang FROM pembelian_barang p LEFT JOIN cabang c ON c.id=p.cabang_id WHERE p.id=?`, [req.params.id]);
    if (!pb) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    const [items] = await db.query('SELECT * FROM pembelian_barang_item WHERE pembelian_id=?', [req.params.id]);
    res.json({success:true, data:{...pb, items}});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// POST buat pembelian baru (draft)
router.post('/', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {nama_supplier, supplier_id, cabang_id, tanggal, items, biaya_ongkir, biaya_lainnya, catatan} = req.body;
    if (!nama_supplier || !cabang_id || !items?.length)
      return res.status(400).json({success:false,message:'Supplier, cabang, dan items wajib.'});

    const nomor    = await genNomor();
    const subtotal = items.reduce((s,i)=>s+(i.qty*i.harga_modal),0);
    const ongkir   = parseFloat(biaya_ongkir)||0;
    const lainnya  = parseFloat(biaya_lainnya)||0;
    const total    = subtotal + ongkir + lainnya;

    const kas_akun_id       = req.body.kas_akun_id       || null;
    const kas_akun_id_ongkir = req.body.kas_akun_id_ongkir || null;
    const kas_akun_id_lain   = req.body.kas_akun_id_lain   || null;
    const [ins] = await conn.query(`INSERT INTO pembelian_barang
      (nomor,supplier_id,nama_supplier,cabang_id,tanggal,subtotal,biaya_ongkir,biaya_lainnya,total,catatan,kas_akun_id,kas_akun_id_ongkir,kas_akun_id_lain,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [nomor, supplier_id||null, nama_supplier, cabang_id, tanggal||new Date().toISOString().slice(0,10),
       subtotal, ongkir, lainnya, total, catatan||null, kas_akun_id, kas_akun_id_ongkir, kas_akun_id_lain, req.user.id]);
    const pbId = ins.insertId;

    for (const item of items) {
      await conn.query(`INSERT INTO pembelian_barang_item (pembelian_id,produk_id,nama_barang,qty,harga_modal,harga_jual)
        VALUES (?,?,?,?,?,?)`,
        [pbId, item.produk_id||null, item.nama_barang, item.qty, item.harga_modal||0, item.harga_jual||0]);
    }
    await conn.commit();
    res.json({success:true, message:'Draft pembelian dibuat.', id:pbId, nomor});
  } catch(e){ await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// PATCH update draft
router.patch('/:id', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[pb]] = await conn.query('SELECT * FROM pembelian_barang WHERE id=?',[req.params.id]);
    if (!pb) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    if (pb.status === 'diterima') return res.status(400).json({success:false,message:'Pembelian sudah diterima, tidak bisa diedit.'});

    const {nama_supplier,supplier_id,cabang_id,tanggal,items,biaya_ongkir,biaya_lainnya,catatan} = req.body;
    const subtotal = (items||[]).reduce((s,i)=>s+(i.qty*i.harga_modal),0);
    const ongkir   = parseFloat(biaya_ongkir)||0;
    const lainnya  = parseFloat(biaya_lainnya)||0;
    const total    = subtotal + ongkir + lainnya;

    const kas_akun_id2        = req.body.kas_akun_id        || null;
    const kas_akun_id_ongkir2 = req.body.kas_akun_id_ongkir || null;
    const kas_akun_id_lain2   = req.body.kas_akun_id_lain   || null;
    await conn.query(`UPDATE pembelian_barang SET nama_supplier=?,supplier_id=?,cabang_id=?,tanggal=?,
      subtotal=?,biaya_ongkir=?,biaya_lainnya=?,total=?,catatan=?,kas_akun_id=?,kas_akun_id_ongkir=?,kas_akun_id_lain=? WHERE id=?`,
      [nama_supplier,supplier_id||null,cabang_id,tanggal,subtotal,ongkir,lainnya,total,catatan||null,
       kas_akun_id2,kas_akun_id_ongkir2,kas_akun_id_lain2,req.params.id]);

    if (items?.length) {
      await conn.query('DELETE FROM pembelian_barang_item WHERE pembelian_id=?',[req.params.id]);
      for (const item of items) {
        await conn.query(`INSERT INTO pembelian_barang_item (pembelian_id,produk_id,nama_barang,qty,harga_modal,harga_jual)
          VALUES (?,?,?,?,?,?)`,
          [req.params.id,item.produk_id||null,item.nama_barang,item.qty,item.harga_modal||0,item.harga_jual||0]);
      }
    }
    await conn.commit();
    res.json({success:true,message:'Draft diupdate.'});
  } catch(e){ await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// POST terima pembelian — stok masuk + pengeluaran + arsip
router.post('/:id/terima', auth(['owner','manajer','head_operational','admin_pusat']), async (req,res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[pb]] = await conn.query('SELECT * FROM pembelian_barang WHERE id=?',[req.params.id]);
    if (!pb) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    if (pb.status === 'diterima') return res.status(400).json({success:false,message:'Sudah diterima.'});

    const [items] = await conn.query('SELECT * FROM pembelian_barang_item WHERE pembelian_id=?',[req.params.id]);

    // 1. Masukkan stok + log
    for (const item of items) {
      let produkId = item.produk_id || null;

      // Jika tidak ada produk_id, cari berdasarkan nama (restock / produk existing)
      if (!produkId && item.nama_barang) {
        // Cari by SKU dulu (lebih akurat), fallback ke nama
        const skuToSearch = item.sku || null;
        let [[found]] = skuToSearch
          ? await conn.query("SELECT id,nama FROM pos_produk WHERE LOWER(sku)=LOWER(?) LIMIT 1", [skuToSearch.trim()])
          : [[null]];
        if (!found) {
          [[found]] = await conn.query("SELECT id,nama FROM pos_produk WHERE LOWER(nama)=LOWER(?) LIMIT 1", [item.nama_barang.trim()]);
        }
        if (found) {
          produkId = found.id;
          // Update produk_id di item
          await conn.query('UPDATE pembelian_barang_item SET produk_id=? WHERE id=?',
            [produkId, item.id]);
        } else {
          // Buat produk baru otomatis
          const skuNew = (item.sku && item.sku.trim()) ? item.sku.trim() : ('PB-' + Date.now().toString().slice(-6));
          const [ins] = await conn.query(
            `INSERT INTO pos_produk (sku, nama, harga_modal, harga_jual, satuan, aktif)
             VALUES (?, ?, ?, ?, 'pcs', 1)`,
            [skuNew, item.nama_barang.trim(), item.harga_modal || 0, item.harga_jual || 0]
          );
          produkId = ins.insertId;
          await conn.query('UPDATE pembelian_barang_item SET produk_id=? WHERE id=?',
            [produkId, item.id]);
        }
      }

      if (!produkId) continue;

      // Tambah stok (ON DUPLICATE KEY = restock otomatis)
      await conn.query(`INSERT INTO pos_stok (produk_id, cabang_id, qty)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE qty = qty + ?`,
        [produkId, pb.cabang_id, item.qty, item.qty]);

      // Update harga di master produk
      if (item.harga_modal > 0)
        await conn.query('UPDATE pos_produk SET harga_modal=? WHERE id=?',
          [item.harga_modal, produkId]);
      if (item.harga_jual > 0)
        await conn.query('UPDATE pos_produk SET harga_jual=? WHERE id=?',
          [item.harga_jual, produkId]);

      // Log stok
      await conn.query(`INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id)
        VALUES (?, ?, 'pembelian', ?, ?, ?)`,
        [produkId, pb.cabang_id, item.qty, 'Pembelian ' + pb.nomor, req.user.id]).catch(() => {});
    }

    // 2. Catat pengeluaran dengan struktur kolom yang benar
    const tglNow = pb.tanggal || new Date().toISOString().slice(0,10);
    // Ambil kategori_id
    const [[katPB]]  = await conn.query("SELECT id FROM pengeluaran_kategori WHERE nama='Pembelian Barang' LIMIT 1");
    const [[katOng]] = await conn.query("SELECT id FROM pengeluaran_kategori WHERE nama='Ongkir' LIMIT 1");
    const [[katLain]]= await conn.query("SELECT id FROM pengeluaran_kategori WHERE nama='Biaya Lainnya' LIMIT 1");

    if (pb.subtotal > 0 && katPB) {
      await conn.query(`INSERT INTO pengeluaran (cabang_id,kategori_id,user_id,tanggal,nominal,keterangan,status)
        VALUES (?,?,?,?,?,'Pembelian ${pb.nomor} - ${pb.nama_supplier}','approved')`,
        [pb.cabang_id, katPB.id, req.user.id, tglNow, pb.subtotal]).catch(e=>console.error('pengeluaran PB:',e.message));
    }
    if (pb.biaya_ongkir > 0 && katOng) {
      await conn.query(`INSERT INTO pengeluaran (cabang_id,kategori_id,user_id,tanggal,nominal,keterangan,status)
        VALUES (?,?,?,?,?,?,'approved')`,
        [pb.cabang_id, katOng.id, req.user.id, tglNow, pb.biaya_ongkir, `Ongkir Pembelian ${pb.nomor}`]).catch(e=>console.error('pengeluaran ongkir:',e.message));
    }
    if (pb.biaya_lainnya > 0 && katLain) {
      await conn.query(`INSERT INTO pengeluaran (cabang_id,kategori_id,user_id,tanggal,nominal,keterangan,status)
        VALUES (?,?,?,?,?,?,'approved')`,
        [pb.cabang_id, katLain.id, req.user.id, tglNow, pb.biaya_lainnya, `Biaya Lainnya Pembelian ${pb.nomor}`]).catch(e=>console.error('pengeluaran lain:',e.message));
    }

    // 2b. Catat mutasi kas per sumber dana
    if (pb.kas_akun_id && pb.subtotal > 0) {
      await conn.query(`INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by)
        VALUES (?,?,'keluar',?,?,?)`,
        [pb.kas_akun_id, tglNow, pb.subtotal, `Pembelian ${pb.nomor} - ${pb.nama_supplier}`, req.user.id]).catch(e=>console.error('kas_mutasi invoice:',e.message));
    }
    if (pb.kas_akun_id_ongkir && pb.biaya_ongkir > 0) {
      await conn.query(`INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by)
        VALUES (?,?,'keluar',?,?,?)`,
        [pb.kas_akun_id_ongkir, tglNow, pb.biaya_ongkir, `Ongkir Pembelian ${pb.nomor}`, req.user.id]).catch(e=>console.error('kas_mutasi ongkir:',e.message));
    }
    if (pb.kas_akun_id_lain && pb.biaya_lainnya > 0) {
      await conn.query(`INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by)
        VALUES (?,?,'keluar',?,?,?)`,
        [pb.kas_akun_id_lain, tglNow, pb.biaya_lainnya, `Biaya Lainnya Pembelian ${pb.nomor}`, req.user.id]).catch(e=>console.error('kas_mutasi lain:',e.message));
    }

    // 3. Update status
    await conn.query("UPDATE pembelian_barang SET status='diterima' WHERE id=?", [req.params.id]);

    await conn.commit();
    audit(req, 'approve', 'pembelian', req.params.id, pb.nomor, {total:pb.total, supplier:pb.nama_supplier, cabang_id:pb.cabang_id});
    res.json({success:true, message:`Pembelian ${pb.nomor} diterima. Stok, pengeluaran otomatis tercatat.`});
  } catch(e){ await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// POST upload file (invoice / resi)
router.post('/:id/upload', auth(['owner','manajer','head_operational','admin_pusat']),
  upload.fields([{name:'invoice',maxCount:1},{name:'resi',maxCount:1}]),
  async (req,res) => {
    try {
      const updates = {};
      if (req.files?.invoice) updates.file_invoice = '/uploads/pembelian/'+req.files.invoice[0].filename;
      if (req.files?.resi)    updates.file_resi    = '/uploads/pembelian/'+req.files.resi[0].filename;
      if (!Object.keys(updates).length) return res.status(400).json({success:false,message:'Tidak ada file.'});
      const sets = Object.keys(updates).map(k=>k+'=?').join(',');
      await db.query(`UPDATE pembelian_barang SET ${sets} WHERE id=?`, [...Object.values(updates), req.params.id]);

      // Masukkan ke arsip
      for (const [type, url] of Object.entries(updates)) {
        const [[pb]] = await db.query('SELECT nomor,cabang_id,tanggal FROM pembelian_barang WHERE id=?',[req.params.id]);
        const namaFile = type==='file_invoice' ? `Invoice-${pb.nomor}` : `Resi-${pb.nomor}`;
        await db.query(`INSERT INTO arsip (cabang_id,tanggal,nama,tipe,url,keterangan,created_by) VALUES (?,?,?,?,?,?,?)`,
          [pb.cabang_id, pb.tanggal, namaFile, type==='file_invoice'?'Invoice':'Resi', url, `Pembelian ${pb.nomor}`, req.user.id]).catch(()=>{});
      }
      res.json({success:true, message:'File diupload.', ...updates});
    } catch(e){res.status(500).json({success:false,message:e.message});}
});

// DELETE hapus draft
router.delete('/:id', auth(['owner']), async (req,res) => {
  try {
    const [[pb]] = await db.query('SELECT status FROM pembelian_barang WHERE id=?',[req.params.id]);
    if (!pb) return res.status(404).json({success:false,message:'Tidak ditemukan.'});
    if (pb.status==='diterima') return res.status(400).json({success:false,message:'Tidak bisa hapus pembelian yang sudah diterima.'});
    await db.query('DELETE FROM pembelian_barang WHERE id=?',[req.params.id]);
    res.json({success:true,message:'Draft dihapus.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

module.exports = router;
