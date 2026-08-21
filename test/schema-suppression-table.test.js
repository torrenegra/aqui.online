// Esquema de suppressed_external_ids (#191) — la constancia de un borrado
// pedido por la persona misma. Mismo patrón que test/schema-log-tables.test.js:
// un `pg` de mentiras captura el SQL del bootstrap sin necesitar Postgres real,
// y el lado de SQLite se inspecciona con la base de verdad.
//
// Esta tabla tiene una propiedad que el resto del esquema no tiene y que hay que
// vigilar: NO cuelga de people(id). Si alguien le agrega la cascada "por
// consistencia", la constancia se borraría junto con la ficha y el borrado
// volvería a deshacerse con el siguiente re-envío.
const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');

// Ni nombre, ni contacto, ni texto libre: el punto de esta tabla es impedir que
// la ficha vuelva, no poder reconstruir lo que se borró.
const PII_SHAPED = /name|full_name|phone|email|address|contact|message|location|reporter|photo|face/i;

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

// El cuerpo del CREATE TABLE de una tabla dentro del SQL del bootstrap.
function cuerpoDeTabla(sql, tabla) {
  const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla} \\(([\\s\\S]*?)\\n    \\);`, 'i'));
  return m ? m[1] : null;
}

test('Postgres: el bootstrap crea suppressed_external_ids de forma idempotente', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) =>
    /CREATE TABLE IF NOT EXISTS suppressed_external_ids/i.test(s)
  );
  assert.ok(schema, 'el bootstrap debe crear suppressed_external_ids');

  const cuerpo = cuerpoDeTabla(schema, 'suppressed_external_ids');
  assert.ok(cuerpo, 'no pude leer el cuerpo de la tabla');

  // La llave es la PRIMARY KEY: es lo que hace que suprimir dos veces la misma
  // ficha no dependa de que el llamador se acuerde de mirar antes.
  assert.match(cuerpo, /external_id TEXT PRIMARY KEY/);
  assert.match(cuerpo, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
});

test('Postgres: la constancia NO cuelga de people(id) — tiene que sobrevivir a la ficha', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) =>
    /CREATE TABLE IF NOT EXISTS suppressed_external_ids/i.test(s)
  );
  const cuerpo = cuerpoDeTabla(schema, 'suppressed_external_ids');

  assert.ok(
    !/REFERENCES/i.test(cuerpo),
    'suppressed_external_ids no puede referenciar nada: la fila de la persona ya no existe ' +
      'cuando esta se escribe, y una cascada se llevaría la constancia con ella'
  );
});

test('Postgres: ninguna columna de la constancia tiene forma de dato personal', async () => {
  const statements = await bootstrapStatements();
  const schema = statements.find((s) =>
    /CREATE TABLE IF NOT EXISTS suppressed_external_ids/i.test(s)
  );
  for (const linea of cuerpoDeTabla(schema, 'suppressed_external_ids').split('\n')) {
    const columna = linea.trim().split(/\s+/)[0];
    if (!columna) continue;
    assert.ok(
      !PII_SHAPED.test(columna),
      `la columna «${columna}» tiene forma de dato personal, y esta tabla no se borra nunca`
    );
  }
});

test('SQLite: la tabla existe, con las mismas dos columnas y sin llave foránea', async () => {
  const Database = require('better-sqlite3');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'encontrados-supresion-')), 'db.sqlite');
  const adapter = await createSqliteAdapter(dbPath);
  try {
    const raw = new Database(dbPath);
    try {
      const columnas = raw.prepare('PRAGMA table_info(suppressed_external_ids)').all();
      assert.deepEqual(
        columnas.map((c) => c.name),
        ['external_id', 'created_at'],
        'los dos motores tienen que quedar iguales'
      );
      assert.equal(columnas.find((c) => c.name === 'external_id').pk, 1);
      for (const c of columnas) {
        assert.ok(!PII_SHAPED.test(c.name), `la columna «${c.name}» tiene forma de dato personal`);
      }
      assert.deepEqual(
        raw.prepare('PRAGMA foreign_key_list(suppressed_external_ids)').all(),
        [],
        'sin llave foránea: la constancia tiene que sobrevivir a la fila de la persona'
      );
    } finally {
      raw.close();
    }
  } finally {
    await adapter.close();
    for (const sufijo of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${sufijo}`, { force: true });
  }
});
