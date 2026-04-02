const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { audit } = require('../middleware/auditLog');

const ROLE_LEVEL = {
  owner:7, manajer:6, head_operational:6, admin_pusat:5,
  spv_area:4, finance:4, kepala_cabang:3, sales:2, kasir:1, vaporista:0
};

function canManage(actorRole, targetRole) {
  if (actorRole === 'owner') return true;
  if (actorRole === targetRole) return false;
  return ROLE_LEVEL[actorRole] > ROLE_LEVEL[targetRole];
}

router.get('/', auth(['owner','manajer','head_operational','admin_pusat','spv_area']), async (req, res) => {
  try {
    const { getCabangAkses } = require('../middleware/cabangFilter');
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.role) { where += ' AND u.role=?'; params.push(req.query.role); }
    if (req.query.aktif !== undefined) { where += ' AND u.aktif=?'; params.push(parseInt(req.query.aktif)); }
    if (req.query.q) { where += ' AND (u.nama_lengkap LIKE ? OR u.username LIKE ?)'; params.push('%'+req.query.q+'%','%'+req.query.q+'%'); }
    // Manajer, head_operational, SPV Area hanya lihat staff di cabang yang dikelola
    if (['manajer','head_operational','spv_area'].includes(req.user.role)) {
      const akses = await getCabangAkses(req.user);
      if (akses !== null && akses.length > 0) {
        where += ` AND u.cabang_id IN (${akses.map(() => '?').join(',')})`;
        params.push(...akses);
      } else if (akses !== null && akses.length === 0) {
        return res.json({ success:true, data:[] });
      }
    }
    const [rows] = await db.query(
      `SELECT u.id, u.username, u.nama_lengkap, u.role, u.cabang_id, u.aktif, c.nama as nama_cabang
       FROM users u LEFT JOIN cabang c ON u.cabang_id = c.id
       ${where} ORDER BY FIELD(u.role,'owner','manajer','head_operational','admin_pusat','spv_area','finance','kepala_cabang','sales','kasir','kasir_sales','vaporista'), u.nama_lengkap`,
      params
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const { username, password, nama_lengkap, role, cabang_id } = req.body;
    if (!username||!password||!role)
      return res.status(400).json({ success:false, message:'Username, password, role wajib diisi.' });
    if (!canManage(req.user.role, role))
      return res.status(403).json({ success:false, message:`Anda tidak bisa membuat akun ${role}.` });
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO users (username, password, nama_lengkap, role, cabang_id) VALUES (?,?,?,?,?)',
      [username.toLowerCase().trim(), hash, nama_lengkap||'', role, cabang_id||null]
    );
    audit(req, 'create', 'user', result.insertId, nama_lengkap, {username, role});
    res.json({ success:true, message:'User berhasil ditambahkan.' });
  } catch(e) {
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({ success:false, message:'Username sudah digunakan.' });
    res.status(500).json({ success:false, message:e.message });
  }
});

router.patch('/:id', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const [[target]] = await db.query('SELECT role, username FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ success:false, message:'User tidak ditemukan.' });
    if (parseInt(req.params.id) !== req.user.id && !canManage(req.user.role, target.role))
      return res.status(403).json({ success:false, message:'Anda tidak bisa mengedit akun ini.' });
    const { username, nama_lengkap, cabang_id, role, aktif } = req.body;
    // Hanya owner yang bisa ubah role
    const newRole = (role && req.user.role === 'owner') ? role : target.role;
    const fields = ['username=?','nama_lengkap=?','cabang_id=?','role=?'];
    const vals   = [username||target.username, nama_lengkap||'', cabang_id||null, newRole];
    if (aktif !== undefined && req.user.role === 'owner') { fields.push('aktif=?'); vals.push(aktif); }
    vals.push(req.params.id);
    await db.query(`UPDATE users SET ${fields.join(',')} WHERE id=?`, vals);
    audit(req, 'update', 'user', req.params.id, nama_lengkap||username, {role, cabang_id, aktif});
    res.json({ success:true, message:'User berhasil diupdate.' });
  } catch(e) {
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({ success:false, message:'Username sudah digunakan.' });
    res.status(500).json({ success:false, message:e.message });
  }
});

router.patch('/:id/password', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const [[target]] = await db.query('SELECT role FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ success:false, message:'User tidak ditemukan.' });
    if (parseInt(req.params.id) !== req.user.id && !canManage(req.user.role, target.role))
      return res.status(403).json({ success:false, message:'Anda tidak bisa ganti password akun ini.' });
    const { password } = req.body;
    if (!password||password.length<6)
      return res.status(400).json({ success:false, message:'Password minimal 6 karakter.' });
    const hash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password=? WHERE id=?', [hash, req.params.id]);
    res.json({ success:true, message:'Password berhasil diubah.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.patch('/:id/status', auth(['owner','manajer','head_operational']), async (req, res) => {
  try {
    const [[target]] = await db.query('SELECT role FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ success:false, message:'User tidak ditemukan.' });
    if (!canManage(req.user.role, target.role))
      return res.status(403).json({ success:false, message:'Akses ditolak.' });
    await db.query('UPDATE users SET aktif=? WHERE id=?', [req.body.aktif, req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id)
      return res.status(400).json({ success:false, message:'Tidak bisa menghapus akun sendiri.' });
    const [[target]] = await db.query('SELECT role FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ success:false, message:'User tidak ditemukan.' });
    if (!canManage(req.user.role, target.role))
      return res.status(403).json({ success:false, message:`Anda tidak bisa menghapus akun ${target.role}.` });
    await db.query('UPDATE users SET aktif=0 WHERE id=?', [req.params.id]);
    res.json({ success:true, message:'User dinonaktifkan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;

// GET /api/users/me/nav-akses — nav override untuk user yang sedang login
router.get('/me/nav-akses', auth(), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT page_id FROM user_nav_akses WHERE user_id=?', [req.user.id]);
    const pages = rows.map(r => r.page_id);
    res.json({ success:true, has_override: pages.length > 0, pages });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/users/:id/nav-akses — nav override untuk user tertentu (owner only)
router.get('/:id/nav-akses', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT page_id FROM user_nav_akses WHERE user_id=?', [req.params.id]);
    const pages = rows.map(r => r.page_id);
    res.json({ success:true, has_override: pages.length > 0, pages });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/users/:id/nav-akses — simpan daftar halaman yang diizinkan
router.post('/:id/nav-akses', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const { pages } = req.body; // array of page_id
    if (!Array.isArray(pages)) return res.status(400).json({ success:false, message:'pages harus array.' });
    await db.query('DELETE FROM user_nav_akses WHERE user_id=?', [req.params.id]);
    if (pages.length > 0) {
      for (const page_id of pages) {
        await db.query('INSERT IGNORE INTO user_nav_akses (user_id, page_id) VALUES (?,?)', [req.params.id, page_id]);
      }
    }
    res.json({ success:true, message:'Hak akses menu disimpan.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET cabang yang dikelola manajer
router.get('/:id/cabang', auth(['owner']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.kode, c.nama FROM manajer_cabang mc
       JOIN cabang c ON mc.cabang_id = c.id
       WHERE mc.user_id = ?`, [req.params.id]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST set cabang manajer (owner only)
router.post('/:id/cabang', auth(['owner']), async (req, res) => {
  try {
    const { cabang_ids } = req.body; // array of cabang_id
    if (!Array.isArray(cabang_ids)) return res.status(400).json({ success:false, message:'cabang_ids harus array.' });
    // Hapus semua dulu lalu insert ulang
    await db.query('DELETE FROM manajer_cabang WHERE user_id=?', [req.params.id]);
    for (const cid of cabang_ids) {
      await db.query('INSERT INTO manajer_cabang (user_id, cabang_id) VALUES (?,?)', [req.params.id, cid]);
    }
    res.json({ success:true, message:`${cabang_ids.length} cabang berhasil diassign.` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/users/preview-generate - preview user yang akan digenerate dari Kerjoo
router.get('/preview-generate', auth(['owner']), async (req, res) => {
  try {
    const { kgAll } = require('../utils/kerjoo');

    // Ambil semua karyawan dan grup
    const [karyawan, grups] = await Promise.all([
      kgAll('/personnels'),
      kgAll('/groups')
    ]);
    const grpMap = {};
    grups.forEach(g => { grpMap[g.id] = g.name; });

    // Ambil user existing
    const [existingUsers] = await db.query('SELECT username, nama_lengkap FROM users');
    const existingNames = new Set(existingUsers.map(u => u.nama_lengkap?.toLowerCase()));

    // Generate preview
    const preview = karyawan.map(k => {
      const grupNama = grpMap[k.group_id] || '';
      const isGudang = grupNama.toUpperCase().includes('GUDANG');
      const isKurir  = grupNama.toUpperCase().includes('KURIR');
      const isSO     = grupNama.toUpperCase().includes('STOCK OPNAME');
      const isMgr    = grupNama.toUpperCase().includes('MANAGER');

      let role = 'vaporista';
      if (isGudang) role = 'kasir';
      if (isKurir)  role = 'kasir';
      if (isSO)     role = 'kasir';
      if (isMgr)    role = 'manajer';

      const username = k.name.toLowerCase()
        .replace(/[^a-z0-9\s]/g,'')
        .replace(/\s+/g,'')
        .substring(0, 30);

      const nik = k.pid || '';
      const sudahAda = existingNames.has(k.name.toLowerCase());

      return {
        personnel_id: k.id,
        nama        : k.name,
        grup        : grupNama,
        role,
        username,
        nik,
        sudah_ada   : sudahAda
      };
    }).filter(k => !k.sudah_ada); // hanya yang belum ada

    res.json({ success:true, data:preview, total:preview.length });
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// POST /api/users/generate-from-kerjoo - generate user dari Kerjoo
router.post('/generate-from-kerjoo', auth(['owner']), async (req, res) => {
  try {
    const { users: userList } = req.body;
    if (!userList?.length) return res.status(400).json({success:false, message:'Tidak ada data.'});

    const bcrypt = require('bcryptjs');
    let created = 0, skipped = 0;

    for (const u of userList) {
      if (!u.username || !u.nik) { skipped++; continue; }
      // Cek username sudah ada
      const [existing] = await db.query('SELECT id FROM users WHERE username=?', [u.username]);
      if (existing.length) {
        // Tambah suffix angka
        let suffix = 2;
        let newUsername = u.username + suffix;
        while (true) {
          const [ex2] = await db.query('SELECT id FROM users WHERE username=?', [newUsername]);
          if (!ex2.length) break;
          suffix++;
          newUsername = u.username + suffix;
        }
        u.username = newUsername;
      }
      const hashed = await bcrypt.hash(u.nik, 10);
      await db.query(
        'INSERT INTO users (username, password, nama_lengkap, role, cabang_id, personnel_id, aktif) VALUES (?,?,?,?,?,?,1)',
        [u.username, hashed, u.nama, u.role, u.cabang_id||null, u.personnel_id||null]
      );
      created++;
    }

    res.json({ success:true, message:`${created} user berhasil dibuat, ${skipped} dilewati.`, created, skipped });
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// GET cabang yang dikelola SPV Area
router.get('/:id/spv-cabang', auth(['owner','manajer','head_operational','admin_pusat']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.kode, c.nama FROM spv_area_cabang sc
       JOIN cabang c ON sc.cabang_id = c.id
       WHERE sc.user_id = ?`, [req.params.id]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST set cabang SPV Area (owner only)
router.post('/:id/spv-cabang', auth(['owner']), async (req, res) => {
  try {
    const { cabang_ids } = req.body;
    if (!Array.isArray(cabang_ids)) return res.status(400).json({ success:false, message:'cabang_ids harus array.' });
    await db.query('DELETE FROM spv_area_cabang WHERE user_id=?', [req.params.id]);
    for (const cid of cabang_ids) {
      await db.query('INSERT INTO spv_area_cabang (user_id, cabang_id) VALUES (?,?)', [req.params.id, cid]);
    }
    res.json({ success:true, message:`${cabang_ids.length} cabang berhasil diassign ke SPV Area.` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET cabang Manajer Area
router.get('/:id/manajer-area-cabang', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.kode, c.nama FROM manajer_area_cabang mac
       JOIN cabang c ON mac.cabang_id = c.id
       WHERE mac.user_id = ?`, [req.params.id]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST set cabang Manajer Area (owner only)
router.post('/:id/manajer-area-cabang', auth(['owner']), async (req, res) => {
  try {
    const { cabang_ids } = req.body;
    if (!Array.isArray(cabang_ids)) return res.status(400).json({ success:false, message:'cabang_ids harus array.' });
    await db.query('DELETE FROM manajer_area_cabang WHERE user_id=?', [req.params.id]);
    for (const cid of cabang_ids) {
      await db.query('INSERT INTO manajer_area_cabang (user_id, cabang_id) VALUES (?,?)', [req.params.id, cid]);
    }
    res.json({ success:true, message:`${cabang_ids.length} cabang berhasil diassign ke Manajer Area.` });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
