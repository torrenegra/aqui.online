const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createStore } = require('../src/people');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store: app.locals.store };
}

test('API: report, fuzzy search, person detail, subscription', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const post = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'María Fernanda López',
      status: 'safe',
      message: 'Confirmado por su hermana',
      location: 'Cali',
      reporter: 'Hermana'
    })
  });
  assert.equal(post.status, 201);
  const created = await post.json();
  assert.equal(created.person_created, true);

  const search = await fetch(`${base}/api/people?q=maria lopez`);
  const { results } = await search.json();
  assert.equal(results.length, 1);
  assert.equal(results[0].latest_update.status, 'safe');
  // Privacy: the raw `reporter` never comes back in the public JSON, only a
  // masked label. 'Hermana' is a name (not phone/email), so it passes
  // through as-is here.
  assert.equal(results[0].latest_update.reporter, undefined);
  assert.equal(results[0].latest_update.reporter_label, 'Hermana');

  const detail = await fetch(`${base}/api/people/${results[0].id}`);
  const person = await detail.json();
  assert.equal(person.updates.length, 1);
  assert.equal(person.updates[0].location, 'Cali');
  assert.equal(person.updates[0].reporter, undefined);
  assert.equal(person.updates[0].reporter_label, 'Hermana');

  const sub = await fetch(`${base}/api/people/${results[0].id}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'email', address: 'Familia@Ejemplo.com' })
  });
  assert.equal(sub.status, 201);
});

test('API: validation errors', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const noName = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'safe' })
  });
  assert.equal(noName.status, 400);

  const badStatus = await fetch(`${base}/api/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X Y', status: 'vivo' })
  });
  assert.equal(badStatus.status, 400);
});

test('home lists missing people and offers both actions', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(base)).text();
  assert.match(html, /Rescaté a alguien/);
  assert.match(html, /Estoy buscando a alguien/);
  assert.match(html, /href="\/rescate"/);
  assert.match(html, /href="\/report"/);
  // The sources line lives small under the listing, present even when empty.
  assert.match(html, /Fuentes de información de desaparecidos/);

  // a reported person shows up in the listing
  const fd = new FormData();
  fd.set('name', 'Pedro Pablo Ramírez');
  fd.set('location', 'Barrio Centro');
  fd.set('contact', '300 123 4567');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  const report = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(report.status, 303);

  const home = await (await fetch(base)).text();
  assert.match(home, /Reportes de desaparecidos más recientes/);
  assert.match(home, /Pedro Pablo Ramírez/);
  // The sources line sits under the listing heading, small, not as a section
  // of its own competing with it.
  assert.match(home, /Fuentes de información de desaparecidos: Encontrados\.co y <a [^>]*>Colombia Te Busca<\/a>, el registro público/);
  assert.doesNotMatch(home, /<h2>Fuentes de información<\/h2>/);
  // No false "coming soon" promises: media and official channels don't expose a
  // scrapable photo registry, so they must not be listed as sources.
  assert.doesNotMatch(home, /Próximamente/);
});

// El home ofrece dos caminos y solo dos: el rescatista que encontró a alguien
// (→ /rescate) y quien está buscando (→ /report). Cada uno con su espacio de
// imagen reservado para que se distingan de un vistazo.
test('home ofrece dos caminos claros, cada uno con su espacio de imagen', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const home = await (await fetch(base)).text();
  assert.match(home, /<a class="path rescuer" href="\/rescate">/);
  assert.match(home, /<a class="path family" href="\/report">/);
  assert.match(home, /Rescaté a alguien/);
  assert.match(home, /Estoy buscando a alguien/);
  // Dos espacios de imagen, uno por camino, cada uno con su imagen.
  assert.equal(home.match(/class="path-art"/g).length, 2);
  assert.match(home, /<img src="\/img\/rescate\.jpg"/);
  assert.match(home, /<img src="\/img\/busqueda\.jpg"/);
});

// Los dos caminos son <span>, no encabezados, así que la página necesita su
// propio <h1>. Es la puerta de entrada del sitio: sin él, un lector de pantalla
// y un buscador entran sin nada que diga qué es esto — y con la base vacía el
// home se quedaba sin un solo encabezado.
test('el home tiene un h1 y los encabezados bajan en orden', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const headingsOf = (html) =>
    [...html.matchAll(/<(h[1-6])\b[^>]*>/g)].map((m) => Number(m[1][1]));

  // Sin reportes todavía: el h1 tiene que estar igual.
  const vacio = await (await fetch(base)).text();
  assert.deepEqual(headingsOf(vacio), [1], 'con la base vacía el home es solo su h1');
  assert.match(vacio, /<h1[^>]*>Personas desaparecidas por el terremoto en Colombia<\/h1>/);

  const fd = new FormData();
  fd.set('name', 'Pedro Pablo Ramírez');
  fd.set('location', 'Barrio Centro');
  fd.set('contact', '300 123 4567');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  const creado = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(creado.status, 303);

  const conReportes = await (await fetch(base)).text();
  const niveles = headingsOf(conReportes);
  assert.equal(niveles[0], 1, 'el primer encabezado de la página es el h1');
  assert.equal(niveles.filter((n) => n === 1).length, 1, 'un solo h1 por página');
  // Ningún salto: de un encabezado al siguiente se baja de a un nivel.
  for (let i = 1; i < niveles.length; i++) {
    assert.ok(
      niveles[i] <= niveles[i - 1] + 1,
      `salto de h${niveles[i - 1]} a h${niveles[i]}: el orden de encabezados se rompió`
    );
  }
});

// A second party reporting the same person is never rejected: the report is
// merged into the same person as one more update, keeping both contacts so a
// rescuer's match can reach every family member who is searching.
test('a duplicate report merges into the same person instead of being rejected', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const report = async (contact) => {
    const fd = new FormData();
    fd.set('name', 'Marta Cecilia Giraldo');
    fd.set('location', 'Barrio La Merced');
    fd.set('contact', contact);
    fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
    return fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  };

  const first = await report('300 111 1111');
  assert.equal(first.status, 303);
  const second = await report('310 222 2222');
  assert.equal(second.status, 303, 'el segundo reporte no debe rechazarse');

  // Both redirects land on the SAME person: merged, not duplicated.
  const personPath = first.headers.get('location').split('?')[0];
  assert.equal(second.headers.get('location').split('?')[0], personPath);

  const results = await (await fetch(`${base}/api/people?q=Marta Cecilia Giraldo`)).json();
  assert.equal(results.results.length, 1, 'debe existir una sola persona, no dos');

  // Both reports survive as separate updates with their own contact.
  const { updates } = await (await fetch(`${base}/api${personPath.replace('/person/', '/people/')}`)).json();
  assert.equal(updates.length, 2);
});

test('reporting requires photos, name, place and contact', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const missingContact = new FormData();
  missingContact.set('name', 'Sin Contacto');
  missingContact.set('location', 'Centro');
  missingContact.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  assert.equal((await fetch(`${base}/report`, { method: 'POST', body: missingContact })).status, 400);

  const noPhoto = new URLSearchParams({ name: 'Sin Foto', location: 'Centro', contact: '3001' });
  const res = await fetch(`${base}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: noPhoto
  });
  assert.equal(res.status, 400);
});

test('the contact of the reporter is never shown on public pages', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Julia Restrepo');
  fd.set('location', 'La Candelaria');
  fd.set('contact', 'secreto@ejemplo.com');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });

  const [person] = await store.searchPeople('julia restrepo');
  const page = await (await fetch(`${base}/person/${person.id}`)).text();
  assert.match(page, /Julia Restrepo/);
  assert.doesNotMatch(page, /secreto@ejemplo\.com/, 'el contacto no debe ser público');

  const home = await (await fetch(base)).text();
  assert.doesNotMatch(home, /secreto@ejemplo\.com/);
});

test('families can no longer subscribe to alerts', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());
  const { person } = await store.findOrCreatePerson('Alguien Buscado');
  for (const path of ['/buscar', '/alerta', `/person/${person.id}/subscribe`, '/subscribe-by-name']) {
    const res = await fetch(`${base}${path}`, { method: 'POST' });
    assert.equal(res.status, 404, `${path} debería no existir`);
  }
  assert.equal((await fetch(`${base}/buscar`)).status, 404);
});

// The old web form's reporter field is gone (the rescuer model asks for a
// private `contact` instead), but updates created with a `reporter` — the
// store API, the aggregator, old rows — still render on the person page.
// A name must come out masked, never verbatim.
test('web: a name reporter renders masked on the person page', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Pedro Pablo Ramírez');
  await store.addUpdate(person.id, {
    status: 'missing',
    message: 'No contesta desde ayer',
    location: 'Barrio Centro',
    source: 'web',
    reporter: 'María Gómez, Cruz Roja'
  });

  const html = await (await fetch(`${base}/person/${person.id}`)).text();
  assert.match(html, /Reportado por: María G\./);
  assert.ok(!html.includes('María Gómez, Cruz Roja'));
});

test('webhook: whatsapp inbound message is processed', async (t) => {
  const { server, base } = await startApp();
  t.after(() => {
    server.close();
    delete process.env.WHATSAPP_RELAY_SECRET;
  });
  process.env.WHATSAPP_RELAY_SECRET = 'secreto-de-relevo-de-prueba';

  const res = await fetch(`${base}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relay-Secret': 'secreto-de-relevo-de-prueba'
    },
    body: JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { type: 'text', from: '573000000000', text: { body: 'BIEN Laura Díaz' } }
                ]
              }
            }
          ]
        }
      ]
    })
  });
  assert.equal(res.status, 200);
  // give the async handler a beat to persist
  await new Promise((r) => setTimeout(r, 150));
  const search = await fetch(`${base}/api/people?q=laura diaz`);
  const { results } = await search.json();
  assert.equal(results.length, 1);
  assert.equal(results[0].latest_update.status, 'safe');
  assert.equal(results[0].latest_update.source, 'whatsapp');

  // Privacy: bot.js sets `reporter` to the sender's raw WhatsApp phone
  // number (see src/bot.js). That number must never reach a public reader —
  // not the raw field, not disguised inside reporter_label.
  const phone = '573000000000';
  assert.equal(results[0].latest_update.reporter, undefined);
  assert.equal(results[0].latest_update.reporter_label, 'Reporte ciudadano');
  assert.ok(!JSON.stringify(results[0]).includes(phone));

  const detail = await fetch(`${base}/api/people/${results[0].id}`);
  const person = await detail.json();
  assert.equal(person.updates[0].reporter, undefined);
  assert.equal(person.updates[0].reporter_label, 'Reporte ciudadano');
  assert.ok(!JSON.stringify(person).includes(phone));

  // Same story on the public HTML person page.
  const page = await fetch(`${base}/person/${results[0].id}`);
  const html = await page.text();
  assert.match(html, /Reporte ciudadano/);
  assert.ok(!html.includes(phone));
});

test('purge-test-data removes only the seeded test records', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const store = (await (async () => null)()) || null;

  const mk = (name) =>
    fetch(`${base}/api/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, status: 'safe' })
    });
  await mk('Verificacion Final');
  await mk('Cadena Completa 9147');
  await mk('Nicolas Contreras'); // a real report must survive

  const res = await fetch(`${base}/api/maintenance/purge-test-data`, { method: 'POST' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.removed_count >= 2, JSON.stringify(body));

  const survivors = await (await fetch(`${base}/api/people?q=Nicolas Contreras`)).json();
  assert.equal(survivors.results.length, 1, 'un reporte real fue borrado');

  const gone = await (await fetch(`${base}/api/people?q=Verificacion Final`)).json();
  assert.equal(gone.results.length, 0);
});

test('DELETE /api/people/:id is disabled without API_KEY', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const res = await fetch(`${base}/api/people/1`, { method: 'DELETE' });
  assert.equal(res.status, 503);
});

test('the contact is remembered between reports via a cookie', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const fd = new FormData();
  fd.set('name', 'Marta Isabel Vélez');
  fd.set('location', 'Chapinero');
  fd.set('contact', 'Cruz Roja · 300 555 1234');
  fd.append('photos', new File([Buffer.from('foto')], 'f.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`${base}/report`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(res.status, 303);

  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('encontrados_reporter='));
  assert.ok(cookie, 'no se guardó la cookie de contacto');

  const form = await fetch(`${base}/report`, { headers: { cookie: cookie.split(';')[0] } });
  assert.match(await form.text(), /Cruz Roja · 300 555 1234/);
});


// Bug fix: the home query filtered by "has ANY update with status='missing'"
// instead of the LATEST status, so once a person was found alive they stayed
// listed as missing forever — their family kept seeing them on the list, and
// rescuers kept looking for someone already home.
test('store: missingPeople/getReunitedCount reflect the LATEST status, not any past one', async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());

  const { person: stillMissing } = await store.findOrCreatePerson('Camila Vanegas');
  await store.addUpdate(stillMissing.id, { status: 'missing', source: 'web', location: 'Suba' });

  const { person: found } = await store.findOrCreatePerson('Julián Restrepo Toro');
  await store.addUpdate(found.id, { status: 'missing', source: 'web', location: 'Kennedy' });
  await store.addUpdate(found.id, { status: 'safe', source: 'web', message: 'Confirmado' });

  const missing = await store.getMissingPeople(50);
  assert.deepEqual(missing.map((p) => p.full_name), ['Camila Vanegas']);
  assert.equal(await store.getReunitedCount(), 1);

  // Flip back to missing (a mistaken "safe" report) — must re-appear.
  await store.addUpdate(found.id, { status: 'missing', source: 'web', message: 'Se perdió de nuevo' });
  const missingAgain = await store.getMissingPeople(50);
  assert.deepEqual(
    missingAgain.map((p) => p.full_name).sort(),
    ['Camila Vanegas', 'Julián Restrepo Toro']
  );
  assert.equal(await store.getReunitedCount(), 0);
});

// #78: the public-registry sweep pushes source='aggregator' updates, and used
// to send status='safe' for a person the SOURCE marked as already found —
// even when nobody had ever reported them missing through this app. That row
// won "latest status" and counted toward the public reunited counter with
// someone who never passed through encontrados.co.
test("store: an aggregator 'safe' row never counts as reunited, with or without a real report first", async (t) => {
  const store = createStore(await createSqliteAdapter(':memory:'));
  t.after(() => store.close());

  // Never reported here at all — the sweep's very first sighting of this
  // ficha was already "Localizada". No real signal exists for this person.
  const { person: neverReported } = await store.findOrCreatePerson('Beatriz Salcedo Prieto');
  await store.addUpdate(neverReported.id, { status: 'safe', source: 'aggregator', message: 'Localizada' });

  // Genuinely reported missing through the app, and the SAME external ficha
  // later flips to "Localizada" in a later sweep — the aggregator row must
  // not override the real 'missing' signal already on file.
  const { person: reportedThenPolluted } = await store.findOrCreatePerson('Nicolás Perea Duarte');
  await store.addUpdate(reportedThenPolluted.id, { status: 'missing', source: 'web', location: 'Suba' });
  await store.addUpdate(reportedThenPolluted.id, { status: 'safe', source: 'aggregator', message: 'Localizada' });

  // Control: a REAL confirmation (web/whatsapp/api) must still count.
  const { person: reallyFound } = await store.findOrCreatePerson('Laura Gómez Rincón');
  await store.addUpdate(reallyFound.id, { status: 'missing', source: 'web', location: 'Kennedy' });
  await store.addUpdate(reallyFound.id, { status: 'safe', source: 'web', message: 'Confirmado' });

  assert.equal(await store.getReunitedCount(), 1, 'solo la confirmación real cuenta');

  const missing = await store.getMissingPeople(50);
  assert.deepEqual(
    missing.map((p) => p.full_name),
    ['Nicolás Perea Duarte'],
    'el reporte real de desaparición resurge; el nunca-reportado no aparece en ninguna lista'
  );
});

test('home: a person later marked safe drops off the list and counts as reunited', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Andrés Felipe Mora');
  await store.addUpdate(person.id, { status: 'missing', source: 'web', location: 'Bosa' });

  const before = await (await fetch(base)).text();
  assert.match(before, /Andrés Felipe Mora/);

  await store.addUpdate(person.id, { status: 'safe', source: 'web', message: 'Ya está en casa' });

  const after = await (await fetch(base)).text();
  assert.doesNotMatch(after, /Andrés Felipe Mora/, 'quien ya apareció no sigue listado como desaparecido');
  assert.match(after, /1 reencontrada/);
});

// #78 end-to-end: the home page's public "reencontradas" counter must not
// move just because the public-registry sweep saw a ficha already marked
// found — that is noise from outside this app, not this app's own signal.
test('home: the reunited counter does not move on an aggregator sync alone', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Esteban Cárdenas Lozano');
  await store.addUpdate(person.id, { status: 'missing', source: 'web', location: 'Engativá' });

  const before = await (await fetch(base)).text();
  assert.match(before, /Esteban Cárdenas Lozano/);
  assert.doesNotMatch(before, /reencontrada/);

  // The public registry's later sweep sees this same ficha as "Localizada".
  await store.addUpdate(person.id, { status: 'safe', source: 'aggregator', message: 'Localizada' });

  const afterAggregatorSync = await (await fetch(base)).text();
  assert.match(
    afterAggregatorSync,
    /Esteban Cárdenas Lozano/,
    'sigue listado como desaparecido: el barrido externo no es una confirmación de esta app'
  );
  assert.doesNotMatch(afterAggregatorSync, /reencontrada/, 'el conteo público no se infla con una fuente externa');

  // A REAL confirmation through the app still has to work.
  await store.addUpdate(person.id, { status: 'safe', source: 'web', message: 'Confirmado por la familia' });
  const afterRealReport = await (await fetch(base)).text();
  assert.doesNotMatch(afterRealReport, /Esteban Cárdenas Lozano/);
  assert.match(afterRealReport, /1 reencontrada/);
});

// #78: GET /api/people's `latest_update` is the same "current status" the
// home page derives — an external consumer of this API must see the same
// answer the site shows, not the aggregator's unconfirmed noise.
test('API: GET /api/people does not surface an aggregator-only safe status', async (t) => {
  const { server, base, store } = await startApp();
  t.after(() => server.close());

  const { person } = await store.findOrCreatePerson('Valentina Osorio Bermúdez');
  await store.addUpdate(person.id, { status: 'missing', source: 'web', location: 'Chapinero' });
  await store.addUpdate(person.id, { status: 'safe', source: 'aggregator', message: 'Localizada' });

  const res = await fetch(`${base}/api/people?q=Valentina Osorio`);
  const { results } = await res.json();
  assert.equal(results.length, 1);
  assert.equal(
    results[0].latest_update.status,
    'missing',
    'la API pública no puede contradecir lo que el home ya muestra'
  );
});
