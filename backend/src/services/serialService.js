const { SerialPort } = require('serialport');
const config = require('../config/config');

class SerialService {
  constructor(io, scale = 'default', serialConfig = null) {
    this.io = io;
    this.scale = scale;
    this.serialConfig = serialConfig;
    this.port = null;
    this.connected = false;
    this._lineBuffer = '';
    this._manualClose = false;
    this._retryTimer = null;
    this.lastError = null;

    // Weight data
    this.latestWeight = null;
    this.weightHistory = [];
    this.dataHistory = [];
    this.maxHistorySize = 100;
    this.maxWeightHistory = 100;

    // Callbacks
    this.onWeightDataCallback = null;
    this.onConfirmCallback = null;
  }

  /**
   * Open the configured port. Resolves after the first open attempt.
   * Empty port = scale disabled (no error, no retry).
   * On failure/close, retries every SerialService.RETRY_MS until disconnect().
   */
  connect() {
    const sourceConfig = this.serialConfig || config.serial || {};
    const portPath = sourceConfig.port;
    const baudRate = sourceConfig.baudRate;

    this._manualClose = false;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;

    if (!portPath) {
      console.log(`⚪ [${this.scale}] No port configured — scale disabled`);
      return Promise.resolve();
    }
    if (this.port && (this.port.isOpen || this.port.opening)) return Promise.resolve();
    if (this.port) this.port.removeAllListeners();

    console.log(`🔌 [${this.scale}] Opening serial port: ${portPath} @ ${baudRate} bps`);

    let done;
    const opened = new Promise((resolve) => { done = resolve; });

    try {
      this.port = new SerialPort({ path: portPath, baudRate: baudRate, autoOpen: false });

      this.port.open((err) => {
        if (err) {
          // Log only when the error changes — retry every 5 s must not flood the log
          if (err.message !== this.lastError) {
            console.error(`❌ [${this.scale}] Failed to open serial port: ${err.message}`);
          }
          this.connected = false;
          this.lastError = err.message;
          if (this.io) {
            const statusPayload = { scale: this.scale, connected: false, error: err.message };
            this.io.emit('serial-status', statusPayload);
            this.io.emit(`serial-status:${this.scale}`, statusPayload);
          }
          this._scheduleReconnect();
          done();
          return;
        }

        console.log(`✅ [${this.scale}] Serial port opened: ${portPath}`);
        this.connected = true;
        this.lastError = null;
        done();
        if (this.io) {
          const statusPayload = { scale: this.scale, connected: true };
          this.io.emit('serial-status', statusPayload);
          this.io.emit(`serial-status:${this.scale}`, statusPayload);
        }
      });

      // Manual line buffer — splits on \r\n or \n
      this.port.on('data', (chunk) => {
        // Debug: raw bytes as the scale sent them (JSON.stringify shows \r \n). Set SERIAL_DEBUG=true.
        if (process.env.SERIAL_DEBUG === 'true') {
          console.log(`📥 [${this.scale}] RAW ${JSON.stringify(chunk.toString())}`);
        }
        this._lineBuffer += chunk.toString();
        const lines = this._lineBuffer.split(/\r\n|\n/);
        this._lineBuffer = lines.pop(); // simpan sisa yang belum lengkap
        lines.forEach((line) => {
          const trimmed = line.trim();
          if (trimmed) this._handleLine(trimmed);
        });
      });

      this.port.on('error', (err) => {
        console.error(`❌ [${this.scale}] Serial port error: ${err.message}`);
        this.connected = false;
        this.lastError = err.message;
        if (this.io) {
          const statusPayload = { scale: this.scale, connected: false, error: err.message };
          this.io.emit('serial-status', statusPayload);
          this.io.emit(`serial-status:${this.scale}`, statusPayload);
        }
        this._scheduleReconnect();
      });

      this.port.on('close', () => {
        console.log(`⚠️ [${this.scale}] Serial port closed`);
        this.connected = false;
        if (this.io) {
          const statusPayload = { scale: this.scale, connected: false };
          this.io.emit('serial-status', statusPayload);
          this.io.emit(`serial-status:${this.scale}`, statusPayload);
        }
        this._scheduleReconnect();
      });

    } catch (err) {
      console.error(`❌ SerialPort init error: ${err.message}`);
      this.lastError = err.message;
      this._scheduleReconnect();
      done();
    }
    return opened;
  }

  /** One pending retry at most; no-op after manual disconnect or when disabled. */
  _scheduleReconnect() {
    if (this._manualClose || this._retryTimer) return;
    const sourceConfig = this.serialConfig || config.serial || {};
    if (!sourceConfig.port) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect();
    }, SerialService.RETRY_MS);
  }

  /** Apply changed serialConfig (mutated in place by settings) and reconnect. */
  async reconfigure() {
    await this.disconnect();
    this.lastError = null;
    return this.connect();
  }

  getStatus() {
    const sourceConfig = this.serialConfig || config.serial || {};
    return {
      connected: this.connected,
      port:      sourceConfig.port || '',
      baudRate:  sourceConfig.baudRate,
      error:     this.lastError
    };
  }

  // Parse satu baris dari timbangan
  // Format: ST,GS,+   17.6   g  atau  US,GS,+    0.0   kg
  _handleLine(line) {
    // Regex: (ST|US) , <mode> , <sign> <spasi> <nilai> <spasi> <unit>
    const match = line.match(/^(ST|US),\w+,([+-])\s*([\d.]+)\s*(\w+)/);
    if (!match) {
      if (process.env.SERIAL_DEBUG === 'true') {
        console.log(`⚠️ [${this.scale}] baris tidak cocok format: ${JSON.stringify(line)}`);
      }
      return; // bukan baris data timbangan
    }

    const status   = match[1];              // 'ST' atau 'US'
    const sign     = match[2];              // '+' atau '-'
    const rawValue = parseFloat(match[3]);  // nilai angka
    const unit     = match[4].toLowerCase(); // 'g' atau 'kg'

    // Normalisasi ke kg
    let weightKg = (unit === 'g') ? rawValue / 1000 : rawValue;
    if (sign === '-') weightKg = -weightKg;

    const stable    = (status === 'ST');
    const timestamp = new Date().toISOString();

    console.log

    const payload = {
      scale:     this.scale,
      weight:    parseFloat(weightKg.toFixed(4)),
      stable:    stable,
      status:    status,
      unit:      unit,
      raw:       line,
      timestamp: timestamp
    };

    // Update latest & history
    this.latestWeight = payload;

    this.weightHistory.push(payload);
    if (this.weightHistory.length > this.maxWeightHistory) this.weightHistory.shift();

    const histData = { weight: payload.weight, timestamp };
    this.dataHistory.push(histData);
    if (this.dataHistory.length > this.maxHistorySize) this.dataHistory.shift();

    if (stable) {
      console.log(`🔒 [${this.scale}] STABLE: ${payload.weight} kg  (${rawValue} ${unit} raw)`);
    }

    // Kirim ke semua client via Socket.IO
    if (this.io) {
      this.io.emit('weightData', payload);
      this.io.emit(`weightData:${this.scale}`, payload);
      this.io.emit('telemetry-data', histData);
    }

    // Callback
    if (this.onWeightDataCallback) {
      this.onWeightDataCallback(payload);
    }
  }

  sendLEDCommand(command) {
    console.log(`💡 LED command: ${command}`);
    return false;
  }

  getLatestWeight() {
    return this.latestWeight;
  }

  getWeightHistory(limit = 50) {
    const count = Math.min(limit, this.weightHistory.length);
    return this.weightHistory.slice(-count);
  }

  getStatistics() {
    if (this.weightHistory.length === 0) return null;
    const weights = this.weightHistory.map(item => item.weight);
    const sum     = weights.reduce((acc, val) => acc + val, 0);
    const average = sum / weights.length;
    const min     = Math.min(...weights);
    const max     = Math.max(...weights);
    const latest  = this.latestWeight;
    return {
      count:   weights.length,
      average: parseFloat(average.toFixed(4)),
      min:     parseFloat(min.toFixed(4)),
      max:     parseFloat(max.toFixed(4)),
      latest:  latest ? latest.weight : null,
      stable:  latest ? latest.stable : false
    };
  }

  onWeightData(callback) {
    this.onWeightDataCallback = callback;
  }

  onConfirm(callback) {
    this.onConfirmCallback = callback;
  }

  setSocketIO(io) {
    this.io = io;
  }

  // Backward compat
  getHistory() {
    return this.dataHistory;
  }

  isConnected() {
    return this.connected;
  }

  /** Manual close: cancels retry. Resolves once the port is closed. */
  disconnect() {
    this._manualClose = true;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    const p = this.port;
    if (!p || !p.isOpen) return Promise.resolve();
    return new Promise((resolve) => p.close(() => resolve()));
  }
}

SerialService.RETRY_MS = 5000;

module.exports = SerialService;
