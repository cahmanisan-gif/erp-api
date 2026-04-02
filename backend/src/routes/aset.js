const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const ROLES = ['owner','admin_pusat','manajer','head_operational'];
const TARIF = { 1:0.25, 2:0.125, 3:0.0625 };
const UMUR  = { 1:4,    2:8,     3:16 };

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads','aset');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'aset-'+Date.now()+path.extname(file.originalname))
});
const ALLOWED_ASET_EXT = ['.jpg','.jpeg','.png','.gif','.webp','.pdf'];
const upload      = multer({
  storage, limits:{ fileSize:10*1024*1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_ASET_EXT.includes(ext)) cb(null, true);
    else cb(new Error('Tipe file tidak diizinkan.'));
  }
});
const uploadFields = upload.fields([{ name:'foto', maxCount:1 },{ name:'invoice', maxCount:1 }]);

function hitungDepresiasi(nilai_perolehan, kelompok, tgl_perolehan) {
  const tarif      = TARIF[kelompok]||0.125;
  const umur       = UMUR[kelompok]||8;
  const tglAwal    = new Date(tgl_perolehan);
  const now        = new Date();
  const tahunJalan = now.getFullYear() - tglAwal.getFullYear();
  const depPerTahun= nilai_perolehan * tarif;
  const totalDep   = Math.min(depPerTahun * tahunJalan, nilai_perolehan);
  const nilai_sisa = Math.max(0, nilai_perolehan - totalDep);
  const pctTerpakai= Math.min(100, Math.round((tahunJalan/umur)*100));
  const tgl_habis  = new Date(tglAwal); tgl_habis.setFullYear(tglAwal.getFullYear()+umur);
  const sisa_hari  = Math.ceil((tgl_habis-now)/(1000*60*60*24));
  const tabel = [];
  let nilaiAwal = nilai_perolehan;
  for (let i=0; i<umur; i++) {
    const nilaiAkhir = Math.max(0, nilaiAwal - depPerTahun);
    tabel.push({ tahun:tglAwal.getFullYear()+i, nilai_awal:nilaiAwal, depresiasi:depPerTahun, nilai_akhir:nilaiAkhir });
    nilaiAwal = nilaiAkhir;
    if (nilaiAkhir<=0) break;
  }
  return { tarif, umur, depPerTahun, totalDep, nilai_sisa, pctTerpakai, tgl_habis:tgl_habis.toISOString().slice(0,10), sisa_hari, tahunJalan, tabel };
}

async function getCabangAkses(user) {
  if (user.role==='owner'||user.role==='admin_pusat') return null;
  const [mc] = await db.query('SELECT cabang_id FROM manajer_cabang WHERE user_id=?',[user.id]);
  const ids  = mc.map(r=>r.cabang_id);
  if (user.cabang_id) ids.push(user.cabang_id);
  return ids;
}

router.get('/', auth(ROLES), async (req, res) => {
  try {
    let where = 'WHERE a.aktif=1';
    const params = [];
    const ids = await getCabangAkses(req.user);
    if (ids) {
      if (ids.length) { where += ` AND a.cabang_id IN (${ids.map(()=>'?').join(',')})`; params.push(...ids); }
      else { where += ' AND 1=0'; }
    }
    if (req.query.cabang_id) { where += ' AND a.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }
    if (req.query.kategori)  { where += ' AND a.kategori=?'; params.push(req.query.kategori); }
    if (req.query.kondisi)   { where += ' AND a.kondisi=?'; params.push(req.query.kondisi); }
    const [rows] = await db.query(
      `SELECT a.*, c.nama as nama_cabang, c.kode as kode_cabang
       FROM aset_cabang a JOIN cabang c ON a.cabang_id=c.id
       ${where} ORDER BY FIELD(a.kondisi,'rusak_total','rusak_sebagian','perlu_perawatan','baik','sudah_diganti'), a.tgl_peremajaan ASC`, params
    );
    rows.forEach(r => { r.kalkulasi = hitungDepresiasi(parseFloat(r.nilai_perolehan), r.kelompok_djp, r.tgl_perolehan); });
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.get('/reminder', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT a.*, c.nama as nama_cabang FROM aset_cabang a JOIN cabang c ON a.cabang_id=c.id
       WHERE a.aktif=1 AND (a.kondisi IN ('perlu_perawatan','rusak_sebagian','rusak_total')
       OR (a.tgl_peremajaan IS NOT NULL AND a.tgl_peremajaan <= DATE_ADD(CURDATE(), INTERVAL 60 DAY)))
       ORDER BY FIELD(a.kondisi,'rusak_total','rusak_sebagian','perlu_perawatan','baik'), a.tgl_peremajaan ASC LIMIT 20`
    );
    rows.forEach(r => { r.kalkulasi = hitungDepresiasi(parseFloat(r.nilai_perolehan), r.kelompok_djp, r.tgl_perolehan); });
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(ROLES), uploadFields, async (req, res) => {
  try {
    const { cabang_id, nama_aset, kategori, kelompok_djp, tgl_perolehan, nilai_perolehan, kondisi, diasuransikan, tgl_peremajaan, catatan } = req.body;
    if (!cabang_id||!nama_aset||!kategori||!tgl_perolehan||!nilai_perolehan)
      return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    const klp       = parseInt(kelompok_djp)||2;
    const foto_url  = req.files?.foto?.[0]    ? 'aset/'+req.files.foto[0].filename    : null;
    const invoice_url = req.files?.invoice?.[0] ? 'aset/'+req.files.invoice[0].filename : null;
    const calc      = hitungDepresiasi(parseFloat(nilai_perolehan), klp, tgl_perolehan);
    const [result]  = await db.query(
      'INSERT INTO aset_cabang (cabang_id,nama_aset,kategori,kelompok_djp,tgl_perolehan,nilai_perolehan,nilai_sisa,umur_ekonomis,kondisi,diasuransikan,tgl_peremajaan,foto_url,invoice_url,catatan,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [cabang_id, nama_aset, kategori, klp, tgl_perolehan, parseFloat(nilai_perolehan), calc.nilai_sisa, UMUR[klp]||8, kondisi||'baik', diasuransikan?1:0, tgl_peremajaan||null, foto_url, invoice_url||null, catatan||'', req.user.id]
    );
    // Catat ke pengeluaran otomatis
    const [kat] = await db.query("SELECT id FROM pengeluaran_kategori WHERE nama='Pembelian Aset' LIMIT 1");
    if (kat.length) {
      await db.query(
        'INSERT INTO pengeluaran (cabang_id,kategori_id,tanggal,nominal,keterangan,aset_id,created_by) VALUES (?,?,?,?,?,?,?)',
        [cabang_id, kat[0].id, tgl_perolehan, parseFloat(nilai_perolehan), `Pembelian aset: ${nama_aset}`, result.insertId, req.user.id]
      );
    }
    res.json({ success:true, message:'Aset berhasil ditambahkan.', id:result.insertId });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.patch('/:id', auth(ROLES), uploadFields, async (req, res) => {
  try {
    const { nama_aset, kategori, kelompok_djp, tgl_perolehan, nilai_perolehan, kondisi, diasuransikan, tgl_peremajaan, catatan } = req.body;
    const [[old]] = await db.query('SELECT * FROM aset_cabang WHERE id=?', [req.params.id]);
    if (!old) return res.status(404).json({ success:false, message:'Aset tidak ditemukan.' });
    let foto_url    = old.foto_url    || null;
    let invoice_url = old.invoice_url || null;
    if (req.files?.foto?.[0]) {
      if (foto_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',foto_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
      foto_url = 'aset/'+req.files.foto[0].filename;
    }
    if (req.files?.invoice?.[0]) {
      if (invoice_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',invoice_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
      invoice_url = 'aset/'+req.files.invoice[0].filename;
    }
    const klp  = parseInt(kelompok_djp)||2;
    const calc = hitungDepresiasi(parseFloat(nilai_perolehan), klp, tgl_perolehan);
    // Jika kondisi berubah jadi rusak_total → catat pengeluaran kerugian
    if (kondisi==='rusak_total' && old.kondisi!=='rusak_total') {
      const [kat] = await db.query("SELECT id FROM pengeluaran_kategori WHERE nama='Kerugian Pelepasan Aset' LIMIT 1");
      if (kat.length && calc.nilai_sisa > 0) {
        await db.query(
          'INSERT INTO pengeluaran (cabang_id,kategori_id,tanggal,nominal,keterangan,aset_id,created_by) VALUES (?,?,CURDATE(),?,?,?,?)',
          [old.cabang_id, kat[0].id, calc.nilai_sisa, `Kerugian pelepasan aset: ${old.nama_aset}`, req.params.id, req.user.id]
        );
      }
    }
    await db.query(
      'UPDATE aset_cabang SET nama_aset=?,kategori=?,kelompok_djp=?,tgl_perolehan=?,nilai_perolehan=?,nilai_sisa=?,umur_ekonomis=?,kondisi=?,diasuransikan=?,tgl_peremajaan=?,foto_url=?,invoice_url=?,catatan=? WHERE id=?',
      [nama_aset, kategori, klp, tgl_perolehan, parseFloat(nilai_perolehan), calc.nilai_sisa, UMUR[klp]||8, kondisi||'baik', diasuransikan?1:0, tgl_peremajaan||null, foto_url, invoice_url, catatan||'', req.params.id]
    );
    res.json({ success:true, message:'Aset berhasil diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT foto_url,invoice_url FROM aset_cabang WHERE id=?', [req.params.id]);
    if (row?.foto_url)    { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',row.foto_url);    if(fs.existsSync(fp)) fs.unlinkSync(fp); }
    if (row?.invoice_url) { const fp=path.join(process.env.UPLOAD_PATH||'/var/www/rajavavapor/uploads',row.invoice_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
    await db.query('UPDATE aset_cabang SET aktif=0 WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
