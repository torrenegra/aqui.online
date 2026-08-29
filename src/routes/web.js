const crypto = require('crypto');
const express = require('express');
const env = require('../env');
const { upload } = require('../upload');
const { sendVerificationEmail, mailOperators, logSafe, relayEnabled } = require('../notify');
const {
  identifyRescuedPerson,
  notifyRescuerOfMatches,
  backfillPhotoDerivatives,
  forgetPersonFaces,
  MAX_QUERY_PHOTOS
} = require('../facematch');
const { esc, layout, updateCard, timeTag, facePlate, LOCATION_SCRIPT, PHONE_FILTER_SCRIPT } = require('../html');
const { isReadyToShow } = require('../report-photo');
const gh = require('../github');
const { logContact, resultFromSend } = require('../logbook');
const { RESCUE_ANCHOR_PREFIX } = require('../people');
const { readSession } = require('../adminAuth');
const { createReportAdmission } = require('../report-admission');
const { RESCUE_PRIVACY, searchOnlyCheckbox, matchContactBlock } = require('../rescue-contact');

// Express 4 doesn't catch async errors on its own.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// El bot guarda el número tal como lo entrega Meta en `from`: solo dígitos, con
// indicativo de país y sin '+'. Un número tecleado en un formulario tiene que
// quedar en ESA misma forma o sería una dirección distinta para el mismo
// teléfono, y ni la deduplicación ni la baja volverían a encontrarlo.
//
// Diez dígitos se leen como un número colombiano sin indicativo, que es como lo
// escribe casi todo el mundo acá. Y si no parece un teléfono se ignora en
// silencio: quien está parado al lado de una persona que acaba de rescatar no
// se puede quedar trancado en una validación de formato — el resto del
// formulario sigue funcionando igual.
const PHONE_DEFAULT_COUNTRY = '57';
// Lo que una persona escribe cuando escribe un celular: dígitos y los
// separadores con los que se agrupan acá — espacios, guiones, paréntesis del
// indicativo y puntos — con un '+' opcional adelante. Todo eso lo limpia
// normalizePhone() de todos modos, así que rechazarlo sería rechazar una forma
// correcta de escribir el número. Lo que sí se rechaza es lo que no es un
// teléfono: letras y cualquier otro símbolo, que normalizePhone() borraría en
// silencio dejando pasar un valor que la persona nunca quiso ("300a1234567").
const PHONE_RAW_RE = /^\+?[\d\s().-]+$/;
function normalizePhone(raw) {
  let digits = String(raw || '')
    .replace(/\D/g, '')
    .replace(/^00/, '');
  if (!digits) return null;
  if (digits.length === 10) digits = PHONE_DEFAULT_COUNTRY + digits;
  // E.164: 15 dígitos como máximo, contando el indicativo.
  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}
const REPORTER_COOKIE = 'encontrados_reporter';
const EMAIL_COOKIE = 'encontrados_email';
// Renamed with the brand. Anyone who used the site before still has the old
// cookie, so read it as a fallback rather than making them type it again.
const LEGACY_COOKIE = { encontrados_reporter: 'aqui_reporter', encontrados_email: 'aqui_email' };

function readCookie(req, name, maxLength = 120) {
  const raw = req.headers.cookie || '';
  const read = (key) => {
    const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(key + '='));
    if (!hit) return '';
    try {
      return decodeURIComponent(hit.slice(key.length + 1)).slice(0, maxLength);
    } catch {
      return '';
    }
  };
  return read(name) || read(LEGACY_COOKIE[name] || name);
}

// Remember who is reporting so a volunteer filing many reports types it once.
function remember(res, name, value) {
  const v = (value || '').trim();
  if (!v) return;
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(v.slice(0, 120))}; Path=/; Max-Age=2592000; SameSite=Lax`
  );
}

// El formulario de reporte pedía un solo campo, "tu teléfono O correo", y ahora
// pide los dos por separado (ver POST /report). La cookie de quien reporta
// existe desde antes y puede traer cualquiera de los dos, así que se decide por
// la forma del valor en vez de tirarlo: quien ya reportó una vez no vuelve a
// escribir su contacto. `encontrados_email` es la misma cookie que prellena el
// correo en /rescate — es el correo de este navegador, no el de un flujo.
function rememberedContact(req) {
  const legacy = readCookie(req, REPORTER_COOKIE);
  const email = readCookie(req, EMAIL_COOKIE);
  const legacyIsEmail = EMAIL_RE.test(legacy);
  return {
    phone: legacyIsEmail ? '' : legacy,
    email: email || (legacyIsEmail ? legacy : '')
  };
}

// `updates.contact` sigue siendo UN campo de texto libre: es lo que se le
// muestra a un rescatista tras una coincidencia facial y lo que viaja en el
// aviso de `notifyFaceMatch`, y nada en el código lo parsea. Por eso el desdoble
// del formulario no cambia la columna — el teléfono y el correo se juntan acá y
// bajan por el mismo camino de siempre. `contact` a secas se sigue aceptando en
// el cuerpo del POST: es lo que manda cualquier cliente que conociera el
// formulario anterior.
function composeContact({ phone, email, contact }) {
  const joined = [phone, email].map((v) => String(v || '').trim()).filter(Boolean).join(' · ');
  return joined || String(contact || '').trim();
}

// `avisoEmail()` — el buzón de operación al que se le manda un aviso — vive en
// `src/notify.js`: es el mismo buzón que recibe los avisos relevados, y una
// segunda copia de la misma lectura se desincroniza sola. Se lee LIVE de
// process.env, no del snapshot del módulo — la misma trampa de frescura que
// /api/diag documenta para la llave de SendGrid. Sin buzón no hay correo; lo
// que produjo el aviso (la entrada del timeline, el reporte) sigue en pie.
//
// Con el relevo activo (NOTIFY_MODE, por omisión "relay") entre una
// coincidencia y el correo al rescatista hay una persona verificando a quién
// se le entrega el dato. Los textos que prometían un aviso instantáneo
// dejarían de ser ciertos, así que la espera se nombra — sin alarmar y sin
// prometer tiempos que no controlamos.
const REVIEWED_NOTE = 'Cada aviso lo revisa antes una persona del equipo, así que puede tomar un momento.';

// RESCUE_PRIVACY, searchOnlyCheckbox: movidos a ../rescue-contact.js el
// 19-ago-2026 (ver .github/CODEOWNERS, bloque "La app pública").

// One small line under the listing heading. Kept honest — the data flows from
// Encontrados.co's own reports and from Colombia Te Busca, the public photo
// registry families use to publish and search (and to which the Red Cross
// points them). Media and official channels (El Espectador, El Tiempo,
// Medicina Legal/SIRDEC, UNGRD…) don't expose a scrapable photo registry — a
// lookup-by-identity form or an intake channel is not a source of faces — so
// they are not promised here as "coming soon".
const SOURCES_NOTE = `<p class="sources-note">Fuentes de información de desaparecidos: Encontrados.co y <a href="https://colombiatebusca.com" target="_blank" rel="noopener">Colombia Te Busca</a>, el registro público donde las familias publican fotos y buscan a sus desaparecidos.</p>`;

// La salida para quien llegó a /rescate y en realidad está BUSCANDO a alguien.
//
// Hasta acá el flujo del rescatista no tenía ninguna: los tres botones de sus
// pantallas —resultado, error, aviso enviado— devolvían todos a /rescate. Una
// familia subía la foto de su familiar, leía «nadie ha reportado a esta
// persona» y se iba del sitio sin reportarla. Justo la persona que más
// necesitaba el formulario de reporte era la única a la que no se lo
// ofrecíamos.
//
// La pregunta va primero y detrás de un <details>, no como un botón suelto, y
// esa es la parte que decide si esto ayuda o hace daño. Un rescatista con una
// persona sin identificar al lado NO debe reportarla como desaparecida: si lo
// hace, crea una ficha de desaparecida para alguien que está a salvo y deja su
// propio teléfono en el lugar del de la familia — la ficha queda apuntando al
// rescatista y la familia real nunca recibe la llamada. Con la acción escondida
// detrás de la pregunta, quien responde «no» no la ve nunca.
//
// Por eso también está la segunda mitad, que hasta acá no existía en ninguna
// parte del sitio: decirle explícitamente al rescatista qué hacer en su caso.
// Que nadie lo hubiera escrito nunca es parte de por qué el formulario de aviso
// se llenaba mal.
const REPORT_EXIT_BLOCK = `<div class="notice">
  <p class="aviso-pregunta">¿Eres tú quien está buscando a esta persona?</p>
  <details class="aviso-si">
    <summary class="big-btn secondary">🙋 Sí, la estoy buscando</summary>
    <div class="aviso-si-cuerpo">
      <p>Repórtala acá: dejas su foto y tu teléfono, y el rescatista que la encuentre te llama directo.</p>
      <a class="big-btn search" href="/report">📢 Reportar a la persona que busco</a>
    </div>
  </details>
  <p class="subtle"><strong>Si la tienes contigo y no sabes quién es, no la reportes como desaparecida.</strong> Vuelve a consultar más tarde: alguien puede reportarla en las próximas horas.</p>
</div>`;

// El pie de las pantallas del rescatista.
//
// Una sola salida, y a /rescate. Acá NO va la de reportar, y no por ahorrar
// espacio: el pie sale en TODAS las pantallas —incluida «Aviso enviado» y la
// que muestra una coincidencia—, o sea justo donde la persona acaba de decirnos
// que tiene a alguien consigo. Un botón de «reporta un desaparecido» ahí, sin
// ninguna pregunta delante, es una invitación a crear la ficha equivocada como
// última cosa que se ve. La salida a reportar vive en REPORT_EXIT_BLOCK, detrás
// de su pregunta, y solo en las pantallas donde de verdad hay un punto muerto.
const RESCUE_FOOTER = `<p><a class="big-btn report" href="/rescate">🔍 Consultar otra persona</a></p>`;

// matchContactBlock: movido a ../rescue-contact.js el 19-ago-2026 (ver
// .github/CODEOWNERS, bloque "La app pública").

// The possible-duplicate finding travels from POST /report to the person page
// in a short-lived cookie rather than in the URL, and this is the whole reason
// why: the warning asserts that two specific missing people may be the same
// human. That claim belongs to the server, for the visitor who just reported —
// a query string would make it a link anyone could forge and circulate, and on
// a post-disaster site a forwarded "these two are the same person" is how a
// real report gets written off as a duplicate and stops being searched for.
// A cookie is not shareable; the worst a visitor can do is mislead themselves.
const DUP_COOKIE = 'encontrados_dup';
const DUP_TTL_SECONDS = 300;

function rememberDuplicateFinding(res, finding) {
  res.append(
    'Set-Cookie',
    `${DUP_COOKIE}=${encodeURIComponent(JSON.stringify(finding))}; Path=/; Max-Age=${DUP_TTL_SECONDS}; SameSite=Lax`
  );
}

function clearDuplicateFinding(res) {
  res.append('Set-Cookie', `${DUP_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`);
}

// Returns the finding only when it is about THIS person; anything unparseable
// or stale is treated as absent. Shape: { p, n, f, c: [{ i, r, s }] }.
function readDuplicateFinding(req, personId) {
  const raw = readCookie(req, DUP_COOKIE, 2000);
  if (!raw) return null;
  try {
    const finding = JSON.parse(raw);
    if (!finding || String(finding.p) !== String(personId)) return null;
    return {
      sameName: !!finding.n,
      priorPhotoId: Number(finding.f) || 0,
      candidates: (Array.isArray(finding.c) ? finding.c : []).slice(0, 4)
    };
  } catch {
    return null;
  }
}

// Shown on the person page right after a report that looks like it may already
// exist. It is a WARNING, not a rejection and not a decision: the report is
// already saved and public by the time this renders, and nothing here changes
// a record. It exists so the reporter — and anyone reading the page — can SEE
// the other report and act on it out of band.
//
// Reconciling the two records (merging them, or splitting a namesake apart) is
// deliberately absent: those are irreversible mutations of public records and
// there is no way to prove, from a cookie, that the caller is entitled to make
// them. That belongs behind a real authorization, not here.
// Cuando alguien llega a /report desde la ficha de una persona concreta —el
// botón «Yo la estoy buscando», o el «No, yo soy quien la está buscando» de una
// coincidencia— el nombre viene precargado y el destino es, a propósito, ESE
// registro. La cadena es determinista: el nombre exacto → `exactByNormalized`
// encuentra siempre a la misma persona → `created: false` → salta la alarma de
// nombre duplicado. Es decir: una madre que reporta a su hijo desde su ficha
// leería, el 100% de las veces, que le escriba al mantenedor para separar dos
// reportes que en realidad son uno, y que un rescatista podría ver los datos de
// otra familia. La alarma es falsa por construcción y hay que apagarla.
//
// Viaja el ID y no un simple booleano porque lo que hay que comprobar es que
// aterrizó en la MISMA persona de la que salió: si `findOrCreatePerson` resolvió
// otro registro (dos personas con el mismo nombre), la advertencia vuelve a ser
// verdadera y tiene que salir.
function fichaOriginField(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return '';
  return `<input type="hidden" name="desde_ficha" value="${id}">`;
}

function duplicateNotice({ person, sameName, priorPhoto, candidates }) {
  // The question only makes sense next to a face — ask on the SAME condition
  // `facePlate` draws on, from the one place that owns it, instead of a local
  // copy: a local copy is exactly what once printed "compare the photos" over
  // a blank card.
  const compare = (photo) =>
    isReadyToShow(photo)
      ? '<p class="dup-q">Compara las fotos: si es la misma persona, escríbenos y unimos los reportes.</p>'
      : '<p class="dup-q">Ese reporte no tiene foto para comparar.</p>';

  // The record we landed on because the NAMES matched. It may be the same
  // person (good — the reports are already together) or a namesake, which is
  // the dangerous case: a rescuer would be shown the wrong family's contact.
  const sameNameCard = sameName
    ? `<article class="card dup">
  ${facePlate(priorPhoto, person.full_name)}
  <p>🔤 <strong>Ya había un reporte con este mismo nombre</strong>, así que este se sumó a ese registro.</p>
  ${compare(priorPhoto)}
  <p class="subtle">Si <strong>no</strong> es la misma persona —dos personas distintas con el mismo nombre— escríbenos a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a> para separarlos: si quedan juntos, un rescatista vería los datos de la familia equivocada.</p>
</article>`
      : '';

  // A 97% facial match and a name that merely scored 0.61 are not the same
  // evidence, and an anxious family reads whatever it is shown as certainty.
  // Say which signal fired, and how strong it was.
  const why = (c) =>
    c.reason === 'face' && c.similarity
      ? `👤 La foto coincide en un <strong>${c.similarity}%</strong> con este otro reporte.`
      : '🔤 El nombre se parece al de este otro reporte. Es una pista débil: revisa la foto.';

  const otherCards = candidates
    .map(
      (c) => `<article class="card dup">
  ${facePlate(c.photo, c.person.full_name)}
  <h3><a href="/person/${c.person.id}">${esc(c.person.full_name)}</a></h3>
  <p>${why(c)}</p>
  ${c.update && c.update.location ? `<p class="loc">📍 ${esc(c.update.location)}</p>` : ''}
  ${compare(c.photo)}
</article>`
    )
    .join('');

  if (!sameNameCard && !otherCards) return '';

  return `<div class="warning">
  <p>⚠️ <strong>Puede que esta persona ya estuviera reportada.</strong> Los reportes repartidos en dos fichas son un problema real: quien la rescate vería el contacto de una sola familia, y la otra nunca recibe la llamada.</p>
</div>
${sameNameCard}
${otherCards}`;
}
const REPORT_PRIVACY = `<p class="privacy">📢 Las fotos del reporte <strong>se publican</strong> en la lista de personas desaparecidas, con los puntos de reconocimiento facial marcados sobre el rostro. Es lo que permite que un rescatista reconozca a la persona que tiene al lado. Sube solo fotos que quieras hacer públicas.</p>`;

// ------------------------------------------- "¿ya se avisó a quien reportó?"
//
// El bloque que responde, en la ficha, la pregunta que hoy no tiene respuesta
// en ninguna pantalla: si alguien ya le escribió a la persona que reportó a
// esta otra, y cuándo. Lee `contact_log` a través de familyContactLogByPerson,
// que ya deja 'relevo' afuera en el SQL — un relevo fue al buzón del equipo,
// no a una familia, y mostrarlo acá diría lo contrario de lo que pasó.
//
// QUIÉN LO VE: solo quien tiene sesión de administración. La ficha sigue
// siendo pública y para un visitante anónimo no cambia ni un byte. La versión
// pública de este mismo bloque es una decisión aparte, declarada en el PR:
// cambia lo que lee una familia (categoría "lo que ve o hace un usuario") y
// abre una superficie nueva de ingeniería social — un estafador que lee "te
// escribimos el 12" en una página indexada tiene el detalle corroborante que
// vuelve creíble una llamada. Eso lo decide una persona, en su propio issue.
//
// Ni el bloque ni sus datos dicen a QUIÉN se contactó: la dirección y el
// número nunca estuvieron en esta tabla y no aparecen acá.
const CONTACT_CHANNEL_LABEL = { email: 'Correo', whatsapp: 'WhatsApp' };
const CONTACT_SOURCE_LABEL = {
  app: 'lo mandó la app',
  operador: 'lo mandó el equipo, por fuera de la app'
};

function contactHistoryBlock(rows) {
  if (!rows || !rows.length) {
    return `<div class="notice"><p>📣 <strong>Todavía no se ha avisado a quien reportó a esta persona.</strong> No hay ningún contacto registrado — ni de la app, ni del equipo.</p>
<p class="subtle">Los relevos al buzón del equipo no cuentan acá: un relevo es un aviso retenido, no un aviso entregado.</p></div>`;
  }
  const items = rows
    .map((r) => {
      const canal = CONTACT_CHANNEL_LABEL[r.channel] || r.channel;
      const quien = CONTACT_SOURCE_LABEL[r.source] || r.source;
      const verbo = r.result === 'enviado' ? 'Se avisó por' : 'Falló el aviso por';
      return `<li>${esc(verbo)} <strong>${esc(canal)}</strong> — ${timeTag(r.created_at)} <span class="subtle">(${esc(quien)})</span></li>`;
    })
    .join('');
  const entregados = rows.filter((r) => r.result === 'enviado').length;
  const titulo = entregados
    ? '📣 <strong>Ya se avisó a quien reportó a esta persona.</strong>'
    : '📣 <strong>Se intentó avisar a quien reportó a esta persona, y no se pudo entregar.</strong>';
  return `<div class="notice">
  <p>${titulo}</p>
  <ul>${items}</ul>
  <p class="subtle">Solo lo ve el equipo: esta ficha, para cualquier otro visitante, no muestra este bloque.</p>
</div>`;
}

// Photos stored before thumbnails existed catch up on their own, so nobody has
// to run a maintenance command for the listing to start showing faces.
//
// Bounded and throttled: one small batch per minute per instance, kicked off
// AFTER the page has been sent so it never delays anyone. It stops costing
// anything once there is nothing pending — and on a serverless instance that
// gets frozen mid-sweep, the work is idempotent and simply resumes next time.
const SWEEP_INTERVAL_MS = 60000;
const SWEEP_BATCH = 5;
// Names are a cheap text scan, no image work, so a bigger batch is free.
const SWEEP_NAMES = 200;

// ------------------------------------------------- ideas and bug reports
// The two footer links. Same form, same handler, same destination (a GitHub
// issue) — only the words and the label change.
const FEEDBACK = {
  ideas: {
    noun: 'idea',
    labels: ['idea'],
    emoji: '💡',
    title: 'Ideas',
    heading: '💡 ¿Tienes una idea?',
    intro:
      'Cuéntanos qué falta, qué te confundió o qué haríamos mejor. Cada idea queda como un issue público en GitHub, así que cualquiera puede opinar o construirla.',
    summaryPlaceholder: 'Tu idea en una línea',
    detailsPlaceholder: '¿Para quién sería útil y por qué? (opcional)',
    submit: '💡 Enviar idea',
    thanks: '¡Gracias! Tu idea quedó registrada.',
    fullTitle: 'Comparte una idea — encontrados.co',
    description:
      'Cuéntanos qué le falta a encontrados.co. Cada idea queda como un issue público en GitHub.'
  },
  bug: {
    noun: 'reporte de error',
    labels: ['bug'],
    emoji: '🐛',
    title: 'Reporta un bug',
    heading: '🐛 ¿Algo no funciona?',
    intro:
      'Cuéntanos qué intentabas hacer, qué esperabas y qué pasó en su lugar. Si dice en qué teléfono o navegador te ocurrió, lo arreglamos mucho más rápido.',
    summaryPlaceholder: 'Qué falló, en una línea',
    detailsPlaceholder: 'Qué hiciste, qué esperabas, qué pasó. Teléfono y navegador si los sabes. (opcional)',
    submit: '🐛 Reportar el error',
    thanks: '¡Gracias! Ya sabemos del error.',
    fullTitle: 'Reporta un error — encontrados.co',
    description:
      '¿Algo no funciona en encontrados.co? Cuéntanoslo y queda registrado como un issue público en GitHub.'
  }
};

const SUMMARY_MAX = 120;
const DETAILS_MAX = 4000;

// A field no human sees and every naive bot fills. Cheaper than a captcha and
// it costs a visitor on a bad connection nothing.
const HONEYPOT = `<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">`;

// A public form that opens issues in someone else's repo is an open relay into
// their notifications, so cap it. Per instance and in memory: on serverless
// that is a soft ceiling, not a wall — several instances mean several buckets.
// It is here to bound what ONE instance can do in a burst, which is the part
// that turns a nuisance into a flood; the honeypot above handles the lazy
// bots, and anything targeted needs a real answer, not a bigger number here.
const FEEDBACK_WINDOW_MS = 600000;
const FEEDBACK_MAX = 10;

function createFeedbackThrottle() {
  let windowStart = 0;
  let count = 0;
  return {
    allow() {
      const now = Date.now();
      if (now - windowStart > FEEDBACK_WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      if (count >= FEEDBACK_MAX) return false;
      count++;
      return true;
    }
  };
}

// State per app, not per module: a serverless instance builds exactly one app,
// so the throttle behaves the same in production — and two apps in one process
// (the test suite) don't throttle each other.
function createSweeper(store, matcher) {
  let lastSweep = 0;
  let sweeping = false;
  return function sweep() {
    const now = Date.now();
    if (sweeping || now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    sweeping = true;
    Promise.all([
      backfillPhotoDerivatives(store, matcher, SWEEP_BATCH),
      store.recasePersonNames(SWEEP_NAMES)
    ])
      .then(([, names]) => {
        if (names.fixed.length) console.log(`[nombres] recapitalizados ${names.fixed.length}`);
      })
      .catch((e) => console.error('[mantenimiento] barrido automático falló:', e.message))
      .finally(() => {
        sweeping = false;
      });
  };
}

function webRoutes(store, matcher) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));
  const sweepPhotoDerivatives = createSweeper(store, matcher);
  const admission = createReportAdmission({ store, matcher });

  // ---------------------------------------------------------------- home
  router.get(
    '/',
    wrap(async (req, res) => {
      const [missing, reunited] = await Promise.all([
        store.getMissingPeople(50),
        store.getReunitedCount()
      ]);
      // The only number on this page that is good news. It is also the honest
      // counterweight to the missing count right next to it.
      const reunitedNote = reunited
        ? ` · <span class="reunited-count">🎉 ${reunited} reencontrada${reunited === 1 ? '' : 's'}</span>`
        : '';
      const photos = await store.reportPhotoByPerson(missing.map((p) => p.id));
      const list = missing.length
        ? `<h2>Reportes de desaparecidos más recientes${reunitedNote}</h2>${SOURCES_NOTE}` +
          missing
            .map((p) => {
              // #65: the whole card is a tap target for the ficha (stretched
              // link in CSS), and the rescuer's action sits right on the card
              // instead of waiting at the end of the ficha. The aria-label
              // carries the name — twenty identical links would be
              // indistinguishable to a screen reader.
              //
              // El texto es una AFIRMACIÓN, no una pregunta, y ese es el
              // arreglo: «¿la tienes contigo?» sobre la card del familiar que
              // alguien está buscando se lee como una invitación a decir que
              // sí. Nadie toca «la tengo conmigo» si no la tiene.
              return `<article class="card person">
  <div class="person-info">
    <h3><a class="card-link" href="/person/${p.id}">${esc(p.full_name)}</a></h3>
    <p class="meta">Último reporte: ${timeTag(p.last_report)}</p>
    <a class="card-cta" href="/rescate" aria-label="La tengo conmigo: a ${esc(p.full_name)} — mira quién la busca">🔍 La tengo conmigo</a>
  </div>
  ${facePlate(photos.get(p.id), p.full_name)}
</article>`;
            })
            .join('')
        : `<p class="subtle">Todavía no hay personas reportadas como desaparecidas.${
            reunited ? ` 🎉 ${reunited} reencontrada${reunited === 1 ? '' : 's'}.` : ''
          }</p>${SOURCES_NOTE}`;

      res.send(
        layout(
          'Inicio',
          `
<section class="action-group">
  <h1>Voluntarios, rescatistas, bomberos, policías y hospitales:</h1>
  <a class="big-btn report" href="/rescate">
    <span class="btn-title">🔍 Tengo a alguien conmigo — mira quién lo busca</span>
    <span class="btn-sub">Subes una foto, la comparamos con IA y la borramos al instante</span>
  </a>
</section>
<section class="action-group">
  <h2>¿Estás buscando a alguien?</h2>
  <!-- Relleno sólido, no contorno: acá NO compite con el botón del rescatista
       —está en su propia sección, con su propio encabezado— así que ponerlo en
       contorno solo lo hacía menos visible que en producción hoy, justo el
       camino que estos cambios existen para volver más visible. El contorno se
       reserva para donde los dos botones sí comparten el ojo (la pareja de la
       ficha), que es donde su trabajo es diferenciar. -->
  <a class="big-btn search" href="/report">
    <span class="btn-title">📢 Reporta a la persona que buscas</span>
    <span class="btn-sub">Deja su foto y tu teléfono: quien la encuentre te llama directo</span>
  </a>
</section>
${list}
`,
          {
            fullTitle:
              'Voluntarios, rescatistas, bomberos, policías y hospitales — encontrados.co',
            description:
              'Si rescataste a alguien, sube su foto y te decimos quién la está buscando. La foto se borra de inmediato. También puedes reportar a una persona desaparecida.',
            path: '/'
          }
        )
      );

      // Page already sent: catching old photos up costs this visitor nothing.
      sweepPhotoDerivatives();
    })
  );

  // ------------------------------------------------------------- photos
  // Serves REPORT photos only. A rescuer's photo ('query') is never served:
  // its bytes were dropped at upload, so there is nothing here to return —
  // this route enforces that rather than relying on the row being empty.
  async function sendPhoto(req, res, pick) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
    const photo = await store.getPhoto(id);
    if (!photo || photo.kind !== 'report') return res.status(404).end();
    const { raw, contentType } = pick(photo);
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
    if (!bytes.length) return res.status(404).end();
    res.set('Content-Type', contentType || 'image/jpeg');
    // Photos never change once stored, and a re-request on a bad connection is
    // exactly what this page cannot afford.
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(bytes);
  }

  router.get(
    '/photo/:id',
    wrap((req, res) => sendPhoto(req, res, (p) => ({ raw: p.content, contentType: p.content_type })))
  );

  // The small face crop the public listing loads — a few KB instead of a few
  // hundred. Falls back to nothing (404) rather than serving the full photo:
  // a visitor on a weak connection must never get the big one by accident.
  router.get(
    '/photo/:id/thumb',
    wrap((req, res) => sendPhoto(req, res, (p) => ({ raw: p.thumb, contentType: p.thumb_type })))
  );

  // The same crop at 480px, for the person page — one face shown at 240 CSS px
  // wants to be sharp on a phone screen, where the listing's 80px copy would
  // look like mush.
  router.get(
    '/photo/:id/face',
    wrap((req, res) =>
      sendPhoto(req, res, (p) => ({ raw: p.thumb_large || p.thumb, contentType: p.thumb_type }))
    )
  );

  // Manual version of the sweep above, openable in a browser. Unlike
  // /api/reindex this needs no API key, and it is safe without one: it never
  // notifies anybody, never calls IndexFaces (so it cannot duplicate a face in
  // the collection), and only touches photos that are still missing a
  // thumbnail or their geometry — once they all have both, it does nothing and
  // costs nothing, however many times it is called.
  router.all(
    ['/mantenimiento', '/fotos/actualizar'],
    wrap(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
      const r = await backfillPhotoDerivatives(store, matcher, limit);
      const names = await store.recasePersonNames(500);
      res.send(
        layout(
          'Poner al día',
          `<h1 class="compact">Poner al día</h1>
<h2>Nombres</h2>
${
  names.fixed.length
    ? `<p>✅ Recapitalizados <strong>${names.fixed.length}</strong> de ${names.checked} nombres.</p>
<ul class="subtle">${names.fixed
        .slice(0, 10)
        .map((f) => `<li>${esc(f.from)} → <strong>${esc(f.to)}</strong></li>`)
        .join('')}</ul>`
    : `<p>✅ Los ${names.checked} nombres ya están bien escritos.</p>`
}
<h2>Fotos</h2>
${
  r.processed === 0
    ? '<p>✅ <strong>Todas las fotos están al día.</strong> No quedaba nada por hacer.</p>'
    : `<p>✅ Procesadas <strong>${r.processed}</strong> foto(s): ${r.thumbnails} miniatura(s) y ${r.geometry} rostro(s) detectado(s).${
        r.failed ? ` ${r.failed} no se pudo(ieron) procesar.` : ''
      }</p>
<p><a class="big-btn report" href="/mantenimiento?limit=${limit}">Procesar las siguientes ${limit}</a></p>
<p class="subtle">Repite hasta que diga que están todas al día. También ocurre solo, poco a poco, a medida que la gente visita el inicio.</p>`
}
${
  r.waiting
    ? `<p class="privacy">⚠️ ${r.waiting} foto(s) ya tienen miniatura con recorte centrado, pero les falta ubicar el rostro y el reconocimiento facial no está activo. Cuando vuelva, ejecuta esto otra vez y se reencuadran sobre la cara.</p>`
    : ''
}
<p><a href="/">← Volver al inicio</a></p>`,
          { path: '/mantenimiento' }
        )
      );
    })
  );

  // ------------------------------------------------------------- rescuer
  //
  // El formulario se vuelve a pintar en los caminos de error, y tiene que
  // volver con TODO lo que la persona ya había puesto — el correo, el teléfono
  // y, sobre todo, la casilla de «no guarden nada».
  //
  // Esa casilla perdiéndose no era una molestia de usabilidad: quien la había
  // marcado pidió expresamente que no guardáramos su firma facial, y el
  // reintento sobre un formulario en blanco la indexaba en silencio. Es
  // exactamente lo contrario de lo que esa persona pidió.
  function rescueForm({ email = '', phone = '', searchOnly = false } = {}) {
    return `
<form class="stack compact" method="post" action="/rescate" enctype="multipart/form-data" data-resize-photos data-require-photo>
  <div class="photo-field" data-photo-field>
    <label class="file-label" data-photo-native><span>📷 Foto de la persona que tienes contigo *</span>
      <input type="file" name="photo" accept="image/*" required></label>
    <div class="photo-buttons" data-photo-enhanced hidden>
      <span class="photo-field-label">📷 Foto de la persona que tienes contigo *</span>
      <div class="photo-buttons-row">
        <button type="button" data-photo-camera>📷 Tomar foto</button>
        <button type="button" class="secondary" data-photo-gallery>🖼️ Elegir de galería</button>
      </div>
      <p class="subtle" data-photo-picked aria-live="polite" hidden></p>
    </div>
  </div>
  ${RESCUE_PRIVACY}
  <label class="field-label"><span>Tu correo (opcional — te avisamos si alguien la busca después)</span>
    <input type="email" name="email" value="${esc(email)}" placeholder="tucorreo@ejemplo.com" autocomplete="email"></label>
  <label class="field-label"><span>Tu WhatsApp (opcional — es por donde te llegamos más rápido)</span>
    <input data-phone-filter name="phone" value="${esc(phone)}" inputmode="tel" maxlength="16" pattern="\\+?[0-9]{10,15}" placeholder="3001234567" autocomplete="tel">
    <span class="field-hint-error" hidden>El teléfono ingresado no es válido.</span></label>
  ${searchOnlyCheckbox(searchOnly)}
  <button>🔎 Ver quién la está buscando</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-photo]')) return;
  if (!f.querySelector('input[type=file]').files.length) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Sube una foto de la persona.');
  }
}, true);

// El rescatista que tiene a la persona al lado abre la cámara sin salir de la
// app. Con JS, dos botones manejan UN solo input: «Tomar foto» le pone el
// atributo capture y dispara la cámara; «Elegir de galería» lo quita y abre el
// carrete. Sin JS queda el input nativo, que ya ofrece las dos opciones.
(function () {
  var field = document.querySelector('[data-photo-field]');
  if (!field) return;
  var input = field.querySelector('input[type=file]');
  var native = field.querySelector('[data-photo-native]');
  var enhanced = field.querySelector('[data-photo-enhanced]');
  var picked = field.querySelector('[data-photo-picked]');
  native.hidden = true;
  enhanced.hidden = false;
  // Un input required oculto bloquea el envío con un error que el navegador no
  // puede enfocar; la validación de arriba ya cubre el caso sin foto.
  input.removeAttribute('required');
  field.querySelector('[data-photo-camera]').addEventListener('click', function () {
    input.setAttribute('capture', 'environment');
    input.click();
  });
  field.querySelector('[data-photo-gallery]').addEventListener('click', function () {
    input.removeAttribute('capture');
    input.click();
  });
  input.addEventListener('change', function () {
    var has = input.files.length > 0;
    picked.textContent = has ? '✓ Foto seleccionada' : '';
    picked.hidden = !has;
  });
})();
</script>
${PHONE_FILTER_SCRIPT}`;
  }

  router.get('/rescate', (req, res) => {
    res.send(
      layout(
        'Mira quién la está buscando',
        `
<h1 class="compact">¿Rescataste a alguien? Mira quién la está buscando</h1>
<p class="subtle">Sube una foto de la persona que tienes contigo. La comparamos con las fotos de las personas reportadas como desaparecidas y te mostramos los datos de contacto de quien la busca.</p>
${rescueForm({ email: readCookie(req, EMAIL_COOKIE) })}`,
        {
          fullTitle: 'Mira quién está buscando a la persona que rescataste — encontrados.co',
          description:
            'Sube la foto de la persona que rescataste: te decimos quién la está buscando y cómo contactarlo. La foto se borra de inmediato.',
          path: '/rescate'
        }
      )
    );
  });

  router.post(
    '/rescate',
    upload.single('photo'),
    wrap(async (req, res) => {
      const email = (req.body.email || '').trim();
      const typedPhone = String(req.body.phone || '').trim().slice(0, 40);
      const phone = normalizePhone(req.body.phone);
      // Opt-in por consulta, nunca por tipo de usuario ni por omisión.
      const searchOnly = !!req.body.solo_busqueda;
      // Lo que la persona ya escribió, para devolvérselo en cualquier reintento.
      const typed = { email, phone: typedPhone, searchOnly };
      if (!req.file) {
        return res.status(400).send(
          layout(
            'Mira quién la está buscando',
            `<h1 class="compact">¿Rescataste a alguien?</h1>
<div class="error"><p>Sube una foto de la persona: es lo que permite reconocerla.</p></div>
${rescueForm(typed)}`
          )
        );
      }

      // An anchor person for this rescue, so an email alert can be attached.
      // En modo solo-búsqueda no se crea: no hay firma que sostener, así que no
      // habría ningún aviso futuro que colgarle, y una fila que no sirve para
      // nada es exactamente lo que esta opción viene a no dejar.
      const person = searchOnly
        ? null
        : (
            await store.findOrCreatePerson(
              `${RESCUE_ANCHOR_PREFIX}${crypto.randomBytes(3).toString('hex')}`
            )
          ).person;
      let emailSub = null;
      let pendingVerification = false;
      if (person && EMAIL_RE.test(email)) {
        const result = await store.subscribe(person.id, 'email', email);
        emailSub = result.sub;
        pendingVerification = result.needsVerification;
        remember(res, EMAIL_COOKIE, email);
      }
      let waSub = null;
      if (person && phone) {
        // Nace SIN verificar, a diferencia de la que crea el bot: allá el
        // número lo entrega Meta y por eso es de quien escribe; acá lo tecleó
        // alguien y puede ser el de cualquiera. Lo verifica su dueño, y solo
        // respondiendo.
        const result = await store.subscribe(person.id, 'whatsapp', phone, { verified: false });
        waSub = result.sub;
      }
      // La firma facial queda atada a una sola suscripción, así que se prefiere
      // el correo (que es lo que ya venía pasando) y el WhatsApp toma el relevo
      // cuando es el único canal que dejaron.
      const sub = emailSub || waSub;

      const { available, unreadable, matches } = await identifyRescuedPerson(store, matcher, {
        bytes: req.file.buffer,
        contentType: req.file.mimetype,
        personId: person ? person.id : null,
        subscriptionId: sub ? sub.id : null,
        searchOnly
      });

      if (emailSub && pendingVerification) {
        await sendVerificationEmail(person, emailSub);
      }

      // Hasta ahora la coincidencia solo vivía en esta pantalla: si el
      // rescatista cerraba la página, no quedaba forma de volver a llegarle.
      // Nunca puede tumbar la respuesta — quien está parado al lado de una
      // persona necesita ver el resultado, pase lo que pase con los avisos.
      // En modo solo-búsqueda no sale ninguno: la confirmación por WhatsApp
      // también deja una fila, y acá lo que se prometió es no dejar nada.
      if (!searchOnly && matches && matches.length) {
        try {
          await notifyRescuerOfMatches(store, { emailSub, phone, matches });
        } catch (e) {
          console.error('[rescate] los avisos al rescatista fallaron:', e.message);
        }
      }

      let body;
      if (unreadable) {
        // Say what happened and what to do about it. This used to be a bare
        // "Error interno del servidor" — a dead end for someone standing next
        // to the person they just pulled out.
        const retry = rescueForm(typed);
        // El formulario de arriba se construye acá mismo, pero lo que está en
        // juego es el consentimiento de alguien sobre su propia firma facial,
        // así que no se da por hecho: se comprueba sobre el HTML que realmente
        // va a salir. Si la casilla no volvió marcada, la persona tiene que
        // enterarse ANTES de volver a subir la foto, no después.
        const keptSearchOnly = /name="solo_busqueda"[^>]*checked/.test(retry);
        body =
          `<div class="error">
  <p><strong>No pudimos leer esa foto.</strong> El archivo llegó en un formato que no podemos procesar.</p>
  <p>Vuelve a intentarlo tomando la foto <strong>directamente con la cámara</strong> desde esta página, o guárdala como JPG antes de subirla.</p>
  ${
    searchOnly
      ? keptSearchOnly
        ? '<p>Dejamos marcada tu casilla de <strong>«no guarden nada»</strong> y tu contacto tal como los escribiste: al reintentar sigue sin guardarse ninguna firma facial.</p>'
        : '<p>⚠️ <strong>Ojo:</strong> no pudimos conservar tu casilla de «no guarden nada». <strong>Vuelve a marcarla</strong> antes de reintentar, o esta foto sí dejará una firma facial guardada.</p>'
      : '<p>Dejamos tu contacto tal como lo escribiste.</p>'
  }
</div>` + retry;
      } else if (!available) {
        body =
          `<div class="error"><p>El reconocimiento facial no está disponible en este momento. Inténtalo de nuevo en unos minutos.</p></div>` +
          REPORT_EXIT_BLOCK;
      } else if (!matches.length) {
        body = `<div class="error">
  <p><strong>Nadie ha reportado a esta persona como desaparecida todavía.</strong></p>
  <p>${
    searchOnly
      ? 'Pediste que no guardáramos nada, así que no quedó ninguna firma facial: <strong>no vamos a poder avisarte</strong> si alguien la reporta más adelante. Vuelve a consultar cuando quieras, o repite la consulta sin marcar esa casilla para que sí podamos avisarte.'
      : emailSub
        ? `Te avisaremos por correo cuando alguien la busque (confirma tu correo con el enlace que te enviamos).${
            relayEnabled() ? ` ${REVIEWED_NOTE}` : ''
          }`
        : waSub
          ? // Acá NO se puede prometer un aviso automático, y esto es lo que
            // cambió: el número quedó guardado pero nadie lo confirmó, y sin
            // coincidencia no hay ninguna pregunta que mandarle para que su
            // dueño lo confirme. Un mensaje automático a un número sin dueño
            // comprobado es justo lo que este servicio no puede hacer. Así que
            // la fila queda —le sirve a una persona del equipo para ubicarte—
            // y la promesa se cae, en vez de dejar el copy prometiendo algo que
            // el código no tiene forma de cumplir.
            'Guardamos tu número, pero <strong>no podemos confirmarlo</strong>, así que no te vamos a escribir solos: si alguien reporta a esta persona, una persona del equipo revisa el caso y te contacta por ahí. Si quieres el aviso por un canal que sí podemos confirmar de una vez, déjanos también tu correo.'
          : 'Vuelve a intentarlo más tarde, o déjanos tu correo o tu WhatsApp para avisarte cuando alguien la busque.'
  }</p>
</div>
${REPORT_EXIT_BLOCK}`;
      } else {
        body =
          `<h2>${matches.length === 1 ? 'La están buscando' : 'Coincidencias encontradas'}</h2>` +
          matches
            .map(
              (m) => `<article class="card">
  <h3><a href="/person/${m.person.id}">${esc(m.person.full_name)}</a></h3>
  <p>👤 Coincidencia facial: <strong>${Math.round(m.similarity)}%</strong></p>
  ${matchContactBlock(m)}
  ${m.update && m.update.location ? `<p class="loc">📍 Visto por última vez: ${esc(m.update.location)}</p>` : ''}
</article>`
            )
            .join('') +
          '<p class="subtle">Verifica siempre la identidad antes de entregar información sensible.</p>';
      }

      res.send(
        layout(
          'Resultado',
          `<h1 class="compact">Resultado</h1>
${body}
<p class="notice">🔒 La foto que subiste ya fue borrada. No quedó almacenada en ningún servidor.${
            searchOnly
              ? ' Tampoco guardamos su firma facial, como pediste: de esta consulta no quedó nada, y por eso no vamos a poder avisarte si alguien reporta a esta persona después.'
              : ''
          }</p>
${RESCUE_FOOTER}`
        )
      );
    })
  );

  // A rescuer matched a ficha that carries no family contact (typically one
  // imported from a public registry). The aviso lands on the person's
  // timeline with status 'missing' ON PURPOSE: the person's current status is
  // the latest update's status, and an unverified sighting must not delist
  // them. The phone and the person's whereabouts travel in `contact`, which
  // is never rendered publicly (updateCard drops it; only a future
  // face-matched rescuer sees it) — the public page must not announce where a
  // vulnerable person can be found. Operators verify and relay to the source
  // registry; only a verified reunion flips the status.
  router.post(
    '/rescate/aviso',
    wrap(async (req, res) => {
      const personId = String(req.body.person_id || '').trim();
      const phone = String(req.body.phone || '')
        .trim()
        .slice(0, 60);
      const location = String(req.body.location || '')
        .trim()
        .slice(0, 160);
      const person = personId ? await store.getPerson(personId) : null;
      if (!person || !phone || !location) {
        return res.status(400).send(
          layout(
            'Aviso incompleto',
            `<h1 class="compact">Falta información</h1>
<div class="error"><p>Necesitamos tu teléfono y dónde está ahora la persona que rescataste.</p></div>
<p><a class="big-btn report" href="/rescate">Volver a intentar</a></p>`
          )
        );
      }

      const update = await store.addUpdate(person.id, {
        status: 'missing',
        message:
          'Aviso de un rescatista: la persona fue vista y sabemos dónde puede ser localizada. Estamos haciendo llegar el aviso a quien la busca.',
        source: 'rescate',
        contact: `${phone} · la persona puede ser localizada en: ${location}`
      });

      // Best effort: the aviso already lives in the timeline; this mail is the
      // operators' real-time signal to go relay it to the source registry. An
      // email failure must never lose the aviso.
      const relayResult = await mailOperators(
        `Aviso de rescatista — ${person.full_name}`,
        [
          'Un rescatista informa dónde puede ser localizada una persona reportada como desaparecida.',
          `Persona: ${person.full_name} (${env.BASE_URL}/person/${person.id})`,
          `Teléfono del rescatista: ${phone}`,
          // La etiqueta de esta línea la leen herramientas que procesan
          // este buzón. Es un nombre de campo, no copy: cambiarlo rompe su
          // parseo en silencio. La pregunta que se le hace al rescatista sí
          // se reformuló, arriba en el formulario.
          `Dónde puede ser localizada: ${location}`,
          '',
          'Siguiente paso: verificar y hacer llegar el aviso a la fuente del reporte (Colombia Te Busca: llenar su formulario de información en nombre del rescatista).'
        ].join('\n')
      );
      // Bitácora (#116): esto es un aviso OPERATIVO al equipo — pide que un
      // operador verifique y reenvíe a la fuente — no un aviso a una persona.
      // Mismo canal 'relevo' que ya usa el relevo de coincidencias pendientes
      // de revisión (src/facematch.js): el enum existente ya significa "esto
      // fue al buzón del equipo, no a un tercero".
      await logContact(store, { personId: person.id, updateId: update.id, channel: 'relevo', result: resultFromSend(relayResult) });

      res.send(
        layout(
          'Aviso enviado',
          `<h1 class="compact">Aviso enviado ✅</h1>
<p><strong>Nos encargamos de hacerle llegar tu aviso a quien busca a ${esc(person.full_name)}.</strong> Te contactarán al número que dejaste.</p>
<p class="subtle">Tu teléfono no se muestra públicamente: solo se comparte para coordinar el reencuentro.</p>
${RESCUE_FOOTER}`
        )
      );
    })
  );

  // ------------------------------------------------- report a missing person
  router.get('/report', (req, res) => {
    const remembered = rememberedContact(req);
    res.send(
      layout(
        'Reporta desaparecido',
        `
<h1 class="compact">Reporta una persona desaparecida</h1>
<p class="subtle">Cuando un rescatista tenga a esta persona, verá tus datos de contacto y se comunicará contigo directamente. Quien te avisa es esa persona: encontrados.co no te llama ni te escribe por este reporte.</p>
<form class="stack compact" method="post" action="/report" enctype="multipart/form-data" data-resize-photos data-require-photos>
  <label class="file-label"><span>📷 Fotos de la persona * (1 a 3 — así la reconocen los rescatistas)</span>
    <input type="file" name="photos" accept="image/*" multiple required></label>
  ${REPORT_PRIVACY}
  <label class="field-label"><span>Nombre completo de la persona *</span>
    <input name="name" required value="${esc(req.query.name || '')}" placeholder="Ej. María Fernanda López" autocomplete="off"></label>
  ${fichaOriginField(req.query.desde)}
  <label class="field-label"><span>Dónde crees que estaba *</span>
    <span id="location-field">
      <input name="location" id="location" list="location-options" autocomplete="off" placeholder="Ej. Barrio San José, Armenia" required>
      <datalist id="location-options"></datalist>
    </span></label>
  <label class="field-label"><span>Tu teléfono para que te contacten</span>
    <input name="contact_phone" data-phone-filter inputmode="tel" autocomplete="tel" maxlength="16" pattern="\\+?[0-9]{10,15}" value="${esc(remembered.phone)}" placeholder="Ej. 3001234567">
    <span class="field-hint-error" hidden>El teléfono ingresado no es válido.</span></label>
  <label class="field-label"><span>Tu correo</span>
    <input name="contact_email" type="email" inputmode="email" autocomplete="email" maxlength="120" value="${esc(remembered.email)}" placeholder="tucorreo@ejemplo.com"></label>
  <p class="subtle contact-note">Con uno basta.</p>
  <label class="field-label"><span>Otros datos que ayuden a reconocerla (opcional)</span>
    <textarea name="message" rows="2" placeholder="Señas, ropa, edad, dónde suele estar…"></textarea></label>
  <button>Reporta desaparecido</button>
</form>
<script>
document.addEventListener('submit', function (ev) {
  var f = ev.target;
  if (!f.matches('form[data-require-photos]')) return;
  if (!f.querySelector('input[type=file]').files.length) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert('Sube al menos una foto de la persona.');
  }
}, true);
</script>
${PHONE_FILTER_SCRIPT}
${LOCATION_SCRIPT}`,
        {
          fullTitle: 'Reporta una persona desaparecida — encontrados.co',
          description:
            'Reporta a una persona desaparecida con sus fotos, el lugar donde crees que estaba y tu contacto. Los rescatistas podrán reconocerla y avisarte.',
          path: '/report'
        }
      )
    );
  });

  router.post(
    '/report',
    upload.array('photos', 8),
    wrap(async (req, res) => {
      const { name, location, message } = req.body;
      const phone = String(req.body.contact_phone || '').trim();
      const email = String(req.body.contact_email || '').trim();
      // Sigue habiendo UNA sola obligación de contacto, ahora repartida en dos
      // casillas: con cualquiera de las dos el reporte pasa, igual que antes.
      const contact = composeContact({ phone, email, contact: req.body.contact });
      const files = (req.files || []).slice(0, MAX_QUERY_PHOTOS);
      if (!name || !name.trim() || !location || !location.trim() || !contact || !files.length) {
        return res
          .status(400)
          .send(
            layout(
              'Error',
              '<p class="error">Faltan datos: hacen falta las fotos, el nombre, el lugar y un teléfono o correo de contacto.</p>'
            )
          );
      }
      // Unlike /rescate's optional phone (which degrades silently), a filled-in
      // box here means the reporter wants it used: a value that isn't a phone
      // number (letters, symbols, too short) is rejected, not dropped.
      // normalizePhone() alone isn't enough: it strips non-digits before
      // counting them, so a letter mixed into an otherwise-valid number (e.g.
      // "300a1234567") would silently pass. PHONE_RAW_RE rejects anything but
      // digits, spaces, and a leading '+' before normalizePhone ever sees it.
      if (phone && (!PHONE_RAW_RE.test(phone) || !normalizePhone(phone))) {
        return res
          .status(400)
          .send(
            layout(
              'Error',
              '<p class="error">El teléfono de contacto no es válido: escribe un número de celular de 10 dígitos.</p>'
            )
          );
      }

      // Thin adapter: the shared report-admission service owns the whole domain
      // sequence — person, update, owner resolution, photo indexing, and
      // subscriber notification (skipping both contact fields this form
      // collects so the reporter isn't echoed their own report). The
      // duplicate check runs LAST, once the report is durable. This handler
      // keeps only the web-specific parts: multipart files in, cookies and
      // the 303.
      //
      // Sin `reporter`: este formulario ya no pide el nombre de quien reporta
      // —era una casilla del relevo a un registro de terceros, que se retiró—.
      // La columna sigue viva y la siguen llenando el API y los agregadores,
      // así que las fichas que ya lo traen se siguen viendo igual.
      const result = await admission.admitReport({
        name,
        status: 'missing',
        message,
        location,
        source: 'web',
        contact,
        photos: files.map((f) => ({ bytes: f.buffer, contentType: f.mimetype })),
        skipAddresses: [phone, email.toLowerCase()].filter(Boolean),
        checkDuplicates: true,
        includePriorPhoto: true
      });
      // Unreachable today — the check above already covers the one field the
      // service validates that this route doesn't (`name`) — but the service
      // is the single source of truth for its own contract: a caller that
      // stops prevalidating, or a validation rule that changes only on one
      // side, must get a 400 here instead of a TypeError on `result.person`.
      if (!result.ok) {
        return res
          .status(400)
          .send(
            layout(
              'Error',
              '<p class="error">Faltan datos: hacen falta las fotos, el nombre, el lugar y un teléfono o correo de contacto.</p>'
            )
          );
      }
      const { person, personCreated: created, update, photos, priorPhoto, candidates } = result;

      remember(res, REPORTER_COOKIE, phone || contact);
      remember(res, EMAIL_COOKIE, email);

      // Two different ways this report can be a duplicate:
      //   created === false → the NAME matched, so it was appended to a record
      //     that may or may not be the same human;
      //   candidates        → a FACE matched a report filed under another name,
      //     which is now a second record for one person.
      //
      // Either way the answer is a 303, never a page rendered onto the POST:
      // this handler stores photos and pays for a face index per photo, so a
      // reload of its response would manufacture the very duplicate it warns
      // about. The finding travels in a short-lived COOKIE, not in the URL: a
      // link is shareable and a cookie is not, and this warning asserts that
      // two specific missing people may be the same person — a claim only the
      // server is entitled to make, and only for the visitor who just reported.
      // Ver fichaOriginField: si este reporte salió de la ficha de esta misma
      // persona, sumarse a su registro es el objetivo del botón, no un hallazgo
      // — la alarma de nombre duplicado sería falsa el 100% de las veces. Solo
      // se apaga esa: los `candidates` por ROSTRO son información nueva y real
      // (un reporte con otro nombre y la misma cara), y siguen saliendo.
      const desdeFicha = String(req.body.desde_ficha || '').trim();
      const sameNameIsExpected = !created && desdeFicha && desdeFicha === String(person.id);
      const sameName = !created && !sameNameIsExpected;
      if (candidates.length || sameName) {
        rememberDuplicateFinding(res, {
          p: person.id,
          n: sameName ? 1 : 0,
          f: priorPhoto ? priorPhoto.id : 0,
          c: candidates.map((c) => ({ i: c.person.id, r: c.reason, s: c.similarity }))
        });
      }

      // The report is saved either way, but a photo the matcher cannot read is
      // a report that no rescuer will ever match — and the one thing worse
      // than a failed upload is a family believing a failed one succeeded.
      const unreadable = photos.filter((p) => p.unreadable).length;
      const flag = unreadable ? `&fotos_ilegibles=${unreadable}` : '';
      res.redirect(303, `/person/${person.id}?reported=1${flag}`);
    })
  );

  // --------------------------------------------------------- person page
  router.get(
    '/person/:id',
    wrap(async (req, res) => {
      const person = await store.getPerson(req.params.id);
      if (!person) {
        return res.status(404).send(layout('No encontrado', '<p class="error">Persona no encontrada.</p>'));
      }
      const updates = await store.getUpdates(person.id);
      const photo = (await store.reportPhotoByPerson([person.id])).get(person.id);
      // Bitácora de avisos a quien reportó — solo con sesión de
      // administración. La consulta ni siquiera se hace para un visitante
      // anónimo: una ficha pública no debe pagar una consulta más por un
      // bloque que no va a renderizar.
      const isTeam = !!readSession(req);
      const contactHistory = isTeam ? contactHistoryBlock(await store.familyContactLogByPerson(person.id)) : '';
      // La respuesta deja de ser la misma para todo el mundo en cuanto este
      // bloque aparece. Sin esto, un intermediario que cachee la página por
      // URL podría servirle a un visitante anónimo la copia que se armó para
      // el equipo. Hoy nada cachea esta ruta; el encabezado es lo que hace
      // que siga siendo cierto si mañana algo lo hace.
      if (isTeam) res.set('Cache-Control', 'private, no-store');
      // Only worth a banner when the newest report ISN'T the located one —
      // otherwise it just repeats the card right below it.
      const lastLocated = updates.find((u) => u.location);
      const locationIsBuried = lastLocated && lastLocated !== updates[0];

      // Possible-duplicate warning for the visitor who just filed this report.
      // It comes from the cookie POST /report set, never from the URL — see
      // DUP_COOKIE above for why. Shown once, then cleared.
      const finding = readDuplicateFinding(req, person.id);
      let duplicates = '';
      if (finding) {
        clearDuplicateFinding(res);
        const wanted = finding.candidates.filter(
          (c) => Number.isInteger(Number(c.i)) && Number(c.i) > 0 && String(c.i) !== String(person.id)
        );
        const dupPhotos = await store.reportPhotoByPerson(wanted.map((c) => Number(c.i)));
        const candidates = (
          await Promise.all(
            wanted.map(async (c) => {
              const other = await store.getPerson(Number(c.i));
              if (!other) return null;
              return {
                person: other,
                photo: dupPhotos.get(Number(c.i)) || null,
                update: await store.getLatestUpdate(Number(c.i)),
                // A 97% facial match and a name that merely scored 0.61 are not
                // the same evidence, and an anxious family reads this card as
                // if they were. Keep them distinguishable.
                reason: c.r === 'face' ? 'face' : 'name',
                similarity: Number(c.s) || null
              };
            })
          )
        ).filter(Boolean);

        let priorPhoto = null;
        if (finding.priorPhotoId) {
          // Metadata only — `getPhoto` would drag the full image and both
          // thumbnails out of Postgres just to read `thumb_type`.
          const p = await store.getReportPhotoMeta(finding.priorPhotoId);
          // Same guard as GET /photo/:id — a rescuer's photo is never rendered.
          if (p && p.kind === 'report' && String(p.person_id) === String(person.id)) priorPhoto = p;
        }
        duplicates = duplicateNotice({
          person,
          sameName: finding.sameName,
          priorPhoto,
          candidates
        });
      }

      res.send(
        layout(
          person.full_name,
          `
${req.query.reported ? '<p class="notice">✅ Reporte registrado. Cuando un rescatista tenga a esta persona, verá tus datos de contacto y se comunicará contigo directamente. El aviso te llega de esa persona, no de nosotros.</p>' : ''}
${
  req.query.fotos_ilegibles
    ? `<div class="error">
  <p><strong>Ojo: no pudimos leer ${Number(req.query.fotos_ilegibles) === 1 ? 'una de las fotos' : 'algunas de las fotos'} que subiste.</strong> El reporte quedó registrado, pero esa foto no sirve para que un rescatista reconozca a la persona.</p>
  <p>Añade otra foto desde esta página, tomada <strong>directamente con la cámara</strong> o guardada como JPG.</p>
</div>`
    : ''
}
${duplicates}
${contactHistory}
<div class="person-body">
  <h1>${esc(person.full_name)}</h1>
  <div class="person-updates">
${locationIsBuried ? `<p class="notice">📍 Última ubicación reportada: <strong>${esc(lastLocated.location)}</strong> (${timeTag(lastLocated.created_at)})</p>` : ''}
${updates.length ? updates.map((u) => updateCard(u)).join('') : '<p class="subtle">Sin reportes todavía.</p>'}
  </div>
  ${facePlate(photo, person.full_name, { large: true })}
</div>
<p class="subtle">Los datos de contacto de quien reporta solo se muestran a un rescatista cuando el rostro coincide.</p>
<div class="sticky-cta cta-par">
  <a class="big-btn report" href="/rescate">🔍 La tengo conmigo</a>
  <a class="big-btn secondary" href="/report?name=${encodeURIComponent(person.full_name)}&desde=${person.id}">🙋 Yo la estoy buscando — dejar mi contacto</a>
</div>`,
          {
            fullTitle: `${person.full_name} — reportada como desaparecida · encontrados.co`,
            description: `${person.full_name} fue reportada como desaparecida tras el terremoto en Colombia. Si la rescataste, encontrados.co te dice quién la está buscando.`,
            path: `/person/${person.id}`
          }
        )
      );
    })
  );

  // ------------------------------------------- rescuer alert confirmation
  router.all('/revisa-tu-correo', (req, res) => {
    const next = String(req.query.next || '/');
    const safeNext = next.startsWith('/') ? next : '/';
    res.send(
      layout(
        'Revisa tu correo',
        `
<div class="takeover">
  <div class="takeover-emoji">📬</div>
  <h1>Para continuar, sigue el enlace que te enviamos por correo.</h1>
  <p>Sin ese paso no podremos avisarte. Revisa tu bandeja de entrada —y la carpeta de spam— un correo de <strong>a@torrenegra.com</strong>.</p>
  <p class="subtle"><a href="${esc(safeNext)}">Volver</a></p>
</div>`,
        { fullTitle: 'Revisa tu correo — encontrados.co' }
      )
    );
  });

  router.all(
    '/verify',
    wrap(async (req, res) => {
      const sub = await store.verifySubscription(req.query.token);
      if (!sub) {
        return res
          .status(404)
          .send(layout('Enlace inválido', '<p class="error">Este enlace de confirmación no es válido o ya fue usado.</p>'));
      }
      res.send(
        layout(
          'Aviso confirmado',
          `
<div class="takeover">
  <div class="takeover-emoji">✅</div>
  <h1>Listo: te avisaremos por correo cuando alguien busque a esta persona.</h1>
  ${relayEnabled() ? `<p class="subtle">${REVIEWED_NOTE}</p>` : ''}
  <p class="subtle"><a href="/">Ir al inicio</a></p>
</div>`,
          { fullTitle: 'Aviso confirmado — encontrados.co' }
        )
      );
    })
  );

  router.all(
    '/unsubscribe',
    wrap(async (req, res) => {
      // La suscripción ya se lleva sus face_id (la cascada de subscription_id
      // se llevaría la fila de `photos` con ellos — #162); retirarlos de
      // Rekognition después es best effort y nunca bloquea la confirmación.
      const sub = await store.unsubscribeByToken(req.query.token);
      if (!sub) {
        return res
          .status(404)
          .send(layout('Enlace inválido', '<p class="error">Este enlace ya no es válido: el aviso no existe.</p>'));
      }
      await forgetPersonFaces(matcher, sub.faceIds, `suscripción ${sub.id}`);
      res.send(
        layout(
          'Aviso cancelado',
          `<p class="notice">✅ Listo: ya no recibirás avisos.</p><p><a href="/">Ir al inicio</a></p>`
        )
      );
    })
  );

  // ------------------------------------------------- ideas and bug reports
  // Two footer links, one handler. Everything sent here becomes a GitHub
  // issue, so the backlog is public and anyone can pick something up.
  const throttle = createFeedbackThrottle();

  function feedbackForm(kind, values = {}) {
    const k = FEEDBACK[kind];
    return `<form class="stack compact" method="post" action="/${kind}">
  <label class="field-label"><span>Resumen *</span>
    <input name="summary" required maxlength="${SUMMARY_MAX}" value="${esc(values.summary || '')}" placeholder="${esc(k.summaryPlaceholder)}"></label>
  <label class="field-label"><span>Detalles (opcional)</span>
    <textarea name="details" rows="5" maxlength="${DETAILS_MAX}" placeholder="${esc(k.detailsPlaceholder)}">${esc(values.details || '')}</textarea></label>
  ${HONEYPOT}
  <button>${esc(k.submit)}</button>
</form>`;
  }

  // The one thing that must be said before anyone types: a GitHub issue is a
  // public, permanent, search-engine-indexed page. On a site whose front door
  // says "reporta desaparecido", somebody WILL land on the bug form and start
  // typing their sister's name and their phone number. Say so first, and put
  // the door they actually wanted right next to the warning.
  const PUBLIC_WARNING = `<p class="privacy">⚠️ <strong>Lo que escribas aquí es público</strong> y queda publicado en GitHub para siempre. No pongas aquí el nombre de una persona desaparecida, tu teléfono ni tu correo. ¿Buscas a alguien? <a href="/report">Repórtala aquí</a> — ahí tu contacto queda privado, aunque la foto de la persona se publica para que un rescatista pueda reconocerla.</p>`;

  function feedbackPage(kind, { body, values, status = 200 } = {}) {
    const k = FEEDBACK[kind];
    return {
      status,
      html: layout(
        k.title,
        `<h1 class="compact">${esc(k.heading)}</h1>
<p class="subtle">${k.intro}</p>
${PUBLIC_WARNING}
${body || ''}
${feedbackForm(kind, values)}
<p class="subtle">¿Ya tienes cuenta de GitHub? También puedes <a href="${gh.newIssueUrl(k.labels)}" target="_blank" rel="noopener">abrir el issue tú mismo</a> o <a href="${gh.issuesUrl()}" target="_blank" rel="noopener">ver lo que ya está reportado</a>.</p>`,
        { fullTitle: k.fullTitle, description: k.description, path: `/${kind}` }
      )
    };
  }

  for (const kind of Object.keys(FEEDBACK)) {
    router.get(`/${kind}`, (req, res) => {
      const page = feedbackPage(kind);
      res.send(page.html);
    });

    router.post(
      `/${kind}`,
      wrap(async (req, res) => {
        const k = FEEDBACK[kind];
        const summary = String(req.body.summary || '')
          .trim()
          .slice(0, SUMMARY_MAX);
        const details = String(req.body.details || '')
          .trim()
          .slice(0, DETAILS_MAX);

        // A bot filling the hidden field gets the success page and nothing
        // else: telling it that it was caught only teaches it to try again.
        if (String(req.body.website || '').trim()) {
          console.warn(`[${kind}] honeypot — descartado`);
          return res.send(feedbackDone(kind, null).html);
        }

        if (!summary) {
          const page = feedbackPage(kind, {
            status: 400,
            values: { details },
            body: `<div class="error"><p>Escribe al menos una línea para saber de qué se trata.</p></div>`
          });
          return res.status(page.status).send(page.html);
        }

        if (!throttle.allow()) {
          console.warn(`[${kind}] límite por instancia alcanzado — no se creó el issue`);
          const page = feedbackPage(kind, {
            status: 429,
            values: { summary, details },
            body: `<div class="error"><p>Estamos recibiendo muchos mensajes en este momento. Inténtalo de nuevo en unos minutos, o <a href="${gh.newIssueUrl(k.labels)}" target="_blank" rel="noopener">ábrelo directamente en GitHub</a>.</p></div>`
          });
          return res.status(page.status).send(page.html);
        }

        const body = [
          details || '_(sin detalles)_',
          '',
          '---',
          `Enviado desde el formulario de ${k.noun} de encontrados.co.`
        ].join('\n');

        const issue = await gh.createIssue({ title: summary, body, labels: k.labels });

        // No token, or GitHub is down: the message must not evaporate. Mail it
        // to the operators so it can be filed by hand — from the sender's side
        // the outcome is the same, which is the point.
        if (!issue.ok) {
          const result = await mailOperators(
            `[${k.noun}] ${summary}`,
            [
              `No se pudo crear el issue en GitHub (${issue.error || 'motivo desconocido'}). Queda aquí para abrirlo a mano.`,
              '',
              `Tipo: ${k.noun}`,
              `Resumen: ${summary}`,
              '',
              details || '(sin detalles)'
            ].join('\n')
          );
          if (!result.ok) {
            console.error(`[${kind}] PERDIDO — sin GitHub y sin este respaldo por correo (${result.error}): "${logSafe(summary)}"`);
          }
        }

        res.send(feedbackDone(kind, issue.ok ? issue.url : null).html);
      })
    );
  }

  function feedbackDone(kind, issueUrl) {
    const k = FEEDBACK[kind];
    return {
      html: layout(
        k.title,
        `<div class="takeover">
  <div class="takeover-emoji">${k.emoji}</div>
  <h1>${esc(k.thanks)}</h1>
  ${
    issueUrl
      ? `<p>Quedó registrado aquí: <a href="${esc(issueUrl)}" target="_blank" rel="noopener">ver en GitHub</a>.</p>`
      : '<p>Lo recibimos y queda registrado.</p>'
  }
  <p class="subtle"><a href="/${kind}">Enviar otro</a> · <a href="/">Ir al inicio</a></p>
</div>`,
        { fullTitle: k.fullTitle }
      )
    };
  }

  // --------------------------------------------------------------- legal
  router.get('/privacidad', (req, res) => {
    res.send(
      layout(
        'Política de privacidad',
        `
<h1>Política de privacidad</h1>
<p class="subtle">Última actualización: 10 de agosto de 2026</p>
<p><strong>encontrados.co</strong> existe con un único propósito: que un rescatista que tiene a una persona a su lado pueda encontrar a quien la está buscando, tras el terremoto en Colombia del lunes 10 de agosto.</p>

<h2>La foto del rescatista no se guarda</h2>
<p>Cuando un rescatista sube la foto de la persona que tiene consigo, esa imagen se compara al instante y <strong>se borra de inmediato</strong>. No queda almacenada en ningún servidor y no se muestra en ninguna parte. Solo conservamos sus <em>metadatos faciales</em>: la firma facial —un código matemático que permite comparar rostros pero <strong>no permite reconstruir la fotografía</strong>— para poder avisarle si más adelante alguien reporta a esa persona como desaparecida.</p>

<h2>Las fotos de los reportes sí se publican</h2>
<p>Es distinto cuando reportas a una persona desaparecida: esas fotos <strong>se guardan y se muestran públicamente</strong> en la lista de personas desaparecidas, junto con los puntos de reconocimiento facial que el sistema detecta sobre el rostro. Ese es justamente el propósito del reporte: que cualquier rescatista pueda reconocer a la persona que tiene al lado. Sube únicamente fotos que quieras hacer públicas. Para eliminar un reporte o sus fotos, escribe a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</p>

<h2>Datos de contacto</h2>
<p>El teléfono o correo de quien reporta se muestra <strong>solo</strong> a un rescatista cuando el rostro de la persona que tiene consigo coincide con el reporte. No aparece en las páginas públicas ni se comparte de ninguna otra forma.</p>

<h2>Qué es público</h2>
<p>El nombre de la persona reportada, su estado y el lugar donde se le vio por última vez son visibles públicamente: ese es el propósito del servicio.</p>

<h2>Avisos y baja</h2>
<p>Solo los rescatistas pueden registrar un aviso por correo, y requiere confirmar el correo. Cada aviso incluye un enlace para darse de baja con un clic. Para eliminar un reporte o sus fotos, escribe a <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</p>

<h2>Qué no hacemos</h2>
<ul>
  <li>No vendemos ni compartimos datos con terceros con fines comerciales.</li>
  <li>No usamos la información para publicidad.</li>
  <li>No usamos las fotos para nada distinto a lo descrito aquí: comparar rostros y, en el caso de los reportes, mostrar a la persona buscada.</li>
</ul>`,
        { fullTitle: 'Política de privacidad — encontrados.co', path: '/privacidad' }
      )
    );
  });

  router.get('/terminos', (req, res) => {
    res.send(
      layout(
        'Términos de servicio',
        `
<h1>Términos de servicio</h1>
<p class="subtle">Última actualización: 10 de agosto de 2026</p>
<p><strong>encontrados.co</strong> es un servicio gratuito y de emergencia que conecta a quien rescata a una persona con quien la está buscando. Al usarlo aceptas estos términos, deliberadamente simples dada la naturaleza de la emergencia:</p>
<ul>
  <li><strong>Úsalo de buena fe.</strong> Reporta solo información que creas cierta. Está prohibido publicar datos falsos o usar el servicio para localizar a alguien que no quiere ser encontrado.</li>
  <li><strong>Los datos de contacto son para reunir familias.</strong> Al mostrarse tras una coincidencia facial, deben usarse únicamente para informar sobre la persona; cualquier otro uso está prohibido.</li>
  <li><strong>Verifica antes de actuar.</strong> El reconocimiento facial es una ayuda, no una prueba: una coincidencia puede ser errónea. Confirma siempre la identidad por otros medios.</li>
  <li><strong>Sin garantías.</strong> El servicio se ofrece "tal cual", sin garantía de disponibilidad ni exactitud, y no sustituye a las autoridades ni a los organismos de socorro.</li>
  <li><strong>Podemos retirar contenido</strong> que incumpla estos términos y atender solicitudes de eliminación en <a href="mailto:a@torrenegra.com">a@torrenegra.com</a>.</li>
</ul>`,
        { fullTitle: 'Términos de servicio — encontrados.co', path: '/terminos' }
      )
    );
  });

  // ------------------------------------------------------------ api docs
  router.get(['/api-doc', '/api-docs'], (req, res) => {
    res.send(
      layout(
        'API',
        `
<h1>API de encontrados.co</h1>
<p>Base: <code>https://encontrados.co/api</code> · JSON. Pensada para organismos de socorro que quieran reportar en lote.</p>

<h2>Reportar una persona desaparecida</h2>
<pre>curl -X POST https://encontrados.co/api/updates \\
  -H 'Content-Type: application/json' \\
  -d '{
    "name": "Juan Carlos Pérez",
    "status": "missing",
    "location": "Barrio San José",
    "contact": "300 123 4567",
    "photo": { "base64": "&lt;JPEG en base64&gt;", "content_type": "image/jpeg" }
  }'</pre>
<ul>
  <li><code>name</code> y <code>status</code> son obligatorios. Para desaparecidos usa <code>missing</code>.</li>
  <li><code>contact</code>: teléfono o correo de quien debe ser avisado. Solo se muestra a un rescatista cuando hay coincidencia facial.</li>
  <li><code>photo</code>: opcional pero decisiva — es lo que permite el reconocimiento facial.</li>
</ul>

<h2>Duplicados</h2>
<p>La respuesta <code>201</code> incluye siempre un bloque <code>duplicate</code>. <strong>Es un aviso, nunca un rechazo</strong>: el reporte queda guardado pase lo que pase.</p>
<pre>{
  "person_id": 42,
  "person_created": false,
  "duplicate": {
    "merged_into_existing_person": true,
    "candidates": [
      { "person_id": 17, "full_name": "Juan Carlos Pérez",
        "reason": "face", "similarity": 97, "name_score": null,
        "url": "https://encontrados.co/person/17" }
    ],
    "warning": "Ya existía una persona con este nombre: …"
  }
}</pre>
<ul>
  <li><code>merged_into_existing_person</code>: el reporte se sumó al historial de alguien ya registrado en vez de crear una persona nueva.</li>
  <li><code>candidates</code>: otros reportes que parecen ser la misma persona.</li>
  <li><code>reason: "face"</code> — coincidencia facial. Trae <code>similarity</code> (% de coincidencia de rostro) y <code>name_score: null</code>. Es la señal fuerte.</li>
  <li><code>reason: "name"</code> — nombre parecido. Trae <code>name_score</code> (0 a 1, similitud difusa de texto) y <code>similarity: null</code>. <strong>Es una señal débil y no es comparable con la facial</strong>: no las mezcles en un mismo umbral — «Juan Carlos Pérez» y «Juan Camilo Pérez» puntúan alto y son dos personas distintas.</li>
  <li><code>warning</code>: la misma información en una frase, o <code>null</code> si no hay nada que advertir.</li>
</ul>
<p class="subtle">Si reportas en lote, usa <code>external_id</code> para que un reenvío del mismo registro actualice el reporte en vez de duplicarlo.</p>

<h2>Consultar</h2>
<pre>curl 'https://encontrados.co/api/people?q=jaun%20peres'
curl https://encontrados.co/api/people/12</pre>

<p class="subtle">Publica solo información que creas cierta — ver <a href="/terminos">términos</a> y <a href="/privacidad">privacidad</a>.</p>`,
        { fullTitle: 'API — encontrados.co', path: '/api-doc' }
      )
    );
  });

  return router;
}

module.exports = { webRoutes };
