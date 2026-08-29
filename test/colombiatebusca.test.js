const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');
const { fakeSendgrid } = require('./helpers');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  // El store va de vuelta porque una prueba de acá necesita mirar la fila
  // guardada, no solo la página que la muestra.
  return { server, base: `http://127.0.0.1:${server.address().port}`, store: app.locals.store };
}

// A real JPEG: the report path decodes it to build the thumbnail.
async function photoBytes() {
  return sharp({
    create: { width: 400, height: 500, channels: 3, background: { r: 120, g: 90, b: 60 } }
  })
    .jpeg()
    .toBuffer();
}

async function report(base, extra = {}) {
  const fd = new FormData();
  fd.set('name', 'Marta Isabel Quintero');
  fd.set('location', 'Barrio San José, Quibdó');
  fd.set('contact', 'hermana@ejemplo.com');
  fd.set('message', 'Lleva una chaqueta roja');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.append('photos', new File([await photoBytes()], 'f.jpg', { type: 'image/jpeg' }));
  return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
}

// El formulario ofrecía «Reportar también en ColombiaTeBusca.com». Ese registro
// no tiene forma programática de recibir un reporte, así que cada publicación
// exigía que una persona llenara su formulario a mano — y ese paso nunca se
// cerró. Una casilla que promete algo que no ocurre es peor que no tener la
// casilla, así que se retiró hasta que exista una vía real.
test('el formulario de reporte ya no ofrece publicar en un registro de terceros', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/report`)).text();
  assert.doesNotMatch(html, /name="colombiatebusca"/);
  assert.doesNotMatch(html, /Reportar también en ColombiaTeBusca/i);
  // Las casillas que solo existían para llenar SU formulario se van con ella.
  for (const field of ['reporter_name', 'department', 'municipality', 'place']) {
    assert.doesNotMatch(html, new RegExp(`name="${field}"`), `sobra la casilla ${field}`);
  }
  assert.doesNotMatch(html, /ctb-fields/);

  // Y el estilo del grupo desplegable tampoco se queda rondando en la hoja.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /\.ctb-fields/);
  assert.doesNotMatch(css, /\.ctb-why/);
});

// Retirar la casilla no basta: mientras el servidor siguiera atendiendo el
// campo, una página vieja en caché o un bot que repita el formulario anterior
// seguiría alimentando una cola que ya nadie atiende. Esto es lo que prueba
// que la puerta quedó cerrada del lado del servidor, no solo en pantalla.
test('un POST que todavía traiga el campo no manda nada al buzón de operación', async (t) => {
  const sg = await fakeSendgrid();
  process.env.AVISO_EMAIL = 'avisos@example.com';
  const { server, base } = await startApp();
  t.after(() => {
    sg.stop();
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  const res = await report(base, {
    colombiatebusca: '1',
    reporter_name: 'Ana Carolina Restrepo',
    department: 'Risaralda',
    municipality: 'Pereira',
    place: 'Barrio Cuba, cerca del parque'
  });

  // El reporte se guarda igual: quitar el relevo no puede costarle el reporte
  // a nadie.
  assert.equal(res.status, 303);
  const personUrl = res.headers.get('location');
  assert.match(personUrl, /^\/person\/\d+\?reported=1$/);
  assert.equal((await fetch(`${base}${personUrl}`)).status, 200);

  assert.equal(
    sg.received.filter((r) => JSON.stringify(r.body).includes('avisos@example.com')).length,
    0,
    'ningún correo de relevo puede salir'
  );
});

// Sin casilla, el nombre de quien reporta ya no entra por este formulario —
// vivía dentro del grupo que ella desplegaba. La columna `reporter` sigue
// existiendo y la siguen llenando el API y los agregadores (ver app.test.js),
// así que lo único que cambia es que un reporte web no la trae.
test('un reporte web ya no guarda nombre de quien reporta', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const res = await report(base, { reporter_name: 'Ana Carolina Restrepo' });
  assert.equal(res.status, 303);

  const location = res.headers.get('location');

  // La fila guardada es lo que de verdad importa: la página oculta o enmascara
  // el nombre de todas formas, así que mirarla sola dejaría pasar un servidor
  // que volviera a persistirlo.
  const personId = Number(location.match(/^\/person\/(\d+)\?/)[1]);
  const updates = await store.getUpdates(personId);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].reporter, null, 'el reporte web no puede guardar quién reporta');

  // Y la página tampoco lo muestra: las dos capas valen.
  const html = await (await fetch(`${base}${location}`)).text();
  assert.doesNotMatch(html, /Reportado por/);
  assert.doesNotMatch(html, /Ana C/);
});

// Sin AVISO_EMAIL el reporte tiene que pasar igual. Ese buzón sigue vivo para
// los avisos de rescatista y los relevos de coincidencias, así que la prueba
// se queda: es el reporte lo que nunca puede depender de nuestra configuración.
test('a report still goes through when AVISO_EMAIL is not configured', async (t) => {
  delete process.env.AVISO_EMAIL;
  const { server, base } = await startApp();
  t.after(() => server.close());

  const res = await report(base);
  assert.equal(res.status, 303);
});

// Los avisos que sí siguen saliendo fallan en silencio sin este buzón —el
// visitante ve su página de éxito igual—, así que necesitan una forma de verse
// desde afuera. Solo presencia: la dirección no se publica.
test('/api/diag reports whether the relay mailbox is configured', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    delete process.env.AVISO_EMAIL;
    server.close();
  });

  delete process.env.AVISO_EMAIL;
  const off = await (await fetch(`${base}/api/diag`)).json();
  assert.equal(off.email.aviso_email_present, false);

  process.env.AVISO_EMAIL = 'avisos@example.com';
  const on = await (await fetch(`${base}/api/diag`)).json();
  assert.equal(on.email.aviso_email_present, true);
  assert.doesNotMatch(JSON.stringify(on), /avisos@example\.com/, 'la dirección no se publica');
});

// One obligation, two boxes: exactly the rule the single field enforced.
test('either contact box on its own is enough, and neither is still an error', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const onlyPhone = await report(base, { contact: '', contact_phone: '310 444 5566' });
  assert.equal(onlyPhone.status, 303, 'con teléfono basta');

  const onlyEmail = await report(base, { contact: '', contact_email: 'primo@ejemplo.com' });
  assert.equal(onlyEmail.status, 303, 'con correo basta');

  const neither = await report(base, { contact: '' });
  assert.equal(neither.status, 400, 'sin ninguna forma de contactar no hay a quién avisar');
});

// #178: the form accepted any text in the phone box — letters, symbols,
// whatever. Unlike /rescate's optional phone, a filled-in box here means the
// value has to actually be usable.
test('a contact phone that is not just digits gets rejected', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const withLetters = await report(base, { contact: '', contact_phone: 'abc123def45' });
  assert.equal(withLetters.status, 400, 'letters mixed with digits are not a phone number');

  const oneLetterMixedIn = await report(base, { contact: '', contact_phone: '300a1234567' });
  assert.equal(
    oneLetterMixedIn.status,
    400,
    'a single stray letter must not be silently stripped down to a valid digit count'
  );

  const tooShort = await report(base, { contact: '', contact_phone: '31044455' });
  assert.equal(tooShort.status, 400, '8 digits are not enough');

  const withSpaces = await report(base, { contact: '', contact_phone: '310 444 5566' });
  assert.equal(withSpaces.status, 303, '10 digits with separator spaces still work');

  const withCountryCode = await report(base, { contact: '', contact_phone: '573145556677' });
  assert.equal(withCountryCode.status, 303, 'a country-code prefix also works, like /rescate');

  const withPlusCountryCode = await report(base, { contact: '', contact_phone: '+573145556677' });
  assert.equal(withPlusCountryCode.status, 303, 'a "+" before the country code also works');
});

// El 400 de este formulario es de página completa y /report lleva de 1 a 3
// fotos obligatorias: rechazar un número se lleva también las fotos que la
// familia acababa de subir. Así que solo se rechaza lo que de verdad no es un
// teléfono — los separadores con los que se escribe un celular en Colombia los
// limpia normalizePhone() igual.
test('the usual ways of writing a Colombian mobile are accepted, separators included', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const dashes = await report(base, { contact: '', contact_phone: '300-123-4567' });
  assert.equal(dashes.status, 303, 'guiones: forma corriente de escribirlo');

  const parens = await report(base, { contact: '', contact_phone: '(300) 123 4567' });
  assert.equal(parens.status, 303, 'paréntesis alrededor del indicativo');

  const dots = await report(base, { contact: '', contact_phone: '300.123.4567' });
  assert.equal(dots.status, 303, 'puntos como separador');

  const plusAndDashes = await report(base, { contact: '', contact_phone: '+57 300-123-4567' });
  assert.equal(plusAndDashes.status, 303, 'indicativo con "+" y guiones a la vez');

  // El límite no se movió: lo que no es un teléfono sigue sin pasar.
  const symbols = await report(base, { contact: '', contact_phone: '300#123*4567' });
  assert.equal(symbols.status, 400, 'símbolos que no separan un número no son un teléfono');

  const separatorsOnly = await report(base, { contact: '', contact_phone: '--- ()' });
  assert.equal(separatorsOnly.status, 400, 'puros separadores no son un número');
});

test('every page ends with the two asks, contributors above the ColombiaTeBusca team', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  for (const path of ['/', '/report', '/rescate', '/privacidad']) {
    const html = await (await fetch(`${base}${path}`)).text();
    const contribute = html.indexOf('¿Deseas contribuir?');
    const team = html.indexOf('¿Eres parte del equipo de ColombiaTeBusca?');
    assert.ok(contribute > 0, `falta la invitación a contribuir en ${path}`);
    assert.ok(team > contribute, `el mensaje al equipo de ColombiaTeBusca va de último en ${path}`);
    assert.match(html.slice(contribute), /crawling de redes sociales/);
    assert.match(html.slice(team), /integrar nuestra tech/);
    // Both asks lead to the same place.
    assert.equal(html.slice(contribute).match(/https:\/\/x\.com\/ni500/g).length, 2);
  }
});
