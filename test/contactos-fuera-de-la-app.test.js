// Contactos que el equipo hizo POR FUERA de la app.
//
// Lo que estos tests protegen, en orden de importancia:
//
//  1. Que un contacto externo NO pueda entrar a la serie de la app. Es la
//     razón de ser de la columna `source`: la gráfica "Envíos por canal" es el
//     instrumento con el que se responde "¿el relevo está reteniendo?", y una
//     fila que la app nunca envió la vuelve incontestable.
//  2. Que el identificador crudo del proveedor no pueda viajar. Un `wamid` de
//     WhatsApp lleva el teléfono del destinatario codificado adentro.
//  3. Que reintentar no duplique y que registrar se pueda deshacer — porque
//     "a esta persona se le avisó el 12" es una afirmación sobre un hecho
//     pasado, y una afirmación que no se puede retirar no debería poder
//     hacerse.
//  4. Que el bloque de la ficha lo vea el equipo y nadie más.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeVercelOAuth } = require('./helpers');

// Nombres sintéticos, igual que en el resto de la suite: nunca una persona
// real en un test.
const PERSONA = 'Persona De Prueba Contactos';

const ref = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function startApp() {
  const adapter = await createSqliteAdapter(':memory:');
  const app = await createApp(adapter, nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, adapter, store: createStore(adapter), base: `http://127.0.0.1:${server.address().port}` };
}

async function crearPersona(base, name = PERSONA) {
  const res = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, status: 'missing' })
  });
  assert.equal(res.status, 201);
  return (await res.json()).person_id;
}

function registrar(base, body, { key } = {}) {
  return fetch(`${base}/api/contact-log`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify(body)
  });
}

const CONTACTO_BASE = {
  channel: 'email',
  result: 'enviado',
  occurred_at: '2026-08-11T15:04:05Z'
};

test('un contacto externo se registra, y NO entra en la serie de envíos de la app', async (t) => {
  const { server, store, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);

  const res = await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: ref('correo-1') });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, created: true, person_id: personId });

  // La serie de la app: sin `source`, el default del adapter es 'app'. Ver
  // acá un cero es EL punto de todo el diseño.
  assert.deepEqual(await store.contactLogCounts(), []);
  // Y el mismo hecho, pedido explícitamente, sí está.
  assert.deepEqual(await store.contactLogCounts({ source: 'operador' }), [
    { channel: 'email', result: 'enviado', count: 1 }
  ]);
  // Pedir TODO también hay que escribirlo.
  assert.equal((await store.contactLogCounts({ source: null })).length, 1);
});

test('un contacto externo con fecha vieja no corre "envíos medidos desde" hacia atrás', async (t) => {
  const { server, store, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);

  // Primero un envío de la app, hoy.
  await store.insertContactLog({ personId, updateId: null, channel: 'relevo', result: 'enviado' });
  const antes = await store.contactLogEarliest();
  assert.ok(antes, 'la app ya tiene su primer registro');

  // Y ahora un contacto del equipo, fechado el día en que arrancó el proyecto
  // —lo más atrás que la ruta acepta, y bastante antes del envío de la app.
  const res = await registrar(base, {
    ...CONTACTO_BASE,
    person_id: personId,
    occurred_at: '2026-08-10T00:00:00Z',
    ref: ref('correo-viejo')
  });
  assert.equal(res.status, 201);

  // Si esto se moviera, el panel pintaría como instrumentados días en los que
  // la app no midió nada — la mentira por omisión que esa frase existe para
  // evitar.
  assert.equal(await store.contactLogEarliest(), antes);
  assert.equal(await store.contactLogEarliest({ source: 'operador' }), '2026-08-10T00:00:00Z');
});

test('la serie diaria de la app tampoco ve los contactos externos', async (t) => {
  const { server, store, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);
  await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: ref('correo-diario') });

  assert.deepEqual(await store.contactLogDaily({}), []);
  assert.equal((await store.contactLogDaily({ source: 'operador' })).length, 1);
});

test('reintentar con la misma referencia no duplica el hecho', async (t) => {
  const { server, store, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);
  const r = ref('correo-repetido');

  const primera = await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: r });
  assert.equal(primera.status, 201);
  assert.equal((await primera.json()).created, true);

  const segunda = await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: r });
  // 200, no 409: un reintento no es un error, es el mismo hecho llegando dos
  // veces — que es justo lo que la referencia existe para absorber.
  assert.equal(segunda.status, 200);
  assert.equal((await segunda.json()).created, false);

  assert.deepEqual(await store.contactLogCounts({ source: 'operador' }), [
    { channel: 'email', result: 'enviado', count: 1 }
  ]);
});

test('el identificador crudo del proveedor no puede viajar: solo se acepta un digesto', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);

  // La forma real de un wamid. Lleva el teléfono del destinatario codificado
  // en base64 adentro — este valor es sintético, pero la forma es la que
  // rechazamos.
  const wamidCrudo = 'wamid.HBgMNTcwMDAwMDAwMDAwFQIAERgSMEEwMDAwMDAwMDAwMDAwMDAwAA==';
  const malos = [
    wamidCrudo,
    '<mensaje@correo.ejemplo>',
    ref('bien').slice(0, 32), // demasiado corto
    ref('bien').toUpperCase() + 'zz', // fuera del alfabeto hexadecimal
    ''
  ];
  for (const malo of malos) {
    const res = await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: malo });
    assert.equal(res.status, 400, `debería rechazar ${JSON.stringify(malo).slice(0, 40)}`);
    assert.match((await res.json()).error, /SHA-256/);
  }
});

test('el endpoint rechaza lo que no es un contacto externo válido', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);
  const ok = { ...CONTACTO_BASE, person_id: personId, ref: ref('x') };

  const casos = [
    [{ ...ok, person_id: 999999 }, 404, /Persona no encontrada/],
    // 'relevo' es un camino interno de la app; nadie lo registra desde afuera.
    [{ ...ok, channel: 'relevo' }, 400, /channel/],
    [{ ...ok, channel: 'sms' }, 400, /channel/],
    // 'rechazado' significa "la app decidió no intentar nada" — una persona
    // escribiendo desde su buzón no tiene ese estado.
    [{ ...ok, result: 'rechazado' }, 400, /result/],
    [{ ...ok, occurred_at: 'ayer' }, 400, /occurred_at/],
    [{ ...ok, occurred_at: undefined }, 400, /occurred_at/],
    [{ ...ok, occurred_at: new Date(Date.now() + 86400000).toISOString() }, 400, /futuro/],
    // La cota simétrica: un 1970 arrastraría medio siglo al "medido desde" de
    // la sección externa.
    [{ ...ok, occurred_at: '1970-01-01T00:00:00Z' }, 400, /anterior al inicio/],
    [{ ...ok, occurred_at: '2026-08-09T23:59:59Z' }, 400, /anterior al inicio/]
  ];
  for (const [body, status, mensaje] of casos) {
    const res = await registrar(base, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match((await res.json()).error, mensaje);
  }
});

test('con API_KEY puesta, registrar y retirar exigen la llave', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  const personId = await crearPersona(base);
  env.API_KEY = 'llave-de-prueba';

  const sinLlave = await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: ref('sin-llave') });
  assert.equal(sinLlave.status, 401);

  const conLlave = await registrar(
    base,
    { ...CONTACTO_BASE, person_id: personId, ref: ref('con-llave') },
    { key: 'llave-de-prueba' }
  );
  assert.equal(conLlave.status, 201);

  const borrarSinLlave = await fetch(`${base}/api/contact-log/${ref('con-llave')}`, { method: 'DELETE' });
  assert.equal(borrarSinLlave.status, 401);

  const borrarConLlave = await fetch(`${base}/api/contact-log/${ref('con-llave')}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer llave-de-prueba' }
  });
  assert.equal(borrarConLlave.status, 200);
});

test('un registro externo se puede retirar, y retirar dos veces no es un error', async (t) => {
  const { server, store, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);
  const r = ref('correo-a-retirar');
  await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: r });

  const primera = await fetch(`${base}/api/contact-log/${r}`, { method: 'DELETE' });
  assert.equal(primera.status, 200);
  assert.deepEqual(await primera.json(), { ok: true, deleted: true });
  assert.deepEqual(await store.contactLogCounts({ source: 'operador' }), []);

  const segunda = await fetch(`${base}/api/contact-log/${r}`, { method: 'DELETE' });
  assert.equal(segunda.status, 200);
  assert.deepEqual(await segunda.json(), { ok: true, deleted: false });
});

test('retirar nunca puede borrar un envío que sí hizo la app', async (t) => {
  const { server, store, base } = await startApp();
  t.after(() => server.close());
  const personId = await crearPersona(base);
  const r = ref('fila-de-la-app');
  // Una fila de la app que además lleva referencia — el único caso en que el
  // DELETE podría alcanzarla si no filtrara por procedencia.
  await store.insertContactLog({
    personId,
    updateId: null,
    channel: 'email',
    result: 'enviado',
    externalRef: r
  });

  const res = await fetch(`${base}/api/contact-log/${r}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, false);
  assert.deepEqual(await store.contactLogCounts(), [{ channel: 'email', result: 'enviado', count: 1 }]);
});

test('lo que se registra es el evento, no el destinatario', async (t) => {
  // Base en archivo para poder abrir una segunda conexión y mirar la fila
  // cruda — mismo patrón que test/schema-log-tables.test.js.
  const dbPath = path.join(os.tmpdir(), `encontrados-contactos-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const adapter = await createSqliteAdapter(dbPath);
  const app = await createApp(adapter, nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await adapter.close();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });
  });

  const personId = await crearPersona(base);
  // Un llamador que mande de más: no hay dónde guardarlo, así que se ignora.
  const res = await registrar(base, {
    ...CONTACTO_BASE,
    person_id: personId,
    ref: ref('sin-pii'),
    address: 'alguien@ejemplo.com',
    phone: '+570000000000',
    name: 'Alguien',
    body: 'texto del mensaje'
  });
  assert.equal(res.status, 201);

  const raw = new Database(dbPath);
  try {
    // La lista completa de columnas: si alguien agrega una con forma de PII,
    // este test se cae antes de que llegue a producción.
    const cols = raw
      .prepare('PRAGMA table_info(contact_log)')
      .all()
      .map((c) => c.name)
      .sort();
    assert.deepEqual(cols, [
      'channel',
      'created_at',
      'external_ref',
      'id',
      'person_id',
      'result',
      'source',
      'update_id'
    ]);
    const fila = raw.prepare("SELECT * FROM contact_log WHERE source = 'operador'").get();
    assert.ok(fila, 'la fila externa quedó registrada');
    const serializada = JSON.stringify(fila);
    for (const rastro of ['alguien@ejemplo.com', '+570000000000', 'Alguien', 'texto del mensaje']) {
      assert.ok(!serializada.includes(rastro), `la fila no debería llevar ${rastro}`);
    }
  } finally {
    raw.close();
  }
});

// --------------------------------------------------------------- la ficha

async function sesionDeEquipo(base, oauth) {
  process.env.ADMIN_EMAILS = 'equipo@ejemplo.com';
  process.env.ADMIN_SESSION_SECRET = 'secreto-de-prueba';
  oauth.setUserInfo({ email: 'equipo@ejemplo.com', email_verified: true });
  const startRes = await fetch(`${base}/admin/login/start`, { redirect: 'manual' });
  const getCookies = (res) =>
    (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean))
      .map((c) => c.split(';')[0])
      .join('; ');
  const state = new URL(startRes.headers.get('location')).searchParams.get('state');
  const cb = await fetch(`${base}/admin/auth/callback?code=fake&state=${state}`, {
    redirect: 'manual',
    headers: { Cookie: getCookies(startRes) }
  });
  return getCookies(cb);
}

test('la ficha muestra el aviso al equipo, y no lo muestra a un visitante anónimo', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    delete process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_SESSION_SECRET;
  });
  const personId = await crearPersona(base);
  await registrar(base, { ...CONTACTO_BASE, person_id: personId, ref: ref('aviso-ficha') });

  const anonima = await (await fetch(`${base}/person/${personId}`)).text();
  assert.ok(!anonima.includes('Ya se avisó a quien reportó'), 'un visitante anónimo no ve el bloque');
  assert.ok(!anonima.includes('por fuera de la app'));

  const cookie = await sesionDeEquipo(base, oauth);
  const res = await fetch(`${base}/person/${personId}`, { headers: { Cookie: cookie } });
  const conSesion = await res.text();
  assert.ok(conSesion.includes('Ya se avisó a quien reportó'), 'el equipo sí lo ve');
  assert.ok(conSesion.includes('lo mandó el equipo, por fuera de la app'));
  assert.ok(conSesion.includes('2026-08-11T15:04:05'), 'la fecha del contacto va en el <time>');
  // La respuesta deja de ser la misma para todo el mundo: nadie la puede
  // cachear y servírsela a un anónimo.
  assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('la ficha sin ningún contacto lo dice, y un relevo no cuenta como aviso entregado', async (t) => {
  const oauth = await fakeVercelOAuth();
  const { server, store, base } = await startApp();
  t.after(() => {
    server.close();
    oauth.stop();
    delete process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_SESSION_SECRET;
  });
  const personId = await crearPersona(base);
  // Un relevo es un aviso RETENIDO: fue al buzón del equipo, no a la familia.
  await store.insertContactLog({ personId, updateId: null, channel: 'relevo', result: 'enviado' });

  const cookie = await sesionDeEquipo(base, oauth);
  const html = await (await fetch(`${base}/person/${personId}`, { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes('Todavía no se ha avisado a quien reportó'));
  assert.ok(!html.includes('Ya se avisó a quien reportó'));
});

// --------------------------------------------------- el script de registro

test('el script de registro valida el archivo entero antes de mandar nada', async () => {
  const { readEntries, refFor } = require('../scripts/registrar-contactos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contactos-'));
  const bueno = path.join(dir, 'bueno.jsonl');
  fs.writeFileSync(
    bueno,
    JSON.stringify({
      person_id: 1,
      channel: 'email',
      result: 'enviado',
      occurred_at: '2026-08-11T15:04:05Z',
      message_id: '<abc@correo.ejemplo>'
    }) + '\n'
  );
  const { entries, errors } = readEntries(bueno);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  // El id del proveedor NO queda en lo que se va a mandar: solo su digesto.
  assert.equal(entries[0].ref, refFor('email', '<abc@correo.ejemplo>'));
  assert.ok(!JSON.stringify(entries[0]).includes('abc@correo.ejemplo'));
  assert.match(entries[0].ref, /^[a-f0-9]{64}$/);

  const malo = path.join(dir, 'malo.jsonl');
  fs.writeFileSync(malo, '{"person_id":1,"channel":"paloma","result":"enviado","occurred_at":"2026-08-11T15:04:05Z","message_id":"x"}\n');
  const roto = readEntries(malo);
  assert.equal(roto.entries.length, 0, 'una línea mala deja el lote entero sin registrar');
  assert.equal(roto.errors.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('el script no pierde las líneas buenas que vienen después de una mala', async () => {
  const { readEntries } = require('../scripts/registrar-contactos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contactos-'));
  const file = path.join(dir, 'intercalado.jsonl');
  const linea = (o) =>
    JSON.stringify({
      person_id: 1,
      channel: 'email',
      result: 'enviado',
      occurred_at: '2026-08-11T15:04:05Z',
      message_id: '<uno@correo.ejemplo>',
      ...o
    });
  fs.writeFileSync(
    file,
    [
      linea({ message_id: '<uno@correo.ejemplo>' }),
      linea({ channel: 'paloma', message_id: '<dos@correo.ejemplo>' }),
      linea({ message_id: '<tres@correo.ejemplo>' })
    ].join('\n') + '\n'
  );
  const { entries, errors } = readEntries(file);
  // El lote se aborta igual —main sale con cualquier error—, pero el conteo
  // que se imprime tiene que decir la verdad sobre cuántas líneas están bien.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /línea 2/);
  assert.equal(entries.length, 2, 'la línea 3 sigue contando aunque la 2 esté mala');

  // Number(null) es 0, y 0 es un entero: sin el chequeo explícito, una
  // persona sin id se iba a la ruta como persona 0.
  // `JSON.parse('null')` es válido y devuelve null: leerle un campo tumbaría
  // el script con un TypeError en vez de con el error de archivo.
  const noObjeto = path.join(dir, 'no-objeto.jsonl');
  fs.writeFileSync(noObjeto, 'null\n[1,2]\n"texto"\n');
  const noObj = readEntries(noObjeto);
  assert.equal(noObj.entries.length, 0);
  assert.equal(noObj.errors.length, 3);
  for (const e of noObj.errors) assert.match(e, /debe ser un objeto JSON/);

  const sinId = path.join(dir, 'sin-id.jsonl');
  fs.writeFileSync(sinId, [linea({ person_id: null }), linea({ person_id: '' })].join('\n') + '\n');
  const roto = readEntries(sinId);
  assert.equal(roto.entries.length, 0);
  assert.equal(roto.errors.length, 2);
  for (const e of roto.errors) assert.match(e, /falta person_id/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('la fecha del aviso llega con la misma forma venga del motor que venga', async () => {
  // Postgres entrega created_at como Date; SQLite, como string ISO. La suite
  // corre sobre SQLite, así que sin este test la diferencia solo aparecería
  // en producción: el <time> de la ficha saldría con la forma del Date.
  const fakePostgres = {
    async familyContactLogByPerson() {
      return [
        {
          channel: 'email',
          result: 'enviado',
          source: 'operador',
          created_at: new Date('2026-08-11T15:04:05Z')
        }
      ];
    }
  };
  const [fila] = await createStore(fakePostgres).familyContactLogByPerson(1);
  assert.equal(fila.created_at, '2026-08-11T15:04:05Z');
  assert.equal(typeof fila.created_at, 'string');
});
