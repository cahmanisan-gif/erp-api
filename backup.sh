#!/bin/bash
# Raja Vapor — Automated MySQL Backup
# Dijalankan via cron setiap hari jam 02:00 WIB

BACKUP_DIR="/var/www/rajavavapor/backups"
DB_NAME="rajavapor"
DB_USER="root"
DB_PASS="passwordkamu"
RETAIN_DAYS=7
DATE=$(date +%Y%m%d_%H%M%S)
FILENAME="rajavapor_${DATE}.sql.gz"
LOG_FILE="${BACKUP_DIR}/backup.log"

# Create backup
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting backup..." >> "$LOG_FILE"
mysqldump -u"$DB_USER" -p"$DB_PASS" --single-transaction --routines --triggers "$DB_NAME" 2>/dev/null | gzip > "${BACKUP_DIR}/${FILENAME}"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Backup success: ${FILENAME} (${SIZE})" >> "$LOG_FILE"

  # Record to database
  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    INSERT INTO backup_log (filename, filesize, status, message)
    VALUES ('${FILENAME}', '${SIZE}', 'success', 'Backup completed successfully');
  " 2>/dev/null
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Backup FAILED!" >> "$LOG_FILE"

  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    INSERT INTO backup_log (filename, status, message)
    VALUES ('${FILENAME}', 'failed', 'Backup failed - check server logs');

    INSERT INTO notifikasi (role_target, tipe, judul, pesan, link)
    VALUES ('owner', 'info', 'Backup Database GAGAL!', 'Backup harian gagal pada $(date). Segera cek server.', 'pg-developer');
  " 2>/dev/null
fi

# Cleanup old backups
find "$BACKUP_DIR" -name "rajavapor_*.sql.gz" -mtime +${RETAIN_DAYS} -delete 2>/dev/null
DELETED=$(find "$BACKUP_DIR" -name "rajavapor_*.sql.gz" -mtime +${RETAIN_DAYS} 2>/dev/null | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cleanup: retained last ${RETAIN_DAYS} days" >> "$LOG_FILE"

# Keep log file manageable
tail -100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
