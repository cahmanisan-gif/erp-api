const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../config/database');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success:false, message:'Username dan password wajib diisi.' });

    const [rows] = await db.query(
      `SELECT u.*, c.nama as nama_cabang
       FROM users u
       LEFT JOIN cabang c ON u.cabang_id = c.id
       WHERE u.username = ? AND u.aktif = 1`,
      [username.trim().toLowerCase()]
    );

    if (!rows.length)
      return res.status(401).json({ success:false, message:'Username tidak ditemukan.' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ success:false, message:'Password salah.' });

    const token = jwt.sign(
      { id:user.id, username:user.username, role:user.role, cabang_id:user.cabang_id, personnel_id:user.personnel_id||null },
      process.env.JWT_SECRET,
      { expiresIn:'8h' }
    );

    res.json({
      success : true,
      token   : token,
      user    : {
        id           : user.id,
        username     : user.username,
        nama_lengkap : user.nama_lengkap,
        role         : user.role,
        cabang_id    : user.cabang_id,
        nama_cabang  : user.nama_cabang,
        personnel_id : user.personnel_id||null
      }
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success:false, message:'Server error.' });
  }
});

module.exports = router;
