#!/bin/bash
# Raja Vapor — Automated MySQL Backup
# Dijalankan via cron setiap hari jam 02:00 WIB
# After backup, optionally uploads to Google Drive via gdrive-upload.js

BACKUP_DIR="/var/www/rajavavapor/backups"
DB_NAME="rajavapor"
DB_USER="root"
DB_PASS="passwordkamu"
RETAIN_COUNT=30
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="rajavapor_${DATE}.sql.gz"
LOG_FILE="${BACKUP_DIR}/cron.log"

mkdir -p "$BACKUP_DIR"

# Create backup
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting backup..." >> "$LOG_FILE"
mysqldump -u"$DB_USER" -p"$DB_PASS" --single-transaction --routines --triggers "$DB_NAME" 2>/dev/null | gzip > "${BACKUP_DIR}/${FILENAME}"

if [ $? -eq 0 ] && [ -s "${BACKUP_DIR}/${FILENAME}" ]; then
  SIZE_BYTES=$(stat -c%s "${BACKUP_DIR}/${FILENAME}" 2>/dev/null || echo 0)
  SIZE_HUMAN=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup success: ${FILENAME} (${SIZE_HUMAN})" >> "$LOG_FILE"

  # Record to database
  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    INSERT INTO backup_log (filename, filesize, status, message)
    VALUES ('${FILENAME}', '${SIZE_HUMAN}', 'success', 'Backup completed successfully — ${SIZE_BYTES} bytes');
  " 2>/dev/null

  # Auto-upload to Google Drive if configured
  if [ -f /var/www/rajavavapor/backend/.env ] && grep -q "GDRIVE_SERVICE_ACCOUNT_JSON" /var/www/rajavavapor/backend/.env 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Triggering Google Drive upload..." >> "$LOG_FILE"
    cd /var/www/rajavavapor && node gdrive-upload.js >> "$LOG_FILE" 2>&1
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Google Drive not configured, skipping upload" >> "$LOG_FILE"
  fi
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup FAILED!" >> "$LOG_FILE"

  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    INSERT INTO backup_log (filename, status, message)
    VALUES ('${FILENAME}', 'failed', 'Backup failed - check server logs');

    INSERT INTO notifikasi (role_target, tipe, judul, pesan, link)
    VALUES ('owner', 'info', 'Backup Database GAGAL!', 'Backup harian gagal pada $(date). Segera cek server.', 'pg-developer');
  " 2>/dev/null
fi

# Cleanup: keep only last N backups
cd "$BACKUP_DIR" && ls -t rajavapor_*.sql.gz 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | xargs -r rm
KEPT=$(ls -1 "$BACKUP_DIR"/rajavapor_*.sql.gz 2>/dev/null | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cleanup: kept ${KEPT} backups (max ${RETAIN_COUNT})" >> "$LOG_FILE"

# Keep log file manageable
tail -200 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
