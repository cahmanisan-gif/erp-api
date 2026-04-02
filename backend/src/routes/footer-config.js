const router = require('express').Router();
const db = require('../config/database');
const auth = require('../middleware/auth');

// Daftar semua halaman yang bisa dijadikan menu footer
const AVAILABLE_MENUS = [
  { key: 'pg-dashboard', label: 'Home', icon: 'home', category: 'Utama' },
  { key: 'pg-kasir', label: 'Kasir', icon: 'monitor', category: 'Utama' },
  { key: 'app-menu', label: 'Menu', icon: 'grid', category: 'Utama' },
  { key: 'app-notif', label: 'Notif', icon: 'bell', category: 'Utama' },
  { key: 'app-akun', label: 'Akun', icon: 'user', category: 'Utama' },
  { key: 'pg-monitoring-omzet', label: 'Omzet', icon: 'trending-up', category: 'Monitoring' },
  { key: 'pg-monitoring-keuntungan', label: 'Keuntungan', icon: 'dollar-sign', category: 'Monitoring' },
  { key: 'pg-laba-rugi', label: 'Laba Rugi', icon: 'bar-chart-2', category: 'Monitoring' },
  { key: 'pg-monitoring-modal', label: 'Modal', icon: 'briefcase', category: 'Monitoring' },
  { key: 'pg-monitoring-deadstock', label: 'Deadstock', icon: 'archive', category: 'Monitoring' },
  { key: 'pg-lap-marketplace', label: 'Marketplace', icon: 'shopping-bag', category: 'Monitoring' },
  { key: 'pg-target', label: 'Target', icon: 'target', category: 'Target & KPI' },
  { key: 'pg-target-saya', label: 'Target Saya', icon: 'crosshair', category: 'Target & KPI' },
  { key: 'pg-kpi', label: 'KPI', icon: 'award', category: 'Target & KPI' },
  { key: 'pg-produk', label: 'Produk', icon: 'package', category: 'Produk' },
  { key: 'pg-pos-produk', label: 'POS Produk', icon: 'box', category: 'Produk' },
  { key: 'pg-pos-stok', label: 'Stok', icon: 'layers', category: 'Produk' },
  { key: 'pg-transfer-barang', label: 'Transfer', icon: 'repeat', category: 'Produk' },
  { key: 'pg-invoice', label: 'Invoice', icon: 'file-text', category: 'Penjualan' },
  { key: 'pg-piutang', label: 'Piutang', icon: 'credit-card', category: 'Keuangan' },
  { key: 'pg-kas', label: 'Kas', icon: 'database', category: 'Keuangan' },
  { key: 'pg-pengeluaran', label: 'Pengeluaran', icon: 'minus-circle', category: 'Keuangan' },
  { key: 'pg-pemasukan', label: 'Pemasukan', icon: 'plus-circle', category: 'Keuangan' },
  { key: 'pg-absensi', label: 'Absensi', icon: 'clock', category: 'HR' },
  { key: 'pg-payroll', label: 'Payroll', icon: 'dollar-sign', category: 'HR' },
  { key: 'pg-konten', label: 'Konten', icon: 'video', category: 'Lainnya' },
  { key: 'pg-request-quick', label: 'Request', icon: 'package', category: 'Shortcut' },
  { key: 'pg-upload-quick', label: 'Upload', icon: 'video', category: 'Shortcut' },
  { key: 'pg-retur', label: 'Retur', icon: 'rotate-ccw', category: 'Lainnya' },
  { key: 'pg-promo', label: 'Promo', icon: 'tag', category: 'Lainnya' },
  { key: 'pg-member', label: 'Member', icon: 'users', category: 'Lainnya' },
  { key: 'pg-audit-log', label: 'Audit Log', icon: 'shield', category: 'Lainnya' },
];

const ALL_ROLES = ['owner','manajer','manajer_area','head_operational','admin_pusat','spv_area','finance','kepala_cabang','sales','kasir','kasir_sales','vaporista'];

// GET /api/footer-config/menus — daftar menu yang tersedia
router.get('/menus', auth(['owner','admin_pusat']), (req, res) => {
  res.json({ success: true, data: AVAILABLE_MENUS, roles: ALL_ROLES });
});

// GET /api/footer-config — semua grup + role + menu
router.get('/', auth(), async (req, res) => {
  try {
    const [grups] = await db.query('SELECT * FROM footer_grup ORDER BY urutan, id');
    const [roles] = await db.query('SELECT * FROM footer_grup_role ORDER BY grup_id');
    const [menus] = await db.query('SELECT * FROM footer_grup_menu ORDER BY grup_id, urutan');
    const data = grups.map(g => ({
      ...g,
      roles: roles.filter(r => r.grup_id === g.id).map(r => r.role),
      menus: menus.filter(m => m.grup_id === g.id)
    }));
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/footer-config/my — footer untuk role user saat ini
router.get('/my', auth(), async (req, res) => {
  try {
    const role = req.user.role;
    const [rows] = await db.query(`
      SELECT m.menu_key, m.label, m.icon, m.urutan
      FROM footer_grup_role r
      JOIN footer_grup g ON g.id = r.grup_id AND g.aktif = 1
      JOIN footer_grup_menu m ON m.grup_id = g.id
      WHERE r.role = ?
      ORDER BY m.urutan`, [role]);
    res.json({ success: true, data: rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/footer-config — buat grup baru
router.post('/', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { nama } = req.body;
    if (!nama) return res.status(400).json({ success: false, message: 'Nama wajib diisi' });
    const [result] = await db.query('INSERT INTO footer_grup (nama) VALUES (?)', [nama]);
    res.json({ success: true, data: { id: result.insertId, nama } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/footer-config/:id — update nama/aktif grup
router.put('/:id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { nama, aktif, urutan } = req.body;
    const sets = [], vals = [];
    if (nama !== undefined) { sets.push('nama=?'); vals.push(nama); }
    if (aktif !== undefined) { sets.push('aktif=?'); vals.push(aktif ? 1 : 0); }
    if (urutan !== undefined) { sets.push('urutan=?'); vals.push(urutan); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Tidak ada perubahan' });
    vals.push(req.params.id);
    await db.query(`UPDATE footer_grup SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/footer-config/:id — hapus grup
router.delete('/:id', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    await db.query('DELETE FROM footer_grup WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/footer-config/:id/roles — set roles untuk grup (replace all)
router.put('/:id/roles', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { roles } = req.body;
    if (!Array.isArray(roles)) return res.status(400).json({ success: false, message: 'roles harus array' });
    const grupId = req.params.id;
    await db.query('DELETE FROM footer_grup_role WHERE grup_id=?', [grupId]);
    if (roles.length) {
      const ph = roles.map(() => '(?,?)').join(',');
      const vals = roles.flatMap(r => [grupId, r]);
      await db.query(`INSERT INTO footer_grup_role (grup_id, role) VALUES ${ph}`, vals);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/footer-config/:id/menus — set menus untuk grup (replace all, max 5)
router.put('/:id/menus', auth(['owner','admin_pusat']), async (req, res) => {
  try {
    const { menus } = req.body;
    if (!Array.isArray(menus)) return res.status(400).json({ success: false, message: 'menus harus array' });
    if (menus.length > 5) return res.status(400).json({ success: false, message: 'Maksimal 5 menu' });
    const grupId = req.params.id;
    await db.query('DELETE FROM footer_grup_menu WHERE grup_id=?', [grupId]);
    if (menus.length) {
      const ph = menus.map(() => '(?,?,?,?,?)').join(',');
      const vals = menus.flatMap((m, i) => [grupId, m.menu_key, m.label || m.menu_key, m.icon || '', i + 1]);
      await db.query(`INSERT INTO footer_grup_menu (grup_id, menu_key, label, icon, urutan) VALUES ${ph}`, vals);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
