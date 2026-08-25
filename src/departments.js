// La lista cerrada de departamentos de Colombia (32 + Bogotá D.C.), y la única
// puerta que convierte lo que llegó en un valor comparable.
//
// Por qué cerrada, y no el texto libre que ya existía: este valor decide si dos
// reportes con nombres parecidos se fusionan o quedan separados (#150). Con
// texto libre, «N. de Santander» y «Norte de Santander» son dos departamentos
// distintos para una comparación por igualdad — y la señal que existe para
// separar a dos familias las volvería a juntar.
const { normalize } = require('./names');

const DEPARTAMENTOS = [
  'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bogotá D.C.', 'Bolívar', 'Boyacá', 'Caldas',
  'Caquetá', 'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Guainía',
  'Guaviare', 'Huila', 'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander',
  'Putumayo', 'Quindío', 'Risaralda', 'San Andrés y Providencia', 'Santander', 'Sucre',
  'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada'
];

// La clave descarta tildes, mayúsculas Y espacios: el formulario manda el valor
// canónico, pero la API y el agregador escriben a mano, y «Bogotá D.C.»,
// «bogota dc» y «BOGOTA D C» son el mismo departamento.
const key = (value) => normalize(value).replace(/\s+/g, '');
const BY_KEY = new Map(DEPARTAMENTOS.map((d) => [key(d), d]));

// Devuelve el departamento canónico, o null cuando no es uno de la lista.
//
// `null` significa una sola cosa: "no declarado". Nunca rechaza un reporte y
// nunca veta una fusión — un dato que no llegó no puede ser evidencia de que
// dos personas sean distintas.
function canonicalDepartment(value) {
  const k = key(value);
  return k ? BY_KEY.get(k) || null : null;
}

module.exports = { DEPARTAMENTOS, canonicalDepartment };
