// Outbound notifications: email (SendGrid) and WhatsApp (Meta Cloud API).
// All fire-and-forget with logging — a failed notification must never block a report.
const env = require('./env');
const { logContact, resultFromSend } = require('./logbook');

const STATUS_LABEL = {
  safe: 'A SALVO',
  injured: 'HERIDO(A)',
  missing: 'DESAPARECIDO(A)',
  deceased: 'FALLECIDO(A)',
  unknown: 'SIN CONFIRMAR'
};

function updateText(person, update) {
  const lines = [
    `${person.full_name}: ${STATUS_LABEL[update.status] || update.status}`,
    update.message ? `Nota: ${update.message}` : null,
    update.location ? `Ubicación: ${update.location}` : null,
    `${env.BASE_URL}/person/${person.id}`
  ];
  return lines.filter(Boolean).join('\n');
}

// ------------------------------------------------------------- modo de envío
//
// Entregarle el contacto de una familia a un desconocido que dice haber
// rescatado a alguien es un vector de extorsión, y la app lo venía haciendo
// sola: el aviso salía derecho al tercero, sin nadie en el circuito. En modo
// RELEVO —el modo por omisión— ningún aviso a un tercero se envía: todos se
// centralizan en el buzón del operador (AVISO_EMAIL) con el contexto suficiente
// para que una persona verifique quién es el destinatario y lo enrute a mano.
//
// NOTIFY_MODE=direct devuelve el comportamiento anterior. Se lee EN VIVO de
// process.env, nunca del snapshot de env.js, para que cambiar de modo sea una
// variable y no un despliegue de código. Cualquier valor distinto de "direct"
// —incluida una errata— significa relevo: este interruptor falla cerrado.
const DIRECT = 'direct';
const RELAY = 'relay';

function notifyMode() {
  const raw = (process.env.NOTIFY_MODE || '').trim().toLowerCase();
  if (!raw || raw === RELAY) return RELAY;
  if (raw === DIRECT) return DIRECT;
  console.warn(`[notify:relevo] NOTIFY_MODE="${raw}" no se reconoce — se asume "relay" (nada sale a terceros).`);
  return RELAY;
}

function relayEnabled() {
  return notifyMode() === RELAY;
}

// El buzón de operación. Live desde process.env por la misma razón, y para que
// una prueba pueda borrarlo y ejercitar el camino "sin configurar".
function avisoEmail() {
  return (process.env.AVISO_EMAIL || env.AVISO_EMAIL || '').trim();
}

// Prefijo estable y grepeable, tanto en el buzón como en los logs.
const RELAY_SUBJECT_PREFIX = '[RETENIDO]';
const CHANNEL_LABEL = { email: 'correo', whatsapp: 'WhatsApp' };

// Le manda al operador un aviso que NO se entregó, con todo lo que hace falta
// para enrutarlo sin abrir la base de datos. Nunca lanza: un fallo acá no puede
// tumbar el reporte ni la coincidencia que lo originó.
// `delivered` = el aviso SÍ salió a su destinatario y esta copia existe por
// otra razón: el texto que salió no lleva el contacto de la familia, así que el
// caso sigue abierto y necesita a un humano. La primera línea del cuerpo tiene
// que decir cuál de los dos casos es — un operador que lee "no se envió" cuando
// sí se envió va a mandar el mismo aviso dos veces.
async function relayToOperators({ reason, channel, address, subject, text, person, details = [], delivered = false }) {
  const to = avisoEmail();
  const ficha = person ? `${env.BASE_URL}/person/${person.id}` : null;
  const trace =
    `motivo="${reason}" canal=${channel} destino=${address} ` +
    `persona=${person ? person.id : '?'} ficha=${ficha || '-'}`;

  if (!to) {
    // El relevo está activo y no hay a dónde relevar. Caer a envío directo
    // reabriría en silencio justo el riesgo que el relevo existe para cerrar,
    // y encima cuando la configuración ya está rota — así que no sale nada.
    // Este log es la ÚNICA copia que queda del aviso, por eso lleva el texto
    // completo: perderlo es peor que tenerlo en el log del operador.
    console.error(
      `[notify:relevo] PERDIDO — ${delivered ? 'copia de seguimiento' : 'relevo activo'} y AVISO_EMAIL sin configurar. ${trace}\n${text}`
    );
    return { ok: false, relayed: false, error: 'AVISO_EMAIL no configurada' };
  }

  const body = [
    ...(delivered
      ? [
          'Este aviso SÍ se envió a su destinatario, pero SIN el contacto de la familia.',
          '',
          'El texto que salió no lleva ese dato y nunca lo lleva, en ningún canal.',
          'Esta copia existe porque el caso queda abierto: alguien dice saber dónde',
          'está una persona y quien la busca todavía no lo sabe. Cerrarlo es un acto',
          'humano.'
        ]
      : [
          'Este aviso NO se envió a su destinatario.',
          '',
          'encontrados.co está en modo relevo: los avisos que iban a terceros se',
          'centralizan en este buzón para que una persona verifique a quién se le',
          'está entregando el dato antes de que salga.'
        ]),
    '',
    `Iba dirigido a: ${address}`,
    `Canal: ${CHANNEL_LABEL[channel] || channel}`,
    `Motivo: ${reason}`,
    person ? `Persona: ${person.full_name}` : null,
    ficha ? `Ficha: ${ficha}` : null,
    ...details,
    '',
    `Asunto original: ${subject}`,
    '--- texto que se iba a enviar ---',
    text,
    '--- fin del texto ---',
    '',
    ...(delivered
      ? [
          'Siguiente paso: verificar quién es esa persona y decidir si el contacto de',
          'arriba se le entrega, o si a la familia le avisa alguien del equipo. El',
          'texto ya salió; el dato no.'
        ]
      : [
          'Siguiente paso: verificar la identidad del destinatario y, si corresponde,',
          'hacerle llegar el texto de arriba. De aquí no sale nada solo.'
        ])
  ]
    .filter((l) => l !== null)
    .join('\n');

  const relaySubject = `${RELAY_SUBJECT_PREFIX} ${reason} — ${person ? person.full_name : 'sin persona'}`;
  const result = await sendEmail(to, relaySubject, body);
  if (!result.ok) {
    console.error(`[notify:relevo] PERDIDO — el relevo a ${to} falló (${result.error || result.status}). ${trace}\n${text}`);
    return { ...result, relayed: false };
  }
  console.log(`[notify:relevo] retenido y relevado a ${to} — ${trace}`);
  return { ...result, relayed: true };
}

// Neutraliza saltos de línea y demás caracteres de control antes de que un
// texto escrito por alguien de afuera entre a un log. El resumen de /ideas y
// /bug es texto libre: sin esto, uno que traiga su propio salto de línea
// fabrica una línea de log entera, y quien diagnostica termina leyendo un
// evento que nunca ocurrió.
function logSafe(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

// Manda un correo al buzón de operación con el asunto y el cuerpo que arma
// quien llama. Comparte la mecánica de `relayToOperators` (leer `avisoEmail()`
// en vivo, degradar con un log claro si no está configurada, nunca lanzar)
// pero sin su plantilla fija de "aviso retenido de coincidencia" — para los
// llamadores que arman su propio texto porque lo que mandan no es ni un aviso
// de coincidencia ni una actualización de estado: hoy son el aviso de un
// rescatista (POST /rescate/aviso) y el respaldo de /ideas y /bug cuando
// GitHub no responde. Antes cada uno reimplementaba el mismo "si hay buzón,
// mandar; si no, loguear y degradar" con su propia forma.
async function mailOperators(subject, body) {
  const to = avisoEmail();
  if (!to) {
    // Este log lleva el asunto y NO el cuerpo, al revés que el de
    // `relayToOperators`. La diferencia es deliberada: allá el texto se vuelca
    // porque el log es la ÚNICA copia que queda del aviso, y ese comentario lo
    // dice. Acá esa razón no aplica — el aviso del rescatista ya quedó
    // guardado con `addUpdate` antes de intentar este correo (por eso su
    // llamador lo llama "best effort"), así que el cuerpo es recuperable de la
    // base. Volcarlo aquí regalaría, a cambio de nada, el teléfono de quien
    // avisa y el lugar donde dice que está la persona: en zona de desastre ese
    // par es materia de extorsión, no un campo más. El asunto alcanza para
    // saber qué se perdió e ir a buscarlo.
    console.error(`[notify:operadores] PERDIDO — AVISO_EMAIL sin configurar. asunto="${logSafe(subject)}"`);
    return { ok: false, error: 'AVISO_EMAIL no configurada' };
  }
  return sendEmail(to, subject, body);
}

// Returns { ok, status, error } and logs loudly — email silence is a bug we
// must be able to diagnose from the Vercel logs alone.
//
// `html` es opcional: casi todo el sistema manda texto plano (avisos,
// verificaciones), y eso no cambia. El reporte operativo recurrente (#116,
// PR 2) es el primer llamador que pasa `html` — SendGrid recibe las dos
// partes, texto primero, para que un cliente que no rinde HTML siga
// mostrando algo legible.
async function sendEmail(to, subject, text, { html } = {}) {
  // Read from process.env too so configuration applied after module load
  // (and test doubles) are honoured.
  const apiKey = process.env.SENDGRID_API_KEY || env.SENDGRID_API_KEY;
  const apiBase = process.env.SENDGRID_API_BASE || 'https://api.sendgrid.com';
  if (!apiKey) {
    console.error(`[notify:email] SKIPPED — SENDGRID_API_KEY is not set. to=${to}`);
    return { ok: false, error: 'SENDGRID_API_KEY no configurada' };
  }
  try {
    const res = await fetch(`${apiBase}/v3/mail/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.EMAIL_FROM, name: 'encontrados.co' },
        subject,
        content: html
          ? [
              { type: 'text/plain', value: text },
              { type: 'text/html', value: html }
            ]
          : [{ type: 'text/plain', value: text }],
        // Click tracking rewrites our links through SendGrid's tracking domain.
        // That domain returns 403 here, which silently broke every
        // verification and unsubscribe link. These are transactional emails:
        // the links must point straight at encontrados.co.
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false }
        }
      })
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[notify:email] FAILED ${res.status} from=${env.EMAIL_FROM} to=${to} body=${body}`);
      return { ok: false, status: res.status, error: body };
    }
    console.log(`[notify:email] sent to=${to} subject="${subject}"`);
    return { ok: true, status: res.status };
  } catch (e) {
    console.error(`[notify:email] THREW to=${to}`, e);
    // `fetch` normalmente rechaza con un Error de verdad, pero no es una
    // garantía del lenguaje — un `e` sin `.message` (por ejemplo `undefined`)
    // tumbaría este catch y con él cualquier aviso que dependa de esta
    // función, justo en el camino que se supone que nunca lanza.
    return { ok: false, error: e?.message || String(e) };
  }
}

// ------------------------------------------------- las plantillas aprobadas
//
// Meta aprueba una plantilla por su nombre, su idioma y su texto exacto. Lo que
// dicen esas dos plantillas ES el contrato del flujo, y el código se ajusta a
// ellas y no al revés:
//
//   confirmacion_rescatista_encontrados  {{1}} = nombre de la persona.
//     Pregunta si quien recibe está con esa persona (o sabe dónde ubicarla) o
//     si lo que hizo fue reportarla como desaparecida, y pide responder SÍ o
//     REPORTE escribiéndolo.
//   ficha_fuente_rescatista_encontrados  {{1}} = nombre, {{2}} = URL de la
//     ficha en el registro público de origen. Dice que nosotros NO tenemos el
//     contacto de la familia y que ellos sí, y manda a marcar a la persona como
//     localizada en ese registro — "solo si la viste tú o hablaste con ella".
//
// De ahí sale la regla más importante de todo el flujo: **por WhatsApp nunca
// sale el contacto de una familia.** Lo más que entrega un "sí" falsificado es
// un enlace a un registro público.
//
// Los nombres son configurables porque quien los aprueba es Meta del lado de la
// cuenta, pero el valor por omisión es el aprobado: sin configurar nada, el
// código manda exactamente lo que Meta ya revisó. Poner la variable en vacío
// apaga ese envío a propósito.
const DEFAULT_TEMPLATE_RESCUE_CONFIRM = 'confirmacion_rescatista_encontrados';
const DEFAULT_TEMPLATE_RESCUE_SOURCE = 'ficha_fuente_rescatista_encontrados';
// Meta trata `es` y `es_CO` como idiomas DISTINTOS: pedir `es` para una
// plantilla aprobada en `es_CO` es un rechazo, no una aproximación.
const DEFAULT_TEMPLATE_LOCALE = 'es_CO';

function readTemplate(name, fallback) {
  const raw = process.env[name] !== undefined ? process.env[name] : env[name];
  return String(raw === undefined || raw === null ? fallback : raw).trim();
}

// Paso 1: la pregunta. Nunca lleva un dato de la familia.
function rescueConfirmTemplate() {
  return readTemplate('WHATSAPP_TEMPLATE_RESCUE_CONFIRM', DEFAULT_TEMPLATE_RESCUE_CONFIRM);
}

// Paso 2: la ficha del registro de origen. Tampoco lleva un dato de la familia.
function rescueSourceTemplate() {
  return readTemplate('WHATSAPP_TEMPLATE_RESCUE_SOURCE', DEFAULT_TEMPLATE_RESCUE_SOURCE);
}

function whatsappTemplateLocale() {
  return readTemplate('WHATSAPP_TEMPLATE_LOCALE', DEFAULT_TEMPLATE_LOCALE) || DEFAULT_TEMPLATE_LOCALE;
}

// Dos formas de mandar, porque Meta acepta dos cosas distintas:
//
//   texto plano — solo DENTRO de la ventana de servicio de 24 h que abre un
//     mensaje entrante. Es lo que se usa para responderle a alguien que acaba
//     de escribirnos.
//   `template`  — obligatorio para cualquier mensaje que iniciemos nosotros
//     fuera de esa ventana. Sin esto, un mensaje a un rescatista que llegó por
//     la web muere en un 131047 y nadie se entera de que no llegó.
//
// Igual que sendEmail, lee la configuración de process.env además del snapshot
// de env.js, para que aplicarla después de cargar el módulo (y las pruebas)
// funcione.
async function sendWhatsApp(to, text, { template } = {}) {
  const token = (process.env.WHATSAPP_TOKEN || env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = (
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    env.WHATSAPP_PHONE_NUMBER_ID ||
    ''
  ).trim();
  const apiBase = process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com';
  if (!token || !phoneNumberId) {
    console.log(`[notify:whatsapp skipped — not configured] to=${to}`);
    return { ok: false, error: 'WhatsApp no configurado' };
  }
  const payload = template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.locale || whatsappTemplateLocale() },
          components: (template.params || []).length
            ? [
                {
                  type: 'body',
                  parameters: (template.params || []).map((p) => ({ type: 'text', text: String(p) }))
                }
              ]
            : []
        }
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };

  // Devuelve el fallo en vez de lanzarlo, igual que sendEmail. Quien llama
  // decide qué hacer con un envío que no salió —y en el flujo de rescate esa
  // decisión es cargada: la fila del estado pendiente solo se escribe si la
  // pregunta salió de verdad. Una excepción que sube y la atrapa un catch
  // genérico convierte "no salió" en "no sé", que es peor.
  try {
    const res = await fetch(
      `${apiBase}/v20.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[notify:whatsapp] FALLÓ ${res.status} to=${to} tipo=${template ? `plantilla:${template.name}` : 'texto'} :: ${body}`
      );
      return { ok: false, status: res.status, error: body.slice(0, 500) };
    }
    // Antes de #116 (PR 4) esto era el hueco exacto que hacía invisible un
    // envío exitoso de WhatsApp: ni un console.log, y menos una fila en la
    // bitácora. sendEmail ya loggeaba su éxito; esto lo empareja.
    console.log(
      `[notify:whatsapp] sent to=${to} tipo=${template ? `plantilla:${template.name}` : 'texto'}`
    );
    return { ok: true, status: res.status };
  } catch (e) {
    console.error(
      `[notify:whatsapp] LANZÓ to=${to} tipo=${template ? `plantilla:${template.name}` : 'texto'}`,
      e
    );
    return { ok: false, error: e.message };
  }
}

function unsubscribeLink(sub) {
  return `${env.BASE_URL}/unsubscribe?token=${sub.verify_token}`;
}

// NO se releva, a propósito. Este correo va al dueño de la dirección que
// acaba de pedir el aviso, confirmando lo que esa misma persona pidió: no hay
// un tercero a quien proteger y no se entrega ningún dato de nadie más.
// Relevarlo no quitaría ningún riesgo y rompería el alta de suscripciones —
// sin doble opt-in nadie queda verificado y, en consecuencia, tampoco habría
// después ningún aviso que relevar.
async function sendVerificationEmail(person, sub) {
  const link = `${env.BASE_URL}/verify?token=${sub.verify_token}`;
  return sendEmail(
    sub.address,
    `Confirma tu suscripción a novedades de ${person.full_name} — encontrados.co`,
    [
      `Pediste recibir avisos cuando haya novedades de ${person.full_name} en encontrados.co.`,
      '',
      `Confirma tu correo abriendo este enlace: ${link}`,
      '',
      'Si no fuiste tú, ignora este mensaje y no recibirás nada.'
    ].join('\n')
  );
}

// Notify all VERIFIED subscribers of a person about a new update.
// skipAddress / skipAddresses: don't echo the update back to whoever reported
// it. Two forms because a WhatsApp reporter has exactly one address to skip
// (their own number), while a web report can carry a phone AND an email —
// either one might already be a subscriber's address.
// Every alert carries that subscriber's personal unsubscribe link.
//
// En modo relevo cada aviso se convierte en un correo al operador — uno por
// destinatario previsto, porque cada uno es una decisión distinta de a quién
// se le entrega qué.
async function notifySubscribers(store, person, update, { skipAddress, skipAddresses } = {}) {
  const skip = new Set([skipAddress, ...(skipAddresses || [])].filter(Boolean));
  const subs = await store.getSubscriptions(person.id);
  const baseText = `🔔 Actualización en encontrados.co:\n${updateText(person, update)}`;
  const subject = `Actualización sobre ${person.full_name} — encontrados.co`;
  const relay = relayEnabled();
  const jobs = subs
    .filter((s) => s.verified && !skip.has(s.address))
    .map(async (s) => {
      if (s.channel !== 'email' && s.channel !== 'whatsapp') return false;
      const text = `${baseText}\n\nPara dejar de recibir estos avisos: ${unsubscribeLink(s)}`;
      let res;
      if (relay) {
        res = await relayToOperators({
          reason: 'Actualización de estado para quien sigue a esta persona',
          channel: s.channel,
          address: s.address,
          subject,
          text,
          person
        });
      } else if (s.channel === 'email') {
        res = await sendEmail(s.address, subject, text);
      } else {
        res = await sendWhatsApp(s.address, text);
      }
      // Bitácora de envíos (#116, PR 4). El canal que queda es 'relevo' en
      // modo relevo, sin importar si el suscriptor original era email o
      // whatsapp — es lo que de verdad se intentó.
      await logContact(store, {
        personId: person.id,
        updateId: update.id,
        channel: relay ? 'relevo' : s.channel,
        result: resultFromSend(res)
      });
      return res;
    });
  const results = await Promise.allSettled(jobs);
  let sent = 0;
  for (const r of results) {
    if (r.status === 'rejected') console.error('[notify] failed:', r.reason);
    else if (r.value && r.value.ok) sent++;
  }
  console.log(
    `[notify] persona ${person.id} (modo ${notifyMode()}): ${subs.length} suscripción(es), ` +
      `${results.length} intento(s), ${sent} ${relay ? 'relevado(s)' : 'enviado(s)'}`
  );
  // `sent`, no `results.length`: el primero cuenta entregas reales (o relevos
  // exitosos al buzón), el segundo solo intentos. Quien reciba este número
  // (hoy nadie) espera "a cuántos les llegó", no "a cuántos se les intentó".
  return sent;
}

module.exports = {
  sendEmail,
  sendWhatsApp,
  sendVerificationEmail,
  notifySubscribers,
  updateText,
  STATUS_LABEL,
  notifyMode,
  relayEnabled,
  relayToOperators,
  mailOperators,
  logSafe,
  avisoEmail,
  rescueConfirmTemplate,
  rescueSourceTemplate,
  whatsappTemplateLocale,
  RELAY_SUBJECT_PREFIX
};
