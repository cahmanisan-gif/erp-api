const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const PDFDocument = require('pdfkit');

const RP = v => 'Rp ' + Math.round(v||0).toLocaleString('id-ID');
const FMT_TGL = s => s ? new Date(s+'T00:00:00').toLocaleDateString('id-ID',{day:'2-digit',month:'long',year:'numeric'}) : '-';

// Helper: setup PDF doc with header
function createPdf(res, filename, title, subtitle) {
  const doc = new PDFDocument({size:'A4', margin:40, bufferPages:true});
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
  doc.pipe(res);
  // Header
  doc.fontSize(18).font('Helvetica-Bold').text('RAJA VAPOR', {align:'center'});
  doc.fontSize(10).font('Helvetica').text('poinraja.com', {align:'center'});
  doc.moveDown(0.5);
  doc.fontSize(14).font('Helvetica-Bold').text(title, {align:'center'});
  if (subtitle) doc.fontSize(9).font('Helvetica').fillColor('#666').text(subtitle, {align:'center'});
  doc.fillColor('#000').moveDown(0.8);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#ccc');
  doc.moveDown(0.5);
  return doc;
}

// Helper: draw table
function drawTable(doc, headers, rows, colWidths, opts={}) {
  const startX = 40;
  const rowH = 18;
  let y = doc.y;

  // Check page break
  function checkPage() {
    if (y > 750) { doc.addPage(); y = 50; return true; }
    return false;
  }

  // Header row
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#333');
  let x = startX;
  headers.forEach((h, i) => {
    const align = opts.aligns?.[i] || 'left';
    const w = colWidths[i];
    doc.text(h, x + 2, y + 3, {width: w - 4, align, lineBreak:false});
    x += w;
  });
  y += rowH;
  doc.moveTo(startX, y).lineTo(startX + colWidths.reduce((s,w)=>s+w,0), y).stroke('#ddd');

  // Data rows
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  rows.forEach((row, ri) => {
    checkPage();
    if (ri % 2 === 0) {
      doc.rect(startX, y, colWidths.reduce((s,w)=>s+w,0), rowH).fill('#f9f9f9');
      doc.fillColor('#000');
    }
    x = startX;
    row.forEach((cell, ci) => {
      const align = opts.aligns?.[ci] || 'left';
      const w = colWidths[ci];
      const bold = opts.boldCols?.includes(ci);
      if (bold) doc.font('Helvetica-Bold');
      doc.text(String(cell ?? ''), x + 2, y + 4, {width: w - 4, align, lineBreak:false});
      if (bold) doc.font('Helvetica');
      x += w;
    });
    y += rowH;
  });

  doc.y = y + 5;
}

// ══════════════════════════════════════════════════════
// 1. LAPORAN PENJUALAN CABANG
// ══════════════════════════════════════════════════════
router.get('/penjualan', auth(), async (req, res) => {
  try {
    const { cabang_id, dari, sampai } = req.query;
    if (!cabang_id || !dari || !sampai) return res.status(400).json({success:false,message:'cabang_id, dari, sampai wajib.'});

    const [[cab]] = await db.query('SELECT nama,kode FROM cabang WHERE id=?', [cabang_id]);
    const cabNama = cab?.nama || 'Cabang #'+cabang_id;

    // Summary
    const [[sum]] = await db.query(`
      SELECT COUNT(*) as trx, COALESCE(SUM(total),0) as omzet, COALESCE(SUM(diskon),0) as diskon
      FROM pos_transaksi WHERE cabang_id=? AND status='selesai' AND created_at>=? AND created_at<=?`,
      [cabang_id, dari+' 00:00:00', sampai+' 23:59:59']);

    // Daily
    const [harian] = await db.query(`
      SELECT DATE(created_at) as tgl, COUNT(*) as trx, SUM(total) as omzet, SUM(diskon) as diskon
      FROM pos_transaksi WHERE cabang_id=? AND status='selesai' AND created_at>=? AND created_at<=?
      GROUP BY DATE(created_at) ORDER BY tgl`,
      [cabang_id, dari+' 00:00:00', sampai+' 23:59:59']);

    // Top produk
    const [topProduk] = await db.query(`
      SELECT ti.nama_produk, SUM(ti.qty) as qty, SUM(ti.subtotal) as omzet
      FROM pos_transaksi_item ti JOIN pos_transaksi t ON t.id=ti.transaksi_id
      WHERE t.cabang_id=? AND t.status='selesai' AND t.created_at>=? AND t.created_at<=?
      GROUP BY ti.produk_id, ti.nama_produk ORDER BY qty DESC LIMIT 15`,
      [cabang_id, dari+' 00:00:00', sampai+' 23:59:59']);

    // Per kasir
    const [perKasir] = await db.query(`
      SELECT u.nama_lengkap, COUNT(*) as trx, SUM(t.total) as omzet
      FROM pos_transaksi t LEFT JOIN users u ON u.id=t.kasir_id
      WHERE t.cabang_id=? AND t.status='selesai' AND t.created_at>=? AND t.created_at<=?
      GROUP BY t.kasir_id, u.nama_lengkap ORDER BY omzet DESC`,
      [cabang_id, dari+' 00:00:00', sampai+' 23:59:59']);

    // Generate PDF
    const doc = createPdf(res, `laporan_penjualan_${cab?.kode||cabang_id}.pdf`,
      `Laporan Penjualan — ${cabNama}`, `Periode: ${FMT_TGL(dari)} s/d ${FMT_TGL(sampai)}`);

    // Summary
    doc.fontSize(11).font('Helvetica-Bold').text('Ringkasan');
    doc.fontSize(9).font('Helvetica');
    doc.text(`Total Transaksi: ${parseInt(sum.trx).toLocaleString('id-ID')}`);
    doc.text(`Total Omzet: ${RP(sum.omzet)}`);
    doc.text(`Total Diskon: ${RP(sum.diskon)}`);
    doc.text(`Omzet Bersih: ${RP(sum.omzet - sum.diskon)}`);
    doc.moveDown(0.8);

    // Harian
    doc.fontSize(11).font('Helvetica-Bold').text('Omzet Harian');
    doc.moveDown(0.3);
    drawTable(doc,
      ['Tanggal', 'Transaksi', 'Omzet', 'Diskon', 'Neto'],
      harian.map(h => [
        FMT_TGL(h.tgl?.toISOString?.()?.slice(0,10) || h.tgl),
        parseInt(h.trx),
        RP(h.omzet), RP(h.diskon), RP(h.omzet - h.diskon)
      ]),
      [120, 70, 110, 100, 110],
      {aligns:['left','center','right','right','right'], boldCols:[4]}
    );

    // Top produk
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text('Top 15 Produk Terlaris');
    doc.moveDown(0.3);
    drawTable(doc,
      ['#', 'Produk', 'Qty', 'Omzet'],
      topProduk.map((p,i) => [i+1, p.nama_produk, parseInt(p.qty), RP(p.omzet)]),
      [30, 260, 60, 160],
      {aligns:['center','left','center','right']}
    );

    // Per kasir
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text('Omzet Per Kasir');
    doc.moveDown(0.3);
    drawTable(doc,
      ['Kasir', 'Transaksi', 'Omzet'],
      perKasir.map(k => [k.nama_lengkap||'-', parseInt(k.trx), RP(k.omzet)]),
      [220, 100, 190],
      {aligns:['left','center','right'], boldCols:[2]}
    );

    // Footer
    doc.moveDown(1);
    doc.fontSize(7).fillColor('#999').text(`Dicetak: ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} — Raja Vapor Portal`, {align:'center'});
    doc.end();
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ══════════════════════════════════════════════════════
// 2. LAPORAN PERSEDIAAN / MODAL CABANG
// ══════════════════════════════════════════════════════
router.get('/persediaan', auth(), async (req, res) => {
  try {
    const { cabang_id } = req.query;
    if (!cabang_id) return res.status(400).json({success:false,message:'cabang_id wajib.'});
    const [[cab]] = await db.query('SELECT nama,kode FROM cabang WHERE id=?', [cabang_id]);

    const [[totals]] = await db.query(`
      SELECT COUNT(DISTINCT p.id) as produk, COALESCE(SUM(s.qty),0) as stok,
             COALESCE(SUM(s.qty*p.harga_modal),0) as modal, COALESCE(SUM(s.qty*p.harga_jual),0) as nilai_jual
      FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1`, [cabang_id]);

    const [items] = await db.query(`
      SELECT p.sku, p.nama, p.kategori, s.qty, p.harga_modal, p.harga_jual,
             (s.qty*p.harga_modal) as modal, (s.qty*p.harga_jual) as nilai_jual
      FROM pos_produk p JOIN pos_stok s ON s.produk_id=p.id AND s.cabang_id=? AND s.qty>0
      WHERE p.aktif=1 ORDER BY modal DESC`, [cabang_id]);

    const doc = createPdf(res, `persediaan_${cab?.kode||cabang_id}.pdf`,
      `Laporan Persediaan — ${cab?.nama||''}`, `Per tanggal: ${FMT_TGL(new Date().toISOString().slice(0,10))}`);

    doc.fontSize(10).font('Helvetica');
    doc.text(`Total Produk: ${parseInt(totals.produk)}   |   Total Stok: ${parseInt(totals.stok)} pcs`);
    doc.text(`Total Modal: ${RP(totals.modal)}   |   Total Nilai Jual: ${RP(totals.nilai_jual)}`);
    doc.font('Helvetica-Bold').text(`Potensi Laba: ${RP(totals.nilai_jual - totals.modal)}`);
    doc.font('Helvetica').moveDown(0.8);

    drawTable(doc,
      ['SKU', 'Produk', 'Kategori', 'Stok', 'H.Modal', 'H.Jual', 'Total Modal'],
      items.map(i => [i.sku, i.nama, i.kategori||'-', i.qty, RP(i.harga_modal), RP(i.harga_jual), RP(i.modal)]),
      [55, 145, 65, 35, 65, 65, 80],
      {aligns:['left','left','left','center','right','right','right'], boldCols:[6]}
    );

    doc.moveDown(1);
    doc.fontSize(7).fillColor('#999').text(`Dicetak: ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} — Raja Vapor Portal`, {align:'center'});
    doc.end();
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ══════════════════════════════════════════════════════
// 3. LAPORAN REKAP OMZET SEMUA CABANG
// ══════════════════════════════════════════════════════
router.get('/rekap-omzet', auth(['owner','manajer','manajer_area','head_operational','admin_pusat']), async (req, res) => {
  try {
    const { dari, sampai } = req.query;
    if (!dari || !sampai) return res.status(400).json({success:false,message:'dari & sampai wajib.'});

    const [rows] = await db.query(`
      SELECT c.kode, c.nama,
             COALESCE(SUM(CASE WHEN t.metode_bayar='cash' THEN t.total ELSE 0 END),0) as cash,
             COALESCE(SUM(CASE WHEN t.metode_bayar IN ('transfer','qris') THEN t.total ELSE 0 END),0) as non_cash,
             COALESCE(SUM(t.total),0) as omzet, COUNT(*) as trx
      FROM cabang c
      LEFT JOIN pos_transaksi t ON t.cabang_id=c.id AND t.status='selesai' AND t.created_at>=? AND t.created_at<=?
      WHERE c.aktif=1
      GROUP BY c.id, c.kode, c.nama ORDER BY omzet DESC`,
      [dari+' 00:00:00', sampai+' 23:59:59']);

    const grandOmzet = rows.reduce((s,r) => s + parseFloat(r.omzet), 0);
    const grandTrx   = rows.reduce((s,r) => s + parseInt(r.trx), 0);

    const doc = createPdf(res, `rekap_omzet_${dari}_${sampai}.pdf`,
      'Rekap Omzet Semua Cabang', `Periode: ${FMT_TGL(dari)} s/d ${FMT_TGL(sampai)}`);

    doc.fontSize(10).font('Helvetica-Bold');
    doc.text(`Grand Total: ${RP(grandOmzet)}  |  ${grandTrx.toLocaleString('id-ID')} transaksi`);
    doc.font('Helvetica').moveDown(0.8);

    drawTable(doc,
      ['#', 'Kode', 'Cabang', 'Trx', 'Cash', 'Non-Cash', 'Total Omzet'],
      rows.map((r,i) => [i+1, r.kode, r.nama, parseInt(r.trx), RP(r.cash), RP(r.non_cash), RP(r.omzet)]),
      [25, 50, 130, 40, 80, 80, 100],
      {aligns:['center','left','left','center','right','right','right'], boldCols:[6]}
    );

    // Footer totals row
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text(`TOTAL: ${grandTrx.toLocaleString('id-ID')} trx  —  ${RP(grandOmzet)}`, {align:'right'});

    doc.moveDown(1);
    doc.fontSize(7).font('Helvetica').fillColor('#999').text(`Dicetak: ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} — Raja Vapor Portal`, {align:'center'});
    doc.end();
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// ── LAPORAN LABA RUGI PDF ──
router.get('/laba-rugi', auth(['owner','manajer','manajer_area','finance','head_operational','admin_pusat']), async (req, res) => {
  try {
    // Fetch data from monitoring/laba-rugi internally
    const { periode, dari, sampai, cabang_id } = req.query;
    const qs = new URLSearchParams({ periode: periode||'bulan-ini', dari: dari||'', sampai: sampai||'', cabang_id: cabang_id||'' }).toString();
    const http = require('http');
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;

    const fetchData = () => new Promise((resolve, reject) => {
      const opts = { hostname:'127.0.0.1', port:3000, path:`/api/monitoring/laba-rugi?${qs}`, headers:{ 'Authorization': `Bearer ${token}` }};
      http.get(opts, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });

    const result = await fetchData();
    if (!result.success) return res.status(500).json(result);

    const { data, konsolidasi: kon, kategori_beban, periodeLabel } = result;
    const subtitle = `Periode: ${periodeLabel}` + (cabang_id ? '' : ` — ${data.length} Cabang`);
    const doc = createPdf(res, `laba-rugi-${result.dateFrom}.pdf`, 'LAPORAN LABA RUGI', subtitle);

    // ── KONSOLIDASI ──
    if (kon && data.length > 1) {
      doc.fontSize(12).font('Helvetica-Bold').text('KONSOLIDASI SELURUH CABANG');
      doc.moveDown(0.3);

      const lines = [
        ['PENDAPATAN', null],
        ['  Omzet POS (Toko)', kon.pendapatan.omzet_pos],
        ['  Omzet Invoice (Sales)', kon.pendapatan.omzet_invoice],
        ['  Pemasukan Lain', kon.pendapatan.pemasukan_lain],
        ['  TOTAL PENDAPATAN', kon.pendapatan.total, true],
        ['', null],
        ['HARGA POKOK PENJUALAN (HPP)', null],
        ['  HPP POS', kon.hpp.hpp_pos],
        ['  HPP Invoice', kon.hpp.hpp_invoice],
        ['  TOTAL HPP', kon.hpp.total, true],
        ['', null],
        ['LABA KOTOR', kon.laba_kotor, true, kon.laba_kotor >= 0],
        ['', null],
        ['BEBAN OPERASIONAL', null],
      ];

      // Add kategori beban
      if (kategori_beban) {
        kategori_beban.forEach(kat => {
          const val = kon.beban_operasional.detail[kat] || 0;
          if (val > 0) lines.push(['  ' + kat, val]);
        });
      }
      lines.push(['  TOTAL BEBAN OPERASIONAL', kon.beban_operasional.total, true]);
      lines.push(['', null]);
      lines.push(['LABA BERSIH', kon.laba_bersih, true, kon.laba_bersih >= 0]);
      lines.push(['MARGIN KOTOR', kon.margin_kotor + '%']);
      lines.push(['MARGIN BERSIH', kon.margin_bersih + '%']);

      lines.forEach(([label, val, bold, positive]) => {
        if (!label) { doc.moveDown(0.2); return; }
        const isTitle = val === null;
        doc.fontSize(isTitle ? 10 : 9).font(bold || isTitle ? 'Helvetica-Bold' : 'Helvetica');
        if (bold && val !== null && positive !== undefined) doc.fillColor(positive ? '#16a34a' : '#dc2626');
        const valStr = val === null ? '' : typeof val === 'string' ? val : RP(val);
        doc.text(label, 50, doc.y, { continued: true, width: 300 });
        doc.text(valStr, { align: 'right', width: 190 });
        doc.fillColor('#000');
      });

      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica').text(`${kon.cabang_untung} cabang untung, ${kon.cabang_rugi} cabang rugi`);
      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke('#ccc');
      doc.moveDown(0.5);
    }

    // ── RANKING CABANG ──
    doc.fontSize(12).font('Helvetica-Bold').text('RANKING CABANG — LABA BERSIH');
    doc.moveDown(0.3);

    const tblHeaders = ['#', 'Cabang', 'Pendapatan', 'HPP', 'Laba Kotor', 'Beban Ops', 'Laba Bersih', 'Margin'];
    const tblWidths  = [20, 95, 70, 65, 70, 65, 70, 55];
    const tblAligns  = ['center','left','right','right','right','right','right','right'];
    const tblRows = data.map((d, i) => [
      i+1,
      (d.cabang.kode||'') + ' ' + (d.cabang.nama||'').substring(0,12),
      RP(d.pendapatan.total),
      RP(d.hpp.total),
      RP(d.laba_kotor),
      RP(d.beban_operasional.total),
      RP(d.laba_bersih),
      d.margin_bersih + '%'
    ]);

    drawTable(doc, tblHeaders, tblRows, tblWidths, { aligns: tblAligns, boldCols: [6] });

    // ── DETAIL PER CABANG (jika single cabang) ──
    if (data.length === 1) {
      const d = data[0];
      doc.addPage();
      doc.fontSize(12).font('Helvetica-Bold').text(`DETAIL: ${d.cabang.kode} ${d.cabang.nama}`);
      doc.moveDown(0.5);

      const detailLines = [
        ['PENDAPATAN', null],
        ['  Omzet POS (Toko)', d.pendapatan.omzet_pos],
        ['  Omzet Invoice (Sales)', d.pendapatan.omzet_invoice],
        ['  Pemasukan Lain', d.pendapatan.pemasukan_lain],
        ['  TOTAL PENDAPATAN', d.pendapatan.total, true],
        ['', null],
        ['HARGA POKOK PENJUALAN', null],
        ['  HPP POS', d.hpp.hpp_pos],
        ['  HPP Invoice', d.hpp.hpp_invoice],
        ['  TOTAL HPP', d.hpp.total, true],
        ['', null],
        ['LABA KOTOR', d.laba_kotor, true],
        ['', null],
        ['BEBAN OPERASIONAL', null],
      ];

      if (kategori_beban) {
        kategori_beban.forEach(kat => {
          const val = d.beban_operasional.detail[kat] || 0;
          if (val > 0) detailLines.push(['  ' + kat, val]);
        });
      }
      detailLines.push(['  TOTAL BEBAN', d.beban_operasional.total, true]);
      detailLines.push(['', null]);
      detailLines.push(['LABA BERSIH', d.laba_bersih, true]);
      detailLines.push(['MARGIN BERSIH', d.margin_bersih + '%']);

      detailLines.forEach(([label, val, bold]) => {
        if (!label) { doc.moveDown(0.2); return; }
        const isTitle = val === null;
        doc.fontSize(isTitle ? 10 : 9).font(bold || isTitle ? 'Helvetica-Bold' : 'Helvetica');
        if (bold && val !== null) doc.fillColor((typeof val === 'number' ? val : parseFloat(val)||0) >= 0 ? '#16a34a' : '#dc2626');
        const valStr = val === null ? '' : typeof val === 'string' ? val : RP(val);
        doc.text(label, 50, doc.y, { continued: true, width: 300 });
        doc.text(valStr, { align: 'right', width: 190 });
        doc.fillColor('#000');
      });
    }

    doc.moveDown(1);
    doc.fontSize(7).font('Helvetica').fillColor('#999').text(`Dicetak: ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} — Raja Vapor Portal`, {align:'center'});
    doc.end();
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

module.exports = router;
