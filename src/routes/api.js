const crypto = require('crypto');
const express = require('express');
const env = require('../env');
const {
  sendVerificationEmail,
  notifyMode,
  relayEnabled,
  avisoEmail
} = require('../notify');
const { STATUSES } = require('../people');
const {
  processPhoto,
  forgetPersonFaces,
  backfillUnindexedPhotos,
  backfillPhotoDerivatives,
  computeMatchStats,
  MAX_QUERY_PHOTOS
} = require('../facematch');
const { backfillUnindexedPetPhotos } = require('../petmatch');
const { publicUpdate } = require('../privacy');
const gh = require('../github');
const { sendReport } = require('../report');
const { createReportAdmission } = require('../report-admission');
const { logApiWrite } = require('../logbook');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Llaves de API con alcance
//
// Hasta acá el API tenía UNA llave: la variable de entorno API_KEY, que abre
// las siete superficies con llave —incluido el DELETE irreversible que se
// lleva las firmas faciales, y el correo de prueba a cualquier dirección desde
// el dominio—. Darle esa llave a alguien para que aporte datos era darle
// escritura total a producción sobre datos de personas desaparecidas.
//
// Ahora hay dos alcances, y la diferencia entre ellos es todo el punto:
//
//   operator  Lo de siempre. API_KEY sigue siendo un principal de este
//             alcance, así que el barrido de la ingesta, el cron del reporte y
//             el DELETE siguen funcionando sin cambiar nada.
//   ingest    Una sola ruta (POST /api/updates) y, dentro de ella, la
//             escritura menos peligrosa que existe en el sistema: agregar o
//             corregir una ficha de persona reportada como desaparecida. No
//             puede marcar a nadie como localizado ni fallecido, no puede
//             pisar fichas que no creó, y ninguna de sus escrituras le manda un
//             aviso a nadie.
//
// Estas tres funciones viven en ESTE archivo a propósito, y vale decir por qué:
// el hash ES la verificación, así que sacarlas a un módulo nuevo las mudaría a
// una ruta sin freno en .github/CODEOWNERS, donde un cambio a hashApiKey se
// podría aprobar sin que decida una persona. Acá el archivo ya está restringido.
// ---------------------------------------------------------------------------

const API_SCOPES = ['operator', 'ingest'];

// Prefijo en claro que se guarda para poder distinguir dos llaves en una lista
// sin tener el secreto de ninguna. Ocho caracteres alcanzan para reconocerla y
// no alcanzan para nada más.
const API_KEY_PREFIX_LENGTH = 8;

// 32 bytes aleatorios. No hace falta bcrypt para verificar algo así: no es una
// contraseña que haya que estirar contra un diccionario, es una llave que nadie
// va a adivinar. base64url para poder pegarla en una cabecera y en una terminal
// sin escaparla.
function generateApiKey() {
  return crypto.randomBytes(32).toString('base64url');
}

// SHA-256 hex — lo ÚNICO que se guarda de la llave. La llave en claro se
// muestra una sola vez, al emitirla: perdida, se revoca y se emite otra.
function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

function apiKeyPrefix(key) {
  return String(key).slice(0, API_KEY_PREFIX_LENGTH);
}

// --- El alcance de una llave de ingesta, en números ------------------------
// Todo esto se decide EN SERVIDOR e ignora lo que diga el cuerpo del request:
// un alcance que el llamador pueda declarar no es un alcance.

// Los dos estados que una llave de ingesta puede AFIRMAR. Marcar a alguien como
// localizado, herido o fallecido cambia lo que lee su familia en la ficha y, en
// el camino normal, le manda un correo: eso se queda en la llave de operación.
//
// Pero lo que llega afuera de esta lista NO se rechaza y NO se convierte en
// 'missing'. Ese es el punto delicado de todo el alcance, así que va escrito:
// buena parte de lo que un voluntario va a encontrar en fuentes públicas es
// gente que YA APARECIÓ, y volver eso 'missing' sería tomar un artículo que dice
// "fue encontrada sana y salva" y publicar que sigue desaparecida — peor que no
// ingerir nada. Se coerciona a 'unknown', el estado de estacionamiento que este
// repo ya usa para exactamente esto: el adaptador del registro público manda
// "Localizada sin vida" a 'unknown' a propósito, porque "adivinar sobre la
// muerte de alguien no se hace solo" (ver STATUS_BY_LABEL en
// src/sources/colombiatebusca.js). Acá se reusa ese principio, no se inventa
// uno.
//
// Y nunca en silencio: la respuesta dice qué se pidió, qué quedó guardado y por
// qué, para que quien empuja sepa que su hallazgo entró como candidato a
// revisión y no como verdad publicada.
const INGEST_STATUSES = ['missing', 'unknown'];
const INGEST_PARKED_STATUS = 'unknown';

// Techo por llave y por hora. Hoy no existe ninguno para nadie en ninguna ruta
// de /api; este es el primero. Se cuenta sobre api_write_log y no en memoria
// porque en Vercel hay varias instancias, y un contador por instancia
// multiplica el techo por el número de instancias.
const INGEST_WRITES_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;

// Cada cuánto vale la pena reescribir last_used_at. Sin throttle, cada request
// de una llave activa sería un UPDATE por un dato que a nadie le importa al
// segundo.
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

// { base64, content_type } → { bytes, contentType } (null if invalid/too big)
function decodePhoto(p) {
  if (!p || typeof p.base64 !== 'string') return null;
  try {
    const bytes = Buffer.from(p.base64, 'base64');
    if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return null;
    return { bytes, contentType: p.content_type || 'image/jpeg' };
  } catch {
    return null;
  }
}

// Turn SendGrid's raw response into an actionable sentence in Spanish.
function emailVerdict(email) {
  if (!email.sendgrid_key_present) {
    return 'SENDGRID_API_KEY no está definida en este entorno de Vercel. Agrégala en Settings → Environment Variables (Production) y vuelve a desplegar.';
  }
  if (!email.sendgrid_key_looks_valid) {
    return `La clave no empieza por "SG." (empieza por "${email.sendgrid_key_prefix}"), así que no parece una API key de SendGrid. Genera una en SendGrid → Settings → API Keys con permiso "Mail Send".`;
  }
  const t = email.test || {};
  if (t.ok) return 'Correo enviado correctamente. Si no llega, revisa spam y la Activity Feed de SendGrid.';
  const err = String(t.error || '');
  if (t.status === 401) {
    return 'SendGrid rechazó la clave (401). Genera una nueva API key con permiso "Mail Send" y actualízala en Vercel.';
  }
  if (t.status === 403) {
    if (/Sender Identity|from address/i.test(err)) {
      return `SendGrid rechaza el remitente ${email.from} (403): no está verificado. Verifícalo en SendGrid → Settings → Sender Authentication (Single Sender o dominio). Alternativa inmediata: define EMAIL_FROM en Vercel con un remitente ya verificado.`;
    }
    return `SendGrid devolvió 403: la clave existe pero no tiene permiso "Mail Send", o el remitente ${email.from} no está verificado.`;
  }
  if (t.error && /fetch/i.test(err)) {
    return 'El entorno no pudo hacer la petición HTTP a SendGrid (fetch falló). Revisa la versión de Node en Vercel.';
  }
  return `SendGrid respondió ${t.status || 'sin estado'}: ${err.slice(0, 300)}`;
}

function apiRoutes(store, matcher, petStore, petMatcher) {
  const router = express.Router();
  router.use(express.json({ limit: '16mb' }));

  const admission = createReportAdmission({ store, matcher });

  // La MISMA secuencia de admisión, con una sola diferencia: no notifica a
  // nadie. Una llave de ingesta reporta a alguien como desaparecido, y eso no
  // es una novedad que haya que empujarle por correo a una familia que está
  // esperando noticias — el peor caso de una llave descuidada no puede ser un
  // aviso falso a quien más lo está esperando.
  //
  // Se arma con la costura de inyección que report-admission.js ya expone, en
  // vez de agregarle una bandera: de ese módulo también cuelgan el formulario
  // web y el bot de WhatsApp, y no hay razón para tocarlo por esto.
  const ingestAdmission = createReportAdmission({
    store,
    matcher,
    notifySubscribers: async () => 0
  });

  // Los dos principales que no tienen fila en api_keys.
  const OPERATOR_ENV = { scope: 'operator', id: null, label: 'API_KEY (entorno)' };
  const OPERATOR_OPEN = { scope: 'operator', id: null, label: 'sin llave configurada' };

  // ¿Quién está escribiendo? Devuelve un principal, o { rejected: <motivo> }.
  //
  // Sin caché a propósito: revocar una llave tiene que surtir efecto en el
  // request siguiente, no cuando expire un TTL.
  async function resolvePrincipal(req) {
    const auth = (req.get('authorization') || '').trim();
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m ? m[1].trim() : '';

    if (token && env.API_KEY && token === env.API_KEY) return OPERATOR_ENV;

    if (token) {
      const row = await store.apiKeyByHash(hashApiKey(token));
      if (row) {
        if (row.revoked_at) return { rejected: 'revocada' };
        await noteKeyUsage(row);
        return { scope: row.scope, id: row.id, label: row.label };
      }
      // Un token presentado que no corresponde a NINGUNA llave conocida se
      // rechaza, incluso sin API_KEY configurada. Antes caía al modo abierto de
      // desarrollo (ver abajo), o sea que equivocarse de llave ABRÍA en vez de
      // cerrar. Es el único cambio de comportamiento observable de este PR.
      return { rejected: 'desconocida' };
    }

    // Sin cabecera de autorización se conserva el comportamiento documentado de
    // siempre (agent.md, "Variables de entorno"): sin API_KEY configurada los
    // POST del API quedan ABIERTOS, para poder desarrollar en local sin ninguna
    // credencial. Es la única puerta que falla abierta y sigue siendo
    // deliberada, pero ahora tiene una condición VERIFICADA en vez de escrita
    // (ver modoAbiertoSigueValido).
    if (!env.API_KEY && (await modoAbiertoSigueValido())) return OPERATOR_OPEN;
    return { rejected: 'ausente' };
  }

  // El modo abierto solo es seguro mientras NO exista ninguna llave emitida.
  // Antes eso era un párrafo de documentación, y documentarlo no lo evitaba: en
  // un despliegue con llaves emitidas y API_KEY sin configurar, una petición SIN
  // cabecera recibía OPERATOR_OPEN, o sea alcance de operador completo. Emitirle
  // una llave `ingest` acotada a un voluntario le abría, de hecho, la puerta
  // grande a cualquier anónimo. Ahora se verifica.
  //
  // Se puede cachear en UN SOLO sentido porque el predicado es monótono: una
  // fila de api_keys no se borra nunca —revocar solo marca revoked_at (ver el
  // DDL)—, así que "no hay ninguna llave" puede volverse falso pero nunca vuelve
  // a ser cierto. Por eso el `false` se recuerda para siempre (cero consultas
  // por request desde que exista una llave) y el `true` se vuelve a preguntar,
  // que es lo que hace que emitir la primera llave cierre la puerta en el
  // request siguiente sin reiniciar nada. En producción API_KEY está
  // configurada, así que este camino ni se toca.
  let sinLlavesEmitidas = null;
  async function modoAbiertoSigueValido() {
    if (sinLlavesEmitidas === false) return false;
    try {
      sinLlavesEmitidas = (await store.apiKeysList()).length === 0;
    } catch (e) {
      // Ante la duda, cerrado. Y sin cachear: un fallo de base no es una
      // respuesta sobre si hay llaves.
      console.error('[api-keys] no se pudo verificar si hay llaves emitidas — se cierra la puerta:', e.message);
      return false;
    }
    return sinLlavesEmitidas;
  }

  // "Último uso", con throttle y en un solo statement (ver el adapter). Se
  // ESPERA en vez de dispararse y olvidarse: en serverless la instancia se
  // puede congelar en cuanto sale la respuesta, y una escritura suelta se
  // pierde. Nunca puede tumbar el request.
  async function noteKeyUsage(row) {
    try {
      const now = Date.now();
      await store.touchApiKeyUsed(
        row.id,
        new Date(now).toISOString(),
        new Date(now - LAST_USED_THROTTLE_MS).toISOString()
      );
    } catch (e) {
      console.error(`[api-keys] no se pudo anotar el último uso de la llave ${row.id}:`, e.message);
    }
  }

  // Exige llave Y alcance. Las lecturas de información de personas siguen
  // abiertas, igual que siempre: la información de emergencia quiere ser
  // encontrada.
  const requireScope = (...allowed) =>
    wrap(async (req, res, next) => {
      const principal = await resolvePrincipal(req);
      if (principal.rejected) {
        // Se distingue "revocada" de "inválida" a propósito: quien opera estas
        // llaves es un voluntario, y "te la revocamos" y "la escribiste mal"
        // llevan a acciones distintas. El precio es confirmarle a quien
        // presenta un token que ese token existió; a cambio, el dueño legítimo
        // entiende qué pasó sin tener que escribirle a nadie.
        const error =
          principal.rejected === 'revocada'
            ? 'Esta llave de API fue revocada'
            : 'API key inválida o ausente';
        return res.status(401).json({ error });
      }
      if (!allowed.includes(principal.scope)) {
        return res.status(403).json({
          error: `Esta llave tiene alcance "${principal.scope}" y esta ruta exige ${allowed
            .map((scope) => `"${scope}"`)
            .join(' o ')}.`
        });
      }
      req.apiPrincipal = principal;
      next();
    });

  // Lo que antes era requireKey: alcance de operación y nada más.
  const requireOperator = requireScope('operator');
  // La única ruta que una llave de ingesta puede tocar.
  const requireWriter = requireScope('operator', 'ingest');

  // GET /api/people?q=juan perez — fuzzy search
  router.get(
    '/people',
    wrap(async (req, res) => {
      const q = req.query.q || '';
      if (!q.trim()) return res.status(400).json({ error: 'Falta el parámetro q' });
      const matches = await store.searchPeople(q, { limit: 10 });
      const results = await Promise.all(
        matches.map(async (p) => ({
          id: p.id,
          full_name: p.full_name,
          score: p.score,
          latest_update: publicUpdate(await store.getLatestUpdate(p.id))
        }))
      );
      res.json({ results });
    })
  );

  // GET /api/people/:id — person + full timeline
  router.get(
    '/people/:id',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });
      res.json({
        id: person.id,
        full_name: person.full_name,
        updates: (await store.getUpdates(person.id)).map(publicUpdate)
      });
    })
  );

  // POST /api/updates — report status by name (creates the person if new)
  // { name, status, message?, location?, reporter?, source?, source_url?, external_id?,
  //   photo?: { base64, content_type } }
  // The photo is used ONLY for face matching; it is never displayed or shared.
  // - source: one of 'web'|'whatsapp'|'api'|'aggregator'; defaults to 'api' if
  //   omitted or not one of those values (e.g. an aggregator identifying itself).
  // - source_url: public link backing this report — the news story saying the
  //   person turned up. Rendered as a clickable link on the person's page, so
  //   only http(s) is accepted; anything else is dropped with a log and the
  //   report still goes through. The rule lives in the shared admission
  //   service, not here (src/report-admission.js).
  // - external_id: the caller's own id for this update. When present, a repeat
  //   POST with the same external_id updates this same update idempotently
  //   instead of creating a duplicate — safe to retry or re-sync from upstream.
  //   source_url is part of that upsert, so a re-push corrects a wrong link.
  //   Si esa llave está suprimida —la ficha se borró a solicitud de la persona
  //   (#191)— la respuesta es 409 con `suppressed: true` y no se crea nada.
  //   Reintentar no la corrige: esa llave no vuelve a entrar.
  //
  // Con una llave de alcance `ingest` (ver "Llaves de API con alcance" arriba) la
  // misma ruta se comporta distinto, y todo se decide en servidor: `source` se
  // fuerza a 'aggregator', `reporter` y `contact` se descartan, no se notifica a
  // nadie, hay techo de escrituras por hora, un `external_id` de otra llave se
  // rechaza con 403, y un `status` que esa llave no puede afirmar se ESTACIONA en
  // 'unknown' —nunca en 'missing'— con un `status_coercion` en la respuesta que
  // dice qué se pidió y qué quedó guardado.
  router.post(
    '/updates',
    requireWriter,
    wrap(async (req, res) => {
      const { name, status, message, location, reporter, contact } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta name' });
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `status debe ser uno de: ${STATUSES.join(', ')}` });
      }
      const externalId =
        req.body.external_id != null && String(req.body.external_id).trim()
          ? String(req.body.external_id).trim()
          : undefined;
      const photo = decodePhoto(req.body.photo);

      // ---- El alcance de una llave de ingesta ------------------------------
      // Todo lo de este bloque se decide con el principal que resolvió
      // requireWriter, NUNCA con el cuerpo del request.
      const principal = req.apiPrincipal;
      const isIngest = principal.scope === 'ingest';

      // Un estado que una llave de ingesta no puede afirmar se ESTACIONA en
      // 'unknown' (ver INGEST_STATUSES arriba para el por qué, que es lo más
      // importante de este bloque). No se rechaza —se perdería el hallazgo— y
      // sobre todo no se convierte en 'missing'.
      let effectiveStatus = status;
      let coercedFrom = null;
      if (isIngest && !INGEST_STATUSES.includes(status)) {
        coercedFrom = status;
        effectiveStatus = INGEST_PARKED_STATUS;
      }

      if (isIngest) {
        // La restricción más valiosa y la más barata: convierte "puede
        // reescribir cualquier ficha" en "solo puede corregir las suyas".
        //
        // Hace falta porque el upsert por external_id (ver insertUpdate en los
        // dos adapters) pisa status, message, location, coordenadas, source_url,
        // reporter y contact de la fila que ya tenga ese id SIN mirar quién la
        // creó — y los external_id de la ingesta pública son URLs de la fuente,
        // o sea derivables por cualquiera.
        //
        // Falla CERRADO: una ficha sin dueño demostrable en la bitácora (la
        // escribió la llave de entorno, o es anterior a esta tabla) no es de
        // esta llave, así que se rechaza.
        //
        // Límite conocido: el chequeo va FUERA de withExternalIdLock (#192), así
        // que dos llaves de ingesta que empujen el MISMO external_id nunca visto
        // en la misma ventana de milisegundos pasan las dos, y la segunda
        // termina actualizando la ficha de la primera. Queda declarado y no se
        // cierra acá: meter el chequeo dentro del lock obliga a bajar la noción
        // de "dueño" a la admisión y a los dos adaptadores, y el daño posible es
        // chico —las dos escrituras están igual de acotadas (solo missing o
        // unknown, sin notificación, sin contacto) y compiten por CREAR la misma
        // ficha, no por reescribir datos ajenos ya publicados.
        if (externalId) {
          const owner = await store.apiWriteOwnerByExternalId(externalId);
          if (owner && String(owner.api_key_id ?? '') !== String(principal.id)) {
            return res.status(403).json({
              error:
                'Ese external_id ya pertenece a una ficha que esta llave no creó. Una llave de ' +
                'ingesta puede agregar fichas nuevas y corregir las propias, no sobreescribir las ' +
                'de otro.'
            });
          }
        }

        // El primer techo de escritura que existe en este API. Se cuenta sobre
        // la bitácora, que es la única cuenta compartida entre instancias.
        const writtenLastHour = await store.countApiWrites(
          principal.id,
          new Date(Date.now() - HOUR_MS).toISOString()
        );
        if (writtenLastHour >= INGEST_WRITES_PER_HOUR) {
          return res.status(429).json({
            error: `Techo alcanzado: ${INGEST_WRITES_PER_HOUR} escrituras por hora por llave. Intenta más tarde.`
          });
        }
      }

      // Thin adapter: the shared report-admission service owns the whole domain
      // sequence (owner resolution after external_id upsert, photo indexing,
      // subscriber notification, and — LAST, once the report is durable — the
      // duplicate check). This route only decodes JSON in and shapes JSON out.
      const result = await (isIngest ? ingestAdmission : admission).admitReport({
        name,
        status: effectiveStatus,
        message,
        location,
        lat: typeof req.body.lat === 'number' ? req.body.lat : parseFloat(req.body.lat),
        lng: typeof req.body.lng === 'number' ? req.body.lng : parseFloat(req.body.lng),
        // Una llave de ingesta es, por definición, un empuje programático: se
        // fuerza 'aggregator' y se ignora lo que venga en el cuerpo. Además de
        // ser cierto, reactiva como red de seguridad real el filtro que ya
        // existe en latestUpdate (una fila 'aggregator' + 'safe' no gana el
        // "estado actual" de una persona).
        source: isIngest ? 'aggregator' : req.body.source,
        // Straight from the body, unvalidated on purpose: the service owns the
        // http(s)-only rule, so it can't end up meaning one thing here and
        // another one on the next entry point that starts accepting a link.
        sourceUrl: req.body.source_url,
        // reporter y contact se DESCARTAN en una llave de ingesta. No estaba en
        // la propuesta y se agrega con razón: `contact` es el teléfono que la
        // ficha le muestra a un rescatista como contacto de la familia (ver
        // matchContactBlock en web.js). Dejar que una llave de voluntario lo
        // escriba permitiría plantar ahí un número ajeno, que en zona de
        // desastre es materia de extorsión. Un dato de fuente pública no
        // necesita este campo.
        reporter: isIngest ? null : reporter,
        contact: isIngest ? null : contact,
        externalId,
        photos: photo ? [photo] : [],
        checkDuplicates: true
      });
      // Una llave suprimida no es un cuerpo mal formado: es una decisión ya
      // tomada sobre esa ficha (#191). Se responde aparte y explícito para que
      // quien empuja pueda distinguirlas — un 400 se reintenta creyendo que hay
      // algo que corregir, y este caso no se corrige nunca. Devuelve la llave
      // que el propio llamador mandó, para que la marque en su registro y deje
      // de mandarla.
      if (!result.ok && result.suppressed) {
        return res.status(409).json({
          error: result.errors.join(' '),
          suppressed: true,
          external_id: externalId
        });
      }
      // Unreachable today — the checks above already cover exactly what the
      // service validates — but the service is the single source of truth for
      // its own contract: a caller that stops prevalidating, or a validation
      // rule that changes only on one side, must get a 400 with `errors` here
      // instead of a TypeError on `result.person`.
      if (!result.ok) {
        return res.status(400).json({ error: result.errors.join(' ') });
      }

      // Qué llave escribió qué ficha. Sin esto se puede revocar una llave mala y
      // seguir sin saber qué tocó — o sea, sin poder limpiar. Y es también lo
      // que sostiene la regla de "no pisar lo ajeno" de arriba. Va DESPUÉS del
      // reporte, que ya está durable, y nunca lo tumba (ver src/logbook.js).
      const bitacoraOk = await logApiWrite(store, {
        personId: result.person.id,
        updateId: result.update.id,
        apiKeyId: principal.id,
        action: result.personCreated ? 'crear' : 'actualizar'
      });

      // Para una llave de ingesta esta bitácora no es observabilidad: es el
      // control. El techo por hora lo cuenta countApiWrites sobre esta tabla, y
      // el dueño de una ficha es su fila más antigua acá. Sin fila, la llave
      // queda de hecho SIN techo y con permiso de pisar cualquier external_id
      // —el chequeo de arriba es `if (owner && …)`— y nada afuera lo indica:
      // el API seguiría respondiendo 201.
      //
      // Así que acá el fallo de bitácora SÍ falla el request, y esa es la
      // manera más simple de que la regla de "falla CERRADO" sea cierta y no
      // una declaración: el control es la escritura, entonces si la escritura
      // no ocurrió, la operación no puede darse por buena. La alternativa
      // —dejar de contar la cuota y el dueño sobre esta tabla— es un rediseño
      // de las dos reglas para tapar un fallo de base que igual habría que
      // atender.
      //
      // Lo que NO se pierde: el reporte ya está guardado, y por eso se responde
      // con person_id. Lo que SÍ hay que decirle a quien empuja es que no
      // reintente a ciegas, porque la ficha quedó sin dueño demostrable: un
      // reintento con el mismo external_id se rechaza con 403 (el LEFT JOIN de
      // apiWriteOwnerByExternalId devuelve { api_key_id: null }, que NO es
      // "libre" — ver el comentario de esa consulta), y uno sin external_id
      // crea una ficha duplicada. Falla cerrado en los dos casos, y salir de
      // ahí es trabajo de un operador, no del que empuja.
      //
      // Para el operador se conserva la regla de las otras tres bitácoras: una
      // bitácora caída nunca tumba un reporte, porque ahí no sostiene ningún
      // control.
      if (isIngest && !bitacoraOk) {
        return res.status(503).json({
          error:
            'El reporte quedó guardado, pero no se pudo registrar en la bitácora de escrituras, ' +
            'y esa bitácora es la que sostiene el techo por hora y la propiedad de las fichas de ' +
            'esta llave. Se responde con error a propósito, en vez de seguir sin esos dos ' +
            'controles. NO reintentes: la ficha quedó sin dueño demostrable, así que volver a ' +
            'mandar el mismo external_id se rechaza con 403, y mandarlo sin external_id crearía ' +
            'una ficha duplicada. Avisá de este error: lo resuelve un operador.',
          person_id: result.person.id,
          external_id: externalId
        });
      }

      res.status(201).json({
        person_id: result.person.id,
        person_created: result.personCreated,
        // Por publicUpdate y no la fila cruda: `updates` lleva `contact` —el
        // teléfono que la ficha le muestra a un rescatista como contacto de la
        // familia— y `reporter` sin enmascarar. Con una llave de ingesta los dos
        // van nulos (se descartan arriba), pero con una llave de operación la
        // fila cruda devolvía el teléfono de la familia en el cuerpo de la
        // respuesta, y esa respuesta termina en el registro de quien integra.
        // La regla del repo —una fila de `updates` nunca sale sin pasar por
        // acá— no tiene excepción por estar detrás de llave.
        update: publicUpdate(result.update),
        photo_stored: !!photo,
        // Solo aparece cuando hubo coerción, y aparecer es el punto: un
        // voluntario tiene que poder ver que su hallazgo entró como CANDIDATO y
        // no como verdad publicada. Callarlo dejaría a alguien creyendo que
        // publicó "apareció" cuando lo que quedó fue "sin confirmar".
        ...(coercedFrom
          ? {
              status_coercion: {
                requested: coercedFrom,
                stored: effectiveStatus,
                reason:
                  `Una llave de ingesta no afirma "${coercedFrom}": eso cambia lo que lee la familia en ` +
                  'la ficha y le manda un aviso. Quedó en "unknown" para que lo revise una persona. ' +
                  'Nunca se convierte en "missing": eso publicaría como desaparecida a alguien que ya apareció.'
              }
            }
          : {}),
        // What the caller needs to reconcile on their side. `person_created:
        // false` already meant "appended to an existing record"; this spells
        // that out and adds the face-based collisions a name never sees.
        duplicate: {
          merged_into_existing_person: result.mergedIntoExisting,
          candidates: result.candidates.map((c) => ({
            person_id: c.person.id,
            full_name: c.person.full_name,
            reason: c.reason,
            // Only a FACE match carries a comparable percentage. The name
            // signal is a fuzzy string score on a different scale entirely, and
            // shipping both under one key invites `if (similarity >= 80) merge`
            // — which would collapse "Juan Carlos Pérez" and "Juan Camilo
            // Pérez", two different missing people, into one record.
            similarity: c.reason === 'face' ? c.similarity : null,
            name_score: c.reason === 'name' ? c.similarity / 100 : null,
            url: `${env.BASE_URL}/person/${c.person.id}`
          })),
          warning: result.warning
        }
      });
    })
  );

  // POST /api/people/:id/subscriptions —
  // { channel: email|whatsapp, address, photos?: [{ base64, content_type }] (max 3) }
  // Photos are used ONLY for face matching; they are never displayed or shared.
  router.post(
    '/people/:id/subscriptions',
    requireOperator,
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });
      const { channel, address } = req.body || {};
      if (!['email', 'whatsapp'].includes(channel)) {
        return res.status(400).json({ error: 'channel debe ser email o whatsapp' });
      }
      try {
        const { sub, needsVerification } = await store.subscribe(person.id, channel, address);
        let photosStored = 0;
        const photos = Array.isArray(req.body.photos) ? req.body.photos.slice(0, MAX_QUERY_PHOTOS) : [];
        if (sub && photos.length) {
          let count = await store.countQueryPhotos(sub.id);
          for (const raw of photos) {
            const photo = decodePhoto(raw);
            if (!photo || count >= MAX_QUERY_PHOTOS) continue;
            await processPhoto(store, matcher, {
              personId: person.id,
              kind: 'query',
              subscriptionId: sub.id,
              bytes: photo.bytes,
              contentType: photo.contentType
            });
            count++;
            photosStored++;
          }
        }
        if (needsVerification) {
          await sendVerificationEmail(person, sub);
        }
        res.status(201).json({ ok: true, pending_verification: needsVerification, photos_stored: photosStored });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    })
  );

  // Test records created while diagnosing the email pipeline. The purge below
  // can only ever touch these exact names, so it needs no secret to be safe.
  const TEST_RECORD_NAMES = [
    'prueba entrega correo',
    'verificacion final',
    'cadena completa',
    'prueba suscribir',
    'zona horaria',
    'conteo prueba'
  ];

  // POST /api/maintenance/purge-test-data — remove only the seeded test rows,
  // y ahora también sus firmas faciales: un registro de prueba no tiene por qué
  // dejar un dato biométrico en la colección después de que su ficha se fue.
  //
  // Sigue siendo segura sin llave, y el radio no cambió: solo puede tocar a
  // quien tenga uno de los nombres de la lista fija de arriba, igual que antes.
  // Y cuando no hay nada que purgar no gasta ni una llamada a Rekognition,
  // porque el retiro va después del borrado y ese bucle no entra.
  router.post(
    '/maintenance/purge-test-data',
    wrap(async (req, res) => {
      const { normalize } = require('../names');
      const removed = [];
      const firmas = { total: 0, deleted: 0, unconfirmed: [] };
      for (const name of TEST_RECORD_NAMES) {
        for (const p of await store.searchPeople(name, { limit: 20, minScore: 0.6 })) {
          const norm = normalize(p.full_name);
          // Only exact matches or the same name plus a trailing id.
          if (!TEST_RECORD_NAMES.some((t) => norm === t || norm.startsWith(t + ' '))) continue;
          // Mismo orden que el DELETE del ARCO, y por la misma razón: los ids
          // antes del borrado porque la cascada se los lleva, y las firmas
          // después, cuando ya no hay ficha que dejar huérfana.
          //
          // Lo que este borrado NO hace, a propósito, es suprimir la llave
          // externa (#191): eso es constancia de que alguien ejerció un
          // derecho, y acá nadie pidió nada — se están limpiando filas que
          // sembramos nosotros. Suprimirlas bloquearía para siempre una llave
          // de prueba, que es un efecto que nadie pidió y que no se ve hasta
          // que la ficha real no puede entrar.
          const faceIds = await store.faceIdsForPerson(p.id);
          const deleted = await store.deletePerson(p.id);
          if (!deleted) continue;
          removed.push({ id: p.id, name: p.full_name });
          const faces = await forgetPersonFaces(matcher, faceIds, `persona ${p.id}`);
          firmas.total += faces.total;
          firmas.deleted += faces.deleted;
          firmas.unconfirmed.push(...faces.unconfirmed);
        }
      }
      res.json({ ok: true, removed_count: removed.length, removed, faces: firmas });
    })
  );

  // DELETE /api/people/:id — honours the deletion requests promised in the
  // privacy policy. Requires API_KEY; disabled entirely when it is unset.
  //
  // Sigue comparando contra env.API_KEY directamente y NO pasa por el alcance:
  // ni siquiera una llave emitida con alcance "operator" puede borrar. Es a
  // propósito y es la dirección segura — el borrado es irreversible y se lleva
  // las firmas faciales—, pero conviene decirlo porque es la única asimetría
  // entre API_KEY y una llave de operación emitida.
  //
  // Borra las dos copias del rastro: la fila (y en cascada sus reportes,
  // suscripciones y fotos) y las firmas faciales en la colección de
  // Rekognition, que no viven en la base y por tanto la cascada no toca.
  //
  // Y deja constancia (#191): la fila se va, pero las llaves externas con las
  // que esa ficha podría volver a entrar quedan suprimidas. Sin eso el borrado
  // duraba hasta el siguiente re-envío del agregador, que insertaba la ficha de
  // nuevo y le reindexaba la cara sin que nada lo registrara.
  router.delete(
    '/people/:id',
    wrap(async (req, res) => {
      if (!env.API_KEY) {
        return res
          .status(503)
          .json({ error: 'Borrado deshabilitado: define API_KEY para habilitarlo.' });
      }
      if ((req.get('authorization') || '') !== `Bearer ${env.API_KEY}`) {
        return res.status(401).json({ error: 'API key inválida o ausente' });
      }
      // Los ids se leen ANTES del borrado: la cascada se lleva las filas de
      // `photos` y con ellas la única forma de saber qué firmas retirar.
      const faceIds = await store.faceIdsForPerson(req.params.id);
      // `atSubjectRequest` es lo que separa este borrado del de registros de
      // prueba: este es alguien ejerciendo un derecho, así que borrar ES
      // suprimir, y las dos escrituras van juntas en la misma transacción del
      // adaptador — la durabilidad no puede depender de que un handler se
      // acuerde de un segundo paso.
      const deleted = await store.deletePerson(req.params.id, { atSubjectRequest: true });
      if (!deleted) return res.status(404).json({ error: 'Persona no encontrada' });
      // Y las firmas DESPUÉS, ya sabiendo que la ficha se fue. Al revés —como
      // abrió este PR— si la base fallaba en el medio quedaban las firmas
      // borradas y la ficha viva: una persona listada como desaparecida y
      // permanentemente invisible para el matcher, porque
      // `backfillUnindexedPhotos` solo recoge fotos con `face_id` nulo y estas
      // lo conservan. De las dos huérfanas posibles esa es la peor, porque le
      // cuesta algo a quien está buscando a un familiar. Nunca lanza, así que
      // un Rekognition caído tampoco deshace el borrado ya hecho.
      const faces = await forgetPersonFaces(matcher, faceIds, `persona ${deleted.id}`);
      res.json({
        ok: true,
        deleted: { id: deleted.id, full_name: deleted.full_name },
        // Lo que quedó por retirar. Reintentar el DELETE ya no sirve —la
        // persona no existe y sus ids se fueron con ella—, así que esta
        // respuesta y el log son el único rastro para limpiarlo a mano.
        faces,
        // Cuántas llaves quedaron suprimidas. Va el CONTEO y no las llaves:
        // quien atiende la solicitud necesita saber que la constancia se
        // escribió, y la llave la elige quien empuja —puede traer un nombre
        // adentro— así que no tiene por qué terminar en un log de respuesta.
        suppressed_external_ids: deleted.suppressed_external_ids
      });
    })
  );

  // POST/GET /api/reindex — index photos stored while matching was down and
  // notify anyone whose search now matches. Safe to run repeatedly.
  // Triggers AWS Rekognition + subscriber notifications, so it requires the API key.
  //
  // Also brings already-stored report photos up to date: the detection geometry
  // the public overlay draws, and the face thumbnail the listing loads.
  router.all(
    '/reindex',
    requireOperator,
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      const indexed = await backfillUnindexedPhotos(store, matcher, limit);
      const derivatives = await backfillPhotoDerivatives(store, matcher, limit);
      const pets = petStore ? await backfillUnindexedPetPhotos(petStore, petMatcher, limit) : null;
      res.json({ ...indexed, derivatives, pets });
    })
  );

  // GET /api/match-stats — recomputa el cruce facial histórico contra la
  // colección y devuelve SOLO cifras agregadas (parte 1 de #116). No escribe
  // nada y no notifica a nadie.
  //
  // Va detrás de la API key aunque sea una lectura. La regla de "las lecturas
  // quedan abiertas" existe porque la información de emergencia quiere ser
  // encontrada — y esto no es eso: son cifras de operación, y cada llamada
  // dispara decenas de búsquedas en Rekognition (cuestan plata y tienen tope
  // por segundo), así que dejarla abierta regala un botón de gasto.
  router.get(
    '/match-stats',
    requireOperator,
    wrap(async (req, res) => {
      const stats = await computeMatchStats(store, matcher);
      if (!stats) {
        return res
          .status(503)
          .json({ error: `El matcher facial no está disponible: ${matcher.status}` });
      }
      res.json(stats);
    })
  );

  // ALL /api/report/send — arma y manda el reporte operativo recurrente
  // (#116, PR 2). Lo dispara el cron de Vercel 3×/día y, a mano, un operador
  // con la API key (el primer envío real lo dispara un humano apenas mergee).
  //
  // A diferencia del resto de esta ruta, acá NO aplica "las lecturas quedan
  // abiertas": esto tiene efecto de lado (manda correos vía SendGrid, que
  // cuesta y tiene cuota) y expone cifras de operación, así que falla CERRADO
  // — a diferencia de las rutas con alcance, que si no hay API_KEY configurada dejan
  // pasar. Acepta la API key existente (Authorization: Bearer <API_KEY>) o el
  // secreto que Vercel Cron manda solo (Authorization: Bearer <CRON_SECRET>,
  // ver https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)
  // — nunca ambos sin configurar.
  function requireKeyOrCron(req, res, next) {
    const auth = req.get('authorization') || '';
    if (env.API_KEY && auth === `Bearer ${env.API_KEY}`) return next();
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (cronSecret && auth === `Bearer ${cronSecret}`) return next();
    res.status(401).json({ error: 'Credencial inválida o ausente (API key o CRON_SECRET)' });
  }
  router.all(
    '/report/send',
    requireKeyOrCron,
    wrap(async (req, res) => {
      const result = await sendReport(store, matcher);
      res.status(result.ok ? 200 : 502).json(result);
    })
  );

  // GET /api/diag/sendgrid — ask SendGrid about deliverability for an address:
  // suppressions (bounce/block/spam/invalid), verified senders, and whether the
  // sending domain is authenticated (SPF/DKIM). A 202 from the send API only
  // means "accepted"; these are the reasons mail still never lands.
  router.get(
    '/diag/sendgrid',
    wrap(async (req, res) => {
      const key = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
      if (!key) return res.status(400).json({ error: 'SENDGRID_API_KEY no configurada' });
      const address = String(req.query.email || '').trim();

      const get = async (path) => {
        try {
          const r = await fetch(`https://api.sendgrid.com${path}`, {
            headers: { Authorization: `Bearer ${key}` }
          });
          const text = await r.text();
          let body;
          try {
            body = JSON.parse(text);
          } catch {
            body = text.slice(0, 300);
          }
          return { status: r.status, body };
        } catch (e) {
          return { error: e.message };
        }
      };

      const [bounces, blocks, spam, invalid, senders, domains] = await Promise.all([
        address ? get(`/v3/suppression/bounces/${encodeURIComponent(address)}`) : { skipped: true },
        address ? get(`/v3/suppression/blocks/${encodeURIComponent(address)}`) : { skipped: true },
        address ? get(`/v3/suppression/spam_reports/${encodeURIComponent(address)}`) : { skipped: true },
        address ? get(`/v3/suppression/invalid_emails/${encodeURIComponent(address)}`) : { skipped: true },
        get('/v3/verified_senders'),
        get('/v3/whitelabel/domains')
      ]);

      const domainList = Array.isArray(domains.body) ? domains.body : [];
      const fromDomain = env.EMAIL_FROM.split('@')[1];
      const matching = domainList.find((d) => d.domain === fromDomain);

      res.json({
        from: env.EMAIL_FROM,
        checked_address: address || '(pasa ?email= para revisar supresiones)',
        suppressions: { bounces, blocks, spam, invalid },
        verified_senders_status: senders.status,
        verified_senders: Array.isArray(senders.body?.results)
          ? senders.body.results.map((v) => ({ email: v.from_email, verified: v.verified }))
          : senders.body,
        domain_authentication:
          domains.status !== 200
            ? `No se pudo verificar: la API key solo tiene permiso "Mail Send" (SendGrid respondió ${domains.status}). Revísalo en SendGrid → Settings → Sender Authentication.`
            : matching
              ? { domain: matching.domain, valid: matching.valid }
              : `El dominio ${fromDomain} no aparece autenticado en SendGrid. Sin SPF/DKIM propios, Gmail y Outlook suelen mandar el correo a spam — sobre todo si el destinatario es del mismo dominio que el remitente.`
      });
    })
  );

  // GET /api/diag — configuration and live self-test. Never exposes secrets,
  // never sends email (a GET must not have side effects — see POST /api/diag/test-email).
  router.get(
    '/diag',
    wrap(async (req, res) => {
      if (typeof matcher.ensureReady === 'function') {
        await matcher.ensureReady();
      }
      // Read the key live: config captured at module load can be stale.
      const liveKey = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
      const out = {
        base_url: env.BASE_URL,
        database: {
          driver: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL ? 'postgres' : 'sqlite (efímero)',
          ok: false
        },
        runtime: {
          node: process.version,
          vercel_env: process.env.VERCEL_ENV || '(local)',
          fetch_available: typeof fetch === 'function'
        },
        email: {
          sendgrid_key_present: !!liveKey,
          // Fingerprint only — never the secret itself.
          sendgrid_key_len: liveKey.length,
          sendgrid_key_prefix: liveKey.slice(0, 3),
          sendgrid_key_looks_valid: /^SG\./.test(liveKey),
          raw_key_had_whitespace:
            !!process.env.SENDGRID_API_KEY &&
            process.env.SENDGRID_API_KEY !== process.env.SENDGRID_API_KEY.trim(),
          from: env.EMAIL_FROM,
          // Presence only, never the address. Three things route through this
          // mailbox — the rescuer's aviso, "report this on Colombia Te Busca
          // too", and every relayed notification (see `notifications` below) —
          // and all of them fail QUIETLY without it: the visitor still gets a
          // success page, the report is still saved, and nobody is told the
          // relay went nowhere. From outside there is no other way to notice.
          aviso_email_present: !!avisoEmail()
        },
        // Los avisos que van a un TERCERO (actualización a quien sigue a una
        // persona, coincidencia facial con un rescatista). En modo relevo
        // ninguno se entrega: todos aterrizan en AVISO_EMAIL para que una
        // persona los verifique y los enrute. Se expone acá para poder ver
        // desde afuera en qué modo está, sin leer los logs ni el código.
        notifications: {
          mode: notifyMode(),
          relay_mailbox_present: !!avisoEmail(),
          // Relevo activo y sin buzón: no sale nada, para nadie, y el único
          // rastro es una línea "[notify:relevo] PERDIDO" en los logs.
          relay_without_mailbox: relayEnabled() && !avisoEmail()
        },
        faces: {
          aws_key_present: !!process.env.AWS_ACCESS_KEY_ID,
          aws_region: process.env.AWS_REGION || '(sin definir → us-east-1)',
          matcher_enabled: !!matcher.enabled,
          status: matcher.status || 'desconocido'
        },
        pet_matching: {
          api_url_present: !!process.env.PET_MATCH_API_URL,
          enabled: !!(petMatcher && petMatcher.enabled),
          status: (petMatcher && petMatcher.status) || 'sin inicializar'
        },
        // Same reasoning as aviso_email_present: without a token /ideas and
        // /bug keep working but quietly fall back to email, so the issue
        // tracker just stays empty and looks like nobody wrote in.
        github: {
          token_present: gh.configured(),
          repo: gh.repo()
        }
      };

      try {
        const recent = await store.getRecentUpdates(1);
        out.database.ok = true;
        out.database.recent_updates = recent.length;
        out.database.counts = await store.counts();
        const pending = await store.photosMissingFaceId(500);
        out.faces.photos_pending_indexing = pending.length;
        if (pending.length) {
          out.faces.hint = 'Ejecuta /api/reindex para indexarlas y avisar coincidencias.';
        }
      } catch (e) {
        out.database.error = e.message;
      }

      res.json(out);
    })
  );

  // POST /api/diag/test-email — sends a real test email and reports the result.
  // A side effect that spends SendGrid quota belongs behind the API key, not on a GET.
  // { email }
  router.post(
    '/diag/test-email',
    requireOperator,
    wrap(async (req, res) => {
      const email = req.body && req.body.email;
      if (!email || !String(email).trim()) {
        return res.status(400).json({ error: 'Falta email' });
      }
      // Same key fingerprinting as GET /api/diag so emailVerdict can produce
      // its actionable sentence on the send path too (never the secret itself).
      const liveKey = (process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY || '').trim();
      const info = {
        sendgrid_key_present: !!liveKey,
        sendgrid_key_prefix: liveKey.slice(0, 3),
        sendgrid_key_looks_valid: /^SG\./.test(liveKey),
        from: env.EMAIL_FROM
      };
      const { sendEmail } = require('../notify');
      info.test = await sendEmail(
        String(email).trim(),
        'Prueba de configuración — encontrados.co',
        'Si recibes este correo, el envío desde encontrados.co funciona correctamente.'
      );
      info.veredicto = emailVerdict(info);
      res.json({ email: info });
    })
  );

  // ---------------------------------------------- contactos hechos FUERA de la app
  //
  // POST /api/contact-log registra que una persona del equipo contactó, desde
  // su propio buzón o su propio teléfono, a quien reportó a alguien. La app no
  // tiene forma de enterarse sola: el envío no pasó por ninguno de sus
  // caminos. Sin esto, la ficha de esa persona y el panel dicen "nadie la ha
  // contactado", que es falso.
  //
  // Tres garantías estructurales, no convenciones:
  //
  // 1. `source` se fuerza a 'operador' acá adentro. Un llamador externo NO
  //    puede escribir en la serie de la app ni aunque lo pida: no hay campo
  //    que lo permita. Por eso la gráfica "Envíos por canal" no se puede
  //    contaminar desde afuera.
  // 2. Nada de lo que entra identifica un destinatario. Ni dirección, ni
  //    número, ni nombre, ni cuerpo del mensaje: persona + canal + fecha +
  //    resultado, y una referencia opaca. Un campo de más en el body se
  //    ignora; no hay dónde guardarlo.
  // 3. `ref` DEBE ser un digesto SHA-256 en hexadecimal, y la ruta lo valida.
  //    No es formalismo: el `wamid` que devuelve la API de WhatsApp lleva el
  //    teléfono del destinatario codificado en base64 adentro, así que
  //    aceptarlo crudo metería el número de una familia en esta base. Que la
  //    validación viva en el código y no en un párrafo de documentación es lo
  //    que hace imposible el accidente.
  //
  // A diferencia de la bitácora interna (src/logbook.js, que se traga sus
  // propios errores para no retrasar jamás un envío real), acá un fallo SÍ se
  // le reporta al llamador: no hay ningún flujo de emergencia esperando, y un
  // registro que falla en silencio deja al panel afirmando lo contrario de lo
  // que pasó.
  const EXTERNAL_REF_RE = /^[a-f0-9]{64}$/;
  const EXTERNAL_CHANNELS = ['email', 'whatsapp'];
  // 'rechazado' no existe para un contacto externo: significa "la app decidió
  // por su cuenta no intentar nada", y una persona que escribe desde su buzón
  // no tiene ese estado. O se mandó, o falló.
  const EXTERNAL_RESULTS = ['enviado', 'fallido'];
  // El primer commit del repo. Nada de lo que esta ruta registra puede haber
  // pasado antes de que la app existiera.
  const INICIO_DEL_REGISTRO = Date.parse('2026-08-10T00:00:00Z');

  router.post(
    '/contact-log',
    requireOperator,
    wrap(async (req, res) => {
      const body = req.body || {};
      const person = await store.getPerson(body.person_id);
      if (!person) return res.status(404).json({ error: 'Persona no encontrada' });
      if (!EXTERNAL_CHANNELS.includes(body.channel)) {
        return res.status(400).json({ error: `channel debe ser uno de: ${EXTERNAL_CHANNELS.join(', ')}` });
      }
      if (!EXTERNAL_RESULTS.includes(body.result)) {
        return res.status(400).json({ error: `result debe ser uno de: ${EXTERNAL_RESULTS.join(', ')}` });
      }
      const ref = String(body.ref || '').trim().toLowerCase();
      if (!EXTERNAL_REF_RE.test(ref)) {
        return res.status(400).json({
          error:
            'ref debe ser un digesto SHA-256 en hexadecimal (64 caracteres). El identificador crudo del proveedor no puede viajar: un wamid de WhatsApp lleva el teléfono del destinatario codificado adentro. Hashéalo en tu máquina y manda solo el digesto.'
        });
      }
      const occurredAt = new Date(body.occurred_at);
      if (!body.occurred_at || Number.isNaN(occurredAt.getTime())) {
        return res.status(400).json({ error: 'Falta occurred_at (fecha ISO 8601 del contacto)' });
      }
      // Un contacto en el futuro es un error de zona horaria del registrador,
      // y entra corriendo hacia adelante la serie de días del panel. Cinco
      // minutos de tolerancia por el desfase de reloj entre máquinas.
      if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: 'occurred_at está en el futuro' });
      }
      // Y la cota simétrica: un contacto anterior al día en que el proyecto
      // existe no es un hecho, es el mismo error de zona horaria (o una línea
      // mal formada) corriendo la serie hacia el otro lado. Importa porque
      // contactLogEarliest({ source: 'operador' }) fecha el "medido desde" de
      // la sección externa: un 1970 ahí pinta como instrumentados cincuenta
      // años en los que nadie contactó a nadie.
      if (occurredAt.getTime() < INICIO_DEL_REGISTRO) {
        return res.status(400).json({ error: 'occurred_at es anterior al inicio del proyecto' });
      }

      const { inserted } = await store.insertContactLog({
        personId: person.id,
        updateId: null,
        channel: body.channel,
        result: body.result,
        source: 'operador',
        externalRef: ref,
        // Mismo formato ISO sin milisegundos que usa el resto del esquema en
        // SQLite (`date(created_at, '-5 hours')` lo parsea); en Postgres la
        // columna es TIMESTAMPTZ y el string se castea igual.
        createdAt: occurredAt.toISOString().replace(/\.\d{3}Z$/, 'Z')
      });

      res.status(inserted ? 201 : 200).json({
        ok: true,
        // false = esta referencia ya estaba registrada. No es un error: el
        // reintento del registrador es exactamente el caso que external_ref
        // existe para absorber.
        created: inserted,
        person_id: person.id
      });
    })
  );

  // DELETE /api/contact-log/:ref — deshace UN registro externo.
  //
  // Existe porque registrar "a esta persona se le avisó el 12 de agosto" es
  // una AFIRMACIÓN sobre un hecho pasado, y una afirmación que no se puede
  // retirar no debería poder hacerse. El filtro `source = 'operador'` vive en
  // el adapter: este camino no puede borrar un envío que la app sí hizo, ni
  // por error ni a propósito.
  router.delete(
    '/contact-log/:ref',
    requireOperator,
    wrap(async (req, res) => {
      const ref = String(req.params.ref || '').trim().toLowerCase();
      if (!EXTERNAL_REF_RE.test(ref)) {
        return res.status(400).json({ error: 'ref debe ser un digesto SHA-256 en hexadecimal (64 caracteres)' });
      }
      const deleted = await store.deleteContactLogByRef(ref);
      res.json({ ok: true, deleted });
    })
  );

  return router;
}

module.exports = {
  apiRoutes,
  // Para el emisor de llaves (scripts/api-key.js). Se exportan de acá y no de
  // un módulo nuevo por lo dicho arriba: el hash es la verificación, y la
  // verificación no debe mudarse a una ruta que se pueda aprobar sin que
  // decida una persona.
  generateApiKey,
  hashApiKey,
  apiKeyPrefix,
  API_SCOPES,
  INGEST_STATUSES,
  INGEST_WRITES_PER_HOUR
};
