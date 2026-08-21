// Borrar una ficha a solicitud de la persona tiene que DURAR (#191).
//
// El defecto que fijan estas pruebas: el ON CONFLICT (external_id) de
// insertUpdate es lo que hace idempotente a un re-envío, y necesita que la fila
// exista. Borrada la ficha, un re-envío de la misma no actualizaba nada:
// insertaba de nuevo, con la cara reindexada, sin log ni error. Para el sistema
// era una ficha nueva que entró bien.
//
// Todos los datos de acá son inventados: no hay ninguna persona real en este
// archivo, ni en un nombre ni en una llave.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');

const KEY = 'secreta-de-prueba';
const FICHA = 'https://ejemplo.invalido/?person=00000000-0000-4000-8000-000000000001';

// Anota los indexados para poder afirmar que un re-envío NO vuelve a indexar la
// cara — que es la mitad del defecto que menos se ve, porque no deja rastro.
function countingMatcher() {
  let n = 0;
  return {
    enabled: true,
    indexCalls: [],
    deleteCalls: [],
    async indexFace(bytes) {
      n += 1;
      this.indexCalls.push(bytes.length);
      return { faceId: `cara-${n}`, geometry: null };
    },
    async detectFace() {
      return null;
    },
    async searchByImage() {
      return [];
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

async function jpeg() {
  return sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .jpeg()
    .toBuffer();
}

const push = (base, body) =>
  fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body)
  });

const del = (base, id) =>
  fetch(`${base}/api/people/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${KEY}` }
  });

async function conLlave(base, extra = {}) {
  const foto = await jpeg();
  return push(base, {
    name: 'Persona Prueba Uno',
    status: 'missing',
    source: 'aggregator',
    external_id: FICHA,
    photo: { base64: foto.toString('base64'), content_type: 'image/jpeg' },
    ...extra
  });
}

test('un re-envío de la misma llave ya no revive la ficha borrada', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  assert.equal(matcher.indexCalls.length, 1, 'la primera entrada sí indexa la cara');

  const borrado = await (await del(base, creada.person_id)).json();
  assert.equal(borrado.ok, true);
  assert.equal(borrado.suppressed_external_ids, 1);

  // El re-envío: mismo cuerpo, misma llave. Antes insertaba una persona nueva.
  const reenvio = await conLlave(base);
  assert.equal(reenvio.status, 409);
  const cuerpo = await reenvio.json();
  assert.equal(cuerpo.suppressed, true);
  assert.equal(cuerpo.external_id, FICHA);

  // Las tres consecuencias, que es lo que de verdad se está protegiendo.
  assert.equal((await store.counts()).people, 0, 'no debía quedar ninguna persona');
  assert.equal(matcher.indexCalls.length, 1, 'la cara NO se volvió a indexar');
  assert.equal((await fetch(`${base}/api/people/${creada.person_id}`)).status, 404);
});

test('la constancia sobrevive a la ficha — es la única tabla que no cae en cascada', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  assert.equal(await store.isExternalIdSuppressed(FICHA), false);

  await del(base, creada.person_id);

  // Si suppressed_external_ids colgara de people(id), la cascada se llevaría la
  // constancia junto con la ficha y el borrado volvería a ser reversible.
  assert.equal(await store.isExternalIdSuppressed(FICHA), true);
});

test('reportar a esa persona sin llave externa sigue siendo posible', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  await del(base, creada.person_id);

  // Es el límite del mecanismo y es deliberado: lo que se suprime es la
  // re-entrada automática de una ficha, no el derecho de nadie a reportar. Si
  // una familia la reporta de verdad —por el formulario, que no manda llave—
  // bloquearlo sería peor que el problema que la supresión arregla.
  const res = await push(base, { name: 'Persona Prueba Uno', status: 'missing', source: 'web' });
  assert.equal(res.status, 201);
  assert.equal((await store.counts()).people, 1);
});

test('la supresión es de UNA llave, no de un nombre ni de una fuente', async (t) => {
  const matcher = countingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();
  await del(base, creada.person_id);

  const otra = await conLlave(base, {
    external_id: 'https://ejemplo.invalido/?person=00000000-0000-4000-8000-000000000002'
  });
  assert.equal(otra.status, 201, 'otra llave es otra ficha, aunque venga del mismo agregador');
});

test('la purga de registros de prueba NO suprime la llave', async (t) => {
  const matcher = countingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  // Un registro de prueba lo sembramos nosotros: nadie ejerció ningún derecho,
  // así que su llave no queda bloqueada para siempre. La diferencia entre los
  // dos borrados es de consecuencia, no de forma.
  const sembrada = await (await conLlave(base, { name: 'Prueba Entrega Correo' })).json();
  const purga = await (
    await fetch(`${base}/api/maintenance/purge-test-data`, { method: 'POST' })
  ).json();
  assert.equal(purga.removed_count, 1);
  assert.equal((await fetch(`${base}/api/people/${sembrada.person_id}`)).status, 404);

  const revuelve = await conLlave(base, { name: 'Prueba Entrega Correo' });
  assert.equal(revuelve.status, 201, 'la ficha de prueba puede volver a entrar');
});

// La condición de carrera que señaló coderabbitai en el PR #192: el chequeo de
// admisión (isExternalIdSuppressed) y la escritura del DELETE no compartían
// ninguna frontera. Un re-envío que ya había leído "no suprimida" podía quedar
// en el aire — por cualquiera de los `await` que ya había entre el chequeo y
// el upsert— mientras un DELETE concurrente suprimía esa misma llave y se
// llevaba la fila; cuando el re-envío seguía, escribía igual y la ficha
// revivía sin log ni error. Las dos pruebas de abajo prueban el arreglo:
// `withExternalIdLock` en los dos adaptadores.
// coderabbitai marcó la primera versión de esta prueba: el `setTimeout(20)`
// probaba "el DELETE no terminó todavía", no "el DELETE de verdad intentó
// pedir el mismo lock". Un test así puede pasar aunque la serialización esté
// rota, si el DELETE sencillamente no llegó a programarse a tiempo.
//
// El arreglo no es esperar más — es no depender del reloj. Se llama a
// `store.deletePerson` directo (no por HTTP) porque, leyendo el código,
// `deletePerson` no tiene NINGÚN `await` antes de encolarse en el lock de esta
// llave: lee la instantánea y llama a `lockExternalIds` de forma síncrona. Eso
// significa que en el instante en que esta llamada RETORNA (antes de que
// corra ningún microtask), su pedido ya quedó encolado detrás de la admisión
// que sigue adentro — es un hecho del orden de ejecución de JS, no una
// carrera de temporizador. Y si el lock no lo bloqueara, `deletePerson` —
// sobre SQLite síncrono, sin red— resolvería en un puñado de microtasks; la
// espera de abajo solo existe para dejarle esa chance, no para "alcanzar a
// tiempo".
test('un DELETE no puede intercalarse con una admisión en curso para la MISMA llave', async (t) => {
  const matcher = countingMatcher();
  const { server, base, store } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await conLlave(base)).json();

  // Simula el tramo de admisión que ahora corre bajo lock (el chequeo y la
  // escritura, src/report-admission.js) sosteniendo el MISMO lock que ese
  // tramo pediría para esta llave — como si una admisión ya hubiera leído
  // "no suprimida" y estuviera a mitad de camino hacia su escritura. Señala
  // con una promesa CUÁNDO entró de verdad, en vez de asumirlo.
  let avisarAdmisionEntro;
  const admisionEntro = new Promise((resolve) => {
    avisarAdmisionEntro = resolve;
  });
  let liberarAdmision;
  const sigueAdentro = new Promise((resolve) => {
    liberarAdmision = resolve;
  });
  const admisionEnCurso = store.withExternalIdLock(FICHA, async () => {
    avisarAdmisionEntro();
    await sigueAdentro;
    return 'listo';
  });
  await admisionEntro;

  let borradoListo = false;
  const borrado = store.deletePerson(creada.person_id, { atSubjectRequest: true }).then((r) => {
    borradoListo = true;
    return r;
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    borradoListo,
    false,
    'el DELETE no debería completar mientras la admisión sigue dentro de su ventana crítica'
  );

  liberarAdmision();
  await admisionEnCurso;
  const resultado = await borrado;
  assert.equal(resultado.suppressed_external_ids, 1);
  assert.equal(await store.isExternalIdSuppressed(FICHA), true);
});

// Igual que la prueba de arriba, sin depender del reloj: se espera la señal
// de que A ya entró, no un tiempo fijo. `tareaA` y `tareaB` se piden en el
// MISMO turno síncrono (nada las separa salvo estas dos líneas), así que B ya
// quedó encolado detrás de A antes de que este test llegue siquiera a
// `await`. Para cuando A avisa que entró, si B pudiera entrar antes de que A
// suelte la puerta sería un fallo real de exclusión mutua, no una carrera.
test('withExternalIdLock serializa dos secciones críticas de la MISMA llave, y no toca llaves distintas', async (t) => {
  const { server, store } = await startApp(countingMatcher());
  t.after(() => server.close());

  const eventos = [];
  let avisarAEntro;
  const aEntro = new Promise((resolve) => {
    avisarAEntro = resolve;
  });
  let liberarA;
  const puertaA = new Promise((resolve) => {
    liberarA = resolve;
  });

  const tareaA = store.withExternalIdLock('clave-x', async () => {
    eventos.push('A-entra');
    avisarAEntro();
    await puertaA;
    eventos.push('A-sale');
  });

  let bEntro = false;
  const tareaB = store.withExternalIdLock('clave-x', async () => {
    bEntro = true;
    eventos.push('B-entra');
  });

  await aEntro;
  assert.equal(bEntro, false, 'B no debería poder entrar mientras A sigue dentro de la misma llave');

  // Una llave DISTINTA no tiene por qué esperar a nadie: el alcance del lock
  // es la misma llave y nada más (#191, mismo límite que la supresión).
  let cEntro = false;
  await store.withExternalIdLock('clave-y', async () => {
    cEntro = true;
  });
  assert.equal(cEntro, true, 'una llave distinta no debería esperar a que A termine con la suya');

  liberarA();
  await Promise.all([tareaA, tareaB]);
  assert.deepEqual(eventos, ['A-entra', 'A-sale', 'B-entra']);
});

test('borrar a alguien que nunca entró por una llave no deja constancia de nada', async (t) => {
  const matcher = countingMatcher();
  const { server, base } = await startApp(matcher);
  t.after(() => {
    server.close();
    env.API_KEY = '';
  });
  env.API_KEY = KEY;

  const creada = await (await push(base, { name: 'Persona Prueba Dos', status: 'missing', source: 'web' })).json();
  const borrado = await (await del(base, creada.person_id)).json();

  // Sin llave no hay nada por lo que la ficha pueda volver a entrar sola: una
  // fila vacía en la tabla de constancia no protegería nada y sería un dato de
  // más en la única tabla que no se borra.
  assert.equal(borrado.suppressed_external_ids, 0);
});
