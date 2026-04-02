#!/bin/bash
# Hapus file video konten yang lebih dari 3 bulan
# Tapi simpan metadata di database

UPLOAD_DIR="/var/www/rajavavapor/uploads/konten"
DB_PASS="passwordkamu"
LOG="/var/log/rajavavapor_cleanup.log"

echo "$(date): Mulai cleanup konten..." >> $LOG

# Tandai file yang akan dihapus (>3 bulan)
mysql -u root -p${DB_PASS} rajavapor -e "
  SELECT filename FROM konten_upload 
  WHERE created_at < DATE_SUB(NOW(), INTERVAL 3 MONTH)
  AND filename IS NOT NULL
" --skip-column-names 2>/dev/null | while read filename; do
  filepath="$UPLOAD_DIR/$filename"
  if [ -f "$filepath" ]; then
    rm "$filepath"
    echo "$(date): Deleted $filename" >> $LOG
  fi
done

# Update database - set filename NULL untuk yang sudah dihapus
mysql -u root -p${DB_PASS} rajavapor -e "
  UPDATE konten_upload SET filename=NULL 
  WHERE created_at < DATE_SUB(NOW(), INTERVAL 3 MONTH)
  AND filename IS NOT NULL
" 2>/dev/null

echo "$(date): Cleanup selesai." >> $LOG
