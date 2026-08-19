import { eq, and } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export interface DocTypeStatus {
  tipoId: number;
  codigo: string;
  nombre: string;
  obligatorio: boolean;
  categoria: string;
  controlaEmision: boolean;
  esRequisitoExtra: boolean; // agregado a mano a esta persona (no viene de su categoría)
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

  // Requisitos EXTRA asignados a mano a esta persona (ej. trabajo en altura).
  const extraIds = new Set(
    db
      .select({ tipoId: schema.requisitosPersona.tipoDocumentoId })
      .from(schema.requisitosPersona)
      .where(eq(schema.requisitosPersona.personaId, personaId))
      .all()
      .map((r) => r.tipoId),
  );
  const aplicaPorCategoria = (t: (typeof todos)[number]) => t.categoria === 'AMBOS' || t.categoria === categoria;

  // Aplican: los de la categoría (más 'AMBOS') y los requisitos extra de esta persona.
  const tipos = todos.filter((t) => aplicaPorCategoria(t) || extraIds.has(t.id));
  // Un requisito extra puede referenciar un tipo desactivado o fuera de 'todos': lo traemos.
  for (const id of extraIds) {
    if (!tipos.some((t) => t.id === id)) {
      const t = db.select().from(schema.documentTypes).where(eq(schema.documentTypes.id, id)).get();
      if (t) tipos.push(t);
    }
  }

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

    // El vencimiento ya NO es por documento: es único a nivel solicitud. Un requisito cuenta
    // como cumplido si Seguridad lo aprobó (VERIFICADO).
    const fechaVencimiento = null;
    const dias: number | null = null;
    const vigencia: DocTypeStatus['vigencia'] = verificado ? 'VIGENTE' : null;
    const presente = verificado;

    // Un requisito extra es obligatorio para esta persona aunque el tipo no lo sea por defecto.
    const esRequisitoExtra = extraIds.has(tipo.id) && !aplicaPorCategoria(tipo);
    const obligatorio = tipo.obligatorio || esRequisitoExtra;

    if (obligatorio && !presente) faltantes.push(tipo.nombre);

    items.push({
      tipoId: tipo.id,
      codigo: tipo.codigo,
      nombre: tipo.nombre,
      obligatorio,
      categoria: tipo.categoria,
      controlaEmision: tipo.controlaEmision,
      esRequisitoExtra,
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

  // Se cuenta sobre los items (incluye los requisitos extra de esta persona).
  const totalObligatorios = items.filter((i) => i.obligatorio).length;
  const completos = items.filter((i) => i.obligatorio && i.presente && i.vigencia !== 'VENCIDO').length;
  // Verificados: obligatorios que Seguridad confirmó explícitamente (VERIFICADO) y siguen vigentes.
  const verificadosObligatorios = items.filter(
    (i) => i.obligatorio && i.verificacion === 'VERIFICADO' && i.vigencia !== 'VENCIDO',
  ).length;
  // Solo hace falta definir categoría si existen requisitos específicos por tipo de contratista.
  const hayCategoriaEspecifica = todos.some((t) => t.obligatorio && t.categoria !== 'AMBOS' && t.categoria !== 'EXTRA');
  const requiereCategoria = !categoria && hayCategoriaEspecifica;
  const todosVerificados = !requiereCategoria && totalObligatorios > 0 && verificadosObligatorios === totalObligatorios;

  return {
    categoria,
    requiereCategoria,
    items,
    faltantes,
    vencidos,
    porVencer,
    estadoDocumental: !requiereCategoria && faltantes.length === 0 ? 'COMPLETO' : 'INCOMPLETO',
    completos,
    totalObligatorios,
    verificadosObligatorios,
    todosVerificados,
  };
}
