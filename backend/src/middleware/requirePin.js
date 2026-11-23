'use strict';

const crypto = require('crypto');
const config = require('../config/config');

/** Guard for write/test endpoints. Header: X-Settings-Pin. Never logs the PIN. */
module.exports = function requirePin(req, res, next) {
  const expected = config.settings.pin;
  if (!expected) {
    return res.status(403).json({ success: false, message: 'SETTINGS_PIN belum dikonfigurasi di server' });
  }
  // Hash both sides so timingSafeEqual gets equal-length buffers
  const h = s => crypto.createHash('sha256').update(String(s || '')).digest();
  if (!crypto.timingSafeEqual(h(req.get('X-Settings-Pin')), h(expected))) {
    return res.status(401).json({ success: false, message: 'PIN salah' });
  }
  next();
};
