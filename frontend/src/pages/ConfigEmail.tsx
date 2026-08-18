import { useState, useEffect } from 'react';
import { api, fmtFecha } from '../api';
import { Spinner, useToast } from '../ui';

export default function ConfigEmail() {
  const { notify } = useToast();
  const [cfg, setCfg] = useState<any>(null);
  const [sched, setSched] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => setCfg(await api.get('/config/email'));
  const loadSched = async () => { try { setSched((await api.get<any>('/config/monitor')).scheduler); } catch { /* no admin / sin datos */ } };
  useEffect(() => { load(); loadSched(); }, []);
  if (!cfg) return <Spinner />;

  const set = (k: string, v: any) => setCfg({ ...cfg, [k]: v });
  const guardar = async () => {
    setBusy(true);
    try {
      const body = { ...cfg }; if (!body.imapPassword) delete body.imapPassword; if (!body.smtpPassword) delete body.smtpPassword;
      const r = await api.put<any>('/config/email', body);
      setSched(r.scheduler ?? null);
      notify(r.scheduler?.activo ? `Configuración guardada. Revisión automática cada ${r.scheduler.pollMinutes} min.` : 'Configuración guardada. Revisión automática desactivada.', 'success');
      load();
    }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };
  const test = async (tipo: 'imap' | 'smtp') => {
    setBusy(true);
    try {
      // Probamos con los datos que están en pantalla (sin necesidad de guardar antes).
      const body = { ...cfg };
      if (!body.imapPassword) delete body.imapPassword;
      if (!body.smtpPassword) delete body.smtpPassword;
      const r = await api.post<{ ok: boolean; error?: string }>(`/config/email/test-${tipo}`, body);
      notify(r.ok ? `Conexión ${tipo.toUpperCase()} correcta.` : `Error ${tipo.toUpperCase()}: ${r.error}`, r.ok ? 'success' : 'error');
    }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };
  const revisarAhora = async () => {
    setBusy(true);
    try { const r = await api.post<any>('/config/email/revisar-ahora'); notify(r.ok ? `Revisión OK: ${r.nuevos} nuevos, ${r.procesados} procesados.` : `Error: ${r.error}`, r.ok ? 'success' : 'error'); loadSched(); }
    catch (e: any) { notify(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head"><div><h1>Configuración de email</h1><div className="subtitle">Lectura automática (IMAP) y envío de avisos (SMTP)</div></div></div>

      <div className="alert info">Las contraseñas se guardan cifradas y no se muestran. Dejalas en blanco para no modificarlas.</div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">📥 Recepción (IMAP)</div>
          <div className="card-body">
            <div className="form-row"><div className="field"><label>Servidor</label><input value={cfg.imapHost ?? ''} onChange={(e) => set('imapHost', e.target.value)} placeholder="imap.gmail.com" /></div><div className="field" style={{ maxWidth: 110 }}><label>Puerto</label><input type="number" value={cfg.imapPort ?? 993} onChange={(e) => set('imapPort', Number(e.target.value))} /></div></div>
            <div className="field"><label>Usuario</label><input value={cfg.imapUser ?? ''} onChange={(e) => set('imapUser', e.target.value)} /></div>
            <div className="field"><label>Contraseña {cfg.imapPasswordSet && <span className="chip">configurada</span>}</label><input type="password" value={cfg.imapPassword ?? ''} onChange={(e) => set('imapPassword', e.target.value)} placeholder="••••••" /></div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!cfg.imapSecure} onChange={(e) => set('imapSecure', e.target.checked)} /> Usar SSL/TLS</label>
            <button className="btn sm" style={{ marginTop: 12 }} onClick={() => test('imap')} disabled={busy}>Probar conexión IMAP</button>
          </div>
        </div>

        <div className="card">
          <div className="card-head">📤 Envío (SMTP)</div>
          <div className="card-body">
            <div className="form-row"><div className="field"><label>Servidor</label><input value={cfg.smtpHost ?? ''} onChange={(e) => set('smtpHost', e.target.value)} placeholder="smtp.gmail.com" /></div><div className="field" style={{ maxWidth: 110 }}><label>Puerto</label><input type="number" value={cfg.smtpPort ?? 587} onChange={(e) => set('smtpPort', Number(e.target.value))} /></div></div>
            <div className="field"><label>Usuario</label><input value={cfg.smtpUser ?? ''} onChange={(e) => set('smtpUser', e.target.value)} /></div>
            <div className="field"><label>Contraseña {cfg.smtpPasswordSet && <span className="chip">configurada</span>}</label><input type="password" value={cfg.smtpPassword ?? ''} onChange={(e) => set('smtpPassword', e.target.value)} placeholder="••••••" /></div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!cfg.smtpSecure} onChange={(e) => set('smtpSecure', e.target.checked)} /> Conexión segura (SSL)</label>
            <div className="form-row" style={{ marginTop: 12 }}>
              <div className="field"><label>Nombre remitente</label><input value={cfg.fromName ?? ''} onChange={(e) => set('fromName', e.target.value)} /><div className="hint">Nombre que ve quien recibe el aviso (ej. "Seguridad Shopping").</div></div>
              <div className="field"><label>Email remitente</label><input value={cfg.fromAddress ?? ''} onChange={(e) => set('fromAddress', e.target.value)} placeholder={cfg.smtpUser || 'usuario@dominio.com'} /><div className="hint">Dirección "De:" de los avisos. Dejalo vacío para usar el usuario SMTP ({cfg.smtpUser || 'el de arriba'}).</div></div>
            </div>
            <button className="btn sm" onClick={() => test('smtp')} disabled={busy}>Probar conexión SMTP</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-body form-row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ maxWidth: 220 }}><label>Frecuencia de revisión (minutos)</label><input type="number" value={cfg.pollMinutes ?? 5} onChange={(e) => set('pollMinutes', Number(e.target.value))} /><div className="hint">0 = desactivado. El cambio aplica apenas guardás (no hace falta reiniciar).</div></div>
          <div className="field" style={{ maxWidth: 220 }}><label>Carpeta "Procesados" (opcional)</label><input value={cfg.processedFolder ?? ''} onChange={(e) => set('processedFolder', e.target.value)} placeholder="Procesados" /></div>
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={guardar} disabled={busy}>Guardar configuración</button>
        <button className="btn" onClick={revisarAhora} disabled={busy}>Revisar buzón ahora</button>
      </div>

      {sched && (
        <div className={`alert ${sched.activo ? 'info' : 'warn'}`} style={{ marginTop: 16 }}>
          {sched.activo
            ? <>Revisión automática <strong>activa</strong> cada {sched.pollMinutes} min. Próxima: <strong>{fmtFecha(sched.nextRunAt)}</strong>. Última: {sched.lastSyncAt ? fmtFecha(sched.lastSyncAt) : 'todavía no corrió'}.</>
            : <>Revisión automática <strong>desactivada</strong> {sched.configurado ? '(frecuencia en 0)' : '(falta configurar el servidor IMAP)'}. Los emails solo entran con "Revisar buzón ahora".</>}
          {sched.lastResult && !sched.lastResult.ok && <div style={{ marginTop: 6 }}>Último error: {sched.lastResult.error}</div>}
        </div>
      )}
    </>
  );
}
