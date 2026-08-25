// Bitácora de auto-fusiones (#150). Lo que estos tests protegen: que
// findOrCreatePerson deje registro cuando fusiona por score (no cuando es un
// match exacto, ni cuando crea una persona nueva); que el nombre original —
// que no se persiste en ningún otro lado — sí quede en merge_log; que la
// tabla exista en los dos adaptadores con la MISMA forma y la misma
// retención que el resto del esquema (ON DELETE CASCADE); y la regla de oro
// ya establecida para match_log/contact_log: un fallo acá nunca tumba la
// fusión real.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { logMerge } = require('../src/logbook');

function tempDbPath() {
  return path.join(os.tmpdir(), `encontrados-merge-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

async function bootstrapPostgresStatements() {
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
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
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

test('Postgres: el bootstrap crea merge_log con la misma retención que el resto del esquema', async () => {
  const statements = await bootstrapPostgresStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS merge_log/i.test(s));
  assert.ok(schema, 'el bootstrap debe crear merge_log');
  assert.match(schema, /merge_log[\s\S]*?person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/);
  assert.match(schema, /submitted_name TEXT NOT NULL/);
  assert.match(schema, /score DOUBLE PRECISION NOT NULL/);
});

// Mismo patrón que withFakePostgresAdapter en test/panel-extras.test.js, pero
// capturando también los params: la prueba de arriba solo mira el DDL
// (CREATE TABLE), y logMerge() traga cualquier error del INSERT a propósito
// (para no tumbar la fusión) — así que si nadie prueba el INSERT en sí, un
// fallo del lado de Postgres sería invisible tanto en dev como en prod.
async function withFakePostgresAdapter(run) {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const calls = [];

  class FakePool {
    constructor() {}
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    }
  }
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
  delete require.cache[storePath];
  try {
    const { createPostgresAdapter } = require('../src/store/postgres');
    const adapter = await createPostgresAdapter('postgres://fake/db');
    await run(adapter, calls);
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
}

test('Postgres: insertMergeLog emite el INSERT con person_id, submitted_name y score en ese orden', async () => {
  await withFakePostgresAdapter(async (adapter, calls) => {
    await adapter.insertMergeLog({ personId: 42, submittedName: 'Johan Gómez', score: 0.855 });
    const call = calls.find((c) => /INSERT INTO merge_log/i.test(c.sql));
    assert.ok(call, 'debía emitirse el INSERT de merge_log');
    assert.match(call.sql, /INSERT INTO merge_log \(person_id, submitted_name, score\) VALUES \(\$1, \$2, \$3\)/);
    assert.deepEqual(call.params, [42, 'Johan Gómez', 0.855], 'los params deben llegar en el mismo orden que las columnas');
  });
});

test('SQLite: merge_log existe con las columnas esperadas', async () => {
  const dbPath = tempDbPath();
  const adapter = await createSqliteAdapter(dbPath);
  try {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const cols = raw.prepare('PRAGMA table_info(merge_log)').all().map((c) => c.name);
      assert.deepEqual(cols, ['id', 'person_id', 'submitted_name', 'score', 'created_at']);
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
    cleanup(dbPath);
  }
});

test('findOrCreatePerson: una fusión difusa (score ≥ 0.85, no exacta) queda registrada con el nombre original', async () => {
  const dbPath = tempDbPath();
  const store = createStore(await createSqliteAdapter(dbPath));
  try {
    const { person: original } = await store.findOrCreatePerson('John Alex Gomez');

    // Mismo caso del issue #150: "Johan Gómez" puntúa 0.855 contra
    // "John Alex Gomez" — se fusiona, sin crear una persona nueva.
    const { person: merged, created } = await store.findOrCreatePerson('Johan Gómez');
    assert.equal(created, false, 'no debía crear una persona nueva');
    assert.equal(merged.id, original.id, 'debía fusionar contra la persona ya existente');

    const raw = new Database(dbPath, { readonly: true });
    try {
      const rows = raw.prepare('SELECT person_id, submitted_name, score FROM merge_log').all();
      assert.equal(rows.length, 1, 'debía quedar exactamente una fusión registrada');
      assert.equal(rows[0].person_id, original.id);
      assert.equal(rows[0].submitted_name, 'Johan Gómez', 'debe guardar el nombre TAL COMO se envió, no el normalizado');
      assert.ok(rows[0].score >= 0.85 && rows[0].score < 0.9, `score fuera de rango: ${rows[0].score}`);
    } finally {
      raw.close();
    }
  } finally {
    await store.close();
    cleanup(dbPath);
  }
});

test('findOrCreatePerson: ni un match exacto ni una persona nueva dejan fila en merge_log', async () => {
  const dbPath = tempDbPath();
  const store = createStore(await createSqliteAdapter(dbPath));
  try {
    await store.findOrCreatePerson('María Fernanda López');
    // Mismo normalized_name — no es una decisión de score discutible.
    await store.findOrCreatePerson('MARIA FERNANDA LOPEZ');
    // Nombre sin nada parecido en la base — crea una persona nueva.
    await store.findOrCreatePerson('Alguien Completamente Distinto');

    const raw = new Database(dbPath, { readonly: true });
    try {
      const n = raw.prepare('SELECT COUNT(*) AS n FROM merge_log').get().n;
      assert.equal(n, 0, 'ni el match exacto ni la persona nueva debían registrarse como auto-fusión');
    } finally {
      raw.close();
    }
  } finally {
    await store.close();
    cleanup(dbPath);
  }
});

// La bitácora registra la fusión que OCURRE. Cuando el veto de #150 separa a
// dos reportes, no hubo fusión que registrar — y escribirla igual diría que dos
// personas distintas son la misma, que es justo lo contrario de lo que pasó.
//
// Esta prueba existe porque las dos piezas llegaron por caminos separados: la
// bitácora reescribió la rama que el veto convierte en bucle. Si un rebase
// futuro se lleva la llamada a logMerge, nada falla y nada se registra — la
// segunda mitad de la prueba es la que lo delata.
test('findOrCreatePerson: una fusión vetada no se registra; la que sí ocurre, sí', async () => {
  const dbPath = tempDbPath();
  const store = createStore(await createSqliteAdapter(dbPath));
  try {
    const { person: original } = await store.findOrCreatePerson('John Alex Gomez');
    await store.addUpdate(original.id, {
      status: 'missing',
      location: 'Un lugar de prueba',
      source: 'web',
      department: 'Quindío'
    });

    // Mismo par del issue #150 (0.855), pero el departamento se contradice.
    const vetado = await store.findOrCreatePerson('Johan Gómez', { department: 'Antioquia' });
    assert.equal(vetado.created, true, 'el veto debía abrirle su propio registro');
    assert.equal(vetado.blocked.reason, 'department');

    const raw = new Database(dbPath, { readonly: true });
    try {
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM merge_log').get().n,
        0,
        'una fusión que no ocurrió no puede quedar registrada'
      );
    } finally {
      raw.close();
    }

    // Y sin señal que contradiga, la fusión ocurre y sí queda registrada.
    const fusionado = await store.findOrCreatePerson('Jhon Alex Gomes');
    assert.equal(fusionado.created, false, 'sin contradicción, el parecido debía fusionar');

    const raw2 = new Database(dbPath, { readonly: true });
    try {
      const rows = raw2.prepare('SELECT person_id, submitted_name FROM merge_log').all();
      assert.equal(rows.length, 1, 'la fusión que sí ocurrió debía quedar registrada');
      assert.equal(rows[0].person_id, original.id);
      assert.equal(rows[0].submitted_name, 'Jhon Alex Gomes');
    } finally {
      raw2.close();
    }
  } finally {
    await store.close();
    cleanup(dbPath);
  }
});

test('SQLite: merge_log se borra solo cuando se borra la persona (misma retención que match_log/contact_log)', async () => {
  const dbPath = tempDbPath();
  const store = createStore(await createSqliteAdapter(dbPath));
  try {
    const { person: original } = await store.findOrCreatePerson('John Alex Gomez');
    await store.findOrCreatePerson('Johan Gómez');

    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = ON');
    try {
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM merge_log').get().n, 1);
      await store.deletePerson(original.id);
      assert.equal(
        raw.prepare('SELECT COUNT(*) AS n FROM merge_log').get().n,
        0,
        'merge_log debía vaciarse al borrar la persona'
      );
    } finally {
      raw.close();
    }
  } finally {
    await store.close();
    cleanup(dbPath);
  }
});

test('regla de oro: un store que revienta al escribir merge_log no tumba la fusión', async () => {
  const brokenStore = {
    async insertMergeLog() {
      throw new Error('merge_log roto a propósito');
    }
  };
  await assert.doesNotReject(
    logMerge(brokenStore, { personId: 1, submittedName: 'Alguien De Prueba', score: 0.9 })
  );

  // Y de punta a punta: un adapter roto no debe impedir que findOrCreatePerson
  // devuelva la fusión real. findOrCreatePerson llama a logMerge(adapter, …)
  // directamente (no store.insertMergeLog), así que hay que romper el
  // adapter, no el store, para ejercitar el mismo camino que corre en
  // producción.
  const adapter = await createSqliteAdapter(':memory:');
  const store = createStore(adapter);
  try {
    const { person: original } = await store.findOrCreatePerson('John Alex Gomez');
    adapter.insertMergeLog = async () => {
      throw new Error('merge_log roto a propósito (prueba)');
    };
    const { person: merged, created } = await store.findOrCreatePerson('Johan Gómez');
    assert.equal(created, false);
    assert.equal(merged.id, original.id, 'la fusión debía seguir en pie aunque la bitácora falle');
  } finally {
    await store.close();
  }
});
