const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const fs      = require('fs');
const path    = require('path');
const { execSync, exec } = require('child_process');

const BACKUP_DIR  = '/var/www/rajavavapor/backups';
const BACKUP_SH   = '/var/www/rajavavapor/backup.sh';
const GDRIVE_JS   = '/var/www/rajavavapor/gdrive-upload.js';
const ENV_FILE    = path.join(__dirname, '../../.env');

// ═══════════════════════════════════════════════
// GET /api/backup/status — last 10 backups, disk usage, gdrive status
// ═══════════════════════════════════════════════
router.get('/status', auth(['owner', 'admin_pusat']), async (req, res) => {
  try {
    // Last 10 backup logs
    const [logs] = await db.query(
      'SELECT * FROM backup_log ORDER BY created_at DESC LIMIT 10'
    );

    // List actual files on disk
    let files = [];
    let totalSizeBytes = 0;
    try {
      files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.sql.gz'))
        .map(f => {
          const stat = fs.statSync(path.join(BACKUP_DIR, f));
          totalSizeBytes += stat.size;
          return { filename: f, size_bytes: stat.size, date: stat.mtime };
        })
        .sort((a, b) => b.date - a.date);
    } catch (e) { /* dir may not exist yet */ }

    // Disk usage of backup directory
    let diskUsage = null;
    try {
      const duOut = execSync(`du -sh ${BACKUP_DIR} 2>/dev/null`).toString().trim();
      diskUsage = duOut.split('\t')[0];
    } catch (e) {}

    // GDrive status summary
    const [[gdriveStats]] = await db.query(`
      SELECT
        COUNT(CASE WHEN gdrive_status='uploaded' THEN 1 END) as uploaded_count,
        MAX(CASE WHEN gdrive_status='uploaded' THEN gdrive_uploaded_at END) as last_upload
      FROM backup_log
    `);

    res.json({
      success: true,
      data: {
        logs,
        files,
        total_files: files.length,
        total_size_bytes: totalSizeBytes,
        disk_usage: diskUsage,
        gdrive: {
          uploaded_count: parseInt(gdriveStats.uploaded_count) || 0,
          last_upload: gdriveStats.last_upload || null,
        },
      },
    });
  } catch (e) {
    console.error('backup status:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════
// POST /api/backup/now — trigger manual backup
// ═══════════════════════════════════════════════
router.post('/now', auth(['owner']), async (req, res) => {
  try {
    execSync(`/bin/bash ${BACKUP_SH}`, { timeout: 120000 });

    // Return the latest log entry
    const [latest] = await db.query(
      'SELECT * FROM backup_log ORDER BY id DESC LIMIT 1'
    );

    res.json({
      success: true,
      message: 'Backup selesai!',
      data: latest[0] || null,
    });
  } catch (e) {
    console.error('backup now:', e);
    res.status(500).json({ success: false, message: 'Backup gagal: ' + e.message });
  }
});

// ═══════════════════════════════════════════════
// POST /api/backup/upload-gdrive — trigger gdrive upload of latest backup
// ═══════════════════════════════════════════════
router.post('/upload-gdrive', auth(['owner']), async (req, res) => {
  try {
    // Check if GDrive is configured (must be uncommented, active vars in .env)
    const envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const folderId = extractEnvVar(envContent, 'GDRIVE_FOLDER_ID');
    const saPath = extractEnvVar(envContent, 'GDRIVE_SERVICE_ACCOUNT_JSON');
    if (!folderId || !saPath) {
      return res.status(400).json({
        success: false,
        message: 'Google Drive belum dikonfigurasi. Set GDRIVE_SERVICE_ACCOUNT_JSON dan GDRIVE_FOLDER_ID di backend/.env',
      });
    }
    if (!fs.existsSync(saPath)) {
      return res.status(400).json({
        success: false,
        message: `File service account tidak ditemukan: ${saPath}`,
      });
    }

    // Optional: upload specific file
    const filename = (req.body && req.body.filename) || '';
    const filenameArg = filename ? ` "${filename}"` : '';

    // Run in background — don't block the HTTP response
    exec(
      `cd /var/www/rajavavapor && node ${GDRIVE_JS}${filenameArg}`,
      { timeout: 300000 },
      async (error, stdout, stderr) => {
        if (error) {
          console.error('gdrive upload error:', error.message, stderr);
        } else {
          console.log('gdrive upload:', stdout);
        }
      }
    );

    // Mark as pending in the latest log entry
    if (filename) {
      await db.query(
        `UPDATE backup_log SET gdrive_status='pending' WHERE filename=? ORDER BY id DESC LIMIT 1`,
        [filename]
      );
    } else {
      await db.query(
        `UPDATE backup_log SET gdrive_status='pending' WHERE status='success' ORDER BY id DESC LIMIT 1`
      );
    }

    res.json({
      success: true,
      message: 'Upload ke Google Drive dimulai. Cek status backup untuk progress.',
    });
  } catch (e) {
    console.error('upload-gdrive:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════
// GET /api/backup/settings — gdrive config status
// ═══════════════════════════════════════════════
router.get('/settings', auth(['owner']), async (req, res) => {
  try {
    const envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';

    // Parse relevant vars
    const folderId = extractEnvVar(envContent, 'GDRIVE_FOLDER_ID');
    const saPath = extractEnvVar(envContent, 'GDRIVE_SERVICE_ACCOUNT_JSON');
    const saExists = saPath ? fs.existsSync(saPath) : false;

    // Parse service account email if key file exists
    let serviceAccountEmail = null;
    if (saExists) {
      try {
        const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
        serviceAccountEmail = sa.client_email || null;
      } catch (e) {}
    }

    // Last successful upload
    const [[lastUpload]] = await db.query(
      `SELECT filename, gdrive_file_id, gdrive_uploaded_at
       FROM backup_log WHERE gdrive_status='uploaded'
       ORDER BY gdrive_uploaded_at DESC LIMIT 1`
    );

    // Cron status
    let cronInstalled = false;
    try {
      const crontab = execSync('crontab -l 2>/dev/null').toString();
      cronInstalled = crontab.includes('backup.sh');
    } catch (e) {}

    res.json({
      success: true,
      data: {
        gdrive_configured: !!(folderId && saPath && saExists),
        gdrive_folder_id: folderId || null,
        service_account_path: saPath || null,
        service_account_exists: saExists,
        service_account_email: serviceAccountEmail,
        last_gdrive_upload: lastUpload || null,
        cron_installed: cronInstalled,
        backup_dir: BACKUP_DIR,
      },
    });
  } catch (e) {
    console.error('backup settings:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ═══════════════════════════════════════════════
// PATCH /api/backup/settings — update gdrive settings
// ═══════════════════════════════════════════════
router.patch('/settings', auth(['owner']), async (req, res) => {
  try {
    const { gdrive_folder_id, gdrive_service_account_path } = req.body;

    if (!gdrive_folder_id && !gdrive_service_account_path) {
      return res.status(400).json({
        success: false,
        message: 'Provide gdrive_folder_id dan/atau gdrive_service_account_path',
      });
    }

    let envContent = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';

    if (gdrive_folder_id) {
      envContent = setEnvVar(envContent, 'GDRIVE_FOLDER_ID', gdrive_folder_id);
    }

    if (gdrive_service_account_path) {
      // Validate the file exists and is valid JSON with required fields
      if (!fs.existsSync(gdrive_service_account_path)) {
        return res.status(400).json({
          success: false,
          message: `File tidak ditemukan: ${gdrive_service_account_path}`,
        });
      }
      try {
        const sa = JSON.parse(fs.readFileSync(gdrive_service_account_path, 'utf8'));
        if (!sa.client_email || !sa.private_key) {
          return res.status(400).json({
            success: false,
            message: 'File JSON bukan service account yang valid (missing client_email/private_key)',
          });
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: 'File bukan JSON yang valid: ' + e.message,
        });
      }
      envContent = setEnvVar(envContent, 'GDRIVE_SERVICE_ACCOUNT_JSON', gdrive_service_account_path);
    }

    fs.writeFileSync(ENV_FILE, envContent, 'utf8');

    res.json({
      success: true,
      message: 'Settings disimpan. Restart PM2 untuk apply: pm2 restart rajavavapor-api',
    });
  } catch (e) {
    console.error('backup settings patch:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Helper: extract env var from .env content ──
function extractEnvVar(content, key) {
  const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

// ── Helper: set/update env var in .env content ──
function setEnvVar(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    return content.replace(regex, line);
  }
  // Append with a newline separator
  return content.trimEnd() + '\n' + line + '\n';
}

module.exports = router;
