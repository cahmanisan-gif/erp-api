const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// Helper: ambil setting loyalty
async function getSetting(key) {
  const [[r]] = await db.query('SELECT value FROM member_setting WHERE key_name=?', [key]);
  return r?.value || null;
}
async function getAllSettings() {
  const [rows] = await db.query('SELECT key_name, value FROM member_setting');
  const s = {};
  rows.forEach(r => { s[r.key_name] = r.value; });
  return s;
}

// Helper: update tier berdasarkan total poin earned
async function updateTier(memberId) {
  const s = await getAllSettings();
  const [[m]] = await db.query('SELECT total_poin, poin_dipakai FROM member WHERE id=?', [memberId]);
  if (!m) return;
  const totalEarned = (m.total_poin||0) + (m.poin_dipakai||0); // lifetime poin earned
  let tier = 'bronze';
  if (totalEarned >= parseInt(s.tier_platinum||5000)) tier = 'platinum';
  else if (totalEarned >= parseInt(s.tier_gold||2000)) tier = 'gold';
  else if (totalEarned >= parseInt(s.tier_silver||500)) tier = 'silver';
  await db.query('UPDATE member SET tier=? WHERE id=?', [tier, memberId]);
}

// GET /api/member/search?q= — cari member by HP/nama (untuk kasir)
router.get('/search', auth(), async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 3) return res.json({success:true, data:[]});
    const [rows] = await db.query(
      `SELECT id, no_hp, nama, tier, total_poin, total_belanja, total_transaksi FROM member
       WHERE aktif=1 AND (no_hp LIKE ? OR nama LIKE ?) LIMIT 10`,
      ['%'+q+'%', '%'+q+'%']);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/member/:id — detail member + log poin terakhir
router.get('/:id', auth(), async (req, res) => {
  try {
    const [[m]] = await db.query('SELECT * FROM member WHERE id=?', [req.params.id]);
    if (!m) return res.status(404).json({success:false,message:'Member tidak ditemukan.'});
    const [logs] = await db.query('SELECT * FROM member_poin_log WHERE member_id=? ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    res.json({success:true, data:{...m, poin_log:logs}});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/member — register member baru (dari kasir)
router.post('/', auth(), async (req, res) => {
  try {
    const { no_hp, nama } = req.body;
    if (!no_hp || !nama) return res.status(400).json({success:false,message:'No HP dan nama wajib.'});
    const hp = no_hp.replace(/\D/g,'');
    const [[exists]] = await db.query('SELECT id,nama FROM member WHERE no_hp=?', [hp]);
    if (exists) return res.json({success:true, message:'Member sudah terdaftar.', data:exists, existing:true});

    const [ins] = await db.query('INSERT INTO member (no_hp, nama, cabang_daftar) VALUES (?,?,?)',
      [hp, nama.trim(), req.user.cabang_id||null]);
    res.json({success:true, message:'Member baru terdaftar!', data:{id:ins.insertId, no_hp:hp, nama:nama.trim(), tier:'bronze', total_poin:0}});
  } catch(e) {
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({success:false,message:'No HP sudah terdaftar.'});
    res.status(500).json({success:false,message:e.message});
  }
});

// POST /api/member/earn — tambah poin dari transaksi
router.post('/earn', auth(), async (req, res) => {
  try {
    const { member_id, transaksi_id, total_belanja, cabang_id } = req.body;
    if (!member_id) return res.json({success:true, poin_earned:0});
    const s = await getAllSettings();

    const minBelanja = parseInt(s.min_belanja_poin||50000);
    if (total_belanja < minBelanja) return res.json({success:true, poin_earned:0, message:`Min belanja ${minBelanja} untuk dapat poin.`});

    const perRupiah = parseInt(s.poin_per_rupiah||10000);
    let poin = Math.floor(total_belanja / perRupiah);

    // Bonus tier
    const [[m]] = await db.query('SELECT tier FROM member WHERE id=?', [member_id]);
    if (m) {
      const bonusMap = {silver:parseInt(s.bonus_poin_silver||10), gold:parseInt(s.bonus_poin_gold||20), platinum:parseInt(s.bonus_poin_platinum||50)};
      const bonus = bonusMap[m.tier] || 0;
      if (bonus > 0) poin += Math.floor(poin * bonus / 100);
    }

    if (poin <= 0) return res.json({success:true, poin_earned:0});

    // Update member
    await db.query('UPDATE member SET total_poin=total_poin+?, total_belanja=total_belanja+?, total_transaksi=total_transaksi+1 WHERE id=?',
      [poin, total_belanja, member_id]);

    // Log
    const [[after]] = await db.query('SELECT total_poin FROM member WHERE id=?', [member_id]);
    await db.query(`INSERT INTO member_poin_log (member_id,tipe,poin,saldo_setelah,transaksi_id,keterangan,cabang_id,created_by)
      VALUES (?,'earn',?,?,?,?,?,?)`,
      [member_id, poin, after.total_poin, transaksi_id, `Belanja ${Math.round(total_belanja).toLocaleString('id-ID')}`, cabang_id, req.user.id]);

    // Update tier
    await updateTier(member_id);

    res.json({success:true, poin_earned:poin, total_poin:after.total_poin});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/member/redeem — pakai poin sebagai diskon
router.post('/redeem', auth(), async (req, res) => {
  try {
    const { member_id, poin_pakai } = req.body;
    if (!member_id || !poin_pakai || poin_pakai <= 0)
      return res.status(400).json({success:false,message:'Member dan jumlah poin wajib.'});

    const s = await getAllSettings();
    const minRedeem = parseInt(s.min_redeem||100);
    if (poin_pakai < minRedeem) return res.status(400).json({success:false,message:`Minimum redeem ${minRedeem} poin.`});

    const [[m]] = await db.query('SELECT total_poin FROM member WHERE id=?', [member_id]);
    if (!m || m.total_poin < poin_pakai)
      return res.status(400).json({success:false,message:'Poin tidak cukup.'});

    const nilaiPerPoin = parseInt(s.nilai_redeem_per_poin||1000);
    const diskon = poin_pakai * nilaiPerPoin;

    // Kurangi poin
    await db.query('UPDATE member SET total_poin=total_poin-?, poin_dipakai=poin_dipakai+? WHERE id=?',
      [poin_pakai, poin_pakai, member_id]);

    const [[after]] = await db.query('SELECT total_poin FROM member WHERE id=?', [member_id]);
    await db.query(`INSERT INTO member_poin_log (member_id,tipe,poin,saldo_setelah,keterangan,cabang_id,created_by)
      VALUES (?,'redeem',?,?,?,?,?)`,
      [member_id, -poin_pakai, after.total_poin, `Redeem ${poin_pakai} poin = Rp ${diskon.toLocaleString('id-ID')}`, req.user.cabang_id, req.user.id]);

    res.json({success:true, diskon, poin_sisa:after.total_poin, message:`${poin_pakai} poin ditukar = diskon Rp ${diskon.toLocaleString('id-ID')}`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/member — list semua member (management)
router.get('/', auth(), async (req, res) => {
  try {
    const { tier, q } = req.query;
    let where = 'aktif=1';
    const params = [];
    if (tier) { where += ' AND tier=?'; params.push(tier); }
    if (q) { where += ' AND (nama LIKE ? OR no_hp LIKE ?)'; params.push('%'+q+'%','%'+q+'%'); }
    const [rows] = await db.query(`SELECT * FROM member WHERE ${where} ORDER BY total_belanja DESC LIMIT 200`, params);
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/member/settings — setting loyalty
router.get('/settings/all', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const s = await getAllSettings();
    res.json({success:true, data:s});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/member/settings — update settings
router.patch('/settings', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await db.query('INSERT INTO member_setting (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?', [k, v, v]);
    }
    res.json({success:true, message:'Setting loyalty disimpan.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
