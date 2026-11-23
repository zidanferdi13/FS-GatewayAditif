'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

process.env.SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'set-')), 'settings.json');
process.env.SETTINGS_PIN = 'secret-pin';

/* ── Fake `serialport` so SerialService can be tested without hardware ── */
const opens = { count: 0, failFirst: 0 };
class FakeSerialPort extends EventEmitter {
  constructor(o) { super(); this.path = o.path; this.isOpen = false; this.opening = false; }
  open(cb) {
    opens.count++;
    if (opens.count <= opens.failFirst) return setImmediate(() => cb(new Error('Permission denied')));
    this.isOpen = true; setImmediate(() => cb(null));
  }
  close(cb) { this.isOpen = false; setImmediate(() => { this.emit('close'); cb && cb(); }); }
}
const spPath = require.resolve('serialport');
require.cache[spPath] = { id: spPath, filename: spPath, loaded: true, exports: { SerialPort: FakeSerialPort } };

const store = require('../settingsStore');
const config = require('../../config/config');
const requirePin = require('../../middleware/requirePin');
const SerialService = require('../serialService');
SerialService.RETRY_MS = 10;

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('settingsStore.validate', () => {
  it('accepts valid partial, empty port, by-id path', () => {
    const r = store.validate({ scales: { small: { port: '/dev/serial/by-id/usb-Prolific_X-if00-port0', baudRate: 9600 }, large: { port: '' } } });
    assert.ok(r.value, JSON.stringify(r));
  });
  it('rejects bad port, baud, printer name, ranges', () => {
    for (const bad of [
      { scales: { small: { port: '/etc/passwd' } } },
      { scales: { small: { baudRate: 1234 } } },
      { printer: { name: 'a; rm -rf /' } },
      { printer: { timeout: 5 } },
      { thresholds: { weightTolerance: 5 } },
      { loadcell: { maxWeight: 10, overloadThreshold: 50 } },
      null, []
    ]) assert.ok(store.validate(bad).errors, JSON.stringify(bad));
  });
});

describe('settingsStore load/save', () => {
  it('missing file keeps .env values', () => { store.load(); assert.ok(config.scales.small); });
  it('save is atomic and round-trips', () => {
    store.apply(store.validate({ thresholds: { smallScaleMaxKg: 5 } }).value);
    store.save();
    assert.ok(!fs.existsSync(`${store.FILE}.tmp`));
    config.thresholds.smallScaleMaxKg = 20;
    store.load();
    assert.equal(config.thresholds.smallScaleMaxKg, 5);
  });
  it('corrupt file does not throw', () => {
    fs.writeFileSync(store.FILE, '{not json');
    assert.doesNotThrow(() => store.load());
  });
});

describe('requirePin', () => {
  const run = (header) => {
    const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
    let called = false;
    requirePin({ get: () => header }, res, () => { called = true; });
    return { code: res.code, called };
  };
  it('ok with right pin', () => assert.deepEqual(run('secret-pin'), { code: null, called: true }));
  it('401 wrong/missing', () => { assert.equal(run('nope').code, 401); assert.equal(run(undefined).code, 401); });
  it('403 when pin not configured', () => {
    config.settings.pin = '';
    assert.equal(run('x').code, 403);
    config.settings.pin = 'secret-pin';
  });
});

describe('SerialService', () => {
  let cfg;
  beforeEach(() => { opens.count = 0; opens.failFirst = 0; cfg = { port: '/dev/ttyUSB9', baudRate: 9600 }; });

  it('empty port: disabled, no open, no retry', async () => {
    const s = new SerialService(null, 't', { port: '', baudRate: 9600 });
    await s.connect(); await sleep(40);
    assert.equal(opens.count, 0);
  });
  it('retries after failure, records error, then connects', async () => {
    opens.failFirst = 2;
    const s = new SerialService(null, 't', cfg);
    await s.connect();
    assert.equal(s.getStatus().error, 'Permission denied');
    await sleep(100);
    assert.equal(s.isConnected(), true);
    assert.equal(opens.count, 3);
    await s.disconnect();
  });
  it('disconnect stops retry; reconfigure does not double-open', async () => {
    opens.failFirst = 99;
    const s = new SerialService(null, 't', cfg);
    await s.connect();
    await s.disconnect();
    const n = opens.count; await sleep(60);
    assert.equal(opens.count, n);

    opens.count = 0; opens.failFirst = 0;
    const s2 = new SerialService(null, 't', cfg);
    await s2.connect();
    await s2.reconfigure();
    assert.equal(opens.count, 2);   // one per connect, never concurrent duplicates
    assert.equal(s2.isConnected(), true);
    await s2.disconnect();
  });
});
