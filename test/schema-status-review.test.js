// Esquema de status_review — la cola de revisión de estado (#190).
//
// Este proyecto no tiene migraciones: el esquema se crea al arrancar y toda
// tabla nueva tiene que quedar IGUAL en los dos motores. Lo que estas pruebas
// protegen:
//
//   1. Que Postgres y SQLite la creen, con los mismos enums.
//   2. Que created_at sea TEXTO ISO en LOS DOS. Es la trampa del repo: un
//      TIMESTAMPTZ vuelve como Date en Postgres y como string en SQLite, y esa
//      diferencia se cuela en producción y no en las pruebas (ya pasó con
//      rescue_asked_at).
//   3. Que herede la retención del resto del esquema: se va con la persona.
//   4. Que update_id NO sea CASCADE — la constancia de una decisión no debe
//      desaparecer porque se borró la fila a la que apuntaba.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSqliteAdapter } = require('../src/store/sqlite');

// Mismo truco que test/schema-log-tables.test.js: se captura lo que el
// bootstrap de Postgres LE MANDARÍA a la base, sin necesitar una base.
async function bootstrapStatements() {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const statements = [];

  class FakePool {
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

function withSqlite(fn) {
  return async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `encontrados-status-review-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const adapter = await createSqliteAdapter(dbPath);
    try {
      await fn(dbPath, adapter);
    } finally {
      await adapter.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };
}

test('Postgres: el bootstrap crea status_review con sus enums y su retención', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) => /CREATE TABLE IF NOT EXISTS status_review/i.test(s));
  assert.ok(schema, 'el bootstrap debe crear status_review');

  const block = schema.match(/CREATE TABLE IF NOT EXISTS status_review \(([\s\S]*?)\n    \);/)[1];

  // Los dos únicos destinos de la cola. Si acá aparece un tercero, alguien
  // convirtió esto en un editor de estado.
  assert.match(block, /probable_status TEXT NOT NULL CHECK \(probable_status IN \('safe','deceased'\)\)/);
  assert.match(block, /notify_mode TEXT CHECK \(notify_mode IN \('direct','relay'\)\)/);

  // Retención heredada, igual que match_log/contact_log.
  assert.match(block, /person_id INTEGER NOT NULL REFERENCES people\(id\) ON DELETE CASCADE/);
  // Y la excepción deliberada: la constancia sobrevive a la fila que apunta.
  assert.match(block, /update_id INTEGER REFERENCES updates\(id\) ON DELETE SET NULL/);

  // La trampa del repo: TEXTO, no TIMESTAMPTZ.
  assert.match(block, /created_at TEXT NOT NULL/);
  assert.ok(
    !/created_at TIMESTAMPTZ/.test(block),
    'created_at como TIMESTAMPTZ volvería Date en Postgres y string en SQLite'
  );
});

test(
  'SQLite: status_review queda creada, con created_at TEXT y el mismo formato ISO que Postgres',
  withSqlite(async (dbPath, adapter) => {
    const raw = new Database(dbPath, { readonly: true });
    try {
      const cols = raw.prepare('PRAGMA table_info(status_review)').all();
      assert.ok(cols.length > 0, 'status_review no existe en SQLite');
      const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
      assert.deepEqual(
        Object.keys(byName).sort(),
        [
          'author',
          'created_at',
          'evidence_note',
          'id',
          'notify_mode',
          'person_id',
          'probable_status',
          'recipients',
          'resolved',
          'update_id'
        ],
        'las columnas de los dos motores tienen que coincidir'
      );
      assert.equal(byName.created_at.type, 'TEXT');
    } finally {
      raw.close();
    }

    // Y el valor real que produce el default: el mismo formato ISO-Z que
    // to_char(...) genera en Postgres, sin milisegundos ni desfase.
    const person = await adapter.insertPerson('Persona Sintetica Esquema', 'persona sintetica esquema', '');
    const row = await adapter.insertStatusReview({
      personId: person.id,
      probableStatus: 'safe',
      evidenceNote: 'nota sintética de prueba',
      author: 'revisora@ejemplo.com',
      resolved: false
    });
    assert.equal(typeof row.created_at, 'string');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  })
);

test(
  'SQLite: la constancia se borra con la persona, y sobrevive al borrado de su update',
  withSqlite(async (dbPath, adapter) => {
    const person = await adapter.insertPerson('Persona Sintetica Cascada', 'persona sintetica cascada', '');
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = ON');
    try {
      const update = raw
        .prepare("INSERT INTO updates (person_id, status, source) VALUES (?, 'unknown', 'aggregator')")
        .run(person.id);
      await adapter.insertStatusReview({
        personId: person.id,
        probableStatus: 'deceased',
        evidenceNote: 'nota sintética de prueba',
        author: 'revisora@ejemplo.com',
        resolved: true,
        updateId: update.lastInsertRowid,
        recipients: 2,
        notifyMode: 'relay'
      });

      // Borrar el update NO se lleva la constancia: la deja huérfana pero
      // legible, que es justamente el punto de ON DELETE SET NULL.
      raw.prepare('DELETE FROM updates WHERE id = ?').run(update.lastInsertRowid);
      const sobrevive = raw.prepare('SELECT * FROM status_review WHERE person_id = ?').all(person.id);
      assert.equal(sobrevive.length, 1, 'la constancia de una decisión no se borra con la fila que apuntaba');
      assert.equal(sobrevive[0].update_id, null);

      // Borrar la persona SÍ: es la regla de retención del esquema entero.
      raw.prepare('DELETE FROM people WHERE id = ?').run(person.id);
      assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM status_review').get().n, 0);
    } finally {
      raw.close();
    }
  })
);
