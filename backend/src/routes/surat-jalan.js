const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

const WRITE_ROLES = ['owner','manajer','head_operational','admin_pusat'];

// ── Helper: generate nomor SJ-YYYYMM-XXXX ──
async function generateNomor(conn) {
  const now = new Date();
  const ym  = String(now.getFullYear()) + String(now.getMonth()+1).padStart(2,'0');
  const prefix = `SJ-${ym}-`;
  const [[row]] = await conn.query(
    `SELECT nomor FROM surat_jalan WHERE nomor LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  let seq = 1;
  if (row) {
    const last = parseInt(row.nomor.split('-').pop(), 10);
    if (!isNaN(last)) seq = last + 1;
  }
  return prefix + String(seq).padStart(4, '0');
}

// ══════════════════════════════════════════════
// GET /api/surat-jalan/pending — belum diterima (for dashboard)
// ══════════════════════════════════════════════
router.get('/pending', auth(), async (req, res) => {
  try {
    const cabang_id = req.query.cabang_id || req.user.cabang_id;
    let where = `sj.status IN ('disiapkan','dikirim')`;
    const params = [];
    if (cabang_id) {
      where += ` AND (sj.dari_cabang_id=? OR sj.ke_cabang_id=?)`;
      params.push(cabang_id, cabang_id);
    }
    const [rows] = await db.query(`
      SELECT sj.*, c1.nama AS dari_cabang, c2.nama AS ke_cabang, u.nama_lengkap AS creator
      FROM surat_jalan sj
      LEFT JOIN cabang c1 ON c1.id=sj.dari_cabang_id
      LEFT JOIN cabang c2 ON c2.id=sj.ke_cabang_id
      LEFT JOIN users u ON u.id=sj.created_by
      WHERE ${where}
      ORDER BY sj.created_at DESC
      LIMIT 50
    `, params);
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// GET /api/surat-jalan — list with filters
// ══════════════════════════════════════════════
router.get('/', auth(), async (req, res) => {
  try {
    const { dari_cabang_id, ke_cabang_id, status, dari, sampai, page, limit: lim } = req.query;
    let where = '1=1';
    const params = [];

    if (dari_cabang_id) { where += ' AND sj.dari_cabang_id=?'; params.push(dari_cabang_id); }
    if (ke_cabang_id)   { where += ' AND sj.ke_cabang_id=?';   params.push(ke_cabang_id); }
    if (status)         { where += ' AND sj.status=?';          params.push(status); }
    if (dari)           { where += ' AND sj.tanggal>=?';        params.push(dari); }
    if (sampai)         { where += ' AND sj.tanggal<=?';        params.push(sampai); }

    const limit  = Math.min(parseInt(lim) || 50, 200);
    const offset = ((parseInt(page) || 1) - 1) * limit;

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM surat_jalan sj WHERE ${where}`, params);

    const [rows] = await db.query(`
      SELECT sj.*, c1.nama AS dari_cabang, c2.nama AS ke_cabang,
             u1.nama_lengkap AS pengirim_nama, u2.nama_lengkap AS penerima_nama,
             uc.nama_lengkap AS creator
      FROM surat_jalan sj
      LEFT JOIN cabang c1 ON c1.id=sj.dari_cabang_id
      LEFT JOIN cabang c2 ON c2.id=sj.ke_cabang_id
      LEFT JOIN users u1 ON u1.id=sj.pengirim_id
      LEFT JOIN users u2 ON u2.id=sj.penerima_id
      LEFT JOIN users uc ON uc.id=sj.created_by
      WHERE ${where}
      ORDER BY sj.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({ success: true, data: rows, total, page: parseInt(page)||1, limit });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// GET /api/surat-jalan/:id — detail + items
// ══════════════════════════════════════════════
router.get('/:id', auth(), async (req, res) => {
  try {
    const [[sj]] = await db.query(`
      SELECT sj.*, c1.nama AS dari_cabang, c2.nama AS ke_cabang,
             u1.nama_lengkap AS pengirim_nama, u2.nama_lengkap AS penerima_nama,
             uc.nama_lengkap AS creator
      FROM surat_jalan sj
      LEFT JOIN cabang c1 ON c1.id=sj.dari_cabang_id
      LEFT JOIN cabang c2 ON c2.id=sj.ke_cabang_id
      LEFT JOIN users u1 ON u1.id=sj.pengirim_id
      LEFT JOIN users u2 ON u2.id=sj.penerima_id
      LEFT JOIN users uc ON uc.id=sj.created_by
      WHERE sj.id=?
    `, [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });

    const [items] = await db.query(
      `SELECT * FROM surat_jalan_item WHERE surat_jalan_id=? ORDER BY id`, [sj.id]
    );
    sj.items = items;
    res.json({ success: true, data: sj });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// POST /api/surat-jalan — create (status: disiapkan)
// ══════════════════════════════════════════════
router.post('/', auth(WRITE_ROLES), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { dari_cabang_id, ke_cabang_id, tanggal, items, catatan } = req.body;

    if (!dari_cabang_id || !ke_cabang_id) return res.status(400).json({ success: false, message: 'Cabang asal & tujuan wajib diisi.' });
    if (dari_cabang_id == ke_cabang_id) return res.status(400).json({ success: false, message: 'Cabang asal & tujuan tidak boleh sama.' });
    if (!items?.length) return res.status(400).json({ success: false, message: 'Items kosong.' });

    const nomor = await generateNomor(conn);
    const total_item = items.length;
    const total_qty  = items.reduce((s, i) => s + (parseInt(i.qty)||0), 0);

    const [result] = await conn.query(`
      INSERT INTO surat_jalan (nomor, dari_cabang_id, ke_cabang_id, tanggal, status, items_json, total_item, total_qty, catatan, created_by, pengirim_id)
      VALUES (?,?,?,?,  'disiapkan', ?,?,?,  ?,?,?)
    `, [nomor, dari_cabang_id, ke_cabang_id, tanggal || new Date().toISOString().slice(0,10),
        JSON.stringify(items), total_item, total_qty, catatan || null, req.user.id, req.user.id]);

    const sjId = result.insertId;

    // Insert items
    for (const item of items) {
      await conn.query(
        `INSERT INTO surat_jalan_item (surat_jalan_id, produk_id, nama_produk, qty, catatan) VALUES (?,?,?,?,?)`,
        [sjId, item.produk_id, item.nama_produk || '', parseInt(item.qty)||0, item.catatan || null]
      );
    }

    await conn.commit();
    audit(req, 'create', 'surat_jalan', sjId, nomor, { dari_cabang_id, ke_cabang_id, total_item, total_qty });
    res.json({ success: true, message: `Surat jalan ${nomor} dibuat.`, data: { id: sjId, nomor } });
  } catch(e) { await conn.rollback(); res.status(500).json({ success: false, message: e.message }); }
  finally { conn.release(); }
});

// ══════════════════════════════════════════════
// POST /api/surat-jalan/:id/kirim — mark as sent + kurangi stok asal
// ══════════════════════════════════════════════
router.post('/:id/kirim', auth(WRITE_ROLES), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[sj]] = await conn.query('SELECT * FROM surat_jalan WHERE id=?', [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });
    if (sj.status !== 'disiapkan') return res.status(400).json({ success: false, message: `Tidak bisa kirim, status: ${sj.status}.` });

    // Get cabang names for log
    const [[dariCab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [sj.dari_cabang_id]);
    const [[keCab]]   = await conn.query('SELECT nama FROM cabang WHERE id=?', [sj.ke_cabang_id]);
    const dariNama = dariCab?.nama || ('Cabang #'+sj.dari_cabang_id);
    const keNama   = keCab?.nama   || ('Cabang #'+sj.ke_cabang_id);

    // Get items
    const [items] = await conn.query('SELECT * FROM surat_jalan_item WHERE surat_jalan_id=?', [sj.id]);

    // Kurangi stok cabang asal
    for (const item of items) {
      await conn.query(
        `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,0) ON DUPLICATE KEY UPDATE qty=GREATEST(0, qty-?)`,
        [item.produk_id, sj.dari_cabang_id, item.qty]
      );
      // Log stok
      await conn.query(
        `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id, referensi_id) VALUES (?,?,'transfer_keluar',?,?,?,?)`,
        [item.produk_id, sj.dari_cabang_id, item.qty, `SJ ${sj.nomor} kirim ke ${keNama}`, req.user.id, sj.nomor]
      ).catch(()=>{});
    }

    // Update surat jalan status
    await conn.query(
      `UPDATE surat_jalan SET status='dikirim', waktu_kirim=NOW(), pengirim_id=?, bukti_kirim_url=? WHERE id=?`,
      [req.user.id, req.body.bukti_kirim_url || null, sj.id]
    );

    await conn.commit();
    audit(req, 'update', 'surat_jalan', sj.id, sj.nomor, { aksi: 'kirim', items_count: items.length });
    res.json({ success: true, message: `Surat jalan ${sj.nomor} telah dikirim. Stok ${dariNama} dikurangi.` });
  } catch(e) { await conn.rollback(); res.status(500).json({ success: false, message: e.message }); }
  finally { conn.release(); }
});

// ══════════════════════════════════════════════
// POST /api/surat-jalan/:id/terima — mark as received + tambah stok tujuan (partial OK)
// ══════════════════════════════════════════════
router.post('/:id/terima', auth(), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[sj]] = await conn.query('SELECT * FROM surat_jalan WHERE id=?', [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });
    if (sj.status !== 'dikirim') return res.status(400).json({ success: false, message: `Tidak bisa terima, status: ${sj.status}.` });

    // Get cabang names for log
    const [[dariCab]] = await conn.query('SELECT nama FROM cabang WHERE id=?', [sj.dari_cabang_id]);
    const [[keCab]]   = await conn.query('SELECT nama FROM cabang WHERE id=?', [sj.ke_cabang_id]);
    const dariNama = dariCab?.nama || ('Cabang #'+sj.dari_cabang_id);
    const keNama   = keCab?.nama   || ('Cabang #'+sj.ke_cabang_id);

    // Get items
    const [items] = await conn.query('SELECT * FROM surat_jalan_item WHERE surat_jalan_id=?', [sj.id]);

    // req.body.items_terima: [{id, qty_diterima}] — optional for partial delivery
    const terimaMap = {};
    if (req.body.items_terima?.length) {
      for (const it of req.body.items_terima) {
        terimaMap[it.id] = parseInt(it.qty_diterima) || 0;
      }
    }

    // Tambah stok cabang tujuan
    for (const item of items) {
      const qtyTerima = terimaMap[item.id] !== undefined ? terimaMap[item.id] : item.qty;
      const finalQty  = Math.min(qtyTerima, item.qty); // cannot exceed original qty

      // Update qty_diterima on item
      await conn.query('UPDATE surat_jalan_item SET qty_diterima=? WHERE id=?', [finalQty, item.id]);

      if (finalQty > 0) {
        await conn.query(
          `INSERT INTO pos_stok (produk_id, cabang_id, qty) VALUES (?,?,?) ON DUPLICATE KEY UPDATE qty=qty+?`,
          [item.produk_id, sj.ke_cabang_id, finalQty, finalQty]
        );
        // Log stok
        await conn.query(
          `INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id, referensi_id) VALUES (?,?,'transfer_masuk',?,?,?,?)`,
          [item.produk_id, sj.ke_cabang_id, finalQty, `SJ ${sj.nomor} terima dari ${dariNama}`, req.user.id, sj.nomor]
        ).catch(()=>{});
      }
    }

    // Update surat jalan status
    await conn.query(
      `UPDATE surat_jalan SET status='diterima', waktu_terima=NOW(), penerima_id=?, bukti_terima_url=? WHERE id=?`,
      [req.user.id, req.body.bukti_terima_url || null, sj.id]
    );

    await conn.commit();
    audit(req, 'update', 'surat_jalan', sj.id, sj.nomor, { aksi: 'terima', penerima: req.user.id });
    res.json({ success: true, message: `Surat jalan ${sj.nomor} diterima di ${keNama}. Stok ditambahkan.` });
  } catch(e) { await conn.rollback(); res.status(500).json({ success: false, message: e.message }); }
  finally { conn.release(); }
});

// ══════════════════════════════════════════════
// POST /api/surat-jalan/:id/batal — cancel (only if disiapkan)
// ══════════════════════════════════════════════
router.post('/:id/batal', auth(WRITE_ROLES), async (req, res) => {
  try {
    const [[sj]] = await db.query('SELECT * FROM surat_jalan WHERE id=?', [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });
    if (sj.status !== 'disiapkan') return res.status(400).json({ success: false, message: `Tidak bisa dibatalkan, status sudah: ${sj.status}.` });

    await db.query('UPDATE surat_jalan SET status=? WHERE id=?', ['batal', sj.id]);
    audit(req, 'update', 'surat_jalan', sj.id, sj.nomor, { aksi: 'batal', alasan: req.body.alasan });
    res.json({ success: true, message: `Surat jalan ${sj.nomor} dibatalkan.` });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ══════════════════════════════════════════════
// DELETE /api/surat-jalan/:id — delete (owner only, only if disiapkan)
// ══════════════════════════════════════════════
router.delete('/:id', auth(['owner']), async (req, res) => {
  try {
    const [[sj]] = await db.query('SELECT * FROM surat_jalan WHERE id=?', [req.params.id]);
    if (!sj) return res.status(404).json({ success: false, message: 'Surat jalan tidak ditemukan.' });
    if (sj.status !== 'disiapkan') return res.status(400).json({ success: false, message: `Tidak bisa dihapus, status: ${sj.status}.` });

    await db.query('DELETE FROM surat_jalan WHERE id=?', [sj.id]);
    audit(req, 'delete', 'surat_jalan', sj.id, sj.nomor, {});
    res.json({ success: true, message: `Surat jalan ${sj.nomor} dihapus.` });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
