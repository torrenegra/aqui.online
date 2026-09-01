// Esquema de api_keys / api_write_log — las dos tablas que sostienen las llaves
// de API con alcance.
//
// Qué protegen estas pruebas, y por qué cada una:
//   1. Que las dos tablas queden creadas en LOS DOS motores. Este repo no tiene
//      migraciones: el esquema se crea al arrancar, y una columna que exista
//      solo en SQLite se estrena en producción.
//   2. Que api_write_log herede la retención del resto del esquema (ON DELETE
//      CASCADE sobre people(id)) y no tenga ninguna columna con forma de PII —
//      misma regla que match_log/contact_log (ver schema-log-tables.test.js).
//   3. Que api_keys no guarde la llave en claro ni datos personales del dueño:
//      solo un alias, un hash y un prefijo.
//   4. Que el bootstrap siga siendo seguro corrido en paralelo consigo mismo
//      (varias instancias arrancan a la vez contra la misma base en Vercel).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSqliteAdapter } = require('../src/store/sqlite');

// La bitácora no puede tener NINGUNA columna que invite a meter texto libre
// sobre una persona. Misma lista que schema-log-tables.test.js, a propósito:
// una sola definición de "esto huele a PII" para todas las bitácoras.
const PII_SHAPED = /full_name|phone|email|address|contact|message|location|reporter/i;

// api_keys sí guarda un alias del dueño (`label`), y eso es deliberado: es lo
// mínimo para poder revocarle a alguien. Lo que NO puede aparecer es un dato de
// contacto — eso convertiría la tabla en un registro de datos personales de
// voluntarios, con su propia retención por definir (Ley 1581).
const OWNER_PII_SHAPED = /phone|telefono|email|correo|cedula|document/i;

// Captura el SQL del bootstrap de Postgres sustituyendo `pg` en el cache de
// módulos — mismo truco que schema-bootstrap.test.js, por la misma razón: la
// suite corre sobre SQLite y no levanta un Postgres.
async function bootstrapStatements() {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const statements = [];

  class FakePool {
    constructor() {}
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    }
  }
  require.cache[pgPath] = {
    id: pgPath,
    filename: pgPath,
    loaded: true,
    exports: { Pool: FakePool }
  };
  delete require.cache[storePath];
  try {
    const { createPostgresAdapter } = require('../src/store/postgres');
    await createPostgresAdapter('postgres://fake/db');
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
  return statements;
}

function columnNames(block) {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('CHECK') && !l.startsWith('--'))
    .map((l) => l.split(/\s+/)[0]);
}

test('Postgres: el bootstrap crea api_keys y api_write_log con sus enums', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS api_keys/i.test(s));
  assert.ok(schema, 'el bootstrap debe crear api_keys');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS api_write_log/i);

  // Los dos alcances. El día que se agregue un tercero, esta prueba obliga a
  // pasar por acá y decidirlo, en vez de que aparezca solo.
  for (const scope of ['operator', 'ingest']) {
    assert.match(schema, new RegExp(`'${scope}'`), `api_keys.scope debe aceptar '${scope}'`);
  }
  for (const action of ['crear', 'actualizar']) {
    assert.match(schema, new RegExp(`'${action}'`), `api_write_log.action debe aceptar '${action}'`);
  }

  // La bitácora hereda la retención que ya rige el esquema: se va con la
  // persona. Sin esto, un borrado a solicitud dejaría atrás el rastro de quién
  // escribió su ficha.
  assert.match(
    schema,
    /api_write_log[\s\S]*?person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/
  );

  // api_keys NO cuelga de people(id) — no es de una persona reportada, es de un
  // voluntario — así que tampoco debe declarar esa referencia por descuido.
  const keysBlock = schema.match(/CREATE TABLE IF NOT EXISTS api_keys \(([\s\S]*?)\);/)[1];
  assert.ok(!/REFERENCES people/i.test(keysBlock), 'api_keys no debe colgar de people(id)');
});

test('Postgres: api_write_log no declara ninguna columna con forma de PII', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS api_keys/i.test(s));
  const block = schema.match(/CREATE TABLE IF NOT EXISTS api_write_log \(([\s\S]*?)\);/)[1];
  for (const col of columnNames(block)) {
    assert.ok(!PII_SHAPED.test(col), `api_write_log.${col} tiene forma de columna con PII`);
  }
});

test('Postgres: api_keys no guarda la llave en claro ni datos de contacto del dueño', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS api_keys/i.test(s));
  const block = schema.match(/CREATE TABLE IF NOT EXISTS api_keys \(([\s\S]*?)\);/)[1];
  const cols = columnNames(block);

  // Lo que sí tiene que estar.
  for (const esperada of ['key_hash', 'key_prefix', 'scope', 'label', 'revoked_at', 'last_used_at']) {
    assert.ok(cols.includes(esperada), `api_keys debería declarar ${esperada}`);
  }
  // Y lo que no. Una columna con la llave en claro anularía todo el punto de
  // guardar un hash.
  for (const prohibida of ['key', 'secret', 'token', 'api_key']) {
    assert.ok(
      !cols.includes(prohibida),
      `api_keys.${prohibida} guardaría la llave en claro — solo se guarda su SHA-256`
    );
  }
  for (const col of cols) {
    assert.ok(
      !OWNER_PII_SHAPED.test(col),
      `api_keys.${col} es un dato de contacto del dueño: la tabla guarda un alias público y nada más`
    );
  }

  // revoked_at y last_used_at van como TEXT en los dos motores porque se
  // comparan en JS; un TIMESTAMPTZ acá volvería Date en Postgres y string en
  // SQLite, y esa diferencia se cuela en producción y no en las pruebas.
  assert.match(block, /revoked_at TEXT/, 'revoked_at debe ser TEXT ISO en los dos motores');
  assert.match(block, /last_used_at TEXT/, 'last_used_at debe ser TEXT ISO en los dos motores');
});

test('Postgres: el bootstrap de las tablas nuevas es idempotente (varias instancias arrancan a la vez)', async () => {
  const statements = await bootstrapStatements();
  const nuevas = statements.filter((s) => /api_keys|api_write_log/i.test(s));
  assert.ok(nuevas.length > 0);
  for (const sql of nuevas) {
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?!IF NOT EXISTS)/gi)) {
      assert.fail(`un CREATE TABLE sin IF NOT EXISTS mataría el arranque de la segunda instancia: ${m[0]}`);
    }
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) {
      assert.fail(`un CREATE INDEX sin IF NOT EXISTS mataría el arranque de la segunda instancia: ${m[0]}`);
    }
  }
});

test('SQLite: las dos tablas quedan creadas, con las mismas columnas y sin PII', async () => {
  const dbPath = path.join(
    os.tmpdir(),
    `encontrados-api-keys-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const adapter = await createSqliteAdapter(dbPath);
  try {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const keys = raw.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name);
      assert.deepEqual(
        keys.sort(),
        [
          'created_at',
          'created_by',
          'id',
          'key_hash',
          'key_prefix',
          'label',
          'last_used_at',
          'revoked_at',
          'scope'
        ],
        'api_keys tiene que tener las MISMAS columnas que en Postgres'
      );
      for (const col of keys) {
        assert.ok(!OWNER_PII_SHAPED.test(col), `api_keys.${col} es un dato de contacto del dueño`);
      }

      const log = raw.prepare('PRAGMA table_info(api_write_log)').all().map((c) => c.name);
      assert.deepEqual(log.sort(), [
        'action',
        'api_key_id',
        'created_at',
        'id',
        'person_id',
        'update_id'
      ]);
      for (const col of log) {
        assert.ok(!PII_SHAPED.test(col), `api_write_log.${col} tiene forma de columna con PII`);
      }
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
    for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suf}`, { force: true });
  }
});

test('SQLite: la bitácora se borra sola cuando se borra la persona, y la llave sobrevive', async () => {
  const dbPath = path.join(
    os.tmpdir(),
    `encontrados-api-keys-cascade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const adapter = await createSqliteAdapter(dbPath);
  try {
    const persona = await adapter.insertPerson('Persona De Prueba Llaves', 'persona de prueba llaves', '');
    const llave = await adapter.insertApiKey({
      label: 'alias-de-prueba',
      keyHash: 'a'.repeat(64),
      keyPrefix: 'aaaaaaaa',
      scope: 'ingest',
      createdBy: 'prueba'
    });

    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = ON');
    try {
      const upd = raw
        .prepare("INSERT INTO updates (person_id, status, source) VALUES (?, 'missing', 'aggregator')")
        .run(persona.id);
      await adapter.insertApiWriteLog({
        personId: persona.id,
        updateId: upd.lastInsertRowid,
        apiKeyId: llave.id,
        action: 'crear'
      });
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM api_write_log').get().n, 1);

      await adapter.deletePerson(persona.id);

      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM api_write_log').get().n,
        0,
        'api_write_log debía vaciarse al borrar la persona (misma retención que updates/photos)'
      );
      // La llave NO se va con la ficha: es de un voluntario, no de la persona
      // reportada, y borrarla dejaría sin poder revocar a quien todavía la tiene.
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n,
        1,
        'la llave no debe borrarse al borrar una persona'
      );
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
    for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suf}`, { force: true });
  }
});
