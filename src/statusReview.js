// La cola de revisión de estado y su salida humana (#190).
//
// El problema: una ficha en `unknown` no tiene salida. El adaptador del
// registro público manda "Localizada sin vida" a `unknown` a propósito
// (src/sources/colombiatebusca.js) porque adivinar sobre la muerte de alguien
// no se hace solo, y el filtro de palabras clave del flujo de medios es
// bidireccional —matchea tanto "sigue desaparecido" como "fue encontrado"—,
// así que buena parte de lo que entra por ahí también aterriza en `unknown`.
// El efecto es el que reporta el issue: la ficha se queda publicada como
// buscada aunque la confirmación exista, y un rescatista sigue haciendo match
// contra personas que ya aparecieron.
//
// Este módulo es la cola y la salida, NO la rutina que detecta candidatos: eso
// es otro alcance y en parte ya lo hace la ingesta.
//
// Las cuatro decisiones de diseño que lo gobiernan, y que no son negociables
// desde acá:
//
//  1. NO se crea un estado público nuevo. Se propuso "probablemente
//     encontrado" y se descartó: `unknown` ya ES ese estacionamiento, y un
//     estado público es un mensaje a una familia. Si una madre lee
//     "probablemente encontrado" en la ficha de su hijo va a leer esperanza, y
//     si era un homónimo esa crueldad la causamos nosotros.
//  2. El marcador de "probable" es PRIVADO: vive en la tabla `status_review` y
//     no lo lee ninguna superficie pública. `publicUpdate` (src/privacy.js)
//     enumera campo por campo lo que sale de una fila de `updates`, y esta
//     tabla no entra ahí.
//  3. La evidencia enlazable va en `updates.source_url`, que ya existe. La
//     justificación en prosa de quien revisó va en `status_review.
//     evidence_note` y NUNCA se copia a `updates.message`, porque message sí
//     sale al público.
//  4. El criterio de "cuándo alcanza la evidencia" NO se codifica acá. Lo está
//     escribiendo el frente de verificación. Esto registra la evidencia y deja
//     juzgar a la persona; lo único que exige es que la evidencia ESTÉ escrita.
//
// Y el peligro que hay que mirar de frente: resolver una ficha manda un aviso.
// Este botón le escribe a personas que están esperando noticias de un
// desaparecido, a veces para decirles que su familiar murió. Por eso la
// pantalla dice antes de confirmar cuántas son y en qué modo va a salir el
// aviso, no se puede resolver sin haber escrito con qué se resolvió, y no
// existe resolución en lote: una ficha a la vez.

const { esc, layout, timeTag } = require('./html');
const { STATUS_LABEL, notifyMode, notifySubscribers: realNotifySubscribers } = require('./notify');

// Los dos únicos destinos de una resolución. `injured` y `missing` no están:
// esto no es un editor de estado, es la salida de un estacionamiento — la
// pregunta que la cola cierra es "apareció viva o murió".
const REVIEW_STATUSES = ['safe', 'deceased'];

// Lo que queda como `reporter` de la fila que escribe una resolución.
//
// UNA sola palabra a propósito: maskReporter (src/privacy.js) recorta un
// reporter de varias palabras a "primer nombre + inicial", así que
// "Revisión de la ficha" saldría al público como "Revisión D." — un
// enmascarado pensado para nombres de personas, aplicado a una etiqueta
// institucional. Una palabra sola vuelve tal cual.
//
// El correo de quien decidió NO va acá: va en `status_review.author`, que es
// privado. Lo público es que la decisión la tomó el equipo, no quién.
const REVIEW_REPORTER = 'Revisión';

// El ÚNICO valor que cuenta como confirmación, y vive acá —al lado del
// formulario que lo emite— para que la casilla y su validador no se puedan
// desincronizar.
//
// Antes se leía con Boolean(confirmo), y eso aceptaba `confirmo=0` y
// `confirmo=false` como un sí: toda cadena no vacía es truthy en JS. La
// consecuencia no es un ataque —esta ruta ya exige sesión de /admin— sino algo
// peor de explicar: un script, un curl copiado o una integración que mandara
// `confirmo=false` queriendo decir "no" habría resuelto la ficha y avisado a
// la familia. Una casilla que acepta 0 como sí no es una confirmación.
// Hallazgo de coderabbitai en la revisión de este PR.
const CONFIRMATION_VALUE = '1';

// Quién recibe de verdad un aviso, con el MISMO criterio que notifySubscribers
// (src/notify.js): suscripción verificada y canal entregable. Si estos dos
// filtros se separan, la pantalla promete un número y sale otro — y el número
// que la pantalla muestra es la base sobre la que una persona decide.
function notifiableSubscribers(subs) {
  return (subs || []).filter((s) => s.verified && (s.channel === 'email' || s.channel === 'whatsapp'));
}

// La cola: fichas en `unknown`, la más reciente primero.
async function gatherQueue(store, { limit = 200 } = {}) {
  return store.getUnknownPeople(limit);
}

// Todo lo que hace falta para juzgar UNA ficha. Una a la vez: no hay una
// pantalla que resuelva varias, y eso es parte del diseño, no una limitación
// pendiente.
async function gatherFicha(store, personId) {
  const person = await store.getPerson(personId);
  if (!person) return null;
  const [latest, updates, reviews, subs] = await Promise.all([
    store.getLatestUpdate(person.id),
    store.getUpdates(person.id),
    store.statusReviewsForPerson(person.id),
    store.getSubscriptions(person.id)
  ]);
  return {
    person,
    latest,
    updates,
    reviews,
    recipients: notifiableSubscribers(subs).length,
    mode: notifyMode()
  };
}

// Validación compartida por las dos escrituras. Devuelve la lista de errores
// —vacía si todo está bien— para que el handler los muestre de vuelta con lo
// que la persona ya había escrito, en vez de perderlo.
function validateEvidence({ estado, evidencia }) {
  const errors = [];
  if (!REVIEW_STATUSES.includes(estado)) {
    errors.push('Elige si la ficha se cierra como «apareció viva» o «murió».');
  }
  // La regla del issue: no se resuelve sin haber escrito con qué se resolvió.
  // Un espacio en blanco no es evidencia.
  const note = typeof evidencia === 'string' ? evidencia.trim() : '';
  if (!note) {
    errors.push('Escribe con qué evidencia estás resolviendo. Sin eso la cola es un botón sin memoria.');
  }
  return { errors, note };
}

// Deja constancia SIN cambiar nada: el marcador privado de "probable" más lo
// que la persona encontró. No toca el estado público y no manda ningún aviso.
//
// Existe por una razón operativa, no decorativa: permite que quien reúne la
// evidencia y quien decide sean personas distintas, y deja el rastro para que
// la segunda vea que la primera ya miró.
async function recordNote({ store, personId, author, estado, evidencia }) {
  const { errors, note } = validateEvidence({ estado, evidencia });
  if (errors.length) return { ok: false, errors };
  const person = await store.getPerson(personId);
  if (!person) return { ok: false, errors: ['Esa persona no existe.'] };
  const row = await store.insertStatusReview({
    personId: person.id,
    probableStatus: estado,
    evidenceNote: note,
    author,
    resolved: false
  });
  return { ok: true, review: row };
}

// Resuelve la ficha: escribe el estado nuevo y manda los avisos.
//
// Por qué NO pasa por admitReport (src/report-admission.js), que es la
// secuencia compartida de las otras tres puertas: admitReport resuelve la
// persona POR NOMBRE (findOrCreatePerson), y acá la persona ya está
// identificada por id. Con nombres homónimos —que en este dominio son la
// norma— exactByNormalized devuelve una de las filas con ese nombre
// normalizado, sin orden garantizado, así que buscar por nombre podría
// aterrizar la resolución en OTRA ficha y mandarle a otra familia el aviso de
// una muerte. Nada de lo que admitReport agrega hace falta acá: no hay foto
// que indexar, no hay external_id que proteger y no hay detección de
// duplicados que correr. Lo único que se reusa es notifySubscribers, que es
// justamente la parte que se comparte.
async function resolveFicha({
  store,
  personId,
  author,
  estado,
  evidencia,
  enlace,
  confirmo,
  notifySubscribers = realNotifySubscribers,
  normalizeSourceUrl
}) {
  const { errors, note } = validateEvidence({ estado, evidencia });
  // La confirmación explícita de que esto manda un aviso. No es letra chica:
  // es una casilla que hay que marcar, y el servidor la exige igual que la
  // evidencia — un formulario armado a mano no se salta la advertencia.
  if (String(confirmo) !== CONFIRMATION_VALUE) {
    errors.push('Marca la casilla que dice que entiendes que resolver manda un aviso.');
  }
  if (errors.length) return { ok: false, errors };

  const person = await store.getPerson(personId);
  if (!person) return { ok: false, errors: ['Esa persona no existe.'] };

  // ¿Sigue en la cola? Dos personas revisando a la vez, o un doble clic,
  // escribirían dos filas y mandarían dos avisos. Se relee el estado justo
  // antes de escribir y se rechaza si ya no es `unknown`.
  //
  // No es un lock: queda una ventana chica entre esta lectura y la escritura.
  // Cerrarla del todo pide serializar por persona, que hoy solo existe por
  // external_id (withExternalIdLock) y una resolución no tiene llave externa.
  // El daño residual es un aviso repetido, no un estado equivocado.
  const latest = await store.getLatestUpdate(person.id);
  if (!latest || latest.status !== 'unknown') {
    return {
      ok: false,
      errors: [
        `Esta ficha ya no está en la cola: su estado actual es ${
          STATUS_LABEL[latest && latest.status] || 'otro'
        }. Alguien la resolvió mientras la mirabas. Recarga la cola antes de volver a decidir.`
      ]
    };
  }

  const sourceUrl = normalizeSourceUrl ? normalizeSourceUrl(enlace) : null;

  // El número que la pantalla le mostró a quien decidió, leído ANTES de
  // escribir: es lo que aceptó, y es lo que queda registrado.
  const recipients = notifiableSubscribers(await store.getSubscriptions(person.id)).length;
  const mode = notifyMode();

  // 1. El estado nuevo, durable. `message` va vacío a propósito: la
  //    justificación de quien revisó es privada y message sale al público.
  const update = await store.addUpdate(person.id, {
    status: estado,
    message: null,
    location: null,
    source: 'web',
    sourceUrl,
    reporter: REVIEW_REPORTER,
    contact: null
  });

  // 2. La constancia, ANTES de notificar. Si esto falla, el error sube y no
  //    sale ningún aviso: un aviso sin registro de quién lo causó es peor que
  //    una resolución que hay que reintentar.
  const review = await store.insertStatusReview({
    personId: person.id,
    probableStatus: estado,
    evidenceNote: note,
    author,
    resolved: true,
    updateId: update.id,
    recipients,
    notifyMode: mode === 'direct' ? 'direct' : 'relay'
  });

  // 3. Los avisos. Un fallo acá degrada a advertencia y nunca deshace lo de
  //    arriba, igual que en report-admission.
  let notified = 0;
  let notifyError = null;
  try {
    notified = await notifySubscribers(store, person, update);
  } catch (e) {
    notifyError = (e && e.message) || 'error desconocido';
    console.error('[status-review] notificación falló:', notifyError);
  }

  return { ok: true, person, update, review, recipients, mode, notified, notifyError };
}

// ---------------------------------------------------------------------- HTML

const PAGE_ROBOTS = 'noindex, nofollow';

function errorsHtml(errors) {
  if (!errors || !errors.length) return '';
  return `<div class="error"><p>⚠️ No se hizo nada. ${errors.map(esc).join('<br>')}</p></div>`;
}

function evidenceLine(label, value) {
  if (!value) return '';
  return `<p><strong>${esc(label)}:</strong> ${esc(value)}</p>`;
}

function queueRowHtml(row) {
  const enlace = row.source_url
    ? `<p><strong>Enlace de la fuente:</strong> <a href="${esc(row.source_url)}" rel="noreferrer noopener nofollow" target="_blank">${esc(
        row.source_url
      )}</a></p>`
    : '<p><em>Sin enlace de fuente.</em></p>';
  return `
    <article class="card">
      <h3><a href="/admin/revision/${esc(row.id)}">${esc(row.full_name)}</a></h3>
      <p>Último reporte: ${timeTag(row.last_report)} · fuente <code>${esc(row.source || '?')}</code></p>
      ${evidenceLine('Nota del reporte', row.message)}
      ${evidenceLine('Ubicación', row.location)}
      ${enlace}
      <p><a href="/admin/revision/${esc(row.id)}">Revisar esta ficha →</a></p>
    </article>`;
}

function buildQueuePageHtml(rows) {
  const body = `
    <h1>Cola de revisión de estado</h1>
    <p>Fichas cuyo último estado es <strong>SIN CONFIRMAR</strong>. Mientras estén acá siguen
    publicadas como buscadas, y un rescatista sigue comparando su cara contra la de alguien que
    quizá ya apareció.</p>
    <p>Se revisa <strong>una a la vez</strong>: no hay resolución en lote, y no la va a haber.
    Cada resolución le manda un aviso a quien sigue a esa persona.</p>
    <p>La cola no dice cuándo la evidencia alcanza. Ese criterio lo está escribiendo el frente de
    verificación, y la decisión es de quien revisa.</p>
    <p><a href="/admin">← Volver al panel</a></p>
    ${
      rows.length
        ? `<p><strong>${rows.length}</strong> ficha(s) esperando.</p><div class="cards">${rows.map(queueRowHtml).join('')}</div>`
        : '<p>✅ No hay fichas esperando revisión.</p>'
    }
  `;
  return layout('Cola de revisión de estado', body, { path: '/admin/revision', robots: PAGE_ROBOTS });
}

// La advertencia de aviso. Es lo más importante de esta pantalla, así que va
// arriba del formulario y con el número adentro — nunca en letra chica, y
// nunca en genérico: dice cuántas personas y qué les va a pasar en el modo que
// está activo AHORA.
function noticeWarningHtml({ person, recipients, mode }) {
  const quienes =
    recipients === 0
      ? `Hoy <strong>nadie</strong> sigue a ${esc(
          person.full_name
        )} con una suscripción verificada, así que no sale ningún aviso. Puede cambiar si alguien se suscribe antes de que resuelvas.`
      : `Hay <strong>${recipients}</strong> suscripción(es) verificada(s) siguiendo a ${esc(
          person.full_name
        )}.`;

  const queLesPasa =
    recipients === 0
      ? ''
      : mode === 'direct'
        ? `<p>El modo de avisos es <strong>directo</strong>: el aviso <strong>les llega a esas ${recipients} personas</strong>, por correo o WhatsApp, con el estado nuevo escrito tal cual.</p>`
        : `<p>El modo de avisos es <strong>relevo</strong>: ninguno de esos ${recipients} avisos sale a un tercero. Caen en el buzón de operación marcados <code>[RETENIDO]</code>, y una persona decide después qué hacer con cada uno.</p>`;

  return `
    <div class="error">
      <h2>⚠️ Resolver esta ficha manda un aviso</h2>
      <p>${quienes}</p>
      ${queLesPasa}
      <p>Si el estado que vas a dejar es <strong>FALLECIDO(A)</strong>, el aviso dice exactamente eso.
      Del otro lado hay alguien esperando noticias de un desaparecido.</p>
      <p>Queda registrado quién resolvió, cuándo, con qué evidencia y a cuántos se les avisó.</p>
    </div>`;
}

function reviewHistoryHtml(reviews) {
  if (!reviews.length) return '<p><em>Nadie ha dejado constancia sobre esta ficha todavía.</em></p>';
  return `<div class="cards">${reviews
    .map(
      (r) => `
      <article class="card">
        <p><strong>${r.resolved ? 'Resolvió' : 'Dejó constancia'}:</strong> ${esc(r.author)} · ${timeTag(
          r.created_at
        )}</p>
        <p><strong>Lo vio como:</strong> ${esc(STATUS_LABEL[r.probable_status] || r.probable_status)}</p>
        <p><strong>Evidencia:</strong> ${esc(r.evidence_note)}</p>
        ${
          r.resolved
            ? `<p>Avisos: ${r.recipients == null ? '?' : esc(r.recipients)} destinatario(s), modo ${esc(
                r.notify_mode || '?'
              )}.</p>`
            : '<p>No cambió el estado y no mandó ningún aviso.</p>'
        }
      </article>`
    )
    .join('')}</div>`;
}

// `formName` dice de CUÁL de los dos formularios vino un envío fallido, y sin
// ese dato el re-render hace daño en vez de ayudar: los dos comparten los
// nombres de campo (`estado`, `evidencia`), así que el texto escrito para una
// constancia sin efecto reaparecía precargado dentro del formulario de
// RESOLVER —el que manda avisos— mientras el de constancia volvía vacío.
// Rellenar el formulario peligroso con palabras que nadie escribió para él es
// exactamente lo que este re-render existía para evitar. Hallazgo de
// coderabbitai en la revisión de este PR.
function buildFichaPageHtml(ficha, { errors = [], form = {}, formName = '' } = {}) {
  const { person, latest, reviews, recipients, mode } = ficha;
  const enlaceActual = latest && latest.source_url;
  const enviado = (nombre) => (formName === nombre ? form : {});
  const formNota = enviado('nota');

  const body = `
    <h1>Revisar: ${esc(person.full_name)}</h1>
    <p><a href="/admin/revision">← Volver a la cola</a> · <a href="/person/${esc(
      person.id
    )}">Ver la ficha pública</a></p>
    ${errorsHtml(errors)}

    <h2>La evidencia que ya está en la ficha</h2>
    <p><strong>Estado actual:</strong> ${esc(STATUS_LABEL[latest && latest.status] || 'sin reportes')}
    ${latest ? `· ${timeTag(latest.created_at)}` : ''}</p>
    ${latest ? evidenceLine('Nota del reporte', latest.message) : ''}
    ${latest ? evidenceLine('Ubicación', latest.location) : ''}
    ${
      enlaceActual
        ? `<p><strong>Enlace de la fuente:</strong> <a href="${esc(
            enlaceActual
          )}" rel="noreferrer noopener nofollow" target="_blank">${esc(enlaceActual)}</a></p>`
        : '<p><em>La ficha no trae enlace de fuente. Si conseguiste uno, pégalo abajo.</em></p>'
    }

    <h2>Lo que ya dejó escrito el equipo</h2>
    ${reviewHistoryHtml(reviews)}

    <h2>Dejar constancia sin resolver</h2>
    <p>Para cuando encontraste algo pero no alcanza para cerrar la ficha, o quieres que otra persona
    lo mire antes. <strong>No cambia el estado público y no manda ningún aviso.</strong></p>
    <form method="post" action="/admin/revision/${esc(person.id)}/nota">
      <label>Lo veo como
        <select name="estado" required>
          <option value="">Elige una</option>
          <option value="safe"${formNota.estado === 'safe' ? ' selected' : ''}>Apareció viva</option>
          <option value="deceased"${formNota.estado === 'deceased' ? ' selected' : ''}>Murió</option>
        </select>
      </label>
      <label>Qué encontré
        <textarea name="evidencia" rows="3" required placeholder="Qué fuente, qué dice, y qué te falta para estar seguro.">${esc(
          formNota.evidencia || ''
        )}</textarea>
      </label>
      <button type="submit">Guardar constancia</button>
    </form>

    <h2>Resolver la ficha</h2>
    ${resolveFormHtml({ person, latest, recipients, mode, form: enviado('resolver') })}
  `;
  return layout(`Revisar ${person.full_name}`, body, {
    path: `/admin/revision/${person.id}`,
    robots: PAGE_ROBOTS
  });
}

// El formulario de resolución solo existe si la ficha SIGUE en la cola.
//
// La pantalla es alcanzable por id para cualquier persona, no solo para las
// que están en `unknown`. Pintar el formulario igual y rechazar el envío
// después sería ofrecer un botón que nunca funciona; peor, sobre una ficha que
// alguien más ya cerró, invita a mandar un segundo aviso a la misma familia.
function resolveFormHtml({ person, latest, recipients, mode, form }) {
  if (!latest || latest.status !== 'unknown') {
    return `<div class="notice"><p>Esta ficha no está en la cola: su estado actual es
      <strong>${esc(STATUS_LABEL[latest && latest.status] || 'sin reportes')}</strong>, no SIN CONFIRMAR.
      La cola solo resuelve lo que sigue sin confirmar. Si hay que corregir este estado, es otro
      camino y otra conversación.</p></div>`;
  }
  const estado = REVIEW_STATUSES.includes(form.estado) ? form.estado : '';
  return `
    ${noticeWarningHtml({ person, recipients, mode })}
    <form method="post" action="/admin/revision/${esc(person.id)}/resolver">
      <label>Cerrar como
        <select name="estado" required>
          <option value="">Elige una</option>
          <option value="safe"${estado === 'safe' ? ' selected' : ''}>Apareció viva (A SALVO)</option>
          <option value="deceased"${estado === 'deceased' ? ' selected' : ''}>Murió (FALLECIDO(A))</option>
        </select>
      </label>
      <label>Con qué evidencia
        <textarea name="evidencia" rows="4" required placeholder="Qué fuente lo confirma, qué dice, y cómo descartaste que sea un homónimo.">${esc(
          form.evidencia || ''
        )}</textarea>
      </label>
      <label>Enlace público que lo respalda (opcional)
        <input type="url" name="enlace" placeholder="https://…" value="${esc(form.enlace || '')}">
      </label>
      <label><input type="checkbox" name="confirmo" value="${CONFIRMATION_VALUE}" required> Entiendo que al resolver
        ${
          recipients === 0
            ? 'no sale ningún aviso hoy, porque nadie sigue a esta persona'
            : mode === 'direct'
              ? `se le avisa a ${recipients} persona(s) que sigue(n) a esta ficha`
              : `se relevan ${recipients} aviso(s) al buzón de operación`
        }, y que la decisión queda registrada a mi nombre.</label>
      <button type="submit">Resolver esta ficha</button>
    </form>`;
}

function buildResolvedPageHtml(result) {
  const { person, update, review, recipients, mode, notified, notifyError } = result;
  const avisos =
    recipients === 0
      ? '<p>No salió ningún aviso: nadie seguía a esta persona.</p>'
      : mode === 'direct'
        ? `<p>Avisos entregados: <strong>${esc(notified)}</strong> de ${esc(recipients)}.</p>`
        : `<p>Se relevaron <strong>${esc(notified)}</strong> de ${esc(
            recipients
          )} aviso(s) al buzón de operación. Nada salió a un tercero.</p>`;
  const body = `
    <h1>Ficha resuelta</h1>
    <p><strong>${esc(person.full_name)}</strong> queda como
    <strong>${esc(STATUS_LABEL[update.status] || update.status)}</strong>.</p>
    ${avisos}
    ${notifyError ? `<p class="error">⚠️ El envío de avisos falló: ${esc(notifyError)}. El estado sí quedó guardado.</p>` : ''}
    <p>Constancia #${esc(review.id)} a nombre de ${esc(review.author)}.</p>
    <p><a href="/admin/revision">← Volver a la cola</a> · <a href="/person/${esc(
      person.id
    )}">Ver la ficha pública</a></p>
  `;
  return layout('Ficha resuelta', body, { path: '/admin/revision', robots: PAGE_ROBOTS });
}

module.exports = {
  REVIEW_STATUSES,
  REVIEW_REPORTER,
  CONFIRMATION_VALUE,
  notifiableSubscribers,
  gatherQueue,
  gatherFicha,
  validateEvidence,
  recordNote,
  resolveFicha,
  buildQueuePageHtml,
  buildFichaPageHtml,
  buildResolvedPageHtml
};
