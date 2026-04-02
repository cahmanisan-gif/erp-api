const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const upload = multer({ dest: '/tmp/', limits:{fileSize:2*1024*1024} });

// GET /api/pos-settings - ambil semua settings
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT key_name, value FROM pos_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key_name] = r.value; });
    res.json({ success:true, data:settings });
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/pos-settings - update settings
router.patch('/', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, val] of Object.entries(updates)) {
      await db.query('INSERT INTO pos_settings (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?', [key, val, val]);
    }
    res.json({success:true, message:'Settings disimpan.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos-settings/upload-logo - upload logo struk
router.post('/upload-logo', auth(['owner','admin_pusat']), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.jpg','.jpeg','.png','.gif'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({success:false,message:'Format harus JPG atau PNG.'});
    }
    const dest = '/var/www/rajavavapor/uploads/struk_logo'+ext;
    fs.renameSync(req.file.path, dest);
    const logoUrl = '/uploads/struk_logo'+ext;
    await db.query('INSERT INTO pos_settings (key_name,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=?', ['struk_logo', logoUrl, logoUrl]);
    res.json({success:true, message:'Logo diupload.', url:logoUrl});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── STRUK PER-USER ──
// GET /api/pos-settings/struk/my — ambil struk setting user yg login (fallback ke global)
router.get('/struk/my', auth(), async (req, res) => {
  try {
    const [[personal]] = await db.query('SELECT * FROM user_struk_settings WHERE user_id=?', [req.user.id]);
    if (personal) {
      // Fallback logo ke global jika personal belum upload
      let logo = personal.struk_logo;
      if (!logo) {
        const [[globalLogo]] = await db.query("SELECT value FROM pos_settings WHERE key_name='struk_logo'");
        logo = globalLogo?.value || null;
      }
      return res.json({success:true, data:{
        struk_header: personal.struk_header,
        struk_footer: personal.struk_footer,
        struk_logo: logo,
        struk_show_logo: personal.struk_show_logo ? '1' : '0',
        is_personal: true
      }});
    }
    // Fallback ke global
    const [rows] = await db.query("SELECT key_name, value FROM pos_settings WHERE key_name IN ('struk_header','struk_footer','struk_logo','struk_show_logo')");
    const settings = {};
    rows.forEach(r => { settings[r.key_name] = r.value; });
    settings.is_personal = false;
    res.json({success:true, data:settings});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/pos-settings/struk/my — simpan struk setting pribadi
router.patch('/struk/my', auth(), async (req, res) => {
  try {
    const {struk_header, struk_footer, struk_show_logo} = req.body;
    await db.query(`INSERT INTO user_struk_settings (user_id, struk_header, struk_footer, struk_show_logo)
      VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE struk_header=VALUES(struk_header), struk_footer=VALUES(struk_footer), struk_show_logo=VALUES(struk_show_logo)`,
      [req.user.id, struk_header||'', struk_footer||'', struk_show_logo==='1'?1:0]);
    res.json({success:true, message:'Setting struk pribadi disimpan.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos-settings/struk/my/upload-logo — upload logo struk pribadi
router.post('/struk/my/upload-logo', auth(), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.jpg','.jpeg','.png','.gif'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({success:false,message:'Format harus JPG atau PNG.'});
    }
    const dir = '/var/www/rajavavapor/uploads/struk_logo_user';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
    const filename = 'user_'+req.user.id+'_'+Date.now()+ext;
    const dest = path.join(dir, filename);
    fs.renameSync(req.file.path, dest);
    const logoUrl = '/uploads/struk_logo_user/'+filename;
    // Hapus logo lama jika ada
    const [[old]] = await db.query('SELECT struk_logo FROM user_struk_settings WHERE user_id=?', [req.user.id]);
    if (old?.struk_logo) {
      const oldPath = '/var/www/rajavavapor'+old.struk_logo;
      if (fs.existsSync(oldPath) && oldPath.includes('struk_logo_user')) fs.unlinkSync(oldPath);
    }
    await db.query(`INSERT INTO user_struk_settings (user_id, struk_logo) VALUES (?,?)
      ON DUPLICATE KEY UPDATE struk_logo=VALUES(struk_logo)`, [req.user.id, logoUrl]);
    res.json({success:true, message:'Logo diupload.', url:logoUrl});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/pos-settings/struk/my/logo — hapus logo struk pribadi
router.delete('/struk/my/logo', auth(), async (req, res) => {
  try {
    const [[old]] = await db.query('SELECT struk_logo FROM user_struk_settings WHERE user_id=?', [req.user.id]);
    if (old?.struk_logo) {
      const oldPath = '/var/www/rajavavapor'+old.struk_logo;
      if (fs.existsSync(oldPath) && oldPath.includes('struk_logo_user')) fs.unlinkSync(oldPath);
    }
    await db.query('UPDATE user_struk_settings SET struk_logo=NULL WHERE user_id=?', [req.user.id]);
    res.json({success:true, message:'Logo dihapus.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/pos-settings/struk/reset — reset ke global (hapus setting pribadi)
router.patch('/struk/reset', auth(), async (req, res) => {
  try {
    const [[old]] = await db.query('SELECT struk_logo FROM user_struk_settings WHERE user_id=?', [req.user.id]);
    if (old?.struk_logo) {
      const oldPath = '/var/www/rajavavapor'+old.struk_logo;
      if (fs.existsSync(oldPath) && oldPath.includes('struk_logo_user')) fs.unlinkSync(oldPath);
    }
    await db.query('DELETE FROM user_struk_settings WHERE user_id=?', [req.user.id]);
    res.json({success:true, message:'Setting struk direset ke default.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos-settings/struk/user/:user_id — admin lihat struk setting user lain
router.get('/struk/user/:user_id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [[personal]] = await db.query('SELECT * FROM user_struk_settings WHERE user_id=?', [req.params.user_id]);
    // Include global logo as fallback reference
    const [[globalLogo]] = await db.query("SELECT value FROM pos_settings WHERE key_name='struk_logo'");
    const data = personal ? {
      struk_header: personal.struk_header,
      struk_footer: personal.struk_footer,
      struk_logo: personal.struk_logo || globalLogo?.value || null,
      struk_logo_personal: personal.struk_logo || null,
      struk_show_logo: personal.struk_show_logo ? 1 : 0,
    } : null;
    res.json({success:true, data, global_logo: globalLogo?.value || null});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// PATCH /api/pos-settings/struk/user/:user_id — admin set struk untuk user lain
router.patch('/struk/user/:user_id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const {struk_header, struk_footer, struk_show_logo} = req.body;
    await db.query(`INSERT INTO user_struk_settings (user_id, struk_header, struk_footer, struk_show_logo)
      VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE struk_header=VALUES(struk_header), struk_footer=VALUES(struk_footer), struk_show_logo=VALUES(struk_show_logo)`,
      [req.params.user_id, struk_header||'', struk_footer||'', struk_show_logo?1:0]);
    res.json({success:true, message:'Setting struk user disimpan.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos-settings/struk/user/:user_id/upload-logo — admin upload logo untuk user lain
router.post('/struk/user/:user_id/upload-logo', auth(['owner','admin_pusat']), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({success:false,message:'File wajib.'});
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.jpg','.jpeg','.png','.gif'].includes(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({success:false,message:'Format harus JPG atau PNG.'});
    }
    const dir = '/var/www/rajavavapor/uploads/struk_logo_user';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true});
    const filename = 'user_'+req.params.user_id+'_'+Date.now()+ext;
    const dest = path.join(dir, filename);
    fs.renameSync(req.file.path, dest);
    const logoUrl = '/uploads/struk_logo_user/'+filename;
    // Hapus logo lama
    const [[old]] = await db.query('SELECT struk_logo FROM user_struk_settings WHERE user_id=?', [req.params.user_id]);
    if (old?.struk_logo && old.struk_logo.includes('struk_logo_user')) {
      const oldPath = '/var/www/rajavavapor'+old.struk_logo;
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await db.query(`INSERT INTO user_struk_settings (user_id, struk_logo) VALUES (?,?)
      ON DUPLICATE KEY UPDATE struk_logo=VALUES(struk_logo)`, [req.params.user_id, logoUrl]);
    res.json({success:true, message:'Logo diupload.', url:logoUrl});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// DELETE /api/pos-settings/struk/user/:user_id — admin reset struk user ke global
router.delete('/struk/user/:user_id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const [[old]] = await db.query('SELECT struk_logo FROM user_struk_settings WHERE user_id=?', [req.params.user_id]);
    if (old?.struk_logo && old.struk_logo.includes('struk_logo_user')) {
      const oldPath = '/var/www/rajavavapor'+old.struk_logo;
      if (fs.existsSync(oldPath)) try { fs.unlinkSync(oldPath); } catch(_){}
    }
    await db.query('DELETE FROM user_struk_settings WHERE user_id=?', [req.params.user_id]);
    res.json({success:true, message:'Setting struk user direset ke default.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── PERMISSIONS ──
// GET /api/pos-settings/permissions/:user_id
router.get('/permissions/:user_id', auth(['owner','admin_pusat','head_operational']), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT permission, granted FROM user_permissions WHERE user_id=?', [req.params.user_id]);
    const perms = {};
    rows.forEach(r => { perms[r.permission] = r.granted; });
    res.json({success:true, data:perms});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// POST /api/pos-settings/permissions/:user_id - set permissions
router.post('/permissions/:user_id', auth(['owner','head_operational']), async (req, res) => {
  try {
    const { permissions } = req.body; // {perm_name: 0/1}
    await db.query('DELETE FROM user_permissions WHERE user_id=?', [req.params.user_id]);
    for (const [perm, granted] of Object.entries(permissions)) {
      if (granted) await db.query('INSERT INTO user_permissions (user_id,permission,granted) VALUES (?,?,1)', [req.params.user_id, perm]);
    }
    res.json({success:true,message:'Hak akses disimpan.'});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/pos-settings/my-permissions - permissions user yg login
router.get('/my-permissions', auth(), async (req, res) => {
  try {
    const [rows] = await db.query('SELECT permission FROM user_permissions WHERE user_id=? AND granted=1', [req.user.id]);
    res.json({success:true, data:rows.map(r=>r.permission)});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
