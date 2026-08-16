import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// ---------- Estado -> color/label ----------
const ESTADO_MAP: Record<string, { color: string; label: string }> = {
  PENDIENTE: { color: 'yellow', label: 'Pendiente' },
  EN_REVISION: { color: 'blue', label: 'En revisión' },
  OBSERVADA: { color: 'orange', label: 'Observada' },
  AUTORIZADA: { color: 'green', label: 'Autorizada' },
  RECHAZADA: { color: 'red', label: 'Rechazada' },
  VENCIDA: { color: 'red', label: 'Vencida' },
  REVOCADA: { color: 'slate', label: 'Revocada' },
  REEMPLAZADA: { color: 'slate', label: 'Reemplazada' },
  // vigencia
  AUTORIZADO: { color: 'green', label: 'Autorizado' },
  NO_AUTORIZADO: { color: 'red', label: 'No autorizado' },
  VENCIDO: { color: 'red', label: 'Vencido' },
  REVOCADO: { color: 'slate', label: 'Revocado' },
  // vigencia documento
  VIGENTE: { color: 'green', label: 'Vigente' },
  POR_VENCER: { color: 'yellow', label: 'Por vencer' },
  SIN_FECHA: { color: 'slate', label: 'Sin fecha' },
  ACTIVO: { color: 'green', label: 'Activo' },
  INACTIVO: { color: 'slate', label: 'Inactivo' },
  // email
  RECEIVED: { color: 'blue', label: 'Recibido' },
  PROCESSING: { color: 'yellow', label: 'Procesando' },
  PROCESSED: { color: 'green', label: 'Procesado' },
  NEEDS_REVIEW: { color: 'orange', label: 'Local sin asignar' },
  ERROR: { color: 'red', label: 'Error' },
  COMPLETO: { color: 'green', label: 'Completo' },
  INCOMPLETO: { color: 'red', label: 'Incompleto' },
};

export function Badge({ estado }: { estado: string }) {
  const m = ESTADO_MAP[estado] ?? { color: 'slate', label: estado };
  return (
    <span className={`badge ${m.color}`}>
      <span className="dot" style={{ background: 'currentColor' }} />
      {m.label}
    </span>
  );
}

export function Spinner() {
  return <div className="spinner" />;
}

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={wide ? { maxWidth: 980 } : undefined}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
interface Toast { id: number; msg: string; type: 'info' | 'success' | 'error'; }
const ToastCtx = createContext<{ notify: (msg: string, type?: Toast['type']) => void }>({ notify: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((msg: string, type: Toast['type'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ notify }}>
      {children}
      <div className="toast">
        {toasts.map((t) => (
          <div key={t.id} className={`item ${t.type}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
