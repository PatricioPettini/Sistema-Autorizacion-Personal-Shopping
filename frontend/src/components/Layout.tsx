import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

function Item({ to, ico, label, pill }: { to: string; ico: string; label: string; pill?: number }) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <span className="ico">{ico}</span>
      <span>{label}</span>
      {pill ? <span className="pill">{pill}</span> : null}
    </NavLink>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const isAdmin = user?.rol === 'ADMIN';

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) nav(`/personas?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">🛡️</span>
          <span>Control de Ingresos</span>
        </div>
        <nav>
          <Item to="/" ico="▦" label="Panel" />
          <Item to="/solicitudes" ico="📄" label="Solicitudes" />
          <Item to="/personas" ico="👤" label="Personas" />
          <Item to="/dentro" ico="🟢" label="Dentro del shopping" />
          <Item to="/reportes" ico="📊" label="Reportes" />
          {isAdmin && (
            <>
              <div className="nav-group">Administración</div>
              <Item to="/locales" ico="🏬" label="Locales" />
              <Item to="/usuarios" ico="👥" label="Usuarios" />
              <Item to="/tipos-documento" ico="🗂️" label="Tipos de documento" />
              <Item to="/config/email" ico="✉️" label="Configuración de email" />
              <Item to="/monitor" ico="📡" label="Monitoreo" />
              <Item to="/auditoria" ico="📚" label="Auditoría" />
            </>
          )}
        </nav>
        <div className="userbox">
          <div className="name">{user?.nombre}</div>
          <div className="rol">{user?.rol === 'ADMIN' ? 'Administrador' : 'Seguridad'}</div>
          <button className="btn ghost sm" style={{ color: '#cbd5e1', marginTop: 8, paddingLeft: 0 }} onClick={() => logout()}>
            ↩ Cerrar sesión
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <form className="search" onSubmit={onSearch}>
            <span className="ico">🔎</span>
            <input placeholder="Buscar por CUIL o nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
