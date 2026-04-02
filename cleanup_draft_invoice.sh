#!/bin/bash
# Auto-hapus draft invoice > 7 hari + kembalikan stok ke gudang
# invoice_item.produk_id sekarang langsung merujuk ke pos_produk.id
DB="mysql -u root -ppasswordkamu rajavapor"

# 1. Log pengembalian stok
$DB -e "
INSERT INTO pos_stok_log (produk_id, cabang_id, tipe, qty, keterangan, user_id)
SELECT ii.produk_id, COALESCE(u.cabang_id,3), 'invoice_batal', ii.qty,
       CONCAT('Draft expired auto-hapus ', i.nomor), i.sales_id
FROM invoice i
JOIN invoice_item ii ON ii.invoice_id = i.id
JOIN users u ON u.id = i.sales_id
WHERE i.status = 'draft' AND i.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
  AND ii.produk_id IS NOT NULL;
" 2>/dev/null

# 2. Kembalikan stok
$DB -e "
UPDATE pos_stok ps
JOIN (
  SELECT ii.produk_id, COALESCE(u.cabang_id,3) AS cabang_id, SUM(ii.qty) AS qty
  FROM invoice i
  JOIN invoice_item ii ON ii.invoice_id = i.id
  JOIN users u ON u.id = i.sales_id
  WHERE i.status = 'draft' AND i.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
    AND ii.produk_id IS NOT NULL
  GROUP BY ii.produk_id, u.cabang_id
) t ON ps.produk_id = t.produk_id AND ps.cabang_id = t.cabang_id
SET ps.qty = ps.qty + t.qty;
" 2>/dev/null

# 3. Hapus items dan invoice
$DB -e "
DELETE ii FROM invoice_item ii
JOIN invoice i ON i.id = ii.invoice_id
WHERE i.status = 'draft' AND i.created_at < DATE_SUB(NOW(), INTERVAL 7 DAY);

DELETE FROM invoice
WHERE status = 'draft' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
" 2>/dev/null
