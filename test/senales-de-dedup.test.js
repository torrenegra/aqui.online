// Las señales con las que #150 va a dejar de fusionar a dos personas distintas
// que comparten un nombre parecido: el departamento y la edad que declara quien
// reporta. Este PR solo las CAPTURA — la fusión todavía no las mira.
//
// Lo que estas pruebas protegen:
//   - que las dos columnas existan en los DOS adaptadores (no hay carpeta de
//     migraciones: el esquema se crea al arrancar, y una columna que solo
//     aparece en uno es un bug que solo se ve en producción);
//   - que `canonicalDepartment` sea la única puerta, y que lo que no está en la
//     lista entre como null en vez de como un valor que no compara con nada;
//   - que un dato ausente o absurdo NUNCA rechace un reporte — el peor
//     resultado posible de esta app es un reporte que se tiró a la basura;
//   - que ninguna de las dos salga por una respuesta pública.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { createStore } = require('../src/people');
const { canonicalDepartment, DEPARTAMENTOS } = require('../src/departments');
const { publicUpdate } = require('../src/privacy');

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

// Un JPEG de verdad: el camino del reporte lo decodifica para la miniatura.
async function photoBytes() {
  return sharp({
    create: { width: 400, height: 500, channels: 3, background: { r: 120, g: 90, b: 60 } }
  })
    .jpeg()
    .toBuffer();
}

// El mismo patrón de test/schema-log-tables.test.js: un `pg` de mentiras que
// captura el SQL del arranque, sin necesidad de un Postgres real.
async function bootstrapStatements() {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const statements = [];

  const params = [];

  class FakePool {
    async query(sql, args) {
      statements.push(String(sql));
      if (args) params.push(args);
      return { rows: [{}] };
    }
  }
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
  delete require.cache[storePath];
  let adapter;
  try {
    const { createPostgresAdapter } = require('../src/store/postgres');
    adapter = await createPostgresAdapter('postgres://fake/db');
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
  // El adaptador conserva su FakePool, así que las llamadas de después del
  // arranque se siguen capturando.
  return { statements, params, adapter };
}

test('la lista de departamentos son los 32 más Bogotá D.C.', () => {
  assert.equal(DEPARTAMENTOS.length, 33);
  assert.ok(DEPARTAMENTOS.includes('Bogotá D.C.'));
  assert.equal(new Set(DEPARTAMENTOS).size, 33, 'no puede haber un departamento repetido');
});

test('canonicalDepartment devuelve el valor canónico sin importar tildes ni mayúsculas', () => {
  // La razón de ser de la lista cerrada: estas cuatro formas son UN departamento.
  for (const escrito of ['Norte de Santander', 'norte de santander', 'NORTE DE SANTANDER', 'Norte  De  Santander']) {
    assert.equal(canonicalDepartment(escrito), 'Norte de Santander', escrito);
  }
  // La clave descarta espacios, así que la API puede escribir «Bogota DC».
  assert.equal(canonicalDepartment('Bogota DC'), 'Bogotá D.C.');
  assert.equal(canonicalDepartment('Bogotá D.C.'), 'Bogotá D.C.');
});

test('lo que no está en la lista entra como null, no como texto suelto', () => {
  // «No lo sé» es una opción real del formulario: es un "no declarado"
  // explícito, y tiene que guardarse igual que la ausencia del dato.
  assert.equal(canonicalDepartment('no-lo-se'), null);
  assert.equal(canonicalDepartment('N. de Santander'), null);
  assert.equal(canonicalDepartment('Metropolis'), null);
  assert.equal(canonicalDepartment('Antioquia y Caldas'), null, 'dos departamentos no son uno');
  for (const vacio of ['', '   ', null, undefined]) {
    assert.equal(canonicalDepartment(vacio), null);
  }
});

test('la puntuación de sobra no pierde un departamento que sí es de la lista', () => {
  // normalize() limpia signos, así que un dedazo de puntuación NO degrada el
  // dato a "no declarado": sigue siendo Cundinamarca y sigue comparando.
  assert.equal(canonicalDepartment('Cundinamarca!!'), 'Cundinamarca');
  assert.equal(canonicalDepartment('¡Quindío!'), 'Quindío');
});

test('SQLite: updates guarda el departamento canónico y la edad', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Persona Prueba Uno');
  const update = await store.addUpdate(person.id, {
    status: 'missing',
    location: 'Armenia',
    source: 'web',
    department: 'norte de santander',
    age: '34'
  });
  assert.equal(update.department, 'Norte de Santander', 'se guarda canonicalizado, no como llegó');
  assert.equal(update.age, 34, 'la edad se guarda como número, no como string');
  await store.close();
});

test('un departamento fuera de la lista y una edad absurda no rechazan el reporte', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Persona Prueba Dos');
  // El año en la casilla de la edad es el dedazo que esto tiene que absorber.
  const update = await store.addUpdate(person.id, {
    status: 'missing',
    location: 'Armenia',
    source: 'web',
    department: 'Metropolis',
    age: '2024'
  });
  assert.ok(update.id, 'el reporte tiene que entrar igual');
  assert.equal(update.department, null);
  assert.equal(update.age, null, 'una edad fuera de rango es "no declarada", no un 2024 guardado');
  await store.close();
});

// `Number(true)` es 1 y `Number([7])` es 7. Sin este filtro, un JSON con
// `"age": true` guardaría una edad declarada de un año — una señal inventada,
// que es peor que ninguna: en #150 va a decidir si dos personas se separan.
test('un age que no es número ni texto entra como no declarado', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Persona Prueba Seis');
  for (const raro of [true, false, [7], { age: 7 }, () => 7]) {
    const update = await store.addUpdate(person.id, {
      status: 'missing',
      location: 'Armenia',
      source: 'web',
      age: raro
    });
    assert.equal(update.age, null, `${typeof raro} no puede volverse una edad`);
  }
  // Y lo que sí es una edad sigue pasando, por los dos tipos que la API manda.
  assert.equal((await store.addUpdate(person.id, { status: 'missing', source: 'web', age: 34 })).age, 34);
  assert.equal((await store.addUpdate(person.id, { status: 'missing', source: 'web', age: '34' })).age, 34);
  // Cero es una edad real —un bebé— y no puede confundirse con "no declarada".
  assert.equal((await store.addUpdate(person.id, { status: 'missing', source: 'web', age: 0 })).age, 0);
  await store.close();
});

// El agregador reenvía su instantánea con el mismo external_id, y el upsert
// pisa las dos columnas con lo que traiga el reenvío. Esto fija esa semántica
// a propósito: si el reenvío omite el departamento, la señal vuelve a "no
// declarado". Es lo mismo que ya hacen `contact` y `reporter`, y falla hacia
// no separar — que es el comportamiento de hoy, no una separación equivocada.
test('un reenvío con el mismo external_id pisa el departamento y la edad', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Persona Prueba Siete');

  const primero = await store.addUpdate(person.id, {
    status: 'missing',
    location: 'Armenia',
    source: 'aggregator',
    externalId: 'ficha-1',
    department: 'Quindío',
    age: 34
  });
  assert.equal(primero.department, 'Quindío');

  const corregido = await store.addUpdate(person.id, {
    status: 'missing',
    location: 'Armenia',
    source: 'aggregator',
    externalId: 'ficha-1',
    department: 'Antioquia',
    age: 36
  });
  assert.equal(corregido.id, primero.id, 'el reenvío no puede duplicar la fila');
  assert.equal(corregido.department, 'Antioquia', 'un reenvío corrige el dato');
  assert.equal(corregido.age, 36);

  const sinSeñales = await store.addUpdate(person.id, {
    status: 'safe',
    location: 'Armenia',
    source: 'aggregator',
    externalId: 'ficha-1'
  });
  assert.equal(sinSeñales.id, primero.id);
  assert.equal(sinSeñales.department, null, 'un reenvío sin el dato lo deja en no declarado');
  assert.equal(sinSeñales.age, null);
  await store.close();
});

test('un reporte sin ninguna de las dos señales sigue entrando', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Persona Prueba Tres');
  const update = await store.addUpdate(person.id, { status: 'missing', location: 'Armenia', source: 'web' });
  assert.ok(update.id);
  assert.equal(update.department, null);
  assert.equal(update.age, null);
  await store.close();
});

test('SQLite: una base creada antes de #150 gana las dos columnas al arrancar', async () => {
  // Este repo no tiene carpeta de migraciones: el esquema se pone al día solo,
  // en cada arranque. Una base que ya existe en disco es el caso real.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'senales-'));
  const file = path.join(dir, 'vieja.db');
  const vieja = new Database(file);
  vieja.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL, phonetic_name TEXT NOT NULL DEFAULT '', created_at TEXT);
    CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('safe','injured','missing','deceased','unknown')),
      message TEXT, location TEXT, lat REAL, lng REAL, contact TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator','rescate')),
      reporter TEXT, external_id TEXT, source_url TEXT, created_at TEXT);
  `);
  const columnas = (db) => new Set(db.prepare('PRAGMA table_info(updates)').all().map((c) => c.name));
  assert.ok(!columnas(vieja).has('department'), 'la base vieja no las tiene');
  vieja.close();

  const adapter = await createSqliteAdapter(file);
  const abierta = new Database(file, { readonly: true });
  assert.ok(columnas(abierta).has('department'), 'el arranque agrega department');
  assert.ok(columnas(abierta).has('age'), 'el arranque agrega age');
  abierta.close();
  await adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Las dos sentencias hacen falta y no se sustituyen: el CREATE TABLE es el
// contrato que tiene que quedar idéntico al de SQLite —una base nueva de
// Postgres se lee ahí, no en la lista de ALTERs— y el ALTER es el que le da las
// columnas a la base que ya existe.
test('Postgres: el arranque declara las dos columnas y también las agrega', async () => {
  const { statements } = await bootstrapStatements();
  const joined = statements.join('\n');
  const create = joined.match(/CREATE TABLE IF NOT EXISTS updates \(([\s\S]*?)\);/i);
  assert.ok(create, 'falta el CREATE TABLE de updates');
  assert.match(create[1], /department TEXT/i);
  assert.match(create[1], /age INTEGER/i);
  assert.match(joined, /ALTER TABLE updates ADD COLUMN IF NOT EXISTS department TEXT/i);
  assert.match(joined, /ALTER TABLE updates ADD COLUMN IF NOT EXISTS age INTEGER/i);
});

// El contrato de Postgres se prueba aparte del DDL a propósito: es el lado que
// puede fallar en silencio. Si el INSERT no nombra las dos columnas, existen
// vacías para siempre y #150 nunca tiene con qué comparar — y ninguna prueba
// de esquema lo notaría.
test('Postgres: el INSERT escribe department y age, en el orden de sus parámetros', async () => {
  const { statements, params, adapter } = await bootstrapStatements();
  const antes = statements.length;
  await adapter.insertUpdate(7, {
    status: 'missing',
    location: 'Armenia',
    source: 'web',
    department: 'Quindío',
    age: 34
  });
  const sql = statements.slice(antes).find((s) => /INSERT INTO updates/i.test(s));
  assert.ok(sql, 'el adaptador debe mandar un INSERT INTO updates');
  const args = params[params.length - 1];

  // El índice se deriva del propio SQL en vez de escribirse a mano: cada
  // columna nueva de `updates` corre a las demás de posición, y una aserción
  // con el número quemado empieza a probar la columna equivocada en silencio.
  const columnas = sql
    .match(/INSERT INTO updates \(([^)]+)\)/i)[1]
    .split(',')
    .map((c) => c.trim());
  assert.equal(args[columnas.indexOf('department')], 'Quindío');
  assert.equal(args[columnas.indexOf('age')], 34);
});

test('el formulario pide el departamento como lista cerrada, con salida', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const html = await (await fetch(`${base}/report`)).text();
  const select = html.match(/<select name="department"[\s\S]*?<\/select>/);
  assert.ok(select, 'el departamento tiene que ser un select, no texto libre');
  assert.match(select[0], /<option value="Norte de Santander">/);
  assert.match(select[0], /<option value="Bogotá D\.C\.">/);
  // La salida que impide que un campo obligatorio bote un reporte: quien no
  // sabe el departamento lo dice, y el reporte entra igual.
  assert.match(select[0], /<option value="no-lo-se">No lo sé<\/option>/);

  // La edad es opcional de verdad — un dato inventado es peor que uno vacío.
  const age = html.match(/<input name="age"[^>]*>/);
  assert.ok(age, 'falta la casilla de edad');
  assert.doesNotMatch(age[0], /required/);
});

test('un reporte que dice «No lo sé» entra, y sin departamento guardado', async (t) => {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const fd = new FormData();
  fd.set('name', 'Persona Prueba Cinco');
  fd.set('location', 'Barrio San José, Quibdó');
  fd.set('contact_phone', '300 123 4567');
  fd.set('department', 'no-lo-se');
  fd.set('age', '34');
  fd.append('photos', new File([await photoBytes()], 'f.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303, 'el reporte tiene que entrar');

  const personId = Number(res.headers.get('location').match(/^\/person\/(\d+)\?/)[1]);
  const [update] = await app.locals.store.getUpdates(personId);
  assert.equal(update.department, null, '«No lo sé» se guarda como no declarado');
  assert.equal(update.age, 34, 'la edad sí se guarda');
});

// POST /api/updates devolvía la fila cruda. Sin API_KEY configurada la ruta es
// pública, así que cualquiera podía escribir un update y leer de vuelta la fila
// entera — incluido `contact` en claro, y ahora las dos señales nuevas. Con
// external_id la respuesta es además la fila que QUEDÓ, no la que se mandó.
test('la respuesta de POST /api/updates no devuelve la fila cruda', async (t) => {
  // Sin API_KEY la ruta queda pública, que es el escenario que esta prueba
  // mide. Se restaura porque node --test corre todo el archivo en un proceso.
  const apiKeyPrevia = process.env.API_KEY;
  delete process.env.API_KEY;
  t.after(() => {
    if (apiKeyPrevia === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = apiKeyPrevia;
  });
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Persona Prueba Ocho',
      status: 'missing',
      location: 'Armenia',
      source: 'aggregator',
      external_id: 'ficha-9',
      source_url: 'https://ejemplo.test/noticia',
      reporter: 'Persona Prueba Nueve',
      contact: 'contacto@ejemplo.test',
      department: 'Quindío',
      age: 34
    })
  });
  assert.equal(res.status, 201);
  const { update } = await res.json();

  assert.equal(update.department, undefined, 'el departamento es una señal interna');
  assert.equal(update.age, undefined, 'la edad es una señal interna');
  assert.equal(update.contact, undefined, 'el contacto no sale nunca');
  assert.equal(update.reporter, undefined, 'quien reporta sale enmascarado, no crudo');
  assert.doesNotMatch(JSON.stringify(update), /contacto@ejemplo\.test/);

  // Lo que el que llama sí necesita para conciliar su lado sigue estando.
  assert.equal(update.external_id, 'ficha-9');
  assert.equal(update.source_url, 'https://ejemplo.test/noticia');
  assert.equal(update.status, 'missing');
  assert.ok(update.id);
});

test('ninguna de las dos señales sale por una respuesta pública', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Persona Prueba Cuatro');
  const update = await store.addUpdate(person.id, {
    status: 'missing',
    location: 'Armenia',
    source: 'web',
    department: 'Quindío',
    age: 34
  });
  // Se guardaron...
  assert.equal(update.department, 'Quindío');
  assert.equal(update.age, 34);
  // ...pero publicUpdate() nombra campo por campo lo que se publica, y estas
  // dos no están. Son señales internas para des-duplicar, no datos del perfil.
  const publico = publicUpdate(update);
  assert.equal(publico.department, undefined);
  assert.equal(publico.age, undefined);
  assert.ok(!Object.keys(publico).includes('department'));
  assert.ok(!Object.keys(publico).includes('age'));
  await store.close();
});
