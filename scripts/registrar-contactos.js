#!/usr/bin/env node
// Registra en encontrados.co los contactos que alguien del equipo hizo POR
// FUERA de la app — un correo desde su propio buzón, un WhatsApp desde su
// propio teléfono — para que la ficha de esa persona y el panel dejen de
// decir "nadie la ha contactado" cuando sí se la contactó.
//
// POR QUÉ ES UN SCRIPT Y NO UNA MIGRACIÓN
//
// Escribir "a esta persona se le avisó el 12 de agosto" es una AFIRMACIÓN
// SOBRE UN HECHO PASADO, no un cambio de estructura. Una migración corre sola
// cuando arranca la app y nadie la mira; esto tiene que correrlo una persona,
// mirando qué va a afirmar, con la evidencia enfrente. Por eso:
//
//   - No corre solo nunca. No lo llama el arranque, ni un cron, ni un deploy.
//   - En seco por omisión: sin `--commit` no manda una sola petición.
//   - Es reversible: `--undo` retira exactamente las mismas filas.
//   - Es idempotente: correrlo dos veces no duplica nada (cada contacto lleva
//     su propia referencia única, y el endpoint la reconoce).
//
// LA REGLA DE PRIVACIDAD, APLICADA ACÁ
//
// El archivo de entrada vive en la máquina de quien mandó los mensajes y tiene
// identificadores del proveedor. NADA de eso viaja: este script calcula el
// digesto SHA-256 localmente y manda solo el digesto. Es deliberado y no es
// opcional — un `wamid` de WhatsApp lleva el teléfono del destinatario
// codificado en base64 adentro, así que mandarlo crudo metería el número de
// una familia en la base de producción. El endpoint además rechaza cualquier
// cosa que no tenga forma de digesto, así que el accidente es imposible por
// los dos lados.
//
// FORMATO DE ENTRADA (JSONL — un objeto por línea):
//
//   {"person_id":123,"channel":"email","result":"enviado",
//    "occurred_at":"2026-08-11T15:04:05Z","message_id":"<abc@mail.ejemplo>"}
//
//   person_id   quién es la persona reportada en encontrados.co
//   channel     email | whatsapp
//   result      enviado | fallido
//   occurred_at fecha ISO 8601 del contacto REAL (no la de hoy)
//   message_id  el id del proveedor (Message-ID del correo, wamid de WhatsApp).
//               Es la evidencia de que el envío existió, y lo único que
//               distingue un contacto de otro. NO viaja: solo su digesto.
//
// USO:
//
//   node scripts/registrar-contactos.js contactos.jsonl                 # en seco
//   node scripts/registrar-contactos.js contactos.jsonl --commit        # registra
//   node scripts/registrar-contactos.js contactos.jsonl --commit --undo # retira
//
//   --base <url>   por omisión https://encontrados.co
//   API_KEY        en el entorno; sin ella el endpoint responde 401

const crypto = require('crypto');
const fs = require('fs');

const CHANNELS = ['email', 'whatsapp'];
const RESULTS = ['enviado', 'fallido'];

// Misma fórmula que documenta docs/contactos-fuera-de-la-app.md. El canal
// entra al digesto para que el mismo identificador en dos canales distintos no
// se pise, y para que el digesto no sea el hash pelado de un valor que pueda
// existir en otra parte.
function refFor(channel, messageId) {
  return crypto.createHash('sha256').update(`${channel}:${messageId}`).digest('hex');
}

function parseArgs(argv) {
  const opts = { file: null, commit: false, undo: false, base: 'https://encontrados.co' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') opts.commit = true;
    else if (a === '--undo') opts.undo = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (!a.startsWith('-') && !opts.file) opts.file = a;
  }
  return opts;
}

// Valida ANTES de mandar nada: un archivo con una línea mala se detiene entero
// en vez de dejar la mitad registrada. Es un registro de hechos, no una carga
// masiva — media carga sería peor que ninguna.
function readEntries(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const entries = [];
  const errors = [];
  lines.forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;
    const nth = `línea ${i + 1}`;
    // Los errores DE ESTA LÍNEA. Mirar el acumulado del archivo haría que una
    // línea mala en el medio se llevara por delante a las buenas que vienen
    // después: el lote se aborta igual (main sale con cualquier error), pero
    // el conteo que se imprime en seco mentiría sobre cuántas hay.
    const propios = [];
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      errors.push(`${nth}: no es JSON válido`);
      return;
    }
    // `JSON.parse('null')` no lanza: devuelve null, y leerle un campo tumba el
    // script con un TypeError en vez de con el error de archivo que este
    // validador existe para dar.
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      errors.push(`${nth}: debe ser un objeto JSON`);
      return;
    }
    // Number(null) y Number('') son 0, y 0 es un entero: sin este chequeo una
    // persona sin id pasaría la validación y saldría a la ruta como persona 0.
    if (obj.person_id === null || obj.person_id === undefined || obj.person_id === '') {
      propios.push(`${nth}: falta person_id`);
    } else if (!Number.isInteger(Number(obj.person_id))) {
      propios.push(`${nth}: person_id debe ser un entero`);
    }
    if (!CHANNELS.includes(obj.channel)) propios.push(`${nth}: channel debe ser ${CHANNELS.join(' o ')}`);
    if (!RESULTS.includes(obj.result)) propios.push(`${nth}: result debe ser ${RESULTS.join(' o ')}`);
    if (!obj.occurred_at || Number.isNaN(new Date(obj.occurred_at).getTime())) {
      propios.push(`${nth}: occurred_at debe ser una fecha ISO 8601`);
    }
    if (!obj.message_id || typeof obj.message_id !== 'string') {
      propios.push(`${nth}: falta message_id (la evidencia del envío)`);
    }
    if (propios.length) {
      errors.push(...propios);
      return;
    }
    entries.push({
      person_id: Number(obj.person_id),
      channel: obj.channel,
      result: obj.result,
      occurred_at: new Date(obj.occurred_at).toISOString(),
      ref: refFor(obj.channel, obj.message_id)
    });
  });
  return { entries, errors };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    console.error('Uso: node scripts/registrar-contactos.js <archivo.jsonl> [--commit] [--undo] [--base <url>]');
    process.exit(2);
  }
  const { entries, errors } = readEntries(opts.file);
  if (errors.length) {
    console.error('El archivo tiene errores y no se registró nada:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const accion = opts.undo ? 'RETIRAR' : 'REGISTRAR';
  console.log(`${accion} ${entries.length} contacto(s) en ${opts.base}`);
  // El message_id NO se imprime: el digesto alcanza para rastrear una fila y
  // no arrastra el identificador del proveedor a la salida de una terminal.
  for (const e of entries) {
    console.log(
      `  persona ${e.person_id} · ${e.channel} · ${e.result} · ${e.occurred_at} · ref ${e.ref.slice(0, 12)}…`
    );
  }

  if (!opts.commit) {
    console.log('\nEn seco: no se mandó ninguna petición. Agrega --commit para hacerlo de verdad.');
    return;
  }

  const key = process.env.API_KEY;
  if (!key) {
    console.error('\nFalta API_KEY en el entorno.');
    process.exit(1);
  }

  let nuevos = 0;
  let repetidos = 0;
  let fallidos = 0;
  for (const e of entries) {
    const url = opts.undo
      ? `${opts.base}/api/contact-log/${e.ref}`
      : `${opts.base}/api/contact-log`;
    const init = opts.undo
      ? { method: 'DELETE', headers: { authorization: `Bearer ${key}` } }
      : {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            person_id: e.person_id,
            channel: e.channel,
            result: e.result,
            occurred_at: e.occurred_at,
            ref: e.ref
          })
        };
    try {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fallidos++;
        console.error(`  ✗ persona ${e.person_id}: ${res.status} ${body.error || ''}`);
      } else if (opts.undo) {
        if (body.deleted) nuevos++;
        else repetidos++;
      } else if (body.created) {
        nuevos++;
      } else {
        repetidos++;
      }
    } catch (err) {
      fallidos++;
      console.error(`  ✗ persona ${e.person_id}: ${err.message}`);
    }
  }

  const verbo = opts.undo ? 'retirados' : 'registrados';
  const yaEstaba = opts.undo ? 'no estaban registrados' : 'ya estaban registrados';
  console.log(`\n${nuevos} ${verbo} · ${repetidos} ${yaEstaba} · ${fallidos} con error`);
  if (fallidos) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { refFor, readEntries };
