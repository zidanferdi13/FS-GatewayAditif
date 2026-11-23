'use strict';

/**
 * PrinterService
 * Sends raw TSPL labels to a CUPS printer queue on Debian/Linux.
 */

const { execFile } = require('child_process');
const TSPLBuilder = require('./TSPLBuilder');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
  });
}

class PrinterNotFoundError extends Error {
  constructor(m) { super(m); this.name = 'PrinterNotFoundError'; }
}
class PrinterOfflineError extends Error {
  constructor(m) { super(m); this.name = 'PrinterOfflineError'; }
}
class PrinterTimeoutError extends Error {
  constructor(m) { super(m); this.name = 'PrinterTimeoutError'; }
}

class PrinterService {
  constructor(config = {}) {
    this._printerName = config.name || '';
    this._timeout = config.timeout || 30000;
    console.log('PrinterService init: "' + this._printerName + '"');
  }

  getPrinterName() { return this._printerName; }

  setConfig({ name, timeout } = {}) {
    if (name !== undefined) this._printerName = name;
    if (timeout !== undefined) this._timeout = timeout;
  }

  /** CUPS queues with state. Throws when CUPS is unavailable. */
  async listQueues() {
    const out = await run('lpstat', ['-p']);
    // "printer NAME is idle.  enabled since ..." / "printer NAME disabled since ..."
    return out.split('\n').map(l => l.match(/^printer (\S+) (.*)$/)).filter(Boolean)
      .map(m => ({ name: m[1], state: /disabled/.test(m[2]) ? 'disabled' : /idle/.test(m[2]) ? 'idle' : 'busy' }));
  }

  async printTest() {
    if (!this._printerName)
      throw new PrinterOfflineError('No printer configured.');
    await this._execCupsPrint(TSPLBuilder.buildLotLabel({ mo: 'TEST PRINT', lot: 'TEST/LOT000' }));
    return { method: 'cups-tspl' };
  }

  async printLot(data) {
    if (!this._printerName)
      throw new PrinterOfflineError('No printer configured. Set PRINTER_NAME to CUPS queue name.');

    const tspl = TSPLBuilder.buildLotLabel({
      mo: String(data.mo || '').trim(),
      lot: String(data.lot_identity || data.lot || '').trim()
    });

    await this._execCupsPrint(tspl);
    return { method: 'cups-tspl' };
  }

  async _execCupsPrint(tspl) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'lp',
        ['-d', this._printerName, '-o', 'raw'],
        { timeout: this._timeout, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            if (err.killed || err.signal === 'SIGTERM')
              return reject(new PrinterTimeoutError('Print timeout after ' + this._timeout + 'ms'));
            return reject(new PrinterOfflineError('CUPS print failed: ' + (stderr || err.message).trim()));
          }
          resolve(stdout.trim());
        }
      );

      child.stdin.on('error', err => {
        reject(new PrinterOfflineError('CUPS print failed: ' + err.message));
      });
      child.stdin.end(tspl);
    });
  }
}

module.exports = PrinterService;
module.exports.PrinterNotFoundError = PrinterNotFoundError;
module.exports.PrinterOfflineError  = PrinterOfflineError;
module.exports.PrinterTimeoutError  = PrinterTimeoutError;
