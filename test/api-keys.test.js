// Llaves de API con alcance — la puerta, no el esquema.
//
// Dos mitades:
//   1. VERIFICACIÓN. Que una llave se reconozca por su hash, que una revocada
//      deje de servir en el request siguiente, y que un token inventado no
//      abra nada.
//   2. ALCANCE. Cada restricción de una llave `ingest`, una por prueba, porque
//      cada una responde a una forma distinta de hacer daño y todas tienen que
//      seguir en pie por separado.
//
// Todos los nombres de este archivo son sintéticos: no describen a nadie.
const test = require('node:test');
const assert = require('node:assert');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { generateApiKey, hashApiKey, apiKeyPrefix, INGEST_WRITES_PER_HOUR } = require('../src/routes/api');

const LLAVE_OPERACION = 'llave-de-operacion-de-prueba';

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    store: app.locals.store
  };
}

// Emite una llave de verdad: se genera, se hashea y se guarda igual que lo hace
// scripts/api-key.js. Devuelve la llave EN CLARO, que es lo único que la app no
// guarda en ningún lado.
async function emitir(store, { scope, label = 'alias-de-prueba' }) {
  const llave = generateApiKey();
  const fila = await store.insertApiKey({
    label,
    keyHash: hashApiKey(llave),
    keyPrefix: apiKeyPrefix(llave),
    scope
  });
  return { llave, fila };
}

function push(base, llave, body) {
  return fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llave}` },
    body: JSON.stringify(body)
  });
}

// El mismo push SIN cabecera de autorización: es el que decide si el modo
// abierto de desarrollo está abierto o cerrado.
function pushSinCabecera(base, body) {
  return fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// La llave de operación se pone SIEMPRE en estas pruebas: sin ella el API cae al
// modo abierto de desarrollo y no se estaría probando ninguna puerta.
function conLlaveDeOperacion(t, app) {
  env.API_KEY = LLAVE_OPERACION;
  t.after(() => {
    app.server.close();
    env.API_KEY = '';
  });
}

// ---------------------------------------------------------------------------
// 1. Verificación
// ---------------------------------------------------------------------------

test('una llave emitida se reconoce por su hash, y la llave en claro no queda guardada', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave, fila } = await emitir(app.store, { scope: 'ingest' });

  const res = await push(app.base, llave, { name: 'Ana Prueba Uno', status: 'missing' });
  assert.equal(res.status, 201);

  // Lo único guardado es el hash y el prefijo. Si la llave en claro apareciera
  // en la fila, todo el diseño (mostrarla una vez y no poder recuperarla)
  // sería decorativo.
  const guardadas = await app.store.apiKeysList();
  const guardada = guardadas.find((k) => k.id === fila.id);
  assert.equal(guardada.key_prefix, llave.slice(0, 8));
  assert.ok(!JSON.stringify(guardada).includes(llave), 'la llave en claro no puede quedar guardada');
  assert.equal(guardada.key_hash, undefined, 'el listado no expone ni el hash');
});

test('una llave inexistente no abre nada, ni siquiera con API_KEY sin configurar', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());
  // A propósito SIN env.API_KEY: es el modo abierto de desarrollo. Presentar un
  // token que no existe tiene que cerrar igual — si cayera al modo abierto,
  // equivocarse de llave ABRIRÍA en vez de cerrar.
  const res = await push(app.base, 'llave-que-nunca-se-emitio', {
    name: 'Ana Prueba Dos',
    status: 'missing'
  });
  assert.equal(res.status, 401);
});

test('revocar una llave la corta en el request siguiente, sin caché de por medio', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave, fila } = await emitir(app.store, { scope: 'ingest' });

  assert.equal((await push(app.base, llave, { name: 'Ana Prueba Tres', status: 'missing' })).status, 201);

  await app.store.revokeApiKey(fila.id, new Date().toISOString());

  const despues = await push(app.base, llave, { name: 'Ana Prueba Cuatro', status: 'missing' });
  assert.equal(despues.status, 401);
  // El motivo se distingue a propósito: quien la usa es un voluntario, y "te la
  // revocamos" y "la escribiste mal" llevan a acciones distintas.
  assert.match((await despues.json()).error, /revocada/i);
});

test('la fila de una llave revocada NO se borra: el rastro de qué escribió tiene que quedar', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { fila } = await emitir(app.store, { scope: 'ingest' });

  await app.store.revokeApiKey(fila.id, new Date().toISOString());
  const filas = await app.store.apiKeysList();
  assert.equal(filas.length, 1);
  assert.ok(filas[0].revoked_at, 'la fila queda, marcada como revocada');

  // Revocar dos veces no reescribe la primera fecha ni falla.
  assert.equal(await app.store.revokeApiKey(fila.id, new Date().toISOString()), undefined);
});

test('API_KEY sigue siendo una llave de operación: puede lo que siempre pudo', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);

  // Un estado que una llave de ingesta NO puede escribir, por la ruta de
  // siempre: la compatibilidad con el barrido y el cron es lo que evita que este
  // cambio rompa a los consumidores que ya existen.
  const res = await push(app.base, LLAVE_OPERACION, { name: 'Ana Prueba Cinco', status: 'safe' });
  assert.equal(res.status, 201);

  // Y una ruta de solo operación.
  const reindex = await fetch(`${app.base}/api/reindex`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${LLAVE_OPERACION}` }
  });
  assert.equal(reindex.status, 200);
});

test('anota el último uso de la llave', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave, fila } = await emitir(app.store, { scope: 'ingest' });

  const antes = (await app.store.apiKeysList()).find((k) => k.id === fila.id);
  assert.equal(antes.last_used_at, null);

  await push(app.base, llave, { name: 'Ana Prueba Seis', status: 'missing' });

  const despues = (await app.store.apiKeysList()).find((k) => k.id === fila.id);
  assert.ok(despues.last_used_at, 'last_used_at debía quedar puesto');
  // TEXTO ISO en los dos motores, no un Date: es la diferencia que se cuela en
  // producción y no en las pruebas.
  assert.equal(typeof despues.last_used_at, 'string');
});

// ---------------------------------------------------------------------------
// 2. El alcance de una llave `ingest`
// ---------------------------------------------------------------------------

test('ingest: una sola ruta — no borra, no suscribe, no reindexa, no manda correo, no lee cifras', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });
  const auth = { Authorization: `Bearer ${llave}` };

  const { person } = await app.store.findOrCreatePerson('Ana Prueba Siete');

  const prohibidas = [
    ['DELETE', `/api/people/${person.id}`, undefined],
    ['POST', `/api/people/${person.id}/subscriptions`, { channel: 'email', address: 'nadie@ejemplo.com' }],
    ['POST', '/api/reindex', undefined],
    ['GET', '/api/match-stats', undefined],
    ['POST', '/api/diag/test-email', { email: 'nadie@ejemplo.com' }]
  ];

  for (const [method, ruta, body] of prohibidas) {
    const res = await fetch(`${app.base}${ruta}`, {
      method,
      headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth,
      body: body ? JSON.stringify(body) : undefined
    });
    assert.ok(
      res.status === 401 || res.status === 403,
      `${method} ${ruta} respondió ${res.status}: una llave de ingesta no debería poder tocarla`
    );
  }

  // Y la persona sigue ahí: ninguna de las de arriba surtió efecto.
  assert.ok(await app.store.getPerson(person.id));
});

test('ingest: missing y unknown entran tal cual', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });

  for (const status of ['missing', 'unknown']) {
    const res = await push(app.base, llave, { name: `Ana Prueba ${status}`, status });
    assert.equal(res.status, 201, `${status} debería entrar`);
    const body = await res.json();
    assert.equal(body.update.status, status);
    assert.equal(body.status_coercion, undefined, 'sin coerción no debe aparecer el campo');
  }
});

// La prueba más importante de este archivo, y la que evita el peor bug posible
// del alcance: buena parte de lo que un voluntario encuentra en fuentes públicas
// es gente que YA APARECIÓ. Si eso se guardara como 'missing', una nota que dice
// "fue encontrada sana y salva" publicaría que la persona sigue desaparecida.
test('ingest: safe, deceased e injured se ESTACIONAN en unknown — nunca en missing', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });

  for (const status of ['safe', 'deceased', 'injured']) {
    const res = await push(app.base, llave, { name: `Ana Prueba ${status}`, status });
    assert.equal(res.status, 201, `${status} no se rechaza: se perdería el hallazgo`);
    const body = await res.json();
    assert.equal(
      body.update.status,
      'unknown',
      `${status} debe quedar en unknown, el estado de estacionamiento que ya usa el adaptador del registro público`
    );
    assert.notEqual(body.update.status, 'missing');
    // Y NUNCA en silencio.
    assert.equal(body.status_coercion.requested, status);
    assert.equal(body.status_coercion.stored, 'unknown');
    assert.match(body.status_coercion.reason, /revise una persona/i);
  }

  // La misma llave sí puede afirmar 'missing' cuando el hallazgo dice eso: la
  // coerción no es un candado sobre todo, es un desvío para lo que no se afirma.
  const desaparecida = await push(app.base, llave, { name: 'Ana Prueba Dieciocho', status: 'missing' });
  assert.equal((await desaparecida.json()).update.status, 'missing');
});

test('la llave de operación NO sufre coerción: sigue pudiendo afirmar cualquier estado', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);

  for (const status of ['safe', 'deceased', 'injured']) {
    const res = await push(app.base, LLAVE_OPERACION, { name: `Ana Operacion ${status}`, status });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.update.status, status, 'el barrido y el cron dependen de que esto no cambie');
    assert.equal(body.status_coercion, undefined);
  }
});

test('ingest: no puede pisar el external_id de otra llave', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const primera = await emitir(app.store, { scope: 'ingest', label: 'alias-uno' });
  const segunda = await emitir(app.store, { scope: 'ingest', label: 'alias-dos' });
  const EXT = 'https://fuente-publica.ejemplo/ficha/123';

  const creada = await push(app.base, primera.llave, {
    name: 'Ana Prueba Ocho',
    status: 'missing',
    external_id: EXT
  });
  assert.equal(creada.status, 201);
  const personId = (await creada.json()).person_id;

  // La dueña sí puede corregir la suya — es el caso que la restricción NO debe
  // romper: sin esto una llave no podría ni arreglar su propio error.
  const propia = await push(app.base, primera.llave, {
    name: 'Ana Prueba Ocho',
    status: 'missing',
    external_id: EXT,
    location: 'corregido'
  });
  assert.equal(propia.status, 201);

  // La otra no.
  const ajena = await push(app.base, segunda.llave, {
    name: 'Otro Nombre Prueba',
    status: 'missing',
    external_id: EXT
  });
  assert.equal(ajena.status, 403);
  assert.match((await ajena.json()).error, /no cre/i);

  // Y no cambió nada: el estado de la ficha es el que dejó su dueña.
  const ultima = await app.store.getLatestUpdate(personId);
  assert.equal(ultima.location, 'corregido');
});

test('ingest: no puede pisar una ficha que escribió la llave de operación (falla cerrado)', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });
  const EXT = 'https://fuente-publica.ejemplo/ficha/456';

  // El barrido de la ingesta empuja con la llave de entorno, que no tiene fila
  // en api_keys: su bitácora queda con api_key_id nulo. "Sin dueño demostrable"
  // tiene que leerse como "no es tuya", no como "es de todos".
  const delOperador = await push(app.base, LLAVE_OPERACION, {
    name: 'Ana Prueba Nueve',
    status: 'missing',
    external_id: EXT
  });
  assert.equal(delOperador.status, 201);

  const intento = await push(app.base, llave, {
    name: 'Ana Prueba Nueve',
    status: 'missing',
    external_id: EXT
  });
  assert.equal(intento.status, 403);
});

test('ingest: fuerza source=aggregator, ignore lo que diga el cuerpo', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });

  // 'web' significa "una persona en el sitio". Una llave programática no puede
  // declararse humana: de eso dependen las cifras de operación y el filtro de
  // seguridad de latestUpdate.
  const res = await push(app.base, llave, {
    name: 'Ana Prueba Diez',
    status: 'missing',
    source: 'web'
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).update.source, 'aggregator');
});

test('ingest: descarta reporter y contact — no puede plantar un contacto de familia', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });

  const res = await push(app.base, llave, {
    name: 'Ana Prueba Once',
    status: 'missing',
    reporter: 'quien-sea',
    // Un número plantado acá es lo que la ficha le muestra a un rescatista como
    // "contacto de la familia". En zona de desastre eso es materia de extorsión.
    contact: '+570000000000'
  });
  assert.equal(res.status, 201);
  const { update } = await res.json();
  assert.equal(update.reporter, null);
  assert.equal(update.contact, null);
});

test('ingest: una escritura suya NO le manda un aviso a nadie', async (t) => {
  // El espía se instala ANTES de crear la app, y eso no es un detalle de estilo:
  // createReportAdmission captura notifyModule.notifySubscribers como valor por
  // omisión de su parámetro, o sea en el momento en que se construye el router.
  // Parcheado después, la app sigue llamando a la función original y la prueba
  // pasaría creyendo que observó algo.
  const avisados = [];
  const notify = require('../src/notify');
  const original = notify.notifySubscribers;
  notify.notifySubscribers = async (store, person, update, opts) => {
    avisados.push({ personId: person.id, status: update.status, opts });
    return 0;
  };
  t.after(() => {
    notify.notifySubscribers = original;
  });

  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });

  // Alguien sigue a esta persona y está esperando noticias.
  const { person } = await app.store.findOrCreatePerson('Ana Prueba Doce');
  await app.store.subscribe(person.id, 'email', 'familia@ejemplo.com', { verified: true });

  const res = await push(app.base, llave, { name: 'Ana Prueba Doce', status: 'missing' });
  assert.equal(res.status, 201);
  assert.deepEqual(avisados, [], 'una llave de ingesta no dispara notifySubscribers');

  // Contraprueba: por la llave de operación el aviso SÍ sale. Sin esto, la
  // afirmación de arriba pasaría igual si notifySubscribers estuviera roto o si
  // el espía no estuviera enganchado.
  const porOperacion = await push(app.base, LLAVE_OPERACION, {
    name: 'Ana Prueba Doce',
    status: 'missing'
  });
  assert.equal(porOperacion.status, 201);
  assert.equal(avisados.length, 1, 'la llave de operación sí notifica, como siempre');
  assert.equal(avisados[0].personId, person.id);
});

test('ingest: tiene techo de escrituras por hora', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave, fila } = await emitir(app.store, { scope: 'ingest' });

  // Se llena la bitácora hasta el techo sin pasar por la ruta: escribir 120
  // fichas de verdad en una prueba es lento y no prueba nada más. La ficha a la
  // que se cuelgan las filas es sintética.
  const { person } = await app.store.findOrCreatePerson('Ana Prueba Trece');
  for (let i = 0; i < INGEST_WRITES_PER_HOUR; i++) {
    await app.store.insertApiWriteLog({
      personId: person.id,
      updateId: null,
      apiKeyId: fila.id,
      action: 'crear'
    });
  }

  const res = await push(app.base, llave, { name: 'Ana Prueba Catorce', status: 'missing' });
  assert.equal(res.status, 429);

  // La llave de operación no tiene techo: el barrido empuja miles de fichas.
  const operacion = await push(app.base, LLAVE_OPERACION, {
    name: 'Ana Prueba Quince',
    status: 'missing'
  });
  assert.equal(operacion.status, 201);
});

test('cada escritura del API queda en la bitácora, con la llave que la hizo', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave, fila } = await emitir(app.store, { scope: 'ingest' });

  const creada = await push(app.base, llave, { name: 'Ana Prueba Dieciseis', status: 'missing' });
  assert.equal(creada.status, 201);
  const { person_id: personId } = await creada.json();

  // Contar por llave es exactamente lo que hace falta para poder limpiar
  // después de revocar una: "qué escribió esta llave".
  const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(await app.store.countApiWrites(fila.id, desde), 1);

  // Y una segunda escritura sobre la misma persona queda como 'actualizar'.
  await push(app.base, llave, { name: 'Ana Prueba Dieciseis', status: 'unknown' });
  assert.equal(await app.store.countApiWrites(fila.id, desde), 2);

  // La bitácora hereda la retención del esquema: se va con la persona.
  await app.store.deletePerson(personId);
  assert.equal(await app.store.countApiWrites(fila.id, desde), 0);
});

// ---------------------------------------------------------------------------
// 3. Lo que la respuesta NO puede devolver, y la puerta que no puede quedar
//    abierta
// ---------------------------------------------------------------------------

test('el 201 de una escritura NUNCA devuelve el contacto de la familia, ni con llave de operación', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);

  const TELEFONO = '+573001234567';
  const res = await push(app.base, LLAVE_OPERACION, {
    name: 'Ana Prueba Diecisiete',
    status: 'missing',
    reporter: 'Quien Reporta Prueba',
    contact: TELEFONO
  });
  assert.equal(res.status, 201);

  const body = await res.json();
  // El dato SÍ se guardó: la ficha lo necesita para que un rescatista pueda
  // llegar a la familia. Lo que no puede es salir en la respuesta.
  const guardado = await app.store.getLatestUpdate(body.person_id);
  assert.equal(guardado.contact, TELEFONO, 'el contacto sí se guarda');

  const crudo = JSON.stringify(body);
  assert.ok(!crudo.includes(TELEFONO), 'el teléfono de la familia no puede viajar en la respuesta');
  assert.equal(body.update.contact, undefined, 'la respuesta no lleva el campo contact');
  assert.equal(body.update.reporter, undefined, 'reporter sale enmascarado, nunca crudo');
  assert.ok(!crudo.includes('Quien Reporta Prueba'), 'ni el nombre de quien reporta, sin enmascarar');
  // Y lo que sí tiene que seguir saliendo, porque de eso dependen el barrido y
  // las pruebas que ya existen.
  assert.equal(body.update.status, 'missing');
  assert.ok(body.update.id);
});

test('emitir la primera llave CIERRA el modo abierto de desarrollo, en el request siguiente', async (t) => {
  const app = await startApp();
  // A propósito sin env.API_KEY: es el escenario que el modo abierto existe
  // para servir, y el mismo en el que se volvía peligroso.
  t.after(() => app.server.close());

  // Sin ninguna llave emitida sigue abierto: desarrollar en local sin
  // credenciales no se rompe.
  const abierto = await pushSinCabecera(app.base, { name: 'Ana Prueba Dieciocho', status: 'missing' });
  assert.equal(abierto.status, 201, 'sin llaves emitidas, el modo abierto de desarrollo sigue igual');

  // Se emite una llave ACOTADA. Antes esto no cambiaba nada acá, y ese era el
  // agujero: la llave más limitada que existe le daba, de hecho, alcance de
  // operación completo a cualquier anónimo del mismo despliegue.
  await emitir(app.store, { scope: 'ingest' });

  const cerrado = await pushSinCabecera(app.base, { name: 'Ana Prueba Diecinueve', status: 'missing' });
  assert.equal(cerrado.status, 401, 'con una llave emitida, una petición sin cabecera no puede pasar');
});

test('si la bitácora no se puede escribir, una llave de ingesta falla — no sigue sin sus dos controles', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave } = await emitir(app.store, { scope: 'ingest' });

  // La bitácora se cae. Es la tabla sobre la que se cuentan el techo por hora y
  // la propiedad de las fichas, así que seguir de largo dejaría a esta llave sin
  // ninguno de los dos y respondiendo 201 como si nada.
  const original = app.store.insertApiWriteLog;
  app.store.insertApiWriteLog = async () => {
    throw new Error('la bitácora está caída');
  };
  t.after(() => {
    app.store.insertApiWriteLog = original;
  });

  const res = await push(app.base, llave, { name: 'Ana Prueba Veinte', status: 'missing' });
  assert.equal(res.status, 503);
  const body = await res.json();
  // El reporte NO se pierde: ya está guardado, y la respuesta dice con qué
  // persona quedó para que quien empuja pueda reconciliar.
  assert.ok(body.person_id, 'el reporte quedó guardado y la respuesta lo dice');
  assert.ok(await app.store.getPerson(body.person_id));

  // Para la llave de operación se conserva la regla de las otras bitácoras: no
  // sostiene ningún control suyo, así que un fallo no puede tumbarle un reporte.
  const operacion = await push(app.base, LLAVE_OPERACION, {
    name: 'Ana Prueba Veintiuno',
    status: 'missing'
  });
  assert.equal(operacion.status, 201, 'una bitácora caída nunca tumba el reporte de un operador');
});

test('la ficha que quedó sin dueño por un fallo de bitácora no la puede reclamar NADIE, ni quien la creó', async (t) => {
  const app = await startApp();
  conLlaveDeOperacion(t, app);
  const { llave: llaveA } = await emitir(app.store, { scope: 'ingest', label: 'alias-a' });
  const { llave: llaveB } = await emitir(app.store, { scope: 'ingest', label: 'alias-b' });
  const EXTERNAL_ID = 'https://fuente.example/ficha/veintidos';

  // La llave A crea la ficha con la bitácora caída: queda guardada, pero sin la
  // fila que prueba de quién es.
  const original = app.store.insertApiWriteLog;
  app.store.insertApiWriteLog = async () => {
    throw new Error('la bitácora está caída');
  };
  const primera = await push(app.base, llaveA, {
    name: 'Ana Prueba Veintidos',
    status: 'missing',
    external_id: EXTERNAL_ID
  });
  assert.equal(primera.status, 503);
  app.store.insertApiWriteLog = original;

  // Una ficha sin dueño demostrable NO es una ficha libre. Esta es la mitad que
  // importa: otra llave de ingesta no puede quedarse con ella, que es
  // exactamente lo que el alcance existe para impedir.
  const ajena = await push(app.base, llaveB, {
    name: 'Ana Prueba Veintidos',
    status: 'missing',
    external_id: EXTERNAL_ID
  });
  assert.equal(ajena.status, 403, 'una ficha sin dueño no queda disponible para cualquiera');

  // Y la otra mitad, que es el precio de la primera y por eso está escrita en la
  // guía: ni siquiera quien la creó puede reintentar. Sin fila en la bitácora no
  // hay forma de demostrar que es suya, así que el reintento también se rechaza
  // y la ficha la tiene que resolver un operador.
  const propia = await push(app.base, llaveA, {
    name: 'Ana Prueba Veintidos',
    status: 'missing',
    external_id: EXTERNAL_ID
  });
  assert.equal(propia.status, 403, 'reintentar el 503 NO es idempotente: la guía no puede prometerlo');

  // El operador sí puede, porque no está sujeto a la regla de propiedad: es la
  // salida de la que habla la guía.
  const operador = await push(app.base, LLAVE_OPERACION, {
    name: 'Ana Prueba Veintidos',
    status: 'missing',
    external_id: EXTERNAL_ID
  });
  assert.equal(operador.status, 201, 'un operador puede resolver la ficha que quedó trabada');
});
