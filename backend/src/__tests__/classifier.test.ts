import { describe, it, expect } from 'vitest';
import { classifyDocument, extractDni, extractVencimiento, extractEmision, detectCategoria, extractNombreApellido, extractPeople } from '../modules/ai/classifier.js';

describe('clasificación y extracción', () => {
  it('extrae DNI con y sin puntos', () => {
    expect(extractDni('Documento 32.456.789 emitido')).toBe('32456789');
    expect(extractDni('DNI 30111222')).toBe('30111222');
    expect(extractDni('sin numeros de documento')).toBeNull();
  });

  it('clasifica ART, Seguro de vida, Monotributo y Cláusula', () => {
    expect(classifyDocument('Aseguradora de Riesgos del Trabajo - certificado de afiliacion', 'art.pdf').codigo).toBe('ART');
    expect(classifyDocument('Poliza de seguro de vida colectivo - suma asegurada beneficiario', 'seguro.pdf').codigo).toBe('SEGURO_VIDA');
    expect(classifyDocument('Constancia de pago de Monotributo - regimen simplificado', 'mono.pdf').codigo).toBe('MONOTRIBUTO');
    expect(classifyDocument('Clausula de no repeticion a favor de Cencosud', 'clausula.pdf').codigo).toBe('CLAUSULA_NO_REPETICION');
  });

  it('detecta categoría Empresa vs Monotributista', () => {
    expect(detectCategoria('Formulario 931 cargas sociales nomina')).toBe('EMPRESA');
    expect(detectCategoria('constancia de monotributo regimen simplificado')).toBe('MONOTRIBUTISTA');
    expect(detectCategoria('un texto neutro')).toBeNull();
  });

  it('extrae fecha de emisión', () => {
    expect(extractEmision('Comprobante de pago - Fecha de emision 05/08/2026')).toBe('2026-08-05');
    expect(extractEmision('documento sin fecha')).toBeNull();
  });

  it('no inventa clasificación cuando no hay señales', () => {
    const r = classifyDocument('texto sin relación alguna', 'archivo.pdf');
    expect(r.codigo).toBeNull();
  });

  it('extrae apellido y nombre desde el texto del DNI (sin invertirlos)', () => {
    const texto = 'REPUBLICA ARGENTINA DOCUMENTO NACIONAL DE IDENTIDAD Apellido: PEREZ Nombre: JUAN CARLOS DNI 35.123.456 Sexo: M';
    const r = extractNombreApellido(texto);
    expect(r).not.toBeNull();
    expect(r!.apellido).toBe('Perez');
    expect(r!.nombre).toBe('Juan Carlos');
  });

  it('devuelve null si no encuentra las etiquetas', () => {
    expect(extractNombreApellido('texto cualquiera sin datos')).toBeNull();
  });

  it('extrae varias personas de una planilla sin mezclar los nombres', () => {
    const planilla = 'PLANILLA DE PERSONAL - LOCAL FRAVEGA ' +
      '1) PEREZ, JUAN CARLOS - DNI 35.123.456 ' +
      '2) GOMEZ, PEDRO - DNI 30.111.222 ' +
      '3) RODRIGUEZ, ANA MARIA - DNI 28.999.333';
    const people = extractPeople(planilla);
    expect(people).toHaveLength(3);
    expect(people[0]).toMatchObject({ dni: '35123456', apellido: 'Perez', nombre: 'Juan Carlos' });
    expect(people[1]).toMatchObject({ dni: '30111222', apellido: 'Gomez', nombre: 'Pedro' });
    expect(people[2]).toMatchObject({ dni: '28999333', apellido: 'Rodriguez', nombre: 'Ana Maria' });
  });

  it('extrae empleados de una nómina ART por CUIL (nombre después del número)', () => {
    const nomina = 'CUIT: 30715621866 Razon Social: GMRA S.A.U. Tipo Documento Nombre del Empleado ' +
      'C.U.I.L. 20295440385 BULESICH MAXIMILIANO ' +
      'C.U.I.L. 27366085314 FURNARO SONIA ELENA ' +
      'C.U.I.L. 20365941611 VANNA JAVIER LEONARDO';
    const people = extractPeople(nomina);
    expect(people).toHaveLength(3); // no incluye el CUIT de la empresa (30...)
    expect(people[0]).toMatchObject({ dni: '29544038', apellido: 'Bulesich', nombre: 'Maximiliano' });
    expect(people[1]).toMatchObject({ dni: '36608531', apellido: 'Furnaro', nombre: 'Sonia Elena' });
    expect(people[2]).toMatchObject({ dni: '36594161', apellido: 'Vanna', nombre: 'Javier Leonardo' });
  });

  it('no toma folios ni números sueltos sin contexto como DNI', () => {
    expect(extractPeople('N° de folio: 18475185 Contrato 558059')).toHaveLength(0);
  });

  it('extrae fecha de vencimiento', () => {
    expect(extractVencimiento('Vigencia hasta 24/08/2026')).toBe('2026-08-24');
    expect(extractVencimiento('sin fecha')).toBeNull();
  });
});
