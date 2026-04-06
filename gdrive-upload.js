#!/usr/bin/env node
/**
 * Raja Vapor — Google Drive Backup Uploader
 *
 * Reads the latest backup from /var/www/rajavavapor/backups/
 * Uploads to Google Drive using a service account.
 * Logs result to backup_log table.
 * Cleans up old files on Drive (keeps last 30).
 *
 * Config via .env:
 *   GDRIVE_FOLDER_ID        — Google Drive folder ID to upload to
 *   GDRIVE_SERVICE_ACCOUNT_JSON — Path to service account key JSON file
 *
 * Usage: node gdrive-upload.js [filename]
 *   If filename given, uploads that specific file.
 *   Otherwise, uploads the latest .sql.gz in backups/.
 */

const path = require('path');
const fs   = require('fs');

// Load .env from backend
require('dotenv').config({ path: path.join(__dirname, 'backend', '.env') });

const BACKUP_DIR = path.join(__dirname, 'backups');
const KEEP_ON_DRIVE = 30;

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'passwordkamu',
  database: process.env.DB_NAME || 'rajavapor',
};

async function main() {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // ── 1. Check config ──
  const serviceAccountPath = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
  const folderId = process.env.GDRIVE_FOLDER_ID;

  if (!serviceAccountPath || !folderId) {
    console.log(`[${now}] GDRIVE_NOT_CONFIGURED — Set GDRIVE_SERVICE_ACCOUNT_JSON and GDRIVE_FOLDER_ID in backend/.env`);
    process.exit(0);
  }

  if (!fs.existsSync(serviceAccountPath)) {
    console.error(`[${now}] Service account key file not found: ${serviceAccountPath}`);
    process.exit(1);
  }

  // ── 2. Find the backup file to upload ──
  let targetFile = process.argv[2]; // optional: specific filename

  if (!targetFile) {
    // Find latest .sql.gz
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.sql.gz'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      console.error(`[${now}] No backup files found in ${BACKUP_DIR}`);
      process.exit(1);
    }
    targetFile = files[0].name;
  }

  const filePath = path.join(BACKUP_DIR, targetFile);
  if (!fs.existsSync(filePath)) {
    console.error(`[${now}] File not found: ${filePath}`);
    process.exit(1);
  }

  const fileSize = fs.statSync(filePath).size;
  console.log(`[${now}] Uploading ${targetFile} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to Google Drive...`);

  // ── 3. Initialize Google Drive API ──
  const { google } = require('googleapis');
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // ── 4. Upload ──
  let gdriveFileId = null;
  try {
    const response = await drive.files.create({
      requestBody: {
        name: targetFile,
        parents: [folderId],
        description: `Raja Vapor DB backup — ${targetFile}`,
      },
      media: {
        mimeType: 'application/gzip',
        body: fs.createReadStream(filePath),
      },
      fields: 'id,name,size',
    });

    gdriveFileId = response.data.id;
    console.log(`[${now}] Upload success! GDrive file ID: ${gdriveFileId}`);

    // ── 5. Update backup_log in DB ──
    await updateBackupLog(targetFile, 'uploaded', gdriveFileId);

  } catch (err) {
    console.error(`[${now}] Upload FAILED:`, err.message);
    await updateBackupLog(targetFile, 'failed', null, err.message);
    process.exit(1);
  }

  // ── 6. Cleanup old files on Drive (keep last N) ──
  try {
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType='application/gzip'`,
      orderBy: 'createdTime desc',
      fields: 'files(id,name,createdTime)',
      pageSize: 100,
    });

    const driveFiles = listRes.data.files || [];
    console.log(`[${now}] Found ${driveFiles.length} backup files on Drive`);

    if (driveFiles.length > KEEP_ON_DRIVE) {
      const toDelete = driveFiles.slice(KEEP_ON_DRIVE);
      for (const file of toDelete) {
        await drive.files.delete({ fileId: file.id });
        console.log(`[${now}] Deleted old Drive backup: ${file.name}`);
      }
      console.log(`[${now}] Cleaned up ${toDelete.length} old backups from Drive`);
    }
  } catch (err) {
    console.error(`[${now}] Drive cleanup warning:`, err.message);
    // Non-fatal — upload already succeeded
  }

  console.log(`[${now}] Done!`);
  process.exit(0);
}

async function updateBackupLog(filename, status, fileId, errorMsg) {
  let conn;
  try {
    const mysql = require('mysql2/promise');
    conn = await mysql.createConnection(DB_CONFIG);

    if (status === 'uploaded') {
      await conn.execute(
        `UPDATE backup_log SET gdrive_status='uploaded', gdrive_file_id=?, gdrive_uploaded_at=NOW()
         WHERE filename=? ORDER BY id DESC LIMIT 1`,
        [fileId, filename]
      );
    } else {
      await conn.execute(
        `UPDATE backup_log SET gdrive_status='failed', message=CONCAT(COALESCE(message,''), ' | GDrive: ${errorMsg || 'unknown error'}')
         WHERE filename=? ORDER BY id DESC LIMIT 1`,
        [filename]
      );
    }
  } catch (e) {
    console.error('DB update error:', e.message);
  } finally {
    if (conn) await conn.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
