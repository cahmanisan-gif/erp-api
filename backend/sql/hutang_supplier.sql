-- Hutang Supplier (Accounts Payable) tables
-- Run: mysql -u root -ppasswordkamu rajavapor < sql/hutang_supplier.sql

CREATE TABLE IF NOT EXISTS hutang_supplier (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  supplier_id   INT          DEFAULT NULL,
  pembelian_id  INT          DEFAULT NULL,
  cabang_id     INT          DEFAULT NULL,
  nama_supplier VARCHAR(200) NOT NULL,
  keterangan    TEXT         DEFAULT NULL,
  total         DECIMAL(15,2) NOT NULL DEFAULT 0,
  terbayar      DECIMAL(15,2) NOT NULL DEFAULT 0,
  jatuh_tempo   DATE         DEFAULT NULL,
  status        ENUM('belum_lunas','lunas') NOT NULL DEFAULT 'belum_lunas',
  created_by    INT          DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_supplier (supplier_id),
  INDEX idx_pembelian (pembelian_id),
  INDEX idx_cabang (cabang_id),
  INDEX idx_status (status),
  INDEX idx_jatuh_tempo (jatuh_tempo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hutang_supplier_pembayaran (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  hutang_id     INT          NOT NULL,
  jumlah        DECIMAL(15,2) NOT NULL,
  tanggal       DATE         NOT NULL,
  metode        ENUM('cash','transfer') NOT NULL DEFAULT 'cash',
  kas_akun_id   INT          DEFAULT NULL,
  bukti_url     VARCHAR(500) DEFAULT NULL,
  catatan       TEXT         DEFAULT NULL,
  created_by    INT          DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hutang (hutang_id),
  INDEX idx_tanggal (tanggal),
  CONSTRAINT fk_hutang_pembayaran_hutang FOREIGN KEY (hutang_id) REFERENCES hutang_supplier(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
