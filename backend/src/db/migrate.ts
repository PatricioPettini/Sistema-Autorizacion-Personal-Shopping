import { db, rawDb, runSchema, schema } from './client.js';
import { sql } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

// Requisitos por tipo de contratista.
//  EMPRESA: Form 931, Pago de ARCA, Nómina ART, Cláusula de No Repetición.
//  MONOTRIBUTISTA: Seguro de Vida Colectivo, Pago del Monotributo, Cláusula de No Repetición.
// El vencimiento de cada documento lo carga manualmente Seguridad al aprobarlo.
const DEFAULT_DOCUMENT_TYPES = [
  { codigo: 'FORM_931', nombre: 'Formulario 931', obligatorio: true, categoria: 'EMPRESA', controlaEmision: false, orden: 1 },
  { codigo: 'PAGO_ARCA', nombre: 'Pago de ARCA', obligatorio: true, categoria: 'EMPRESA', controlaEmision: false, orden: 2 },
  { codigo: 'NOMINA_ART', nombre: 'Nómina ART', obligatorio: true, categoria: 'EMPRESA', controlaEmision: false, orden: 3 },
  { codigo: 'SEGURO_VIDA_COLECTIVO', nombre: 'Seguro de Vida Colectivo (mín. $20.000.000)', obligatorio: true, categoria: 'MONOTRIBUTISTA', controlaEmision: false, orden: 4 },
  { codigo: 'PAGO_MONOTRIBUTO', nombre: 'Pago del Monotributo', obligatorio: true, categoria: 'MONOTRIBUTISTA', controlaEmision: false, orden: 5 },
  { codigo: 'CLAUSULA_NO_REPETICION', nombre: 'Cláusula de No Repetición (a favor de Cencosud SA)', obligatorio: true, categoria: 'AMBOS', controlaEmision: false, orden: 6 },
];

// Tipos viejos que ya no aplican (se desactivan, no se borran para conservar historial).
const OBSOLETE_CODES = ['DNI', 'ART', 'SEGURO_VIDA', 'MONOTRIBUTO'];

/** Agrega una columna si todavía no existe (para bases ya creadas). Idempotente. */
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = rawDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    rawDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateColumns(): void {
  ensureColumn('documentos', 'verificacion', "TEXT NOT NULL DEFAULT 'PENDIENTE'");
  ensureColumn('documentos', 'verificado_por_user_id', 'INTEGER');
  ensureColumn('documentos', 'fecha_verificacion', 'TEXT');
  ensureColumn('documentos', 'nota_verificacion', 'TEXT');
  ensureColumn('document_types', 'categoria', "TEXT NOT NULL DEFAULT 'AMBOS'");
  ensureColumn('document_types', 'controla_emision', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('personas', 'categoria', 'TEXT');
  ensureColumn('personas', 'empresa', 'TEXT');
  ensureColumn('personas', 'cuil', 'TEXT');
  ensureColumn('autorizaciones', 'fecha_hasta', 'TEXT');
  ensureColumn('documentos', 'fecha_vencimiento', 'TEXT');
}

/**
 * Backfill: cada solicitud existente (modelo viejo persona única) pasa a tener
 * su fila en solicitud_personas, así el nuevo modelo (varias personas por
 * solicitud) funciona con los datos ya cargados. Idempotente.
 */
function backfillSolicitudPersonas(): void {
  rawDb.exec(
    `INSERT INTO solicitud_personas (solicitud_id, persona_id, estado)
     SELECT s.id, s.persona_id, s.estado
     FROM solicitudes s
     WHERE s.persona_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM solicitud_personas sp
         WHERE sp.solicitud_id = s.id AND sp.persona_id = s.persona_id
       )`,
  );
}

export function ensureDefaultDocumentTypes(): void {
  for (const dt of DEFAULT_DOCUMENT_TYPES) {
    rawDb
      .prepare(
        `INSERT INTO document_types (codigo, nombre, obligatorio, tiene_vencimiento, categoria, controla_emision, orden, activo)
         VALUES (?, ?, ?, 0, ?, ?, ?, 1)
         ON CONFLICT(codigo) DO UPDATE SET
           nombre = excluded.nombre,
           obligatorio = excluded.obligatorio,
           categoria = excluded.categoria,
           controla_emision = excluded.controla_emision,
           orden = excluded.orden,
           activo = 1`,
      )
      .run(dt.codigo, dt.nombre, dt.obligatorio ? 1 : 0, dt.categoria, dt.controlaEmision ? 1 : 0, dt.orden);
  }
  for (const codigo of OBSOLETE_CODES) {
    rawDb.prepare(`UPDATE document_types SET activo = 0 WHERE codigo = ?`).run(codigo);
  }
  // "Documentación recibida": existe pero INACTIVO (no se muestra en el checklist),
  // se usa internamente para adjuntar el PDF fuente (planilla/bundle) sin perderlo.
  rawDb
    .prepare(
      `INSERT INTO document_types (codigo, nombre, obligatorio, tiene_vencimiento, categoria, controla_emision, orden, activo)
       VALUES ('DOCUMENTACION', 'Documentación recibida', 0, 0, 'AMBOS', 0, 99, 0)
       ON CONFLICT(codigo) DO UPDATE SET activo = 0, obligatorio = 0`,
    )
    .run();
}

export const LOCAL_SIN_ASIGNAR = '(Sin asignar)';

/** Local temporal para solicitudes cuyo local no se pudo identificar automáticamente. */
export function ensurePlaceholderLocal(): void {
  rawDb
    .prepare(
      `INSERT INTO locales (nombre, estado, observaciones)
       VALUES (?, 'INACTIVO', 'Local temporal para solicitudes cuyo local no se pudo identificar. Reasigná el local correcto.')
       ON CONFLICT(nombre) DO NOTHING`,
    )
    .run(LOCAL_SIN_ASIGNAR);
}

export function getPlaceholderLocalId(): number {
  return (rawDb.prepare('SELECT id FROM locales WHERE nombre = ?').get(LOCAL_SIN_ASIGNAR) as { id: number }).id;
}

export function migrate(): void {
  runSchema();
  migrateColumns();
  backfillSolicitudPersonas();
  ensureDefaultDocumentTypes();
  ensurePlaceholderLocal();
  // Verificación mínima
  const count = db.select({ n: sql<number>`count(*)` }).from(schema.documentTypes).get();
  logger.info(`Migración OK. Tipos de documento: ${count?.n ?? 0}`);
}

// Ejecutable directo: tsx src/db/migrate.ts
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate();
}
