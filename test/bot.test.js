const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { handleInbound, parseMessage } = require('../src/bot');

async function freshStore() {
  return createStore(await createSqliteAdapter(':memory:'));
}

test('parseMessage understands report with note and location', () => {
  const p = parseMessage('BIEN Juan Pérez: hablé con él @ albergue San José');
  assert.equal(p.intent, 'report');
  assert.equal(p.status, 'safe');
  assert.equal(p.name, 'Juan Pérez');
  assert.equal(p.note, 'hablé con él');
  assert.equal(p.location, 'albergue San José');
});

// #118: un texto sin comando ya no se convierte en búsqueda por nombre.
test('bare text without a command is not a search', () => {
  const p = parseMessage('Juan Pérez');
  assert.equal(p.intent, 'unrecognized');
  // La otra mitad del arreglo: del fallback no sale ningún nombre. `name` era
  // el campo que se interpolaba en la respuesta, y por ahí se ecoaba la frase
  // de la persona de vuelta.
  assert.ok(!p.name, 'del fallback no puede salir un nombre que alguien interpole');
});

// Las dos frases que motivaron volver estricto el SÍ (ver ANSWERS en src/bot.js).
// Ya no confirman un rescate; acá se fija además que tampoco caen en la otra
// trampa —convertirse en una búsqueda por su texto entero—, que es lo que las
// dejaba volver como "No encontré reportes sobre «Claro que no es ella»".
test('las frases que parecen un SÍ tampoco disparan una búsqueda (#118)', () => {
  for (const frase of ['Claro que no es ella', 'Si la veo te aviso']) {
    const p = parseMessage(frase);
    assert.equal(p.intent, 'unrecognized', `"${frase}" no es un comando`);
    assert.ok(!p.name, `"${frase}" no puede convertirse en un nombre a buscar`);
  }
});

test('free text never touches the store and is not echoed back (#118)', async () => {
  const store = await freshStore();
  let searched = false;
  const spied = new Proxy(store, {
    get(target, prop) {
      if (prop === 'searchPeople') {
        return (...args) => {
          searched = true;
          return target.searchPeople(...args);
        };
      }
      return target[prop];
    }
  });
  const phrase =
    'La plataforma me mostró una coincidencia alta pero no aparecen datos de quien la busca, qué hago';
  const reply = await handleInbound(spied, {
    channel: 'whatsapp',
    from: '573009998877',
    text: phrase
  });
  assert.equal(searched, false, 'free text must never call searchPeople');
  assert.ok(!reply.includes(phrase), 'the reply must not echo the user phrase');
  assert.ok(!/No encontré reportes/.test(reply), 'the reply must not look like a search result');
  assert.match(reply, /BUSCAR/);
  assert.match(reply, /AYUDA/);
});

test('explicit BUSCAR keyword still searches (#118)', async () => {
  const store = await freshStore();
  await handleInbound(store, { channel: 'whatsapp', from: '1', text: 'BIEN Persona Prueba Uno' });
  const r = await handleInbound(store, { channel: 'whatsapp', from: '2', text: 'BUSCAR Persona Prueba Uno' });
  assert.match(r, /Persona Prueba Uno/);
});

// BAJA TODO es la salida de emergencia del canal: es lo que se le ofrece a
// alguien a quien le estamos escribiendo por error. Pasa por `parsed.name`, el
// mismo campo que #118 vacía en el fallback, así que roza la condición tocada y
// no tenía prueba propia en ningún archivo.
test('BAJA TODO sigue cancelando todas las suscripciones (#118)', async () => {
  const store = await freshStore();
  const phone = '573004445566';
  await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'SUSCRIBIR Ana Prueba Uno' });
  await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'SUSCRIBIR Beto Prueba Dos' });
  const r = await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'BAJA TODO' });
  assert.match(r, /cancelé tus 2 suscripciones/);
  for (const nombre of ['ana prueba uno', 'beto prueba dos']) {
    const [persona] = await store.searchPeople(nombre);
    assert.equal((await store.getSubscriptions(persona.id)).length, 0);
  }
});

// Una foto llega con su leyenda como texto. Si la leyenda no es un comando, la
// foto no se indexa a espaldas de quien la mandó: se le contesta el acuse y se
// le dice con qué palabra reenviarla. Que el rostro NO entre al índice es lo
// que se está fijando acá — es una foto de una persona real que nadie pidió
// guardar.
test('una foto con leyenda de texto libre no indexa el rostro (#118)', async () => {
  const store = await freshStore();
  let tocado = false;
  const matcher = {
    enabled: true,
    async indexFace() {
      tocado = true;
      return { faceId: 'cara-de-prueba', geometry: null };
    },
    async detectFace() {
      tocado = true;
      return null;
    },
    async searchByImage() {
      tocado = true;
      return [];
    }
  };
  const leyenda = 'la vi cerca del albergue pero no sé cómo se llama';
  const r = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573007778899',
    text: leyenda,
    photo: { bytes: Buffer.from('jpeg-de-prueba'), contentType: 'image/jpeg' },
    matcher
  });
  assert.equal(tocado, false, 'una leyenda sin comando no puede indexar un rostro');
  assert.ok(!r.includes(leyenda), 'la respuesta no ecoa la leyenda');
  assert.match(r, /BUSCAR/);
});

test('report then fuzzy find via WhatsApp flow', async () => {
  const store = await freshStore();
  const r1 = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573001234567',
    text: 'BIEN Juan Carlos Pérez Gómez: está en el albergue'
  });
  assert.match(r1, /Registrado/);

  // Different speller, missing middle names, accent-free
  const r2 = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573007654321',
    text: 'BUSCAR jaun peres'
  });
  assert.match(r2, /Juan Carlos Pérez Gómez/);
  assert.match(r2, /A SALVO/);
});

test('reporting a confidently-matching name merges into the same person', async () => {
  const store = await freshStore();
  await handleInbound(store, { channel: 'whatsapp', from: '1', text: 'BIEN José Pérez Gómez' });
  await handleInbound(store, { channel: 'whatsapp', from: '2', text: 'HERIDO Jose Perez Gomez' });
  const matches = await store.searchPeople('jose perez gomez');
  assert.equal(matches.length, 1);
  const updates = await store.getUpdates(matches[0].id);
  assert.equal(updates.length, 2);
});

test('subscribe registers the sender phone; unsubscribe removes it', async () => {
  const store = await freshStore();
  const phone = '573001112233';
  const r = await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'SUSCRIBIR Ana María Ruiz' });
  assert.match(r, /Te avisaré a este número/);
  const [person] = await store.searchPeople('ana maria ruiz');
  const subs = await store.getSubscriptions(person.id);
  assert.deepEqual(
    subs.map((s) => [s.channel, s.address]),
    [['whatsapp', phone]]
  );

  const r2 = await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'BAJA Ana Maria Ruiz' });
  assert.match(r2, /ya no recibirás avisos/);
  assert.equal((await store.getSubscriptions(person.id)).length, 0);
});

// #78: the bot answers "where is this person" from store.getLatestUpdate,
// which is the SAME "current status" invariant the home page's missing/
// reunited lists use. Filtering the aggregator-safe noise only from the home
// queries and not from here would have a family texting the bot and being
// told "A SALVO" from a public-registry sync, while the site's own listing
// still (correctly) shows them as missing.
test('BUSCAR does not report someone as found from a public-registry sync alone', async () => {
  const store = await freshStore();
  const { person } = await store.findOrCreatePerson('Camilo Andrade Ríos');
  await store.addUpdate(person.id, { status: 'missing', source: 'web', location: 'Bosa' });
  await store.addUpdate(person.id, { status: 'safe', source: 'aggregator', message: 'Localizada' });

  const r = await handleInbound(store, { channel: 'whatsapp', from: '573009998877', text: 'BUSCAR Camilo Andrade' });
  assert.match(r, /DESAPARECID/i, 'la fila del agregador no puede pisar el reporte real de desaparición');
  assert.doesNotMatch(r, /A SALVO/);

  // A REAL confirmation must still flip it.
  await store.addUpdate(person.id, { status: 'safe', source: 'web', message: 'Confirmado por la familia' });
  const r2 = await handleInbound(store, { channel: 'whatsapp', from: '573009998877', text: 'BUSCAR Camilo Andrade' });
  assert.match(r2, /A SALVO/);
});

test('help for unknown/empty messages', async () => {
  const store = await freshStore();
  const r = await handleInbound(store, { channel: 'whatsapp', from: '99', text: 'ayuda' });
  assert.match(r, /Comandos/);
});

// #156: cuatro ramas devolvían su respuesta sin mirar `photo`, y la foto se
// perdía en silencio — sin avisarlo y sin que ninguna función del matcher se
// llamara. Cada prueba de acá abajo afirma la causa (el matcher no se toca)
// y no solo el texto: un mensaje que dijera "recibí tu foto" sin agregar el
// aviso de #156 habría pasado una prueba que solo mirara el texto.
function matcherEspia() {
  const llamadas = { indexFace: false, detectFace: false, searchByImage: false };
  return {
    espia: llamadas,
    matcher: {
      enabled: true,
      async indexFace() {
        llamadas.indexFace = true;
        return { faceId: 'cara-de-prueba', geometry: null };
      },
      async detectFace() {
        llamadas.detectFace = true;
        return null;
      },
      async searchByImage() {
        llamadas.searchByImage = true;
        return [];
      }
    }
  };
}

const FOTO_DE_PRUEBA = { bytes: Buffer.from('jpeg-de-prueba'), contentType: 'image/jpeg' };

test('una foto en un mensaje no reconocido no se indexa y se avisa (#156)', async () => {
  const store = await freshStore();
  const { matcher, espia } = matcherEspia();
  const r = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573001112200',
    text: 'no sé qué comando usar pero le mando la foto igual',
    photo: FOTO_DE_PRUEBA,
    matcher
  });
  assert.deepEqual(espia, { indexFace: false, detectFace: false, searchByImage: false });
  assert.match(r, /Recibí una foto, pero con este mensaje no puedo usarla, así que no la guardé/);
  // El aviso tiene que ofrecerle a esta persona los dos caminos que sirven
  // para lo que está haciendo: buscar (SUSCRIBIR) o reportar una
  // desaparición. Proponerle solo BIEN la empujaba a registrar como a salvo
  // a alguien a quien no encuentra, que es el dato que hace que nadie la
  // siga buscando.
  assert.match(r, /• SUSCRIBIR <nombre> — si estás buscando a esa persona/);
  assert.match(r, /• DESAPARECIDO <nombre> — si no sabes dónde está/);
  // Y DESAPARECIDO va en su propia viñeta: agruparlo con BIEN/HERIDO bajo
  // "si la encontraste" describe la situación contraria a la que reporta.
  assert.match(r, /• BIEN \/ HERIDO <nombre> — si la encontraste/);
  assert.doesNotMatch(r, /DESAPARECIDO <nombre> — si la encontraste/);
});

test('una foto con AYUDA (o mensaje vacío) no se indexa y se avisa (#156)', async () => {
  const store = await freshStore();
  const { matcher, espia } = matcherEspia();
  const r = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573001112201',
    text: 'ayuda',
    photo: FOTO_DE_PRUEBA,
    matcher
  });
  assert.deepEqual(espia, { indexFace: false, detectFace: false, searchByImage: false });
  assert.match(r, /Comandos/);
  assert.match(r, /Recibí una foto, pero con este mensaje no puedo usarla, así que no la guardé/);
});

test('una foto con BUSCAR sin resultados no se indexa y se avisa (#156)', async () => {
  const store = await freshStore();
  const { matcher, espia } = matcherEspia();
  const r = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573001112202',
    text: 'BUSCAR Nadie Con Este Nombre',
    photo: FOTO_DE_PRUEBA,
    matcher
  });
  assert.deepEqual(espia, { indexFace: false, detectFace: false, searchByImage: false });
  assert.match(r, /No encontré reportes/);
  assert.match(r, /Recibí una foto, pero con este mensaje no puedo usarla, así que no la guardé/);
});

test('una foto con BAJA no se indexa y se avisa (#156)', async () => {
  const store = await freshStore();
  const phone = '573001112203';
  await handleInbound(store, { channel: 'whatsapp', from: phone, text: 'SUSCRIBIR Carla Prueba Tres' });

  const { matcher, espia } = matcherEspia();
  const r = await handleInbound(store, {
    channel: 'whatsapp',
    from: phone,
    text: 'BAJA Carla Prueba Tres',
    photo: FOTO_DE_PRUEBA,
    matcher
  });
  assert.deepEqual(espia, { indexFace: false, detectFace: false, searchByImage: false });
  assert.match(r, /ya no recibirás avisos/);
  assert.match(r, /Recibí una foto, pero con este mensaje no puedo usarla, así que no la guardé/);
});

// Control: report y subscribe SÍ procesan la foto (ya lo hacían antes de
// #156) y por lo tanto no deben llevar el aviso de "no la usé". Necesita una
// imagen de verdad (no el buffer de relleno de arriba): con leyenda de
// comando el flujo SÍ intenta decodificarla para la miniatura antes de
// indexar, y un buffer ilegible se guarda sin indexar por una razón aparte —
// eso rompería esta prueba sin decir nada sobre #156.
async function fotoValida() {
  return sharp({ create: { width: 200, height: 250, channels: 3, background: { r: 80, g: 60, b: 100 } } })
    .jpeg()
    .toBuffer();
}

test('una foto con BIEN sí se indexa y no lleva el aviso de #156', async () => {
  const store = await freshStore();
  const { matcher, espia } = matcherEspia();
  const r = await handleInbound(store, {
    channel: 'whatsapp',
    from: '573001112204',
    text: 'BIEN Dario Prueba Cuatro: está bien',
    photo: { bytes: await fotoValida(), contentType: 'image/jpeg' },
    matcher
  });
  assert.equal(espia.indexFace, true, 'un reporte con foto sí debe indexar la cara');
  assert.doesNotMatch(r, /Recibí una foto, pero con este mensaje no puedo usarla, así que no la guardé/);
});
