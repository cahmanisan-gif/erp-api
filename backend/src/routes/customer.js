const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

// GET /api/customer/summary — CRM dashboard stats
router.get('/summary', auth(), async (req, res) => {
  try {
    const bulanIni = new Date().toISOString().slice(0,7);
    const bulanLalu = new Date(Date.now()-30*86400000).toISOString().slice(0,7);
    const salesFilter = req.user.role === 'sales' ? ' AND c.sales_id='+req.user.id : '';
    const salesFilterInv = req.user.role === 'sales' ? ' AND i.sales_id='+req.user.id : '';

    const [
      [totals], [kategoriRows], [tipeRows],
      [omzetBulanIni], [omzetBulanLalu],
      [topCustomers], [recentActivity], [invoiceStats]
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) as total FROM customer c WHERE 1=1${salesFilter}`),
      db.query(`SELECT COALESCE(c.kategori,'reguler') as kategori, COUNT(*) as jumlah
        FROM customer c WHERE 1=1${salesFilter} GROUP BY COALESCE(c.kategori,'reguler')`),
      db.query(`SELECT c.tipe, COUNT(*) as jumlah FROM customer c WHERE 1=1${salesFilter} GROUP BY c.tipe`),
      db.query(`SELECT COALESCE(SUM(i.total),0) as omzet, COUNT(*) as cnt
        FROM invoice i WHERE i.status IN ('diterbitkan','lunas') AND i.tanggal LIKE ?${salesFilterInv}`, [bulanIni+'%']),
      db.query(`SELECT COALESCE(SUM(i.total),0) as omzet
        FROM invoice i WHERE i.status IN ('diterbitkan','lunas') AND i.tanggal LIKE ?${salesFilterInv}`, [bulanLalu+'%']),
      db.query(`SELECT c.id, c.nama, c.nama_toko, c.kategori, COALESCE(o.omzet,0) as omzet
        FROM customer c
        LEFT JOIN (SELECT customer_id, SUM(total) as omzet FROM invoice WHERE status IN ('diterbitkan','lunas') AND tanggal LIKE ? GROUP BY customer_id) o ON o.customer_id=c.id
        WHERE 1=1${salesFilter} ORDER BY omzet DESC LIMIT 5`, [bulanIni+'%']),
      db.query(`SELECT a.tipe, a.catatan, a.created_at, c.nama as nama_customer, u.nama_lengkap as nama_sales
        FROM crm_activity a JOIN customer c ON c.id=a.customer_id LEFT JOIN users u ON u.id=a.sales_id
        ORDER BY a.created_at DESC LIMIT 5`),
      db.query(`SELECT
        SUM(CASE WHEN status='lunas' THEN 1 ELSE 0 END) as lunas,
        SUM(CASE WHEN status='diterbitkan' THEN 1 ELSE 0 END) as outstanding,
        SUM(CASE WHEN status='overdue' THEN 1 ELSE 0 END) as overdue
        FROM invoice i WHERE i.tanggal LIKE ?${salesFilterInv}`, [bulanIni+'%']),
    ]);

    const omzetIni = parseFloat(omzetBulanIni[0].omzet);
    const omzetLalu = parseFloat(omzetBulanLalu[0].omzet);
    const growth = omzetLalu > 0 ? Math.round((omzetIni - omzetLalu) / omzetLalu * 100) : null;

    res.json({ success:true, data:{
      total_customer: totals[0].total,
      kategori: Object.fromEntries(kategoriRows.map(r => [r.kategori, r.jumlah])),
      tipe: Object.fromEntries(tipeRows.map(r => [r.tipe||'lainnya', r.jumlah])),
      omzet_bulan_ini: omzetIni,
      omzet_bulan_lalu: omzetLalu,
      growth,
      invoice_count: parseInt(omzetBulanIni[0].cnt),
      invoice_stats: invoiceStats[0],
      top_customers: topCustomers,
      recent_activity: recentActivity,
    }});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.kategori) { where += ' AND c.kategori=?'; params.push(req.query.kategori); }
    if (req.user.role === 'sales') { where += ' AND c.sales_id=?'; params.push(req.user.id); }
    const bulanIni = new Date().toISOString().slice(0,7); // YYYY-MM
    const [rows] = await db.query(
      `SELECT c.*, u.nama_lengkap as nama_sales,
              COALESCE(omz.total_omzet, 0) as omzet_bulan_ini,
              COALESCE(omz.inv_count, 0) as invoice_count,
              act.last_activity, act.last_activity_type
       FROM customer c
       LEFT JOIN users u ON c.sales_id = u.id
       LEFT JOIN (
         SELECT customer_id, SUM(total) as total_omzet, COUNT(*) as inv_count
         FROM invoice
         WHERE status IN ('diterbitkan','lunas') AND tanggal LIKE ?
         GROUP BY customer_id
       ) omz ON omz.customer_id = c.id
       LEFT JOIN (
         SELECT customer_id, MAX(created_at) as last_activity,
                SUBSTRING_INDEX(GROUP_CONCAT(tipe ORDER BY created_at DESC),',',1) as last_activity_type
         FROM crm_activity GROUP BY customer_id
       ) act ON act.customer_id = c.id
       ${where} ORDER BY omzet_bulan_ini DESC, c.nama`, [bulanIni+'%', ...params]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/', auth(['owner','manajer','admin_pusat','sales']), async (req, res) => {
  try {
    const { kode, nama, nama_owner, nama_toko, telepon, no_hp, alamat, kota, wilayah, tipe, sales_id } = req.body;
    if (!kode||!nama) return res.status(400).json({ success:false, message:'Kode dan nama wajib.' });
    await db.query(
      'INSERT INTO customer (kode,nama,nama_owner,nama_toko,telepon,no_hp,alamat,kota,wilayah,tipe,sales_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [kode, nama, nama_owner||'', nama_toko||'', telepon||'', no_hp||'', alamat||'', kota||'', wilayah||'', tipe||'reseller', sales_id||req.user.id]
    );
    res.json({ success:true, message:'Customer berhasil ditambahkan.' });
  } catch(e) {
    if (e.code==='ER_DUP_ENTRY') return res.status(400).json({ success:false, message:'Kode customer sudah ada.' });
    res.status(500).json({ success:false, message:e.message });
  }
});

router.patch('/:id', auth(['owner','manajer','admin_pusat','sales']), async (req, res) => {
  try {
    const { nama, nama_owner, nama_toko, telepon, no_hp, alamat, kota, wilayah, tipe } = req.body;
    await db.query(
      'UPDATE customer SET nama=?,nama_owner=?,nama_toko=?,telepon=?,no_hp=?,alamat=?,kota=?,wilayah=?,tipe=? WHERE id=?',
      [nama, nama_owner||'', nama_toko||'', telepon||'', no_hp||'', alamat||'', kota||'', wilayah||'', tipe||'reseller', req.params.id]
    );
    res.json({ success:true, message:'Customer berhasil diupdate.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.delete('/:id', auth(['owner','manajer']), async (req, res) => {
  try {
    await db.query('DELETE FROM customer WHERE id=?', [req.params.id]);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

router.post('/crm', auth(), async (req, res) => {
  try {
    const { customer_id, tipe, catatan } = req.body;
    await db.query('INSERT INTO crm_activity (customer_id,sales_id,tipe,catatan) VALUES (?,?,?,?)',
      [customer_id, req.user.id, tipe, catatan||'']);
    res.json({ success:true, message:'Aktivitas dicatat.' });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// GET /api/customer/:id/detail — detail customer + invoice history + activity + totals
router.get('/:id/detail', auth(), async (req, res) => {
  try {
    const [[cust]] = await db.query(
      `SELECT c.*, u.nama_lengkap as nama_sales
       FROM customer c LEFT JOIN users u ON c.sales_id=u.id WHERE c.id=?`, [req.params.id]);
    if (!cust) return res.status(404).json({success:false,message:'Customer tidak ditemukan.'});

    // Invoice history
    const [invoices] = await db.query(
      `SELECT i.id, i.nomor, i.tanggal, i.jatuh_tempo, i.total, i.ongkir, i.status, i.keterangan,
              COALESCE(ii.total_qty,0) as total_qty
       FROM invoice i
       LEFT JOIN (SELECT invoice_id, SUM(qty) as total_qty FROM invoice_item GROUP BY invoice_id) ii ON ii.invoice_id=i.id
       WHERE i.customer_id=? ORDER BY i.tanggal DESC`, [req.params.id]);

    // CRM activity history
    const [activities] = await db.query(
      `SELECT a.*, u.nama_lengkap as nama_user
       FROM crm_activity a LEFT JOIN users u ON u.id=a.sales_id
       WHERE a.customer_id=? ORDER BY a.created_at DESC LIMIT 50`, [req.params.id]);

    // Totals
    const [[totals]] = await db.query(
      `SELECT COUNT(*) as total_invoice,
              COALESCE(SUM(CASE WHEN status IN ('diterbitkan','lunas') THEN total ELSE 0 END),0) as total_omzet,
              COALESCE(SUM(CASE WHEN status='lunas' THEN total ELSE 0 END),0) as total_lunas,
              COALESCE(SUM(CASE WHEN status='diterbitkan' THEN total ELSE 0 END),0) as total_outstanding,
              MIN(tanggal) as first_invoice,
              MAX(tanggal) as last_invoice
       FROM invoice WHERE customer_id=?`, [req.params.id]);

    // Omzet per bulan (6 bulan terakhir)
    const [perBulan] = await db.query(
      `SELECT DATE_FORMAT(tanggal,'%Y-%m') as bulan, SUM(total) as omzet, COUNT(*) as jumlah
       FROM invoice WHERE customer_id=? AND status IN ('diterbitkan','lunas')
         AND tanggal >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY DATE_FORMAT(tanggal,'%Y-%m') ORDER BY bulan ASC`, [req.params.id]);

    res.json({success:true, data:{
      customer: cust,
      invoices,
      activities,
      totals,
      perBulan
    }});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;
