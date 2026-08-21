const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { handleInbound } = require('../src/bot');
const { nullMatcher } = require('../src/faces');

// #162: dar de baja una suscripción cascada también sobre `photos` (kind
// 'query', las fotos que sube un rescatista para que le avisen). Esa fila era
// el único lugar donde vivía el face_id, así que sin este arreglo la firma se
// queda indexada en Rekognition para siempre. Mismo problema que
// test/face-deletion.test.js ya fija para el borrado de persona, ahora en los
// tres caminos de baja: el link del pie de cada aviso, BAJA <nombre> y BAJA
// TODO por WhatsApp.

// Anota cada llamada para poder afirmar QUÉ se retiró y EN CUÁNTOS lotes, no
// solo que se llamó.
function deletingMatcher({ broken = false } = {}) {
  return {
    enabled: true,
    deleteCalls: [],
    async indexFace() {
      return { faceId: null, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage() {
      return [];
    },
    async deleteFaces(faceIds) {
      this.deleteCalls.push([...faceIds]);
      if (broken) throw new Error('Rekognition no responde');
      return { deleted: [...faceIds], unconfirmed: [] };
    }
  };
}

// Arranca en frío: `enabled` miente hasta que alguien llama a ensureReady() —
// es el caso que documenta src/facematch.js (#89). forgetPersonFaces despierta
// el matcher antes de leer `enabled`; sin este doble esa rama queda sin cubrir
// en los tres caminos de baja.
function coldMatcher() {
  return {
    enabled: false,
    deleteCalls: [],
    async ensureReady() {
      this.enabled = true;
    },
    async deleteFaces(faceIds) {
      this.deleteCalls.push([...faceIds]);
      return { deleted: [...faceIds], unconfirmed: [] };
    }
  };
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    store: app.locals.store
  };
}

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

// Una persona con una suscripción ya verificada y sus fotos de rescatista ya
// indexadas. Se arma por el store y no por HTTP/WhatsApp a propósito: lo que
// se prueba acá es el borrado, no la subida.
async function subscribedWithFaces(store, name, channel, address, faceIds) {
  const { person } = await store.findOrCreatePerson(name);
  const { sub } = await store.subscribe(person.id, channel, address);
  for (const faceId of faceIds) {
    const photo = await store.addPhoto({
      personId: person.id,
      kind: 'query',
      subscriptionId: sub.id,
      content: Buffer.from(faceId),
      contentType: 'image/jpeg'
    });
    await store.setPhotoFaceId(photo.id, faceId);
  }
  return { person, sub };
}

// ---------------------------------------------------------- GET /unsubscribe

test('el link de baja retira la firma facial de la suscripción', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { sub } = await subscribedWithFaces(
    store,
    'Persona Prueba Uno',
    'email',
    'rescatista.uno@ejemplo.com',
    ['face-sub-1', 'face-sub-2']
  );

  const res = await fetch(`${base}/unsubscribe?token=${sub.verify_token}`);
  assert.equal(res.status, 200);

  assert.deepEqual(matcher.deleteCalls.flat().sort(), ['face-sub-1', 'face-sub-2']);
  // Y la suscripción, como siempre.
  assert.equal(await store.getSubscriptionById(sub.id), undefined);
});

test('las firmas de otra suscripción no se tocan', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { sub: borrada } = await subscribedWithFaces(
    store,
    'Persona Prueba Uno',
    'email',
    'uno@ejemplo.com',
    ['face-uno']
  );
  const { sub: otra } = await subscribedWithFaces(
    store,
    'Persona Prueba Dos',
    'email',
    'dos@ejemplo.com',
    ['face-dos']
  );

  await fetch(`${base}/unsubscribe?token=${borrada.verify_token}`);

  assert.deepEqual(matcher.deleteCalls.flat(), ['face-uno']);
  assert.ok(await store.getSubscriptionById(otra.id), 'la otra suscripción sigue en pie');
});

test('un token inválido no toca la colección', async (t) => {
  const matcher = deletingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => server.close());

  const res = await fetch(`${base}/unsubscribe?token=no-existe`);
  assert.equal(res.status, 404);
  assert.deepEqual(matcher.deleteCalls, []);
});

test('una suscripción sin fotos indexadas no gasta una llamada a la colección', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { sub } = await subscribedWithFaces(store, 'Sin Fotos', 'email', 'sinfotos@ejemplo.com', []);

  const res = await fetch(`${base}/unsubscribe?token=${sub.verify_token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(matcher.deleteCalls, []);
});

test('si Rekognition falla, la baja se hace igual', async (t) => {
  const matcher = deletingMatcher({ broken: true });
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { sub } = await subscribedWithFaces(store, 'Persona Prueba Tres', 'email', 'tres@ejemplo.com', [
    'face-tres'
  ]);

  const res = await fetch(`${base}/unsubscribe?token=${sub.verify_token}`);
  // La baja no puede quedar bloqueada porque un proveedor externo esté caído.
  assert.equal(res.status, 200);
  assert.equal(await store.getSubscriptionById(sub.id), undefined);
});

test('la firma se retira DESPUÉS de que la baja ya se hizo', async (t) => {
  const matcher = deletingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => server.close());

  const { sub } = await subscribedWithFaces(store, 'Persona Prueba Cuatro', 'email', 'cuatro@ejemplo.com', [
    'face-cuatro'
  ]);

  // El orden ES la garantía: si la base falla a mitad de camino, la firma
  // sigue en la colección y la baja se puede reintentar entera. Al revés
  // quedaría una firma retirada con la suscripción todavía viva.
  let bajaYaHecha = null;
  matcher.deleteFaces = async (ids) => {
    bajaYaHecha = (await store.getSubscriptionById(sub.id)) === undefined;
    return { deleted: [...ids], unconfirmed: [] };
  };

  assert.equal((await fetch(`${base}/unsubscribe?token=${sub.verify_token}`)).status, 200);
  assert.equal(bajaYaHecha, true, 'la suscripción ya debe estar borrada al tocar la colección');
});

// -------------------------------------------------------- BAJA <nombre> / TODO

test('BAJA <nombre> retira la firma facial de esa suscripción', async (t) => {
  const store = await freshStore();
  const matcher = deletingMatcher();
  const phone = '573001112233';

  const { sub } = await subscribedWithFaces(store, 'Ana Prueba Uno', 'whatsapp', phone, ['face-ana']);

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA Ana Prueba Uno',
    matcher
  });

  assert.match(reply, /ya no recibirás avisos/);
  assert.deepEqual(matcher.deleteCalls.flat(), ['face-ana']);
  assert.equal(await store.getSubscriptionById(sub.id), undefined);
});

test('BAJA <nombre> despierta un matcher en frío antes de retirar la firma', async (t) => {
  const store = await freshStore();
  const matcher = coldMatcher();
  const phone = '573001112255';

  const { sub } = await subscribedWithFaces(store, 'Gabi Prueba Uno', 'whatsapp', phone, ['face-gabi']);

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA Gabi Prueba Uno',
    matcher
  });

  assert.match(reply, /ya no recibirás avisos/);
  // Si esto queda vacío, forgetPersonFaces leyó `enabled` en frío (falso) y
  // nunca llegó a llamar a deleteFaces — el bug clase #89.
  assert.deepEqual(matcher.deleteCalls.flat(), ['face-gabi']);
  assert.equal(await store.getSubscriptionById(sub.id), undefined);
});

test('BAJA <nombre> sin suscripción no gasta una llamada a la colección', async (t) => {
  const store = await freshStore();
  const matcher = deletingMatcher();
  const phone = '573001112244';

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA Nadie Suscrito',
    matcher
  });

  assert.match(reply, /No encontré/);
  assert.deepEqual(matcher.deleteCalls, []);
});

test('BAJA TODO retira, en un solo lote, las firmas de todas las suscripciones', async (t) => {
  const store = await freshStore();
  const matcher = deletingMatcher();
  const phone = '573004445566';

  await subscribedWithFaces(store, 'Beto Prueba Uno', 'whatsapp', phone, ['face-beto']);
  await subscribedWithFaces(store, 'Cati Prueba Dos', 'whatsapp', phone, ['face-cati-1', 'face-cati-2']);

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA TODO',
    matcher
  });

  assert.match(reply, /cancelé tus 2 suscripciones/);
  // Un solo lote, no una llamada por suscripción — es lo que pedía el #162
  // para que la baja masiva no dependa de N respuestas de Rekognition.
  assert.equal(matcher.deleteCalls.length, 1);
  assert.deepEqual(matcher.deleteCalls[0].sort(), ['face-beto', 'face-cati-1', 'face-cati-2']);
  for (const nombre of ['beto prueba uno', 'cati prueba dos']) {
    const [persona] = await store.searchPeople(nombre);
    assert.equal((await store.getSubscriptions(persona.id)).length, 0);
  }
});

test('BAJA TODO sin suscripciones no gasta una llamada a la colección', async (t) => {
  const store = await freshStore();
  const matcher = deletingMatcher();

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573009990000',
    text: 'BAJA TODO',
    matcher
  });

  assert.match(reply, /No tenías suscripciones activas/);
  assert.deepEqual(matcher.deleteCalls, []);
});

test('si Rekognition falla, BAJA TODO cancela las suscripciones igual', async (t) => {
  const store = await freshStore();
  const matcher = deletingMatcher({ broken: true });
  const phone = '573007778899';

  await subscribedWithFaces(store, 'Diego Prueba Uno', 'whatsapp', phone, ['face-diego']);

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA TODO',
    matcher
  });

  // La baja ya se prometió al usuario: no puede quedar condicionada a que
  // Rekognition responda.
  assert.match(reply, /cancelé tus 1 suscripciones/);
  const [persona] = await store.searchPeople('diego prueba uno');
  assert.equal((await store.getSubscriptions(persona.id)).length, 0);
});

test('sin reconocimiento facial, la baja no se ve afectada', async (t) => {
  const store = await freshStore();
  const phone = '573006665544';

  await subscribedWithFaces(store, 'Elena Prueba Uno', 'whatsapp', phone, ['face-elena']);

  const reply = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA Elena Prueba Uno',
    matcher: nullMatcher
  });

  assert.match(reply, /ya no recibirás avisos/);
});

// ---------------------------------------- Postgres: forma del SQL (sin DB real)
//
// BAJA TODO puede afectar varias suscripciones a la vez, y la primera versión
// de este arreglo borraba con `WHERE channel = $1 AND address = $2` — el mismo
// filtro que ya usó el SELECT de arriba. Eso reabre el propio hueco del #162:
// una suscripción creada entre el SELECT y el DELETE cae en ese WHERE sin que
// su face_id se haya leído nunca. El DELETE tiene que ir por los ids ya
// leídos, no repetir el filtro original. Mismo patrón de FakePool que
// test/panel-extras.test.js usa para fijar la forma del SQL sin una base real.
async function withFakePostgresAdapter(run) {
  const pgPath = require.resolve('pg');
  const storePath = require.resolve('../src/store/postgres');
  const savedPg = require.cache[pgPath];
  const savedStore = require.cache[storePath];
  const calls = [];

  class FakePool {
    constructor() {}
    async query(sql, params) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/^SELECT id FROM subscriptions/.test(text)) return { rows: [{ id: 10 }, { id: 11 }] };
      if (/^SELECT face_id FROM photos/.test(text)) {
        return { rows: [{ face_id: 'face-a' }, { face_id: 'face-b' }] };
      }
      if (/^DELETE FROM subscriptions/.test(text)) return { rowCount: 2 };
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

test('Postgres: BAJA TODO borra por los ids ya leídos, no por (channel, address)', async () => {
  await withFakePostgresAdapter(async (adapter, calls) => {
    const result = await adapter.deleteSubscriptionsForAddress('whatsapp', '573000000000');
    assert.deepEqual(result.faceIds.sort(), ['face-a', 'face-b']);

    const del = calls.find((c) => /^DELETE FROM subscriptions/.test(c.sql));
    assert.ok(del, 'debía emitirse un DELETE sobre subscriptions');
    // Por id: una suscripción creada DESPUÉS del SELECT no coincide con
    // ninguno de estos ids, así que este WHERE no puede alcanzarla.
    assert.match(del.sql, /WHERE id = ANY\(\$1\)/);
    assert.deepEqual(del.params, [[10, 11]]);
    assert.doesNotMatch(del.sql, /channel/, 'el DELETE no debe volver a filtrar por channel/address');
  });
});
