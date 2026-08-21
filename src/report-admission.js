// Shared report-admission domain flow.
//
// One report arrives — from the web form (POST /report), the JSON API
// (POST /api/updates) or the WhatsApp bot (handleInbound) — and the same
// sequence of business rules has to run every time:
//
//   1. Validate and normalize the input.
//   1b. Refuse a report whose external_id was suppressed by a deletion request
//      (#191) — before anything is written, so nothing gets re-created. Steps
//      1b through 4 run under a per-external_id lock shared with `deletePerson`
//      (#192) — see the comment at the top of that block for why.
//   2. Find or create the person by name.
//   3. Add (or, with external_id, upsert) the update.
//   4. Resolve the ACTUAL owner of the update. external_id can land the row on
//      a different person than the name lookup returned; from here on the owner
//      is the one thing every downstream step must agree on. This used to be
//      done only in the API route even though it is a system invariant.
//   5. Index the report photos.
//   6. Notify eligible subscribers, skipping the reporter's own addresses so
//      nobody gets their own report echoed back.
//   7. Run duplicate detection LAST, once the report is durable, indexed and
//      notified — see the note on `checkDuplicates` below for why.
//   8. Return a structured result the caller renders as HTML, JSON or WhatsApp
//      text. No transport detail leaks in here.
//
// Everything after the durable write (steps 5–7) is a courtesy: a photo,
// matcher or notification failure degrades to a warning and NEVER corrupts or
// discards the report the family just filed. That is the one outcome an
// emergency service must never produce.
//
// The route/bot handlers stay thin: they translate transport-specific input
// into `admitReport(...)` arguments and translate the structured result back
// into their own response shape.

const { STATUSES, SOURCES } = require('./people');
const notifyModule = require('./notify');
const duplicatesModule = require('./duplicates');
const facematchModule = require('./facematch');

// El enlace a la fuente pública que respalda un reporte — hoy, la noticia que
// dice que una persona apareció.
//
// Se normaliza acá y no en cada handler por la misma razón que existe este
// módulo: el valor termina siendo un href clickeable en la ficha de una persona
// desaparecida, que lee su familia. Un `javascript:` o un `data:text/html`
// guardado ahí sería un hueco de seguridad servido a quien menos puede
// permitírselo, y una regla repetida en tres puertas es una regla que se afloja
// en dos de ellas sin que nadie lo note.
//
// Un enlace inválido se descarta con un log y NO tumba el reporte: perder el
// aviso de que alguien apareció por culpa de un enlace mal formado sería peor
// que ignorar el enlace.
function normalizeSourceUrl(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn('[report-admission] source_url descartado, no es una URL');
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(`[report-admission] source_url descartado, protocolo ${parsed.protocol}`);
    return null;
  }
  return parsed.href;
}

// Dependencies are injected so the service can be tested directly with fakes.
// Defaults are the real modules, so a caller that only passes { store, matcher }
// gets production behavior.
function createReportAdmission({
  store,
  matcher,
  notifySubscribers = notifyModule.notifySubscribers,
  findDuplicateCandidates = duplicatesModule.findDuplicateCandidates,
  duplicateWarning = duplicatesModule.duplicateWarning,
  processPhoto = facematchModule.processPhoto
} = {}) {
  if (!store) throw new Error('report-admission requires a store');

  // photos: array of { bytes, contentType } already decoded by the caller. The
  // service never touches multipart, base64 or WhatsApp media APIs — that is
  // transport detail the handler owns.
  //
  // sourceUrl: the public link backing this report. Every entry point can pass
  // it and gets the same http(s)-only rule; today only the JSON API has an
  // input where a link exists (the web form has no such field and the WhatsApp
  // grammar has no such token), so the other two simply leave it unset. That is
  // a transport difference, not a behavior one — the day the form grows a
  // "link to the news" field it passes `sourceUrl` and inherits the rule.
  //
  // checkDuplicates / includePriorPhoto: each is its own Rekognition call or
  // extra store read, and only the web form and (for duplicates) the JSON API
  // render anything from them — the WhatsApp bot's reply never mentions a
  // possible duplicate. Both default to off so a caller that won't use the
  // result doesn't pay for it; web.js and api.js opt in explicitly.
  async function admitReport({
    name,
    status,
    message = null,
    location = null,
    lat,
    lng,
    source,
    sourceUrl = null,
    reporter = null,
    contact = null,
    externalId,
    photos = [],
    skipAddresses = [],
    checkDuplicates = false,
    includePriorPhoto = false
  }) {
    // ---- 1. Validate and normalize -------------------------------------
    const errors = [];
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) errors.push('Falta el nombre de la persona.');
    if (!STATUSES.includes(status)) {
      errors.push(`El estado debe ser uno de: ${STATUSES.join(', ')}.`);
    }
    if (errors.length) {
      return { ok: false, errors };
    }
    const cleanSource = SOURCES.includes(source) ? source : 'api';
    const cleanSourceUrl = normalizeSourceUrl(sourceUrl);
    const usablePhotos = (photos || []).filter((p) => p && p.bytes && p.bytes.length);

    // ---- 1b–4. ¿Está suprimida? Si no, buscar/crear y escribir el update --
    // Todo este tramo corre bajo el MISMO lock por external_id que sostiene
    // `deletePerson` mientras suprime esa llave (#192, `withExternalIdLock` en
    // los dos adaptadores). Sin el lock, el chequeo de abajo podía dar "no
    // suprimida" y quedar en el aire — por un `await` cualquiera de los que ya
    // había entre el chequeo y la escritura— mientras un DELETE concurrente
    // suprimía esa misma llave y se llevaba la fila; cuando este código
    // seguía, escribía igual y la ficha revivía sin log ni error (hallazgo de
    // coderabbitai en el PR). Adentro del lock solo va lo que decide SI la
    // ficha se recrea o no; la indexación de fotos y las notificaciones
    // (pasos 5-7, más abajo) siguen afuera a propósito: son best-effort y no
    // tienen por qué sostener un lock mientras esperan a Rekognition o a
    // SendGrid.
    //
    // Sin external_id no hay llave que proteger, así que no hay lock que
    // pedir: un reporte sin external_id no compite con nada (#191).
    const admit = async () => {
      // ---- 1b. ¿La llave de este reporte está suprimida? -------------------
      // Alguien pidió el borrado de su ficha (DELETE /api/people/:id) y eso
      // dejó constancia de la llave con la que había entrado. Sin este chequeo
      // el borrado no es durable: la fila ya no existe, así que el
      // ON CONFLICT (external_id) del upsert no aplica y un re-envío de la
      // misma ficha inserta de nuevo — persona nueva, foto nueva y la cara
      // reindexada, sin log ni error.
      //
      // El issue lo pedía en POST /api/updates; vive acá porque acá es donde
      // la frase "protege contra cualquier ruta de ingreso" es verdad. Este
      // servicio es la secuencia compartida de las tres puertas (web, API,
      // WhatsApp) y de la que se agregue mañana; en el handler del API solo
      // protegería a ese handler.
      //
      // El alcance es la MISMA llave externa, y el límite es deliberado: un
      // reporte sin external_id no se bloquea nunca. Si una familia reporta a
      // esa persona de verdad más adelante —por el formulario, que no manda
      // llave— tiene que poder. Lo que se suprime es la re-entrada automática
      // de una ficha, no el derecho de nadie a reportar. Hoy solo el API
      // acepta external_id, así que las otras dos puertas no pueden llegar
      // hasta acá.
      //
      // Va ANTES de findOrCreatePerson a propósito: más adelante ya habría una
      // persona creada, que es justo lo que hay que evitar.
      if (externalId && (await store.isExternalIdSuppressed(externalId))) {
        return {
          ok: false,
          suppressed: true,
          errors: ['Esta ficha se borró a solicitud de la persona y no se vuelve a crear.']
        };
      }

      // ---- 2. Find or create the person ----------------------------------
      const { person, created } = await store.findOrCreatePerson(cleanName);

      // Read the record's existing report photo BEFORE this report's own
      // photos are stored — afterwards there is no way to tell which face was
      // already there and which one just arrived. That pre-existing face is
      // the whole point of the "possible duplicate" comparison the web page
      // draws, which is the only caller that asks for it.
      const priorPhoto =
        includePriorPhoto && !created
          ? (await store.reportPhotoByPerson([person.id])).get(person.id) || null
          : null;

      // ---- 3. Add / upsert the update ------------------------------------
      const update = await store.addUpdate(person.id, {
        status,
        message,
        location,
        lat,
        lng,
        source: cleanSource,
        sourceUrl: cleanSourceUrl,
        reporter,
        contact,
        externalId
      });

      // ---- 4. Resolve the ACTUAL owner -----------------------------------
      // With external_id the upsert may have landed on a different person
      // than the one just looked up (the aggregator's name for this
      // external_id drifted). Resolve who actually owns the timeline row
      // before notifying, so alerts never reach the wrong subscribers and the
      // response never reports the wrong person. This is a system invariant,
      // not an API detail.
      const owner =
        update.person_id === person.id
          ? person
          : (await store.getPerson(update.person_id)) || person;

      // "This report was appended to a record that already existed." Read
      // from where the update ACTUALLY landed, not from the name lookup: with
      // external_id the upsert can keep its original person while
      // findOrCreatePerson inserted a fresh row for the drifted name.
      const mergedIntoExisting = !created || String(owner.id) !== String(person.id);

      return { ok: true, person, created, priorPhoto, update, owner, mergedIntoExisting };
    };

    const admitted = externalId ? await store.withExternalIdLock(externalId, admit) : await admit();
    if (!admitted.ok) return admitted;
    const { created, priorPhoto, update, owner, mergedIntoExisting } = admitted;

    // ---- 5. Index the report photos ------------------------------------
    // processPhoto never throws for a matcher/Rekognition failure — it stores
    // the photo and marks it unreadable at worst, so the report stays intact.
    const storedPhotos = [];
    for (const p of usablePhotos) {
      storedPhotos.push(
        await processPhoto(store, matcher, {
          personId: owner.id,
          kind: 'report',
          updateId: update.id,
          bytes: p.bytes,
          contentType: p.contentType
        })
      );
    }
    const unreadablePhotos = storedPhotos.filter((p) => p && p.unreadable).length;

    // ---- 6. Notify eligible subscribers --------------------------------
    // Skip the reporter's own addresses so they don't get their own report
    // echoed back. A notification failure must never break the report, so any
    // throw here is swallowed — the write above is already durable.
    let notified = 0;
    try {
      notified = await notifySubscribers(store, owner, update, {
        skipAddresses: (skipAddresses || []).filter(Boolean)
      });
    } catch (e) {
      console.error('[report-admission] notificación falló:', e && e.message);
    }

    // ---- 7. Duplicate detection LAST, once the report is durable -------
    // Everything above is the family's data and a courtesy already delivered;
    // this is a courtesy still pending. Running the face searches first meant
    // a slow Rekognition call — or a serverless timeout inside it — could take
    // the whole report down with it, or at least take photo indexing and
    // subscriber notification down with it. Advisory only and NEVER throws
    // (see src/duplicates.js). By the time this runs the photos are already
    // indexed and would match themselves; excludePersonId drops every hit on
    // this record, so self-matching is a non-issue, exactly as it was before
    // this flow was unified (#87).
    const candidates = checkDuplicates
      ? await findDuplicateCandidates(store, matcher, {
          name: cleanName,
          photos: usablePhotos.map((p) => p.bytes),
          excludePersonId: owner.id
        })
      : [];

    // ---- 8. Structured result ------------------------------------------
    return {
      ok: true,
      person: owner,
      personCreated: created,
      update,
      photos: storedPhotos,
      unreadablePhotos,
      mergedIntoExisting,
      priorPhoto,
      candidates,
      warning: duplicateWarning({ mergedIntoExisting, candidates }),
      notified
    };
  }

  return { admitReport };
}

module.exports = { createReportAdmission, normalizeSourceUrl };
