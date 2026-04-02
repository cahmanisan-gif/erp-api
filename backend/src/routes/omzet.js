const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const role    = (roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) return res.status(403).json({ success:false, message:'Akses ditolak' });
  next();
};

// ── GET /api/omzet/areas ── daftar area unik
router.get('/areas', auth(), async (req, res) => {
  const [rows] = await db.query(
    `SELECT DISTINCT COALESCE(kecamatan,kabupaten) AS area FROM cabang WHERE aktif=1 AND (kecamatan IS NOT NULL OR kabupaten IS NOT NULL) ORDER BY 1`
  );
  res.json({ success:true, data: rows.map(r => r.area).filter(Boolean) });
});

// ── GET /api/omzet/kategori ── daftar kategori pengeluaran
router.get('/kategori', auth(), async (req, res) => {
  const [rows] = await db.query(`SELECT id, nama FROM pengeluaran_kategori ORDER BY nama`);
  res.json({ success:true, data:rows });
});

// ── GET /api/omzet/kas-akun ── daftar akun kas aktif
router.get('/kas-akun', auth(), async (req, res) => {
  const [rows] = await db.query(`SELECT id, nama_akun, nama_bank FROM kas_akun WHERE aktif=1 ORDER BY nama_akun`);
  res.json({ success:true, data:rows });
});

// ── GET /api/omzet?bulan=YYYY-MM ─────────────────────────────
// Kembalikan semua cabang + data omzet per hari dalam bulan tsb
router.get('/', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7); // YYYY-MM
    const [year, month] = bulan.split('-').map(Number);

    // Semua cabang aktif
    const [cabangList] = await db.query(
      `SELECT id, nama, kecamatan AS kota, kabupaten AS area, tanggal_buka FROM cabang WHERE aktif=1 ORDER BY COALESCE(area,kota), nama ASC`
    );

    // Semua omzet di bulan ini
    const [omzetRows] = await db.query(
      `SELECT o.*, c.nama AS nama_cabang
       FROM omzet_cabang o
       JOIN cabang c ON c.id = o.cabang_id
       WHERE DATE_FORMAT(o.tanggal,'%Y-%m') = ?`,
      [bulan]
    );

    // Pengeluaran per omzet_id
    const [pglRows] = await db.query(
      `SELECT op.*, pk.nama AS nama_kategori
       FROM omzet_pengeluaran op
       LEFT JOIN pengeluaran_kategori pk ON pk.id = op.kategori_id
       WHERE DATE_FORMAT(op.tanggal,'%Y-%m') = ?`,
      [bulan]
    );

    // Tanggal dalam bulan (1 s/d hari terakhir bulan)
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const todayStr = today.toISOString().slice(0,10);

    // Map omzet per cabang_id + tanggal
    const omzetMap = {};
    omzetRows.forEach(o => {
      if (!omzetMap[o.cabang_id]) omzetMap[o.cabang_id] = {};
      omzetMap[o.cabang_id][o.tanggal.toISOString().slice(0,10)] = o;
    });

    // Map pengeluaran per omzet_id
    const pglMap = {};
    pglRows.forEach(p => {
      if (!pglMap[p.omzet_id]) pglMap[p.omzet_id] = [];
      pglMap[p.omzet_id].push(p);
    });

    // Hitung status tiap cabang di bulan ini
    const result = cabangList.map(cab => {
      const days = [];
      let missingCount = 0;
      let totalCash = 0, totalTransfer = 0, totalPos = 0, totalSelisih = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        // Jangan hitung hari yang belum tiba
        if (dateStr > todayStr) continue;

        const omzet = omzetMap[cab.id]?.[dateStr] || null;
        if (!omzet) {
          missingCount++;
        } else {
          totalCash     += parseFloat(omzet.omzet_cash || 0);
          totalTransfer += parseFloat(omzet.omzet_transfer || 0);
          totalPos      += parseFloat(omzet.omzet_pos || 0);
          const totalPglHari = (pglMap[omzet.id]||[]).reduce((s,p)=>s+parseFloat(p.nominal||0),0);
          const selisihHari = parseFloat(omzet.omzet_pos||0) > 0
            ? (parseFloat(omzet.omzet_cash||0) + parseFloat(omzet.omzet_transfer||0) + totalPglHari) - parseFloat(omzet.omzet_pos||0)
            : 0;
          omzet._selisih = selisihHari;
          totalSelisih  += selisihHari;
        }
        days.push({
          tanggal  : dateStr,
          omzet    : omzet,
          pengeluaran: omzet ? (pglMap[omzet.id] || []) : []
        });
      }

      return {
        cabang      : { id: cab.id, nama: cab.nama, kota: cab.area || cab.kota },
        days        : days,
        totalCash,
        totalTransfer,
        totalOmzet  : totalCash + totalTransfer,
        totalPos,
        totalSelisih,
        missingCount,
        isComplete  : missingCount === 0
      };
    });

    res.json({ success:true, data:result, bulan });
  } catch(e) {
    console.error(e);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ── POST /api/omzet ─ input/update omzet satu hari satu cabang
router.post('/', auth(), role(['owner','admin_pusat','finance']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      cabang_id, tanggal,
      omzet_cash = 0, omzet_transfer = 0, omzet_pos = 0,
      kas_akun_cash, kas_akun_transfer,
      catatan,
      pengeluaran = []
    } = req.body;

    if (!cabang_id || !tanggal) throw new Error('cabang_id dan tanggal wajib diisi');

    // Upsert omzet (jika sudah ada, update)
    const [existing] = await conn.query(
      `SELECT id FROM omzet_cabang WHERE cabang_id=? AND tanggal=?`,
      [cabang_id, tanggal]
    );

    let omzetId;
    if (existing.length) {
      omzetId = existing[0].id;
      // Ambil data lama untuk reverse mutasi kas lama
      const [old] = await conn.query(`SELECT * FROM omzet_cabang WHERE id=?`, [omzetId]);
      const oldData = old[0];

      // Hapus mutasi kas lama terkait omzet ini
      await conn.query(`DELETE FROM kas_mutasi WHERE keterangan LIKE ?`, [`%[OMZET#${omzetId}]%`]);

      // Update omzet
      await conn.query(
        `UPDATE omzet_cabang SET omzet_pos=?, omzet_cash=?, omzet_transfer=?, kas_akun_cash=?, kas_akun_transfer=?, catatan=? WHERE id=?`,
        [omzet_pos||0, omzet_cash, omzet_transfer, kas_akun_cash||null, kas_akun_transfer||null, catatan||null, omzetId]
      );
    } else {
      const [ins] = await conn.query(
        `INSERT INTO omzet_cabang (cabang_id,tanggal,omzet_pos,omzet_cash,omzet_transfer,kas_akun_cash,kas_akun_transfer,catatan,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [cabang_id, tanggal, omzet_pos||0, omzet_cash, omzet_transfer, kas_akun_cash||null, kas_akun_transfer||null, catatan||null, req.user.id]
      );
      omzetId = ins.insertId;
    }

    // Buat mutasi kas (cash)
    if (parseFloat(omzet_cash) > 0 && kas_akun_cash) {
      const [cab] = await conn.query(`SELECT nama FROM cabang WHERE id=?`, [cabang_id]);
      await conn.query(
        `INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by)
         VALUES (?,?,'masuk',?,?,?)`,
        [kas_akun_cash, tanggal, omzet_cash, `Omzet cash ${cab[0]?.nama} ${tanggal} [OMZET#${omzetId}]`, req.user.id]
      );
    }

    // Buat mutasi kas (transfer)
    if (parseFloat(omzet_transfer) > 0 && kas_akun_transfer) {
      const [cab] = await conn.query(`SELECT nama FROM cabang WHERE id=?`, [cabang_id]);
      await conn.query(
        `INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by)
         VALUES (?,?,'masuk',?,?,?)`,
        [kas_akun_transfer, tanggal, omzet_transfer, `Omzet transfer ${cab[0]?.nama} ${tanggal} [OMZET#${omzetId}]`, req.user.id]
      );
    }

    // Hapus pengeluaran lama terkait omzet ini (beserta sinknya di tabel pengeluaran)
    const [oldPgl] = await conn.query(
      `SELECT pengeluaran_id FROM omzet_pengeluaran WHERE omzet_id=?`, [omzetId]
    );
    for (const p of oldPgl) {
      if (p.pengeluaran_id) {
        await conn.query(`DELETE FROM pengeluaran WHERE id=?`, [p.pengeluaran_id]);
      }
    }
    await conn.query(`DELETE FROM omzet_pengeluaran WHERE omzet_id=?`, [omzetId]);

    // Insert pengeluaran baru
    for (const pgl of pengeluaran) {
      if (!pgl.nominal || parseFloat(pgl.nominal) <= 0) continue;
      // Sync ke tabel pengeluaran utama (status approved langsung)
      const [pIns] = await conn.query(
        `INSERT INTO pengeluaran (cabang_id,kategori_id,tanggal,nominal,keterangan,status,user_id)
         VALUES (?,?,?,?,?,'approved',?)`,
        [cabang_id, pgl.kategori_id||null, tanggal, pgl.nominal, pgl.keterangan||`Pengeluaran cabang ${tanggal}`, req.user.id]
      );
      await conn.query(
        `INSERT INTO omzet_pengeluaran (omzet_id,cabang_id,tanggal,kategori_id,nominal,keterangan,pengeluaran_id,created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [omzetId, cabang_id, tanggal, pgl.kategori_id||null, pgl.nominal, pgl.keterangan||null, pIns.insertId, req.user.id]
      );
    }

    // Hitung fraud_flag: POS vs (cash + transfer + total pengeluaran)
    if (parseFloat(omzet_pos) > 0) {
      const [pglSum] = await conn.query(
        `SELECT COALESCE(SUM(nominal),0) AS total FROM omzet_pengeluaran WHERE omzet_id=?`, [omzetId]
      );
      const totalPgl   = parseFloat(pglSum[0].total);
      const totalSistem = parseFloat(omzet_cash) + parseFloat(omzet_transfer) + totalPgl;
      const isFraud    = Math.abs(parseFloat(omzet_pos) - totalSistem) > 0;
      await conn.query(`UPDATE omzet_cabang SET fraud_flag=? WHERE id=?`, [isFraud?1:0, omzetId]);
    }

    await conn.commit();
    res.json({ success:true, omzet_id:omzetId });
  } catch(e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ success:false, message:e.message });
  } finally {
    conn.release();
  }
});

// ── DELETE /api/omzet/:id ─────────────────────────────────────
router.delete('/:id', auth(), role(['owner','admin_pusat']), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const id = req.params.id;

    // Hapus mutasi kas terkait
    await conn.query(`DELETE FROM kas_mutasi WHERE keterangan LIKE ?`, [`%[OMZET#${id}]%`]);

    // Hapus pengeluaran terkait
    const [pglRows] = await conn.query(`SELECT pengeluaran_id FROM omzet_pengeluaran WHERE omzet_id=?`, [id]);
    for (const p of pglRows) {
      if (p.pengeluaran_id) await conn.query(`DELETE FROM pengeluaran WHERE id=?`, [p.pengeluaran_id]);
    }
    await conn.query(`DELETE FROM omzet_pengeluaran WHERE omzet_id=?`, [id]);
    await conn.query(`DELETE FROM omzet_cabang WHERE id=?`, [id]);

    await conn.commit();
    res.json({ success:true });
  } catch(e) {
    await conn.rollback();
    res.status(500).json({ success:false, message:e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
