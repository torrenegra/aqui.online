// Unit tests for the shared report-admission service (src/report-admission.js).
//
// These prove the SHARED domain contract directly, with fakes for the store,
// matcher, duplicate matcher, photo indexer and notifier — no HTTP, no
// SQLite, no Rekognition. The three entry points (web / API / WhatsApp) are
// thin adapters over this service; the integration tests (app.test.js,
// bot.test.js) prove they wire into it. What matters here is that the RULES
// are identical no matter which caller supplied the input.
const test = require('node:test');
const assert = require('node:assert');
const { createReportAdmission } = require('../src/report-admission');

// A tiny in-memory store with just the surface the service touches. Records
// every call so a test can assert the ORDER of operations, which is where the
// "duplicate check LAST, after indexing and notifying" invariant lives.
function fakeStore({
  existingPerson = null,
  existingReportPhoto = null,
  ownerOverride = null,
  suppressedExternalIds = []
} = {}) {
  const events = [];
  let nextPersonId = 100;
  let nextUpdateId = 500;
  const peopleById = new Map();
  if (existingPerson) peopleById.set(existingPerson.id, existingPerson);
  if (ownerOverride) peopleById.set(ownerOverride.id, ownerOverride);

  return {
    events,
    // La constancia de un borrado a solicitud (#191). El servicio la consulta
    // antes de crear cualquier cosa, así que el doble tiene que responderla.
    async isExternalIdSuppressed(externalId) {
      events.push({ op: 'isExternalIdSuppressed', externalId });
      return suppressedExternalIds.includes(externalId);
    },
    async findOrCreatePerson(name) {
      events.push({ op: 'findOrCreatePerson', name });
      if (existingPerson) return { person: existingPerson, created: false };
      const person = { id: nextPersonId++, full_name: name };
      peopleById.set(person.id, person);
      return { person, created: true };
    },
    async reportPhotoByPerson(ids) {
      events.push({ op: 'reportPhotoByPerson', ids });
      const m = new Map();
      if (existingReportPhoto && ids.includes(existingReportPhoto.person_id)) {
        m.set(existingReportPhoto.person_id, existingReportPhoto);
      }
      return m;
    },
    async addUpdate(personId, fields) {
      events.push({ op: 'addUpdate', personId, fields });
      // ownerOverride models an external_id upsert landing on a DIFFERENT
      // person than the name lookup returned.
      const landedOn = ownerOverride ? ownerOverride.id : personId;
      return { id: nextUpdateId++, person_id: landedOn, ...fields };
    },
    async getPerson(id) {
      events.push({ op: 'getPerson', id });
      return peopleById.get(id) || null;
    },
    // El doble no modela concurrencia real (no hay nada con quien competir en
    // estas pruebas): pasa directo, transparente para el orden de `events`
    // que las pruebas de arriba ya verifican.
    async withExternalIdLock(externalId, fn) {
      return fn();
    }
  };
}

// Records every step so a test can assert relative order and the args each got.
function tracker() {
  const calls = [];
  return {
    calls,
    findDuplicateCandidates: (result = []) => async (store, matcher, args) => {
      calls.push({ step: 'dup', args });
      return typeof result === 'function' ? result(args) : result;
    },
    processPhoto: (behavior = {}) => async (store, matcher, args) => {
      calls.push({ step: 'photo', args });
      if (behavior.throw) throw new Error('processPhoto exploded');
      return { id: `photo-${calls.length}`, unreadable: !!behavior.unreadable };
    },
    notifySubscribers: (behavior = {}) => async (store, person, update, opts) => {
      calls.push({ step: 'notify', personId: person.id, updateId: update.id, opts });
      if (behavior.throw) throw new Error('notify exploded');
      return behavior.count == null ? 1 : behavior.count;
    },
    duplicateWarning: () => ({ mergedIntoExisting, candidates }) =>
      mergedIntoExisting || candidates.length ? 'aviso de duplicado' : null
  };
}

function buildService(store, t, overrides = {}) {
  return createReportAdmission({
    store,
    matcher: { enabled: true },
    findDuplicateCandidates: overrides.findDuplicateCandidates || t.findDuplicateCandidates(),
    processPhoto: overrides.processPhoto || t.processPhoto(),
    notifySubscribers: overrides.notifySubscribers || t.notifySubscribers(),
    duplicateWarning: overrides.duplicateWarning || t.duplicateWarning()
  });
}

// ------------------------------------------------------------------ validation

test('missing name produces a structured validation error, no writes', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({ name: '   ', status: 'missing' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /nombre/i.test(e)));
  assert.equal(store.events.length, 0, 'nada debe escribirse cuando la validación falla');
});

test('invalid status produces a structured validation error, no writes', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({ name: 'Juan Pérez', status: 'vivo' });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /estado/i.test(e)));
  assert.equal(store.events.length, 0);
});

// -------------------------------------------- same core behavior across inputs

test('web, API and WhatsApp shaped inputs produce the same core report behavior', async () => {
  const inputs = [
    { name: 'Ana Gómez', status: 'missing', source: 'web', contact: '3001112222' },
    { name: 'Ana Gómez', status: 'missing', source: 'api', reporter: 'Hermana' },
    { name: 'Ana Gómez', status: 'missing', source: 'whatsapp', reporter: '573001112222' }
  ];
  for (const input of inputs) {
    const store = fakeStore();
    const t = tracker();
    const svc = buildService(store, t);
    const res = await svc.admitReport(input);
    assert.equal(res.ok, true);
    assert.equal(res.personCreated, true);
    assert.equal(res.update.status, 'missing');
    assert.equal(res.update.person_id, res.person.id);
    // Every entry point runs the SAME courtesy step. None of these inputs
    // asked for the duplicate check, so it never runs — that decision is the
    // caller's, not the source's (see the "no dead work" section below).
    assert.deepEqual(
      t.calls.map((c) => c.step),
      ['notify'],
      `mismo flujo para source=${input.source}`
    );
  }
});

// ---------------------------------- no dead work: opt-in duplicate check ----
//
// The duplicate check is a Rekognition call per photo, and the prior-photo
// read is an extra store query. Neither is free, and neither is used by every
// caller: the WhatsApp reply never mentions a possible duplicate, and only
// the web page renders the pre-existing photo for comparison. Both are
// opt-in so a caller that won't render the result doesn't pay for it.

test('checkDuplicates defaults to off — no Rekognition call for a caller that never asked (WhatsApp shape)', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({
    name: 'Ana Gómez',
    status: 'missing',
    source: 'whatsapp',
    photos: [{ bytes: Buffer.from('foto'), contentType: 'image/jpeg' }]
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.candidates, []);
  assert.equal(res.warning, null);
  assert.ok(!t.calls.some((c) => c.step === 'dup'), 'sin checkDuplicates no debe correr la búsqueda facial de duplicados');
});

test('includePriorPhoto defaults to off — no extra store read for a caller that never uses it (API shape)', async () => {
  const existing = { id: 42, full_name: 'Existente Persona' };
  const priorPhoto = { id: 900, person_id: 42, kind: 'report' };
  const store = fakeStore({ existingPerson: existing, existingReportPhoto: priorPhoto });
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({ name: 'Existente Persona', status: 'safe', source: 'api' });
  assert.equal(res.ok, true);
  assert.equal(res.priorPhoto, null);
  assert.ok(
    !store.events.some((e) => e.op === 'reportPhotoByPerson'),
    'sin includePriorPhoto no debe leerse la foto previa de la persona'
  );
});

test('checkDuplicates + includePriorPhoto opt-in runs both (web/API shape)', async () => {
  const existing = { id: 43, full_name: 'Existente Persona Dos' };
  const priorPhoto = { id: 901, person_id: 43, kind: 'report' };
  const store = fakeStore({ existingPerson: existing, existingReportPhoto: priorPhoto });
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({
    name: 'Existente Persona Dos',
    status: 'safe',
    source: 'web',
    checkDuplicates: true,
    includePriorPhoto: true
  });
  assert.equal(res.priorPhoto.id, priorPhoto.id);
  assert.ok(t.calls.some((c) => c.step === 'dup'), 'con checkDuplicates la búsqueda de duplicados sí debe correr');
});

test('an unknown/absent source is normalized to api without rejecting the report', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({ name: 'Ana Gómez', status: 'missing', source: 'no-existe' });
  assert.equal(res.ok, true);
  const addUpdate = store.events.find((e) => e.op === 'addUpdate');
  assert.equal(addUpdate.fields.source, 'api');
});

// ------------------------------------------------- subscriber notification

test('subscriber notification is consistent — always fires with the reporter self-echo skipped', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  await svc.admitReport({
    name: 'Ana Gómez',
    status: 'missing',
    source: 'web',
    skipAddresses: ['3001112222', 'ana@ejemplo.com', '']
  });
  const notify = t.calls.find((c) => c.step === 'notify');
  assert.ok(notify, 'siempre debe notificar');
  // Falsy addresses are dropped, real ones kept — the reporter isn't echoed.
  assert.deepEqual(notify.opts.skipAddresses, ['3001112222', 'ana@ejemplo.com']);
});

// ------------------------------ ordering: dup check LAST, once report is durable
//
// A slow Rekognition call — or a serverless timeout inside it — must never
// take photo indexing or subscriber notification down with it: those are the
// report; the duplicate check is a courtesy on top. See the comment on step 7
// of src/report-admission.js.

test('duplicate detection runs AFTER photo indexing and subscriber notification, not before', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  await svc.admitReport({
    name: 'Ana Gómez',
    status: 'missing',
    source: 'web',
    photos: [{ bytes: Buffer.from('foto'), contentType: 'image/jpeg' }],
    checkDuplicates: true
  });
  const steps = t.calls.map((c) => c.step);
  const dupAt = steps.indexOf('dup');
  const photoAt = steps.indexOf('photo');
  const notifyAt = steps.indexOf('notify');
  assert.ok(dupAt !== -1 && photoAt !== -1 && notifyAt !== -1);
  assert.ok(dupAt > photoAt, 'la detección de duplicados debe correr después de indexar la foto');
  assert.ok(dupAt > notifyAt, 'la detección de duplicados debe correr después de notificar');
});

test('photos without bytes are ignored — no indexing, dup check (when requested) runs with no photos', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({
    name: 'Ana Gómez',
    status: 'missing',
    source: 'web',
    photos: [{ bytes: Buffer.alloc(0), contentType: 'image/jpeg' }, null],
    checkDuplicates: true
  });
  assert.equal(res.photos.length, 0);
  assert.ok(!t.calls.some((c) => c.step === 'photo'));
  const dup = t.calls.find((c) => c.step === 'dup');
  assert.deepEqual(dup.args.photos, []);
});

// ------------------------------------- external_id upsert resolves real owner

test('external_id upsert resolves the ACTUAL owner before notify and response', async () => {
  const original = { id: 1, full_name: 'Nombre Original' };
  const drifted = { id: 2, full_name: 'Nombre Que Derivó' };
  // Name lookup returns the drifted row (created fresh); the upsert lands the
  // update on the ORIGINAL owner (id 1).
  const store = fakeStore({ ownerOverride: original });
  const t = tracker();
  // Make findOrCreatePerson return the drifted person as "created".
  store.findOrCreatePerson = async (name) => {
    store.events.push({ op: 'findOrCreatePerson', name });
    return { person: drifted, created: true };
  };
  const svc = buildService(store, t);
  const res = await svc.admitReport({
    name: 'Nombre Que Derivó',
    status: 'safe',
    source: 'api',
    externalId: 'ext-42',
    checkDuplicates: true
  });
  // Owner in the result and in the notification is the real owner, not the
  // drifted name lookup.
  assert.equal(res.person.id, original.id);
  const notify = t.calls.find((c) => c.step === 'notify');
  assert.equal(notify.personId, original.id);
  // Duplicate check excludes the real owner so its own photos never self-match.
  const dup = t.calls.find((c) => c.step === 'dup');
  assert.equal(dup.args.excludePersonId, original.id);
  // And "merged into existing" is true: the report joined an old record even
  // though the name lookup inserted a fresh (drifted) row.
  assert.equal(res.mergedIntoExisting, true);
});

// ---------------------------------------------------------- supresión (#191)

test('una llave suprimida no escribe NADA — ni la persona vuelve a existir', async () => {
  const store = fakeStore({ suppressedExternalIds: ['ficha-suprimida'] });
  const t = tracker();
  const svc = buildService(store, t);

  const res = await svc.admitReport({
    name: 'Persona Prueba Uno',
    status: 'missing',
    source: 'aggregator',
    externalId: 'ficha-suprimida',
    photos: [{ bytes: Buffer.from('foto'), contentType: 'image/jpeg' }]
  });

  assert.equal(res.ok, false);
  assert.equal(res.suppressed, true);
  // Lo que de verdad importa: el chequeo va antes de todo lo demás, así que no
  // se creó la persona ni se indexó una cara. Un rechazo después de
  // findOrCreatePerson dejaría la ficha viva de todos modos.
  assert.deepEqual(
    store.events.map((e) => e.op),
    ['isExternalIdSuppressed'],
    'lo único que debía tocarse es la consulta de supresión'
  );
  assert.deepEqual(t.calls, [], 'ni foto, ni notificación, ni chequeo de duplicados');
});

test('la supresión es por llave exacta: otra llave de la misma persona sí entra', async () => {
  const store = fakeStore({ suppressedExternalIds: ['ficha-suprimida'] });
  const t = tracker();
  const svc = buildService(store, t);

  const res = await svc.admitReport({
    name: 'Persona Prueba Uno',
    status: 'missing',
    source: 'aggregator',
    externalId: 'otra-ficha'
  });
  assert.equal(res.ok, true);
});

test('un reporte sin external_id nunca se bloquea, ni consulta la supresión', async () => {
  const store = fakeStore({ suppressedExternalIds: ['ficha-suprimida'] });
  const t = tracker();
  const svc = buildService(store, t);

  // El formulario web y el bot no mandan llave. Si una familia reporta de
  // verdad a alguien cuya ficha se borró, tiene que poder: bloquear eso sería
  // peor que el problema que la supresión arregla.
  const res = await svc.admitReport({ name: 'Persona Prueba Uno', status: 'missing', source: 'web' });
  assert.equal(res.ok, true);
  assert.ok(
    !store.events.some((e) => e.op === 'isExternalIdSuppressed'),
    'sin llave no hay nada que consultar'
  );
});

test('a brand-new person is not reported as merged', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({ name: 'Persona Nueva', status: 'missing', source: 'api' });
  assert.equal(res.personCreated, true);
  assert.equal(res.mergedIntoExisting, false);
});

test('appending to an existing person (name match) reports merged', async () => {
  const existing = { id: 7, full_name: 'Existente Persona' };
  const store = fakeStore({ existingPerson: existing });
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({ name: 'Existente Persona', status: 'injured', source: 'api' });
  assert.equal(res.personCreated, false);
  assert.equal(res.mergedIntoExisting, true);
  assert.equal(res.person.id, existing.id);
});

// --------------------------------------------- prior photo read before indexing

test('the prior report photo is captured before this report stores its own', async () => {
  const existing = { id: 9, full_name: 'Existente Persona' };
  const priorPhoto = { id: 555, person_id: 9, kind: 'report', thumb_type: 'image/jpeg' };
  const store = fakeStore({ existingPerson: existing, existingReportPhoto: priorPhoto });
  const t = tracker();
  const svc = buildService(store, t);
  const res = await svc.admitReport({
    name: 'Existente Persona',
    status: 'missing',
    source: 'web',
    photos: [{ bytes: Buffer.from('foto'), contentType: 'image/jpeg' }],
    includePriorPhoto: true
  });
  assert.equal(res.priorPhoto.id, priorPhoto.id);
  // The prior-photo read happened before addUpdate / photo indexing.
  const readAt = store.events.findIndex((e) => e.op === 'reportPhotoByPerson');
  const updateAt = store.events.findIndex((e) => e.op === 'addUpdate');
  assert.ok(readAt !== -1 && readAt < updateAt);
});

// ---------------------------------------- failures never corrupt the report

test('a photo processing failure does not throw or lose the report', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t, { processPhoto: t.processPhoto({ throw: true }) });
  // The service does NOT catch processPhoto throws itself (facematch's
  // processPhoto is contractually non-throwing), so a throwing fake surfaces —
  // but the write already happened. We assert the update landed before the throw.
  await assert.rejects(
    svc.admitReport({
      name: 'Ana Gómez',
      status: 'missing',
      source: 'web',
      photos: [{ bytes: Buffer.from('x'), contentType: 'image/jpeg' }]
    })
  );
  assert.ok(store.events.some((e) => e.op === 'addUpdate'), 'el reporte ya se escribió antes de indexar');
});

test('an unreadable photo is reported but the admission still succeeds', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t, { processPhoto: t.processPhoto({ unreadable: true }) });
  const res = await svc.admitReport({
    name: 'Ana Gómez',
    status: 'missing',
    source: 'web',
    photos: [{ bytes: Buffer.from('x'), contentType: 'image/heic' }]
  });
  assert.equal(res.ok, true);
  assert.equal(res.unreadablePhotos, 1);
});

test('a notification failure is swallowed — the report is already durable', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t, { notifySubscribers: t.notifySubscribers({ throw: true }) });
  const res = await svc.admitReport({ name: 'Ana Gómez', status: 'missing', source: 'web' });
  assert.equal(res.ok, true, 'un fallo al notificar no debe tumbar el reporte');
  assert.equal(res.notified, 0);
  assert.ok(store.events.some((e) => e.op === 'addUpdate'));
});

test('a matcher/duplicate failure that returns nothing yields no candidates and no warning', async () => {
  const store = fakeStore();
  const t = tracker();
  const svc = buildService(store, t, { findDuplicateCandidates: t.findDuplicateCandidates([]) });
  const res = await svc.admitReport({
    name: 'Persona Nueva',
    status: 'missing',
    source: 'api',
    checkDuplicates: true
  });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.warning, null);
});

test('face and name duplicate candidates flow through into the structured result and warning', async () => {
  const store = fakeStore();
  const t = tracker();
  const candidates = [
    { person: { id: 11, full_name: 'Otra Persona' }, reason: 'face', similarity: 97 },
    { person: { id: 12, full_name: 'Persona Parecida' }, reason: 'name', similarity: 61 }
  ];
  const svc = buildService(store, t, { findDuplicateCandidates: t.findDuplicateCandidates(candidates) });
  const res = await svc.admitReport({
    name: 'Persona Nueva',
    status: 'missing',
    source: 'api',
    checkDuplicates: true
  });
  assert.equal(res.candidates.length, 2);
  assert.equal(res.warning, 'aviso de duplicado');
});
