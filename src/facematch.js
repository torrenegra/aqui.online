// Orchestrates photo storage + face matching + match notifications.
//
// Two photo kinds:
//   'report' — attached to a status update about a person
//   'query'  — attached to a subscription by someone LOOKING for a person
//
// When a new photo matches stored photos of the OPPOSITE kind, the interested
// subscriber(s) get a notification. The notification NEVER includes any photo:
// photos are never shared with anyone, they are used exclusively for face
// comparison.

const env = require('./env');
const {
  sendEmail,
  sendWhatsApp,
  relayEnabled,
  relayToOperators,
  rescueConfirmTemplate,
  rescueSourceTemplate,
  whatsappTemplateLocale
} = require('./notify');
const { storeThumbnail } = require('./thumbs');
const { toMatchable } = require('./photo');
const { hasGeometry, derivativeAction } = require('./report-photo');
const { logMatch, logContact, resultFromSend } = require('./logbook');
const { matcherReady } = require('./faces');

const MAX_QUERY_PHOTOS = 3;

// El texto que puede llegarle a un rescatista cuando alguien reporta como
// desaparecida a la persona que dice haber rescatado.
//
// NO lleva el contacto de la familia, y ese es el punto: este texto es el único
// que se ENVÍA a un tercero, así que la forma de garantizar que el contacto no
// viaje en un mensaje es que no exista acá. La copia que un humano necesita
// para cerrar el caso va aparte, en el bloque `details` del relevo al operador,
// junto a la advertencia de no entregarla sin verificar.
//
// Alcance, para no leer de más: esto cubre lo que se manda. La pantalla del
// resultado de /rescate es otra superficie —`matchContactBlock()` en
// routes/web.js— y este cambio no la toca.
//
// Antes el contacto sí venía en esta cadena, y no salía por WhatsApp solo
// porque `notifyFaceMatch` desviaba ese canal al relevo. Eso hacía que la
// garantía dependiera de una rama del código: cualquier camino de envío nuevo
// —o el que ya existía para correo— la reabría sin tocar esta función. Sacarlo
// de acá convierte la regla en una propiedad del texto, que no tiene ramas.
//
// `similarity` puede venir vacío en avisos viejos, anteriores a que el puntaje
// se guardara junto con la pregunta (`subscriptions.rescue_similarity`). En los
// nuevos siempre viene: sin él, un humano aprueba una entrega sin el único dato
// que distingue un rescate real de un parecido.
function matchText(matchedPerson, similarity, sub) {
  const pct = similarity == null ? '' : ` (${Math.round(similarity)}% de coincidencia facial)`;
  // Sin suscripción no hay a quién dar de baja, y un enlace de baja con el
  // token vacío es un enlace roto en el buzón de un operador.
  const token = sub && sub.verify_token;
  return [
    `🔔 encontrados.co — alguien está buscando a la persona que rescataste${pct}.`,
    `Reportada como desaparecida: *${matchedPerson.full_name}*`,
    `Detalles del reporte: ${env.BASE_URL}/person/${matchedPerson.id}`,
    '',
    'No damos el contacto de su familia por este medio. Si sabes dónde está,',
    'respóndenos por aquí y una persona del equipo sigue el caso: la noticia',
    'de que alguien apareció la tiene que dar alguien que la verificó.',
    '',
    '🔒 Privacidad: la foto que subiste nunca se guardó; solo conservamos su firma facial para poder avisarte.',
    token ? `Para dejar de recibir estos avisos: ${env.BASE_URL}/unsubscribe?token=${token}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

// `updateId` es nuevo (#116, PR 4): los tres llamadores ya tenían a mano el
// update más reciente de matchedPerson antes de invocar esta función, así que
// enhebrarlo acá no cuesta una consulta extra en ningún caso. Es opcional
// (queda null si algún llamador futuro no lo tiene) porque contact_log.update_id
// es nullable a propósito, desde el esquema de PR 3.
async function notifyFaceMatch(store, sub, matchedPerson, similarity, contact, updateId = null) {
  if (!sub) return;
  // Que la suscripción no esté verificada NO es motivo para tirar el aviso.
  //
  // El corte existe para no escribirle a una dirección que quizá no es de quien
  // la escribió, y eso solo puede pasar en el ENVÍO directo. En modo relevo no
  // sale nada hacia afuera: el aviso va al buzón del operador para que una
  // persona decida. Cortar arriba de la bifurcación no protegía a un tercero,
  // nos tapaba la información a nosotros — la coincidencia se descartaba y ni
  // el operador se enteraba, justo en los casos que más necesitan un humano.
  //
  // Así que el corte baja al camino de envío, y el relevo se entera de que la
  // suscripción no está verificada, que es un dato que cambia lo que un humano
  // decide hacer con el aviso.
  const unverified = !sub.verified;
  console.log(
    `[facematch] notifying sub ${sub.id} (${sub.channel}${unverified ? ', SIN verificar' : ''}) about ${matchedPerson.full_name}` +
      (similarity == null ? '' : ` @ ${Math.round(similarity)}%`)
  );
  const text = matchText(matchedPerson, similarity, sub);
  const subject = 'Alguien busca a la persona que rescataste — encontrados.co';

  // El contacto de una familia no sale por NINGÚN canal, y ya no depende de
  // esta rama: `matchText` no lo contiene (ver su nota). Lo que queda acá es
  // otra razón, que sigue en pie por su cuenta.
  //
  // Una suscripción de WhatsApp nace sin verificar —el número lo teclea quien
  // llena el formulario y nadie comprueba que sea suyo— y un texto libre solo
  // se entrega dentro de la ventana de 24 h, que abre una palabra escrita
  // desde ese teléfono. O sea: el canal por el que menos sabemos a quién le
  // estamos hablando. Su primer contacto va por plantilla aprobada
  // (`askRescueConfirmation`), no por este camino; si un aviso de coincidencia
  // llega igual acá, lo enruta una persona.
  const byWhatsApp = sub.channel === 'whatsapp';

  // El aviso más sensible de la app: su destinatario es alguien que dice haber
  // rescatado a la persona, sin que nadie lo haya verificado. En modo relevo no
  // sale solo.
  const alOperador = async (delivered) => {
    const res = await relayToOperators({
      reason:
        'Coincidencia facial con quien dice haber rescatado a esta persona' +
        (unverified ? ' (suscripción SIN verificar)' : ''),
      channel: sub.channel,
      address: sub.address,
      subject,
      text,
      person: matchedPerson,
      delivered,
      details: [
        similarity == null
          ? '⚠️ Sin puntaje de coincidencia facial guardado para este aviso.'
          : `Coincidencia facial: ${Math.round(similarity)}%`,
        unverified
          ? '⚠️ La suscripción NO está verificada: nadie ha comprobado que esa dirección o ese número sean de quien dice haber rescatado a la persona.'
          : 'La suscripción está verificada por su titular.',
        byWhatsApp
          ? 'Este aviso iba a un WhatsApp: el primer contacto por ahí va por plantilla aprobada, no por texto libre, así que se enruta a mano en cualquier modo de envío.'
          : null,
        contact
          ? `Contacto de quien la busca (no entregarlo sin verificar): ${contact}`
          : 'El reporte no trae contacto de quien la busca.'
      ].filter(Boolean)
    });
    // El relevo ES el intento real que ocurrió (nada le llegó directo a
    // sub.address), así que el canal que queda en la bitácora es 'relevo' —
    // no sub.channel — sea cual sea el motivo del relevo.
    await logContact(store, {
      personId: matchedPerson.id,
      updateId,
      channel: 'relevo',
      result: resultFromSend(res)
    });
    return res;
  };

  if (relayEnabled() || byWhatsApp) {
    await alOperador(false);
    return;
  }

  // Envío directo: acá sí, nunca a una dirección que su dueño no confirmó.
  if (unverified) {
    console.warn(
      `[facematch] subscription ${sub.id} is unverified — relevado, pero NUNCA enviado directo`
    );
    // Nada se intentó — ni directo (por no estar verificada) ni relevo (el
    // relevo está apagado, si no habría entrado por la rama de arriba). Es el
    // único 'rechazado' real de esta función: la app decidió no intentar nada.
    await logContact(store, { personId: matchedPerson.id, updateId, channel: sub.channel, result: 'rechazado' });
    return;
  }

  if (sub.channel === 'email') {
    const res = await sendEmail(sub.address, subject, text);
    await logContact(store, { personId: matchedPerson.id, updateId, channel: 'email', result: resultFromSend(res) });
    // El texto que acaba de salir NO lleva el contacto de la familia, así que
    // el caso queda abierto: alguien sabe dónde está una persona y nadie puede
    // avisarle a quien la busca. Por eso el operador recibe igual su copia, con
    // el dato — si no, el mensaje le promete al rescatista un seguimiento que
    // nadie iba a hacer, que es la única mentira que este sistema puede contar
    // y que hace daño de verdad.
    await alOperador(true);
  }
}

// ------------------------------------------- primer contacto con un rescatista
//
// La coincidencia solo existía en la pantalla: si el rescatista cerraba la
// página, no quedaba forma de volver a llegarle. Ahora también sale por sus
// canales, y cada uno tiene su propia regla porque lo que prueban es distinto.
//
//   Correo   — puede llevar los datos. La dirección la acaba de teclear quien
//              está viendo ese mismo contacto en pantalla, así que el mensaje
//              no expone nada nuevo. Igual pasa por notifyFaceMatch: sin
//              verificar va al relevo, jamás a un envío directo.
//   WhatsApp — no puede. Un número tecleado no lo comprueba nadie, y mandarle
//              el teléfono de una familia a un número desconocido es el vector
//              de extorsión que este servicio no puede abrir. Sale la PLANTILLA
//              de confirmación, sin un solo dato de la familia, y la entrega
//              espera a que respondan.
async function notifyRescuerOfMatches(store, { emailSub, phone, matches }) {
  if (!matches || !matches.length) return;
  for (const m of matches) {
    if (emailSub) {
      await notifyFaceMatch(
        store,
        emailSub,
        m.person,
        m.similarity,
        m.update && m.update.contact,
        m.update && m.update.id
      );
    }
  }
  // Una sola pregunta, por la coincidencia más fuerte (matches viene ordenado):
  // preguntar por dos personas distintas convierte un "sí" en una respuesta
  // ambigua, y de esa respuesta depende qué se entrega.
  if (phone && matches[0]) {
    const top = matches[0];
    await requestRescueConfirmation(store, phone, top.person, {
      contact: top.update && top.update.contact,
      similarity: top.similarity
    });
  }
}

// ------------------------------------------------ el estado de la pregunta
//
// Una pregunta de hace un mes ya no es una conversación: contestarla no prueba
// nada sobre dónde está hoy la persona.
const RESCUE_ASK_TTL_HOURS = 72;

function askedAt(sub) {
  const v = Date.parse(sub.rescue_asked_at || sub.created_at);
  return Number.isNaN(v) ? 0 : v;
}

// Las preguntas de rescate vivas para un número, la más reciente primero.
//
// Se filtra por `rescue_state`, NUNCA por `verified`. Son dos hechos distintos
// que antes compartían el mismo booleano: `verified` dice "este número es de
// quien escribe" (lo prueba el bot cuando alguien manda SUSCRIBIR desde él);
// `rescue_state = 'asked'` dice "a este número le preguntamos si tiene consigo
// a esta persona y todavía no responde". Confundirlos hacía que la suscripción
// de un seguidor —verificada, pero que nunca reclamó ningún rescate— se saltara
// la confirmación entera.
async function pendingRescueAsks(store, address, { maxAgeHours = RESCUE_ASK_TTL_HOURS } = {}) {
  if (typeof store.subscriptionsForAddress !== 'function') return [];
  const subs = await store.subscriptionsForAddress('whatsapp', address);
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  return subs
    .filter((s) => s.rescue_state === 'asked' && askedAt(s) >= cutoff)
    .sort((a, b) => askedAt(b) - askedAt(a) || Number(b.id) - Number(a.id));
}

// Paso 1 de la entrega en dos pasos: preguntar, sin entregar nada.
//
// Manda `confirmacion_rescatista_encontrados`, que nombra a UNA persona y pide
// responder SÍ o REPORTE. Devuelve `{ asked, reason, sub }`.
//
// Dos cosas que el orden de este código sostiene:
//
//   1. La fila se escribe DESPUÉS de un envío exitoso. Escribirla antes dejaba
//      un estado "pendiente de confirmación" para una pregunta que nunca salió
//      —por ejemplo con la plantilla sin configurar— y entonces bastaba subir
//      una foto pública con el número propio y escribirle "sí" al bot.
//   2. Una sola pregunta viva por número. La plantilla nombra a una persona; si
//      hubiera dos preguntas abiertas, un "SÍ" no diría por cuál de las dos.
async function requestRescueConfirmation(store, address, person, { contact, similarity } = {}) {
  const name = rescueConfirmTemplate();
  if (!name) {
    console.warn(
      `[facematch:rescate] plantilla de confirmación apagada — no se le preguntó nada a ${address}`
    );
    return { asked: false, reason: 'sin-plantilla' };
  }

  const subs =
    typeof store.subscriptionsForAddress === 'function'
      ? await store.subscriptionsForAddress('whatsapp', address)
      : [];
  const mine = subs.find((s) => String(s.person_id) === String(person.id));

  // Este número ya confirmó por ESTA persona: no hay nada que volver a
  // preguntar, y el aviso sigue el camino de siempre (que para WhatsApp es el
  // relevo). Ojo: la condición es el reclamo confirmado, no `verified` — un
  // número verificado por el bot no reclamó ningún rescate.
  if (mine && mine.rescue_state === 'confirmed') {
    await notifyFaceMatch(store, mine, person, similarity, contact);
    return { asked: false, reason: 'ya-confirmado', sub: mine };
  }

  const pending = await pendingRescueAsks(store, address);
  if (mine && pending.some((s) => String(s.id) === String(mine.id))) {
    // Ya le preguntamos por esta misma persona y sigue sin responder.
    return { asked: false, reason: 'ya-preguntado', sub: mine };
  }
  if (pending.length) {
    console.warn(
      `[facematch:rescate] ${address} ya tiene una pregunta abierta — no se le pregunta por ${person.full_name}`
    );
    const relayRes = await relayToOperators({
      reason: 'Segunda coincidencia para un número que ya tiene una pregunta de rescate abierta',
      channel: 'whatsapp',
      address,
      subject: 'Coincidencia sin preguntar — encontrados.co',
      text: matchText(person, similarity, null),
      person,
      details: [
        'No se le mandó la plantilla: ese número ya tiene otra pregunta de rescate sin responder, y dos preguntas abiertas vuelven ambiguo el "SÍ".',
        similarity == null ? null : `Coincidencia facial: ${Math.round(similarity)}%`,
        // El contacto ya no viaja dentro del texto (ver matchText), así que
        // tiene que venir acá o el operador se queda sin él justo en el caso
        // que más necesita a un humano.
        contact
          ? `Contacto de quien la busca (no entregarlo sin verificar): ${contact}`
          : 'El reporte no trae contacto de quien la busca.'
      ].filter(Boolean)
    });
    await logContact(store, { personId: person.id, updateId: null, channel: 'relevo', result: resultFromSend(relayRes) });
    return { asked: false, reason: 'otra-pregunta-abierta' };
  }

  const res = await sendWhatsApp(address, null, {
    template: { name, locale: whatsappTemplateLocale(), params: [person.full_name] }
  });
  await logContact(store, { personId: person.id, updateId: null, channel: 'whatsapp', result: resultFromSend(res) });
  if (!res.ok) {
    console.error(`[facematch:rescate] la plantilla a ${address} no salió: ${res.error || res.status}`);
    return { asked: false, reason: 'envio-fallido' };
  }

  const { sub } = await store.subscribe(person.id, 'whatsapp', address, { verified: false });
  // El puntaje se guarda ACÁ porque acá es donde existe. La respuesta llega
  // horas después y para entonces ya nadie lo tiene, así que el relevo salía
  // sin el único dato que distingue un rescate real de un parecido.
  await store.setSubscriptionRescue(sub.id, {
    state: 'asked',
    similarity,
    askedAt: new Date().toISOString()
  });
  return { asked: true, sub };
}

// La ficha en el registro público de origen, que es lo ÚNICO que se le manda a
// un rescatista que confirma. Sale de `updates.external_id` de las fichas que
// entraron por un agregador; se exige la forma exacta porque el texto de la
// plantilla manda a marcar a la persona como localizada allá, y mandar a
// alguien a un enlace que no es ese registro es peor que no mandarlo.
const SOURCE_FICHA_RE = /^https?:\/\/(www\.)?colombiatebusca\.com\/\?person=[0-9a-fA-F-]{36}$/;

async function sourceFichaUrl(store, personId) {
  if (typeof store.getUpdates !== 'function') return null;
  for (const u of await store.getUpdates(personId)) {
    const ext = String(u.external_id || '').trim();
    if (u.source === 'aggregator' && SOURCE_FICHA_RE.test(ext)) return ext;
  }
  return null;
}

// Paso 2: contestaron la pregunta, desde su propio número.
//
// Lo que sale de acá hacia el rescatista NO es el contacto de la familia — por
// WhatsApp eso no sale nunca. Sale `ficha_fuente_rescatista_encontrados`, que
// le dice que nosotros no tenemos ese contacto y que la familia sí, y lo manda
// a marcar a la persona como localizada en el registro donde ellos la buscan.
// Por eso un "sí" falsificado o ambiguo cuesta, como mucho, un enlace a un
// registro público.
//
// Una respuesta resuelve UNA pregunta: la última que le llegó a ese teléfono.
// Antes resolvía TODAS las pendientes del número, así que dos usos de /rescate
// el mismo día entregaban las dos personas con un solo "sí".
//
// Devuelve null si ese número no tenía nada pendiente — ahí "sí" es una palabra
// cualquiera y el mensaje se procesa como siempre.
async function resolveRescueAnswer(store, address, { answer, maxAgeHours = RESCUE_ASK_TTL_HOURS } = {}) {
  const pending = await pendingRescueAsks(store, address, { maxAgeHours });
  if (!pending.length) return null;

  const [sub, ...rest] = pending;
  if (rest.length) {
    console.warn(
      `[facematch:rescate] ${address} tiene ${pending.length} preguntas abiertas — se resuelve solo la última (sub ${sub.id})`
    );
  }
  const person = await store.getPerson(sub.person_id);
  if (!person) return null;

  // Responder desde el propio número prueba que el número le pertenece. Eso, y
  // nada más: el reclamo de rescate vive aparte, en rescue_state.
  await store.verifySubscription(sub.verify_token);

  if (answer === 'reporte') {
    // Dijo que lo que hizo fue reportarla, no que la tenga consigo. No es un
    // rescatista: no se le manda ninguna ficha ni se le entrega nada.
    await store.setSubscriptionRescue(sub.id, { state: 'reported' });
    console.log(`[facematch:rescate] ${address} respondió REPORTE por ${person.full_name}`);
    return { answer: 'reporte', person: person.full_name, sent: false };
  }

  await store.setSubscriptionRescue(sub.id, { state: 'confirmed' });
  const latest = await store.getLatestUpdate(person.id);
  const similarity = sub.rescue_similarity == null ? null : Number(sub.rescue_similarity);

  // El operador recibe el cuadro completo: el contacto de la familia y el
  // puntaje de la coincidencia que originó la pregunta.
  await notifyFaceMatch(
    store,
    { ...sub, verified: true },
    person,
    similarity,
    latest && latest.contact,
    latest && latest.id
  );

  const ficha = await sourceFichaUrl(store, person.id);
  const template = rescueSourceTemplate();
  if (!ficha || !template) {
    // Una ficha reportada por la web no tiene registro de origen a donde
    // mandarlo, y no hay ninguna plantilla aprobada para ese caso. Inventar una
    // no es una opción: Meta solo entrega lo aprobado, y el texto de un mensaje
    // en este flujo es una decisión de privacidad, no de redacción. Queda en
    // manos del operador, que ya recibió el relevo de arriba.
    console.log(
      `[facematch:rescate] confirmación de ${address} por ${person.full_name} sin ficha de origen — solo relevo`
    );
    return { answer: 'si', person: person.full_name, ficha: null, sent: false };
  }
  const res = await sendWhatsApp(address, null, {
    template: {
      name: template,
      locale: whatsappTemplateLocale(),
      params: [person.full_name, ficha]
    }
  });
  await logContact(store, {
    personId: person.id,
    updateId: latest && latest.id,
    channel: 'whatsapp',
    result: resultFromSend(res)
  });
  if (!res.ok) {
    console.error(`[facematch:rescate] la ficha a ${address} no salió: ${res.error || res.status}`);
  }
  return { answer: 'si', person: person.full_name, ficha, sent: !!res.ok };
}

// Search the collection for a stored photo, index it, and notify on cross-kind
// matches. Shared by live uploads and the backfill of previously-stored photos.
async function matchStoredPhoto(store, matcher, photo, bytes) {
  const { id, person_id: personId, kind, update_id: updateId, subscription_id: subscriptionId } = photo;

  // Search BEFORE indexing so the photo never matches itself.
  const matches = await matcher.searchByImage(bytes);
  console.log(`[facematch] photo ${id} (${kind}) → ${matches.length} raw match(es)`);

  // Esta misma persona ya tiene esta foto exacta indexada — un reporte
  // re-empujado por el agregador trae los mismos bytes cada vez (#160). Sin
  // esto, cada re-empuje sumaba una firma nueva por la misma cara: hasta 118
  // para una sola persona, medido en producción. Reusar el face_id evita la
  // llamada a IndexFaces; detectFace da la geometría para la miniatura sin
  // volver a indexar (mismo patrón que ya usa backfillPhotoDerivatives para
  // no duplicar una cara que ya está en la colección).
  //
  // Best effort, no atómico a propósito: leer photoFaceIdForContent y llamar
  // indexFace son dos pasos separados por una llamada de red a Rekognition, y
  // esta app corre en varias instancias serverless sin estado compartido para
  // serializarlos. Dos re-empujes de la MISMA foto llegando casi al mismo
  // instante podrían leer null los dos y sumar dos firmas en vez de una — una
  // ventana angosta (el caso real del issue es un re-crawl días después, no
  // dos empujes simultáneos) que reduce el problema de "cada re-empuje" a
  // "una carrera puntual", no lo cierra del todo. Cerrarla exigiría una
  // reclamación atómica entre instancias, que es una decisión de arquitectura
  // aparte y no cabe en este PR.
  const reusedFaceId = await store.photoFaceIdForContent(personId, kind, bytes);
  let faceId, geometry;
  if (reusedFaceId) {
    faceId = reusedFaceId;
    geometry = await matcher.detectFace(bytes);
    console.log(`[facematch] photo ${id} (${kind}) usa una firma existente`);
  } else {
    ({ faceId, geometry } = await matcher.indexFace(bytes, id));
  }
  if (faceId) await store.setPhotoFaceId(id, faceId);
  // Report photos are shown publicly: they get the geometry to draw and the
  // face thumbnail the listing loads instead of the full image.
  if (kind === 'report') await storeThumbnail(store, id, bytes, geometry);
  if (!matches.length) return 0;

  const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));
  const matchedPhotos = (await store.photosByFaceIds([...bySimilarity.keys()])).filter(
    (p) => p.kind !== kind
  );

  // Superficie del match_log (#116, PR 4): 'report' cuando la foto nueva es un
  // reporte (llegó por la web o por POST /api/updates), 'api' cuando es una
  // foto de consulta subida por POST /api/people/:id/subscriptions — la única
  // otra puerta que crea fotos kind='query' aparte de /rescate (que tiene su
  // propia superficie 'rescate', ver identifyRescuedPerson). Invariante que
  // sostiene la fila: person_id y face_id SIEMPRE vienen del mismo lado — el
  // lado reportado/encontrado — así que face_id siempre resuelve a una foto
  // de esa misma persona.
  const surface = kind === 'report' ? 'report' : 'api';

  let notified = 0;
  for (const mp of matchedPhotos) {
    const similarity = bySimilarity.get(mp.face_id) || 0;
    if (kind === 'report') {
      // A missing-person report matched a rescued face → alert that rescuer.
      const sub = await store.getSubscriptionById(mp.subscription_id);
      const person = await store.getPerson(personId);
      const latest = await store.getLatestUpdate(personId);
      await logMatch(store, { personId, updateId, faceId, similarity, surface });
      await notifyFaceMatch(store, sub, person, similarity, latest && latest.contact, updateId);
    } else {
      // A rescued face matched an existing report → alert this rescuer.
      const sub = await store.getSubscriptionById(subscriptionId);
      const person = await store.getPerson(mp.person_id);
      const latest = await store.getLatestUpdate(mp.person_id);
      await logMatch(store, {
        personId: mp.person_id,
        updateId: mp.update_id,
        faceId: mp.face_id,
        similarity,
        surface
      });
      await notifyFaceMatch(store, sub, person, similarity, latest && latest.contact, mp.update_id);
    }
    notified++;
  }
  return notified;
}

// Store a photo, then match it. Returns the stored photo row (no bytes).
async function processPhoto(store, matcher, { personId, kind, updateId, subscriptionId, bytes, contentType }) {
  // Convert before storing, not just before matching: the stored bytes are
  // what GET /photo/:id later hands to a browser, and a HEIC renders as a
  // broken image everywhere except Safari.
  const usable = await toMatchable(bytes, contentType);

  const photo = await store.addPhoto({
    personId,
    kind,
    updateId,
    subscriptionId,
    content: usable ? usable.bytes : bytes,
    contentType: usable ? usable.contentType : contentType
  });

  if (!usable) {
    // The report itself is the family's data and is already durable — losing
    // it over an unreadable attachment is never the right trade. But the photo
    // cannot do the one job it was uploaded for, so mark it and let the caller
    // say so out loud rather than let the person believe the face is indexed.
    console.warn(
      `[facematch] photo ${photo.id} ilegible (${contentType}) — guardada sin indexar ni miniatura`
    );
    photo.unreadable = true;
    return photo;
  }
  const content = usable.bytes;

  if (!(await matcherReady(matcher))) {
    console.warn(
      `[facematch] matcher disabled — photo ${photo.id} stored WITHOUT indexing (will be picked up by /api/reindex)`
    );
    // The listing still needs something light to show, so build the thumbnail
    // anyway — centred, since nothing told us where the face is.
    if (kind === 'report') await storeThumbnail(store, photo.id, content, null);
    return photo;
  }
  try {
    await matchStoredPhoto(store, matcher, photo, content);
  } catch (e) {
    // Matching must never break reporting or subscribing.
    console.error('[facematch]', e);
  }
  return photo;
}

// Index photos that were stored while face matching was unavailable, and run
// matching for them so missed coincidences still reach the people waiting.
async function backfillUnindexedPhotos(store, matcher, limit = 100) {
  if (!(await matcherReady(matcher))) {
    return { ok: false, error: 'El reconocimiento facial no está activo.', processed: 0 };
  }
  const pending = await store.photosMissingFaceId(limit);
  let indexed = 0;
  let notified = 0;
  let noFace = 0;
  for (const photo of pending) {
    try {
      const bytes = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
      notified += await matchStoredPhoto(store, matcher, photo, bytes);
      indexed++;
    } catch (e) {
      console.error(`[facematch:backfill] photo ${photo.id} failed:`, e.message);
      noFace++;
    }
  }
  console.log(
    `[facematch:backfill] pendientes=${pending.length} procesadas=${indexed} avisos=${notified} fallidas=${noFace}`
  );
  return { ok: true, pending: pending.length, processed: indexed, notifications: notified, failed: noFace };
}

// Bring already-stored report photos up to date: the detection geometry the
// public overlay needs, and the face thumbnail the listing loads. Idempotent
// and safe to run repeatedly — it only looks at photos still missing one.
//
// Geometry comes from DetectFaces, not IndexFaces: these photos are already in
// the collection, and re-indexing them would register a duplicate face.
// Thumbnails don't need Rekognition at all, so they are still generated (as a
// centred crop) when face matching is unavailable.
async function backfillPhotoDerivatives(store, matcher, limit = 100) {
  // Una sola lectura para toda la corrida: el mismo valor que `derivativeAction`
  // y el loop de abajo usan varias veces, en vez de que cada uso vuelva a leer
  // el getter perezoso (#89).
  //
  // Ventana angosta que esto introduce, señalada en revisión: si el matcher
  // pasa de apagado a encendido A MITAD de esta corrida —otra request en la
  // misma instancia lo despierta con su propio ensureReady()— la versión
  // anterior (que releía `matcher.enabled` en cada vuelta) lo notaba y
  // arrancaba a indexar lo que quedaba en ESTA corrida; con `ready` cacheado
  // acá, esas fotos quedan pendientes hasta la SIGUIENTE corrida del barrido.
  // No se pierde nada —siguen en `photosMissingDerivatives`—, solo se demora.
  // Cachear sigue siendo lo correcto (evita leer el getter suelto varias
  // veces por vuelta); el matiz es que ya no es cero diferencia observable.
  const ready = await matcherReady(matcher);
  const pending = await store.photosMissingDerivatives(limit);
  let thumbs = 0;
  let geometries = 0;
  let waiting = 0;
  let failed = 0;
  let noFace = 0;

  for (const photo of pending) {
    // Already thumbnailed, and only Rekognition could add what's missing.
    // Redoing the centred crop would change nothing, so leave it for later —
    // otherwise this photo looks "pending" forever while matching is down.
    if (derivativeAction(photo, ready) === 'skip') {
      waiting++;
      continue;
    }
    try {
      const bytes = Buffer.isBuffer(photo.content) ? photo.content : Buffer.from(photo.content);
      let geometry = hasGeometry(photo) ? photo.face_detail : null;
      if (!geometry && ready) {
        geometry = await matcher.detectFace(bytes);
        if (geometry) geometries++;
      }
      const thumb = await storeThumbnail(store, photo.id, bytes, geometry);
      if (thumb) {
        thumbs++;
        if (!geometry && ready) {
          // Rekognition looked and found no face. Without a mark, this photo
          // re-enters photosMissingDerivatives on EVERY run and gets a
          // DetectFaces call each time, forever — the pending counter never
          // reaches 0 and the loop burns Rekognition on photos that will
          // never yield a box. storeThumbnail just rewrote face_detail, so
          // the mark goes on top of what it stored.
          await store.setPhotoFaceDetail(photo.id, { crop: thumb.crop, no_face: true });
          noFace++;
        }
      } else {
        failed++;
      }
    } catch (e) {
      console.error(`[facematch:derivatives] photo ${photo.id} failed:`, e.message);
      failed++;
    }
  }

  console.log(
    `[facematch:derivatives] pendientes=${pending.length} miniaturas=${thumbs} geometrias=${geometries} sin_rostro=${noFace} esperando=${waiting} fallidas=${failed}`
  );
  return {
    ok: true,
    // What this run could actually act on. Anything counted in `waiting` needs
    // Rekognition back before it can move.
    processed: pending.length - waiting,
    thumbnails: thumbs,
    geometry: geometries,
    no_face: noFace,
    waiting,
    failed,
    face_matching: ready
  };
}

// The rescuer flow: identify who is looking for the person in front of you.
// The photo is NEVER stored — it is compared, its face signature is indexed so
// future reports can reach this rescuer, and the bytes are dropped immediately.
//
// `searchOnly` apaga esa indexación: compara contra la colección, devuelve las
// coincidencias y NO deja nada — ni firma facial en Rekognition, ni fila de
// foto, ni la persona ancla que las sostiene.
//
// El costo es exactamente la funcionalidad más valiosa: sin firma indexada, esa
// consulta NUNCA va a recibir el aviso posterior de "alguien reportó a esta
// persona". La opción que da más privacidad quita la que más sirve, y por eso
// no es el comportamiento por omisión de nadie: es una casilla que alguien
// marca a sabiendas, con el costo escrito al lado.
async function identifyRescuedPerson(
  store,
  matcher,
  { bytes, contentType, personId, subscriptionId, searchOnly = false }
) {
  if (!(await matcherReady(matcher))) {
    return { available: false, matches: [] };
  }

  // A format Rekognition refuses used to throw straight through this function
  // and out of the route, and the rescuer — holding a person, in the field —
  // got "Error interno del servidor" and no idea what to do next.
  const usable = await toMatchable(bytes, contentType);
  if (!usable) return { available: true, unreadable: true, matches: [] };

  let matches;
  try {
    matches = await matcher.searchByImage(usable.bytes);
  } catch (e) {
    // searchByImage already treats "no face in this image" as an empty result,
    // so anything landing here is Rekognition itself failing. Degrade to "try
    // again in a moment"; never a 500 on the one screen a rescuer is using.
    console.error('[facematch:rescue] búsqueda fallida:', e.name, e.message);
    return { available: false, matches: [] };
  }
  const bySimilarity = new Map(matches.map((m) => [m.faceId, m.similarity]));

  // Index the face so a later missing-person report can alert this rescuer,
  // then immediately drop the image bytes. En modo solo-búsqueda esto es
  // justamente lo que no pasa: la consulta se resuelve con lo que ya está
  // indexado y no agrega nada a la colección.
  let photo = null;
  if (!searchOnly) {
    photo = await store.addPhoto({
      personId,
      kind: 'query',
      subscriptionId,
      content: Buffer.alloc(0),
      contentType: usable.contentType
    });
    try {
      const { faceId } = await matcher.indexFace(usable.bytes, photo.id);
      if (faceId) await store.setPhotoFaceId(photo.id, faceId);
      // No geometry is stored for a rescuer's photo: the image is dropped on
      // the next line, so there would be nothing to draw it over.
    } catch (e) {
      console.error('[facematch:rescue] index failed:', e.message);
    }
    await store.clearPhotoContent(photo.id);
  }

  // Which missing-person reports does this face correspond to?
  const found = [];
  const seen = new Set();
  const photos = await store.photosByFaceIds([...bySimilarity.keys()]);
  for (const mp of photos.filter((x) => x.kind === 'report')) {
    if (seen.has(mp.person_id)) continue;
    seen.add(mp.person_id);
    const person = await store.getPerson(mp.person_id);
    if (!person) continue;
    const latest = await store.getLatestUpdate(mp.person_id);
    // El teléfono al que hay que llamar puede NO estar en el último update, y
    // eso no es un borde: un aviso de rescatista queda como el más reciente y
    // su `contact` es de un tercero, así que filtrarlo (#120) tapaba también el
    // contacto que la familia sí había dejado en un reporte anterior. Que una
    // familia no reciba la llamada es exactamente el daño que esto existe para
    // evitar, así que la pantalla busca el contacto más reciente que de verdad
    // sea de quien la busca, no el del update más nuevo.
    //
    // `updatesForPerson` viene ordenado por fecha descendente en los dos
    // adaptadores, así que el primero que cumple es el más reciente.
    const contactUpdate =
      latest && latest.contact && latest.source !== 'rescate'
        ? latest
        : (await store.getUpdates(mp.person_id)).find((u) => u.contact && u.source !== 'rescate') || null;
    found.push({
      person,
      similarity: bySimilarity.get(mp.face_id) || 0,
      update: latest,
      contactUpdate
    });
  }
  found.sort((a, b) => b.similarity - a.similarity);

  // Bitácora de coincidencias (#116, PR 4), superficie 'rescate' — el caso de
  // éxito más importante que la app tenía invisible: un rescatista vio esto en
  // pantalla, y hasta ahora no quedaba ni rastro. Un row por persona encontrada
  // en `found` (ya deduplicado por persona arriba, a propósito: es el mismo
  // conjunto que ve el rescatista y el que dispara notifyRescuerOfMatches).
  // Se registra pase lo que pase con searchOnly — el match es real haya
  // quedado indexada la firma del rescatista o no.
  for (const f of found) {
    await logMatch(store, {
      personId: f.person.id,
      updateId: f.update ? f.update.id : null,
      faceId: photos.find((x) => x.person_id === f.person.id && x.kind === 'report')?.face_id,
      similarity: f.similarity,
      surface: 'rescate'
    });
  }

  return { available: true, matches: found, photoId: photo ? photo.id : null, indexed: !!photo };
}

// ¿Cuántas veces ya sirvió el matcher? Hoy nadie lo sabe: un match se pinta en
// pantalla y se evapora — ninguna tabla lo registra (#116). Pero las firmas
// faciales sí quedaron en la colección, así que la historia se puede
// RECOMPUTAR: por cada foto de consulta indexada se busca por face_id y se
// cuenta contra qué reportes coincide hoy.
//
// Devuelve SOLO cifras agregadas. Esto es instrumentación, no un registro de
// personas: ni un nombre, ni un contacto, ni un id de persona sale de acá.
// Los detalles ya viven en las tablas de siempre, detrás de sus propias reglas.
//
// Dos honestidades del número: es el cruce contra la colección de HOY (una
// firma borrada ya no cuenta, una indexada después sí), y si `failed` > 0 las
// cifras son un piso, no el total.
const MATCH_STATS_CONCURRENCY = 3;

async function computeMatchStats(store, matcher) {
  if (!(await matcherReady(matcher))) return null;

  const rows = await store.indexedPhotos();
  const byFaceId = new Map(rows.map((r) => [r.face_id, r]));
  const queries = rows.filter((r) => r.kind === 'query');
  // Universo de personas reportadas (desaparecidas) que sí tienen al menos una
  // foto indexada — el denominador honesto del embudo del reporte por correo
  // (#116, PR 2): "solo estas pueden coincidir". Se calcula directo de `rows`,
  // sin ningún costo extra: son las mismas filas que ya se leyeron arriba.
  const reportedPeopleIndexed = new Set(
    rows.filter((r) => r.kind === 'report').map((r) => r.person_id)
  );

  const stats = {
    generated_at: new Date().toISOString(),
    // Cuántas firmas hay de cada lado del cruce.
    indexed: { query: queries.length, report: rows.length - queries.length },
    searched: 0,
    failed: 0,
    // Fotos de consulta (rescatista o quien busca) que hoy coinciden con al
    // menos un reporte — el cruce que es la razón de ser de la app.
    query_photos_with_report_match: 0,
    // La misma cara consultada más de una vez (reintentos, o dos rescatistas
    // con la misma persona al frente).
    query_photos_with_query_match: 0,
    // Personas distintas a cada lado de los cruces de arriba.
    reported_people_matched: 0,
    query_people_matched: 0,
    // Personas reportadas con foto utilizable — el universo de partida del
    // embudo (ver arriba). No es rows.length: eso cuenta FOTOS, y una persona
    // puede tener varias.
    reported_people_indexed: reportedPeopleIndexed.size,
    // Coincidencias individuales contra el lado reportado, sin deduplicar por
    // persona ni por foto: una persona con varias fotos, o una foto de quien
    // busca que golpea a varias personas, suman más de una acá. Es el "31" del
    // embudo aprobado — la fila de abajo (reported_people_matched) es la
    // versión deduplicada por persona.
    report_matches_total: 0,
    // Coincidencias contra firmas que ya no tienen foto en la base: quedaron
    // colgadas en la colección al borrar una persona (#71). Trabajo de limpieza.
    // Cuenta GOLPES, no firmas huérfanas distintas — una misma firma huérfana
    // que golpea dos veces suma dos acá.
    dangling_face_matches: 0
  };

  const reportedPeople = new Set();
  const queryPeople = new Set();

  async function searchOne(q) {
    let matches;
    try {
      matches = await matcher.searchByFaceId(q.face_id);
    } catch (e) {
      console.error(`[facematch:stats] search failed for photo ${q.id}:`, e.message);
      stats.failed++;
      return;
    }
    stats.searched++;
    let hitReport = false;
    let hitQuery = false;
    for (const m of matches) {
      const row = byFaceId.get(m.faceId);
      if (!row) {
        stats.dangling_face_matches++;
        continue;
      }
      if (row.kind === 'report') {
        hitReport = true;
        stats.report_matches_total++;
        reportedPeople.add(row.person_id);
        queryPeople.add(q.person_id);
      } else {
        hitQuery = true;
      }
    }
    if (hitReport) stats.query_photos_with_report_match++;
    if (hitQuery) stats.query_photos_with_query_match++;
  }

  // Pool chico a propósito: Rekognition tiene tope de búsquedas por segundo y
  // esto corre dentro de una función serverless con reloj. ~100 firmas a
  // concurrencia 3 salen en pocos segundos sin rozar el throttling.
  let next = 0;
  const workers = Array.from({ length: MATCH_STATS_CONCURRENCY }, async () => {
    while (next < queries.length) {
      await searchOne(queries[next++]);
    }
  });
  await Promise.all(workers);

  stats.reported_people_matched = reportedPeople.size;
  stats.query_people_matched = queryPeople.size;
  return stats;
}

// Retira de la colección las firmas faciales que ya perdieron su ficha. La
// firma no vive en la base: vive en Rekognition, así que ninguna cascada la
// toca, y sin esto sobrevivía al borrado para siempre — una foto de rescatista
// seguiría coincidiendo con alguien cuya ficha ya no existe, y quedaría un dato
// biométrico retenido sin el registro que lo justificaba.
//
// Recibe los ids en vez de ir a buscarlos: para cuando esto corre, la cascada
// ya se llevó las filas de `photos`, así que hay que leerlos ANTES del borrado
// y pasarlos acá (ver la ruta DELETE en src/routes/api.js, y el mismo patrón
// para bajas de suscripción en src/routes/web.js y src/bot.js — #162).
//
// Best effort a propósito: la política de privacidad promete el borrado, así
// que un Rekognition caído NO puede bloquearlo. Lo que no se pudo confirmar se
// devuelve y se loguea, porque los ids ya no están en ninguna parte de donde
// volver a leerlos.
//
// `label` es solo para ese log: quien llama identifica lo que se borró
// ("persona 91", "suscripción 44") sin que acá haya que saber de qué se trata.
async function forgetPersonFaces(matcher, faceIds, label) {
  const faceMatching = await matcherReady(matcher);

  const ids = (faceIds || []).filter(Boolean);
  if (!ids.length) {
    return { total: 0, deleted: 0, unconfirmed: [], face_matching: faceMatching };
  }

  let result;
  try {
    result = await matcher.deleteFaces(ids);
  } catch (e) {
    // El proveedor no debería lanzar (el suyo atrapa por lote), pero la
    // garantía tiene que ser estructural y no depender de que se porte bien.
    console.error('[facematch:olvido] DeleteFaces falló:', e.name, e.message);
    result = { deleted: [], unconfirmed: ids };
  }

  const unconfirmed = result.unconfirmed || [];
  if (unconfirmed.length) {
    // El único rastro duradero: la respuesta HTTP se la lleva quien llamó, y
    // los ids ya no están en la base para reintentarlo desde ahí.
    console.error(
      `[facematch:olvido] ${label}: ${unconfirmed.length} firma(s) sin retirar de la colección —`,
      unconfirmed.join(', ')
    );
  }
  return {
    total: ids.length,
    deleted: (result.deleted || []).length,
    unconfirmed,
    face_matching: faceMatching
  };
}

module.exports = {
  processPhoto,
  identifyRescuedPerson,
  forgetPersonFaces,
  notifyRescuerOfMatches,
  requestRescueConfirmation,
  resolveRescueAnswer,
  backfillUnindexedPhotos,
  backfillPhotoDerivatives,
  computeMatchStats,
  MAX_QUERY_PHOTOS
};
