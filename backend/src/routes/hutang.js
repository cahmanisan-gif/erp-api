const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const WRITE_ROLES = ['owner','manajer','head_operational','admin_pusat','finance'];

// Upload bukti pembayaran
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/var/www/rajavavapor/uploads/hutang';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g,'_');
    cb(null, Date.now()+'-'+safeName);
  }
});
const ALLOWED_EXT = ['.pdf','.jpg','.jpeg','.png','.gif','.webp'];
const upload = multer({
  storage, limits:{fileSize:5*1024*1024},
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Tipe file tidak diizinkan.'));
  }
});

// ═══ GET /api/hutang/summary — dashboard stats ═══
router.get('/summary', auth(), async (req,res) => {
  try {
    const {cabang_id} = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (cabang_id) { where+=' AND h.cabang_id=?'; params.push(cabang_id); }

    // Total hutang belum lunas
    const [[totals]] = await db.query(`
      SELECT
        COUNT(*) as total_record,
        COALESCE(SUM(h.total),0) as total_hutang,
        COALESCE(SUM(h.terbayar),0) as total_terbayar,
        COALESCE(SUM(h.total - h.terbayar),0) as total_sisa
      FROM hutang_supplier h ${where} AND h.status='belum_lunas'`, params);

    // Jatuh tempo 7 hari ke depan
    const paramJt = [...params];
    const [[jatuhTempo]] = await db.query(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(h.total - h.terbayar),0) as nominal
      FROM hutang_supplier h ${where} AND h.status='belum_lunas'
        AND h.jatuh_tempo IS NOT NULL AND h.jatuh_tempo BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)`, paramJt);

    // Overdue
    const paramOd = [...params];
    const [[overdue]] = await db.query(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(h.total - h.terbayar),0) as nominal
      FROM hutang_supplier h ${where} AND h.status='belum_lunas'
        AND h.jatuh_tempo IS NOT NULL AND h.jatuh_tempo < CURDATE()`, paramOd);

    // Per supplier (top 10)
    const paramSup = [...params];
    const [perSupplier] = await db.query(`
      SELECT h.supplier_id, h.nama_supplier,
        COUNT(*) as jumlah_hutang,
        COALESCE(SUM(h.total - h.terbayar),0) as sisa_hutang
      FROM hutang_supplier h ${where} AND h.status='belum_lunas'
      GROUP BY h.supplier_id, h.nama_supplier
      ORDER BY sisa_hutang DESC LIMIT 10`, paramSup);

    res.json({success:true, data:{
      total_record:   totals.total_record,
      total_hutang:   parseFloat(totals.total_hutang),
      total_terbayar: parseFloat(totals.total_terbayar),
      total_sisa:     parseFloat(totals.total_sisa),
      jatuh_tempo:    {count: jatuhTempo.cnt, nominal: parseFloat(jatuhTempo.nominal)},
      overdue:        {count: overdue.cnt,     nominal: parseFloat(overdue.nominal)},
      per_supplier:   perSupplier
    }});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ GET /api/hutang/aging — aging report ═══
router.get('/aging', auth(), async (req,res) => {
  try {
    const {cabang_id} = req.query;
    let where = 'WHERE h.status=\'belum_lunas\' AND h.jatuh_tempo IS NOT NULL';
    const params = [];
    if (cabang_id) { where+=' AND h.cabang_id=?'; params.push(cabang_id); }

    const [rows] = await db.query(`
      SELECT
        CASE
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 0  THEN 'belum_jatuh_tempo'
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 30  THEN '1-30'
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 60  THEN '31-60'
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 90  THEN '61-90'
          ELSE '90+'
        END as bucket,
        COUNT(*) as jumlah,
        COALESCE(SUM(h.total - h.terbayar),0) as nominal
      FROM hutang_supplier h ${where}
      GROUP BY bucket
      ORDER BY FIELD(bucket, 'belum_jatuh_tempo', '1-30', '31-60', '61-90', '90+')`, params);

    // Also return detail per bucket
    const [detail] = await db.query(`
      SELECT h.id, h.nama_supplier, h.total, h.terbayar, (h.total - h.terbayar) as sisa,
        h.jatuh_tempo, DATEDIFF(CURDATE(), h.jatuh_tempo) as hari_lewat,
        CASE
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 0  THEN 'belum_jatuh_tempo'
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 30  THEN '1-30'
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 60  THEN '31-60'
          WHEN DATEDIFF(CURDATE(), h.jatuh_tempo) <= 90  THEN '61-90'
          ELSE '90+'
        END as bucket,
        c.nama as nama_cabang
      FROM hutang_supplier h
      LEFT JOIN cabang c ON c.id=h.cabang_id
      ${where}
      ORDER BY h.jatuh_tempo ASC`, params);

    res.json({success:true, data:{buckets: rows, detail}});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ GET /api/hutang — list all hutang ═══
router.get('/', auth(), async (req,res) => {
  try {
    const {supplier_id, status, cabang_id, dari, sampai} = req.query;
    let q = `SELECT h.*, c.nama as nama_cabang, pb.nomor as nomor_pembelian
             FROM hutang_supplier h
             LEFT JOIN cabang c ON c.id=h.cabang_id
             LEFT JOIN pembelian_barang pb ON pb.id=h.pembelian_id
             WHERE 1=1`;
    const params = [];
    if (supplier_id) { q+=' AND h.supplier_id=?';     params.push(supplier_id); }
    if (status)      { q+=' AND h.status=?';           params.push(status); }
    if (cabang_id)   { q+=' AND h.cabang_id=?';        params.push(cabang_id); }
    if (dari)        { q+=' AND h.created_at>=?';       params.push(dari+' 00:00:00'); }
    if (sampai)      { q+=' AND h.created_at<=?';       params.push(sampai+' 23:59:59'); }
    q += ' ORDER BY h.status ASC, h.jatuh_tempo ASC, h.created_at DESC LIMIT 500';
    const [rows] = await db.query(q, params);
    res.json({success:true, data:rows});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ GET /api/hutang/:id — detail hutang + pembayaran ═══
router.get('/:id', auth(), async (req,res) => {
  try {
    const [[row]] = await db.query(`
      SELECT h.*, c.nama as nama_cabang, pb.nomor as nomor_pembelian,
             s.nama as supplier_nama_full, s.pic, s.no_hp as supplier_hp
      FROM hutang_supplier h
      LEFT JOIN cabang c ON c.id=h.cabang_id
      LEFT JOIN pembelian_barang pb ON pb.id=h.pembelian_id
      LEFT JOIN supplier s ON s.id=h.supplier_id
      WHERE h.id=?`, [req.params.id]);
    if (!row) return res.status(404).json({success:false,message:'Hutang tidak ditemukan.'});

    const [pembayaran] = await db.query(`
      SELECT hp.*, u.nama_lengkap as nama_user, ka.nama_akun, ka.nama_bank
      FROM hutang_supplier_pembayaran hp
      LEFT JOIN users u ON u.id=hp.created_by
      LEFT JOIN kas_akun ka ON ka.id=hp.kas_akun_id
      WHERE hp.hutang_id=?
      ORDER BY hp.tanggal DESC, hp.id DESC`, [req.params.id]);

    res.json({success:true, data:{...row, pembayaran}});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ POST /api/hutang — create hutang manual ═══
router.post('/', auth(WRITE_ROLES), async (req,res) => {
  try {
    const {supplier_id, pembelian_id, cabang_id, nama_supplier, keterangan, total, jatuh_tempo} = req.body;
    if (!nama_supplier || !total) return res.status(400).json({success:false,message:'Nama supplier dan total wajib diisi.'});

    const [ins] = await db.query(`INSERT INTO hutang_supplier
      (supplier_id, pembelian_id, cabang_id, nama_supplier, keterangan, total, jatuh_tempo, created_by)
      VALUES (?,?,?,?,?,?,?,?)`,
      [supplier_id||null, pembelian_id||null, cabang_id||null, nama_supplier, keterangan||null,
       parseFloat(total), jatuh_tempo||null, req.user.id]);

    audit(req, 'create', 'hutang_supplier', ins.insertId, nama_supplier, {total, supplier_id, cabang_id});
    res.json({success:true, message:'Hutang supplier ditambahkan.', id:ins.insertId});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ PATCH /api/hutang/:id — edit hutang ═══
router.patch('/:id', auth(WRITE_ROLES), async (req,res) => {
  try {
    const {supplier_id, cabang_id, nama_supplier, keterangan, total, jatuh_tempo} = req.body;
    await db.query(`UPDATE hutang_supplier SET supplier_id=?, cabang_id=?, nama_supplier=?,
      keterangan=?, total=?, jatuh_tempo=? WHERE id=?`,
      [supplier_id||null, cabang_id||null, nama_supplier, keterangan||null,
       parseFloat(total), jatuh_tempo||null, req.params.id]);

    // Recalculate status
    const [[h]] = await db.query(`SELECT h.total, COALESCE(SUM(hp.jumlah),0) as ttl_bayar
      FROM hutang_supplier h LEFT JOIN hutang_supplier_pembayaran hp ON hp.hutang_id=h.id
      WHERE h.id=? GROUP BY h.id, h.total`, [req.params.id]);
    if (h) {
      const terbayar = parseFloat(h.ttl_bayar||0);
      const status = terbayar >= parseFloat(h.total) ? 'lunas' : 'belum_lunas';
      await db.query('UPDATE hutang_supplier SET terbayar=?,status=? WHERE id=?',[terbayar,status,req.params.id]);
    }

    audit(req, 'update', 'hutang_supplier', req.params.id, nama_supplier, {total, supplier_id, cabang_id});
    res.json({success:true, message:'Hutang diupdate.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ DELETE /api/hutang/:id — delete hutang (owner only) ═══
router.delete('/:id', auth(['owner']), async (req,res) => {
  try {
    const [[h]] = await db.query('SELECT nama_supplier,total FROM hutang_supplier WHERE id=?',[req.params.id]);
    if (!h) return res.status(404).json({success:false,message:'Hutang tidak ditemukan.'});
    await db.query('DELETE FROM hutang_supplier WHERE id=?',[req.params.id]);
    audit(req, 'delete', 'hutang_supplier', req.params.id, h.nama_supplier, {total:h.total});
    res.json({success:true, message:'Hutang dihapus.'});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ GET /api/hutang/:id/pembayaran — list pembayaran ═══
router.get('/:id/pembayaran', auth(), async (req,res) => {
  try {
    const [rows] = await db.query(`
      SELECT hp.*, u.nama_lengkap as nama_user, ka.nama_akun, ka.nama_bank
      FROM hutang_supplier_pembayaran hp
      LEFT JOIN users u ON u.id=hp.created_by
      LEFT JOIN kas_akun ka ON ka.id=hp.kas_akun_id
      WHERE hp.hutang_id=?
      ORDER BY hp.tanggal DESC, hp.id DESC`, [req.params.id]);
    res.json({success:true, data:rows});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});

// ═══ POST /api/hutang/:id/pembayaran — add pembayaran ═══
router.post('/:id/pembayaran', auth(WRITE_ROLES), upload.single('bukti'), async (req,res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[hutang]] = await conn.query('SELECT * FROM hutang_supplier WHERE id=?',[req.params.id]);
    if (!hutang) { await conn.rollback(); return res.status(404).json({success:false,message:'Hutang tidak ditemukan.'}); }
    if (hutang.status==='lunas') { await conn.rollback(); return res.status(400).json({success:false,message:'Hutang sudah lunas.'}); }

    const {jumlah, tanggal, metode, kas_akun_id, catatan} = req.body;
    if (!jumlah || parseFloat(jumlah)<=0) { await conn.rollback(); return res.status(400).json({success:false,message:'Jumlah pembayaran wajib > 0.'}); }

    const buktiUrl = req.file ? '/uploads/hutang/'+req.file.filename : null;

    await conn.query(`INSERT INTO hutang_supplier_pembayaran
      (hutang_id, jumlah, tanggal, metode, kas_akun_id, bukti_url, catatan, created_by)
      VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, parseFloat(jumlah), tanggal||new Date().toISOString().slice(0,10),
       metode||'cash', kas_akun_id||null, buktiUrl, catatan||null, req.user.id]);

    // Recalculate terbayar & status
    const [[calc]] = await conn.query(`SELECT h.total, COALESCE(SUM(hp.jumlah),0) as ttl_bayar
      FROM hutang_supplier h LEFT JOIN hutang_supplier_pembayaran hp ON hp.hutang_id=h.id
      WHERE h.id=? GROUP BY h.id, h.total`, [req.params.id]);
    const terbayar = parseFloat(calc.ttl_bayar||0);
    const status = terbayar >= parseFloat(calc.total) ? 'lunas' : 'belum_lunas';
    await conn.query('UPDATE hutang_supplier SET terbayar=?,status=? WHERE id=?',[terbayar,status,req.params.id]);

    // Optionally create kas_mutasi if kas_akun_id provided
    if (kas_akun_id) {
      const tgl = tanggal || new Date().toISOString().slice(0,10);
      await conn.query(`INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by)
        VALUES (?,?,'keluar',?,?,?)`,
        [kas_akun_id, tgl, parseFloat(jumlah),
         `Bayar hutang supplier: ${hutang.nama_supplier}`, req.user.id]).catch(e=>console.error('kas_mutasi hutang:',e.message));
    }

    await conn.commit();
    audit(req, 'create', 'hutang_pembayaran', req.params.id, hutang.nama_supplier, {jumlah, metode, kas_akun_id});
    res.json({success:true, message:'Pembayaran disimpan.', status});
  } catch(e){ await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

// ═══ DELETE /api/hutang/pembayaran/:id — delete pembayaran (owner only) ═══
router.delete('/pembayaran/:id', auth(['owner']), async (req,res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[bp]] = await conn.query('SELECT * FROM hutang_supplier_pembayaran WHERE id=?',[req.params.id]);
    if (!bp) { await conn.rollback(); return res.status(404).json({success:false,message:'Pembayaran tidak ditemukan.'}); }

    await conn.query('DELETE FROM hutang_supplier_pembayaran WHERE id=?',[req.params.id]);

    // Recalculate terbayar & status
    const [[calc]] = await conn.query(`SELECT h.total, COALESCE(SUM(hp.jumlah),0) as ttl_bayar
      FROM hutang_supplier h LEFT JOIN hutang_supplier_pembayaran hp ON hp.hutang_id=h.id
      WHERE h.id=? GROUP BY h.id, h.total`, [bp.hutang_id]);
    if (calc) {
      const terbayar = parseFloat(calc.ttl_bayar||0);
      const status = terbayar >= parseFloat(calc.total||0) ? 'lunas' : 'belum_lunas';
      await conn.query('UPDATE hutang_supplier SET terbayar=?,status=? WHERE id=?',[terbayar,status,bp.hutang_id]);
    }

    await conn.commit();
    audit(req, 'delete', 'hutang_pembayaran', req.params.id, `hutang_id:${bp.hutang_id}`, {jumlah:bp.jumlah});
    res.json({success:true, message:'Pembayaran dihapus.'});
  } catch(e){ await conn.rollback(); res.status(500).json({success:false,message:e.message}); }
  finally { conn.release(); }
});

module.exports = router;
