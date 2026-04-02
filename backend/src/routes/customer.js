const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');

router.get('/', auth(), async (req, res) => {
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (req.query.kategori) { where += ' AND c.kategori=?'; params.push(req.query.kategori); }
    if (req.user.role === 'sales') { where += ' AND c.sales_id=?'; params.push(req.user.id); }
    const bulanIni = new Date().toISOString().slice(0,7); // YYYY-MM
    const [rows] = await db.query(
      `SELECT c.*, u.nama_lengkap as nama_sales,
              COALESCE(omz.total_omzet, 0) as omzet_bulan_ini
       FROM customer c
       LEFT JOIN users u ON c.sales_id = u.id
       LEFT JOIN (
         SELECT customer_id, SUM(total) as total_omzet
         FROM invoice
         WHERE status IN ('diterbitkan','lunas') AND tanggal LIKE ?
         GROUP BY customer_id
       ) omz ON omz.customer_id = c.id
       ${where} ORDER BY c.nama`, [bulanIni+'%', ...params]
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
