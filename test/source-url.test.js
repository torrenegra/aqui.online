// source_url: el enlace a la noticia que confirma que una persona apareció.
//
// Lo que se prueba acá no es "se guarda un campo". Es que un `safe` con enlace
// llegue hasta la ficha que lee alguien buscando a un familiar, y que ese
// enlace no pueda ser cualquier cosa: termina siendo un href clickeable en la
// página más frágil del sitio.
//
// El archivo tiene dos mitades a propósito, y la división importa:
//
//   1. La REGLA, probada directo contra el servicio compartido de admisión
//      (src/report-admission.js), que es donde vive desde que el #138 unificó
//      la admisión de reportes. Probarla ahí y no contra una ruta es lo que
//      dice que las tres puertas —web, API y bot— comparten la misma regla,
//      no tres copias que se pueden separar.
//   2. El RECORRIDO completo, por HTTP, hasta el HTML de la ficha.
//
// Datos 100 % sintéticos, como el resto de la suite.

const test = require('node:test');
const assert = require('node:assert/strict');

const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { createReportAdmission, normalizeSourceUrl } = require('../src/report-admission');

// Mismo arranque que el resto de la suite: cada archivo levanta su propia app
// en memoria para no compartir estado entre pruebas.
async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

// ------------------------------------------------- 1. la regla, en el servicio

test('normalizeSourceUrl solo deja pasar http y https', () => {
  assert.equal(normalizeSourceUrl('https://ejemplo.com/nota'), 'https://ejemplo.com/nota');
  assert.equal(normalizeSourceUrl('http://ejemplo.com/nota'), 'http://ejemplo.com/nota');
  assert.equal(normalizeSourceUrl('  https://ejemplo.com/nota  '), 'https://ejemplo.com/nota');

  // Los tres que importan: dos esquemas que se ejecutarían al hacer clic y una
  // cadena que no es una URL. Ninguno puede terminar en un href.
  assert.equal(normalizeSourceUrl('javascript:alert(1)'), null);
  assert.equal(normalizeSourceUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(normalizeSourceUrl('no-soy-una-url'), null);

  // Ausente es ausente, no la cadena "null".
  assert.equal(normalizeSourceUrl(null), null);
  assert.equal(normalizeSourceUrl(undefined), null);
  assert.equal(normalizeSourceUrl('   '), null);
});

// Un store mínimo: solo la superficie que admitReport toca, para poder mirar
// exactamente qué valor llega a la fila. Es la aserción que importa — que la
// ruta no pueda colar un enlace sin pasar por la regla.
function fakeStore(seen) {
  return {
    async findOrCreatePerson(full_name) {
      return { person: { id: 1, full_name }, created: true };
    },
    async addUpdate(personId, fields) {
      seen.push(fields);
      return { id: 10, person_id: personId, ...fields };
    },
    async getPerson(id) {
      return { id, full_name: 'Persona Prueba Servicio' };
    }
  };
}

function serviceWith(seen) {
  return createReportAdmission({
    store: fakeStore(seen),
    matcher: { enabled: false },
    notifySubscribers: async () => 0,
    findDuplicateCandidates: async () => [],
    duplicateWarning: () => null,
    processPhoto: async () => ({ id: 'p1', unreadable: false })
  });
}

test('admitReport normaliza el enlace antes de escribirlo, venga de donde venga', async () => {
  const seen = [];
  const svc = serviceWith(seen);

  await svc.admitReport({
    name: 'Persona Prueba Servicio',
    status: 'safe',
    source: 'aggregator',
    sourceUrl: '  https://ejemplo.com/noticia/rescatados  '
  });
  assert.equal(seen[0].sourceUrl, 'https://ejemplo.com/noticia/rescatados');
});

test('admitReport descarta un enlace hostil sin tumbar el reporte', async () => {
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'no-soy-una-url']) {
    const seen = [];
    const svc = serviceWith(seen);
    const res = await svc.admitReport({
      name: 'Persona Prueba Servicio',
      status: 'safe',
      source: 'aggregator',
      sourceUrl: hostile
    });
    // Las dos mitades de la promesa: el enlace no se guarda Y el reporte entra.
    // Perder el aviso de que alguien apareció por culpa de un enlace mal
    // formado sería peor que ignorar el enlace.
    assert.equal(res.ok, true, `el reporte debe entrar igual con sourceUrl=${hostile}`);
    assert.equal(seen[0].sourceUrl, null, `no debe guardarse ${hostile}`);
  }
});

test('un origen que no manda enlace guarda null, no undefined', async () => {
  // La web y el bot de WhatsApp no tienen campo de enlace: no lo pasan. La fila
  // que escriben tiene que ser indistinguible de un API que mandó el campo
  // vacío, o el upsert por external_id empezaría a comportarse distinto según
  // por cuál puerta entró el reporte.
  const seen = [];
  const svc = serviceWith(seen);
  await svc.admitReport({ name: 'Persona Prueba Servicio', status: 'missing', source: 'web' });
  assert.equal(seen[0].sourceUrl, null);
});

// ------------------------------------------- 2. el recorrido, hasta la ficha

test('POST /api/updates guarda source_url y lo devuelve en la ficha', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  // env.API_KEY, no process.env.API_KEY: src/env.js copia el entorno al
  // cargarse, así que ponerla después no exigía nada y estas pruebas venían
  // pasando por el camino SIN llave sin querer.
  env.API_KEY = 'test-key';
  t.after(() => { env.API_KEY = ''; });

  const res = await fetch(`${app.base}/api/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify({
      name: 'Persona Prueba Enlace',
      status: 'safe',
      source: 'aggregator',
      source_url: 'https://ejemplo.com/noticia/rescatados-chocó'
    })
  });
  assert.equal(res.status, 201);

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Enlace');
  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();

  assert.match(html, /Encontrado — ver noticia/, 'la ficha debe ofrecer el enlace a la noticia');
  assert.match(html, /ejemplo\.com\/noticia/, 'el href debe apuntar a la noticia');
});

test('un update sin source_url no inventa ningún enlace', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Sin Enlace');
  await app.store.addUpdate(person.id, { status: 'missing', source: 'web', location: 'Quibdó' });

  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();
  assert.doesNotMatch(html, /source-link/, 'sin enlace no debe renderizarse el bloque');
});

test('source_url solo acepta http(s): un javascript: se descarta sin tumbar el reporte', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  // env.API_KEY, no process.env.API_KEY: src/env.js copia el entorno al
  // cargarse, así que ponerla después no exigía nada y estas pruebas venían
  // pasando por el camino SIN llave sin querer.
  env.API_KEY = 'test-key';
  t.after(() => { env.API_KEY = ''; });

  // El caso que importa: alguien con la API key manda un esquema peligroso.
  // El reporte tiene que entrar igual — perder el aviso de que una persona
  // apareció por culpa de un enlace malo sería peor que ignorar el enlace.
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'no-soy-una-url']) {
    const res = await fetch(`${app.base}/api/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        name: 'Persona Prueba Hostil',
        status: 'safe',
        source: 'aggregator',
        source_url: hostile
      })
    });
    assert.equal(res.status, 201, `el reporte debe entrar igual con source_url=${hostile}`);
  }

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Hostil');
  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();

  assert.doesNotMatch(html, /javascript:/, 'nunca debe salir un href javascript:');
  assert.doesNotMatch(html, /data:text\/html/, 'nunca debe salir un href data:');
  assert.doesNotMatch(html, /source-link/, 'un enlace descartado no debe renderizar el bloque');
});

test('un re-push con el mismo external_id refresca el enlace', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  // env.API_KEY, no process.env.API_KEY: src/env.js copia el entorno al
  // cargarse, así que ponerla después no exigía nada y estas pruebas venían
  // pasando por el camino SIN llave sin querer.
  env.API_KEY = 'test-key';
  t.after(() => { env.API_KEY = ''; });

  const post = (sourceUrl) =>
    fetch(`${app.base}/api/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify({
        name: 'Persona Prueba Idempotente',
        status: 'safe',
        source: 'aggregator',
        external_id: 'ctb-9999',
        source_url: sourceUrl
      })
    });

  await post('https://ejemplo.com/nota-vieja');
  await post('https://ejemplo.com/nota-corregida');

  const { person } = await app.store.findOrCreatePerson('Persona Prueba Idempotente');
  const html = await (await fetch(`${app.base}/person/${person.id}`)).text();

  assert.match(html, /nota-corregida/, 'el re-push debe actualizar el enlace');
  assert.doesNotMatch(html, /nota-vieja/, 'el enlace viejo no debe sobrevivir');
});
