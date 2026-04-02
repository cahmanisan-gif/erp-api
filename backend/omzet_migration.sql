-- Tambah kolom area di cabang (jika belum ada)
ALTER TABLE cabang ADD COLUMN IF NOT EXISTS area VARCHAR(100) NULL AFTER kota;

-- Update area dari kota yang sudah ada (default sama dengan kota)
UPDATE cabang SET area = kota WHERE area IS NULL AND kota IS NOT NULL;

-- Tabel omzet harian per cabang
CREATE TABLE IF NOT EXISTS omzet_cabang (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  cabang_id     INT NOT NULL,
  tanggal       DATE NOT NULL,
  omzet_cash    DECIMAL(15,2) NOT NULL DEFAULT 0,
  omzet_transfer DECIMAL(15,2) NOT NULL DEFAULT 0,
  omzet_total   DECIMAL(15,2) GENERATED ALWAYS AS (omzet_cash + omzet_transfer) STORED,
  kas_akun_cash     INT NULL COMMENT 'akun kas untuk cash (brangkas)',
  kas_akun_transfer INT NULL COMMENT 'akun kas untuk transfer (BCA)',
  catatan       TEXT NULL,
  created_by    INT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_cabang_tanggal (cabang_id, tanggal),
  FOREIGN KEY (cabang_id) REFERENCES cabang(id) ON DELETE CASCADE,
  FOREIGN KEY (kas_akun_cash) REFERENCES kas_akun(id) ON DELETE SET NULL,
  FOREIGN KEY (kas_akun_transfer) REFERENCES kas_akun(id) ON DELETE SET NULL
);

-- Tabel pengeluaran cabang harian (linked ke omzet)
CREATE TABLE IF NOT EXISTS omzet_pengeluaran (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  omzet_id    INT NOT NULL,
  cabang_id   INT NOT NULL,
  tanggal     DATE NOT NULL,
  kategori_id INT NULL,
  nominal     DECIMAL(15,2) NOT NULL DEFAULT 0,
  keterangan  VARCHAR(255) NULL,
  pengeluaran_id INT NULL COMMENT 'auto-sync ke tabel pengeluaran',
  created_by  INT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (omzet_id) REFERENCES omzet_cabang(id) ON DELETE CASCADE,
  FOREIGN KEY (cabang_id) REFERENCES cabang(id) ON DELETE CASCADE,
  FOREIGN KEY (kategori_id) REFERENCES pengeluaran_kategori(id) ON DELETE SET NULL,
  FOREIGN KEY (pengeluaran_id) REFERENCES pengeluaran(id) ON DELETE SET NULL
);
