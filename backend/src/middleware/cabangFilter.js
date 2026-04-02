const db = require('../config/database');

// Mengembalikan array cabang_id yang boleh diakses user
async function getCabangAkses(user) {
  // Owner & admin_pusat = semua cabang
  if (['owner','admin_pusat','finance'].includes(user.role)) return null; // null = semua

  // Manajer & head_operational = cabang yang diassign via manajer_cabang
  // Fallback ke cabang_id sendiri jika belum ada assignment
  if (['manajer','head_operational'].includes(user.role)) {
    const [rows] = await db.query(
      'SELECT cabang_id FROM manajer_cabang WHERE user_id=?', [user.id]
    );
    if (rows.length > 0) return rows.map(r => r.cabang_id);
    if (user.cabang_id) return [user.cabang_id];
    return [];
  }

  // Manajer Area = cabang yang diassign via manajer_area_cabang
  if (user.role === 'manajer_area') {
    const [rows] = await db.query(
      'SELECT cabang_id FROM manajer_area_cabang WHERE user_id=?', [user.id]
    );
    if (rows.length > 0) return rows.map(r => r.cabang_id);
    if (user.cabang_id) return [user.cabang_id];
    return [];
  }

  // SPV Area = cabang yang diassign via spv_area_cabang
  if (user.role === 'spv_area') {
    const [rows] = await db.query(
      'SELECT cabang_id FROM spv_area_cabang WHERE user_id=?', [user.id]
    );
    return rows.map(r => r.cabang_id);
  }

  // Kepala cabang, sales, kasir = cabang sendiri
  if (user.cabang_id) return [user.cabang_id];

  return [];
}

module.exports = { getCabangAkses };
