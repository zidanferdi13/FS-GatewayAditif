'use strict';

/**
 * Runtime settings persisted to backend/data/settings.json.
 * Priority: settings.json > .env > code defaults.
 * apply() mutates the shared `config` objects in place so services holding
 * a reference (SerialService.serialConfig) see changes without re-wiring.
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config/config');

const FILE      = process.env.SETTINGS_FILE || path.join(__dirname, '../../data/settings.json');
const BAUDS     = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const PORT_RE   = /^(\/dev\/(ttyUSB|ttyACM|ttyS|ttyAMA)\d+|\/dev\/serial\/by-id\/[\w.:-]+|COM\d+)$/;
const SCALES    = ['small', 'large'];
// ponytail: printer name allowlist is checked in the controller (needs async lpstat).
const NAME_RE   = /^[\w.-]{1,127}$/;

const RANGES = {
  smallScaleMaxKg:    [0.1, 1000],
  weightTolerance:    [0.001, 0.1],
  autoConfirmDelayMs: [0, 10000],
  skipKemasanDelayMs: [0, 10000]
};

function current() {
  return {
    scales: {
      small: { port: config.scales.small.port, baudRate: config.scales.small.baudRate },
      large: { port: config.scales.large.port, baudRate: config.scales.large.baudRate }
    },
    printer: { name: config.printer.name, timeout: config.printer.timeout },
    loadcell: {
      maxWeight:         config.loadcell.max_weight,
      overloadThreshold: config.loadcell.overload_threshold
    },
    thresholds: { ...config.thresholds }
  };
}

const isNum = (v, [min, max]) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * Validate a partial settings object. Returns { value } (cleaned) or { errors }.
 * Unknown keys are dropped.
 */
function validate(input) {
  const errors = [];
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['Body harus object'] };

  if (input.scales !== undefined) {
    out.scales = {};
    for (const s of SCALES) {
      const v = input.scales && input.scales[s];
      if (v === undefined) continue;
      const o = {};
      if (v.port !== undefined) {
        if (typeof v.port !== 'string' || (v.port !== '' && !PORT_RE.test(v.port)))
          errors.push(`scales.${s}.port tidak valid`);
        else o.port = v.port;
      }
      if (v.baudRate !== undefined) {
        if (!BAUDS.includes(v.baudRate)) errors.push(`scales.${s}.baudRate harus salah satu dari ${BAUDS.join(', ')}`);
        else o.baudRate = v.baudRate;
      }
      out.scales[s] = o;
    }
  }

  if (input.printer !== undefined) {
    const p = input.printer || {};
    out.printer = {};
    if (p.name !== undefined) {
      if (typeof p.name !== 'string' || (p.name !== '' && !NAME_RE.test(p.name))) errors.push('printer.name tidak valid');
      else out.printer.name = p.name;
    }
    if (p.timeout !== undefined) {
      if (!isNum(p.timeout, [1000, 120000])) errors.push('printer.timeout harus 1000-120000 ms');
      else out.printer.timeout = p.timeout;
    }
  }

  if (input.loadcell !== undefined) {
    const l = input.loadcell || {};
    out.loadcell = {};
    for (const k of ['maxWeight', 'overloadThreshold']) {
      if (l[k] === undefined) continue;
      if (!isNum(l[k], [0.1, 100000])) errors.push(`loadcell.${k} harus 0.1-100000`);
      else out.loadcell[k] = l[k];
    }
  }

  if (input.thresholds !== undefined) {
    const t = input.thresholds || {};
    out.thresholds = {};
    for (const [k, range] of Object.entries(RANGES)) {
      if (t[k] === undefined) continue;
      if (!isNum(t[k], range)) errors.push(`thresholds.${k} harus ${range[0]}-${range[1]}`);
      else out.thresholds[k] = t[k];
    }
  }

  // Cross-field: overload <= max (using merged values)
  const cur = current();
  const max = (out.loadcell && out.loadcell.maxWeight)         ?? cur.loadcell.maxWeight;
  const ov  = (out.loadcell && out.loadcell.overloadThreshold) ?? cur.loadcell.overloadThreshold;
  if (ov > max) errors.push('loadcell.overloadThreshold tidak boleh melebihi maxWeight');

  return errors.length ? { errors } : { value: out };
}

/** Merge validated partial into config. Returns which scales changed (need reconfigure). */
function apply(v) {
  const changedScales = [];
  for (const s of SCALES) {
    const n = v.scales && v.scales[s];
    if (!n) continue;
    const t = config.scales[s];
    if ((n.port !== undefined && n.port !== t.port) || (n.baudRate !== undefined && n.baudRate !== t.baudRate)) {
      if (n.port !== undefined) t.port = n.port;
      if (n.baudRate !== undefined) t.baudRate = n.baudRate;
      changedScales.push(s);
    }
  }
  if (v.printer) Object.assign(config.printer, v.printer);
  if (v.loadcell) {
    if (v.loadcell.maxWeight !== undefined)         config.loadcell.max_weight = v.loadcell.maxWeight;
    if (v.loadcell.overloadThreshold !== undefined) config.loadcell.overload_threshold = v.loadcell.overloadThreshold;
  }
  if (v.thresholds) Object.assign(config.thresholds, v.thresholds);
  return { changedScales };
}

/** Load settings.json over .env defaults. Missing/corrupt file => keep .env values. */
function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`⚠️  settings.json tidak terbaca (${err.message}) — pakai .env`);
    return;
  }
  const r = validate(raw);
  if (r.errors) {
    console.error(`⚠️  settings.json tidak valid (${r.errors.join('; ')}) — pakai .env`);
    return;
  }
  apply(r.value);
}

/** Atomic write: temp file then rename. Persists the full current state. */
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...current() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

module.exports = { load, save, validate, apply, current, FILE };
