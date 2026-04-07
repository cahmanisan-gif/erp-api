const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

// ── APPROVAL RULES (hardcoded) ──
const APPROVAL_RULES = [
  { modul: 'pengeluaran',   kondisi: 'nominal > 500000',   label: 'Pengeluaran di atas Rp 500.000' },
  { modul: 'diskon',        kondisi: 'persen > 15',        label: 'Diskon di atas 15%' },
  { modul: 'retur',         kondisi: 'nominal > 1000000',  label: 'Retur di atas Rp 1.000.000' },
  { modul: 'transfer_stok', kondisi: 'selalu',             label: 'Transfer stok (selalu butuh approval)' },
];

const APPROVE_ROLES = ['owner', 'manajer', 'head_operational', 'admin_pusat'];

// ── GET /api/approval ──
// List approvals with filters: ?status=pending&modul=pengeluaran&cabang_id=6
router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];

    if (req.query.status)    { where += ' AND a.status=?';    params.push(req.query.status); }
    if (req.query.modul)     { where += ' AND a.modul=?';     params.push(req.query.modul); }
    if (req.query.cabang_id) { where += ' AND a.cabang_id=?'; params.push(parseInt(req.query.cabang_id)); }

    const [rows] = await db.query(
      `SELECT a.*,
              u1.nama_lengkap AS nama_pengaju,
              u2.nama_lengkap AS nama_pemroses,
              c.nama AS nama_cabang
       FROM approval a
       LEFT JOIN users u1 ON u1.id = a.diajukan_oleh
       LEFT JOIN users u2 ON u2.id = a.diproses_oleh
       LEFT JOIN cabang c  ON c.id  = a.cabang_id
       ${where}
       ORDER BY a.waktu_ajuan DESC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/approval/count ──
// Count pending approvals grouped by modul (for notification badge)
router.get('/count', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT modul, COUNT(*) AS jumlah
       FROM approval
       WHERE status = 'pending'
       GROUP BY modul`
    );

    const total = rows.reduce((s, r) => s + r.jumlah, 0);
    res.json({ success: true, data: { total, per_modul: rows } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/approval/rules ──
// Return hardcoded approval rules
router.get('/rules', auth(), async (req, res) => {
  res.json({ success: true, data: APPROVAL_RULES });
});

// ── POST /api/approval ──
// Create new approval request
router.post('/', auth(), async (req, res) => {
  try {
    const { modul, ref_id, ref_nomor, deskripsi, nominal, cabang_id } = req.body;

    if (!modul || !deskripsi) {
      return res.status(400).json({ success: false, message: 'Modul dan deskripsi wajib diisi.' });
    }

    const [result] = await db.query(
      `INSERT INTO approval (modul, ref_id, ref_nomor, deskripsi, nominal, cabang_id, diajukan_oleh)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [modul, ref_id || null, ref_nomor || null, deskripsi, nominal || 0, cabang_id || null, req.user.id]
    );

    await audit(req, 'create', 'approval', result.insertId, `Pengajuan ${modul}`, {
      modul, ref_id, ref_nomor, nominal, cabang_id
    });

    res.json({ success: true, message: 'Pengajuan approval berhasil.', id: result.insertId });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /api/approval/:id/approve ──
router.patch('/:id/approve', auth(APPROVE_ROLES), async (req, res) => {
  try {
    const { catatan_approval } = req.body;
    const id = parseInt(req.params.id);

    const [[row]] = await db.query('SELECT * FROM approval WHERE id=?', [id]);
    if (!row) return res.status(404).json({ success: false, message: 'Approval tidak ditemukan.' });
    if (row.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Approval sudah ${row.status}.` });
    }

    await db.query(
      `UPDATE approval
       SET status = 'approved', diproses_oleh = ?, catatan_approval = ?, waktu_proses = NOW()
       WHERE id = ?`,
      [req.user.id, catatan_approval || null, id]
    );

    await audit(req, 'approve', 'approval', id, `Approve ${row.modul} — ${row.ref_nomor || row.deskripsi}`, {
      modul: row.modul, ref_id: row.ref_id, nominal: row.nominal, catatan_approval
    });

    res.json({ success: true, message: 'Approval disetujui.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /api/approval/:id/reject ──
router.patch('/:id/reject', auth(APPROVE_ROLES), async (req, res) => {
  try {
    const { catatan_approval } = req.body;
    const id = parseInt(req.params.id);

    const [[row]] = await db.query('SELECT * FROM approval WHERE id=?', [id]);
    if (!row) return res.status(404).json({ success: false, message: 'Approval tidak ditemukan.' });
    if (row.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Approval sudah ${row.status}.` });
    }

    await db.query(
      `UPDATE approval
       SET status = 'rejected', diproses_oleh = ?, catatan_approval = ?, waktu_proses = NOW()
       WHERE id = ?`,
      [req.user.id, catatan_approval || null, id]
    );

    await audit(req, 'reject', 'approval', id, `Reject ${row.modul} — ${row.ref_nomor || row.deskripsi}`, {
      modul: row.modul, ref_id: row.ref_id, nominal: row.nominal, catatan_approval
    });

    res.json({ success: true, message: 'Approval ditolak.' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
