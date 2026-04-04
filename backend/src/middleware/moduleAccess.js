const db = require('../config/database');

// Daftar modul yang bisa dikontrol aksesnya
const MODULE_DEFS = [
  { key: 'keuntungan',         label: 'Keuntungan Cabang',        desc: 'HPP, laba kotor & bersih, margin per cabang' },
  { key: 'laba_rugi',          label: 'Laporan Laba Rugi',        desc: 'P&L konsolidasi per cabang' },
  { key: 'monitoring_omzet',   label: 'Monitoring Omzet',         desc: 'Omzet semua cabang (detail harian)' },
  { key: 'monitoring_modal',   label: 'Monitoring Modal',         desc: 'Nilai modal & persediaan per cabang' },
  { key: 'lap_per_kasir',      label: 'Omzet Per Kasir',          desc: 'Breakdown omzet per staff/kasir' },
  { key: 'lap_marketplace',    label: 'Biaya Marketplace',        desc: 'Fee Tokopedia / Shopee' },
  { key: 'payroll',            label: 'Payroll',                  desc: 'Gaji, kasbon, potongan karyawan' },
  { key: 'kas_bank',           label: 'Kas & Bank',               desc: 'Saldo rekening & mutasi kas' },
  { key: 'monitoring_deadstock',label:'Monitoring Deadstock',      desc: 'Barang lambat jual per cabang' },
];

// Cek apakah user punya akses ke modul tertentu
// Owner selalu punya akses
async function hasModuleAccess(userId, role, moduleKey) {
  if (role === 'owner') return true;
  const [[row]] = await db.query(
    'SELECT id FROM module_akses WHERE module_key=? AND user_id=?',
    [moduleKey, userId]
  );
  return !!row;
}

// Express middleware: requireModule('keuntungan')
function requireModule(moduleKey) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    const allowed = await hasModuleAccess(req.user.id, req.user.role, moduleKey);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Anda tidak memiliki akses ke modul ini.' });
    }
    next();
  };
}

module.exports = { MODULE_DEFS, hasModuleAccess, requireModule };
