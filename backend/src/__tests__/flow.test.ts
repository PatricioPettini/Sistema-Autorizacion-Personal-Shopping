import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { db, schema } from '../db/client.js';
import { findOrCreatePersona } from '../modules/personas/service.js';
import { saveDocumentVersion } from '../modules/storage/service.js';
import { getPersonaDocStatus } from '../modules/documentos/service.js';
import { getVigencia, recomputeAutorizacionPersona } from '../modules/autorizaciones/service.js';
import { todayLocal } from '../lib/datetime.js';

function tipoId(codigo: string): number {
  return db.select().from(schema.documentTypes).where(eq(schema.documentTypes.codigo, codigo)).get()!.id;
}

function verificar(personaId: number, codigo: string, fechaVencimiento?: string) {
  // saveDocumentVersion crea el documento; si no existe (aún no se cargó archivo), lo creamos.
  const existing = db.select().from(schema.documentos).where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipoId(codigo)))).get();
  if (!existing) db.insert(schema.documentos).values({ personaId, tipoDocumentoId: tipoId(codigo) }).run();
  db.update(schema.documentos)
    .set({ verificacion: 'VERIFICADO', fechaVencimiento: fechaVencimiento ?? null })
    .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipoId(codigo))))
    .run();
}

function setCategoria(personaId: number, categoria: string) {
  db.update(schema.personas).set({ categoria }).where(eq(schema.personas.id, personaId)).run();
}

const DOCS_EMPRESA = ['FORM_931', 'PAGO_ARCA', 'NOMINA_ART', 'CLAUSULA_NO_REPETICION'];

beforeAll(() => {
  migrate();
});

describe('personas', () => {
  it('no duplica por CUIL', () => {
    const a = findOrCreatePersona({ cuil: '20-32456789-3', nombre: 'Juan', apellido: 'Perez' });
    const b = findOrCreatePersona({ cuil: '20324567893', nombre: 'Juan', apellido: 'Perez' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.persona.id).toBe(b.persona.id);
  });
});

describe('documentos y verificación manual', () => {
  it('crea versiones y deduplica archivos idénticos', () => {
    const { persona } = findOrCreatePersona({ cuil: '20111222333', nombre: 'Ana', apellido: 'Lopez' });
    const t = tipoId('FORM_931');
    const r1 = saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: t, buffer: Buffer.from('AAA'), originalFilename: 'f931.pdf' });
    expect(r1.version).toBe(1);
    const r2 = saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: t, buffer: Buffer.from('AAA'), originalFilename: 'f931.pdf' });
    expect(r2.duplicate).toBe(true);
    const r3 = saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: t, buffer: Buffer.from('BBB'), originalFilename: 'f931_nuevo.pdf' });
    expect(r3.version).toBe(2);
  });

  it('exige los documentos obligatorios de la categoría (Empresa = 4)', () => {
    const { persona } = findOrCreatePersona({ cuil: '20999888777', nombre: 'Luis', apellido: 'Diaz' });
    // Sin categoría: solo aplica Cláusula (AMBOS) y pide definir el tipo.
    expect(getPersonaDocStatus(persona.id).requiereCategoria).toBe(true);
    setCategoria(persona.id, 'EMPRESA');
    const status = getPersonaDocStatus(persona.id);
    expect(status.totalObligatorios).toBe(4);
    expect(status.estadoDocumental).toBe('INCOMPLETO');
    expect(status.faltantes).toEqual(expect.arrayContaining(['Formulario 931', 'Pago de ARCA', 'Nómina ART']));
  });

  it('un documento cuenta como presente SOLO cuando se aprueba manualmente', () => {
    const { persona } = findOrCreatePersona({ cuil: '20444555666', nombre: 'Rosa', apellido: 'Mota' });
    setCategoria(persona.id, 'EMPRESA');
    saveDocumentVersion({ personaId: persona.id, tipoDocumentoId: tipoId('FORM_931'), buffer: Buffer.from('x'), originalFilename: 'f931.pdf' });
    let doc = getPersonaDocStatus(persona.id).items.find((i) => i.codigo === 'FORM_931')!;
    expect(doc.presente).toBe(false);
    verificar(persona.id, 'FORM_931');
    doc = getPersonaDocStatus(persona.id).items.find((i) => i.codigo === 'FORM_931')!;
    expect(doc.presente).toBe(true);
  });

  it('un documento aprobado cuenta como presente (el vencimiento ya no es por documento)', () => {
    const { persona } = findOrCreatePersona({ cuil: '20666777888', nombre: 'Elsa', apellido: 'Ríos' });
    setCategoria(persona.id, 'EMPRESA');
    verificar(persona.id, 'FORM_931');
    const doc = getPersonaDocStatus(persona.id).items.find((i) => i.codigo === 'FORM_931')!;
    expect(doc.presente).toBe(true);
    expect(doc.vigencia).toBe('VIGENTE');
  });

  it('todosVerificados solo cuando TODOS los obligatorios están aprobados y vigentes', () => {
    const { persona } = findOrCreatePersona({ cuil: '20777888999', nombre: 'Nora', apellido: 'Fuentes' });
    setCategoria(persona.id, 'EMPRESA');
    expect(getPersonaDocStatus(persona.id).todosVerificados).toBe(false);
    verificar(persona.id, 'FORM_931');
    verificar(persona.id, 'PAGO_ARCA');
    verificar(persona.id, 'NOMINA_ART');
    expect(getPersonaDocStatus(persona.id).todosVerificados).toBe(false); // falta 1 (Cláusula)
    verificar(persona.id, 'CLAUSULA_NO_REPETICION');
    expect(getPersonaDocStatus(persona.id).todosVerificados).toBe(true);
  });

  it('auto-autoriza solo con documentación completa Y fecha de vencimiento cargada', () => {
    const user = db.insert(schema.users).values({ nombre: 'Rev', email: `rev${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const { persona } = findOrCreatePersona({ cuil: '20555444333', nombre: 'Sara', apellido: 'Vega' });
    setCategoria(persona.id, 'EMPRESA');
    const local = db.insert(schema.locales).values({ nombre: `Local Auto ${Date.now()}`, estado: 'ACTIVO' }).returning().get();
    const sol = db.insert(schema.solicitudes).values({ localId: local.id, personaId: persona.id, estado: 'PENDIENTE' }).returning().get();
    db.insert(schema.solicitudPersonas).values({ solicitudId: sol.id, personaId: persona.id }).run();
    const spEstado = () => db.select().from(schema.solicitudPersonas).where(and(eq(schema.solicitudPersonas.solicitudId, sol.id), eq(schema.solicitudPersonas.personaId, persona.id))).get()!.estado;

    // 4/4 aprobados pero SIN fecha -> todavía NO autorizada.
    for (const c of DOCS_EMPRESA) verificar(persona.id, c);
    recomputeAutorizacionPersona(sol.id, persona.id, user.id);
    expect(getPersonaDocStatus(persona.id).todosVerificados).toBe(true);
    expect(spEstado()).not.toBe('AUTORIZADA');

    // Cargar fecha de vencimiento -> se auto-autoriza hasta esa fecha.
    const futuro = new Date(new Date(`${todayLocal()}T12:00:00Z`).getTime() + 5 * 86400000).toISOString().slice(0, 10);
    db.update(schema.solicitudes).set({ fechaVencimiento: futuro }).where(eq(schema.solicitudes.id, sol.id)).run();
    recomputeAutorizacionPersona(sol.id, persona.id, user.id);
    expect(spEstado()).toBe('AUTORIZADA');
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
    const aut = db.select().from(schema.autorizaciones).where(and(eq(schema.autorizaciones.personaId, persona.id), eq(schema.autorizaciones.estado, 'AUTORIZADA'))).get()!;
    expect(aut.fechaHasta).toBe(futuro);
  });
});

describe('autorización y vigencia', () => {
  it('marca AUTORIZADO cuando hay autorización vigente hoy', () => {
    const { persona } = findOrCreatePersona({ cuil: '20187776665', nombre: 'Sofia', apellido: 'Ruiz' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Test ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `t${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    expect(getVigencia(persona.id, local.id).estado).toBe('NO_AUTORIZADO');
    db.insert(schema.autorizaciones).values({ personaId: persona.id, localId: local.id, fecha: todayLocal(), horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
  });

  it('respeta el rango de fechas: vigente si hoy cae dentro de [fecha, fechaHasta]', () => {
    const { persona } = findOrCreatePersona({ cuil: '20185554443', nombre: 'Nadia', apellido: 'Vera' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Rango ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `r${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    db.insert(schema.autorizaciones).values({ personaId: persona.id, localId: local.id, fecha: ayer, fechaHasta: manana, horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('AUTORIZADO');
  });

  it('marca VENCIDO cuando el rango completo ya pasó', () => {
    const { persona } = findOrCreatePersona({ cuil: '20185553332', nombre: 'Omar', apellido: 'Paz' });
    const local = db.insert(schema.locales).values({ nombre: 'Local Pasado ' + Date.now(), estado: 'ACTIVO' }).returning().get();
    const user = db.insert(schema.users).values({ nombre: 'T', email: `p${Date.now()}@x.com`, passwordHash: 'x', rol: 'ADMIN' }).returning().get();
    const hace10 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const hace5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    db.insert(schema.autorizaciones).values({ personaId: persona.id, localId: local.id, fecha: hace10, fechaHasta: hace5, horaDesde: '08:00', horaHasta: '18:00', estado: 'AUTORIZADA', autorizadaPorUserId: user.id }).run();
    expect(getVigencia(persona.id, local.id).estado).toBe('VENCIDO');
  });
});
