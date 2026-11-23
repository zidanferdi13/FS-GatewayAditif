'use strict';
// TEMP - bukti temuan review. Hapus setelah diperbaiki / dipindah ke settings.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));
const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
process.env.SETTINGS_FILE = path.join(blocker, 'sub', 'settings.json'); // parent is a FILE => save() throws

const store = require('../settingsStore');
const config = require('../../config/config');
const Controller = require('../../controllers/settingsController');

const mkRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const serial = () => ({ calls: 0, getStatus: () => ({}), async reconfigure() { this.calls++; } });

describe('review findings', () => {
  it('F1: validate() throws TypeError on null sub-objects (-> HTTP 500, not 400)', () => {
    assert.throws(() => store.validate({ scales: null }), TypeError);
    assert.throws(() => store.validate({ scales: { small: null } }), TypeError);
  });

  it('F2: update() mutates live config BEFORE save() fails', async () => {
    const before = config.thresholds.smallScaleMaxKg;
    const c = new Controller({ small: serial(), large: serial() }, { listQueues: async () => [], setConfig() {} });
    const res = mkRes(); let err = null;
    await c.update({ body: { thresholds: { smallScaleMaxKg: 7 } } }, res, e => { err = e; });
    assert.ok(err, 'save should have failed');
    assert.equal(config.thresholds.smallScaleMaxKg, 7, 'in-memory value changed although not persisted');
    config.thresholds.smallScaleMaxKg = before;
  });

  it('F3: saving an unrelated section is blocked when CUPS is down', async () => {
    const c = new Controller({ small: serial(), large: serial() }, { listQueues: async () => { throw new Error('cups down'); }, setConfig() {} });
    const res = mkRes();
    await c.update({ body: { printer: { name: 'XP-420B-RAW' }, thresholds: { weightTolerance: 0.03 } } }, res, () => {});
    assert.equal(res.code, 502);
  });
});
