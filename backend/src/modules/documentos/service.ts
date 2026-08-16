import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { daysUntil } from '../../lib/datetime.js';
import { env } from '../../config/env.js';

export interface DocTypeStatus {
  tipoId: number;
  codigo: string;
  nombre: string;
  obligatorio: boolean;
  categoria: string;
  controlaEmision: boolean;
  presente: boolean;
  tieneArchivo: boolean;
  documentoId: number | null;
  versionId: number | null;
  version: number | null;
  fechaEmision: string | null;
  fechaVencimiento: string | null;
  diasParaVencer: number | null; // días hasta llegar al límite (30 días desde emisión)
  vigencia: 'VIGENTE' | 'POR_VENCER' | 'VENCIDO' | 'SIN_FECHA' | null;
  verificacion: 'PENDIENTE' | 'VERIFICADO' | 'RECHAZADO';
  notaVerificacion: string | null;
  clasificacionConfianza: number | null;
}

export interface PersonaDocStatus {
  categoria: string | null; // EMPRESA | MONOTRIBUTISTA | null
  requiereCategoria: boolean; // true si falta definir si es empresa o monotributista
  items: DocTypeStatus[];
  faltantes: string[];
  vencidos: string[]; // documentación con emisión > 30 días
  porVencer: string[];
  estadoDocumental: 'COMPLETO' | 'INCOMPLETO';
  completos: number;
  totalObligatorios: number;
  verificadosObligatorios: number; // obligatorios marcados VERIFICADO por Seguridad (y no vencidos)
  todosVerificados: boolean; // true si TODOS los obligatorios están verificados y vigentes
}

export function getPersonaDocStatus(personaId: number): PersonaDocStatus {
  const persona = db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get();
  const categoria = persona?.categoria ?? null;

  const todos = db
    .select()
    .from(schema.documentTypes)
    .where(eq(schema.documentTypes.activo, true))
    .orderBy(schema.documentTypes.orden)
    .all();

  // Solo aplican los tipos de la categoría de la persona (más los 'AMBOS').
  const tipos = todos.filter((t) => t.categoria === 'AMBOS' || t.categoria === categoria);

  const items: DocTypeStatus[] = [];
  const faltantes: string[] = [];
  const vencidos: string[] = [];
  const porVencer: string[] = [];

  for (const tipo of tipos) {
    const doc = db
      .select()
      .from(schema.documentos)
      .where(and(eq(schema.documentos.personaId, personaId), eq(schema.documentos.tipoDocumentoId, tipo.id)))
      .get();

    let version = null as (typeof schema.documentVersions.$inferSelect) | null;
    if (doc?.currentVersionId) {
      version = db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, doc.currentVersionId)).get() ?? null;
    }

    const tieneArchivo = !!version;
    const verificacion = (doc?.verificacion ?? 'PENDIENTE') as DocTypeStatus['verificacion'];
    const verificado = verificacion === 'VERIFICADO';

    // Vencimiento manual: Seguridad carga la fecha al aprobar. Al pasar, el documento vence.
    const fechaVencimiento = doc?.fechaVencimiento ?? null;
    let vigencia: DocTypeStatus['vigencia'] = null;
    let dias: number | null = null;
    if (verificado) {
      if (fechaVencimiento) {
        dias = daysUntil(fechaVencimiento);
        if (dias === null) vigencia = 'VIGENTE';
        else if (dias < 0) vigencia = 'VENCIDO';
        else if (dias <= env.rules.expiryAlertDays) vigencia = 'POR_VENCER';
        else vigencia = 'VIGENTE';
      } else {
        vigencia = 'VIGENTE'; // aprobado sin fecha de vencimiento => no vence
      }
    }

    // Un requisito cuenta como cumplido solo si está VERIFICADO y no está vencido.
    const presente = verificado && vigencia !== 'VENCIDO';

    if (vigencia === 'VENCIDO') vencidos.push(tipo.nombre);
    if (vigencia === 'POR_VENCER') porVencer.push(tipo.nombre);
    if (tipo.obligatorio && !presente) faltantes.push(tipo.nombre);

    items.push({
      tipoId: tipo.id,
      codigo: tipo.codigo,
      nombre: tipo.nombre,
      obligatorio: tipo.obligatorio,
      categoria: tipo.categoria,
      controlaEmision: tipo.controlaEmision,
      presente,
      tieneArchivo,
      documentoId: doc?.id ?? null,
      versionId: version?.id ?? null,
      version: version?.version ?? null,
      fechaEmision: version?.fechaEmision ?? null,
      fechaVencimiento,
      diasParaVencer: dias,
      vigencia,
      verificacion,
      notaVerificacion: doc?.notaVerificacion ?? null,
      clasificacionConfianza: version?.clasificacionConfianza ?? null,
    });
  }

  const obligatorios = tipos.filter((t) => t.obligatorio);
  const completos = items.filter((i) => i.obligatorio && i.presente && i.vigencia !== 'VENCIDO').length;
  // Verificados: obligatorios que Seguridad confirmó explícitamente (VERIFICADO) y siguen vigentes.
  const verificadosObligatorios = items.filter(
    (i) => i.obligatorio && i.verificacion === 'VERIFICADO' && i.vigencia !== 'VENCIDO',
  ).length;
  // Solo hace falta definir categoría si existen requisitos específicos por tipo de contratista.
  const hayCategoriaEspecifica = todos.some((t) => t.obligatorio && t.categoria !== 'AMBOS');
  const requiereCategoria = !categoria && hayCategoriaEspecifica;
  const todosVerificados = !requiereCategoria && obligatorios.length > 0 && verificadosObligatorios === obligatorios.length;

  return {
    categoria,
    requiereCategoria,
    items,
    faltantes,
    vencidos,
    porVencer,
    estadoDocumental: !requiereCategoria && faltantes.length === 0 ? 'COMPLETO' : 'INCOMPLETO',
    completos,
    totalObligatorios: obligatorios.length,
    verificadosObligatorios,
    todosVerificados,
  };
}
