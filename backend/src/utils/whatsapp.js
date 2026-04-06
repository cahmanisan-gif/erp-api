const db = require('../config/database');

// ── Cache wa_setting in memory, refresh every 60s ──
let _settings = null;
let _settingsTs = 0;

async function getSettings() {
  if (_settings && Date.now() - _settingsTs < 60000) return _settings;
  const [rows] = await db.query('SELECT key_name, value FROM wa_setting');
  _settings = {};
  rows.forEach(r => { _settings[r.key_name] = r.value; });
  _settingsTs = Date.now();
  return _settings;
}

// Force refresh cache (after settings update)
function clearSettingsCache() { _settings = null; _settingsTs = 0; }

// ── Log to wa_log ──
async function logWA({ tujuan, pesan, tipe, status, response_text, ref_type, ref_id }) {
  try {
    const [result] = await db.query(
      `INSERT INTO wa_log (tujuan, pesan, tipe, status, response_text, ref_type, ref_id)
       VALUES (?,?,?,?,?,?,?)`,
      [tujuan, pesan, tipe || 'info', status || 'pending', response_text || null, ref_type || null, ref_id || null]
    );
    return result.insertId;
  } catch (e) {
    console.error('logWA error:', e.message);
    return null;
  }
}

/**
 * Send WhatsApp message via Fonnte-style gateway
 * @param {string} phone  - target phone number
 * @param {string} message - text message
 * @param {object} opts   - { tipe, ref_type, ref_id }
 * @returns {object} { success, logId, status, response }
 */
async function sendWA(phone, message, opts = {}) {
  const settings = await getSettings();
  const { tipe = 'info', ref_type = null, ref_id = null } = opts;

  // If WA feature disabled, log and skip
  if (settings.wa_aktif !== '1') {
    const logId = await logWA({
      tujuan: phone, pesan: message, tipe,
      status: 'disabled', response_text: 'Fitur WA nonaktif',
      ref_type, ref_id
    });
    return { success: false, logId, status: 'disabled', response: 'Fitur WA nonaktif' };
  }

  const url = settings.wa_gateway_url;
  const apiKey = settings.wa_api_key;

  if (!url || !apiKey || apiKey === 'placeholder_ganti_nanti') {
    const logId = await logWA({
      tujuan: phone, pesan: message, tipe,
      status: 'failed', response_text: 'API key belum dikonfigurasi',
      ref_type, ref_id
    });
    return { success: false, logId, status: 'failed', response: 'API key belum dikonfigurasi' };
  }

  // Log as pending first
  const logId = await logWA({
    tujuan: phone, pesan: message, tipe,
    status: 'pending', ref_type, ref_id
  });

  try {
    // Fonnte-style API: POST with Authorization header, form body
    const formBody = new URLSearchParams({ target: phone, message });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': apiKey,
      },
      body: formBody,
    });

    const text = await res.text();
    let responseData;
    try { responseData = JSON.parse(text); } catch { responseData = { raw: text }; }

    const sent = res.ok && (responseData.status === true || responseData.status === 'true');
    const finalStatus = sent ? 'sent' : 'failed';

    // Update log with result
    if (logId) {
      await db.query(
        'UPDATE wa_log SET status=?, response_text=? WHERE id=?',
        [finalStatus, text.substring(0, 500), logId]
      ).catch(() => {});
    }

    return { success: sent, logId, status: finalStatus, response: responseData };
  } catch (e) {
    // Network error
    if (logId) {
      await db.query(
        'UPDATE wa_log SET status=?, response_text=? WHERE id=?',
        ['failed', e.message.substring(0, 500), logId]
      ).catch(() => {});
    }
    return { success: false, logId, status: 'failed', response: e.message };
  }
}

// ── Templates ──
const TEMPLATES = {
  stok_kritis: (data) =>
    `[RAJA VAPOR - STOK KRITIS]\n\n` +
    `Cabang: ${data.cabang}\n` +
    `${data.items.map(i => `- ${i.nama}: sisa ${i.qty} (min: ${i.minimum})`).join('\n')}\n\n` +
    `Segera lakukan restock. Cek di portal: https://poinraja.com`,

  sewa_jatuh_tempo: (data) =>
    `[RAJA VAPOR - SEWA JATUH TEMPO]\n\n` +
    `Cabang: ${data.cabang}\n` +
    `Jenis: ${data.jenis}\n` +
    `Jatuh tempo: ${data.tgl_selesai}\n` +
    `Sisa: ${data.sisa_hari} hari\n\n` +
    `Segera perpanjang atau hubungi pemilik ruko.`,

  target_warning: (data) =>
    `[RAJA VAPOR - TARGET BULAN INI]\n\n` +
    `Halo ${data.nama},\n` +
    `Pencapaian target kamu baru ${data.persen}% (Rp ${data.tercapai} dari Rp ${data.target}).\n` +
    `Sudah tanggal ${data.tanggal}, ayo kejar target!\n\n` +
    `Semangat! - Raja Vapor`,

  transaksi_besar: (data) =>
    `[RAJA VAPOR - TRANSAKSI BESAR]\n\n` +
    `Cabang: ${data.cabang}\n` +
    `Kasir: ${data.kasir}\n` +
    `Total: Rp ${data.total}\n` +
    `Waktu: ${data.waktu}\n\n` +
    `Transaksi di atas threshold Rp ${data.threshold}.`,

  broadcast: (data) =>
    `[RAJA VAPOR]\n\n${data.pesan}`,
};

/**
 * Send WA using a named template
 * @param {string} phone
 * @param {string} template - template name from TEMPLATES
 * @param {object} data     - data to fill template
 * @param {object} opts     - { ref_type, ref_id }
 */
async function sendWATemplate(phone, template, data, opts = {}) {
  const fn = TEMPLATES[template];
  if (!fn) {
    console.error(`WA template "${template}" not found`);
    return { success: false, status: 'failed', response: 'Template tidak ditemukan' };
  }
  const message = fn(data);
  return sendWA(phone, message, { tipe: 'alert', ...opts });
}

module.exports = { sendWA, sendWATemplate, getSettings, clearSettingsCache, logWA };
