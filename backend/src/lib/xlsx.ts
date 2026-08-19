import AdmZip from 'adm-zip';
import path from 'node:path';

/**
 * Lectores mínimos de planillas SIN dependencias externas. Soportamos los formatos
 * que llegan por email desde los encargados de los locales:
 *   - .xlsx / .xlsm (Office Open XML): ZIP con XML.
 *   - .ods           (OpenDocument):  ZIP con content.xml.
 *   - .csv / .tsv    (texto plano):   delimitador auto-detectado (coma, punto y coma o tab).
 * Cada lector devuelve una matriz de filas/celdas como texto.
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

/**
 * Lector mínimo de archivos .ods (OpenDocument Spreadsheet). Igual que el .xlsx,
 * es un ZIP; los datos viven en content.xml (table:table-row / table:table-cell).
 * Lee la primera tabla. Respeta table:number-columns-repeated (celdas repetidas).
 */
export function parseOds(buffer: Buffer): string[][] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return [];
  }
  const entry = zip.getEntry('content.xml');
  if (!entry) return [];
  const xml = entry.getData().toString('utf8');

  // Primera tabla (una hoja del .ods).
  const tableM = xml.match(/<table:table\b[\s\S]*?<\/table:table>/);
  const tableXml = tableM ? tableM[0] : xml;

  const rows: string[][] = [];
  const rowRe = /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(tableXml))) {
    const cells: string[] = [];
    const cellRe = /<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1]))) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const repM = attrs.match(/table:number-columns-repeated="(\d+)"/);
      const rep = repM ? Math.min(parseInt(repM[1], 10), 1024) : 1; // cap defensivo
      // El texto de la celda son sus <text:p> (uno o varios).
      const pRe = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
      let p: RegExpExecArray | null;
      let val = '';
      while ((p = pRe.exec(body))) val += (val ? ' ' : '') + p[1];
      val = decodeXmlEntities(val.replace(/<[^>]+>/g, '')); // quitar tags internos (<text:s/>, etc.)
      for (let i = 0; i < rep; i++) cells.push(val);
    }
    rows.push(cells);
  }
  return rows;
}

/** Parte una línea CSV/TSV respetando comillas dobles. */
function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // comilla escapada ""
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Lee CSV/TSV. Autodetecta el delimitador (coma, punto y coma o tab). */
export function parseDelimited(buffer: Buffer): string[][] {
  const text = buffer.toString('utf8').replace(/^﻿/, ''); // saca el BOM
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  // Delimitador = el que más aparece en la primera línea (';' es común en configuraciones ES).
  const first = lines[0];
  const cont = (d: string) => first.split(d).length - 1;
  const delim = cont('\t') >= cont(';') && cont('\t') >= cont(',') ? '\t' : cont(';') >= cont(',') ? ';' : ',';
  return lines.map((l) => splitDelimited(l, delim));
}

/** Dispatcher: elige el lector según la extensión del archivo. */
export function parseSpreadsheet(filename: string, buffer: Buffer): string[][] {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.ods') return parseOds(buffer);
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return parseDelimited(buffer);
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(buffer);
  // Sin extensión reconocible: probar por contenido (ZIP → xlsx u ods; si no, texto).
  const rows = parseXlsx(buffer);
  if (rows.length) return rows;
  const ods = parseOds(buffer);
  if (ods.length) return ods;
  return parseDelimited(buffer);
}

export interface ExcelPersona {
  cuil: string;
  nombreCompleto: string;
}

/**
 * Interpreta una planilla (ya leída como filas) con columnas "CUIL" y "Nombre completo".
 * Detecta los encabezados (en cualquier orden). Si no hay encabezados claros,
 * asume que la primera columna es CUIL y la segunda el nombre.
 */
export function filasAPersonas(rows: string[][]): ExcelPersona[] {
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

/** Lee un adjunto de planilla (xlsx/ods/csv/tsv) y devuelve las personas (CUIL + nombre). */
export function parsePersonasSpreadsheet(filename: string, buffer: Buffer): ExcelPersona[] {
  return filasAPersonas(parseSpreadsheet(filename, buffer));
}

/** Compatibilidad: lee solo .xlsx desde un buffer. */
export function parsePersonasExcel(buffer: Buffer): ExcelPersona[] {
  return filasAPersonas(parseXlsx(buffer));
}
