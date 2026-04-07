const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');

const upload = multer({ dest: '/tmp/' });

// GET /api/request-produk — daftar semua produk master + detail dari pos_produk
router.get('/', auth(), async (req, res) => {
  try {
    const { aktif, jenis, q, limit } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (aktif !== undefined) { where += ' AND rpm.aktif=?'; params.push(aktif); }
    if (jenis) { where += ' AND rpm.jenis=?'; params.push(jenis); }
    if (q) { where += ' AND rpm.nama LIKE ?'; params.push('%' + q + '%'); }
    const lmt = Math.min(parseInt(limit) || 500, 2000);

    const [rows] = await db.query(`
      SELECT rpm.*,
             pp.nama AS pos_nama, pp.kategori AS pos_kategori,
             pp.harga_jual AS pos_harga_jual, pp.harga_modal AS pos_harga_modal,
             pp.sku AS pos_sku, pp.barcode AS pos_barcode, pp.foto_url AS pos_foto_url,
             pp.stok_minimum AS pos_stok_minimum
        FROM request_produk_master rpm
        LEFT JOIN pos_produk pp ON pp.id = rpm.produk_id
       ${where}
       ORDER BY rpm.jenis, rpm.nama
       LIMIT ?
    `, [...params, lmt]);

    // Merge: prefer pos_produk data if linked
    const data = rows.map(r => ({
      id: r.id,
      produk_id: r.produk_id,
      nama: r.nama,
      jenis: r.jenis,
      satuan: r.satuan,
      aktif: r.aktif,
      sku: r.sku || r.pos_sku || null,
      barcode: r.barcode || r.pos_barcode || null,
      harga_jual: r.harga_jual || r.pos_harga_jual || 0,
      harga_modal: r.harga_modal || r.pos_harga_modal || 0,
      foto_url: r.foto_url || r.pos_foto_url || null,
      deskripsi: r.deskripsi || null,
      stok_minimum: r.stok_minimum || r.pos_stok_minimum || 0,
      created_at: r.created_at,
      linked: !!r.produk_id,
    }));

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/request-produk/:id — detail lengkap 1 produk + stok per cabang
router.get('/:id', auth(), async (req, res) => {
  try {
    const [[rpm]] = await db.query('SELECT * FROM request_produk_master WHERE id=?', [req.params.id]);
    if (!rpm) return res.status(404).json({ success: false, message: 'Produk tidak ditemukan.' });

    // Jika linked ke pos_produk, ambil data lengkap + stok per cabang
    let pos_produk = null;
    let stok_cabang = [];
    let penjualan_30h = [];

    if (rpm.produk_id) {
      const [[pp]] = await db.query('SELECT * FROM pos_produk WHERE id=?', [rpm.produk_id]);
      pos_produk = pp || null;

      // Stok per cabang
      const [stok] = await db.query(`
        SELECT s.cabang_id, c.nama AS nama_cabang, c.kode, s.qty
          FROM pos_stok s
          JOIN cabang c ON c.id = s.cabang_id
         WHERE s.produk_id = ?
         ORDER BY c.nama
      `, [rpm.produk_id]);
      stok_cabang = stok;

      // Penjualan 30 hari terakhir per cabang
      const [sales] = await db.query(`
        SELECT t.cabang_id, c.nama AS nama_cabang,
               SUM(ti.qty) AS total_qty, SUM(ti.subtotal) AS total_omzet
          FROM pos_transaksi_item ti
          JOIN pos_transaksi t ON t.id = ti.transaksi_id
          JOIN cabang c ON c.id = t.cabang_id
         WHERE t.status = 'selesai'
           AND ti.produk_id = ?
           AND t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         GROUP BY t.cabang_id, c.nama
         ORDER BY total_qty DESC
      `, [rpm.produk_id]);
      penjualan_30h = sales;
    }

    // Merge data
    const data = {
      id: rpm.id,
      produk_id: rpm.produk_id,
      nama: rpm.nama,
      jenis: rpm.jenis,
      satuan: rpm.satuan,
      aktif: rpm.aktif,
      sku: rpm.sku || (pos_produk?.sku) || null,
      barcode: rpm.barcode || (pos_produk?.barcode) || null,
      harga_jual: rpm.harga_jual || (pos_produk?.harga_jual) || 0,
      harga_modal: rpm.harga_modal || (pos_produk?.harga_modal) || 0,
      foto_url: rpm.foto_url || (pos_produk?.foto_url) || null,
      deskripsi: rpm.deskripsi || null,
      stok_minimum: rpm.stok_minimum || (pos_produk?.stok_minimum) || 0,
      created_at: rpm.created_at,
      linked: !!rpm.produk_id,
      pos_produk,
      stok_cabang,
      total_stok: stok_cabang.reduce((s, r) => s + r.qty, 0),
      penjualan_30h,
      total_terjual_30h: penjualan_30h.reduce((s, r) => s + Number(r.total_qty), 0),
    };

    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/request-produk — tambah produk + optional link ke pos_produk
router.post('/', auth(['owner', 'admin_pusat', 'manajer']), async (req, res) => {
  try {
    const { nama, jenis, satuan, produk_id, sku, barcode, harga_jual, harga_modal, foto_url, deskripsi, stok_minimum } = req.body;
    if (!nama) return res.status(400).json({ success: false, message: 'Nama wajib diisi.' });

    const [result] = await db.query(
      `INSERT INTO request_produk_master (produk_id, nama, sku, barcode, harga_jual, harga_modal, foto_url, deskripsi, jenis, satuan, stok_minimum)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [produk_id || null, nama.trim(), sku || null, barcode || null, harga_jual || 0, harga_modal || 0, foto_url || null, deskripsi || null, jenis || null, satuan || 'pcs', stok_minimum || 0]
    );
    res.json({ success: true, message: 'Produk ditambahkan.', id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: 'Produk sudah ada.' });
    res.status(500).json({ success: false, message: e.message });
  }
});

// PATCH /api/request-produk/:id — update produk
router.patch('/:id', auth(['owner', 'admin_pusat', 'manajer']), async (req, res) => {
  try {
    const { nama, jenis, satuan, aktif, produk_id, sku, barcode, harga_jual, harga_modal, foto_url, deskripsi, stok_minimum } = req.body;
    await db.query(
      `UPDATE request_produk_master
          SET nama=?, jenis=?, satuan=?, aktif=?, produk_id=?,
              sku=?, barcode=?, harga_jual=?, harga_modal=?, foto_url=?, deskripsi=?, stok_minimum=?
        WHERE id=?`,
      [nama, jenis || null, satuan || 'pcs', aktif ?? 1, produk_id || null,
       sku || null, barcode || null, harga_jual || 0, harga_modal || 0, foto_url || null, deskripsi || null, stok_minimum || 0,
       req.params.id]
    );
    res.json({ success: true, message: 'Produk diupdate.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PATCH /api/request-produk/:id/link — link ke pos_produk dan sync data
router.patch('/:id/link', auth(['owner', 'admin_pusat', 'manajer']), async (req, res) => {
  try {
    const { produk_id } = req.body;
    if (!produk_id) return res.status(400).json({ success: false, message: 'produk_id wajib.' });
    const [[pp]] = await db.query('SELECT id, sku, barcode, harga_jual, harga_modal, foto_url, stok_minimum FROM pos_produk WHERE id=?', [produk_id]);
    if (!pp) return res.status(404).json({ success: false, message: 'Produk POS tidak ditemukan.' });

    await db.query(
      `UPDATE request_produk_master
          SET produk_id=?, sku=?, barcode=?, harga_jual=?, harga_modal=?, foto_url=?, stok_minimum=?
        WHERE id=?`,
      [pp.id, pp.sku, pp.barcode, pp.harga_jual, pp.harga_modal, pp.foto_url, pp.stok_minimum, req.params.id]
    );
    res.json({ success: true, message: 'Produk berhasil di-link ke POS.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/request-produk/sync-all — sync semua yang sudah linked dari pos_produk
router.post('/sync-all', auth(['owner', 'admin_pusat']), async (req, res) => {
  try {
    const [result] = await db.query(`
      UPDATE request_produk_master rpm
        JOIN pos_produk pp ON pp.id = rpm.produk_id
         SET rpm.sku = pp.sku,
             rpm.barcode = pp.barcode,
             rpm.harga_jual = pp.harga_jual,
             rpm.harga_modal = pp.harga_modal,
             rpm.foto_url = pp.foto_url,
             rpm.stok_minimum = pp.stok_minimum
       WHERE rpm.produk_id IS NOT NULL
    `);
    res.json({ success: true, message: `${result.affectedRows} produk disync dari POS.`, synced: result.affectedRows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /api/request-produk/:id
router.delete('/:id', auth(['owner', 'admin_pusat']), async (req, res) => {
  try {
    await db.query('DELETE FROM request_produk_master WHERE id=?', [req.params.id]);
    res.json({ success: true, message: 'Produk dihapus.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/request-produk/import — import dari Excel
router.post('/import', auth(['owner', 'admin_pusat']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'File wajib diupload.' });
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    fs.unlinkSync(req.file.path);

    let inserted = 0, skipped = 0;
    for (const row of rows) {
      const nama = (row['Nama'] || row['nama'] || '').toString().trim();
      const jenis = (row['Jenis'] || row['jenis'] || '').toString().trim() || null;
      const satuan = (row['Satuan'] || row['satuan'] || 'pcs').toString().trim();
      const harga_jual = parseInt(row['Harga Jual'] || row['harga_jual'] || 0);
      const harga_modal = parseInt(row['Harga Modal'] || row['harga_modal'] || 0);
      if (!nama) { skipped++; continue; }
      try {
        await db.query(
          'INSERT INTO request_produk_master (nama, jenis, satuan, harga_jual, harga_modal) VALUES (?,?,?,?,?)',
          [nama, jenis, satuan, harga_jual, harga_modal]
        );
        inserted++;
      } catch (e) { if (e.code === 'ER_DUP_ENTRY') skipped++; else throw e; }
    }
    res.json({ success: true, message: `Import selesai: ${inserted} ditambah, ${skipped} dilewati.` });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /api/request-produk/export — export ke Excel
router.get('/export', auth(['owner', 'admin_pusat', 'manajer']), async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT rpm.nama AS Nama, rpm.jenis AS Jenis, rpm.satuan AS Satuan,
             rpm.sku AS SKU, rpm.harga_jual AS 'Harga Jual', rpm.harga_modal AS 'Harga Modal',
             rpm.aktif AS Aktif
        FROM request_produk_master rpm ORDER BY rpm.jenis, rpm.nama
    `);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 35 }, { wch: 12 }, { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 6 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Master Produk Request');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=master_produk_request.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
