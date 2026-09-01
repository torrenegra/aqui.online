// scripts/api-key.js — quién emite una llave.
//
// Estas pruebas corren el CLI DE VERDAD, como subproceso, y no la función por
// dentro. Es a propósito: lo que se está protegiendo es un contrato con una
// persona en una terminal —qué se rechaza, con qué mensaje y con qué código de
// salida—, y eso no se ve llamando a la función suelta.
//
// La regla que protegen: --emisor no acepta lo que alguien teclee. Solo un
// correo que YA está en ADMIN_EMAILS, o sea una cuenta de operación. Eso da la
// identidad de quien emitió —lo que después permite "cada quien revoca las
// suyas"— sin abrir una puerta por la que entre el dato personal de un
// voluntario.
//
// Todos los correos y alias de este archivo son sintéticos: no son de nadie.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const CLI = path.join(__dirname, '..', 'scripts', 'api-key.js');
const ADMINS = 'admin-uno@ejemplo-de-prueba.co, Admin-Dos@Ejemplo-De-Prueba.co';

function baseDeDatosTemporal(t) {
  const dbPath = path.join(
    os.tmpdir(),
    `encontrados-api-key-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  t.after(() => {
    for (const suf of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suf}`, { force: true });
  });
  return dbPath;
}

// El entorno del hijo se arma a mano y NO se hereda tal cual: si la terminal de
// quien corre las pruebas tiene una cadena de conexión, el CLI se iría contra
// esa base. Una prueba que le escriba a una base de verdad es peor que una
// prueba que falle.
function correr(dbPath, args, { adminEmails = ADMINS } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/(DATABASE|POSTGRES|STORAGE|NEON)/i.test(k)) continue;
    env[k] = v;
  }
  env.DB_PATH = dbPath;
  env.ADMIN_EMAILS = adminEmails;
  try {
    return {
      ok: true,
      salida: execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
    };
  } catch (e) {
    return { ok: false, codigo: e.status, salida: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function filas(dbPath) {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return raw.prepare('SELECT id, label, scope, created_by FROM api_keys ORDER BY id').all();
  } finally {
    raw.close();
  }
}

test('emitir sin --emisor se rechaza: la llave no se emite sin saber quién la emitió', (t) => {
  const db = baseDeDatosTemporal(t);
  const r = correr(db, ['emitir', '--alias', 'voluntario-de-prueba', '--alcance', 'ingest']);
  assert.equal(r.ok, false, 'emitir sin --emisor tenía que fallar');
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /--emisor/);
  assert.equal(filas(db).length, 0, 'no debía quedar ninguna llave emitida');
});

test('un correo fuera de ADMIN_EMAILS se rechaza — ahí es donde entraría el dato de un voluntario', (t) => {
  const db = baseDeDatosTemporal(t);
  const r = correr(db, [
    'emitir',
    '--alias',
    'voluntario-de-prueba',
    '--alcance',
    'ingest',
    '--emisor',
    'alguien-de-afuera@ejemplo-de-prueba.co'
  ]);
  assert.equal(r.ok, false, 'un correo fuera de la allowlist tenía que fallar');
  assert.match(r.salida, /ADMIN_EMAILS/);
  assert.equal(filas(db).length, 0, 'no debía quedar ninguna llave emitida');
});

// El borde que importa: sin allowlist configurada isAllowedEmail devuelve false
// para TODO (cerrado por defecto), así que los dos casos se ven iguales desde
// adentro. Afuera no lo son: uno lo arregla otra persona agregándote a la
// allowlist, el otro lo arregla configurando la variable en esta terminal. Si
// el mensaje no los distingue, se pierde el tiempo buscando del lado equivocado.
test('sin ADMIN_EMAILS el error dice que falta la allowlist, no que el correo no está en ella', (t) => {
  const db = baseDeDatosTemporal(t);
  const r = correr(
    db,
    [
      'emitir',
      '--alias',
      'voluntario-de-prueba',
      '--alcance',
      'ingest',
      '--emisor',
      'admin-uno@ejemplo-de-prueba.co'
    ],
    { adminEmails: '' }
  );
  assert.equal(r.ok, false, 'sin allowlist no se puede emitir');
  assert.match(
    r.salida,
    /no tiene ADMIN_EMAILS configurada/,
    'el mensaje tiene que señalar que falta configurar la allowlist en este entorno'
  );
  assert.doesNotMatch(
    r.salida,
    /no está en la ADMIN_EMAILS/,
    'ese es el OTRO error, y lleva a buscar del lado equivocado'
  );
  assert.equal(filas(db).length, 0);
});

test('un correo de ADMIN_EMAILS se guarda en created_by, normalizado', (t) => {
  const db = baseDeDatosTemporal(t);
  const r = correr(db, [
    'emitir',
    '--alias',
    'voluntario-de-prueba',
    '--alcance',
    'ingest',
    // Con mayúsculas a propósito: se compara y se guarda normalizado, para que
    // el día que el panel pregunte "¿esta llave es tuya?" la respuesta no
    // dependa de cómo se tecleó el correo.
    '--emisor',
    '  Admin-Dos@Ejemplo-De-Prueba.co '
  ]);
  assert.equal(r.ok, true, r.salida);
  const guardadas = filas(db);
  assert.equal(guardadas.length, 1);
  assert.equal(guardadas[0].created_by, 'admin-dos@ejemplo-de-prueba.co');
});

test('listar muestra el emisor — sin eso la columna no sirve para revocar después', (t) => {
  const db = baseDeDatosTemporal(t);
  const emitida = correr(db, [
    'emitir',
    '--alias',
    'voluntario-de-prueba',
    '--alcance',
    'ingest',
    '--emisor',
    'admin-uno@ejemplo-de-prueba.co'
  ]);
  assert.equal(emitida.ok, true, emitida.salida);

  const listado = correr(db, ['listar']);
  assert.equal(listado.ok, true, listado.salida);
  assert.match(listado.salida, /admin-uno@ejemplo-de-prueba\.co/);
  assert.match(listado.salida, /voluntario-de-prueba/);

  // Y la llave en claro NO puede aparecer en un listado: de ella solo se guarda
  // el hash y el prefijo.
  const enClaro = emitida.salida.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
  assert.ok(enClaro, 'la emisión debería imprimir la llave en claro una vez');
  assert.ok(!listado.salida.includes(enClaro), 'listar nunca puede mostrar la llave en claro');
});
