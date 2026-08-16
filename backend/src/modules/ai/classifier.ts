import { normalizeDni } from '../personas/service.js';

export interface Classification {
  codigo: string | null;
  confianza: number; // 0..1
  candidatos: { codigo: string; score: number }[];
}

// Palabras clave por tipo de documento (en minúscula, sin acentos).
const KEYWORDS: Record<string, string[]> = {
  ART: ['art', 'aseguradora de riesgos', 'riesgos del trabajo', 'contrato de afiliacion', 'certificado de afiliacion', 'experta art', 'ley 24.557', '24.557', 'asegurada por', 'nomina'],
  SEGURO_VIDA: ['seguro de vida', 'vida colectivo', 'seguro colectivo', 'poliza de vida', 'vida obligatorio', 'beneficiario', 'suma asegurada'],
  MONOTRIBUTO: ['monotributo', 'monotributista', 'regimen simplificado', 'recategorizacion', 'constancia de monotributo'],
  CLAUSULA_NO_REPETICION: ['clausula de no repeticion', 'no repeticion', 'renuncia a repetir', 'cencosud'],
};

// Pistas por nombre de archivo.
const FILENAME_HINTS: Record<string, string[]> = {
  ART: ['art', 'nomina'],
  SEGURO_VIDA: ['seguro', 'vida'],
  MONOTRIBUTO: ['monotributo', 'mono'],
  CLAUSULA_NO_REPETICION: ['clausula', 'norepeticion', 'no_repeticion', 'repeticion', 'cencosud'],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function classifyDocument(text: string | null, filename: string): Classification {
  const t = normalize(text ?? '');
  const fn = normalize(filename);
  const scores: Record<string, number> = {};
  // Si el PDF no tiene texto (escaneado), nos apoyamos más en el nombre del archivo.
  const sinTexto = t.trim().length < 20;
  const fnWeight = sinTexto ? 1.0 : 0.5;

  for (const [codigo, words] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const w of words) if (t.includes(normalize(w))) score += 1;
    for (const h of FILENAME_HINTS[codigo] ?? []) if (fn.includes(h)) score += fnWeight;
    if (score > 0) scores[codigo] = score;
  }

  const candidatos = Object.entries(scores)
    .map(([codigo, score]) => ({ codigo, score }))
    .sort((a, b) => b.score - a.score);

  if (candidatos.length === 0) return { codigo: null, confianza: 0, candidatos: [] };

  const top = candidatos[0];
  const total = candidatos.reduce((s, c) => s + c.score, 0);
  // Confianza: proporción del score del ganador, acotada.
  const confianza = Math.min(0.99, total > 0 ? top.score / total : 0);
  // Solo asignamos si hay una ventaja razonable.
  const codigo = confianza >= 0.5 && top.score >= 1 ? top.codigo : null;
  return { codigo, confianza, candidatos };
}

/** Extrae un DNI (7-8 dígitos) del texto. Devuelve null si no hay uno claro. */
export function extractDni(text: string | null): string | null {
  if (!text) return null;
  // Buscar patrones tipo 32.456.789 o 32456789
  const matches = text.match(/\b\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\b/g) ?? [];
  for (const m of matches) {
    const norm = normalizeDni(m);
    if (norm.length >= 7 && norm.length <= 8) return norm;
  }
  return null;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const NAME_STOP = new Set([
  'DNI', 'SEXO', 'SEX', 'NACIONALIDAD', 'NATIONALITY', 'EJEMPLAR', 'REPUBLICA', 'ARGENTINA', 'MERCOSUR',
  'DOCUMENTO', 'DOCUMENT', 'NACIONAL', 'IDENTIDAD', 'REGISTRO', 'MINISTERIO', 'INTERIOR', 'SURNAME', 'NAME',
  'APELLIDO', 'APELLIDOS', 'NOMBRE', 'NOMBRES', 'CUIL', 'CUIT', 'FECHA', 'DATE', 'NACIMIENTO', 'BIRTH',
  'TRAMITE', 'DOMICILIO', 'FIRMA', 'M', 'F',
  // Encabezados de la nómina ART
  'TIPO', 'EMPLEADO', 'EMPLEADOS', 'DECLARADOS', 'RAZON', 'SOCIAL', 'CONTRATO', 'VIGENCIA', 'EXPERTA', 'ART',
  'ASEGURADORA', 'RIESGOS', 'TRABAJO', 'CERTIFICADO', 'AFILIACION', 'FOLIO', 'PAGINA',
]);

/** Toma la primera secuencia de palabras en MAYÚSCULAS (nombre "APELLIDO NOMBRE"). */
function nameSequence(seg: string): { nombre: string; apellido: string } | null {
  const words: string[] = [];
  let skipped = 0;
  for (const tok of seg.split(/\s+/)) {
    if (/^[A-ZÁÉÍÓÚÑ]{2,}$/.test(tok) && !NAME_STOP.has(tok)) words.push(tok);
    else if (words.length === 0 && skipped++ < 2) continue;
    else break;
  }
  if (words.length >= 2) return { apellido: titleCase(words[0]), nombre: titleCase(words.slice(1, 4).join(' ')) };
  return null;
}

/** Toma las palabras en MAYÚSCULAS que siguen a una etiqueta, hasta encontrar otra palabra o stop-word. */
function grabNameAfter(text: string, labelRe: RegExp): string | null {
  const m = text.match(labelRe);
  if (!m || m.index === undefined) return null;
  const rest = text.slice(m.index + m[0].length);
  const words: string[] = [];
  let skipped = 0;
  for (const tok of rest.split(/\s+/)) {
    if (/^[A-ZÁÉÍÓÚÑ]{2,}$/.test(tok) && !NAME_STOP.has(tok)) words.push(tok);
    else if (words.length === 0 && skipped++ < 2) continue; // saltar "/ Surname" etc. antes del valor
    else break;
  }
  return words.length ? words.slice(0, 3).join(' ') : null;
}

/** Extrae Apellido/Nombre desde el texto de un documento (ej. DNI). null si no se puede.
 *  Soporta el formato bilingüe del DNI argentino: "Apellido / Surname" y "Nombre / Name". */
export function extractNombreApellido(text: string | null): { nombre: string; apellido: string } | null {
  if (!text) return null;
  const apellido = grabNameAfter(text, /apellidos?\s*(?:\/?\s*surname)?\s*[:\-]?\s*/i);
  const nombre = grabNameAfter(text, /nombres?\s*(?:\/?\s*name)?\s*[:\-]?\s*/i);
  if (apellido && nombre) return { apellido: titleCase(apellido), nombre: titleCase(nombre) };
  return null;
}

export interface ExtractedPerson {
  dni: string;
  nombre: string | null;
  apellido: string | null;
}

const COMA_NAME = /([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})?)\s*,\s*([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})?)/g;

/** Deduce Apellido/Nombre en un segmento de texto, tomando la coincidencia MÁS CERCANA al final
 *  (la más próxima al DNI, para no confundirse con la persona anterior de la planilla). */
function nameFromSegment(seg: string): { nombre: string; apellido: string } | null {
  // Patrón "APELLIDO, NOMBRE": tomar la última aparición del segmento.
  let last: RegExpMatchArray | null = null;
  COMA_NAME.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = COMA_NAME.exec(seg))) last = mm;
  if (last) return { apellido: titleCase(last[1].trim()), nombre: titleCase(last[2].trim()) };
  // Etiquetas Apellido:/Nombre:
  const etiq = extractNombreApellido(seg);
  if (etiq) return etiq;
  return null;
}

/**
 * Extrae TODAS las personas presentes en un texto (una planilla/PDF puede tener varias).
 * Para cada DNI se busca el nombre en el segmento que va desde el DNI anterior hasta este,
 * evitando así arrastrar el nombre de la persona previa. El nombre es best-effort (puede
 * quedar null y lo completa/verifica Seguridad). Nunca inventa nombres.
 */
/** Deriva el DNI de un CUIL/CUIT de persona (8 dígitos del medio, sin el 0 de relleno). */
export function dniFromCuil(cuil: string): string | null {
  const digits = cuil.replace(/\D/g, '');
  if (digits.length !== 11) return null;
  const prefijo = digits.slice(0, 2);
  // Prefijos de PERSONA física (20,23,24,25,26,27). Empresas: 30/33/34 -> no es persona.
  if (!['20', '23', '24', '25', '26', '27'].includes(prefijo)) return null;
  return digits.slice(2, 10).replace(/^0+/, '');
}

export function extractPeople(text: string | null): ExtractedPerson[] {
  if (!text) return [];
  // 1) Encontrar todos los identificadores válidos (CUIL de persona o DNI).
  const re = /(\d{2}[-\s]?\d{8}[-\s]?\d|\d{1,2}[.\s]?\d{3}[.\s]?\d{3})/g;
  const found: { dni: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1];
    const soloDigitos = raw.replace(/\D/g, '');
    let dni: string | null = null;
    if (soloDigitos.length === 11) {
      dni = dniFromCuil(raw); // CUIL de persona; CUIT de empresa (30/33/34) -> null
    } else if (soloDigitos.length >= 7 && soloDigitos.length <= 8) {
      // Número suelto: aceptar solo si viene con separadores o cerca de "DNI/Documento"
      // (evita folios, números de contrato, teléfonos, etc.).
      const conSeparadores = /[.\s]/.test(raw);
      const contexto = normalize(text.slice(Math.max(0, m.index - 14), m.index));
      if (conSeparadores || /(dni|documento|docum|l\.?c|l\.?e)\W*$/.test(contexto)) dni = soloDigitos;
    }
    if (dni) found.push({ dni, start: m.index, end: m.index + raw.length });
  }

  // 2) Para cada identificador, buscar el nombre alrededor (antes = DNI/etiquetas; después = nómina "APELLIDO NOMBRE").
  const people: ExtractedPerson[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    if (seen.has(cur.dni)) continue;
    seen.add(cur.dni);
    const before = text.slice(i > 0 ? found[i - 1].end : 0, cur.start);
    const after = text.slice(cur.end, i < found.length - 1 ? found[i + 1].start : Math.min(text.length, cur.end + 80));
    const name = nameFromSegment(before) || nameSequence(after) || nameSequence(before);
    people.push({ dni: cur.dni, apellido: name?.apellido ?? null, nombre: name?.nombre ?? null });
  }
  return people;
}

/** Detecta si la documentación es de una Empresa o de un Monotributista. null si no está claro. */
export function detectCategoria(text: string | null): 'EMPRESA' | 'MONOTRIBUTISTA' | null {
  if (!text) return null;
  const t = normalize(text);
  const empresa = ['931', 'formulario 931', 'cargas sociales', 'nomina', 'declaracion jurada', 'seguridad social'].filter((k) => t.includes(k)).length;
  const mono = ['monotributo', 'monotributista', 'regimen simplificado', 'recategorizacion'].filter((k) => t.includes(k)).length;
  if (empresa > 0 && empresa >= mono) return 'EMPRESA';
  if (mono > 0 && mono > empresa) return 'MONOTRIBUTISTA';
  return null;
}

const MESES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

const iso = (y: string, mo: string, d: string) => {
  if (y.length === 2) y = `20${y}`;
  const s = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isNaN(new Date(s).getTime()) ? null : s;
};

/** Extrae la fecha de EMISIÓN del documento (YYYY-MM-DD). null si no se puede determinar.
 *  Soporta "05/08/2026" y el formato de carta "12 de agosto de 2026".
 *  Evita confundirse con fechas de vigencia ("hasta el 31 de julio de 2027"). */
export function extractEmision(text: string | null): string | null {
  if (!text) return null;
  const t = normalize(text);
  let m: RegExpExecArray | null;

  // 1) Fecha del encabezado de la carta ("... Buenos Aires, 12 de agosto de 2026").
  m = /buenos aires[,\s]+(?:a\s+)?(\d{1,2})\s+de\s+([a-zñ]+)\s+de\s+(\d{4})/.exec(t);
  if (m && MESES[m[2]]) { const d = iso(m[3], MESES[m[2]], m[1]); if (d) return d; }
  m = /buenos aires[,\s]+(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t);
  if (m) { const d = iso(m[3], m[2], m[1]); if (d) return d; }

  // 2) Fecha junto a una etiqueta de emisión/pago.
  m = /(emision|emitido|emitida|fecha de emision|fecha de pago|de pago|pago)[^0-9]{0,20}(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t);
  if (m) { const d = iso(m[4], m[3], m[2]); if (d) return d; }

  // 3) Primera fecha del texto que NO venga después de "hasta" (evita fechas de vigencia).
  const noEsHasta = (idx: number) => !/hasta\s*(?:el\s*)?$/.test(t.slice(Math.max(0, idx - 12), idx));
  const reTxt = /(\d{1,2})\s+de\s+([a-zñ]+)\s+de\s+(\d{4})/g;
  while ((m = reTxt.exec(t))) {
    if (MESES[m[2]] && noEsHasta(m.index)) { const d = iso(m[3], MESES[m[2]], m[1]); if (d) return d; }
  }
  const reNum = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/g;
  while ((m = reNum.exec(t))) {
    if (noEsHasta(m.index)) { const d = iso(m[3], m[2], m[1]); if (d) return d; }
  }
  return null;
}

/** Extrae la empresa contratista (nombre + CUIT) de un documento. null si no se detecta. */
export function extractEmpresa(text: string | null): { nombre: string | null; cuit: string | null } | null {
  if (!text) return null;
  let nombre: string | null = null;
  let cuit: string | null = null;

  // "la empresa GMRA S.A.U." / "empresa IATEC S.A. (INDUSTRIA...)"
  const emp = text.match(/empresa\s+([A-ZÁÉÍÓÚÑ0-9][\wÁÉÍÓÚÑ&.\s]{1,60}?(?:S\.?\s?A\.?\s?U?\.?|S\.?\s?R\.?\s?L\.?))/i);
  if (emp) nombre = emp[1].replace(/\s+/g, ' ').trim();

  // CUIT 30-71562186-6 o 30715621866
  const c = text.match(/cuit[^0-9]{0,10}(\d{2}[-\s]?\d{8}[-\s]?\d)/i);
  if (c) cuit = c[1].replace(/\D/g, '');

  if (!nombre && !cuit) return null;
  return { nombre, cuit };
}

/** Extrae una fecha de vencimiento del texto (formato de salida YYYY-MM-DD). null si no hay. */
export function extractVencimiento(text: string | null): string | null {
  if (!text) return null;
  const t = normalize(text);
  // Buscar cerca de la palabra "vencimiento" / "vence" / "validez" / "hasta".
  const re = /(vencimiento|vence|validez|hasta|vigencia)[^0-9]{0,20}(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/g;
  let match: RegExpExecArray | null;
  const fechas: string[] = [];
  while ((match = re.exec(t))) {
    const d = match[2].padStart(2, '0');
    const mo = match[3].padStart(2, '0');
    let y = match[4];
    if (y.length === 2) y = `20${y}`;
    const iso = `${y}-${mo}-${d}`;
    if (!isNaN(new Date(iso).getTime())) fechas.push(iso);
  }
  if (fechas.length === 0) return null;
  // La más lejana suele ser el vencimiento.
  fechas.sort();
  return fechas[fechas.length - 1];
}
