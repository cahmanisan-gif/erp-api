const db = require('../config/database');

/**
 * Log aksi ke audit_log
 * @param {object} req - Express request (untuk user info + IP)
 * @param {string} aksi - create/update/delete/approve/reject/batal
 * @param {string} modul - produk/stok/transaksi/retur/user/pembelian/dll
 * @param {string|number} targetId - ID record
 * @param {string} targetLabel - Nama/deskripsi record
 * @param {object} detail - Data tambahan (before/after, keterangan)
 */
async function audit(req, aksi, modul, targetId, targetLabel, detail) {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || null;
    await db.query(
      `INSERT INTO audit_log (user_id, user_nama, user_role, cabang_id, aksi, modul, target_id, target_label, detail, ip_address)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user?.id || 0,
        req.user?.nama_lengkap || req.user?.username || '-',
        req.user?.role || '-',
        req.user?.cabang_id || null,
        aksi, modul,
        String(targetId || ''),
        (targetLabel || '').slice(0, 200),
        detail ? JSON.stringify(detail) : null,
        ip
      ]
    );
  } catch(e) {
    console.error('audit_log error:', e.message);
  }
}

module.exports = { audit };
