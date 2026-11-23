'use strict';

const fs     = require('fs');
const path   = require('path');
const { SerialPort } = require('serialport');
const config = require('../config/config');
const store  = require('../services/settingsStore');

const BY_ID_DIR = '/dev/serial/by-id';

class SettingsController {
  /** @param {{small, large}} serials SerialService instances @param printerService */
  constructor(serials, printerService) {
    this.serials = serials;
    this.printer = printerService;
  }

  _snapshot() {
    return {
      ...store.current(),
      status: {
        small: this.serials.small.getStatus(),
        large: this.serials.large.getStatus()
      }
    };
  }

  /** GET /api/settings/public — no auth, thresholds only */
  getPublic(req, res) {
    res.json({ success: true, data: { ...config.thresholds } });
  }

  /** GET /api/settings */
  get(req, res) {
    res.json({ success: true, data: this._snapshot() });
  }

  /** PUT /api/settings */
  async update(req, res, next) {
    try {
      const r = store.validate(req.body);
      if (r.errors) return res.status(400).json({ success: false, message: r.errors.join('; ') });

      // Printer must be an existing CUPS queue (also blocks arbitrary names reaching `lp -d`)
      if (r.value.printer && r.value.printer.name) {
        let queues;
        try { queues = await this.printer.listQueues(); }
        catch (e) { return res.status(502).json({ success: false, message: `CUPS tidak tersedia: ${e.message}` }); }
        if (!queues.some(q => q.name === r.value.printer.name)) {
          return res.status(400).json({ success: false, message: 'Queue printer tidak ditemukan di CUPS' });
        }
      }

      const { changedScales } = store.apply(r.value);
      this.printer.setConfig({ name: config.printer.name, timeout: config.printer.timeout });
      store.save();
      await Promise.all(changedScales.map(s => this.serials[s].reconfigure()));

      res.json({ success: true, data: this._snapshot() });
    } catch (err) { next(err); }
  }

  /** GET /api/settings/ports — detected serial ports (+ stable by-id symlinks) */
  async ports(req, res, next) {
    try {
      const byId = {};
      try {
        for (const n of fs.readdirSync(BY_ID_DIR)) {
          byId[fs.realpathSync(path.join(BY_ID_DIR, n))] = path.join(BY_ID_DIR, n);
        }
      } catch { /* dir absent: no USB-serial attached (or non-Linux) */ }

      const list = await SerialPort.list();
      const data = list.map(p => ({
        path:         p.path,
        byId:         byId[p.path] || null,
        manufacturer: p.manufacturer || null,
        serialNumber: p.serialNumber || null
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  }

  /** GET /api/settings/printers */
  async printers(req, res) {
    try {
      res.json({ success: true, data: await this.printer.listQueues() });
    } catch (e) {
      res.status(502).json({ success: false, message: `CUPS tidak tersedia: ${e.message}` });
    }
  }

  /** POST /api/settings/printer/test */
  async printerTest(req, res) {
    try {
      await this.printer.printTest();
      res.json({ success: true, data: {} });
    } catch (e) {
      const status = e.name === 'PrinterTimeoutError' ? 504 : 502;
      res.status(status).json({ success: false, message: e.message });
    }
  }

  /** POST /api/settings/scales/:scale/reconnect */
  async reconnect(req, res, next) {
    try {
      const svc = this.serials[req.params.scale];
      if (!svc || !Object.hasOwn(this.serials, req.params.scale)) {
        return res.status(400).json({ success: false, message: 'scale harus small atau large' });
      }
      await svc.reconfigure();
      res.json({ success: true, data: svc.getStatus() });
    } catch (err) { next(err); }
  }
}

module.exports = SettingsController;
