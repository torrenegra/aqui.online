// Minimal server-rendered HTML helpers. No client framework: emergency sites
// must load fast on bad connections and old phones.
const env = require('./env');
const { STATUS_LABEL } = require('./notify');
const { maskReporter } = require('./privacy');
const { isReadyToShow, toCropSpace } = require('./report-photo');

const DEFAULT_DESCRIPTION =
  'Si rescataste a alguien, sube su foto y te decimos quién la está buscando; la foto se borra de inmediato. También puedes reportar a una persona desaparecida. Terremoto en Colombia, 10 de agosto.';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_CLASS = {
  safe: 'ok',
  injured: 'warn',
  missing: 'bad',
  deceased: 'grave',
  unknown: 'muted'
};

const PRIVACY_NOTE = `<p class="privacy">🔒 La foto del reporte <strong>se publica</strong> junto al nombre, para que un rescatista pueda reconocer a la persona. La foto de un rescatista, en cambio, nunca se guarda.</p>`;

// The public face plate: the report photo with the face-detection geometry
// drawn over it. Rekognition gives every coordinate as a ratio of the image,
// so positioning in percentages lands each marker on the right pixel at any
// rendered size — and, unlike an SVG stretched to the box, keeps the dots
// round on a non-square photo.
const LANDMARK_LABEL = {
  eyeLeft: 'ojo izquierdo',
  eyeRight: 'ojo derecho',
  nose: 'nariz',
  mouthLeft: 'comisura izquierda',
  mouthRight: 'comisura derecha'
};

function pct(n) {
  const v = Number(n);
  return `${(Number.isFinite(v) ? v * 100 : 0).toFixed(3)}%`;
}

// The listing loads the face thumbnail, never the full photo, and only once
// PHOTO_SCRIPT decides the visitor's connection can afford it. Without
// JavaScript the <noscript> copy loads normally.
function facePlate(photo, personName, { large = false } = {}) {
  if (!isReadyToShow(photo)) return '';
  const detail = photo.face_detail ? toCropSpace(photo.face_detail) : null;
  const alt = `Foto del reporte de ${personName}`;
  const src = `/photo/${photo.id}/${large ? 'face' : 'thumb'}`;

  let overlay = '';
  if (detail && detail.box) {
    const { l, t, w, h } = detail.box;
    const points = (detail.points || [])
      .map(
        (p) =>
          `<span class="face-pt" style="left:${pct(p.x)};top:${pct(p.y)}" title="${esc(
            LANDMARK_LABEL[p.t] || p.t
          )}"></span>`
      )
      .join('');
    overlay = `<div class="face-box" style="left:${pct(l)};top:${pct(t)};width:${pct(w)};height:${pct(
      h
    )}"></div>${points}`;
  }

  // The <img> is built by PHOTO_SCRIPT, not rendered here: an <img> that is
  // hidden with display:none never satisfies loading="lazy" in Chrome, so it
  // would sit there forever without fetching anything.
  const px = large ? 240 : 80;
  return `<div class="face pending${large ? ' large' : ''}" data-src="${src}" data-alt="${esc(alt)}">
  <button type="button" class="face-load" aria-label="Ver la foto de ${esc(personName)}" title="Ver foto">📷</button>
  <noscript><img class="face-noscript" src="${src}" alt="${esc(alt)}" width="${px}" height="${px}"></noscript>
  ${overlay}
</div>`;
}

// Photos are the heaviest thing on this page, and the people refreshing it are
// often on one bar of signal. Load the thumbnails only when the connection can
// clearly afford them; otherwise leave a button so it stays the visitor's call.
//
// Deliberately written to survive toString(): it is unit-tested here in Node
// and shipped to the browser inside PHOTO_SCRIPT, so there is only ever one
// copy of the rule. Keep it self-contained — no closures, no modern syntax.
function thumbnailsAreAffordable(c) {
  if (!c) return true; // nothing to go on: don't punish the visitor
  if (c.saveData) return false; // they explicitly asked to save data
  var t = c.effectiveType || '';
  if (t === 'slow-2g' || t === '2g') return false;
  if (t === '3g') return (c.downlink || 0) >= 0.5;
  return true;
}

const PHOTO_SCRIPT = `<script>
(function () {
  var affordable = ${thumbnailsAreAffordable.toString()};

  function show(face) {
    var src = face.getAttribute('data-src');
    if (!src || face.querySelector('img:not(.face-noscript)')) return;
    face.classList.add('loading');
    var img = document.createElement('img');
    img.alt = face.getAttribute('data-alt') || '';
    var px = face.classList.contains('large') ? 240 : 80;
    img.width = px;
    img.height = px;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', function () {
      face.classList.remove('pending');
      face.classList.remove('loading');
    });
    img.addEventListener('error', function () { face.classList.remove('loading'); });
    img.src = src;
    face.insertBefore(img, face.firstChild);
  }

  var faces = document.querySelectorAll('.face.pending');
  var ok = affordable(navigator.connection || navigator.mozConnection || navigator.webkitConnection);
  Array.prototype.forEach.call(faces, function (face) {
    if (ok) return show(face);
    var btn = face.querySelector('.face-load');
    if (btn) btn.addEventListener('click', function () { show(face); });
  });
})();
</script>`;

// Client-side downscale + XHR upload with a visible progress bar. Emergency
// users on weak connections must see that something is happening.
const RESIZE_SCRIPT = `<script>
(function () {
  function bar(form) {
    var box = form.querySelector('.upload-progress');
    if (!box) {
      box = document.createElement('div');
      box.className = 'upload-progress';
      box.innerHTML = '<div class="upload-label">Preparando…</div><div class="upload-track"><div class="upload-fill"></div></div>';
      form.appendChild(box);
    }
    box.style.display = 'block';
    return {
      set: function (pct, label) {
        box.querySelector('.upload-fill').style.width = Math.max(2, Math.round(pct)) + '%';
        if (label) box.querySelector('.upload-label').textContent = label;
      },
      hide: function () { box.style.display = 'none'; }
    };
  }

  async function shrink(file) {
    if (typeof createImageBitmap !== 'function') return file;
    try {
      var bmp = await createImageBitmap(file);
      var scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', 0.82); });
      return new File([blob], (file.name || 'foto') + '.jpg', { type: 'image/jpeg' });
    } catch (e) { return file; }
  }

  document.addEventListener('submit', async function (ev) {
    var form = ev.target;
    if (!form.matches('form[data-resize-photos]')) return;
    var inputs = form.querySelectorAll('input[type=file]');
    var files = [];
    inputs.forEach(function (i) { for (var f of i.files) files.push(f); });
    if (!files.length) return; // plain submit, no upload UI needed

    ev.preventDefault();
    var submitBtn = form.querySelector('button:not([type=button])');
    if (submitBtn) { submitBtn.disabled = true; }
    var p = bar(form);

    // 1) shrink (0-30%)
    var data = new FormData(form);
    inputs.forEach(function (i) { data.delete(i.name); });
    var done = 0;
    for (var input of inputs) {
      for (var file of input.files) {
        p.set(5 + (done / files.length) * 25, 'Optimizando foto ' + (done + 1) + ' de ' + files.length + '…');
        data.append(input.name, await shrink(file));
        done++;
      }
    }

    // 2) upload (30-100%)
    p.set(30, 'Enviando… 0%');
    var requestUrl = new URL(form.getAttribute('action') || location.href, location.href).href;
    var xhr = new XMLHttpRequest();
    xhr.open(form.method || 'POST', requestUrl);
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      var pct = e.loaded / e.total;
      p.set(30 + pct * 65, 'Enviando… ' + Math.round(pct * 100) + '%');
    };
    xhr.onload = function () {
      p.set(100, '¡Listo!');
      // Only navigate when the server actually redirected us somewhere else.
      // For a page rendered in place (e.g. search results) responseURL equals
      // the request URL, and navigating there would discard the results.
      if (xhr.responseURL && xhr.responseURL.split('#')[0] !== requestUrl.split('#')[0]) {
        window.location.href = xhr.responseURL;
        return;
      }
      document.open();
      document.write(xhr.responseText);
      document.close();
    };
    xhr.onerror = function () {
      p.set(100, 'Error de conexión. Revisa tu señal e inténtalo de nuevo.');
      if (submitBtn) submitBtn.disabled = false;
    };
    xhr.send(data);
  });
})();
</script>`;

// Two asks at the very bottom of every page, aimed at the two kinds of people
// who can widen the search beyond what this site indexes on its own: the
// registry that already holds most of the country's fichas, and anyone with an
// AI agent who can go find reports nobody has entered here yet. Kept in the
// footer, below the credits, so they never compete with the list of missing
// people — which is what someone landing here actually came for.
const WRITE_US = `<a href="https://x.com/ni500" target="_blank" rel="noopener">Escríbenos</a>`;
const OUTREACH = `<p class="outreach">¿Deseas contribuir? Puedes usar tu agente de AI para hacer crawling de redes sociales y encontrar reportes de desaparecidos. ${WRITE_US}.</p>
  <p class="outreach">¿Eres parte del equipo de ColombiaTeBusca? Puedes integrar nuestra tech directamente o podemos integrarla por Uds. ${WRITE_US}.</p>`;

// Money, last of all. People do ask where to donate, and the honest answer is
// "not here" — so the line says that first and then hands over three labelled
// destinations on Vaki, the crowdfunding platform, named in plain text so
// nobody clicks without knowing where they land.
//
// Three constraints shaped it, in this order:
//   1. It must never compete with "Reporta desaparecido". Someone looking for
//      their sister cannot meet a money button first, so this sits at the very
//      bottom, under the credits and under the two asks, in the same quiet
//      .outreach style — no new CSS, no new weight, nothing to notice unless
//      you were looking for it.
//   2. The country is LABELLED, never detected. Geolocation breaks on a VPN
//      and, worse, on the diaspora — a good share of the people reporting from
//      this site do it from +34 and +54 numbers, and guessing would send them
//      to the wrong door with no way back.
//   3. One paragraph, three links, zero JavaScript. Same budget as everything
//      else here.
const GIVE = `<p class="outreach">Este sitio no recibe donaciones. Si quieres aportar dinero, estos enlaces llevan a Vaki, una plataforma de recaudo colectivo cofundada por uno de los mantenedores de este sitio: <a href="https://vaki.co/explorar" target="_blank" rel="noopener">ver campañas abiertas en Colombia</a> · <a href="https://helpcolombia.vaki.org" target="_blank" rel="noopener">donar desde Estados Unidos, con Vaki Foundation</a> · <a href="https://vaki.co/crear" target="_blank" rel="noopener">crear una vaki para ayudar a alguien en particular</a>.</p>`;

function layout(title, body, meta = {}) {
  const fullTitle = meta.fullTitle || `${title} — encontrados.co · Personas y terremoto en Colombia`;
  const description = meta.description || DEFAULT_DESCRIPTION;
  const url = meta.path ? `${env.BASE_URL}${meta.path}` : env.BASE_URL;
  // meta.robots: para páginas que nunca deben entrar a un buscador (hoy solo
  // el panel de /admin/stats en su ventana pública temporal, #116 PR 6). Sin
  // esto, cualquier página se indexa igual que siempre.
  const robots = meta.robots ? `\n<meta name="robots" content="${esc(meta.robots)}">` : '';
  // meta.mainClass: para una página que necesita más ancho que el formulario
  // angosto por el que está pensado <main> (hoy solo /admin/stats, denso en
  // datos) — sin tocar el <main> de todas las demás páginas.
  const mainClass = meta.mainClass ? ` class="${esc(meta.mainClass)}"` : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">${robots}
<meta property="og:site_name" content="encontrados.co">
<meta property="og:type" content="website">
<meta property="og:locale" content="es_CO">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9D%A4%EF%B8%8F%E2%80%8D%F0%9F%A9%B9%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="tricolor"><span class="y"></span><span class="b"></span><span class="r"></span></div>
<header>
  <a class="brand" href="/">❤️‍🩹 encontrados.co</a>
  <nav>
    <a href="/mascotas">🐾 Mascotas</a>
    <a href="/rescate">Soy rescatista</a>
    <a href="/report" class="cta">Reporta desaparecido</a>
  </nav>
</header>
<div class="banner">🇨🇴 <strong>Terremoto en Colombia — lunes 10 de agosto.</strong></div>
<main${mainClass}>
${body}
</main>
<footer>
  <p><span class="credit">Hecho con 💙 por <a href="https://x.com/ni500" target="_blank" rel="noopener">Ni500</a> y <a href="https://me.torrenegra.com" target="_blank" rel="noopener">Torrenegra</a>, y mantenido por grandes contribuidores y voluntarios ✊🇨🇴</span> · <a href="/ideas">💡 Ideas</a> · <a href="/bug">🐛 Reporta bug</a> · <a href="https://github.com/encontradosco/encontrados" target="_blank" rel="noopener">Github</a> · <a href="/privacidad">Privacidad</a> · <a href="/terminos">Términos</a></p>
${OUTREACH}
${GIVE}
</footer>
${RESIZE_SCRIPT}
${TIME_SCRIPT}
${PHOTO_SCRIPT}
</body>
</html>`;
}

function statusBadge(status) {
  return `<span class="badge ${STATUS_CLASS[status] || 'muted'}">${esc(
    STATUS_LABEL[status] || status
  )}</span>`;
}

// Timestamps are always shown in the VIEWER's timezone (done client-side —
// the server cannot know it). Without JavaScript we fall back to a relative
// time, which is correct in every timezone instead of guessing one.
function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso || '');
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'hace instantes';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

// <time> element carrying the machine-readable instant so the client can
// localize it.
function timeTag(iso) {
  return `<time class="ts" datetime="${esc(iso || '')}">${fmtDate(iso)}</time>`;
}

// Render every timestamp in the viewer's own timezone and locale.
const TIME_SCRIPT = `<script>
(function () {
  var opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  var els = document.querySelectorAll('time.ts');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var iso = el.getAttribute('datetime');
    if (!iso) continue;
    var d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    try {
      // undefined locale + no timeZone option = the viewer's own settings
      el.textContent = d.toLocaleString(undefined, opts);
      el.title = d.toLocaleString();
    } catch (e) {}
  }
})();
</script>`;

function mapLink(u) {
  if (u.lat == null || u.lng == null) return '';
  return ` · <a href="https://www.openstreetmap.org/?mlat=${u.lat}&amp;mlon=${u.lng}#map=16/${u.lat}/${u.lng}" target="_blank" rel="noopener">ver en mapa</a>`;
}

// `source` is an enum for the database, not for a family reading the ficha —
// "Fuente: aggregator" is developer jargon on the most human page of the site.
const SOURCE_LABEL = {
  web: 'sitio web',
  whatsapp: 'WhatsApp',
  api: 'API',
  aggregator: 'registro externo',
  rescate: 'rescatista'
};

// El enlace a la noticia que respalda este update. Se muestra distinto cuando
// la persona aparece como encontrada: ahí no es un dato más, es lo que quien
// la está buscando vino a ver. `rel="noopener nofollow"` porque es un destino
// externo que no controlamos, y `target=_blank` para no sacar a nadie de la
// ficha que está leyendo.
function sourceLink(u) {
  if (!u.source_url) return '';
  const label = u.status === 'safe' ? '✅ Encontrado — ver noticia' : 'Ver la fuente de este reporte';
  const cls = u.status === 'safe' ? 'source-link found' : 'source-link';
  return `<p class="${cls}"><a href="${esc(u.source_url)}" target="_blank" rel="noopener nofollow">${label}</a></p>`;
}

function updateCard(u, personName) {
  // Never render the raw `reporter` — it may be a phone number or email
  // (see src/privacy.js). Only the masked public label is safe to show.
  const reporterLabel = maskReporter(u.reporter);
  return `<article class="card">
  ${personName ? `<h3><a href="/person/${u.person_id}">${esc(personName)}</a></h3>` : ''}
  <p>${statusBadge(u.status)} ${timeTag(u.created_at)}</p>
  ${u.message ? `<p class="msg">${esc(u.message)}</p>` : ''}
  ${u.location ? `<p class="loc">📍 ${esc(u.location)}${mapLink(u)}</p>` : u.lat != null && u.lng != null ? `<p class="loc">📍 Ubicación GPS${mapLink(u)}</p>` : ''}
  ${sourceLink(u)}
  <p class="meta">Fuente: ${esc(SOURCE_LABEL[u.source] || u.source)}${reporterLabel ? ` · Reportado por: ${esc(reporterLabel)}` : ''}</p>
</article>`;
}

// Type-ahead for the "where were they" field. There is deliberately NO
// "share my location" button: the reporter is almost never standing where the
// missing person was last seen, so their GPS answered a different question
// than the one being asked — and the browser permission prompt cost a form
// abandon to get there.
const LOCATION_SCRIPT = `<script>
(function () {
  var loc = document.getElementById('location');
  var list = document.getElementById('location-options');
  var timer;
  if (loc && list) loc.addEventListener('input', function () {
    clearTimeout(timer);
    var q = loc.value.trim();
    if (q.length < 4) return;
    timer = setTimeout(function () {
      fetch('https://nominatim.openstreetmap.org/search?format=json&countrycodes=co&limit=5&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (results) {
          list.innerHTML = '';
          results.forEach(function (r) {
            var o = document.createElement('option');
            o.value = r.display_name.split(',').slice(0, 4).join(',');
            list.appendChild(o);
          });
        }).catch(function () {});
    }, 400);
  });
})();
</script>`;

// Restricts any input marked `data-phone-filter` to digits and a single
// leading '+' as the visitor types, and flags it invalid — a red border plus
// the sibling `.field-hint-error` message — once what's left doesn't look
// like a real phone number (10 digits, or 11-15 with a country code). Purely
// a UX signal: whether an invalid value blocks submission is up to the page
// (see /report's own server-side check vs. /rescate's deliberately lenient
// one), not this script.
const PHONE_FILTER_SCRIPT = `<script>
document.addEventListener('input', function (ev) {
  if (!ev.target || !ev.target.matches('[data-phone-filter]')) return;
  var v = ev.target.value;
  var plus = v.charAt(0) === '+' ? '+' : '';
  v = plus + v.replace(/\\D/g, '').slice(0, 15);
  ev.target.value = v;
  var digits = plus ? v.length - 1 : v.length;
  var valid = !v || digits === 10 || (digits >= 11 && digits <= 15);
  ev.target.classList.toggle('field-invalid', !valid);
  var hint = ev.target.parentElement.querySelector('.field-hint-error');
  if (hint) hint.hidden = valid;
}, true);
</script>`;

module.exports = {
  esc,
  layout,
  statusBadge,
  updateCard,
  fmtDate,
  timeTag,
  facePlate,
  thumbnailsAreAffordable,
  PRIVACY_NOTE,
  LOCATION_SCRIPT,
  PHONE_FILTER_SCRIPT
};
