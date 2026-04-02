const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── MAPPING CABANG ──

// GET /api/manajer-area/mapping/:user_id
router.get('/mapping/:user_id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT mac.cabang_id, c.kode, c.nama
      FROM manajer_area_cabang mac
      JOIN cabang c ON c.id=mac.cabang_id
      WHERE mac.user_id=? ORDER BY c.kode`, [req.params.user_id]);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/manajer-area/mapping/:user_id — set mapping (delete-all + reinsert)
router.post('/mapping/:user_id', auth(['owner']), async (req, res) => {
  try {
    const { cabang_ids } = req.body;
    await db.query('DELETE FROM manajer_area_cabang WHERE user_id=?', [req.params.user_id]);
    if (cabang_ids?.length) {
      const ph = cabang_ids.map(() => '(?,?)').join(',');
      const vals = cabang_ids.flatMap(id => [parseInt(req.params.user_id), parseInt(id)]);
      await db.query(`INSERT INTO manajer_area_cabang (user_id, cabang_id) VALUES ${ph}`, vals);
    }
    res.json({success:true, message:`${cabang_ids?.length||0} cabang dimapping.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── SKEMA BAGI HASIL CONFIG ──

// GET /api/manajer-area/skema — semua config
router.get('/skema', auth(['owner','admin_pusat','manajer_area']), async (req, res) => {
  try {
    let where = '1=1';
    const params = [];
    // manajer_area hanya lihat milik sendiri
    if (req.user.role === 'manajer_area') { where = 'bh.user_id=?'; params.push(req.user.id); }
    const [rows] = await db.query(`
      SELECT bh.*, u.nama_lengkap, u.username,
        (SELECT GROUP_CONCAT(c.nama ORDER BY c.kode SEPARATOR ', ')
         FROM manajer_area_cabang mac JOIN cabang c ON c.id=mac.cabang_id
         WHERE mac.user_id=bh.user_id) as nama_cabang_list
      FROM manajer_bagi_hasil bh
      JOIN users u ON u.id=bh.user_id
      WHERE ${where}`, params);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/manajer-area/skema/:user_id — update config
router.patch('/skema/:user_id', auth(['owner']), async (req, res) => {
  try {
    const {skema, poin_minimum, poin_penalti, nilai_per_poin, persen_owner, persen_manajer, pengeluaran_ditanggung, catatan} = req.body;
    await db.query(`UPDATE manajer_bagi_hasil SET skema=?, poin_minimum=?, poin_penalti=?, nilai_per_poin=?,
      persen_owner=?, persen_manajer=?, pengeluaran_ditanggung=?, catatan=? WHERE user_id=?`,
      [skema, poin_minimum||400, poin_penalti||400, nilai_per_poin||1000,
       persen_owner||40, persen_manajer||60, pengeluaran_ditanggung||'manajer', catatan||null, req.params.user_id]);
    res.json({success:true, message:'Skema diupdate.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── KALKULASI BAGI HASIL ──

// GET /api/manajer-area/kalkulasi/:user_id?bulan=YYYY-MM
router.get('/kalkulasi/:user_id', auth(['owner','admin_pusat','manajer_area']), async (req, res) => {
  try {
    const userId = parseInt(req.params.user_id);
    // manajer_area hanya lihat milik sendiri
    if (req.user.role === 'manajer_area' && req.user.id !== userId)
      return res.status(403).json({success:false,message:'Tidak diizinkan.'});

    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const dateFrom = bulan + '-01';
    const dateTo = bulan + '-31'; // MySQL handles month boundary

    // Get config
    const [[config]] = await db.query('SELECT * FROM manajer_bagi_hasil WHERE user_id=?', [userId]);
    if (!config) return res.status(404).json({success:false,message:'Skema bagi hasil tidak ditemukan.'});

    // Get managed cabang
    const [cabangRows] = await db.query(`
      SELECT mac.cabang_id, c.kode, c.nama
      FROM manajer_area_cabang mac JOIN cabang c ON c.id=mac.cabang_id
      WHERE mac.user_id=? ORDER BY c.kode`, [userId]);
    const cabangIds = cabangRows.map(c => c.cabang_id);

    if (!cabangIds.length)
      return res.json({success:true, data:{config, cabang:[], kalkulasi:null, bulan}});

    const ph = cabangIds.map(()=>'?').join(',');

    if (config.skema === 'poin') {
      // ── SKEMA POIN ──
      // Hitung poin per karyawan di cabang-cabang ini
      const [karyawanPoin] = await db.query(`
        SELECT r.user_id, u.nama_lengkap, u.role, r.cabang_id, c.nama as nama_cabang,
               SUM(r.total_poin) as total_poin, SUM(r.total_trx) as total_trx,
               SUM(r.omzet_total) as omzet_total
        FROM staff_rekap_harian r
        JOIN users u ON u.id=r.user_id
        JOIN cabang c ON c.id=r.cabang_id
        WHERE r.cabang_id IN (${ph}) AND r.tanggal BETWEEN ? AND ?
          AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')
        GROUP BY r.user_id, u.nama_lengkap, u.role, r.cabang_id, c.nama
        ORDER BY c.nama, total_poin DESC`,
        [...cabangIds, dateFrom, dateTo]);

      // Juga hitung dari pos_transaksi_item langsung (sebagai cross-check & fallback jika rekap belum lengkap)
      const [poinFromTrx] = await db.query(`
        SELECT t.kasir_id as user_id, t.cabang_id,
               COALESCE(SUM(ti.komisi_poin * ti.qty),0) as total_poin_trx
        FROM pos_transaksi t
        JOIN pos_transaksi_item ti ON ti.transaksi_id=t.id
        WHERE t.cabang_id IN (${ph}) AND t.status='selesai'
          AND t.created_at >= ? AND t.created_at <= ?
        GROUP BY t.kasir_id, t.cabang_id`,
        [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']);

      // Merge: gunakan yang lebih besar antara rekap vs transaksi langsung
      const poinTrxMap = {};
      poinFromTrx.forEach(r => { poinTrxMap[r.user_id+'_'+r.cabang_id] = parseInt(r.total_poin_trx)||0; });

      const detailKaryawan = karyawanPoin.map(k => {
        const poinRekap = parseInt(k.total_poin)||0;
        const poinTrx = poinTrxMap[k.user_id+'_'+k.cabang_id] || 0;
        const poin = Math.max(poinRekap, poinTrx);
        const dibawahMin = poin < config.poin_minimum;
        return {
          user_id: k.user_id, nama: k.nama_lengkap, role: k.role,
          cabang_id: k.cabang_id, nama_cabang: k.nama_cabang,
          total_poin: poin, total_trx: parseInt(k.total_trx)||0,
          omzet: parseFloat(k.omzet_total)||0,
          dibawah_minimum: dibawahMin
        };
      });

      // Juga cek karyawan aktif yang TIDAK ada transaksi (poin = 0, otomatis di bawah min)
      const [activeStaff] = await db.query(`
        SELECT u.id as user_id, u.nama_lengkap, u.role, u.cabang_id, c.nama as nama_cabang
        FROM users u
        JOIN cabang c ON c.id=u.cabang_id
        WHERE u.cabang_id IN (${ph}) AND u.aktif=1
          AND u.role IN ('kasir','kasir_sales','vaporista','kepala_cabang')`, cabangIds);

      // Tambahkan karyawan yang belum ada di detailKaryawan
      const existingIds = new Set(detailKaryawan.map(d => d.user_id));
      activeStaff.forEach(s => {
        if (!existingIds.has(s.user_id)) {
          detailKaryawan.push({
            user_id: s.user_id, nama: s.nama_lengkap, role: s.role,
            cabang_id: s.cabang_id, nama_cabang: s.nama_cabang,
            total_poin: 0, total_trx: 0, omzet: 0,
            dibawah_minimum: true
          });
        }
      });

      const totalPoin = detailKaryawan.reduce((s,k) => s + k.total_poin, 0);
      const totalKaryawan = detailKaryawan.length;
      const karyawanDibawah = detailKaryawan.filter(k => k.dibawah_minimum).length;
      const totalPenalti = karyawanDibawah * config.poin_penalti;
      const poinBersih = Math.max(0, totalPoin - totalPenalti);
      const bagianManajer = poinBersih * parseFloat(config.nilai_per_poin);

      res.json({success:true, data:{
        config, bulan, cabang: cabangRows,
        kalkulasi: {
          skema: 'poin',
          total_poin: totalPoin,
          total_karyawan: totalKaryawan,
          karyawan_dibawah_minimum: karyawanDibawah,
          total_penalti: totalPenalti,
          poin_bersih: poinBersih,
          nilai_per_poin: parseFloat(config.nilai_per_poin),
          bagian_manajer: bagianManajer,
          detail_karyawan: detailKaryawan.sort((a,b) => b.total_poin - a.total_poin)
        }
      }});

    } else {
      // ── SKEMA GROSS PROFIT ──
      // Omzet & HPP dari POS
      const [posData] = await db.query(`
        SELECT t.cabang_id, c.nama as nama_cabang,
               COALESCE(SUM(t.total),0) as omzet,
               COALESCE(SUM(ti.harga_modal * ti.qty),0) as hpp
        FROM pos_transaksi t
        JOIN pos_transaksi_item ti ON ti.transaksi_id=t.id
        JOIN cabang c ON c.id=t.cabang_id
        WHERE t.cabang_id IN (${ph}) AND t.status='selesai'
          AND t.created_at >= ? AND t.created_at <= ?
        GROUP BY t.cabang_id, c.nama`,
        [...cabangIds, dateFrom+' 00:00:00', dateTo+' 23:59:59']);

      // Pengeluaran (approved)
      const [pglData] = await db.query(`
        SELECT cabang_id, COALESCE(SUM(nominal),0) as total_pengeluaran
        FROM pengeluaran
        WHERE cabang_id IN (${ph}) AND status='approved' AND tanggal BETWEEN ? AND ?
        GROUP BY cabang_id`, [...cabangIds, dateFrom, dateTo]);

      const pglMap = {};
      pglData.forEach(r => { pglMap[r.cabang_id] = parseFloat(r.total_pengeluaran); });

      const detailCabang = posData.map(r => {
        const omzet = parseFloat(r.omzet);
        const hpp = parseFloat(r.hpp);
        const grossProfit = omzet - hpp;
        const pengeluaran = pglMap[r.cabang_id] || 0;
        return {
          cabang_id: r.cabang_id, nama_cabang: r.nama_cabang,
          omzet, hpp, gross_profit: grossProfit, pengeluaran
        };
      });

      // Tambahkan cabang tanpa POS data (mungkin ada pengeluaran saja)
      const possCabIds = new Set(posData.map(r => r.cabang_id));
      cabangRows.forEach(cab => {
        if (!possCabIds.has(cab.cabang_id)) {
          const pgl = pglMap[cab.cabang_id] || 0;
          detailCabang.push({
            cabang_id: cab.cabang_id, nama_cabang: cab.nama,
            omzet: 0, hpp: 0, gross_profit: 0, pengeluaran: pgl
          });
        }
      });

      const totalOmzet = detailCabang.reduce((s,c) => s + c.omzet, 0);
      const totalHpp = detailCabang.reduce((s,c) => s + c.hpp, 0);
      const totalGrossProfit = totalOmzet - totalHpp;
      const totalPengeluaran = detailCabang.reduce((s,c) => s + c.pengeluaran, 0);

      const pctOwner = parseFloat(config.persen_owner) / 100;
      const pctManajer = parseFloat(config.persen_manajer) / 100;
      const bagianOwner = totalGrossProfit * pctOwner;
      const bagianManajerKotor = totalGrossProfit * pctManajer;
      const bagianManajerBersih = config.pengeluaran_ditanggung === 'manajer'
        ? bagianManajerKotor - totalPengeluaran
        : bagianManajerKotor;

      res.json({success:true, data:{
        config, bulan, cabang: cabangRows,
        kalkulasi: {
          skema: 'gross_profit',
          total_omzet: totalOmzet,
          total_hpp: totalHpp,
          gross_profit: totalGrossProfit,
          total_pengeluaran: totalPengeluaran,
          persen_owner: parseFloat(config.persen_owner),
          persen_manajer: parseFloat(config.persen_manajer),
          bagian_owner: bagianOwner,
          bagian_manajer_kotor: bagianManajerKotor,
          bagian_manajer_bersih: bagianManajerBersih,
          detail_cabang: detailCabang
        }
      }});
    }
  } catch(e) {
    console.error('kalkulasi bagi hasil:', e);
    res.status(500).json({success:false,message:e.message});
  }
});

// POST /api/manajer-area/kalkulasi/:user_id/simpan — simpan log bagi hasil
router.post('/kalkulasi/:user_id/simpan', auth(['owner']), async (req, res) => {
  try {
    const { bulan, kalkulasi } = req.body;
    if (!bulan || !kalkulasi) return res.status(400).json({success:false,message:'bulan dan kalkulasi wajib.'});

    const k = kalkulasi;
    await db.query(`INSERT INTO manajer_bagi_hasil_log
      (user_id,bulan,skema,total_omzet,total_hpp,gross_profit,total_pengeluaran,
       total_poin,total_karyawan,karyawan_di_bawah_min,total_penalti,poin_bersih,
       bagian_owner,bagian_manajer,detail_json,status,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
       total_omzet=VALUES(total_omzet),total_hpp=VALUES(total_hpp),gross_profit=VALUES(gross_profit),
       total_pengeluaran=VALUES(total_pengeluaran),total_poin=VALUES(total_poin),
       total_karyawan=VALUES(total_karyawan),karyawan_di_bawah_min=VALUES(karyawan_di_bawah_min),
       total_penalti=VALUES(total_penalti),poin_bersih=VALUES(poin_bersih),
       bagian_owner=VALUES(bagian_owner),bagian_manajer=VALUES(bagian_manajer),
       detail_json=VALUES(detail_json),status=VALUES(status)`,
      [req.params.user_id, bulan, k.skema,
       k.total_omzet||0, k.total_hpp||0, k.gross_profit||0, k.total_pengeluaran||0,
       k.total_poin||0, k.total_karyawan||0, k.karyawan_dibawah_minimum||0,
       k.total_penalti||0, k.poin_bersih||0,
       k.bagian_owner||0, k.skema==='poin' ? k.bagian_manajer : k.bagian_manajer_bersih,
       JSON.stringify(k), 'draft', req.user.id]);

    res.json({success:true, message:'Kalkulasi disimpan.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/manajer-area/history/:user_id — riwayat bagi hasil
router.get('/history/:user_id', auth(['owner','admin_pusat','manajer_area']), async (req, res) => {
  try {
    if (req.user.role === 'manajer_area' && req.user.id !== parseInt(req.params.user_id))
      return res.status(403).json({success:false,message:'Tidak diizinkan.'});
    const [rows] = await db.query('SELECT * FROM manajer_bagi_hasil_log WHERE user_id=? ORDER BY bulan DESC', [req.params.user_id]);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/manajer-area/list — daftar semua manajer area
router.get('/list', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT u.id, u.username, u.nama_lengkap, u.aktif,
             bh.skema,
             (SELECT COUNT(*) FROM manajer_area_cabang mac WHERE mac.user_id=u.id) as jumlah_cabang,
             (SELECT GROUP_CONCAT(c2.nama ORDER BY c2.kode SEPARATOR ', ')
              FROM manajer_area_cabang mac2 JOIN cabang c2 ON c2.id=mac2.cabang_id
              WHERE mac2.user_id=u.id) as cabang_list
      FROM users u
      LEFT JOIN manajer_bagi_hasil bh ON bh.user_id=u.id
      WHERE u.role='manajer_area'
      ORDER BY u.nama_lengkap`);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
