// Shared person/update/subscription logic over a storage adapter (SQLite or Postgres).
// All fuzzy-matching decisions live here so both backends behave identically.
const crypto = require('crypto');
const { normalize, phoneticKey, titleCaseName, matchScore } = require('./names');
const { logMerge } = require('./logbook');
const { canonicalDepartment } = require('./departments');

const STATUSES = ['safe', 'injured', 'missing', 'deceased', 'unknown'];
// 'aggregator': updates pushed by an external data aggregator, distinct from
// the app's own web/whatsapp/api channels (see POST /api/updates).
const SOURCES = ['web', 'whatsapp', 'api', 'aggregator'];

// Nombre ancla que POST /rescate (src/routes/web.js) le da a la persona
// "encontrada" que un rescatista fotografía en campo — no tiene nombre real,
// así que se le da uno sintético con un sufijo aleatorio. El panel de
// estadísticas (#132) necesita reconocer estas personas para contar "personas
// fotografiadas por un rescatista", y sin tocar el esquema la única señal que
// existe es este patrón de nombre. Vive acá, exportado, para que web.js (quien
// lo crea) y report.js (quien lo cuenta) compartan la MISMA constante en vez
// de dos copias del mismo string que se puedan desincronizar en silencio.
const RESCUE_ANCHOR_PREFIX = 'Persona rescatada ';
// La forma en la que ese prefijo queda guardado en normalized_name (minúsculas,
// sin tildes) — derivada con la misma normalize() que usa el resto del
// esquema, no una copia a mano de la regla.
const RESCUE_ANCHOR_NORMALIZED_PREFIX = `${normalize(RESCUE_ANCHOR_PREFIX)} `;

// La edad declarada, o null si no llegó o no es creíble.
//
// El rango (0..120) no está para validarle nada a nadie: está para que un dedazo
// —«2024» en la casilla de edad, un año en vez de una edad— no se guarde como
// una señal que después separe a dos reportes de la misma persona. Fuera de
// rango se trata como "no declarado", que es lo que en realidad es.
//
// Se redondea porque la comparación de #150 es por margen de años: media edad
// no significa nada y complicaría el tipo de la columna en los dos motores.
// Solo número o texto: `Number(true)` es 1 y `Number([7])` es 7, así que un
// JSON con `"age": true` entraría como una edad declarada de un año.
function parseAge(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const age = Math.round(n);
  return age >= 0 && age <= 120 ? age : null;
}

// Postgres returns Date objects; SQLite returns strings. Present ISO strings everywhere.
function isoRow(row) {
  if (row && row.created_at instanceof Date) {
    return { ...row, created_at: row.created_at.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }
  return row;
}

function createStore(adapter) {
  async function getPerson(id) {
    return isoRow(await adapter.getPerson(id));
  }

  // Fuzzy search: adapter prefilters candidates, JS scorer ranks them.
  async function searchPeople(query, { limit = 5, minScore = 0.55 } = {}) {
    const q = normalize(query);
    if (!q) return [];
    const candidates = await adapter.candidatePeople(q, phoneticKey(query));
    return candidates
      .map((p) => ({ ...isoRow(p), score: matchScore(q, p.normalized_name) }))
      .filter((p) => p.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Reuse an existing person when the name confidently matches; otherwise create.
  async function findOrCreatePerson(fullName) {
    const norm = normalize(fullName);
    if (!norm) throw new Error('Name is required');
    const exact = await adapter.exactByNormalized(norm);
    if (exact) return { person: isoRow(exact), created: false };
    const [best] = await searchPeople(fullName, { limit: 1, minScore: 0.85 });
    if (best) {
      // #150: solo la fusión difusa (por score) se registra — un match exacto
      // sobre el mismo normalized_name no es una decisión discutible.
      await logMerge(adapter, { personId: best.id, submittedName: fullName, score: best.score });
      return { person: await getPerson(best.id), created: false };
    }
    // Only new people are re-cased: an existing row keeps whatever it has, so
    // a correction made by hand isn't undone by the next report.
    const person = await adapter.insertPerson(titleCaseName(fullName), norm, phoneticKey(fullName));
    return { person: isoRow(person), created: true };
  }

  // `department` y `age` son las señales con las que #150 separa a dos personas
  // que comparten un nombre parecido. Se guardan canonicalizadas o no se
  // guardan: un departamento fuera de la lista entra como null, porque un valor
  // que no compara con nada es indistinguible de no tener el dato.
  //
  // La normalización vive acá y no en cada handler por la misma razón que
  // `normalizeSourceUrl` vive en report-admission: una regla repetida en tres
  // puertas es una regla que se afloja en dos de ellas sin que nadie lo note.
  async function addUpdate(
    personId,
    { status, message, location, lat, lng, source, sourceUrl, reporter, contact, externalId, department, age }
  ) {
    if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
    return isoRow(
      await adapter.insertUpdate(personId, {
        status,
        message,
        location,
        lat,
        lng,
        source,
        sourceUrl,
        reporter,
        contact,
        externalId,
        department: canonicalDepartment(department),
        age: parseAge(age)
      })
    );
  }

  // Re-case names stored before titleCaseName existed (or typed straight into
  // the API). Only the display name changes: normalized_name and phonetic_name
  // are case-insensitive, so nothing about matching moves.
  async function updatePersonName(id, fullName) {
    return adapter.updatePersonName(id, fullName);
  }

  async function recasePersonNames(limit = 500) {
    const people = await adapter.allPeople(limit);
    const fixed = [];
    for (const p of people) {
      const cased = titleCaseName(p.full_name);
      if (cased && cased !== p.full_name) {
        await adapter.updatePersonName(p.id, cased);
        fixed.push({ id: p.id, from: p.full_name, to: cased });
      }
    }
    return { checked: people.length, fixed };
  }

  // Everyone reported missing — the home page listing.
  async function getMissingPeople(limit = 50) {
    return (await adapter.missingPeople(limit)).map(isoRow);
  }

  // How many people whose LATEST status is 'safe' — the "reencontradas" count.
  async function getReunitedCount() {
    return adapter.reunitedCount();
  }

  async function getUpdates(personId) {
    return (await adapter.updatesForPerson(personId)).map(isoRow);
  }

  async function getLatestUpdate(personId) {
    return isoRow(await adapter.latestUpdate(personId));
  }

  async function getRecentUpdates(limit = 20) {
    return (await adapter.recentUpdates(limit)).map(isoRow);
  }

  // Every subscription gets a unique token, used for the unsubscribe link and —
  // for email — the verification link. Email starts unverified; WhatsApp is
  // verified implicitly (the sender messages from their own number).
  //
  // Ese "implícitamente" vale solo para el bot, donde el número lo entrega Meta
  // y por lo tanto es del que escribe. Un número TECLEADO en un formulario web
  // no trae esa prueba: puede ser el de cualquiera. Quien lo crea puede decirlo
  // con `{ verified: false }` en vez de heredar una suposición que ahí es falsa.
  //
  // `needsVerification` significa una sola cosa: "hay que mandarle el correo de
  // verificación a esta dirección". Sin el calificador de canal, un número de
  // teléfono sin verificar pedía un correo que nunca iba a llegar a ninguna
  // parte, y la API respondía `pending_verification: true` por algo que no
  // estaba pendiente sino que era imposible. Un número NO se verifica por
  // correo: se verifica cuando su dueño escribe desde él.
  async function subscribe(personId, channel, address, { verified: asVerified } = {}) {
    const addr0 = String(address || '').trim();
    if (!addr0) throw new Error('Address is required');
    const addr = channel === 'email' ? addr0.toLowerCase() : addr0;
    const existing = await adapter.findSubscription(personId, channel, addr);
    if (existing) {
      return {
        sub: existing,
        created: false,
        needsVerification: channel === 'email' && !existing.verified
      };
    }
    const token = crypto.randomBytes(16).toString('hex');
    const verified = asVerified === undefined ? channel !== 'email' : !!asVerified;
    const sub = await adapter.insertSubscription(personId, channel, addr, verified, token);
    return { sub, created: true, needsVerification: channel === 'email' && !verified };
  }

  // El estado del reclamo de rescate, aparte de `verified` (ver el esquema).
  // state: 'asked' | 'confirmed' | 'reported' | null
  async function setSubscriptionRescue(id, fields) {
    return adapter.setSubscriptionRescue(id, fields || {});
  }

  async function verifySubscription(token) {
    if (!token) return null;
    return adapter.verifySubscriptionByToken(String(token));
  }

  async function unsubscribeByToken(token) {
    if (!token) return null;
    return adapter.deleteSubscriptionByToken(String(token));
  }

  async function unsubscribe(personId, channel, address) {
    return adapter.deleteSubscription(personId, channel, address);
  }

  async function unsubscribeAll(channel, address) {
    return adapter.deleteSubscriptionsForAddress(channel, address);
  }

  async function getSubscriptions(personId) {
    return adapter.subscriptionsForPerson(personId);
  }

  // Todas las suscripciones de una dirección o número, sin importar a qué
  // persona sigan. Es como se responde "¿a este número le preguntamos algo y
  // sigue esperando respuesta?" cuando llega un mensaje entrante: la única
  // identidad que trae es el número desde el que escribe.
  async function subscriptionsForAddress(channel, address) {
    const addr0 = String(address || '').trim();
    if (!addr0) return [];
    return adapter.subscriptionsForAddress(channel, channel === 'email' ? addr0.toLowerCase() : addr0);
  }

  async function getSubscriptionById(id) {
    return adapter.getSubscriptionById(id);
  }

  async function addPhoto(fields) {
    return adapter.insertPhoto(fields);
  }

  async function setPhotoFaceId(photoId, faceId) {
    return adapter.setPhotoFaceId(photoId, faceId);
  }

  async function setPhotoFaceDetail(photoId, detail) {
    return adapter.setPhotoFaceDetail(photoId, detail);
  }

  // Postgres returns JSONB already parsed; SQLite returns the raw JSON text.
  function withParsedDetail(photo) {
    if (!photo) return photo;
    const raw = photo.face_detail;
    if (typeof raw !== 'string') return photo;
    try {
      return { ...photo, face_detail: JSON.parse(raw) };
    } catch {
      return { ...photo, face_detail: null };
    }
  }

  async function getPhoto(id) {
    return withParsedDetail(await adapter.getPhoto(id));
  }

  // Metadata for one report photo — enough to render it, without pulling the
  // image bytes. Returns null for a rescuer's photo, which is never rendered.
  async function getReportPhotoMeta(id) {
    return withParsedDetail(await adapter.reportPhotoMeta(id));
  }

  // The public listing shows at most one photo per person. Both adapters order
  // by (person_id, has-geometry, id), so the first row per person wins.
  async function reportPhotoByPerson(personIds) {
    const rows = await adapter.reportPhotosForPeople(personIds);
    const byPerson = new Map();
    for (const row of rows) {
      if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, withParsedDetail(row));
    }
    return byPerson;
  }

  async function setPhotoThumbnails(photoId, sizes) {
    return adapter.setPhotoThumbnails(photoId, sizes);
  }

  async function photosMissingDerivatives(limit = 100) {
    return (await adapter.photosMissingDerivatives(limit)).map(withParsedDetail);
  }

  async function clearPhotoContent(photoId) {
    return adapter.clearPhotoContent(photoId);
  }

  async function photosByFaceIds(faceIds) {
    return adapter.photosByFaceIds(faceIds);
  }

  async function photoFaceIdForContent(personId, kind, content) {
    return adapter.photoFaceIdForContent(personId, kind, content);
  }

  async function indexedPhotos() {
    return adapter.indexedPhotos();
  }

  async function countQueryPhotos(subscriptionId) {
    return adapter.countQueryPhotos(subscriptionId);
  }

  async function photosMissingFaceId(limit = 100) {
    return adapter.photosMissingFaceId(limit);
  }

  async function counts() {
    return adapter.counts();
  }

  // Face signatures of every photo anchored to this person — the report photos
  // AND any rescuer 'query' rows attached to a subscription on them. Read this
  // before deletePerson: the cascade takes the photo rows with it.
  async function faceIdsForPerson(personId) {
    return adapter.faceIdsForPerson(personId);
  }

  // Deletes the person and, by cascade, their reports, subscriptions and photos.
  //
  // `options` viaja tal cual al adaptador. El único que existe hoy es
  // `atSubjectRequest`, que marca el borrado del ARCO — el que además deja
  // constancia de las llaves externas con las que la ficha podría volver a
  // entrar (#191). Sin esa constancia el borrado se deshace con un re-envío.
  async function deletePerson(id, options) {
    return isoRow(await adapter.deletePerson(id, options));
  }

  // ¿Esta llave externa es de una ficha que se borró a solicitud de su titular?
  // La consulta el ingreso ANTES de crear (src/report-admission.js), que es el
  // único lugar donde alcanza a impedir que la ficha vuelva.
  async function isExternalIdSuppressed(externalId) {
    return adapter.isExternalIdSuppressed(externalId);
  }

  // Serializa, por external_id, el chequeo-y-escritura de una admisión contra
  // la ventana en la que `deletePerson({ atSubjectRequest: true })` suprime esa
  // misma llave (#192). Pass-through directo: cada adaptador implementa el
  // lock con lo que tiene — advisory lock de sesión en Postgres, mutex en
  // memoria en SQLite — pero el contrato es el mismo para quien lo llama.
  async function withExternalIdLock(externalId, fn) {
    return adapter.withExternalIdLock(externalId, fn);
  }

  // Bitácora de coincidencias y envíos (#116, PR 4). Pass-through directo:
  // src/logbook.js ya se encarga de que un fallo acá nunca suba.
  async function insertMatchLog(fields) {
    return adapter.insertMatchLog(fields);
  }

  async function insertContactLog(fields) {
    return adapter.insertContactLog(fields);
  }

  async function insertMergeLog(fields) {
    return adapter.insertMergeLog(fields);
  }

  // ---- Cola de revisión de estado (#190) --------------------------------
  // Pass-through, igual que la bitácora: la lógica de qué significa una ficha
  // en la cola y de qué hace falta para resolverla vive en
  // src/statusReview.js, no acá.
  //
  // El límite por omisión es alto a propósito: es una cola de trabajo que una
  // persona tiene que vaciar, no un listado paginado, y una ficha que no se
  // ve es una ficha que sigue publicada como buscada.
  async function getUnknownPeople(limit = 200) {
    return (await adapter.unknownPeople(limit)).map(isoRow);
  }

  async function insertStatusReview(fields) {
    return isoRow(await adapter.insertStatusReview(fields));
  }

  async function statusReviewsForPerson(personId) {
    return (await adapter.statusReviewsForPerson(personId)).map(isoRow);
  }

  async function matchLogCounts(opts) {
    return adapter.matchLogCounts(opts);
  }

  async function contactLogCounts(opts) {
    return adapter.contactLogCounts(opts);
  }

  async function matchLogDaily(opts) {
    return adapter.matchLogDaily(opts);
  }

  async function contactLogDaily(opts) {
    return adapter.contactLogDaily(opts);
  }

  async function matchLogEarliest() {
    return adapter.matchLogEarliest();
  }

  async function contactLogEarliest(opts) {
    return adapter.contactLogEarliest(opts);
  }

  async function deleteContactLogByRef(externalRef) {
    return adapter.deleteContactLogByRef(externalRef);
  }

  // Normaliza igual que getPerson/getUpdates: Postgres entrega `created_at`
  // como Date y SQLite como string ISO, y el consumidor (el bloque de avisos
  // de la ficha) se lo pasa a timeTag() sin distinguir. Sin isoRow, el
  // atributo datetime del <time> sale con la forma del motor —o sea, distinto
  // en producción que en la suite, que corre sobre SQLite.
  async function familyContactLogByPerson(personId) {
    return (await adapter.familyContactLogByPerson(personId)).map(isoRow);
  }

  // Cifras del panel #132 — pass-through directo, igual que el resto de la
  // bitácora: la lógica de qué significan vive en report.js, no acá.
  async function updatesBeyondFirstBySource() {
    return adapter.updatesBeyondFirstBySource();
  }

  async function queryPhotoPeople() {
    return adapter.queryPhotoPeople();
  }

  async function matchLogSimilarityRows() {
    return adapter.matchLogSimilarityRows();
  }

  return {
    STATUSES,
    SOURCES,
    getPerson,
    searchPeople,
    findOrCreatePerson,
    updatePersonName,
    recasePersonNames,
    addUpdate,
    getUpdates,
    getLatestUpdate,
    getRecentUpdates,
    getMissingPeople,
    getReunitedCount,
    subscribe,
    verifySubscription,
    unsubscribeByToken,
    unsubscribe,
    unsubscribeAll,
    getSubscriptions,
    subscriptionsForAddress,
    getSubscriptionById,
    setSubscriptionRescue,
    addPhoto,
    setPhotoFaceId,
    setPhotoFaceDetail,
    setPhotoThumbnails,
    getPhoto,
    getReportPhotoMeta,
    reportPhotoByPerson,
    clearPhotoContent,
    photosByFaceIds,
    photoFaceIdForContent,
    indexedPhotos,
    countQueryPhotos,
    photosMissingFaceId,
    photosMissingDerivatives,
    counts,
    faceIdsForPerson,
    deletePerson,
    isExternalIdSuppressed,
    withExternalIdLock,
    insertMatchLog,
    insertContactLog,
    insertMergeLog,
    getUnknownPeople,
    insertStatusReview,
    statusReviewsForPerson,
    matchLogCounts,
    contactLogCounts,
    matchLogDaily,
    contactLogDaily,
    matchLogEarliest,
    contactLogEarliest,
    deleteContactLogByRef,
    familyContactLogByPerson,
    updatesBeyondFirstBySource,
    queryPhotoPeople,
    matchLogSimilarityRows,
    close: () => adapter.close()
  };
}

module.exports = { createStore, STATUSES, SOURCES, RESCUE_ANCHOR_PREFIX, RESCUE_ANCHOR_NORMALIZED_PREFIX };
