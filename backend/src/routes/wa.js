const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const { sendWA, sendWATemplate, getSettings, clearSettingsCache } = require('../utils/whatsapp');

const OWNER_ROLES = ['owner', 'admin_pusat'];

// ════════════════════════════════════════════════════════════
// GET /api/wa/settings — get all wa_setting (owner only)
// ════════════════════════════════════════════════════════════
router.get('/settings', auth(OWNER_ROLES), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM wa_setting ORDER BY id');
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
// PATCH /api/wa/settings — update settings (owner only)
// body: { settings: [ {key_name, value}, ... ] }
// ════════════════════════════════════════════════════════════
router.patch('/settings', auth(OWNER_ROLES), async (req, res) => {
  try {
    const { settings } = req.body;
    if (!Array.isArray(settings) || !settings.length) {
      return res.status(400).json({ success: false, message: 'Data settings tidak valid.' });
    }

    let updated = 0;
    for (const s of settings) {
      if (!s.key_name) continue;
      const [result] = await db.query(
        'UPDATE wa_setting SET value=? WHERE key_name=?',
        [String(s.value ?? ''), s.key_name]
      );
      if (result.affectedRows) updated++;
    }

    clearSettingsCache();
    res.json({ success: true, message: `${updated} setting diperbarui.`, updated });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
// GET /api/wa/log — list WA logs with filters + pagination
// query: tipe, status, dari (date), sampai (date), page, limit
// ════════════════════════════════════════════════════════════
router.get('/log', auth(OWNER_ROLES), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    let where = '1=1';
    const params = [];

    if (req.query.tipe) { where += ' AND tipe=?'; params.push(req.query.tipe); }
    if (req.query.status) { where += ' AND status=?'; params.push(req.query.status); }
    if (req.query.dari) { where += ' AND DATE(created_at) >= ?'; params.push(req.query.dari); }
    if (req.query.sampai) { where += ' AND DATE(created_at) <= ?'; params.push(req.query.sampai); }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM wa_log WHERE ${where}`, params
    );

    const [rows] = await db.query(
      `SELECT * FROM wa_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) }
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
// POST /api/wa/send — manual send WA (owner only)
// body: { tujuan, pesan }
// ════════════════════════════════════════════════════════════
router.post('/send', auth(OWNER_ROLES), async (req, res) => {
  try {
    const { tujuan, pesan } = req.body;
    if (!tujuan || !pesan) {
      return res.status(400).json({ success: false, message: 'Tujuan dan pesan wajib diisi.' });
    }

    const result = await sendWA(tujuan, pesan, { tipe: 'info' });
    res.json({
      success: result.success,
      message: result.success ? 'Pesan terkirim.' : `Gagal: ${result.response}`,
      logId: result.logId,
      status: result.status
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
// POST /api/wa/test — send test message to owner's own number
// ════════════════════════════════════════════════════════════
router.post('/test', auth(OWNER_ROLES), async (req, res) => {
  try {
    // Get owner's phone from users table
    const [[user]] = await db.query('SELECT no_hp FROM users WHERE id=?', [req.user.id]);
    if (!user || !user.no_hp) {
      return res.status(400).json({
        success: false,
        message: 'Nomor HP kamu belum diisi. Update di profil dulu.'
      });
    }

    const pesan = `[TEST] WhatsApp Gateway Raja Vapor aktif!\nWaktu: ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`;
    const result = await sendWA(user.no_hp, pesan, { tipe: 'info' });

    res.json({
      success: result.success,
      message: result.success
        ? `Pesan test terkirim ke ${user.no_hp}`
        : `Gagal kirim: ${typeof result.response === 'string' ? result.response : JSON.stringify(result.response)}`,
      logId: result.logId,
      status: result.status
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
// POST /api/wa/broadcast — send to multiple users by role or cabang_id
// body: { pesan, role?, cabang_id? }
// ════════════════════════════════════════════════════════════
router.post('/broadcast', auth(OWNER_ROLES), async (req, res) => {
  try {
    const { pesan, role, cabang_id } = req.body;
    if (!pesan) {
      return res.status(400).json({ success: false, message: 'Pesan wajib diisi.' });
    }

    let where = 'aktif=1 AND no_hp IS NOT NULL AND no_hp != ""';
    const params = [];

    if (role) { where += ' AND role=?'; params.push(role); }
    if (cabang_id) { where += ' AND cabang_id=?'; params.push(parseInt(cabang_id)); }

    const [users] = await db.query(`SELECT id, no_hp, nama_lengkap FROM users WHERE ${where}`, params);

    if (!users.length) {
      return res.status(400).json({ success: false, message: 'Tidak ada user dengan nomor HP yang sesuai filter.' });
    }

    let sent = 0, failed = 0;
    for (const u of users) {
      const result = await sendWA(u.no_hp, `[RAJA VAPOR]\n\n${pesan}`, { tipe: 'broadcast' });
      if (result.success) sent++; else failed++;
    }

    res.json({
      success: true,
      message: `Broadcast selesai. Terkirim: ${sent}, Gagal: ${failed}, Total: ${users.length}`,
      sent, failed, total: users.length
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ════════════════════════════════════════════════════════════
// POST /api/wa/generate-alerts — auto-generate & send pending alerts
//   1. Stok kritis → WA ke kepala_cabang
//   2. Sewa jatuh tempo (<=7 hari) → WA ke owner
//   3. Target belum 50% di tanggal 20+ → WA ke kasir/vaporista
// ════════════════════════════════════════════════════════════
router.post('/generate-alerts', auth(OWNER_ROLES), async (req, res) => {
  try {
    const settings = await getSettings();
    const today = new Date().toISOString().slice(0, 10);
    const dayOfMonth = new Date().getDate();
    let totalSent = 0, totalFailed = 0, alerts = [];

    // ─── 1. STOK KRITIS ───
    if (settings.alert_stok_kritis === '1') {
      const [stokRows] = await db.query(`
        SELECT s.cabang_id, c.nama as cabang_nama,
               p.id as produk_id, p.nama_produk, s.qty, p.stok_minimum
        FROM pos_stok s
        JOIN pos_produk p ON s.produk_id = p.id AND p.aktif = 1
        JOIN cabang c ON s.cabang_id = c.id
        WHERE s.qty <= p.stok_minimum AND p.stok_minimum > 0
        ORDER BY s.cabang_id, p.nama_produk
      `).catch(() => [[]]);

      // Group by cabang
      const byCabang = {};
      stokRows.forEach(r => {
        if (!byCabang[r.cabang_id]) byCabang[r.cabang_id] = { cabang: r.cabang_nama, items: [] };
        byCabang[r.cabang_id].items.push({ nama: r.nama_produk, qty: r.qty, minimum: r.stok_minimum });
      });

      for (const [cabangId, data] of Object.entries(byCabang)) {
        // Check if already sent today for this cabang
        const [[exists]] = await db.query(
          `SELECT id FROM wa_log WHERE ref_type='stok' AND ref_id=? AND DATE(created_at)=? AND status IN ('sent','disabled','pending') LIMIT 1`,
          [parseInt(cabangId), today]
        );
        if (exists) continue;

        // Find kepala_cabang for this branch
        const [kcUsers] = await db.query(
          `SELECT no_hp FROM users WHERE cabang_id=? AND role='kepala_cabang' AND aktif=1 AND no_hp IS NOT NULL AND no_hp != ''`,
          [parseInt(cabangId)]
        );

        // Limit items to 10 per message to avoid huge messages
        const limitedData = { ...data, items: data.items.slice(0, 10) };
        if (data.items.length > 10) {
          limitedData.items.push({ nama: `...dan ${data.items.length - 10} produk lainnya`, qty: '-', minimum: '-' });
        }

        if (kcUsers.length) {
          for (const kc of kcUsers) {
            const r = await sendWATemplate(kc.no_hp, 'stok_kritis', limitedData, { ref_type: 'stok', ref_id: parseInt(cabangId) });
            if (r.success) totalSent++; else totalFailed++;
          }
          alerts.push(`Stok kritis ${data.cabang}: ${data.items.length} produk`);
        }
      }
    }

    // ─── 2. SEWA JATUH TEMPO ───
    if (settings.alert_sewa_jatuh_tempo === '1') {
      const [sewaRows] = await db.query(`
        SELECT s.id, s.cabang_id, c.nama as cabang_nama, s.jenis, s.tgl_selesai,
               DATEDIFF(s.tgl_selesai, CURDATE()) as sisa_hari
        FROM sewa_cabang s
        JOIN cabang c ON s.cabang_id = c.id
        WHERE s.tgl_selesai BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)
          AND s.status != 'selesai'
      `).catch(() => [[]]);

      // Get owner phone(s)
      const [owners] = await db.query(
        `SELECT no_hp FROM users WHERE role='owner' AND aktif=1 AND no_hp IS NOT NULL AND no_hp != ''`
      );

      for (const sewa of sewaRows) {
        const [[exists]] = await db.query(
          `SELECT id FROM wa_log WHERE ref_type='sewa' AND ref_id=? AND DATE(created_at)=? AND status IN ('sent','disabled','pending') LIMIT 1`,
          [sewa.id, today]
        );
        if (exists) continue;

        for (const o of owners) {
          const r = await sendWATemplate(o.no_hp, 'sewa_jatuh_tempo', {
            cabang: sewa.cabang_nama,
            jenis: sewa.jenis || 'Sewa Ruko',
            tgl_selesai: sewa.tgl_selesai,
            sisa_hari: sewa.sisa_hari
          }, { ref_type: 'sewa', ref_id: sewa.id });
          if (r.success) totalSent++; else totalFailed++;
        }
        alerts.push(`Sewa ${sewa.cabang_nama}: ${sewa.sisa_hari} hari lagi`);
      }
    }

    // ─── 3. TARGET BELUM 50% DI TANGGAL 20+ ───
    if (dayOfMonth >= 20) {
      const bulan = new Date().getMonth() + 1;
      const tahun = new Date().getFullYear();
      const bulanStr = `${tahun}-${String(bulan).padStart(2, '0')}`;

      // Get targets with user info
      const [targetRows] = await db.query(`
        SELECT t.*, u.no_hp, u.nama_lengkap, u.role
        FROM target_sales t
        JOIN users u ON t.sales_id = u.id AND u.aktif = 1
        WHERE t.bulan = ? AND t.tahun = ?
          AND u.no_hp IS NOT NULL AND u.no_hp != ''
      `, [bulan, tahun]).catch(() => [[]]);

      for (const t of targetRows) {
        // Get actual pencapaian from invoice + POS
        const [[inv]] = await db.query(
          `SELECT COALESCE(SUM(total),0) as omzet FROM invoice
           WHERE sales_id=? AND status IN ('diterbitkan','lunas') AND tanggal LIKE ?`,
          [t.sales_id, bulanStr + '%']
        ).catch(() => [[{ omzet: 0 }]]);

        const tercapai = parseFloat(inv.omzet || 0);
        const target = parseFloat(t.target_nominal || 0);
        if (target <= 0) continue;

        const persen = Math.round((tercapai / target) * 100);
        if (persen >= 50) continue; // On track, skip

        // Check if already sent today
        const [[exists]] = await db.query(
          `SELECT id FROM wa_log WHERE ref_type='target' AND ref_id=? AND DATE(created_at)=? AND status IN ('sent','disabled','pending') LIMIT 1`,
          [t.id, today]
        );
        if (exists) continue;

        const r = await sendWATemplate(t.no_hp, 'target_warning', {
          nama: t.nama_lengkap,
          persen,
          tercapai: tercapai.toLocaleString('id-ID'),
          target: target.toLocaleString('id-ID'),
          tanggal: dayOfMonth
        }, { ref_type: 'target', ref_id: t.id });

        if (r.success) totalSent++; else totalFailed++;
        alerts.push(`Target ${t.nama_lengkap}: ${persen}%`);
      }
    }

    res.json({
      success: true,
      message: `Alert selesai. Terkirim: ${totalSent}, Gagal: ${totalFailed}`,
      sent: totalSent, failed: totalFailed,
      alerts
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
