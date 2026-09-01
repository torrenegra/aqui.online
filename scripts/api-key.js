#!/usr/bin/env node
// Emite, lista y revoca llaves de API — `npm run api-key`.
//
// POR QUÉ ES UN SCRIPT Y NO UNA PANTALLA: el panel en /admin es el siguiente
// paso, y va aparte a propósito. Una tanda que agregara "llaves por persona"
// SIN el alcance acotado que trae este mismo PR sería peor que no hacer nada,
// porque permitiría emitir con dos clics una llave de poder total. Primero el
// alcance, después la comodidad de emitirla.
//
// LA LLAVE SE MUESTRA UNA SOLA VEZ. De ella solo se guarda su SHA-256 y un
// prefijo de 8 caracteres; no hay forma de recuperarla. Perdida se revoca y se
// emite otra.
//
// Uso:
//   npm run api-key -- listar
//   npm run api-key -- emitir --alias "voluntario-1" --alcance ingest --emisor <correo>
//   npm run api-key -- revocar --id 3
//
// Contra qué base corre: la misma que el servidor (src/store/index.js) — SQLite
// en local, Postgres si hay DATABASE_URL / POSTGRES_URL en el entorno. Emitir
// una llave de producción es una operación de producción: se corre con la
// cadena de conexión de producción a la vista y por alguien que puede hacerlo.
const { createAdapter } = require('../src/store');
const { createStore } = require('../src/people');
const {
  generateApiKey,
  hashApiKey,
  apiKeyPrefix,
  API_SCOPES,
  INGEST_STATUSES,
  INGEST_WRITES_PER_HOUR
} = require('../src/routes/api');
const { isAllowedEmail, adminEmails } = require('../src/adminAuth');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

const USO = `
Uso:
  npm run api-key -- listar
  npm run api-key -- emitir --alias <alias> --alcance ${API_SCOPES.join('|')} --emisor <correo>
  npm run api-key -- revocar --id <id>

Sobre --alias: es un ALIAS PÚBLICO, no el nombre legal ni el correo de nadie.
Alcanza para saber a quién revocarle; guardar más convertiría la tabla en un
registro de datos personales de voluntarios (Ley 1581).

Sobre --emisor: es una CUENTA DE OPERACIÓN, no una persona escrita a mano. El
único valor que se acepta es un correo que YA está en ADMIN_EMAILS — la misma
allowlist que abre /admin—, así que por esta bandera no puede entrar el dato
personal de un voluntario: los valores posibles son ese puñado de cuentas y
ninguno más. Hubo antes una bandera --por de texto libre y se quitó justo por
eso; esta no es la misma con otro nombre.
`.trim();

// Quién emite la llave. Devuelve el correo normalizado, o lanza.
//
// La regla entera está en qué VALORES acepta: solo un correo que ya vive en
// ADMIN_EMAILS, o sea una de las pocas cuentas que administran esta
// instalación. Eso da la identidad del emisor y al mismo tiempo hace imposible
// guardar acá el dato personal de un voluntario, porque el conjunto de valores
// posibles es la allowlist y nada más. La bandera anterior (--por) aceptaba
// texto libre y por eso se quitó; la diferencia no es el nombre de la bandera,
// es que ahora esto es una REFERENCIA A UNA CUENTA y no algo que alguien teclea.
//
// Para qué hace falta: la emisión se delega a personas de confianza, y una
// llave emitida tiene que poder revocarla quien la emitió, además de los
// administradores. Sin este dato esa regla no se puede escribir.
function normalizarEmisor(valor) {
  const crudo = String(valor ?? '').trim();
  if (!crudo) {
    throw new Error(
      'Falta --emisor <correo>: la cuenta de operación que emite esta llave.\n' +
        'Tiene que ser uno de los correos de ADMIN_EMAILS — no un nombre, y no el correo\n' +
        'de quien va a USAR la llave (para eso está --alias, que es público).'
    );
  }
  // Los dos errores de abajo se separan a propósito: llevan a acciones
  // distintas. "No estás en la allowlist" lo arregla otra persona agregándote;
  // "no hay allowlist en este entorno" es un problema de configuración de la
  // terminal desde la que estás corriendo esto, y confundirlos hace perder el
  // tiempo buscando en el lado equivocado.
  const configuradas = adminEmails();
  if (!configuradas.length) {
    throw new Error(
      'Este entorno no tiene ADMIN_EMAILS configurada, así que no hay ninguna cuenta de\n' +
        'operación contra la cual validar --emisor. Una allowlist vacía cierra para todos,\n' +
        'nunca abre, así que ningún correo va a pasar hasta que la configures.\n' +
        'Configurá ADMIN_EMAILS acá donde estás corriendo el comando — es la MISMA variable\n' +
        'que usa /admin, y tenerla en Vercel no la pone en tu terminal.'
    );
  }
  if (!isAllowedEmail(crudo)) {
    const n = configuradas.length;
    throw new Error(
      `El correo "${crudo}" no está en la ADMIN_EMAILS de este entorno (hay ${n} cuenta` +
        `${n === 1 ? '' : 's'} configurada${n === 1 ? '' : 's'}).\n` +
        'Solo una cuenta de operación puede figurar como emisora: eso es justamente lo que\n' +
        'impide que en esta columna termine el dato personal de un voluntario. Si esa cuenta\n' +
        'debería poder emitir llaves, agregala a ADMIN_EMAILS primero.'
    );
  }
  // Se guarda normalizado, igual que compara isAllowedEmail: el día que el
  // panel pregunte "¿esta llave es tuya?" va a comparar contra la sesión, y dos
  // formas del mismo correo harían que la respuesta dependa de cómo se tecleó.
  return crudo.toLowerCase();
}

// Lo que hay que decirle a quien recibe una llave de ingesta. No es adorno: la
// decisión de permitir foto se tomó porque sin foto la ficha no sirve para el
// cruce facial, que es el corazón del producto — y esa decisión SOLO se sostiene
// si quien usa la llave sabe que la foto tiene que venir de una fuente pública.
const ONBOARDING_INGEST = `
Qué puede hacer esta llave:
  - POST /api/updates, y nada más. No borra, no suscribe, no reindexa, no manda
    correo, no lee cifras de operación.
  - Puede AFIRMAR solo los estados ${INGEST_STATUSES.join(' y ')}.
  - Si manda "safe", "deceased" o "injured", la ficha entra igual pero queda en
    "unknown", para que la revise una persona, y la respuesta lo dice. NUNCA se
    convierte en "missing": eso publicaría como desaparecida a alguien que ya
    apareció. Lo que se pierde no es el hallazgo, es la afirmación.
  - Agregar fichas nuevas y corregir LAS SUYAS. No puede sobreescribir una ficha
    que no creó.
  - Hasta ${INGEST_WRITES_PER_HOUR} escrituras por hora.
  - Ninguna escritura suya le manda un aviso a nadie.

Qué tiene que saber quien la use:
  - LA FOTO SOLO PUEDE VENIR DE UNA FUENTE PÚBLICA. Se usa únicamente para el
    cruce facial, nunca se muestra; pero subir la foto de una persona desde una
    fuente privada convierte un aporte en una filtración de datos biométricos.
  - Solo información pública. Ningún dato de una fuente privada entra por acá.
  - La llave es personal y no se comparte. Si se filtra, se revoca y se emite
    otra: no hay forma de recuperar la que se perdió.
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const comando = args._[0];

  if (!comando || comando === 'ayuda' || args.help) {
    console.log(USO);
    return;
  }

  const store = createStore(await createAdapter());
  try {
    if (comando === 'listar') {
      const filas = await store.apiKeysList();
      if (!filas.length) {
        console.log('No hay ninguna llave emitida. La variable de entorno API_KEY sigue funcionando aparte.');
        return;
      }
      for (const f of filas) {
        const estado = f.revoked_at ? `REVOCADA (${f.revoked_at})` : 'activa';
        console.log(
          `#${f.id}  ${f.scope.padEnd(8)}  ${f.key_prefix}…  ${estado.padEnd(34)}  ` +
            `último uso: ${f.last_used_at || 'nunca'}  emisor: ${f.created_by || 'sin registrar'}  ` +
            `alias: ${f.label}`
        );
      }
      return;
    }

    if (comando === 'emitir') {
      const alias = (args.alias || '').trim();
      const alcance = (args.alcance || '').trim();
      if (!alias) throw new Error('Falta --alias (un alias público, no un nombre legal ni un correo).');
      if (!API_SCOPES.includes(alcance)) {
        throw new Error(`--alcance debe ser uno de: ${API_SCOPES.join(', ')}.`);
      }
      const emisor = normalizarEmisor(args.emisor);
      if (/@|\+\d{7}/.test(alias)) {
        throw new Error(
          'El alias parece un correo o un teléfono. Es un alias PÚBLICO: usá algo como "voluntario-1".'
        );
      }
      const llave = generateApiKey();
      const fila = await store.insertApiKey({
        label: alias,
        keyHash: hashApiKey(llave),
        keyPrefix: apiKeyPrefix(llave),
        scope: alcance,
        createdBy: emisor
      });
      console.log(
        `\nLlave #${fila.id} emitida, alcance "${alcance}", alias "${alias}", emisor ${emisor}.`
      );
      console.log('\n  ' + llave + '\n');
      console.log('Esto es lo único que se muestra una vez. De ella solo queda guardado su');
      console.log('SHA-256 y el prefijo ' + fila.key_prefix + '. Entregala por un canal que no la deje escrita.');
      console.log('\nSe usa así:\n  Authorization: Bearer <la llave de arriba>');
      if (alcance === 'ingest') console.log('\n' + ONBOARDING_INGEST);
      else {
        console.log(
          '\nOJO: una llave de alcance "operator" abre todas las rutas con llave del API\n' +
            '(suscripciones, reindex, cifras de operación, correo de prueba, bitácora de\n' +
            'contactos externos), SALVO dos que verifican API_KEY directamente y que ninguna\n' +
            'llave emitida puede usar: DELETE /api/people/:id —irreversible, se lleva las\n' +
            'firmas faciales— y ALL /api/report/send.'
        );
      }
      return;
    }

    if (comando === 'revocar') {
      // Se valida el TEXTO completo y no con parseInt: parseInt('3loquesea')
      // devuelve 3, así que un --id con dedazo revocaba la llave #3 en vez de
      // fallar. Revocar es una acción sobre una llave concreta y no se hace por
      // aproximación.
      const idCrudo = String(args.id ?? '').trim();
      if (!/^[1-9]\d*$/.test(idCrudo)) {
        throw new Error('Falta --id, o no es un entero positivo (mirá `npm run api-key -- listar`).');
      }
      const id = Number(idCrudo);
      if (!Number.isSafeInteger(id)) throw new Error(`El --id ${idCrudo} no es un entero representable.`);
      const fila = await store.revokeApiKey(id, new Date().toISOString());
      if (!fila) {
        console.log(`La llave #${id} no existe o ya estaba revocada. La fila NUNCA se borra, a propósito:`);
        console.log('sin ella se pierde el rastro de qué escribió esa llave, que es justo lo que hace falta');
        console.log('para limpiar después de revocarla.');
        return;
      }
      console.log(`Llave #${fila.id} (${fila.scope}, alias "${fila.label}") revocada a las ${fila.revoked_at}.`);
      console.log('Surte efecto en el request siguiente: la verificación no tiene caché.');
      return;
    }

    throw new Error(`Comando desconocido: ${comando}\n\n${USO}`);
  } finally {
    await store.close();
  }
}

main().catch((e) => {
  console.error('\n' + e.message + '\n');
  process.exit(1);
});
