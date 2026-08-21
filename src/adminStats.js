// El panel de estadísticas (#116, PR 6 + hotfixes + rediseño a dashboard).
//
// SOLO cifras agregadas — la misma clase de dato que ya es público hoy en
// GET /api/diag. Ni un nombre, ni un contacto, ni un person_id/face_id/
// update_id, visible o en el HTML: si un dato no cabría en el correo del
// reporte (src/report.js), no cabe acá. El drill-down por ID que resuelve
// nombres y contactos en vivo NO EXISTE en este PR — cuando exista, nace
// detrás de requireAdminSession en /api/admin/*, nunca en esta superficie.
//
// DISEÑO (rediseño post-#129, pedido explícito del operador: "un dashboard
// visual. gráficas. hoy puedes lanzar data, en cards y números... igual las
// explicaciones"):
//   - Cards arriba: el estado del sistema en 3 segundos, sin leer una tabla.
//   - Gráficas como ciudadano de primera, justo debajo — la serie de 7 días
//     es lo que el correo no puede contar.
//   - Las tablas y el texto "qué significa" NO se borran — bajan a bloques
//     <details> nativos (cero JS para abrirlos), siempre accesibles.
//   - Identidad visual: la MISMA de encontrados.co (public/styles.css) — el
//     panel es una sección más del sitio, no un producto aparte. La única
//     firma nueva es la barra de 3px en cada card, la misma idea que ya usa
//     el .tricolor de la cabecera: una franja de color que informa estado.
//
// El embudo (dependiente de computeMatchStats, el recompute contra
// Rekognition — medía 28,7s en prod) sigue diferido a su propio endpoint,
// GET /admin/stats/funnel (#127/#128): la página entera renderiza de
// inmediato con lo barato, y esa llamada aparte rellena DOS huecos —
// la card de "salud de la medición" arriba, y el bloque de detalle del
// embudo más abajo — desde un solo fetch.
const { layout, esc } = require('./html');
const {
  table,
  section,
  pivotContact,
  sumContact,
  SURFACE_LABEL,
  CHANNEL_LABEL,
  SOURCE_LABEL,
  SIMILARITY_TIERS,
  n,
  bogotaClock,
  instrumentedSinceNote,
  suppressedCell,
  suppressBreakdown,
  SUPPRESSION_NOTE
} = require('./report');
const { dailyMatchesChart, dailyContactChart, contactByChannelChart, funnelChart, reunionFunnelChart } = require('./charts');

const ISSUE_URL = 'https://github.com/encontradosco/encontrados/issues/116';
const DEDUP_ISSUE_URL = 'https://github.com/encontradosco/encontrados/issues/132';

// Punto 1 del issue #132, desglosado por canal de entrada — orden estable
// para que la tabla siempre salga en el mismo orden.
const SOURCE_ORDER = ['web', 'whatsapp', 'api', 'aggregator', 'rescate'];

function publicBanner() {
  return `<div class="stats-banner">⚠️ <strong>Vista temporal sin autenticación.</strong> El acceso de administración
(<a href="${esc(ISSUE_URL)}">#116</a>) se está terminando de configurar — mientras tanto, esta página
queda abierta con las mismas cifras agregadas que ya son públicas en <code>/api/diag</code>. Se cierra
detrás de una sesión en cuanto el acceso esté listo.</div>`;
}

function statCard({ label, value, detail, variant, id, loading }) {
  const cls = ['stat-card', variant ? `stat-card--${variant}` : '', loading ? 'stat-card--loading' : '']
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}"${id ? ` id="${esc(id)}"` : ''}>
  <p class="stat-card__label">${esc(label)}</p>
  <p class="stat-card__value">${value}</p>
  ${detail ? `<p class="stat-card__detail">${detail}</p>` : ''}
</div>`;
}

function dot(color) {
  return `<span class="stat-card__dot" style="background:${color}"></span>`;
}

// Tabla + explicación de siempre, ahora detrás de un <details> nativo — el
// número exacto y el "qué significa" siguen ahí, a un tap/clic, nunca
// borrados (pedido explícito del operador, dos veces).
function detailsBlock(summaryText, innerHtml, { open = false } = {}) {
  return `<details class="stats-detail"${open ? ' open' : ''}>
  <summary>${esc(summaryText)}</summary>
  <div class="stats-detail__body">${innerHtml}</div>
</details>`;
}

// Supresión de celdas pequeñas (#132): la MISMA lógica pura que ya corre
// dentro de dailyContactChart (charts.js) sobre el mismo `d.contact` —
// suppressBreakdown es determinística, así que llamarla otra vez acá con las
// mismas partes en el mismo orden da exactamente el mismo resultado. No hace
// falta pasarse el cálculo de un archivo a otro para que tabla y gráfica
// coincidan.
function contactCells(contact) {
  const parts = ['enviado', 'fallido', 'rechazado'].map((k) => ({ key: k, value: contact[k] || 0 }));
  const { cells } = suppressBreakdown(parts, parts.reduce((s, p) => s + p.value, 0));
  return Object.fromEntries(cells.map((c) => [c.key, c]));
}

function dailyTable(daily) {
  return table(
    ['Día', 'Coincidencias', 'Enviados', 'Fallidos', 'Rechazados'],
    daily.map((d) => {
      const matches = suppressedCell(d.matches);
      const c = contactCells(d.contact);
      return [
        esc(d.day),
        d.matchesAvailable ? matches.display : '—',
        d.contactAvailable ? c.enviado.display : '—',
        d.contactAvailable ? c.fallido.display : '—',
        d.contactAvailable ? c.rechazado.display : '—'
      ];
    })
  );
}

// El fragmento caro, en DOS piezas con id propio — el script del lado del
// cliente las separa e inyecta cada una en su lugar (la card de salud
// arriba del todo, el detalle del embudo más abajo) desde una sola llamada.
// `stats` puede venir null (reconocimiento facial apagado): nunca una card
// que muestre un cero que parezca un dato real — declara explícitamente que
// no se pudo medir.
function buildFunnelFragmentHtml(stats, matcherStatus) {
  let cardHtml;
  let detailsHtml;

  if (!stats) {
    cardHtml = statCard({
      id: 'salud-card-slot',
      label: 'Salud de la medición',
      value: '—',
      detail: `Reconocimiento facial no disponible (${esc(matcherStatus || 'desconocido')}).`,
      variant: 'warn'
    });
    detailsHtml = `<div id="funnel-details-fragment"><p style="padding:10px 12px;background:#fdf6e3;border:1px solid #f0dca0;border-radius:10px;">
⚠️ El reconocimiento facial no está disponible en esta corrida (${esc(matcherStatus || 'desconocido')}). Las coincidencias no se pudieron recalcular —
esto <strong>no significa que sean cero</strong>, significa que no se pudieron medir. La base general de abajo sigue siendo real.</p></div>`;
    return `${cardHtml}\n${detailsHtml}`;
  }

  const notFoundYet = Math.max(stats.reported_people_indexed - stats.reported_people_matched, 0);
  const healthy = stats.failed === 0 && stats.dangling_face_matches === 0;
  // El número grande es stats.failed: FOTOS subidas por quien busca (no
  // personas, no las buscadas) cuya comparación falló esta corrida — la
  // etiqueta lo dice en la propia card, no solo en el detalle de abajo, para
  // que no se lea como si contara personas buscadas (el mismo error que
  // tenía "Comparaciones que fallaron" en el resto del panel y el correo).
  cardHtml = statCard({
    id: 'salud-card-slot',
    label: 'Fotos sin comparar (de quien busca)',
    value: n(stats.failed),
    detail: `${n(stats.dangling_face_matches)} golpe(s) contra firma(s) huérfana(s) en el índice`,
    variant: healthy ? undefined : stats.failed > 0 ? 'bad' : 'warn'
  });

  const funnelBody =
    section('El embudo (acumulado)') +
    funnelChart(stats) +
    detailsBlock(
      'Ver la tabla y qué significa cada número',
      table(
        ['Paso', 'Cuántas', 'Qué significa'],
        [
          [
            'Personas buscadas con foto utilizable',
            n(stats.reported_people_indexed),
            'Tienen una foto donde se detectó bien la cara — solo estas pueden coincidir.'
          ],
          [
            '→ De esas, con al menos una coincidencia',
            n(stats.reported_people_matched),
            `Las otras ${n(notFoundYet)} no han aparecido en ninguna foto — todavía.`
          ],
          ['→ Coincidencias en total', n(stats.report_matches_total), 'Una misma persona puede aparecer en varias fotos.']
        ]
      ) +
        table(
          ['Señal de confiabilidad', 'Cuántos', 'Qué significa'],
          [
            [
              'Fotos que no se pudieron comparar',
              n(stats.failed),
              'Son fotos subidas por <strong>quien busca</strong> a alguien —un rescatista, o quien se suscribe con una foto— no de las personas buscadas. Falló la consulta al reconocimiento facial para esa foto puntual; si tenía alguna coincidencia, no quedó contada. Por eso los números de arriba son el <strong>mínimo real</strong> — pueden ser más.'
            ],
            [
              'Coincidencias contra firmas huérfanas',
              n(stats.dangling_face_matches),
              'Golpes contra la firma facial de una persona ya borrada de la base, que sigue en el índice (#71). Si una misma firma huérfana golpea más de una vez, cuenta cada vez — puede haber menos firmas distintas por limpiar que este número.'
            ]
          ]
        )
    );
  detailsHtml = `<div id="funnel-details-fragment" class="stats-section">${funnelBody}</div>`;

  return `${cardHtml}\n${detailsHtml}`;
}

// Vanilla, sin dependencias: pide el fragmento apenas carga la página y lo
// reparte en sus dos destinos (la card de salud, el detalle del embudo).
// Mientras espera, ambos dicen con claridad que están calculando; si falla o
// expira, lo dicen también — nunca un cero que parezca un dato real.
const FUNNEL_SCRIPT = `<script>
(function () {
  var cardSlot = document.getElementById('salud-card-slot');
  var detailsSlot = document.getElementById('funnel-details-slot');
  fetch('/admin/stats/funnel')
    .then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      return res.text();
    })
    .then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var card = tmp.querySelector('#salud-card-slot');
      var details = tmp.querySelector('#funnel-details-fragment');
      if (card && cardSlot) cardSlot.replaceWith(card);
      if (details && detailsSlot) detailsSlot.replaceWith(details);
    })
    .catch(function () {
      var msg = '<p style="padding:10px 12px;background:#fdecea;border:1px solid #f0b8ae;border-radius:10px;">' +
        '⚠️ No se pudo calcular el embudo de coincidencias en este momento (recompute contra Rekognition — puede tardar). ' +
        'Intenta recargar en un minuto.</p>';
      if (cardSlot) cardSlot.outerHTML = '<div class="stat-card stat-card--bad"><p class="stat-card__label">Salud de la medición</p>' +
        '<p class="stat-card__value">—</p><p class="stat-card__detail">No se pudo calcular. Intenta recargar.</p></div>';
      if (detailsSlot) detailsSlot.innerHTML = msg;
    });
})();
</script>`;

// `data` es gatherCheapReportData(store, matcher) — SIN stats: el embudo se
// pide aparte (ver FUNNEL_SCRIPT). `daily` es gatherDailySeries().
function buildStatsPageHtml({ generatedAt, counts, activity, matcherStatus, extras }, daily, { isPublic }) {
  const { day, month, hm } = bogotaClock(generatedAt);

  const banner = isPublic ? publicBanner() : '';

  const matchPivot = activity.match || { total: 0, rescate: 0, report: 0, api: 0 };
  const contactPivot = pivotContact(activity.contact);
  const contactTotals = sumContact(contactPivot);

  // Supresión de celdas pequeñas (#132) — ver report.js, suppressBreakdown.
  // Se calcula UNA vez acá y se reutiliza en la card y en la tabla de
  // detalle de abajo, para que la misma cifra nunca salga distinta en dos
  // sitios de la misma página.
  const matchSuppression = suppressBreakdown(
    ['rescate', 'report', 'api'].map((s) => ({ key: s, value: matchPivot[s] || 0 })),
    matchPivot.total || 0
  );
  const matchByKey = Object.fromEntries(matchSuppression.cells.map((c) => [c.key, c]));

  const contactResultSuppression = suppressBreakdown(
    [
      { key: 'enviado', value: pivotSum(contactPivot, 'enviado') },
      { key: 'fallido', value: pivotSum(contactPivot, 'fallido') },
      { key: 'rechazado', value: pivotSum(contactPivot, 'rechazado') }
    ],
    contactTotals.total
  );
  const contactByKey = Object.fromEntries(contactResultSuppression.cells.map((c) => [c.key, c]));

  const peopleCell = suppressedCell(counts.people);
  const updatesCell = suppressedCell(counts.updates);
  const photosIndexedCell = suppressedCell(counts.photos_indexed);
  const photosCell = suppressedCell(counts.photos);
  const subscriptionsCell = suppressedCell(counts.subscriptions);
  const subscriptionsVerifiedCell = suppressedCell(counts.subscriptions_verified);

  // Las 3 cards que SÍ pueden ir de inmediato (datos baratos, de la base) +
  // el 4to slot, que arranca en "calculando" y lo llena FUNNEL_SCRIPT.
  const heroCards =
    `<div class="stats-hero">` +
    statCard({
      label: 'Coincidencias registradas',
      value: matchSuppression.total.display,
      detail: `Rescate ${matchByKey.rescate.display} · Reporte ${matchByKey.report.display} · API ${matchByKey.api.display}`
    }) +
    statCard({
      label: 'Envíos intentados',
      value: contactResultSuppression.total.display,
      detail: `${dot('#4a7c59')}${contactByKey.enviado.display} enviados &nbsp; ${dot('#c0392b')}${contactByKey.fallido.display} fallidos &nbsp; ${dot('#c8863c')}${contactByKey.rechazado.display} rechazados`,
      variant: pivotSum(contactPivot, 'fallido') > 0 ? 'bad' : pivotSum(contactPivot, 'rechazado') > 0 ? 'warn' : undefined
    }) +
    statCard({
      label: 'Personas en la base',
      value: peopleCell.display,
      detail: `${updatesCell.display} actualizaciones · ${photosIndexedCell.display} de ${photosCell.display} fotos indexadas`
    }) +
    statCard({ id: 'salud-card-slot', label: 'Salud de la medición', value: '…', detail: 'Calculando contra Rekognition…', loading: true }) +
    `</div>`;

  const bitacoraDetails = detailsBlock(
    'Ver el desglose completo y qué significa cada número',
    instrumentedSinceNote(activity.instrumentedSince) +
      table(
        ['Superficie', 'Coincidencias registradas'],
        [
          ...['rescate', 'report', 'api'].map((s) => [SURFACE_LABEL[s], matchByKey[s].display]),
          ['<strong>Total</strong>', `<strong>${matchSuppression.total.display}</strong>`]
        ]
      ) +
      table(
        ['Canal', 'Enviados', 'Fallidos', 'Rechazados'],
        ['email', 'whatsapp', 'relevo'].map((ch) => {
          const c = contactCells(contactPivot[ch]);
          return [CHANNEL_LABEL[ch], c.enviado.display, c.fallido.display, c.rechazado.display];
        })
      ) +
      `<p class="stats-note">"${esc(CHANNEL_LABEL.relevo)}" es todo lo que fue al buzón del <strong>equipo</strong>, nunca a una familia ni a un rescatista: coincidencias pendientes de revisión (modo relevo), solicitudes de publicar en Colombia Te Busca, y avisos de rescatista.</p>`
  );

  const since = activity.since;
  let deltaNote = '';
  if (since) {
    const sinceMatch = since.match || { total: 0 };
    const sinceContact = sumContact(pivotContact(since.contact));
    const at = bogotaClock(since.at);
    deltaNote = `<p class="stats-note"><strong>Desde el horario programado anterior</strong> (aprox. ${esc(at.day)} ${esc(at.month)}, ${esc(at.hm)} Bogotá): ${n(sinceMatch.total)} coincidencia(s) nueva(s), ${n(sinceContact.total)} envío(s) intentado(s) (${n(sinceContact.enviados)} entregado(s)).</p>`;
  }

  const dailySection = `<div class="stats-section">
    ${section('Últimos 7 días')}
    <div class="stats-chart-card">${dailyMatchesChart(daily)}</div>
    <div class="stats-chart-card">${dailyContactChart(daily)}</div>
    ${detailsBlock('Ver la tabla exacta, día por día', dailyTable(daily))}
  </div>`;

  // Los contactos que el equipo hizo POR FUERA de la app viven en su propia
  // sección, con su propio título y SIN gráfica — deliberadamente. Meterlos en
  // la gráfica de arriba, aunque fuera como una barra más, rompería lo único
  // que esa gráfica sirve para responder: si el relevo está reteniendo y si la
  // app entregó. Quien mañana investigue por qué hay 88 retenidos no puede
  // encontrarse al lado un "correo: 24" que la app nunca mandó.
  const outreachPivot = pivotContact(activity.outreach);
  const outreachTotals = sumContact(outreachPivot);
  // Misma supresión de celdas pequeñas (#132) que el resto del panel: estas
  // cifras describen a personas concretas igual que las de arriba, y un total
  // exacto al lado de un "<5" permite deducir la celda oculta por resta.
  const outreachSummary = suppressBreakdown(
    [
      { key: 'enviado', value: pivotSum(outreachPivot, 'enviado') },
      { key: 'fallido', value: pivotSum(outreachPivot, 'fallido') }
    ],
    outreachTotals.total
  );
  const outreachByKey = Object.fromEntries(outreachSummary.cells.map((c) => [c.key, c]));
  const outreachSection = `<div class="stats-section">
    ${section('Contactos que hizo el equipo por fuera de la app')}
    <p class="stats-note">Correos y mensajes que una persona del equipo mandó desde su propio buzón o su propio teléfono, y que registró después por <code>POST /api/contact-log</code> con la fecha real del contacto. <strong>No entran en la gráfica de arriba ni en ninguna de las series de la app</strong>: aquélla mide lo que hizo el software, ésta mide lo que hizo una persona. Un cero acá significa "no se ha registrado ninguno", no "no se contactó a nadie" — la app no puede enterarse sola de un correo que salió de otro buzón.</p>
    ${table(
      ['Canal', 'Entregados', 'Fallidos'],
      ['email', 'whatsapp'].map((ch) => {
        const c = contactCells(outreachPivot[ch]);
        return [CHANNEL_LABEL[ch], c.enviado.display, c.fallido.display];
      })
    )}
    <p class="stats-note">Total registrado: ${outreachSummary.total.display} (${outreachByKey.enviado.display} entregados). El detalle por persona —a quién se avisó y cuándo— se ve en la ficha de cada persona, y solo con sesión de administración.</p>
  </div>`;

  const channelSection = `<div class="stats-section">
    ${section('Envíos por canal (acumulado) — solo lo que mandó la app')}
    <div class="stats-chart-card">${contactByChannelChart(contactPivot, CHANNEL_LABEL)}</div>
    ${bitacoraDetails}
  </div>`;

  // Placeholder del embudo: arranca con "calculando" + <noscript>, y
  // FUNNEL_SCRIPT lo reemplaza entero por #funnel-details-fragment.
  const funnelPlaceholder = `<div id="funnel-details-slot" class="stats-section">
    ${section('El embudo (acumulado)')}
    <p style="padding:10px 12px;background:#f4f1ea;border:1px solid #e8e4da;border-radius:10px;">⏳ Calculando el embudo de coincidencias contra Rekognition — puede tardar unos segundos…</p>
    <noscript><p>⚠️ Esta sección necesita JavaScript para cargar (pide el embudo aparte, para que el resto de la página no espere por Rekognition). Sin JS, no se muestra.</p></noscript>
  </div>`;

  const baseSection = `<div class="stats-section">
    ${section('La base en general')}
    ${detailsBlock(
      'Ver personas, actualizaciones, suscripciones y fotos',
      table(
        ['Qué', 'Total', 'Qué significa'],
        [
          [
            'Personas registradas',
            peopleCell.display,
            'Personas únicas en la base. Es menor que las fichas de las fuentes porque una misma persona puede tener varias fichas — al entrar se fusionan (ver el desglose completo más arriba, en «Personas reportadas y duplicados»).'
          ],
          [
            'Actualizaciones',
            updatesCell.display,
            'Cada ficha de una fuente externa y cada reporte directo en la web entra como una actualización de una persona.'
          ],
          [
            'Suscripciones (verificadas)',
            `${subscriptionsCell.display} (${subscriptionsVerifiedCell.display})`,
            'Familiares que pidieron aviso si su persona aparece. Solo las verificadas reciben correo.'
          ],
          [
            'Fotos (en el índice facial)',
            `${photosCell.display} (${photosIndexedCell.display})`,
            'Fotos en la base; las del índice son las que ya pueden producir coincidencias.'
          ]
        ]
      ),
      { open: false }
    )}
  </div>`;

  // Punto 1 del issue #132 — "las dos caras": fichas recibidas y personas
  // resultantes, JUNTAS y arriba de la página (no solo en el detalle de "La
  // base en general", que sigue existiendo con el mismo par de números). El
  // desglose de abajo NO es "fichas − personas": cuenta filas de `updates`
  // que no fueron la primera de su persona, un universo relacionado pero
  // distinto — ver la nota en report.js (gatherDuplicateBreakdown).
  // suppressBreakdown, NO suppressedCell suelta por fuente — el total de
  // abajo es exacto (extras.duplicates.total), así que una sola fuente chica
  // sería deducible por resta de las demás si cada celda se suprimiera por
  // su cuenta. Bug real, encontrado renderizando el panel contra
  // `npm run seed` antes de abrir este PR (ver el cuerpo del PR).
  const dedupBreakdown = suppressBreakdown(
    SOURCE_ORDER.map((src) => ({ key: src, value: extras.duplicates.bySource[src] || 0 })),
    extras.duplicates.total
  );
  const dedupByKey = Object.fromEntries(dedupBreakdown.cells.map((c) => [c.key, c]));
  const dedupSourceRows = SOURCE_ORDER.map((src) => [SOURCE_LABEL[src], dedupByKey[src].display]);
  const dedupSection = `<div class="stats-section">
    ${section('Personas reportadas, y qué pasó con los duplicados')}
    <p class="stats-note">Entraron <strong>${updatesCell.display}</strong> ficha(s) (actualizaciones) y resultaron <strong>${peopleCell.display}</strong> persona(s) únicas en el registro — la diferencia es el trabajo de deduplicación: una misma persona apareció en más de una ficha, y esas fichas se fusionaron en un solo registro al entrar.</p>
    ${detailsBlock(
      'Ver las fichas que se sumaron a un registro ya existente, por canal de entrada',
      `<p class="stats-note">De esas fichas, <strong>${dedupBreakdown.total.display}</strong> no fueron la primera actualización de su persona — se sumaron a un registro que ya existía. Incluye tanto los duplicados de fuentes externas (agregador) como los que se generan del lado nuestro (web, WhatsApp, API, avisos de rescate):</p>` +
        table(['Canal de entrada', 'Fichas sumadas a un registro existente'], dedupSourceRows) +
        `<p class="stats-note">Esta cuenta no distingue una ficha duplicada por error (la misma persona reportada dos veces) de un seguimiento legítimo (un cambio de estado de la misma persona, reportado después) — el esquema de hoy no guarda esa diferencia entre las dos.</p>`
    )}
  </div>`;

  // Punto 2 del issue #132.
  const rescuedCell = suppressedCell(extras.rescuedPeople);
  const rescuedPeopleSection = `<div class="stats-section">
    ${section('Personas buscadas por rescatistas')}
    <p class="stats-note">Personas fotografiadas por un rescatista en campo, con firma facial guardada: <strong>${rescuedCell.display}</strong>.</p>
    ${detailsBlock(
      'Qué significa exactamente esta cifra',
      `<p class="stats-note">Es el otro lado del cruce, hoy opacado por el volumen del registro de personas desaparecidas. Dos honestidades: no incluye las consultas en modo «no guarden nada» (esa opción no deja ningún rastro que contar — ver «Lo que todavía no podemos medir» más abajo), y no deduplica entre rescates — si dos rescatistas fotografiaron a la misma persona, o el mismo rescatista repitió la consulta, cada intento guardado cuenta por separado.</p>`
    )}
  </div>`;

  // Puntos 3-4 del issue #132: tramos de confianza, cada uno desglosado por
  // superficie. El tramo 100% se señala aparte como lo que es — una alarma
  // de calidad, no un logro (misma firma facial, casi siempre la misma foto
  // subida dos veces por el formulario equivocado).
  const tier100 = suppressedCell(extras.similarity.tiers['100'].total);
  const similarityRows = SIMILARITY_TIERS.map((t) => {
    const bucket = extras.similarity.tiers[t.key];
    const totalCell = suppressedCell(bucket.total);
    const bySurfaceSuppression = suppressBreakdown(
      ['rescate', 'report', 'api'].map((s) => ({ key: s, value: bucket.bySurface[s] || 0 })),
      bucket.total
    );
    const byKey = Object.fromEntries(bySurfaceSuppression.cells.map((c) => [c.key, c]));
    return [t.label, byKey.rescate.display, byKey.report.display, byKey.api.display, totalCell.display];
  });
  const similaritySection = `<div class="stats-section">
    ${section('Coincidencias por tramo de confianza')}
    ${instrumentedSinceNote(activity.instrumentedSince)}
    ${
      tier100.value > 0
        ? `<p class="stats-note">⚠️ <strong>${tier100.display}</strong> coincidencia(s) al 100% — misma firma facial, casi siempre la misma foto subida dos veces (alguien usó el formulario equivocado: reportó por el de rescatista siendo familia, o al revés). <strong>No es un encuentro: es un dato para corregir</strong>, no un logro.</p>`
        : ''
    }
    ${table([`Tramo`, SURFACE_LABEL.rescate, SURFACE_LABEL.report, SURFACE_LABEL.api, 'Total'], similarityRows)}
    <p class="stats-note">El umbral del matcher es 90% (<code>FACE_MATCH_THRESHOLD</code>) — el reconocimiento facial nunca devuelve nada por debajo, así que no hay tramos menores.${
      extras.similarity.belowThreshold > 0
        ? ` (${suppressedCell(extras.similarity.belowThreshold).display} coincidencia(s) histórica(s) quedaron fuera de estos tramos — de antes de que el umbral actual estuviera vigente.)`
        : ''
    }</p>
  </div>`;

  // Punto 5 del issue #132: qué pasó después de cada coincidencia.
  //
  // LÍMITE HONESTO (ver también report.js, gatherRescueContactAvailability):
  // ni match_log ni contact_log guardan qué coincidencia concreta originó
  // qué aviso — no hay match_id en contact_log, y contact_log ni siquiera
  // guarda de qué superficie vino la coincidencia que lo disparó. Así que
  // esta sección responde la pregunta del issue en DOS piezas medibles, en
  // vez de fingir un embudo por coincidencia que la base no puede sostener:
  //   (a) de las veces que un rescatista usó la app, cuántas dejaron un
  //       contacto utilizable — la causa exacta y medible de "nadie a quien
  //       avisar" (el rescatista no dejó su contacto);
  //   (b) de TODOS los avisos que sí se intentaron (de cualquier
  //       coincidencia, cualquier superficie), qué resultado tuvieron.
  const rescueContactSuppression = suppressBreakdown(
    [
      { key: 'sinContacto', value: extras.rescueContact.withoutContact },
      { key: 'conContacto', value: extras.rescueContact.withContact }
    ],
    extras.rescueContact.total
  );
  const rescueContactByKey = Object.fromEntries(rescueContactSuppression.cells.map((c) => [c.key, c]));

  // "Entregado directo" = enviado por correo o WhatsApp, sin pasar por el
  // relevo. "Al buzón del equipo" = relevo/enviado — SÍ llegó, pero a un
  // humano del equipo, no a quien buscaba o rescataba; esta base no guarda
  // si ese aviso YA se resolvió (ese estado vive en las etiquetas de Gmail
  // de /encontrados-avisos, un sistema aparte), así que cuenta cuántos
  // avisos llegaron ahí ALGUNA VEZ, no cuántos siguen pendientes hoy.
  const directDelivered = (contactPivot.email.enviado || 0) + (contactPivot.whatsapp.enviado || 0);
  const relayDelivered = contactPivot.relevo.enviado || 0;
  const failedOrRejected = ['email', 'whatsapp', 'relevo'].reduce(
    (s, ch) => s + (contactPivot[ch].fallido || 0) + (contactPivot[ch].rechazado || 0),
    0
  );
  const contactOutcomeSuppression = suppressBreakdown(
    [
      { key: 'fallidoRechazado', value: failedOrRejected },
      { key: 'relevo', value: relayDelivered },
      { key: 'directo', value: directDelivered }
    ],
    contactTotals.total
  );
  const outcomeByKey = Object.fromEntries(contactOutcomeSuppression.cells.map((c) => [c.key, c]));

  // Fallos primero (pedido explícito del issue): fallidos y rechazados antes
  // que entregados, en cada fila del canal.
  const outcomeDetailRows = ['email', 'whatsapp', 'relevo'].map((ch) => {
    const c = contactCells(contactPivot[ch]);
    return [CHANNEL_LABEL[ch], c.fallido.display, c.rechazado.display, c.enviado.display];
  });

  // Qué SABEMOS de cada coincidencia, y qué solo podemos acotar.
  //
  // Esta sección no trae ninguna cifra nueva: reparte las que ya están arriba
  // en esta misma página, con un criterio distinto. La razón de existir es que
  // el panel podía leerse como si "225 coincidencias" fueran 225 sucesos con
  // desenlace, y no lo son — la única coincidencia cuyo desenlace esta base
  // puede PROBAR es la que se mostró en una pantalla (superficie rescate).
  // Todo lo demás se acota, no se sabe, y acá se dice con esas palabras.
  //
  // Las dos particiones son por ejes DISTINTOS y se cruzan entre sí (una
  // coincidencia de rescate puede además ser del tramo 100%). Por eso se
  // presentan como dos lentes sobre el mismo total y NUNCA se suman ni se
  // restan entre ellas: hacerlo fabricaría un número que la base no sostiene,
  // que es exactamente el error que este panel viene evitando desde #132.
  // Mismo `matchPivot` que alimenta la tarjeta de arriba: una sola fuente de
  // verdad para el total y por superficie, agrupado acá en otras dos casillas.
  const screenSuppression = suppressBreakdown(
    [
      { key: 'enPantalla', value: matchPivot.rescate || 0 },
      { key: 'sinPantalla', value: (matchPivot.report || 0) + (matchPivot.api || 0) }
    ],
    matchPivot.total || 0
  );
  const screenByKey = Object.fromEntries(screenSuppression.cells.map((c) => [c.key, c]));

  const knownRows = [
    [
      'Se mostraron en una pantalla',
      screenByKey.enPantalla.display,
      'Superficie <code>/rescate</code>: un rescatista vio a quién tenía enfrente y cómo contactar a su familia. <strong>Es el único desenlace que esta base puede probar.</strong>'
    ],
    [
      'No tuvieron pantalla',
      screenByKey.sinPantalla.display,
      'Superficie reporte o API: no hay un paso intermedio que alguien mire. Dispararon el camino de aviso, y ese aviso ya no se puede atar de vuelta a esta coincidencia.'
    ],
    [
      'Casi con seguridad son la misma foto dos veces',
      tier100.display,
      'Similitud 100 %: la misma firma facial. Alguien usó el formulario equivocado. <strong>No es un encuentro: es un dato para corregir.</strong>'
    ]
  ];

  const unknownRows = [
    [
      'Cuál aviso salió de cuál coincidencia',
      '<code>contact_log</code> no guarda <code>match_id</code> — no hay ninguna columna que ate las dos bitácoras.'
    ],
    [
      'Si el aviso que llegó al buzón del equipo se atendió',
      'Ese estado vive en las etiquetas del correo del equipo, un sistema aparte de esta base.'
    ],
    [
      'Si una coincidencia era verdadera o un falso positivo',
      'Nadie registra un veredicto humano sobre una coincidencia. El porcentaje de similitud es una medida de parecido, no un fallo sobre si es la persona.'
    ],
    [
      'Si hubo reencuentro',
      'La app no puede verlo. Nadie vuelve a la web a contar que encontró a su familiar.'
    ]
  ];

  const matchKnowledgeSection = `<div class="stats-section">
    ${section('Qué sabemos de cada coincidencia — y qué pudo haber pasado')}
    ${instrumentedSinceNote(activity.instrumentedSince)}
    <p class="stats-note">Una coincidencia significa que el reconocimiento facial encontró un parecido por encima de su umbral. <strong>No prueba que sean la misma persona</strong>, y es todo lo que el sistema sabe por sí solo. Lo que pasó después casi nunca queda escrito acá, así que estas cifras separan lo comprobable de lo que solo se puede acotar — y no se suman entre sí: son dos formas distintas de mirar las mismas ${screenSuppression.total.display} coincidencias.</p>
    ${table(['Lo que sí sabemos', 'Cuántas', 'Cómo lo sabemos'], knownRows)}
    ${table(['Lo que no sabemos', 'Por qué'], unknownRows)}
    <p class="stats-note"><strong>Entonces, ¿qué pudo haber pasado con una coincidencia que no podemos trazar?</strong> Una de estas cinco cosas. Con los datos de hoy, las tres últimas son <strong>indistinguibles entre sí</strong>:</p>
    <ol class="stats-note">
      <li><strong>Era un duplicado y no había nada que hacer.</strong> Es lo más probable en el tramo del 100 % (${tier100.display} coincidencias).</li>
      <li><strong>Era real y disparó un aviso que llegó al buzón del equipo</strong>, donde queda a la espera de que una persona lo revise. Si esa revisión ocurrió, y con qué desenlace, no se puede ver desde acá. (En total han llegado ${outcomeByKey.relevo.display} avisos a ese buzón, sumando todas las coincidencias — ese número es contexto global y no se puede repartir entre ellas.)</li>
      <li><strong>Era real pero no había a quién avisar</strong>, porque el rescatista no dejó contacto — le pasó a ${rescueContactByKey.sinContacto.display} de ${rescueContactSuppression.total.display} consultas.</li>
      <li><strong>Era un falso positivo</strong> y el aviso fue ruido.</li>
      <li><strong>Era real, se avisó, y nadie alcanzó a actuar.</strong></li>
    </ol>
    <p class="stats-note">Para poder distinguirlas harían falta dos cosas que hoy no existen: una columna que ate el aviso a la coincidencia que lo originó, y un veredicto humano por coincidencia. Las dos son cambios de esquema — <strong>una decisión de una persona, no de este panel</strong>.</p>
  </div>`;

  const matchOutcomeSection = `<div class="stats-section">
    ${section('Qué pasó después de cada coincidencia')}
    <p class="stats-note">Ni la bitácora de coincidencias ni la de avisos guardan qué aviso salió de cuál coincidencia puntual — no hay ninguna columna que las ate. Por eso esta sección responde en dos piezas medibles, no en un solo número por coincidencia.</p>
    <p class="stats-note"><strong>¿Había a quién avisar?</strong> De <strong>${rescueContactSuppression.total.display}</strong> veces que un rescatista usó esta app, <strong>${rescueContactByKey.sinContacto.display}</strong> no dejaron ningún contacto (correo o WhatsApp) — así que si esa foto llega a coincidir con un reporte, <strong>no hay a quién avisar</strong>. Es el caso <strong>MÁS COMÚN hoy, y es correcto</strong>: esta app nunca le escribe a un número o correo que nadie confirmó, ni inventa un contacto que no existe. Las otras <strong>${rescueContactByKey.conContacto.display}</strong> sí dejaron un contacto utilizable.</p>
    <p class="stats-note"><strong>Avisos intentados, por resultado.</strong> De ${contactOutcomeSuppression.total.display} avisos intentados (de cualquier coincidencia): ${outcomeByKey.directo.display} llegaron directo a quien buscaba o rescataba, ${outcomeByKey.relevo.display} llegaron al buzón del equipo — <strong>esperando que una persona los revise y los enrute</strong> (esta base no distingue cuáles ya se atendieron; ese seguimiento vive en el correo del equipo, no acá) — y ${outcomeByKey.fallidoRechazado.display} fallaron o se rechazaron.</p>
    ${detailsBlock('Ver el detalle por canal, fallos primero', table(['Canal', 'Fallidos', 'Rechazados', 'Entregados'], outcomeDetailRows))}
  </div>`;

  // Punto 6 del issue #132 — la pregunta que importa: cuántos encuentros
  // hizo posibles esta app. Cuatro escalones, ACUMULADOS desde siempre —
  // NUNCA por día (rebanar por día fue justo lo que fabricó un falso "caso
  // único" antes en este panel). Los tres primeros reusan celdas YA
  // suprimidas más arriba en esta misma página (misma cifra, mismo sitio de
  // verdad — matchSuppression/matchByKey vienen del hero card de arriba,
  // contactByKey de la tarjeta de envíos) — solo el último escalón es nuevo.
  const reunitedCell = suppressedCell(extras.reunitedCount);
  const funnelSteps = [
    { key: 'registrada', label: 'Registrada', cell: matchSuppression.total },
    { key: 'entregada', label: 'Entregada', cell: matchByKey.rescate },
    { key: 'avisada', label: 'Avisada', cell: contactByKey.enviado },
    { key: 'salvo', label: 'A salvo', cell: reunitedCell }
  ];
  const reunionSection = `<div class="stats-section">
    ${section('El embudo del encuentro (acumulado) — la pregunta que importa')}
    <p class="stats-note"><strong>La app no puede ver el abrazo.</strong> Nadie vuelve a la web a contarnos que encontró a su familiar, así que esto se mide por aproximación:</p>
    <div class="stats-chart-card">${reunionFunnelChart(funnelSteps)}</div>
    ${detailsBlock(
      'Ver qué cuenta cada escalón',
      table(
        ['Escalón', 'Cuántas', 'Qué significa'],
        [
          [
            '1 · Coincidencia registrada',
            matchSuppression.total.display,
            'El sistema reconoció a alguien — cualquier superficie (rescate, reporte, API).'
          ],
          [
            '2 · Entregada',
            matchByKey.rescate.display,
            'Un rescatista vio en pantalla a quién encontró y cómo contactar a su familia. Este es el momento en que la app hace su trabajo — solo cuenta la superficie "rescate" (/rescate), la única con una pantalla de resultado; las coincidencias de reporte/API se notifican sin este paso intermedio.'
          ],
          [
            '3 · Contacto avisado',
            contactByKey.enviado.display,
            'Un aviso llegó a destino — directo a quien buscaba/rescataba, o al buzón del equipo (relevo). No distingue si ese aviso ya se resolvió.'
          ],
          [
            '4 · Persona a salvo',
            reunitedCell.display,
            'Su estado más reciente en el registro es "a salvo". No necesariamente vino de un aviso de esta app — puede ser una familia que la encontró por su cuenta y solo actualizó el estado.'
          ]
        ]
      )
    )}
    <p class="stats-note">⚠️ El último escalón es un <strong>PISO, no un total</strong>: los reencuentros que nadie nos reporta no aparecen acá, y son probablemente la mayoría. Tampoco es estrictamente un subconjunto de los anteriores — puede haber personas "a salvo" que nunca pasaron por ningún aviso de esta app.</p>
  </div>`;

  // El principio que gobierna todo el issue #132: un cero nunca puede
  // parecer un hecho medido cuando es un punto ciego. Estos son los puntos
  // ciegos que introduce ESTA pasada — no un inventario de todo lo que la
  // app no mide (eso sigue viviendo en el correo, sección 4).
  const notYetSection = `<div class="stats-section">
    ${section('Lo que todavía no podemos medir')}
    ${detailsBlock(
      'Ver los puntos ciegos declarados en esta pasada',
      table(
        ['Señal', 'Por qué sigue afuera'],
        [
          [
            'Personas fotografiadas por un rescatista en modo «no guarden nada»',
            'Esa opción no guarda ni la firma facial ni ninguna fila — no queda ningún rastro que contar.'
          ],
          [
            'Si una ficha «de más» de una persona es un duplicado real o un seguimiento legítimo',
            'El esquema no distingue las dos cosas: un cambio de estado reportado después y un duplicado por error se ven exactamente igual — una fila adicional de `updates` para la misma persona.'
          ],
          [
            'Qué coincidencia concreta originó qué aviso',
            'Ni match_log ni contact_log guardan esa relación (no hay match_id en contact_log) — la sección «Qué pasó después de cada coincidencia» responde en dos piezas separadas, no en un embudo por coincidencia.'
          ],
          [
            'Si un aviso que llegó al buzón del equipo (relevo) ya fue atendido',
            'Esta base no guarda un estado de "resuelto" para el relevo — ese seguimiento vive en las etiquetas de Gmail del equipo, un sistema aparte.'
          ]
        ]
      )
    )}
  </div>`;

  const suppressionNote = `<p class="stats-note" style="font-style:italic;">${SUPPRESSION_NOTE}</p>`;

  const footer = `<p class="stats-note" style="font-style:italic;">Generado ${esc(day)} ${esc(month)}, ${esc(hm)} Bogotá · Mismas cifras que el reporte por correo (#116) · Sin drill-down por ID — eso vive detrás de sesión en /api/admin/*, no acá.</p>`;

  const body = `
    <h1>Panel de estadísticas</h1>
    ${banner}
    ${suppressionNote}
    ${heroCards}
    ${deltaNote}
    ${dedupSection}
    ${rescuedPeopleSection}
    ${dailySection}
    ${channelSection}
    ${outreachSection}
    ${similaritySection}
    ${matchKnowledgeSection}
    ${matchOutcomeSection}
    ${reunionSection}
    ${funnelPlaceholder}
    ${baseSection}
    ${notYetSection}
    ${footer}
    ${FUNNEL_SCRIPT}
  `;

  return layout('Panel de estadísticas', body, { path: '/admin/stats', robots: 'noindex, nofollow', mainClass: 'stats-wide' });
}

function pivotSum(pivot, result) {
  return Object.values(pivot).reduce((s, ch) => s + (ch[result] || 0), 0);
}

module.exports = { buildStatsPageHtml, buildFunnelFragmentHtml };
