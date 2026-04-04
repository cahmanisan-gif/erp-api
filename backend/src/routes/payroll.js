const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { requireModule } = require('../middleware/moduleAccess');

// ── MASTER KARYAWAN PAYROLL ──
router.get('/karyawan', auth(), requireModule('payroll'), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payroll_karyawan WHERE aktif=1 ORDER BY nama');
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/karyawan', auth(), async (req, res) => {
  try {
    const { personnel_id, nama, nik, grup, jabatan, gaji_pokok, rate_lembur, rate_insentif_absensi, potongan_per_hari, tunjangan_jabatan, tunjangan_transport, bpjs_kes, bpjs_jht, catatan } = req.body;
    await db.query(
      `INSERT INTO payroll_karyawan (personnel_id,nama,nik,grup,jabatan,gaji_pokok,rate_lembur,rate_insentif_absensi,potongan_per_hari,tunjangan_jabatan,tunjangan_transport,bpjs_kes,bpjs_jht,catatan)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE nama=VALUES(nama),nik=VALUES(nik),grup=VALUES(grup),jabatan=VALUES(jabatan),
       gaji_pokok=VALUES(gaji_pokok),rate_lembur=VALUES(rate_lembur),rate_insentif_absensi=VALUES(rate_insentif_absensi),
       tunjangan_jabatan=VALUES(tunjangan_jabatan),tunjangan_transport=VALUES(tunjangan_transport),bpjs_kes=VALUES(bpjs_kes),bpjs_jht=VALUES(bpjs_jht),catatan=VALUES(catatan)`,
      [personnel_id,nama,nik||'',grup||'',jabatan||'',gaji_pokok||0,rate_lembur||0,rate_insentif_absensi||0,potongan_per_hari||0,tunjangan_jabatan||0,tunjangan_transport||0,bpjs_kes||0,bpjs_jht||0,catatan||'']
    );
    res.json({ success:true, message:'Data gaji disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── PAYROLL BULANAN ──
router.get('/', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const [rows] = await db.query('SELECT * FROM payroll WHERE bulan=? ORDER BY grup,nama', [bulan]);
    res.json({ success:true, data:rows, bulan });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Generate payroll dari data absensi + master gaji
router.post('/generate', auth(), async (req, res) => {
  try {
    const { bulan, data } = req.body; // data = array hasil rekap absensi + komponen
    if (!bulan || !data?.length) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });

    // Hitung hari kerja efektif bulan ini (total hari - jumlah minggu)
    const [y, m] = bulan.split('-').map(Number);
    const totalHari    = new Date(y, m, 0).getDate();
    const jumlahMinggu = Math.floor(totalHari / 7);
    const sisaHari     = totalHari % 7;
    const hariKerja    = totalHari - jumlahMinggu - (sisaHari > 0 ? 1 : 0);

    // Ambil insentif gudang bulan ini
    const [insentifGudang] = await db.query(
      "SELECT * FROM payroll_insentif_gudang WHERE bulan=? AND sudah_apply=0", [bulan]
    );
    const insentifMap = {};
    insentifGudang.forEach(i => { insentifMap[i.personnel_id] = i; });

    // Ambil kasbon aktif semua karyawan
    const [kasbonRows] = await db.query(
      "SELECT * FROM kasbon WHERE status='aktif' AND sisa > 0"
    );
    // Ambil bon barang bulan ini
    const [bonRows] = await db.query(
      "SELECT * FROM bon_barang WHERE bulan_potong=? AND status_bayar='belum'", [bulan]
    );
    // Ambil potongan stok bulan ini
    const [stokRows] = await db.query(
      "SELECT * FROM potongan_stok WHERE bulan_potong=? AND status_bayar='belum'", [bulan]
    );

    const results = [];
    for (const d of data) {
      const hariLembur = Math.max(0, (d.hari_hadir||0) - hariKerja);

      // Kasbon aktif karyawan ini
      const kasbon = kasbonRows.filter(k => k.personnel_id === d.personnel_id);
      const totalKasbon = kasbon.reduce((s,k) => s + Math.min(parseFloat(k.cicilan_per_bulan), parseFloat(k.sisa)), 0);

      // Bon barang karyawan ini bulan ini
      const bon = bonRows.filter(b => b.personnel_id === d.personnel_id);
      const totalBon = bon.reduce((s,b) => s + parseFloat(b.total), 0);

      // Potongan stok karyawan ini bulan ini
      const stok = stokRows.filter(s => s.personnel_id === d.personnel_id);
      const totalStok = stok.reduce((s,p) => s + parseFloat(p.total), 0);

      const row = {
        bulan,
        personnel_id : d.personnel_id,
        nama         : d.nama,
        nik          : d.nik || '',
        grup         : d.grup || '',
        jabatan      : d.jabatan || '',
        hari_kerja   : hariKerja,
        hari_hadir   : d.hari_hadir || 0,
        hari_lembur  : hariLembur,
        gaji_pokok   : d.gaji_pokok || 0,
        bonus_omzet  : d.bonus_omzet || 0,
        bonus_poin   : d.bonus_poin || 0,
        lembur       : hariLembur * (d.rate_lembur || 0),
        insentif_absensi: (insentifMap[d.personnel_id]?.total_insentif || 0) +
          (d.hari_hadir >= hariKerja ? (d.rate_insentif_absensi || 0) : 0),
        tunjangan_lain      : d.tunjangan_lain || 0,
        tunjangan_jabatan   : d.tunjangan_jabatan || 0,
        tunjangan_transport : d.tunjangan_transport || 0,
        potongan_absensi: Math.max(0, hariKerja - (d.hari_hadir||0)) * (d.potongan_per_hari || 0),
        kasbon       : totalKasbon + totalBon + totalStok,
        bpjs_kes     : d.bpjs_kes || 0,
        bpjs_jht     : d.bpjs_jht || 0,
        potongan_lain: d.potongan_lain || 0,
        status       : 'draft',
        created_by   : req.user.id
      };

      console.log('Inserting payroll for:', row.nama, row.bulan);
      const insertCols = 'bulan,personnel_id,nama,nik,grup,jabatan,hari_kerja,hari_hadir,hari_lembur,gaji_pokok,bonus_omzet,bonus_poin,lembur,insentif_absensi,tunjangan_lain,tunjangan_jabatan,tunjangan_transport,potongan_absensi,kasbon,bpjs_kes,bpjs_jht,potongan_lain,status,created_by';
      const insertVals = [row.bulan,row.personnel_id,row.nama,row.nik,row.grup,row.jabatan,row.hari_kerja,row.hari_hadir,row.hari_lembur,row.gaji_pokok,row.bonus_omzet,row.bonus_poin,row.lembur,row.insentif_absensi,row.tunjangan_lain,row.tunjangan_jabatan,row.tunjangan_transport,row.potongan_absensi,row.kasbon,row.bpjs_kes,row.bpjs_jht,row.potongan_lain,row.status,row.created_by];
      const placeholders = insertVals.map(()=>'?').join(',');
      await db.query(
        `INSERT INTO payroll (${insertCols}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE hari_hadir=VALUES(hari_hadir),hari_lembur=VALUES(hari_lembur),gaji_pokok=VALUES(gaji_pokok),bonus_omzet=VALUES(bonus_omzet),bonus_poin=VALUES(bonus_poin),lembur=VALUES(lembur),insentif_absensi=VALUES(insentif_absensi),tunjangan_lain=VALUES(tunjangan_lain),tunjangan_jabatan=VALUES(tunjangan_jabatan),tunjangan_transport=VALUES(tunjangan_transport),potongan_absensi=VALUES(potongan_absensi),kasbon=VALUES(kasbon),bpjs_kes=VALUES(bpjs_kes),bpjs_jht=VALUES(bpjs_jht),potongan_lain=VALUES(potongan_lain)`,
        insertVals
      );
      results.push(row);
    }

    // Update kasbon sisa
    for (const d of data) {
      const kasbon = kasbonRows.filter(k => k.personnel_id === d.personnel_id);
      for (const k of kasbon) {
        const cicilan = Math.min(parseFloat(k.cicilan_per_bulan), parseFloat(k.sisa));
        const sisaBaru = parseFloat(k.sisa) - cicilan;
        await db.query('UPDATE kasbon SET sisa=?, status=? WHERE id=?',
          [sisaBaru, sisaBaru <= 0 ? 'lunas' : 'aktif', k.id]);
        await db.query('INSERT INTO kasbon_cicilan (kasbon_id,personnel_id,bulan,nominal) VALUES (?,?,?,?)',
          [k.id, d.personnel_id, bulan, cicilan]);
      }
      // Update bon barang
      const bon = bonRows.filter(b => b.personnel_id === d.personnel_id);
      for (const b of bon) {
        await db.query("UPDATE bon_barang SET status_bayar='dipotong' WHERE id=?", [b.id]);
      }
      // Update potongan stok
      const stok = stokRows.filter(s => s.personnel_id === d.personnel_id);
      for (const s of stok) {
        await db.query("UPDATE potongan_stok SET status_bayar='dipotong' WHERE id=?", [s.id]);
      }
    }

    // Mark insentif gudang sudah di-apply
    if(insentifGudang.length){
      const ids = insentifGudang.map(i=>i.id);
      const ph = ids.map(()=>'?').join(',');
      await db.query(`UPDATE payroll_insentif_gudang SET sudah_apply=1 WHERE id IN (${ph})`, ids);
    }

    console.log('Generate payroll success:', results.length);
    res.json({ success:true, message:`${results.length} data payroll berhasil digenerate.`, data:results });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Update satu baris payroll
router.patch('/:id', auth(), async (req, res) => {
  try {
    const { bonus_omzet, bonus_poin, tunjangan_lain, kasbon, potongan_absensi, potongan_lain, status } = req.body;
    await db.query(
      `UPDATE payroll SET bonus_omzet=?,bonus_poin=?,tunjangan_lain=?,kasbon=?,potongan_absensi=?,potongan_lain=?,status=? WHERE id=?`,
      [bonus_omzet||0, bonus_poin||0, tunjangan_lain||0, kasbon||0, potongan_absensi||0, potongan_lain||0, status||'draft', req.params.id]
    );
    res.json({ success:true, message:'Payroll diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// Finalisasi payroll bulan
router.post('/finalisasi', auth(), async (req, res) => {
  try {
    const { bulan } = req.body;
    await db.query("UPDATE payroll SET status='final' WHERE bulan=?", [bulan]);
    res.json({ success:true, message:'Payroll bulan '+bulan+' telah difinalisasi.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── KASBON ──
router.get('/kasbon', auth(), async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM kasbon ORDER BY created_at DESC");
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/kasbon', auth(), async (req, res) => {
  try {
    const { personnel_id, nama, tanggal, nominal, cicilan_per_bulan, keterangan } = req.body;
    if (!personnel_id||!nominal) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      'INSERT INTO kasbon (personnel_id,nama,tanggal,nominal,cicilan_per_bulan,sisa,keterangan,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [personnel_id, nama, tanggal, nominal, cicilan_per_bulan||nominal, nominal, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Kasbon berhasil dicatat.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── BON BARANG ──
router.get('/bon-barang', auth(), async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM bon_barang ORDER BY tanggal DESC");
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/bon-barang', auth(), async (req, res) => {
  try {
    const { personnel_id, nama_karyawan, tanggal, nama_barang, qty, harga_satuan, bulan_potong, keterangan } = req.body;
    if (!personnel_id||!nama_barang||!qty||!harga_satuan) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      'INSERT INTO bon_barang (personnel_id,nama_karyawan,tanggal,nama_barang,qty,harga_satuan,bulan_potong,keterangan,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [personnel_id, nama_karyawan, tanggal, nama_barang, qty, harga_satuan, bulan_potong||null, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Bon barang berhasil dicatat.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── POTONGAN STOK ──
router.get('/potongan-stok', auth(), async (req, res) => {
  try {
    const [rows] = await db.query("SELECT ps.*, c.nama AS nama_cabang FROM potongan_stok ps LEFT JOIN cabang c ON c.id=ps.cabang_id ORDER BY ps.tanggal DESC");
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/potongan-stok', auth(), async (req, res) => {
  try {
    const { personnel_id, nama_karyawan, tanggal, cabang_id, nama_barang, qty_hilang, harga_satuan, no_stok_opname, bulan_potong, keterangan } = req.body;
    if (!personnel_id||!nama_barang||!qty_hilang||!harga_satuan) return res.status(400).json({ success:false, message:'Data tidak lengkap.' });
    await db.query(
      'INSERT INTO potongan_stok (personnel_id,nama_karyawan,tanggal,cabang_id,nama_barang,qty_hilang,harga_satuan,no_stok_opname,bulan_potong,keterangan,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [personnel_id, nama_karyawan, tanggal, cabang_id||null, nama_barang, qty_hilang, harga_satuan, no_stok_opname||'', bulan_potong||null, keterangan||'', req.user.id]
    );
    res.json({ success:true, message:'Potongan stok berhasil dicatat.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;
