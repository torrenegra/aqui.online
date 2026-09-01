// El rescatista y sus canales: cuándo un aviso se retiene, cuándo se releva y
// cuándo —solo cuándo— sale con el contacto de una familia adentro.
//
// Las reglas que se fijan acá:
//
//   1. Una suscripción SIN verificar no hace que el aviso se pierda. Sí bloquea
//      el envío directo, que es el único camino donde el mensaje sale hacia una
//      dirección que nadie comprobó; en modo relevo el aviso llega al buzón del
//      operador, marcado, para que una persona decida.
//   2. **Por WhatsApp NUNCA sale el contacto de una familia.** Ni antes ni
//      después de que respondan que sí, ni en modo directo. Lo único que sale
//      tras un SÍ es la ficha del registro público de origen.
//   3. Las plantillas aprobadas por Meta son el contrato: sus nombres, su
//      idioma y sus parámetros no los decide este código.
//
// Todos los nombres, correos, teléfonos y fichas de este archivo son
// inventados.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const env = require('../src/env');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { fakeSendgrid, fakeWhatsApp } = require('./helpers');

const BUZON = 'operacion@ejemplo.com';
// Los nombres reales aprobados por Meta: el código los trae por omisión, así
// que las pruebas verifican lo que de verdad va a salir a producción.
const PLANTILLA_PREGUNTA = 'confirmacion_rescatista_encontrados';
const PLANTILLA_FICHA = 'ficha_fuente_rescatista_encontrados';
const LOCALE = 'es_CO';
// El POST del webhook exige la credencial del relevo: Meta no le habla directo,
// le entrega a un relevo que verifica su firma y reenvía. Sin esta cabecera todo
// entrante responde 403, que es justo lo que debe pasar en producción.
const RELAY_SECRET = 'secreto-de-relevo-de-prueba';
process.env.WHATSAPP_RELAY_SECRET = RELAY_SECRET;
// Una ficha sintética con la forma exacta que exige el código.
const FICHA = 'https://colombiatebusca.com/?person=00000000-0000-4000-8000-000000000001';
const FICHA_2 = 'https://colombiatebusca.com/?person=00000000-0000-4000-8000-000000000002';

const FAKE_GEOMETRY = {
  box: { l: 0.25, t: 0.1, w: 0.5, h: 0.6 },
  points: [{ t: 'nose', x: 0.5, y: 0.45 }],
  pose: { roll: 0, yaw: 0, pitch: 0 },
  confidence: 99.5
};

// Bytes idénticos = mismo rostro, así toda la cadena corre sin AWS.
function fakeMatcher() {
  const indexed = new Map();
  let n = 0;
  const key = (b) => b.toString('utf8');
  return {
    enabled: true,
    async indexFace(bytes) {
      const id = `face-${++n}`;
      if (!indexed.has(key(bytes))) indexed.set(key(bytes), []);
      indexed.get(key(bytes)).push(id);
      return { faceId: id, geometry: FAKE_GEOMETRY };
    },
    async detectFace() {
      return FAKE_GEOMETRY;
    },
    async searchByImage(bytes) {
      return (indexed.get(key(bytes)) || []).map((faceId) => ({ faceId, similarity: 97 }));
    }
  };
}

const jpegCache = new Map();
async function photoBytes(label) {
  if (!jpegCache.has(label)) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
    jpegCache.set(
      label,
      await sharp({
        create: { width: 400, height: 500, channels: 3, background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 } }
      })
        .jpeg()
        .toBuffer()
    );
  }
  return jpegCache.get(label);
}

async function startApp(matcher) {
  const app = await createApp(await createSqliteAdapter(':memory:'), matcher || fakeMatcher());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

async function rescate(base, { face, email, phone, searchOnly }) {
  const fd = new FormData();
  fd.set('photo', new File([await photoBytes(face)], 'r.jpg', { type: 'image/jpeg' }));
  if (email) fd.set('email', email);
  if (phone) fd.set('phone', phone);
  if (searchOnly) fd.set('solo_busqueda', '1');
  return fetch(`${base}/rescate`, { method: 'POST', body: fd });
}

async function reportar(base, { name, contact, face }) {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('location', 'Barrio San José');
  fd.set('contact', contact);
  fd.append('photos', new File([await photoBytes(face)], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

// Una ficha que llegó de un agregador y por lo tanto tiene registro de origen.
// El reporte por la web va DESPUÉS para que el contacto de la familia quede en
// el update más reciente, que es de donde lo lee el aviso.
async function fichaConOrigen(app, { name, contact, face, ficha }) {
  const { person } = await app.store.findOrCreatePerson(name);
  await app.store.addUpdate(person.id, {
    status: 'missing',
    source: 'aggregator',
    externalId: ficha
  });
  await reportar(app.base, { name, contact, face });
  return person;
}

// Simula un mensaje entrante de Meta.
async function inbound(base, { from, text, button }) {
  const msg = button
    ? { from, type: 'button', button: { text: button } }
    : { from, type: 'text', text: { body: text } };
  return fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': RELAY_SECRET },
    body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [msg] } }] }] })
  });
}

const to = (mail) => JSON.stringify(mail.body.personalizations);
const text = (mail) => mail.body.content[0].value;
const plantillas = (wa) => wa.received.map((m) => m.body).filter((b) => b.type === 'template');
// Todo lo que salió por WhatsApp, sin importar el tipo. Es sobre esto que se
// afirma que el contacto de una familia no está en ninguna parte.
const todoWhatsApp = (wa) => JSON.stringify(wa.received.map((m) => m.body));

// ------------------------------------------------------ el gate de verificación

test('una coincidencia contra una suscripción SIN verificar llega al relevo, no se descarta', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  // El rescatista deja su correo y NO confirma el enlace: queda sin verificar,
  // que es el estado de la enorme mayoría de las suscripciones reales.
  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });
  sg.received.length = 0;

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });

  assert.equal(sg.received.length, 1, 'el aviso tiene que existir: antes se perdía en silencio');
  const mail = sg.received[0];
  assert.match(to(mail), new RegExp(BUZON), 'va al buzón del operador');
  assert.doesNotMatch(to(mail), /rescatista@ejemplo\.com/, 'nunca a la dirección sin verificar');

  // Y el humano tiene que enterarse de que no está verificada: eso cambia lo
  // que decide hacer con el aviso.
  assert.match(mail.body.subject, /SIN verificar/);
  assert.match(text(mail), /NO está verificada/);
  assert.match(text(mail), /Contacto de quien la busca.*300 000 0000/);
});

test('esa misma suscripción sin verificar NUNCA produce un envío directo', async (t) => {
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
    delete process.env.AVISO_EMAIL;
  });

  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });
  sg.received.length = 0;

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });

  assert.equal(
    sg.received.length,
    0,
    'sin relevo y sin verificar no sale nada: el corte vive en el camino de envío'
  );
});

// ------------------------------------------------------------ el número tecleado

test('el WhatsApp del formulario queda con la forma que usa el bot, y sin verificar', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  await rescate(app.base, { face: 'a', phone: '300 123 4567' });
  await rescate(app.base, { face: 'b', phone: '+57 300 123 4567' });

  // Las dos formas de escribir el mismo teléfono tienen que aterrizar en la
  // misma dirección; si no, la baja y la deduplicación no lo vuelven a hallar.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573001234567');
  assert.equal(subs.length, 2, 'los dos rescates apuntan al mismo número normalizado');
  for (const s of subs) {
    assert.ok(!s.verified, 'un número tecleado no lo comprueba nadie: nace sin verificar');
  }
});

test('un número que no parece teléfono se ignora en silencio, sin trancar el formulario', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  await reportar(app.base, { name: 'Camila Prueba Rojas', contact: '300 111 2222', face: 'camila' });
  const res = await rescate(app.base, { face: 'camila', phone: 'no tengo, llámenme al fijo' });

  assert.equal(res.status, 200, 'el rescate no se puede caer por el formato de un campo opcional');
  assert.match(await res.text(), /Camila Prueba Rojas/, 'la coincidencia se muestra igual');
  assert.equal((await app.store.counts()).subscriptions, 0, 'no se guardó ninguna dirección inservible');
});

// ------------------------------------------------------ modo solo búsqueda

test('la casilla de solo búsqueda viene apagada y dice lo que cuesta antes de marcarla', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const html = await (await fetch(`${app.base}/rescate`)).text();
  assert.match(html, /name="solo_busqueda"/);
  // Apagada: sin `checked` en ninguna parte de esa casilla.
  assert.doesNotMatch(html, /name="solo_busqueda"[^>]*checked/);
  // Y el costo se lee ahí mismo, no después de haber consultado.
  assert.match(html, /no vamos a poder avisarte si alguien reporta a esta persona/i);
});

test('solo búsqueda: encuentra la coincidencia y no deja ancla, ni foto, ni firma indexada', async (t) => {
  const matcher = fakeMatcher();
  let indexadas = 0;
  const indexFace = matcher.indexFace.bind(matcher);
  matcher.indexFace = async (...args) => {
    indexadas++;
    return indexFace(...args);
  };
  const app = await startApp(matcher);
  t.after(() => app.server.close());

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const antes = await app.store.counts();
  indexadas = 0;

  const html = await (
    await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com', phone: '311 222 3344', searchOnly: true })
  ).text();

  // La consulta sirve: la coincidencia se ve y el contacto también.
  assert.match(html, /Rosa Elvira Prueba/);
  assert.match(html, /300 000 0000/);

  const despues = await app.store.counts();
  assert.equal(despues.people, antes.people, 'no se crea la persona ancla');
  assert.equal(despues.photos, antes.photos, 'no queda fila de foto');
  assert.equal(despues.subscriptions, 0, 'ni correo ni WhatsApp dejan suscripción');
  assert.equal(indexadas, 0, 'nada nuevo entra a la colección facial');
  // Y se lo decimos, para que nadie crea que quedó esperando un aviso.
  assert.match(html, /no vamos a poder avisarte/i);
});

test('solo búsqueda sin coincidencias dice que no quedó nada esperando', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const html = await (
    await rescate(app.base, { face: 'desconocido', email: 'rescatista@ejemplo.com', searchOnly: true })
  ).text();

  assert.match(html, /Nadie ha reportado a esta persona/);
  assert.match(html, /no vamos a poder avisarte/i);
  assert.doesNotMatch(html, /Te avisaremos/, 'no se puede prometer un aviso que no va a existir');
  assert.equal((await app.store.counts()).subscriptions, 0);
});

test('solo búsqueda no manda nada por WhatsApp ni por correo', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  sg.received.length = 0;

  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com', phone: '311 222 3344', searchOnly: true });

  assert.equal(wa.received.length, 0, 'la plantilla también deja una fila: en este modo no sale');
  assert.equal(sg.received.length, 0, 'sin suscripción no hay verificación ni aviso que relevar');
});

test('la consulta normal sigue indexando: el modo efímero es opt-in, no el nuevo default', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const antes = await app.store.counts();

  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });

  const despues = await app.store.counts();
  assert.equal(despues.photos_query, antes.photos_query + 1, 'sin marcar la casilla, la firma se sigue guardando');
  assert.equal(despues.subscriptions, 1);
});


// -------------------------------------------------- primer contacto por WhatsApp

test('la coincidencia sale por WhatsApp como la plantilla aprobada, en es_CO y sin datos de la familia', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  sg.received.length = 0;

  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  assert.equal(wa.received.length, 1, 'un solo mensaje: la pregunta');
  const salida = wa.received[0].body;
  // Texto plano acá sería un 131047: el rescatista llegó por la web y no hay
  // ninguna ventana de 24 h abierta.
  assert.equal(salida.type, 'template', 'un mensaje que iniciamos nosotros tiene que ser plantilla');
  assert.equal(salida.template.name, PLANTILLA_PREGUNTA, 'el nombre lo aprueba Meta, no lo elige este código');
  // `es` y `es_CO` son idiomas distintos para Meta: pedir el que no es equivale
  // a que no llegue nada.
  assert.equal(salida.template.language.code, LOCALE);
  assert.equal(salida.to, '573112223344');
  assert.equal(salida.template.components[0].parameters.length, 1, 'la plantilla aprobada tiene UN parámetro');
  assert.equal(salida.template.components[0].parameters[0].text, 'Rosa Elvira Prueba');
  assert.doesNotMatch(
    JSON.stringify(salida),
    /300 000 0000/,
    'el primer mensaje NO puede llevar el contacto de la familia'
  );

  // Y queda la fila que sostiene el estado pendiente de la pregunta —marcada
  // como pregunta de rescate, que es distinto de estar verificada.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  const preguntada = subs.filter((s) => s.rescue_state === 'asked');
  assert.equal(preguntada.length, 1, 'una pregunta viva, ni cero ni dos');
  assert.ok(!preguntada[0].verified, 'nada se da por confirmado antes de que respondan');
  assert.equal(Math.round(preguntada[0].rescue_similarity), 97, 'el puntaje se guarda donde existe');
});

test('la coincidencia en pantalla deja copia por correo, y sin verificar pasa por el relevo', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  sg.received.length = 0;

  // La coincidencia se ve en pantalla; si cierra la página, esta es la copia
  // que sobrevive.
  await rescate(app.base, { face: 'nn', email: 'rescatista@ejemplo.com' });

  const verificacion = sg.received.find((m) => text(m).includes('/verify?token='));
  assert.ok(verificacion, 'la verificación del correo va directa, como siempre');
  const aviso = sg.received.find((m) => text(m).includes('300 000 0000'));
  assert.ok(aviso, 'la coincidencia tiene que dejar rastro fuera de la pantalla');
  assert.match(to(aviso), new RegExp(BUZON), 'sin verificar, la copia va al buzón');
  assert.doesNotMatch(to(aviso), /rescatista@ejemplo\.com/);
  assert.match(aviso.body.subject, /SIN verificar/);
});

// La fila del estado pendiente se escribe DESPUÉS de que la pregunta sale. Al
// revés —como estaba— alguien podía subir una foto pública con su propio
// número, no recibir nada porque la plantilla no salió, y aun así escribirle
// "sí" al bot sobre un estado pendiente que nunca correspondió a una pregunta.
test('con la plantilla apagada no sale nada Y no queda ninguna pregunta pendiente que cobrar después', async (t) => {
  const wa = await fakeWhatsApp();
  process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM = '';
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
    delete process.env.WHATSAPP_TEMPLATE_RESCUE_CONFIRM;
    delete process.env.NOTIFY_MODE;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const res = await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /Rosa Elvira Prueba/, 'la coincidencia se sigue viendo en pantalla');
  assert.equal(wa.received.length, 0, 'sin plantilla aprobada no se manda un texto que Meta va a rechazar');

  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.equal(
    subs.filter((s) => s.rescue_state === 'asked').length,
    0,
    'no hay pregunta pendiente porque no hubo pregunta'
  );

  // Y por lo tanto el "sí" no cobra nada.
  await inbound(app.base, { from: '573112223344', text: 'SÍ' });
  assert.doesNotMatch(todoWhatsApp(wa), /300 000 0000/);
  assert.doesNotMatch(todoWhatsApp(wa), /Gracias por confirmar/);
});

test('si Meta rechaza el envío tampoco queda pregunta pendiente', async (t) => {
  const wa = await fakeWhatsApp();
  // Apunta el cliente a un puerto donde no hay nadie: el envío falla de verdad.
  process.env.WHATSAPP_API_BASE = 'http://127.0.0.1:1';
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  const res = await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  assert.equal(res.status, 200, 'un envío fallido no puede tumbar la pantalla del rescatista');
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.equal(subs.filter((s) => s.rescue_state === 'asked').length, 0);
});

// Un número verificado por el bot prueba que el número es de quien escribe. No
// prueba que esa persona tenga a nadie al lado, y compartían el mismo booleano:
// una suscripción de seguidor se saltaba la confirmación de rescate entera.
test('una suscripción de seguidor verificada NO se salta la confirmación de rescate', async (t) => {
  const wa = await fakeWhatsApp();
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });

  const persona = await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0000',
    face: 'nn',
    ficha: FICHA
  });

  // El seguidor se suscribe desde su propio número: eso SÍ verifica el número.
  await inbound(app.base, { from: '573112223344', text: 'SUSCRIBIR Rosa Elvira Prueba' });
  const seguidor = (await app.store.subscriptionsForAddress('whatsapp', '573112223344')).find(
    (s) => String(s.person_id) === String(persona.id)
  );
  assert.ok(seguidor && seguidor.verified, 'el bot verifica el número, como siempre');
  assert.equal(seguidor.rescue_state, null, 'pero no reclamó ningún rescate');

  wa.received.length = 0;
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  const enviadas = plantillas(wa);
  assert.equal(enviadas.length, 1, 'igual hay que preguntarle: seguir a alguien no es tenerla al lado');
  assert.equal(enviadas[0].template.name, PLANTILLA_PREGUNTA);
  assert.doesNotMatch(todoWhatsApp(wa), new RegExp(FICHA.replace(/[.?*+^$[\]\\(){}|-]/g, '\\$&')));
});

// ---------------------------------------------------------- la respuesta

// La regla más importante de todo el archivo, y la que ninguna otra puede
// derogar: el contacto de una familia no sale por WhatsApp. Ni en modo directo,
// ni con la suscripción verificada, ni después de que confirmen.
test('el contacto de la familia NUNCA sale por WhatsApp, en ningún modo ni en ningún momento', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.NOTIFY_MODE = 'direct';
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
    delete process.env.AVISO_EMAIL;
  });

  await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0000',
    face: 'nn',
    ficha: FICHA
  });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  await inbound(app.base, { from: '573112223344', text: 'SÍ' });
  // Y por si alguien insiste después de confirmar.
  await inbound(app.base, { from: '573112223344', text: 'SÍ' });
  await inbound(app.base, { from: '573112223344', text: 'BUSCAR Rosa Elvira Prueba' });

  assert.doesNotMatch(
    todoWhatsApp(wa),
    /300 000 0000/,
    'ni la plantilla, ni la respuesta del bot, ni ningún mensaje posterior'
  );
  // El contacto existe y le llega a un humano, que es donde tiene que estar.
  const relevo = sg.received.find((m) => text(m).includes('300 000 0000'));
  assert.ok(relevo, 'el contacto tiene que llegarle al operador');
  assert.match(to(relevo), new RegExp(BUZON));
});

test('tras el SÍ sale la ficha del registro de origen: dos parámetros, es_CO, y nada de la familia', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0000',
    face: 'nn',
    ficha: FICHA
  });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  assert.equal(plantillas(wa).length, 1, 'hasta acá, solo la pregunta');

  await inbound(app.base, { from: '573112223344', text: 'sí' });

  const enviadas = plantillas(wa);
  assert.equal(enviadas.length, 2, 'la pregunta y la ficha, nada más');
  const ficha = enviadas[1];
  assert.equal(ficha.template.name, PLANTILLA_FICHA);
  assert.equal(ficha.template.language.code, LOCALE);
  assert.deepEqual(
    ficha.template.components[0].parameters.map((p) => p.text),
    ['Rosa Elvira Prueba', FICHA],
    'la plantilla aprobada lleva nombre y URL de la ficha, en ese orden'
  );

  // Y la respuesta del bot dice la verdad de quién tiene el contacto.
  const ultimo = JSON.stringify(wa.received[wa.received.length - 1].body);
  assert.match(ultimo, /no tenemos su contacto, ellos sí/i);

  // Responder desde el propio número verifica el número, y el reclamo de
  // rescate queda registrado aparte.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  const confirmada = subs.find((s) => s.rescue_state === 'confirmed');
  assert.ok(confirmada && confirmada.verified, 'responder verifica el número y confirma el rescate');
});

// Una ficha reportada por la web no tiene registro de origen a donde mandar al
// rescatista, y no hay ninguna plantilla aprobada para ese caso. Inventar una
// no es opción, así que decide un humano.
test('sin ficha de origen no se le manda nada al rescatista: releva al operador', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  sg.received.length = 0;

  await inbound(app.base, { from: '573112223344', text: 'SI' });

  assert.equal(plantillas(wa).length, 1, 'solo la pregunta: no hay plantilla aprobada para este caso');
  const relevo = sg.received.find((m) => text(m).includes('300 000 0000'));
  assert.ok(relevo, 'el operador recibe el caso completo');
  assert.match(relevo.body.subject, /^\[RETENIDO\] /);
  // Al rescatista se le dice la verdad: falta una revisión humana.
  assert.match(JSON.stringify(wa.received[wa.received.length - 1].body), /revisa cada caso/);
});

// El puntaje existe en el momento de la coincidencia y la respuesta llega horas
// después: si no se guarda, el operador aprueba una entrega sin el único dato
// que distingue un rescate real de un parecido.
test('el relevo de una entrega confirmada trae el puntaje de la coincidencia', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  sg.received.length = 0;

  await inbound(app.base, { from: '573112223344', text: 'SÍ' });

  const relevo = sg.received.find((m) => text(m).includes('300 000 0000'));
  assert.ok(relevo);
  assert.match(text(relevo), /Coincidencia facial: 97%/, 'el puntaje viaja con la pregunta hasta la entrega');
});

test('REPORTE no es una confirmación de rescate: no manda ninguna ficha', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0000',
    face: 'nn',
    ficha: FICHA
  });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });

  await inbound(app.base, { from: '573112223344', text: 'REPORTE' });

  assert.equal(plantillas(wa).length, 1, 'la ficha no sale: quien reporta no es quien rescató');
  assert.doesNotMatch(todoWhatsApp(wa), /300 000 0000/);
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.ok(subs.some((s) => s.rescue_state === 'reported'), 'queda anotado como quien la busca');
  assert.equal(subs.filter((s) => s.rescue_state === 'confirmed').length, 0);
});

// Un solo "sí" resolvía TODAS las suscripciones pendientes del número: dos usos
// de /rescate el mismo día entregaban las dos personas con una sola palabra.
test('un SÍ resuelve UNA pregunta, no todas las pendientes de ese número', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  const a = await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0001',
    face: 'a',
    ficha: FICHA
  });
  const b = await fichaConOrigen(app, {
    name: 'Camila Prueba Rojas',
    contact: '300 000 0002',
    face: 'b',
    ficha: FICHA_2
  });

  // Dos preguntas abiertas para el mismo número, sembradas a mano: es el estado
  // que la app ya no produce, pero que una base viva puede tener.
  for (const [i, persona] of [a, b].entries()) {
    const { sub } = await app.store.subscribe(persona.id, 'whatsapp', '573112223344', {
      verified: false
    });
    await app.store.setSubscriptionRescue(sub.id, {
      state: 'asked',
      similarity: 97,
      askedAt: new Date(Date.now() - (i === 0 ? 7200_000 : 60_000)).toISOString()
    });
  }

  await inbound(app.base, { from: '573112223344', text: 'SÍ' });

  const fichas = plantillas(wa).filter((p) => p.template.name === PLANTILLA_FICHA);
  assert.equal(fichas.length, 1, 'una respuesta, una entrega');
  assert.equal(
    fichas[0].template.components[0].parameters[1].text,
    FICHA_2,
    'la que se resuelve es la última que le llegó al teléfono'
  );
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.equal(subs.filter((s) => s.rescue_state === 'confirmed').length, 1);
  assert.equal(subs.filter((s) => s.rescue_state === 'asked').length, 1, 'la otra sigue esperando');
  assert.doesNotMatch(todoWhatsApp(wa), /300 000 000[12]/);
});

test('a un número con una pregunta abierta no se le abre una segunda', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0001',
    face: 'a',
    ficha: FICHA
  });
  await fichaConOrigen(app, {
    name: 'Camila Prueba Rojas',
    contact: '300 000 0002',
    face: 'b',
    ficha: FICHA_2
  });

  await rescate(app.base, { face: 'a', phone: '311 222 3344' });
  sg.received.length = 0;
  await rescate(app.base, { face: 'b', phone: '311 222 3344' });

  const preguntas = plantillas(wa).filter((p) => p.template.name === PLANTILLA_PREGUNTA);
  assert.equal(preguntas.length, 1, 'dos preguntas abiertas volverían ambiguo el "SÍ"');
  assert.equal(preguntas[0].template.components[0].parameters[0].text, 'Rosa Elvira Prueba');
  // La segunda coincidencia no se pierde: la recibe un humano.
  const relevo = sg.received.find((m) => text(m).includes('Camila Prueba Rojas'));
  assert.ok(relevo, 'la segunda coincidencia llega al operador en vez de perderse');
});

// ------------------------------------------------- qué cuenta como respuesta

test('una frase que empieza con "sí" o "claro" NO confirma nada, y la búsqueda que pidieron sí corre', async (t) => {
  const wa = await fakeWhatsApp();
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = BUZON;
  const app = await startApp();
  t.after(() => {
    wa.stop();
    sg.stop();
    app.server.close();
    delete process.env.AVISO_EMAIL;
  });

  await fichaConOrigen(app, {
    name: 'Rosa Elvira Prueba',
    contact: '300 000 0000',
    face: 'nn',
    ficha: FICHA
  });
  await rescate(app.base, { face: 'nn', phone: '311 222 3344' });
  wa.received.length = 0;

  for (const frase of ['Claro que no es ella', 'Si la veo te aviso', 'sisi', 'confirmo']) {
    await inbound(app.base, { from: '573112223344', text: frase });
  }

  assert.equal(
    plantillas(wa).length,
    0,
    'ninguna de esas frases es la respuesta que pide la plantilla'
  );
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.equal(subs.filter((s) => s.rescue_state === 'confirmed').length, 0);

  // Y no se traga el mensaje: sigue de largo y se procesa como cualquier otro.
  // Desde #118 un texto sin comando ya no es una búsqueda implícita, así que
  // la búsqueda se pide con su palabra clave y se contesta como tal.
  wa.received.length = 0;
  await inbound(app.base, { from: '573112223344', text: 'BUSCAR Rosa Elvira Prueba' });
  assert.match(todoWhatsApp(wa), /Rosa Elvira Prueba/, 'la búsqueda que el usuario pidió corre');
});

test('un "sí" de un número al que no le preguntamos nada no entrega nada', async (t) => {
  const wa = await fakeWhatsApp();
  process.env.NOTIFY_MODE = 'direct';
  const app = await startApp();
  t.after(() => {
    wa.stop();
    app.server.close();
    delete process.env.NOTIFY_MODE;
  });

  await reportar(app.base, { name: 'Rosa Elvira Prueba', contact: '300 000 0000', face: 'nn' });

  await inbound(app.base, { from: '573009998877', text: 'si' });

  assert.doesNotMatch(todoWhatsApp(wa), /300 000 0000/, 'escribir "sí" no puede cosechar el contacto de una familia');
  assert.doesNotMatch(todoWhatsApp(wa), /Gracias por confirmar/, 'no hay nada que confirmar');
});

// ------------------------------------------- lo que se le promete a la gente

// La suscripción de WhatsApp que deja el formulario nace sin verificar, y sin
// coincidencia no hay ninguna pregunta que mandarle para que su dueño la
// confirme. La página prometía un aviso automático que el código no tiene forma
// de cumplir.
test('sin coincidencia, la página no promete un aviso por WhatsApp que no puede mandar', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const html = await (await rescate(app.base, { face: 'desconocido', phone: '311 222 3344' })).text();

  assert.match(html, /Nadie ha reportado a esta persona/);
  assert.doesNotMatch(html, /Te avisaremos a tu WhatsApp/, 'esa promesa no la puede cumplir nadie');
  assert.match(html, /no podemos confirmarlo/i, 'y se dice por qué');
  // La fila queda: le sirve a una persona del equipo para ubicar al rescatista.
  const subs = await app.store.subscriptionsForAddress('whatsapp', '573112223344');
  assert.equal(subs.length, 1);
});

// Perder la casilla en el reintento no era una molestia de usabilidad: quien la
// marcó pidió que NO guardáramos su firma facial, y el reintento sobre un
// formulario en blanco la indexaba en silencio.
test('la foto ilegible vuelve al formulario con la casilla marcada y el teléfono puesto', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  // Un contenedor HEIC cuyo encabezado sharp lee pero cuyo contenido no decodifica.
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 7)]);
  const fd = new FormData();
  fd.set('photo', new File([heic], 'IMG_1.HEIC', { type: 'image/heic' }));
  fd.set('email', 'rescatista@ejemplo.com');
  fd.set('phone', '311 222 3344');
  fd.set('solo_busqueda', '1');
  const html = await (await fetch(`${app.base}/rescate`, { method: 'POST', body: fd })).text();

  assert.match(html, /No pudimos leer esa foto/);
  assert.match(html, /name="solo_busqueda"[^>]*checked/, 'la casilla vuelve marcada, o el reintento indexa la cara');
  assert.match(html, /name="phone" value="311 222 3344"/, 'el teléfono no se pierde');
  assert.match(html, /value="rescatista@ejemplo\.com"/);
  // Y se dice en pantalla, para que no haya que confiar en que se ve marcada.
  assert.match(html, /no guarden nada/i);
});

test('la foto ilegible sin la casilla marcada no inventa que la marcaron', async (t) => {
  const app = await startApp();
  t.after(() => app.server.close());

  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 7)]);
  const fd = new FormData();
  fd.set('photo', new File([heic], 'IMG_1.HEIC', { type: 'image/heic' }));
  fd.set('phone', '311 222 3344');
  const html = await (await fetch(`${app.base}/rescate`, { method: 'POST', body: fd })).text();

  assert.doesNotMatch(html, /name="solo_busqueda"[^>]*checked/);
  assert.match(html, /name="phone" value="311 222 3344"/);
});

// `needsVerification` significa "hay que mandarle el correo de verificación".
// Sin el calificador de canal, la API mandaba un correo a un número de teléfono
// y respondía `pending_verification: true` por algo que nunca iba a llegar.
test('suscribir un WhatsApp por la API no dispara un correo de verificación', async (t) => {
  const sg = await fakeSendgrid();
  // env.API_KEY, no process.env.API_KEY: src/env.js copia el entorno al
  // cargarse, así que ponerla después no exige nada y estas dos pruebas venían
  // pasando por el camino SIN llave sin querer.
  env.API_KEY = 'llave-de-prueba';
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    env.API_KEY = '';
  });

  const { person } = await app.store.findOrCreatePerson('Rosa Elvira Prueba');
  sg.received.length = 0;

  const res = await fetch(`${app.base}/api/people/${person.id}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer llave-de-prueba' },
    body: JSON.stringify({ channel: 'whatsapp', address: '573112223344' })
  });

  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.pending_verification, false, 'un número no se verifica por correo');
  assert.equal(sg.received.length, 0, 'no se manda un correo a un teléfono');
});

test('suscribir un correo por la API sí sigue pidiendo verificación', async (t) => {
  const sg = await fakeSendgrid();
  // env.API_KEY, no process.env.API_KEY: src/env.js copia el entorno al
  // cargarse, así que ponerla después no exige nada y estas dos pruebas venían
  // pasando por el camino SIN llave sin querer.
  env.API_KEY = 'llave-de-prueba';
  const app = await startApp();
  t.after(() => {
    sg.stop();
    app.server.close();
    env.API_KEY = '';
  });

  const { person } = await app.store.findOrCreatePerson('Rosa Elvira Prueba');
  sg.received.length = 0;

  const res = await fetch(`${app.base}/api/people/${person.id}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer llave-de-prueba' },
    body: JSON.stringify({ channel: 'email', address: 'rescatista@ejemplo.com' })
  });

  assert.equal((await res.json()).pending_verification, true);
  assert.ok(sg.received.some((m) => text(m).includes('/verify?token=')));
});
