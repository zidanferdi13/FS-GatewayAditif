import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings, Loader2, Lock, RefreshCw, Printer, Save } from 'lucide-react';
import {
  settingsApi,
  type SettingsData, type SerialPortInfo, type PrinterQueue, type ScaleStatus,
} from '@/services/api';
import { useUIStore } from '@/store/uiStore';
import { cn } from '@/utils/cn';

const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
type ScaleKey = 'small' | 'large';

const inputCls =
  'h-9 w-full px-3 rounded-lg bg-bg-elevated border border-b-card text-t-primary text-sm ' +
  'outline-none focus:border-c-blue transition-colors disabled:opacity-50';
const btnCls =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill border border-b-card bg-bg-elevated text-xs font-bold ' +
  'text-t-secondary hover:border-c-blue hover:text-c-blue transition-all disabled:opacity-50 disabled:pointer-events-none';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-b-card bg-bg-surface p-5 space-y-4">
      <h2 className="text-xs font-bold text-t-primary uppercase tracking-wider">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-t-secondary">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-t-muted">{hint}</span>}
    </label>
  );
}

/** Port value stored in settings: prefer the stable by-id symlink. */
const portValue = (p: SerialPortInfo) => p.byId ?? p.path;

function errorHint(msg: string | null): string | null {
  if (!msg) return null;
  if (/permission denied|EACCES/i.test(msg))
    return 'Izin ditolak: user server belum di grup dialout. Jalankan: sudo usermod -aG dialout <user>, lalu restart service PM2.';
  if (/no such file|ENOENT|not found/i.test(msg))
    return 'Port tidak ditemukan. Cek kabel USB atau pilih port lain.';
  return msg;
}

export function SettingsPage() {
  const nav       = useNavigate();
  const showToast = useUIStore((s) => s.showToast);

  const [pinInput, setPinInput] = useState('');
  const [pin, setPin]           = useState<string | null>(null); // memory only, never persisted
  const [pinError, setPinError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const [form, setForm]       = useState<Omit<SettingsData, 'status'> | null>(null);
  const [status, setStatus]   = useState<Record<ScaleKey, ScaleStatus> | null>(null);
  const [ports, setPorts]     = useState<SerialPortInfo[]>([]);
  const [queues, setQueues]   = useState<PrinterQueue[]>([]);
  const [queueErr, setQueueErr] = useState<string | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  const toast = useCallback(
    (type: 'success' | 'error', title: string, message?: string) =>
      showToast({ type, title, message, duration: type === 'error' ? 6000 : 3000 }),
    [showToast],
  );

  const loadLists = useCallback(async (p: string) => {
    settingsApi.ports(p).then(setPorts).catch(() => setPorts([]));
    settingsApi.printers(p)
      .then((q) => { setQueues(q); setQueueErr(null); })
      .catch((e: Error) => { setQueues([]); setQueueErr(e.message); });
  }, []);

  // ── PIN gate ───────────────────────────────────────────────────────────────
  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setPinError(null);
    try {
      const { status: st, ...rest } = await settingsApi.get(pinInput);
      setForm(rest);
      setStatus(st);
      setPin(pinInput);
      loadLists(pinInput);
    } catch (err) {
      setPinError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  // ── Live connection status (poll; does not touch edited form) ──────────────
  useEffect(() => {
    if (!pin) return;
    const t = setInterval(() => {
      settingsApi.get(pin).then((d) => setStatus(d.status)).catch(() => { /* keep last */ });
    }, 3000);
    return () => clearInterval(t);
  }, [pin]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (err) { toast('error', 'Gagal', (err as Error).message); }
    finally { setBusy(null); }
  };

  const save = () => run('save', async () => {
    if (!pin || !form) return;
    const { status: st, ...rest } = await settingsApi.save(pin, form);
    setForm(rest);
    setStatus(st);
    toast('success', 'Tersimpan', 'Pengaturan diterapkan. Ambang berlaku setelah halaman dashboard dimuat ulang.');
  });

  const reconnect = (s: ScaleKey) => run(`rc-${s}`, async () => {
    if (!pin) return;
    const st = await settingsApi.reconnect(pin, s);
    setStatus((cur) => (cur ? { ...cur, [s]: st } : cur));
  });

  const testPrint = () => run('print', async () => {
    if (!pin) return;
    await settingsApi.testPrint(pin);
    toast('success', 'Tes cetak', 'Label tes dikirim ke printer');
  });

  const setScale = (s: ScaleKey, patch: Partial<{ port: string; baudRate: number }>) =>
    setForm((f) => f && { ...f, scales: { ...f.scales, [s]: { ...f.scales[s], ...patch } } });
  const setThreshold = (k: keyof SettingsData['thresholds'], v: string) =>
    setForm((f) => f && { ...f, thresholds: { ...f.thresholds, [k]: v === '' ? NaN : Number(v) } });

  // ── Render ─────────────────────────────────────────────────────────────────
  const header = (
    <div className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-b-card bg-bg-surface">
      <button onClick={() => nav('/')} className="flex items-center gap-1.5 text-t-secondary hover:text-t-primary transition-colors">
        <ArrowLeft size={18} />
        <span className="text-sm font-medium">Dashboard</span>
      </button>
      <div className="h-4 w-px bg-b-card" />
      <Settings size={18} className="text-c-blue" />
      <h1 className="text-base font-bold text-t-primary">Pengaturan</h1>
    </div>
  );

  if (!pin || !form || !status) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-bg-base">
        {header}
        <form onSubmit={unlock} className="m-auto w-80 space-y-3 rounded-xl border border-b-card bg-bg-surface p-6">
          <div className="flex items-center gap-2 text-t-primary">
            <Lock size={16} className="text-c-blue" />
            <span className="text-sm font-bold">Masukkan PIN</span>
          </div>
          <input
            type="password"
            autoFocus
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            aria-label="PIN pengaturan"
            className={inputCls}
          />
          {pinError && <p role="alert" className="text-xs text-c-red">{pinError}</p>}
          <button type="submit" disabled={!pinInput || checking} className={cn(btnCls, 'w-full justify-center')}>
            {checking && <Loader2 size={14} className="animate-spin" />}
            Buka
          </button>
        </form>
      </div>
    );
  }

  const invalid = Object.values(form.thresholds).some((v) => !Number.isFinite(v)) ||
                  !Number.isFinite(form.printer.timeout);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg-base">
      {header}
      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-3xl space-y-5">

          {/* ── Timbangan ─────────────────────────────────────────────────── */}
          {(['small', 'large'] as ScaleKey[]).map((s) => {
            const cfg = form.scales[s];
            const st  = status[s];
            const known = ports.some((p) => portValue(p) === cfg.port || p.path === cfg.port);
            const hint = errorHint(st.error);
            return (
              <Section key={s} title={`Timbangan ${s === 'small' ? 'Kecil (S1)' : 'Besar (S2)'}`}>
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('h-2.5 w-2.5 rounded-full', st.connected ? 'bg-c-green' : 'bg-c-red')} />
                  <span className="text-t-secondary">
                    {!st.port ? 'Nonaktif' : st.connected ? 'Terhubung' : 'Tidak terhubung (mencoba ulang tiap 5 detik)'}
                  </span>
                </div>
                {hint && !st.connected && <p role="alert" className="text-xs text-c-red">{hint}</p>}

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <Field label="Port" hint="Pilih by-id agar tetap sama setelah reboot / cabut-colok">
                      <select className={inputCls} value={cfg.port} onChange={(e) => setScale(s, { port: e.target.value })}>
                        <option value="">(nonaktif)</option>
                        {cfg.port && !known && <option value={cfg.port}>{cfg.port} (tidak terdeteksi)</option>}
                        {ports.map((p) => (
                          <option key={p.path} value={portValue(p)}>
                            {p.path}{p.manufacturer ? ` — ${p.manufacturer}` : ''}{p.byId ? ' [by-id]' : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label="Baud rate">
                    <select className={inputCls} value={cfg.baudRate} onChange={(e) => setScale(s, { baudRate: Number(e.target.value) })}>
                      {BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </Field>
                </div>

                <button type="button" className={btnCls} disabled={busy === `rc-${s}` || !st.port} onClick={() => reconnect(s)}>
                  {busy === `rc-${s}` ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  Sambung ulang
                </button>
              </Section>
            );
          })}

          {/* ── Printer ───────────────────────────────────────────────────── */}
          <Section title="Printer">
            {queueErr && <p role="alert" className="text-xs text-c-red">CUPS tidak tersedia: {queueErr}</p>}
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <Field label="Antrian CUPS">
                  <select className={inputCls} value={form.printer.name}
                          onChange={(e) => setForm({ ...form, printer: { ...form.printer, name: e.target.value } })}>
                    {form.printer.name && !queues.some((q) => q.name === form.printer.name) &&
                      <option value={form.printer.name}>{form.printer.name} (tidak terdeteksi)</option>}
                    {queues.map((q) => <option key={q.name} value={q.name}>{q.name} — {q.state}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Timeout (ms)">
                <input type="number" className={inputCls} min={1000} max={120000} step={1000}
                       value={Number.isFinite(form.printer.timeout) ? form.printer.timeout : ''}
                       onChange={(e) => setForm({ ...form, printer: { ...form.printer, timeout: e.target.value === '' ? NaN : Number(e.target.value) } })} />
              </Field>
            </div>
            <p className="text-[11px] text-t-muted">Simpan dulu bila mengganti antrian, baru tes cetak.</p>
            <button type="button" className={btnCls} disabled={busy === 'print' || !form.printer.name} onClick={testPrint}>
              {busy === 'print' ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
              Tes cetak
            </button>
          </Section>

          {/* ── Ambang ────────────────────────────────────────────────────── */}
          <Section title="Ambang Penimbangan">
            <p className="text-[11px] text-t-muted">Berlaku di dashboard setelah halaman dimuat ulang. Hindari mengubah saat MO sedang berjalan.</p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Batas timbangan kecil (kg)" hint="Target ≤ nilai ini memakai S1, selebihnya S2">
                <input type="number" className={inputCls} min={0.1} max={1000} step="any" value={Number.isFinite(form.thresholds.smallScaleMaxKg) ? form.thresholds.smallScaleMaxKg : ''}
                       onChange={(e) => setThreshold('smallScaleMaxKg', e.target.value)} />
              </Field>
              <Field label="Toleransi (pecahan)" hint="0.02 = ±2% dari target">
                <input type="number" className={inputCls} min={0.001} max={0.1} step="any" value={Number.isFinite(form.thresholds.weightTolerance) ? form.thresholds.weightTolerance : ''}
                       onChange={(e) => setThreshold('weightTolerance', e.target.value)} />
              </Field>
              <Field label="Jeda setelah konfirmasi (ms)">
                <input type="number" className={inputCls} min={0} max={10000} step={100} value={Number.isFinite(form.thresholds.autoConfirmDelayMs) ? form.thresholds.autoConfirmDelayMs : ''}
                       onChange={(e) => setThreshold('autoConfirmDelayMs', e.target.value)} />
              </Field>
              <Field label="Jeda lewati Kemasan (ms)">
                <input type="number" className={inputCls} min={0} max={10000} step={100} value={Number.isFinite(form.thresholds.skipKemasanDelayMs) ? form.thresholds.skipKemasanDelayMs : ''}
                       onChange={(e) => setThreshold('skipKemasanDelayMs', e.target.value)} />
              </Field>
            </div>
          </Section>

          <div className="flex justify-end pb-2">
            <button type="button" onClick={save} disabled={busy === 'save' || invalid}
                    className={cn(btnCls, 'border-c-blue text-c-blue bg-c-blue-dim px-5 py-2 text-sm')}>
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Simpan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
