const express=require('express');const router=express.Router();const auth=require('../middleware/auth');
const KERJOO_URL=process.env.KERJOO_URL;const KERJOO_EMAIL=process.env.KERJOO_EMAIL;const KERJOO_PASS=process.env.KERJOO_PASSWORD;
let _token=null,_tokenExp=0;
async function getToken(){if(_token&&Date.now()<_tokenExp)return _token;const r=await fetch(KERJOO_URL+'/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:KERJOO_EMAIL,password:KERJOO_PASS})});const d=await r.json();if(!d.access_token)throw new Error('Gagal login Kerjoo');_token=d.access_token;_tokenExp=Date.now()+(23*60*60*1000);return _token;}
async function kg(path){const t=await getToken();const r=await fetch(KERJOO_URL+path,{headers:{'Authorization':'Bearer '+t}});return r.json();}
async function kgAll(path){const first=await kg(path+(path.includes('?')?'&':'?')+'per_page=100&page=1');const rows=first.data||[];const last=first.meta?.last_page||1;for(let p=2;p<=last;p++){const d=await kg(path+(path.includes('?')?'&':'?')+'per_page=100&page='+p);rows.push(...(d.data||[]));}return rows;}
router.get('/absensi',auth(),async(req,res)=>{try{const tgl=req.query.tanggal||new Date().toISOString().slice(0,10);const rows=await kgAll('/attendances/dailies-with-details?date='+tgl);res.json({success:true,data:rows,tanggal:tgl});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.get('/summary',auth(),async(req,res)=>{try{const tgl=req.query.tanggal||new Date().toISOString().slice(0,10);const d=await kg('/attendances/summary/daily?date='+tgl);res.json({success:true,data:d.data||d,tanggal:tgl});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.get('/rekap',auth(),async(req,res)=>{try{const b=req.query.bulan||new Date().toISOString().slice(0,7);const[y,m]=b.split('-');const d=await kg('/attendances/summaries?start_date='+b+'-01&end_date='+b+'-'+new Date(y,m,0).getDate()+'&per_page=500');res.json({success:true,data:d.data||d,bulan:b});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.get('/karyawan',auth(),async(req,res)=>{try{const[rows,grps]=await Promise.all([kgAll('/personnels'),kgAll('/groups')]);const grpMap={};grps.forEach(g=>{grpMap[g.id]=g.name;});rows.forEach(k=>{k.group_name=grpMap[k.group_id]||'Tanpa Grup';});res.json({success:true,data:rows,total:rows.length});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.get('/foto',async(req,res)=>{try{const url=req.query.url;if(!url||!url.includes('kerjoo.com'))return res.status(400).json({success:false});const t=await getToken();const r=await fetch(url,{headers:{Authorization:'Bearer '+t}});if(!r.ok)return res.status(404).send('');const buf=await r.arrayBuffer();const ct=r.headers.get('content-type')||'image/jpeg';res.set('Content-Type',ct);res.set('Cache-Control','public,max-age=86400');res.send(Buffer.from(buf));}catch(e){res.status(500).send('');}});

router.get('/rekap-bulan',auth(),async(req,res)=>{
  try{
    const bulan=req.query.bulan||new Date().toISOString().slice(0,7);
    const[y,m]=bulan.split('-');
    const daysInMonth=new Date(y,m,0).getDate();
    const today=new Date().toISOString().slice(0,10);
    // Fetch semua hari dalam bulan
    // Ambil tanggal yang sudah digenerate per karyawan
    const db2=require('../config/database');
    const [genRows]=await db2.query(
      `SELECT keterangan, tanggal FROM pengeluaran WHERE keterangan LIKE 'Uang makan gudang%' AND DATE_FORMAT(tanggal,'%Y-%m')=? AND kategori_id=24`,
      [bulan]
    );
    // Map: personnel_id -> Set of tanggal sudah generate
    const genMap={};
    genRows.forEach(r=>{
      const m=r.keterangan.match(/pid:(\d+)/);
      if(m){
        if(!genMap[m[1]])genMap[m[1]]=new Set();
        genMap[m[1]].add(r.tanggal.toISOString?r.tanggal.toISOString().slice(0,10):r.tanggal.slice(0,10));
      }
    });
    const rekapMap={};
    const promises=[];
    for(let d=1;d<=daysInMonth;d++){
      const tgl=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if(tgl>today)break;
      promises.push(kgAll('/attendances/dailies-with-details?date='+tgl).then(rows=>{
        rows.forEach(r=>{
          const grp=(r.personnel?.group?.name||'').toUpperCase();
          const pid=r.personnel_id;
          // Hanya hitung hadir jika ada clock IN (type_id=1)
          const atts = r.attendances||[];
          const hasClockIn = atts.some(a => a.type_id===1);
          if(!hasClockIn) return;
          if(!rekapMap[pid]){
            rekapMap[pid]={
              personnel_id:pid,
              name:r.personnel?.name||'',
              group_name:r.personnel?.group?.name||'',
              position:r.personnel?.position?.name||r.personnel?.old_position||'',
              pid_nik:r.personnel?.pid||'',
              hadir:0,
              telat:0,
              tanggal_hadir:[]
            };
          }
          // Deduplikasi - skip jika tanggal sudah ada
          if(!rekapMap[pid].tanggal_hadir.includes(tgl)){
            rekapMap[pid].hadir++;
            if(r.is_late)rekapMap[pid].telat++;
            rekapMap[pid].tanggal_hadir.push(tgl);
          }
        });
      }));
    }
    await Promise.all(promises);
    res.json({success:true,data:Object.values(rekapMap),bulan});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});


router.get('/rekap-gudang',auth(),async(req,res)=>{
  try{
    const bulan=req.query.bulan||new Date().toISOString().slice(0,7);
    const[y,m]=bulan.split('-');
    const daysInMonth=new Date(y,m,0).getDate();
    const today=new Date().toISOString().slice(0,10);
    // Ambil tanggal yang sudah digenerate per karyawan
    const db2=require('../config/database');
    const [genRows]=await db2.query(
      `SELECT keterangan, tanggal FROM pengeluaran WHERE keterangan LIKE 'Uang makan gudang%' AND DATE_FORMAT(tanggal,'%Y-%m')=? AND kategori_id=24`,
      [bulan]
    );
    // Map: personnel_id -> Set of tanggal sudah generate
    const genMap={};
    genRows.forEach(r=>{
      const m=r.keterangan.match(/pid:(\d+)/);
      if(m){
        if(!genMap[m[1]])genMap[m[1]]=new Set();
        genMap[m[1]].add(r.tanggal.toISOString?r.tanggal.toISOString().slice(0,10):r.tanggal.slice(0,10));
      }
    });
    const rekapMap={};
    const promises=[];
    for(let d=1;d<=daysInMonth;d++){
      const tgl=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      if(tgl>today)break;
      promises.push(kgAll('/attendances/dailies-with-details?date='+tgl).then(rows=>{
        rows.forEach(r=>{
          const grp=(r.personnel?.group?.name||'').toUpperCase();
          if(!grp.includes('GUDANG'))return;
          const pid=r.personnel_id;
          if(!rekapMap[pid]){
            rekapMap[pid]={
              personnel_id:pid,
              name:r.personnel?.name||'',
              group_name:r.personnel?.group?.name||'',
              position:r.personnel?.position?.name||r.personnel?.old_position||'',
              pid_nik:r.personnel?.pid||'',
              detail:[]
            };
          }
          const logMasuk=(r.attendances||[]).find(a=>a.type?.name==='Masuk');
          if(logMasuk){
            const[hh,mm]=(logMasuk.log_time||'00:00:00').split(':').map(Number);
            const wibH=(hh+7)%24;
            const wibM=mm;
            rekapMap[pid].detail.push({tanggal:tgl,jam_masuk_wib:`${String(wibH).padStart(2,'0')}:${String(wibM).padStart(2,'0')}`});
          }
        });
      }));
    }
    await Promise.all(promises);
    // Hitung insentif & uang makan per karyawan
    const INSENTIF=10000;const MAKAN=10000;
    const SHIFT1_ON_TIME=9*60;const SHIFT1_LATE=9*60+15;
    const SHIFT2_ON_TIME=15*60;const SHIFT2_LATE=15*60+15;
    Object.values(rekapMap).forEach(k=>{
      let total_insentif=0,total_makan=0,hadir=0;
      k.detail.forEach(d=>{
        const[hh,mm]=d.jam_masuk_wib.split(':').map(Number);
        const menit=hh*60+mm;
        hadir++;
        // Deteksi shift berdasarkan jam masuk
        const isShift1=menit<12*60;
        const threshold_on=isShift1?SHIFT1_ON_TIME:SHIFT2_ON_TIME;
        const threshold_late=isShift1?SHIFT1_LATE:SHIFT2_LATE;
        // Lembur (hadir di luar shift normal) tetap dapat uang makan + insentif
        const isLembur=(isShift1&&menit>=12*60)||((!isShift1)&&menit<6*60);
        if(isLembur){d.status='on_time';d.lembur=true;total_insentif+=INSENTIF;total_makan+=MAKAN;}
        else if(menit<=threshold_on){d.status='on_time';total_insentif+=INSENTIF;total_makan+=MAKAN;}
        else if(menit<=threshold_late){d.status='late_ok';total_makan+=MAKAN;}
        else{d.status='late';}
        d.shift=isShift1?1:2;
      });
      k.hadir=hadir;
      k.total_insentif=total_insentif;
      k.total_makan=total_makan;
      k.total_tunjangan=total_insentif+total_makan;
      k.detail.sort((a,b)=>a.tanggal.localeCompare(b.tanggal));
    });
    res.json({success:true,data:Object.values(rekapMap),bulan,rate:{insentif:INSENTIF,makan:MAKAN}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});


router.post('/generate-uang-makan',auth(),async(req,res)=>{
  try{
    const {bulan, data, kas_akun_id, cabang_id} = req.body;
    if(!bulan||!data?.length) return res.status(400).json({success:false,message:'Data tidak lengkap.'});
    const db=require('../config/database');
    const KATEGORI_UANG_MAKAN=24;
    const KAS_AKUN=kas_akun_id||8;
    let totalMakan=0, totalInsentif=0, inserted=0;
    // Cek yang sudah digenerate bulan ini
    const [existing]=await db.query(
      "SELECT keterangan FROM pengeluaran WHERE keterangan LIKE ? AND DATE_FORMAT(tanggal,'%Y-%m')=?",
      ['Uang makan gudang%'+bulan+'%', bulan]
    );
    const existingIds=new Set(existing.map(e=>{const m=e.keterangan.match(/pid:(\d+)/);return m?parseInt(m[1]):0;}).filter(Boolean));
    for(const k of data){
      if(!k.total_makan&&!k.total_insentif) continue;
      if(existingIds.has(k.personnel_id)) continue; // Skip yang sudah digenerate
      // Catat pengeluaran uang makan
      if(k.total_makan>0){
        await db.query(
          'INSERT INTO pengeluaran (cabang_id,kategori_id,user_id,tanggal,nominal,keterangan,status) VALUES (?,?,?,?,?,?,?)',
          [cabang_id||null, KATEGORI_UANG_MAKAN, req.user.id,
           new Date().toISOString().slice(0,10), k.total_makan,
           'Uang makan gudang - '+k.name+' ('+bulan+') pid:'+k.personnel_id, 'approved']
        );
        // Mutasi kas keluar
        await db.query(
          'INSERT INTO kas_mutasi (akun_id,tanggal,tipe,nominal,keterangan,created_by) VALUES (?,?,?,?,?,?)',
          [KAS_AKUN,new Date().toISOString().slice(0,10),'keluar',k.total_makan,'Uang makan '+k.name+' '+bulan,req.user.id]
        );
        await db.query('UPDATE kas_akun SET saldo_awal=saldo_awal-? WHERE id=?',[k.total_makan,KAS_AKUN]);
        totalMakan+=k.total_makan;
        inserted++;
      }
      // Simpan insentif ke tabel payroll_insentif_gudang
      if(k.total_insentif>0){
        await db.query(
          `INSERT INTO payroll_insentif_gudang (personnel_id,nama,bulan,total_insentif,total_makan)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE total_insentif=VALUES(total_insentif),total_makan=VALUES(total_makan)`,
          [k.personnel_id, k.name, bulan, k.total_insentif, k.total_makan||0]
        );
      }
      totalInsentif+=k.total_insentif||0;
    }
    res.json({success:true,message:`Uang makan ${inserted} karyawan (${rp(totalMakan)}) dicatat ke KAS ADMIN. Insentif absensi ${rp(totalInsentif)} masuk ke payroll.`,total_makan:totalMakan,total_insentif:totalInsentif});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
function rp(n){return 'Rp '+parseInt(n||0).toLocaleString('id-ID');}


router.get('/cek-uang-makan',auth(),async(req,res)=>{
  try{
    const bulan=req.query.bulan||new Date().toISOString().slice(0,7);
    const db=require('../config/database');
    const [rows]=await db.query(
      "SELECT keterangan FROM pengeluaran WHERE keterangan LIKE ? AND DATE_FORMAT(tanggal,'%Y-%m')=? AND kategori_id=24",
      ['Uang makan gudang%', bulan]
    );
    const generatedIds=new Set();
    const generatedNames=[];
    rows.forEach(r=>{
      const mId=r.keterangan.match(/pid:([0-9]+)/);
      const mNm=r.keterangan.match(/Uang makan gudang - (.+?) \(/);
      if(mId) generatedIds.add(parseInt(mId[1]));
      if(mNm) generatedNames.push(mNm[1]);
    });
    res.json({success:true,generated_ids:[...generatedIds],generated:generatedNames,bulan,total:generatedIds.size});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

module.exports=router;

// GET /api/kerjoo/koreksi-absensi?bulan=
router.get('/koreksi-absensi', auth(), async (req, res) => {
  try {
    const bulan = req.query.bulan || new Date().toISOString().slice(0,7);
    const db = require('../config/database');
    const [rows] = await db.query(
      'SELECT * FROM absensi_koreksi WHERE bulan=? ORDER BY nama', [bulan]
    );
    res.json({ success:true, data:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// POST /api/kerjoo/koreksi-absensi
router.post('/koreksi-absensi', auth(['owner']), async (req, res) => {
  try {
    const { personnel_id, nama, bulan, koreksi_hari, alasan } = req.body;
    if (!personnel_id||!bulan) return res.status(400).json({success:false,message:'Data tidak lengkap.'});
    const db = require('../config/database');
    await db.query(
      `INSERT INTO absensi_koreksi (personnel_id,nama,bulan,koreksi_hari,alasan,created_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE koreksi_hari=VALUES(koreksi_hari),alasan=VALUES(alasan)`,
      [personnel_id, nama, bulan, koreksi_hari||0, alasan||'', req.user.id]
    );
    res.json({success:true, message:'Koreksi disimpan.'});
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// DELETE /api/kerjoo/koreksi-absensi/:personnel_id/:bulan
router.delete('/koreksi-absensi/:personnel_id/:bulan', auth(['owner']), async (req, res) => {
  try {
    const db = require('../config/database');
    await db.query('DELETE FROM absensi_koreksi WHERE personnel_id=? AND bulan=?',
      [req.params.personnel_id, req.params.bulan]);
    res.json({success:true, message:'Koreksi dihapus.'});
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── SYNC ABSENSI HARI INI (cache lokal dari Kerjoo) ──
let _lastSyncAbsensi = 0;
router.post('/sync-absensi-hari-ini', auth(), async (req, res) => {
  try {
    // Rate limit: max 1x per 2 menit
    if (Date.now() - _lastSyncAbsensi < 120000)
      return res.json({success:true, message:'Sync terlalu cepat, gunakan cache.', cached:true});
    _lastSyncAbsensi = Date.now();

    const db2 = require('../config/database');
    const tgl = new Date().toISOString().slice(0,10);
    const rows = await kgAll('/attendances/dailies-with-details?date=' + tgl);

    // Map personnel_id ke user_id
    const [userRows] = await db2.query('SELECT id, personnel_id FROM users WHERE personnel_id IS NOT NULL AND aktif=1');
    const pidToUid = {};
    userRows.forEach(u => { pidToUid[u.personnel_id] = u.id; });

    let synced = 0;
    for (const r of rows) {
      const pid = r.personnel_id;
      const uid = pidToUid[pid];
      if (!uid) continue;

      const atts = r.attendances || [];
      const clockIn = atts.find(a => a.type_id === 1 || (a.type?.name||'').toLowerCase() === 'masuk');
      const clockOut = atts.find(a => a.type_id === 2 || (a.type?.name||'').toLowerCase() === 'pulang');

      let status = 'tidak_hadir';
      let ciTime = null, coTime = null;
      if (clockIn) {
        const [hh, mm, ss] = (clockIn.log_time || '00:00:00').split(':').map(Number);
        const wibH = (hh + 7) % 24;
        ciTime = `${String(wibH).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss||0).padStart(2,'0')}`;
        status = 'hadir';
      }
      if (clockOut) {
        const [hh, mm, ss] = (clockOut.log_time || '00:00:00').split(':').map(Number);
        const wibH = (hh + 7) % 24;
        coTime = `${String(wibH).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss||0).padStart(2,'0')}`;
        status = 'pulang';
      }

      await db2.query(`INSERT INTO absensi_hari_ini (user_id, personnel_id, tanggal, clock_in, clock_out, status)
        VALUES (?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE clock_in=VALUES(clock_in), clock_out=VALUES(clock_out), status=VALUES(status)`,
        [uid, pid, tgl, ciTime, coTime, status]);
      synced++;
    }
    res.json({success:true, message:`${synced} absensi disync.`, synced});
  } catch(e) {
    console.error('sync-absensi:', e.message);
    res.status(500).json({success:false, message:e.message});
  }
});

// GET /api/kerjoo/status-saya — cek status absensi user login hari ini
router.get('/status-saya', auth(), async (req, res) => {
  try {
    const db2 = require('../config/database');
    const tgl = new Date().toISOString().slice(0,10);
    const GUDANG_IDS = [3, 4];

    // Gudang kasir & owner/admin selalu diizinkan
    if (GUDANG_IDS.includes(req.user.cabang_id))
      return res.json({success:true, data:{status:'hadir', exempt:true, reason:'Gudang'}});
    if (!['kasir','kasir_sales','vaporista','kepala_cabang'].includes(req.user.role))
      return res.json({success:true, data:{status:'hadir', exempt:true, reason:'Role exempt'}});
    if (!req.user.personnel_id)
      return res.json({success:true, data:{status:'hadir', exempt:true, reason:'Belum terhubung Kerjoo'}});

    const [[row]] = await db2.query(
      'SELECT status, clock_in, clock_out FROM absensi_hari_ini WHERE user_id=? AND tanggal=?',
      [req.user.id, tgl]);

    if (!row)
      return res.json({success:true, data:{status:'belum_sync', clock_in:null, clock_out:null}});

    res.json({success:true, data:{status: row.status, clock_in: row.clock_in, clock_out: row.clock_out}});
  } catch(e) { res.status(500).json({success:false, message:e.message}); }
});

// Export helper for use by other modules (e.g., dashboard)
module.exports = router;
module.exports._kgAll = kgAll;
