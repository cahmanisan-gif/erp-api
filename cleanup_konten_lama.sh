#!/bin/bash
# ═══════════════════════════════════════════════════════
# AUTO-CLEANUP VIDEO KONTEN > 30 HARI (SUDAH DI-REVIEW)
# Hash tetap di DB → re-upload tetap terdeteksi & ditolak
# ═══════════════════════════════════════════════════════

KONTEN_DIR="/var/www/rajavavapor/uploads/konten"
DB_USER="root"
DB_PASS="passwordkamu"
DB_NAME="rajavapor"
HARI_SIMPAN=30
LOG="/var/www/rajavavapor/backups/cleanup_konten.log"

echo "$(date '+%Y-%m-%d %H:%M:%S') — Mulai cleanup konten lama (>${HARI_SIMPAN} hari)" >> "$LOG"

# Ambil daftar file yang sudah di-review DAN lebih dari 30 hari
FILES=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -N -e "
  SELECT filename FROM konten_upload
  WHERE status IN ('approved','rejected')
    AND tanggal < DATE_SUB(CURDATE(), INTERVAL ${HARI_SIMPAN} DAY)
    AND filename IS NOT NULL
" 2>/dev/null)

DELETED=0
FREED=0

for FILE in $FILES; do
  FILEPATH="$KONTEN_DIR/$FILE"
  if [ -f "$FILEPATH" ]; then
    SIZE=$(stat -c%s "$FILEPATH" 2>/dev/null || echo 0)
    rm -f "$FILEPATH"
    FREED=$((FREED + SIZE))
    DELETED=$((DELETED + 1))
  fi
done

FREED_MB=$((FREED / 1024 / 1024))
echo "$(date '+%Y-%m-%d %H:%M:%S') — Selesai: $DELETED file dihapus, ${FREED_MB}MB dibebaskan" >> "$LOG"
echo "Cleanup done: $DELETED files deleted, ${FREED_MB}MB freed"
