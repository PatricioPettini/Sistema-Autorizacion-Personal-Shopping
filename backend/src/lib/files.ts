import crypto from 'node:crypto';
import path from 'node:path';

const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/jpg',
]);

export function isAllowedFile(filename: string, mime?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return false;
  if (mime && !ALLOWED_MIME.has(mime.toLowerCase())) {
    // Algunos clientes envían application/octet-stream; permitimos si la extensión es válida.
    if (mime.toLowerCase() !== 'application/octet-stream') return false;
  }
  return true;
}

export function isZip(filename: string, mime?: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed';
}

/** Quita acentos, caracteres peligrosos y espacios raros. Nunca devuelve rutas. */
export function sanitizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+/g, '.')
    .trim()
    .slice(0, 150);
}

/** Sanitiza para usar como segmento de carpeta (sin puntos iniciales ni traversal). */
export function safeSegment(name: string): string {
  const s = sanitizeName(name).replace(/^\.+/, '').replace(/\.+$/, '');
  return s.replace(/[^A-Za-z0-9 _.\-]/g, '_') || 'sin_nombre';
}

/**
 * Une base + segmentos garantizando que el resultado quede DENTRO de base.
 * Protege contra path traversal / Zip Slip.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const target = path.resolve(base, ...segments.map((s) => s.replace(/^([/\\])+/, '')));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Ruta insegura detectada (posible path traversal).');
  }
  return target;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function ext(filename: string): string {
  return path.extname(filename).toLowerCase();
}
