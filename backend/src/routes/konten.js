const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const auth    = require('../middleware/auth');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const UPLOAD_DIR = '/var/www/rajavavapor/uploads/konten';
const MIN_DURASI = 15;
const MAX_DURASI = 30;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
    + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `konten_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100*1024*1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4','.mov','.avi','.mkv','.webm','.m4v','.3gp','.hevc','.ts','.mts'];
    const allowedMime = ['video/mp4','video/quicktime','video/x-msvideo','video/x-matroska','video/webm','video/mp2t','video/3gpp','video/hevc'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || allowedMime.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format video tidak didukung. Gunakan MP4, MOV, AVI, MKV, atau WEBM.'));
  }
});

// POST /api/konten/upload
router.post('/upload', auth(), upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({success:false, message:'File video wajib diupload.'});

  try {
    const { cabang_id, tanggal } = req.body;

    // === FIX #4: personnel_id selalu dari DB, tidak boleh dari frontend ===
    const [[userRecord]] = await db.query(
      'SELECT personnel_id, nama_lengkap, cabang_id FROM users WHERE id=?',
      [req.user.id]
    );
    if (!userRecord?.personnel_id) {
      fs.unlinkSync(file.path);
      return res.status(403).json({success:false, message:'Akun tidak memiliki personnel_id. Hubungi admin.'});
    }
    const personnel_id  = userRecord.personnel_id;
    const nama_karyawan = userRecord.nama_lengkap || req.user.username || '';

    // Untuk role vaporista, paksa cabang sesuai data user; role lain bisa pilih cabang
    const cabang_id_final = (req.user.role === 'vaporista')
      ? (userRecord.cabang_id || cabang_id)
      : (cabang_id || userRecord.cabang_id);

    if (!cabang_id_final || !tanggal) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:'Data tidak lengkap (cabang/tanggal).'});
    }

    // === FIX #6: Validasi tanggal di backend — tidak boleh future, max 1 hari ke belakang ===
    const today     = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    if (tanggal > today) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:'Tanggal tidak boleh lebih dari hari ini.'});
    }
    if (tanggal < yesterday) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:`Tanggal tidak valid. Maksimal upload untuk kemarin (${yesterday}).`});
    }

    // ── PROTEKSI 0: Jam upload (05:30–22:00 WIB) ──────────────────────────────
    const nowWIB    = new Date(Date.now() + 7*3600*1000); // UTC+7
    const jamWIB    = nowWIB.getUTCHours() * 60 + nowWIB.getUTCMinutes();
    const JAM_BUKA  = 5 * 60 + 30;  // 05:30
    const JAM_TUTUP = 22 * 60;      // 22:00
    if (jamWIB < JAM_BUKA || jamWIB >= JAM_TUTUP) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:`Upload konten hanya diperbolehkan pukul 05:30–22:00 WIB. Sekarang ${String(nowWIB.getUTCHours()).padStart(2,'0')}:${String(nowWIB.getUTCMinutes()).padStart(2,'0')} WIB.`});
    }

    // Cek durasi pakai ffprobe
    let durasi = 0;
    try {
      const out = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${file.path}"`).toString().trim();
      durasi = parseFloat(out);
    } catch(e) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:'Gagal membaca durasi video.'});
    }

    if (durasi < MIN_DURASI || durasi > MAX_DURASI) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:`Durasi video ${durasi.toFixed(1)} detik. Harus antara ${MIN_DURASI}-${MAX_DURASI} detik.`});
    }

    // Hitung hash file (untuk deteksi file identik)
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');

    // Cek duplikasi hash file identik
    const [dupCheck] = await db.query('SELECT id, nama_karyawan, tanggal FROM konten_upload WHERE file_hash=?', [hash]);
    if (dupCheck.length) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:`Video duplikat! Video ini sudah diupload sebelumnya oleh ${dupCheck[0].nama_karyawan} pada ${dupCheck[0].tanggal}.`});
    }

    // Ekstrak metadata video (resolusi, codec, bitrate, creation_time)
    let videoMeta = {};
    try {
      const metaOut = execSync(`ffprobe -v quiet -print_format json -show_streams -show_format "${file.path}"`).toString();
      const metaJson = JSON.parse(metaOut);
      const vStream = metaJson.streams?.find(s => s.codec_type === 'video') || {};
      const fmt = metaJson.format || {};
      videoMeta = {
        codec        : vStream.codec_name || '',
        width        : vStream.width || 0,
        height       : vStream.height || 0,
        bitrate      : Math.round(parseFloat(fmt.bit_rate||0)/1000), // kbps
        size_kb      : Math.round(parseFloat(fmt.size||0)/1024),
        creation_time: vStream.tags?.creation_time || fmt.tags?.creation_time || null,
        nb_frames    : vStream.nb_frames || null
      };
    } catch(e) { console.error('Meta extract error:', e.message); }

    // === VALIDASI FRAUD DETECTION ===

    // 1. Cek creation_time vs tanggal upload (toleransi ±1 hari)
    //    Jika tidak ada metadata, coba inject otomatis via ffmpeg dulu
    let noMetadata = !videoMeta.creation_time;

    if (noMetadata) {
      // Auto-inject creation_time = tanggal upload ke file video
      // Selalu output ke .mp4 agar metadata bisa ditulis ke semua codec termasuk HEVC
      const injPath = file.path + '_injected.mp4';
      try {
        execSync(`ffmpeg -i "${file.path}" -movflags use_metadata_tags -metadata creation_time="${tanggal}T00:00:00.000000Z" -c copy "${injPath}" -y 2>/dev/null`);
        if (fs.existsSync(injPath) && fs.statSync(injPath).size > 1024) {
          fs.unlinkSync(file.path);
          // Ganti path file ke .mp4 baru
          const newPath = file.path.replace(/\.[^/.]+$/, '.mp4');
          fs.renameSync(injPath, newPath);
          file.path     = newPath;
          file.filename = path.basename(newPath);
          videoMeta.creation_time  = `${tanggal}T00:00:00.000000Z`;
          videoMeta.meta_injected  = true;
          noMetadata = false;
        } else {
          if (fs.existsSync(injPath)) fs.unlinkSync(injPath);
        }
      } catch(e) {
        if (fs.existsSync(injPath)) try { fs.unlinkSync(injPath); } catch(_) {}
        console.error('Meta inject error:', e.message);
      }
    }

    if (!noMetadata) {
      const recDate  = new Date(videoMeta.creation_time).toISOString().slice(0,10);
      const uplDate  = tanggal;
      const diffDays = Math.abs((new Date(recDate) - new Date(uplDate)) / (1000*60*60*24));
      if (diffDays > 1) {
        fs.unlinkSync(file.path);
        return res.status(400).json({success:false, message:`Video ditolak: waktu perekaman (${recDate}) tidak sesuai tanggal upload (${uplDate}). Kemungkinan video lama.`});
      }
    }

    // 2. Deteksi video blank/gelap (scene complexity)
    try {
      const midSec2 = Math.floor(durasi/2);
      const brightnessOut = execSync(`ffmpeg -ss ${midSec2} -i "${file.path}" -vframes 1 -vf "scale=64:64,format=gray" -f rawvideo pipe:1 2>/dev/null | python3 -c "import sys; d=sys.stdin.buffer.read(); print(sum(d)/len(d) if d else 0)"`).toString().trim();
      const brightness = parseFloat(brightnessOut) || 128;
      if (brightness < 10) {
        fs.unlinkSync(file.path);
        return res.status(400).json({success:false, message:'Video ditolak: video terlalu gelap/blank. Pastikan video merekam konten yang jelas.'});
      }
    } catch(e) { console.error('Blank check error:', e.message); }

    // 3. Cek GPS metadata
    let gpsInfo = null;
    let gpsLat = null, gpsLng = null;
    try {
      const gpsOut = execSync(`ffprobe -v quiet -print_format json -show_streams "${file.path}" 2>/dev/null`).toString();
      const gpsJson = JSON.parse(gpsOut);
      const loc = gpsJson.streams?.find(s => s.tags?.location || s.tags?.['com.apple.quicktime.location.ISO6709']);
      if (loc) {
        const locStr = loc.tags?.location || loc.tags?.['com.apple.quicktime.location.ISO6709'] || '';
        const match = locStr.match(/([+-][0-9.]+)([+-][0-9.]+)/);
        if (match) {
          gpsInfo = { lat: parseFloat(match[1]), lng: parseFloat(match[2]), raw: locStr };
          gpsLat = gpsInfo.lat;
          gpsLng = gpsInfo.lng;
        }
      }
    } catch(e) { console.error('GPS error:', e.message); }
    if (gpsInfo) videoMeta.gps = gpsInfo;

    // 3b. Validasi GPS vs koordinat cabang (jika keduanya tersedia)
    const [[cabangData]] = await db.query('SELECT lat, lng, nama FROM cabang WHERE id=?', [cabang_id_final]);
    if (cabangData?.lat && cabangData?.lng && gpsLat !== null && gpsLng !== null) {
      const distKm = haversineKm(gpsLat, gpsLng, parseFloat(cabangData.lat), parseFloat(cabangData.lng));
      videoMeta.gps_distance_m = Math.round(distKm * 1000);
      if (distKm > 0.5) { // toleransi 500 meter
        fs.unlinkSync(file.path);
        return res.status(400).json({success:false, message:`Video ditolak: lokasi GPS (${gpsLat.toFixed(5)}, ${gpsLng.toFixed(5)}) terlalu jauh dari toko ${cabangData.nama} (jarak ~${Math.round(distKm*1000)}m, batas 500m).`});
      }
    }

    // ── PROTEKSI TAMBAHAN: Audio, Freeze, Motion, Static-photo ──────────────

    // A. Cek audio stream (video tanpa audio = mencurigakan)
    let hasAudio = false;
    try {
      const auOut = execSync(`ffprobe -v quiet -print_format json -show_streams "${file.path}"`).toString();
      const auJson = JSON.parse(auOut);
      hasAudio = auJson.streams?.some(s => s.codec_type === 'audio') || false;
    } catch(e) { /* silent */ }
    if (!hasAudio) videoMeta.no_audio_flag = true;

    // B. Freeze detection — video beku/statis (foto diputar sebagai video)
    try {
      const freezeOut = execSync(
        `ffmpeg -i "${file.path}" -vf "freezedetect=n=-60dB:d=1.0" -f null - 2>&1 | grep freeze_duration || true`
      ).toString().trim();
      if (freezeOut) {
        // Hitung total detik freeze
        const durations = [...freezeOut.matchAll(/freeze_duration:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
        const totalFreeze = durations.reduce((a,b)=>a+b, 0);
        if (totalFreeze > durasi * 0.6) { // lebih dari 60% frozen
          fs.unlinkSync(file.path);
          return res.status(400).json({success:false,
            message:`Video ditolak: video terdeteksi diam/beku selama ${totalFreeze.toFixed(1)} detik dari total ${durasi.toFixed(1)} detik. Pastikan video menampilkan konten nyata.`});
        }
        if (totalFreeze > 0) videoMeta.freeze_seconds = parseFloat(totalFreeze.toFixed(1));
      }
    } catch(e) { console.error('Freeze detect error:', e.message); }

    // C. Scene change count — hitung perubahan scene nyata
    let sceneChangeCount = 0;
    try {
      const scOut = execSync(
        `ffmpeg -i "${file.path}" -vf "select='gt(scene,0.15)',showinfo" -f null - 2>&1 | grep -c "pts_time" || echo 0`
      ).toString().trim();
      sceneChangeCount = parseInt(scOut) || 0;
      videoMeta.scene_changes = sceneChangeCount;
    } catch(e) { /* silent */ }

    // Tolak jika tidak ada audio DAN tidak ada scene change (kemungkinan besar foto)
    if (!hasAudio && sceneChangeCount === 0) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false,
        message:'Video ditolak: tidak ada audio dan tidak ada pergerakan terdeteksi. Kemungkinan foto/gambar dijadikan video.'});
    }

    // D. Batas upload: 1 video per hari (cek tanggal hari ini)
    const [todayCheck] = await db.query(
      `SELECT COUNT(*) as c FROM konten_upload
       WHERE personnel_id=? AND status != 'rejected'
         AND tanggal = CURDATE()`,
      [personnel_id]
    );
    if ((todayCheck[0]?.c || 0) >= 1) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false,
        message:'Upload ditolak: kamu sudah upload konten hari ini. Coba lagi besok.'});
    }

    // 4. FIX #1 + #3: Ekstrak perceptual hash dari 3 frame (25%, 50%, 75%)
    //    FIX #3: cek frame hash lintas semua bulan (bukan hanya bulan ini)
    //    FIX #2: threshold lebih ketat (hamming ≤5) untuk video tanpa metadata
    const hammingThreshold = noMetadata ? 5 : 10;
    const frameHashes = [];
    const framePoints = [0.25, 0.5, 0.75];

    for (const pct of framePoints) {
      const sec = Math.max(0, Math.floor(durasi * pct));
      const framePath = file.path + `_f${pct}.jpg`;
      try {
        execSync(`ffmpeg -ss ${sec} -i "${file.path}" -vframes 1 -q:v 2 "${framePath}" -y 2>/dev/null`);
        if (fs.existsSync(framePath)) {
          const phashOut = execSync(`python3 -c "import imagehash,PIL.Image; print(imagehash.phash(PIL.Image.open('${framePath}')))"`)
            .toString().trim();
          if (phashOut) frameHashes.push(phashOut);
          fs.unlinkSync(framePath);
        }
      } catch(e) { /* frame extract gagal — lanjut */ }
    }

    const frameHash = frameHashes[1] || frameHashes[0] || null; // primary = frame tengah

    // E. Deteksi foto-dijadikan-video: semua frame terlalu mirip satu sama lain
    if (frameHashes.length >= 2) {
      let allSimilar = true;
      for (let i = 0; i < frameHashes.length && allSimilar; i++) {
        for (let j = i+1; j < frameHashes.length && allSimilar; j++) {
          try {
            const a = BigInt('0x'+frameHashes[i]), b = BigInt('0x'+frameHashes[j]);
            const dist = (a ^ b).toString(2).split('').filter(x=>x==='1').length;
            if (dist > 6) allSimilar = false; // frame cukup berbeda → bukan foto
          } catch(e) { allSimilar = false; }
        }
      }
      if (allSimilar) {
        fs.unlinkSync(file.path);
        return res.status(400).json({success:false,
          message:'Video ditolak: semua frame terdeteksi identik — kemungkinan foto dijadikan video atau screen recording gambar diam.'});
      }
    }

    if (frameHashes.length > 0) {
      // FIX #3: query semua bulan, bukan hanya bulan yang sama
      const [frameCheck] = await db.query(
        'SELECT id, nama_karyawan, tanggal, frame_hash FROM konten_upload WHERE frame_hash IS NOT NULL'
      );
      for (const existing of frameCheck) {
        if (!existing.frame_hash) continue;
        for (const newHash of frameHashes) {
          try {
            const a = BigInt('0x'+existing.frame_hash);
            const b = BigInt('0x'+newHash);
            const xor = a ^ b;
            const dist = xor.toString(2).split('').filter(x=>x==='1').length;
            if (dist <= hammingThreshold) {
              fs.unlinkSync(file.path);
              return res.status(400).json({success:false, message:`Video terdeteksi sangat mirip dengan konten ${existing.nama_karyawan} pada ${existing.tanggal}. Tidak bisa upload konten yang sama meski sudah di-rename atau di-rekompress.`});
            }
          } catch(e) { /* lewati jika hash tidak valid */ }
        }
      }
    }

    // Simpan semua frame hash di video_meta untuk referensi
    if (frameHashes.length > 0) videoMeta.frame_hashes = frameHashes;

    // Cek sudah upload untuk tanggal yang dipilih (bisa beda dari hari ini)
    const [tglCheck] = await db.query(
      'SELECT id FROM konten_upload WHERE personnel_id=? AND tanggal=? AND status != "rejected"',
      [personnel_id, tanggal]
    );
    if (tglCheck.length) {
      fs.unlinkSync(file.path);
      return res.status(400).json({success:false, message:'Sudah ada konten yang diupload untuk tanggal ini.'});
    }

    const bulan = tanggal.slice(0,7);
    await db.query(
      `INSERT INTO konten_upload
        (personnel_id, nama_karyawan, cabang_id, tanggal, bulan, filename,
         file_hash, frame_hash, durasi_detik, video_meta, no_metadata_flag, gps_lat, gps_lng)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [personnel_id, nama_karyawan, cabang_id_final, tanggal, bulan, file.filename,
       hash, frameHash, durasi, JSON.stringify(videoMeta),
       noMetadata ? 1 : 0, gpsLat, gpsLng]
    );

    res.json({
      success: true,
      message: `Video berhasil diupload (${durasi.toFixed(1)} detik). Menunggu review.`,
      durasi,
      no_metadata_flag: noMetadata
    });
  } catch(e) {
    if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(500).json({success:false, message:e.message});
  }
});

// GET /api/konten?bulan=&cabang_id=&status=
router.get('/', auth(), async (req, res) => {
  try {
    const { bulan, cabang_id, status } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (bulan)     { where += ' AND k.bulan=?';     params.push(bulan); }
    if (cabang_id) { where += ' AND k.cabang_id=?'; params.push(cabang_id); }
    if (status)    { where += ' AND k.status=?';    params.push(status); }
    const [rows] = await db.query(
      `SELECT k.*, c.nama AS nama_cabang FROM konten_upload k
       LEFT JOIN cabang c ON c.id=k.cabang_id
       ${where} ORDER BY k.tanggal DESC, k.created_at DESC`,
      params
    );
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// PATCH /api/konten/:id/open — reviewer membuka/memutar video (FIX #7)
router.patch('/:id/open', auth(['owner','manajer','admin_pusat']), async (req, res) => {
  try {
    await db.query(
      'UPDATE konten_upload SET review_opened_at=NOW() WHERE id=? AND review_opened_at IS NULL',
      [req.params.id]
    );
    res.json({success:true});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// PATCH /api/konten/:id/review - approve/reject
router.patch('/:id/review', auth(['owner','manajer','admin_pusat']), async (req, res) => {
  try {
    const { status, catatan_review } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({success:false,message:'Status tidak valid.'});
    const [[konten]] = await db.query('SELECT * FROM konten_upload WHERE id=?', [req.params.id]);
    if (!konten) return res.status(404).json({success:false,message:'Konten tidak ditemukan.'});

    // FIX #7: Reviewer harus membuka video sebelum approve (kecuali owner)
    if (status === 'approved' && !konten.review_opened_at && req.user.role !== 'owner') {
      return res.status(400).json({success:false, message:'Tonton video terlebih dahulu sebelum meng-approve.'});
    }

    await db.query(
      'UPDATE konten_upload SET status=?,catatan_review=?,reviewed_by=?,reviewed_at=NOW() WHERE id=?',
      [status, catatan_review||'', req.user.id, req.params.id]
    );

    // Jika approved — sync jumlah konten ke payroll_toko_input otomatis
    if (status === 'approved' && konten.personnel_id && konten.bulan) {
      try {
        const [[cnt]] = await db.query(
          "SELECT COUNT(*) AS total FROM konten_upload WHERE personnel_id=? AND bulan=? AND status='approved'",
          [konten.personnel_id, konten.bulan]
        );
        const jumlah = cnt.total || 0;
        const [[usr]] = await db.query(
          'SELECT cabang_id FROM users WHERE personnel_id=? LIMIT 1',
          [konten.personnel_id]
        );
        const cabang_id = usr ? usr.cabang_id : konten.cabang_id;
        await db.query(`
          INSERT INTO payroll_toko_input (personnel_id, nama, cabang_id, bulan, jumlah_konten)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE jumlah_konten = VALUES(jumlah_konten)
        `, [konten.personnel_id, konten.nama_karyawan||'', cabang_id, konten.bulan, jumlah]);
      } catch(syncErr) {
        console.error('Sync konten payroll error:', syncErr.message);
      }
    }

    res.json({success:true, message:`Konten ${status}.`});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

// GET /api/konten/rekap?bulan=&cabang_id=
router.get('/rekap', auth(), async (req, res) => {
  try {
    const { bulan, cabang_id } = req.query;
    let where = "WHERE k.status='approved'";
    const params = [];
    if (bulan)     { where += ' AND k.bulan=?';     params.push(bulan); }
    if (cabang_id) { where += ' AND k.cabang_id=?'; params.push(cabang_id); }
    const [rows] = await db.query(
      `SELECT k.personnel_id, k.nama_karyawan, k.cabang_id, c.nama AS nama_cabang,
       COUNT(*) AS jumlah_konten, GROUP_CONCAT(k.tanggal ORDER BY k.tanggal) AS tanggal_list
       FROM konten_upload k LEFT JOIN cabang c ON c.id=k.cabang_id
       ${where} GROUP BY k.personnel_id, k.nama_karyawan, k.cabang_id, c.nama`,
      params
    );
    res.json({success:true, data:rows});
  } catch(e) { res.status(500).json({success:false,message:e.message}); }
});

module.exports = router;

// GET /api/konten/my-cabang?personnel_id=
router.get('/my-cabang', auth(), async (req, res) => {
  try {
    const db2 = require('../config/database');
    let pid = req.query.personnel_id;
    if (!pid) {
      const [[usr]] = await db2.query('SELECT personnel_id FROM users WHERE id=?', [req.user.id]);
      pid = usr?.personnel_id;
    }
    if (!pid) return res.json({success:true, data:null, message:'Personnel ID tidak ditemukan.'});
    const [[kar]] = await db2.query('SELECT grup FROM payroll_karyawan WHERE personnel_id=?', [pid]);
    if (!kar) return res.json({success:true, data:null, message:'Karyawan tidak ditemukan di database.'});
    const [[cabang]] = await db2.query(
      `SELECT c.id, c.nama FROM cabang c
       JOIN cabang_kerjoo_grup ckg ON ckg.cabang_id = c.id
       WHERE ckg.kerjoo_group_name = ?`, [kar.grup]
    );
    res.json({success:true, data:cabang||null, grup:kar.grup});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// GET satu konten by id
router.get('/:id', auth(), async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT k.*, c.nama as nama_cabang FROM konten_upload k
       LEFT JOIN cabang c ON c.id=k.cabang_id
       WHERE k.id=?`, [req.params.id]);
    res.json({success:true, data:row||null});
  } catch(e){res.status(500).json({success:false,message:e.message});}
});
