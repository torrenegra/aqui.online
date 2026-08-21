// El lado Postgres del arreglo a la condición de carrera de #192
// (coderabbitai): la admisión y el borrado a solicitud comparten un advisory
// lock TRANSACCIONAL por external_id (withExternalIdLock / deletePerson en
// src/store/postgres.js).
//
// Es transaccional y no de sesión por la revisión de cris-pappcorn (punto 1):
// `findPostgresUrl()` (src/store/index.js) solo puede resolver el endpoint
// pooled de Neon — los dos nombres del endpoint directo (`DATABASE_URL_UNPOOLED`,
// `POSTGRES_URL_NON_POOLING`) no están en su lista y tampoco casan con su
// regex — y bajo ese pooler (PgBouncer en modo transacción) un advisory lock
// de SESIÓN y su unlock pueden repartirse en backends distintos: el unlock no
// lanza, la fuga es muda, y el lock queda tomado hasta que el pooler recicle
// esa conexión. `pg_advisory_xact_lock` se toma y se libera en el MISMO
// backend porque vive dentro de una única transacción, y se libera SOLO al
// COMMIT o al ROLLBACK — sin `finally` que dependa de que corra.
//
// No hay Postgres real en este entorno — mismo límite que test/schema-*.test.js
// — así que esto no puede probar contención de un advisory lock de verdad
// entre dos conexiones; lo que SÍ puede probar, con un `pg` de mentira que
// además de `query`/`connect` HACE CUMPLIR `max` (con una cola FIFO, como el
// `pg.Pool` real), es la FORMA del SQL emitido — que ningún lock quede fuera
// de una transacción, que `deletePerson` no vuelva a tomar su conexión del
// pool principal (revisión de cris-pappcorn, punto 3), y —lo que QA encontró
// en la primera versión de este arreglo— que sostener el lock nunca agota el
// pool del que `fn` necesita sacar sus propias conexiones.
const test = require('node:test');
const assert = require('node:assert');

// Como test/schema-suppression-table.test.js, pero este `pg` de mentira además
// de `connect()` hace cumplir `max` con una cola FIFO — sin eso no hay forma
// de que una prueba reproduzca "el pool se quedó sin conexiones libres".
// `pools` guarda cada `new Pool(...)` que el adaptador construya, en el orden
// en que las construye: la primera es siempre `pool` (el principal, las
// queries normales), la segunda es `lockPool` (la del advisory lock).
async function withFakePostgresAdapter(rowsFor, run) {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];

  const pools = [];

  class FakeClient {
    constructor(onRelease) {
      this.calls = [];
      this.released = false;
      this._onRelease = onRelease;
    }
    async query(text, params) {
      this.calls.push({ text: String(text).trim(), params });
      return rowsFor(String(text), params) || { rows: [], rowCount: 0 };
    }
    release() {
      if (this.released) return;
      this.released = true;
      this._onRelease();
    }
  }

  class FakePool {
    constructor(opts) {
      this.max = (opts && opts.max) || Infinity;
      this.active = 0;
      this.waiters = [];
      this.calls = [];
      this.clients = [];
      pools.push(this);
    }
    async _acquire() {
      if (this.active < this.max) {
        this.active += 1;
        return;
      }
      // Cola FIFO: nadie pasa hasta que alguien suelte una conexión — igual
      // que el `pg.Pool` real cuando ya está en `max`.
      await new Promise((resolve) => this.waiters.push(resolve));
      this.active += 1;
    }
    _release() {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
    async query(text, params) {
      await this._acquire();
      try {
        this.calls.push({ text: String(text).trim(), params });
        return rowsFor(String(text), params) || { rows: [], rowCount: 0 };
      } finally {
        this._release();
      }
    }
    async connect() {
      await this._acquire();
      const client = new FakeClient(() => this._release());
      this.clients.push(client);
      return client;
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
    const adapter = await createPostgresAdapter('postgres://fake/db');
    return await run({ adapter, pools });
  } finally {
    delete require.cache[storePath];
    if (savedPg) require.cache[pgPath] = savedPg;
    else delete require.cache[pgPath];
    if (savedStore) require.cache[storePath] = savedStore;
  }
}

test('Postgres: withExternalIdLock abre una transacción, toma el advisory lock TRANSACCIONAL, corre fn y hace COMMIT, en una conexión dedicada del lockPool (no del pool principal)', async () => {
  await withFakePostgresAdapter(
    () => null,
    async ({ adapter, pools }) => {
      let corrioFn = false;
      const resultado = await adapter.withExternalIdLock('clave-x', async () => {
        corrioFn = true;
        return 'listo';
      });

      assert.equal(corrioFn, true);
      assert.equal(resultado, 'listo');
      assert.equal(pools.length, 2, 'un pool principal y uno aparte para el lock');
      const [mainPool, lockPool] = pools;
      assert.equal(mainPool.clients.length, 0, 'el lock no debe tocar el pool principal para nada');
      assert.equal(lockPool.clients.length, 1, 'una sola conexión dedicada, no una por query');

      const [client] = lockPool.clients;
      const textos = client.calls.map((c) => c.text);
      assert.deepEqual(textos, [
        'BEGIN',
        "SET LOCAL lock_timeout = '5s'",
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        'COMMIT'
      ]);
      const lockCall = client.calls.find((c) => c.text === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
      assert.deepEqual(lockCall.params, ['clave-x']);
      assert.equal(client.released, true);
    }
  );
});

test('Postgres: withExternalIdLock hace ROLLBACK (nunca COMMIT) si fn lanza, y libera la conexión igual', async () => {
  await withFakePostgresAdapter(
    () => null,
    async ({ adapter, pools }) => {
      await assert.rejects(
        adapter.withExternalIdLock('clave-x', async () => {
          throw new Error('boom');
        }),
        /boom/
      );
      const [, lockPool] = pools;
      const [client] = lockPool.clients;
      const textos = client.calls.map((c) => c.text);
      assert.ok(textos.includes('ROLLBACK'), 'debe hacer ROLLBACK cuando fn lanza');
      assert.ok(!textos.includes('COMMIT'), 'no debe hacer COMMIT si fn lanzó');
      assert.equal(client.released, true, 'la conexión se libera aunque fn haya lanzado');
    }
  );
});

test('Postgres: tres admisiones concurrentes de llaves DISTINTAS no agotan el pool ni se traban entre sí', async () => {
  // Antes del arreglo original (antes de #192), esto se quedaba esperando
  // para siempre: las tres sostenían la única conexión dedicada al lock que
  // su `withExternalIdLock` pedía al MISMO pool que su propio
  // `isExternalIdSuppressed` necesitaba. Nada en este escenario compite por
  // el mismo advisory lock (son tres llaves distintas), así que no había
  // ninguna razón de negocio para que se esperaran entre sí — era puro
  // agotamiento del pool. El cambio de lock de sesión a transaccional (punto
  // 1 de la revisión de cris-pappcorn) no toca esta garantía: sigue siendo
  // una conexión dedicada del lockPool, nunca del pool principal.
  function rowsFor(text) {
    if (text.trim().startsWith('SELECT 1 FROM suppressed_external_ids')) return { rows: [] };
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter }) => {
    const admisiones = ['clave-a', 'clave-b', 'clave-c'].map((clave) =>
      adapter.withExternalIdLock(clave, () => adapter.isExternalIdSuppressed(clave))
    );

    const resultado = await Promise.race([
      Promise.all(admisiones),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 500))
    ]);

    assert.notEqual(
      resultado,
      'TIMEOUT',
      'tres admisiones concurrentes de llaves distintas no deberían trabar el pool entre sí'
    );
    assert.deepEqual(resultado, [false, false, false]);
  });
});

test('Postgres: deletePerson a solicitud toma su conexión del lockPool (no del pool principal), pide el advisory lock TRANSACCIONAL de cada llave dentro del BEGIN, y guarda el HASH de la llave', async () => {
  function rowsFor(text) {
    const sql = text.trim();
    if (sql.startsWith('SELECT DISTINCT external_id FROM updates')) {
      // A propósito al revés del orden esperado: el código tiene que ordenar
      // él mismo, no confiar en el orden del SELECT. La misma consulta se usa
      // para la instantánea (por `pool`) y para la relectura fresca YA
      // ADENTRO de la transacción (por el client del lockPool).
      return { rows: [{ external_id: 'ext-b' }, { external_id: 'ext-a' }] };
    }
    if (sql.startsWith('INSERT INTO suppressed_external_ids')) {
      return { rows: [], rowCount: 2 };
    }
    if (sql.startsWith('DELETE FROM people')) {
      return { rows: [{ id: 42, full_name: 'Persona Prueba Postgres' }] };
    }
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter, pools }) => {
    const resultado = await adapter.deletePerson(42, { atSubjectRequest: true });

    assert.equal(resultado.id, 42);
    assert.equal(resultado.suppressed_external_ids, 2);

    const [mainPool, lockPool] = pools;

    // La instantánea (solo para saber qué llaves pedir) se lee por el pool
    // principal, con `pool.query` directo — sin conexión dedicada.
    assert.equal(mainPool.clients.length, 0, 'la instantánea no pide una conexión dedicada del pool principal');
    assert.ok(
      mainPool.calls.some((c) => c.text.startsWith('SELECT DISTINCT external_id FROM updates')),
      'la instantánea se lee por el pool principal'
    );

    // Todo lo demás — el lock, la relectura fresca, la supresión y el DELETE
    // — va en UNA sola conexión dedicada del lockPool (revisión de
    // cris-pappcorn, punto 3: nunca del pool principal).
    assert.equal(lockPool.clients.length, 1, 'una sola conexión dedicada del lockPool para todo el borrado');
    const [client] = lockPool.clients;

    const beginPos = client.calls.findIndex((c) => c.text === 'BEGIN');
    const commitPos = client.calls.findIndex((c) => c.text === 'COMMIT');
    const insertPos = client.calls.findIndex((c) => c.text.startsWith('INSERT INTO suppressed_external_ids'));
    const lockCalls = client.calls
      .map((c, i) => ({ i, c }))
      .filter(({ c }) => c.text === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');

    assert.equal(lockCalls.length, 2, 'una llamada de lock transaccional por llave');
    assert.deepEqual(
      lockCalls.map(({ c }) => c.params[0]),
      ['ext-a', 'ext-b'],
      'se piden en orden alfabético, sin importar el orden del SELECT — así dos borrados con llaves ' +
        'en común nunca se traban entre sí por pedirlas al revés'
    );
    assert.ok(beginPos !== -1 && lockCalls.every(({ i }) => i > beginPos), 'los locks se piden DESPUÉS del BEGIN — ya no antes, como con el lock de sesión');
    assert.ok(commitPos !== -1, 'debe hacer COMMIT');
    assert.ok(lockCalls.every(({ i }) => i < commitPos), 'los locks se piden ANTES del COMMIT');

    // El punto 2 de la revisión: nunca se guarda la llave cruda. El orden no
    // importa (la relectura fresca no promete orden, solo dedup + hash), así
    // que se compara como conjunto.
    assert.ok(insertPos !== -1, 'debe insertar en suppressed_external_ids');
    const insertCall = client.calls[insertPos];
    const esperado = new Set(
      ['ext-a', 'ext-b'].map((k) => require('crypto').createHash('sha256').update(k, 'utf8').digest('hex'))
    );
    assert.deepEqual(new Set(insertCall.params[0]), esperado);
    assert.ok(
      !insertCall.params[0].includes('ext-a') && !insertCall.params[0].includes('ext-b'),
      'la llave cruda no debe llegar nunca al INSERT'
    );

    assert.equal(client.released, true);
  });
});

test('Postgres: deletePerson SIN atSubjectRequest no toca ningún advisory lock, aunque siga tomando su conexión del lockPool (la purga de datos de prueba sigue igual)', async () => {
  function rowsFor(text) {
    const sql = text.trim();
    if (sql.startsWith('DELETE FROM people')) {
      return { rows: [{ id: 7, full_name: 'Prueba Entrega Correo' }] };
    }
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter, pools }) => {
    const resultado = await adapter.deletePerson(7);

    assert.equal(resultado.suppressed_external_ids, 0);
    const [mainPool, lockPool] = pools;
    assert.ok(
      !mainPool.calls.some((c) => c.text.startsWith('SELECT DISTINCT external_id FROM updates')),
      'sin atSubjectRequest no hay ninguna llave que proteger, así que no se lee ninguna instantánea'
    );
    assert.equal(lockPool.clients.length, 1, 'deletePerson toma su conexión del lockPool aunque no haya nada que suprimir');
    const [client] = lockPool.clients;
    assert.ok(
      !client.calls.some((c) => /pg_advisory/.test(c.text)),
      'un borrado que no suprime nada no tiene por qué pedir ningún lock'
    );
    assert.ok(
      !client.calls.some((c) => c.text.startsWith('INSERT INTO suppressed_external_ids')),
      'sin atSubjectRequest no se inserta nada en la constancia'
    );
  });
});

test('Postgres: ningún advisory lock vive fuera de su transacción — ni en withExternalIdLock ni en deletePerson a solicitud', async () => {
  // El invariante que hace que la corrección no dependa del entorno (revisión
  // de cris-pappcorn, punto 1): prohíbe la FORMA de un lock de sesión, no un
  // síntoma. Alguien que en seis meses reintroduzca `pg_advisory_lock` o
  // `pg_advisory_unlock[_all]` choca contra esta prueba aunque nunca haya
  // oído hablar de PgBouncer ni del endpoint pooled de Neon.
  const SESSION_LOCK_FORMS = /\bpg_advisory_lock\(|\bpg_advisory_unlock\(|\bpg_advisory_unlock_all\(/;

  function rowsFor(text) {
    const sql = text.trim();
    if (sql.startsWith('SELECT DISTINCT external_id FROM updates')) {
      return { rows: [{ external_id: 'ext-a' }] };
    }
    if (sql.startsWith('DELETE FROM people')) {
      return { rows: [{ id: 1, full_name: 'Persona' }] };
    }
    return null;
  }

  await withFakePostgresAdapter(rowsFor, async ({ adapter, pools }) => {
    await adapter.withExternalIdLock('clave-x', async () => 'ok');
    await adapter.deletePerson(1, { atSubjectRequest: true });

    const [mainPool, lockPool] = pools;
    const todasLasLlamadas = [...mainPool.calls, ...lockPool.clients.flatMap((c) => c.calls)];

    for (const { text } of todasLasLlamadas) {
      assert.ok(
        !SESSION_LOCK_FORMS.test(text),
        `no debe aparecer un lock de sesión en el SQL emitido: «${text}»`
      );
    }

    // Todo pg_advisory_xact_lock cae entre un BEGIN y su COMMIT/ROLLBACK, en
    // el MISMO client — nunca suelto en autocommit.
    for (const client of lockPool.clients) {
      const beginPos = client.calls.findIndex((c) => c.text === 'BEGIN');
      const endPos = client.calls.findIndex((c) => c.text === 'COMMIT' || c.text === 'ROLLBACK');
      const lockPositions = client.calls
        .map((c, i) => ({ i, c }))
        .filter(({ c }) => c.text.startsWith('SELECT pg_advisory_xact_lock('))
        .map(({ i }) => i);

      if (!lockPositions.length) continue;
      assert.notEqual(beginPos, -1, 'un client con un lock transaccional debe tener un BEGIN');
      assert.notEqual(endPos, -1, 'un client con un lock transaccional debe tener un COMMIT o ROLLBACK');
      for (const i of lockPositions) {
        assert.ok(i > beginPos && i < endPos, 'el lock transaccional debe caer estrictamente entre el BEGIN y su cierre');
      }
    }
  });
});
