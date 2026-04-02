const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// ── HELPER: kirim notifikasi ──
async function kirimNotif({user_id, role_target, tipe, judul, pesan, link}) {
  try {
    await db.query(`INSERT INTO notifikasi (user_id, role_target, tipe, judul, pesan, link) VALUES (?,?,?,?,?,?)`,
      [user_id||null, role_target||null, tipe, judul, pesan||null, link||null]);
  } catch(e) { console.error('kirimNotif:', e.message); }
}

// GET /api/notifikasi — notif untuk user login (personal + role broadcast)
router.get('/', auth(), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT * FROM notifikasi
      WHERE (user_id=? OR role_target=? OR (user_id IS NULL AND role_target IS NULL))
      ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, req.user.role]);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/notifikasi/unread-count — hitung belum dibaca
router.get('/unread-count', auth(), async (req, res) => {
  try {
    const [[{count}]] = await db.query(`
      SELECT COUNT(*) as count FROM notifikasi
      WHERE (user_id=? OR role_target=? OR (user_id IS NULL AND role_target IS NULL))
        AND dibaca=0`,
      [req.user.id, req.user.role]);
    res.json({success:true, count: parseInt(count)});
  } catch(e) { res.json({success:true, count:0}); }
});

// POST /api/notifikasi/baca/:id — tandai dibaca
router.post('/baca/:id', auth(), async (req, res) => {
  try {
    await db.query('UPDATE notifikasi SET dibaca=1 WHERE id=?', [req.params.id]);
    res.json({success:true});
  } catch(e) { res.json({success:true}); }
});

// POST /api/notifikasi/baca-semua — tandai semua dibaca
router.post('/baca-semua', auth(), async (req, res) => {
  try {
    await db.query(`UPDATE notifikasi SET dibaca=1
      WHERE (user_id=? OR role_target=? OR (user_id IS NULL AND role_target IS NULL)) AND dibaca=0`,
      [req.user.id, req.user.role]);
    res.json({success:true});
  } catch(e) { res.json({success:true}); }
});

// POST /api/notifikasi/generate — auto-generate notif + cleanup (dipanggil periodik oleh frontend owner)
router.post('/generate', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    let generated = 0;

    // ── Auto-cleanup: hapus dibaca > 7 hari, semua > 30 hari ──
    await db.query("DELETE FROM notifikasi WHERE dibaca=1 AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)").catch(()=>{});
    await db.query("DELETE FROM notifikasi WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)").catch(()=>{});

    // 1. Stok habis — notif ke owner jika ada produk stok 0 tapi punya min > 0
    const [[stokHabis]] = await db.query(`
      SELECT COUNT(DISTINCT CONCAT(p.id,'_',s.cabang_id)) as cnt
      FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.qty=0
      WHERE p.aktif=1 AND p.stok_minimum > 0`);
    if (stokHabis.cnt > 0) {
      const [[exists]] = await db.query(
        "SELECT id FROM notifikasi WHERE tipe='stok_habis' AND DATE(created_at)=? LIMIT 1", [today]);
      if (!exists) {
        await kirimNotif({role_target:'owner', tipe:'stok_habis',
          judul:`${stokHabis.cnt} produk stok habis`,
          pesan:'Ada produk dengan stok 0 yang seharusnya ada stok minimum. Cek segera.',
          link:'pg-pos-stok'});
        generated++;
      }
    }

    // 2. Request barang pending
    const [[reqPending]] = await db.query("SELECT COUNT(*) as cnt FROM request_barang WHERE status='Sedang Dicarikan'");
    if (reqPending.cnt > 0) {
      const [[exists]] = await db.query(
        "SELECT id FROM notifikasi WHERE tipe='request_masuk' AND DATE(created_at)=? LIMIT 1", [today]);
      if (!exists) {
        await kirimNotif({role_target:'owner', tipe:'request_masuk',
          judul:`${reqPending.cnt} request barang pending`,
          pesan:'Ada request barang yang belum diproses.', link:'pg-request'});
        generated++;
      }
    }

    // 3. Retur pending
    const [[returP]] = await db.query("SELECT COUNT(*) as cnt FROM retur_customer WHERE status='draft'");
    if (returP.cnt > 0) {
      const [[exists]] = await db.query(
        "SELECT id FROM notifikasi WHERE tipe='retur_pending' AND DATE(created_at)=? LIMIT 1", [today]);
      if (!exists) {
        await kirimNotif({role_target:'owner', tipe:'retur_pending',
          judul:`${returP.cnt} retur customer menunggu approval`,
          pesan:'Ada retur yang perlu disetujui atau ditolak.', link:'pg-retur'});
        generated++;
      }
    }

    // 4. Sewa jatuh tempo dalam 7 hari
    const [sewaRows] = await db.query(`
      SELECT nama FROM cabang WHERE id IN (
        SELECT cabang_id FROM sewa WHERE tgl_selesai BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND aktif=1
      )`).catch(()=>[[]]);
    if (sewaRows.length > 0) {
      const [[exists]] = await db.query(
        "SELECT id FROM notifikasi WHERE tipe='sewa_jatuh_tempo' AND DATE(created_at)=? LIMIT 1", [today]);
      if (!exists) {
        await kirimNotif({role_target:'owner', tipe:'sewa_jatuh_tempo',
          judul:`${sewaRows.length} sewa jatuh tempo dalam 7 hari`,
          pesan: sewaRows.map(s=>s.nama).join(', '), link:'pg-cabang'});
        generated++;
      }
    }

    res.json({success:true, generated});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/notifikasi/kirim — owner kirim notifikasi manual
router.post('/kirim', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { target, user_id, role_target, judul, pesan, link } = req.body;
    if (!judul) return res.status(400).json({success:false, message:'Judul wajib diisi.'});

    let sent = 0;
    if (target === 'semua') {
      // Broadcast ke semua — user_id null, role_target null
      await kirimNotif({tipe:'info', judul, pesan, link});
      sent = 1;
    } else if (target === 'role' && role_target) {
      await kirimNotif({role_target, tipe:'info', judul, pesan, link});
      sent = 1;
    } else if (target === 'user' && user_id) {
      // Kirim ke user tertentu (bisa multiple)
      const ids = Array.isArray(user_id) ? user_id : [user_id];
      for (const uid of ids) {
        await kirimNotif({user_id: uid, tipe:'info', judul, pesan, link});
        sent++;
      }
    } else if (target === 'cabang' && req.body.cabang_id) {
      // Kirim ke semua user di cabang tertentu
      const [users] = await db.query('SELECT id FROM users WHERE cabang_id=? AND aktif=1', [req.body.cabang_id]);
      for (const u of users) {
        await kirimNotif({user_id: u.id, tipe:'info', judul, pesan, link});
        sent++;
      }
    } else {
      return res.status(400).json({success:false, message:'Target tidak valid.'});
    }

    res.json({success:true, message:`Notifikasi terkirim ke ${sent} target.`});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

module.exports = router;
module.exports.kirimNotif = kirimNotif;
