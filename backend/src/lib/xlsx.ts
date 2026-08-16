import AdmZip from 'adm-zip';

/**
 * Lector mínimo de archivos .xlsx (Office Open XML) sin dependencias externas.
 * Un .xlsx es un ZIP con XML adentro; leemos la primera hoja y las cadenas
 * compartidas (sharedStrings). Devuelve una matriz de filas/celdas como texto.
 */

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Convierte una referencia de columna ("A", "B", "AA") a índice base 0. */
function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseXlsx(buffer: Buffer): string[][] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return [];
  }

  // 1) Cadenas compartidas
  const shared: string[] = [];
  const ssEntry = zip.getEntry('xl/sharedStrings.xml');
  if (ssEntry) {
    const xml = ssEntry.getData().toString('utf8');
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(xml))) {
      const inner = m[1];
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let t: RegExpExecArray | null;
      let val = '';
      while ((t = tRe.exec(inner))) val += t[1];
      shared.push(decodeXmlEntities(val));
    }
  }

  // 2) Primera hoja
  let sheetXml = '';
  const s1 = zip.getEntry('xl/worksheets/sheet1.xml');
  if (s1) {
    sheetXml = s1.getData().toString('utf8');
  } else {
    const any = zip.getEntries().find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
    if (any) sheetXml = any.getData().toString('utf8');
  }
  if (!sheetXml) return [];

  // 3) Filas y celdas
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(sheetXml))) {
    const rowInner = r[1];
    const cells: string[] = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cRe.exec(rowInner))) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const typeM = attrs.match(/t="([^"]+)"/);
      const type = typeM ? typeM[1] : 'n';
      let value = '';
      if (type === 's') {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) value = shared[parseInt(vM[1], 10)] ?? '';
      } else if (type === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t: RegExpExecArray | null;
        let val = '';
        while ((t = tRe.exec(body))) val += t[1];
        value = decodeXmlEntities(val);
      } else {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) value = decodeXmlEntities(vM[1]);
      }
      cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

export interface ExcelPersona {
  cuil: string;
  nombreCompleto: string;
}

/**
 * Interpreta una planilla con columnas "CUIL" y "Nombre completo".
 * Detecta los encabezados (en cualquier orden). Si no hay encabezados claros,
 * asume que la primera columna es CUIL y la segunda el nombre.
 */
export function parsePersonasExcel(buffer: Buffer): ExcelPersona[] {
  const rows = parseXlsx(buffer);
  if (rows.length === 0) return [];

  const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const soloDigitos = (s: string) => (s || '').replace(/\D/g, '');

  // Buscar fila de encabezado (la primera que mencione "cuil").
  let headerIdx = -1;
  let cuilCol = -1;
  let nombreCol = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const celdas = rows[i].map(norm);
    const cIdx = celdas.findIndex((v) => v.includes('cuil') || v.includes('cuit'));
    if (cIdx >= 0) {
      headerIdx = i;
      cuilCol = cIdx;
      nombreCol = celdas.findIndex((v) => v.includes('nombre') || v.includes('apellido'));
      break;
    }
  }

  const out: ExcelPersona[] = [];
  if (headerIdx >= 0) {
    if (nombreCol < 0) nombreCol = cuilCol === 0 ? 1 : 0;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cuil = soloDigitos(rows[i][cuilCol] ?? '');
      const nombreCompleto = (rows[i][nombreCol] ?? '').trim();
      if (cuil.length >= 10) out.push({ cuil, nombreCompleto });
    }
  } else {
    // Sin encabezado: col0 = CUIL, col1 = nombre.
    for (const row of rows) {
      const cuil = soloDigitos(row[0] ?? '');
      const nombreCompleto = (row[1] ?? '').trim();
      if (cuil.length >= 10) out.push({ cuil, nombreCompleto });
    }
  }
  return out;
}
