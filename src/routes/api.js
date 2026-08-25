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
const { matcherReady } = require('../faces');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

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

  // If API_KEY is set, writes require `Authorization: Bearer <key>`.
  // Reads stay open — emergency information wants to be found.
  function requireKey(req, res, next) {
    if (!env.API_KEY) return next();
    const auth = req.get('authorization') || '';
    if (auth === `Bearer ${env.API_KEY}`) return next();
    res.status(401).json({ error: 'API key inválida o ausente' });
  }

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
  router.post(
    '/updates',
    requireKey,
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

      // Thin adapter: the shared report-admission service owns the whole domain
      // sequence (owner resolution after external_id upsert, photo indexing,
      // subscriber notification, and — LAST, once the report is durable — the
      // duplicate check). This route only decodes JSON in and shapes JSON out.
      const result = await admission.admitReport({
        name,
        status,
        message,
        location,
        lat: typeof req.body.lat === 'number' ? req.body.lat : parseFloat(req.body.lat),
        lng: typeof req.body.lng === 'number' ? req.body.lng : parseFloat(req.body.lng),
        source: req.body.source,
        // Straight from the body, unvalidated on purpose: the service owns the
        // http(s)-only rule, so it can't end up meaning one thing here and
        // another one on the next entry point that starts accepting a link.
        sourceUrl: req.body.source_url,
        reporter,
        contact,
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

      res.status(201).json({
        person_id: result.person.id,
        person_created: result.personCreated,
        update: result.update,
        photo_stored: !!photo,
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
    requireKey,
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
    requireKey,
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
    requireKey,
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
  // — a diferencia de requireKey, que si no hay API_KEY configurada deja
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
      const matcherAvailable = await matcherReady(matcher);
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
          matcher_enabled: matcherAvailable,
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
    requireKey,
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
    requireKey,
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
    requireKey,
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

module.exports = { apiRoutes };
