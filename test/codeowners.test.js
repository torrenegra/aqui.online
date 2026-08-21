// Vigila que el freno de .github/CODEOWNERS no se caiga solo.
//
// El problema que resuelve: CODEOWNERS razona sobre RUTAS, y lo que de verdad
// queremos proteger son PIEZAS de código. Mientras la pieza no se mueva, las
// dos cosas coinciden. Pero el día que alguien renombra un archivo o saca una
// función a otro módulo, el patrón deja de coincidir, la pieza aterriza en el
// catch-all `*` — donde el agente puede aprobar solo — y NADIE SE ENTERA:
// GitHub no avisa cuando un patrón de CODEOWNERS dejó de matchear algo.
//
// Como `npm test` es check obligatorio de la regla de rama, esta prueba
// convierte ese silencio en un CI rojo. El freno deja de depender de que
// alguien se acuerde.
//
// Dos afirmaciones por pieza, y las dos hacen falta:
//   1. La pieza EXISTE. Si no la encontramos, la prueba falla en vez de pasar
//      por vacuidad — una prueba que vigila algo que ya no está no vigila nada.
//   2. Todos los archivos donde vive están en rutas restringidas.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const RUTA_CODEOWNERS = path.join(RAIZ, '.github', 'CODEOWNERS');

// La cuenta cuya aprobación NO alcanza en las rutas restringidas. Es un agente
// de IA y mantenedor del proyecto: aprueba lo rutinario, y en estas rutas la
// decisión pasa a una persona (ver CONTRIBUTING.md, "Qué entra con una
// revisión y qué espera a una persona").
const AGENTE = '@cris-pappcorn';

// ---------------------------------------------------------------------------
// Las piezas vigiladas.
//
// `define` tiene que matchear la DEFINICIÓN, no una mención cualquiera: hoy
// src/sources/colombiatebusca.js nombra a maskReporter en un comentario, y esa
// mención no debe contar como "la pieza vive acá".
// ---------------------------------------------------------------------------
const PIEZAS_VIGILADAS = [
  // --- Lo que revela el contacto de una familia -----------------------------
  {
    nombre: 'matchContactBlock',
    define: /function\s+matchContactBlock\s*\(/,
    porque: 'pinta en pantalla el contacto de una familia que está buscando a alguien',
  },
  // `relayToColombiaTeBusca` se vigilaba acá hasta que se retiró la casilla que
  // la alimentaba: ya no existe la pieza, así que no hay nada que vigilar.
  {
    nombre: 'relayToOperators',
    define: /function\s+relayToOperators\s*\(/,
    porque: 'arma el relevo a operadores, que es donde viaja el contacto en detalle',
  },
  {
    nombre: 'notifySubscribers',
    define: /function\s+notifySubscribers\s*\(/,
    porque: 'decide a quién se le escribe cuando aparece una novedad de una persona',
  },
  {
    nombre: 'resolveFicha',
    define: /function\s+resolveFicha\s*\(/,
    porque:
      'cierra una ficha en SIN CONFIRMAR como A SALVO o FALLECIDO(A): cambia lo que el ' +
      'listado público dice de alguien y manda el aviso a quien la está buscando',
  },

  // La superficie de mascotas tiene su propio bloque de contacto, en
  // src/routes/pets.js, y no reusa matchContactBlock: es otra pantalla y otro
  // dato. Pero es el MISMO tipo de dato —el teléfono o el correo de una
  // persona, mostrado a un desconocido— así que lleva el mismo freno. Se
  // vigila la interpolación, no el copy: si mañana cambia el texto pero el
  // contacto sigue saliendo a pantalla, esto tiene que seguir matcheando.
  {
    nombre: 'el contacto del dueño de una mascota',
    define: /esc\(pet\.contact\)/,
    porque: 'pinta en pantalla el teléfono o el correo de quien perdió una mascota, ante cualquiera que suba una foto parecida',
  },

  // --- El consentimiento y la promesa que se le hace a quien sube una foto ---
  {
    nombre: 'RESCUE_PRIVACY',
    define: /const\s+RESCUE_PRIVACY\s*=/,
    porque: 'es la promesa textual de que la foto no se guarda y solo queda su firma facial',
  },
  {
    nombre: 'searchOnlyCheckbox',
    define: /const\s+searchOnlyCheckbox\s*=/,
    porque: 'es la casilla con la que una persona consiente (o no) que su reporte se publique',
  },

  // El equivalente de RESCUE_PRIVACY del lado de mascotas. La diferencia es
  // dónde vive la promesa: en personas es el texto que se le muestra a quien
  // sube la foto, y acá es el borrado mismo, que el código dejó a propósito
  // FUERA del try que puede fallar (src/petmatch.js). Se vigila esa forma
  // —la condición y la llamada juntas— porque es lo que hace que la promesa
  // se cumpla aunque comparar falle; vigilar solo el nombre de la función
  // dejaría pasar que alguien la moviera adentro del try.
  {
    nombre: 'el borrado de la foto de «encontré» de una mascota',
    define: /kind\s*===\s*'query'\)\s*await\s+petStore\.clearPetPhotoContent\s*\(/,
    porque: 'es el borrado incondicional de la foto de quien encontró una mascota, la promesa de que de esa foto solo queda su embedding',
  },

  // --- El filtro de salida ---------------------------------------------------
  {
    nombre: 'maskReporter',
    define: /function\s+maskReporter\s*\(/,
    porque: 'es lo que impide que un teléfono o un correo salgan tal cual en una respuesta pública',
  },
  {
    nombre: 'looksLikeContact',
    define: /function\s+looksLikeContact\s*\(/,
    porque: 'es el detector de datos de contacto en texto libre del que depende el enmascarado',
  },
  {
    nombre: 'publicUpdate',
    define: /function\s+publicUpdate\s*\(/,
    porque: 'es el filtro por el que pasa toda fila de `updates` antes de salir al público',
  },

  // --- El esquema ------------------------------------------------------------
  {
    nombre: 'CREATE TABLE',
    define: /CREATE\s+TABLE/i,
    porque: 'es el esquema de la base, que se crea al arrancar y tiene que quedar igual en los dos motores',
  },

  // --- Biometría -------------------------------------------------------------
  {
    nombre: 'IndexFacesCommand',
    define: /new\s+IndexFacesCommand\s*\(/,
    porque: 'es donde se guarda la firma facial de una persona en Rekognition',
  },
  {
    nombre: 'SearchFacesCommand',
    define: /new\s+SearchFacesCommand\s*\(/,
    porque: 'es la comparación que decide si un rescatista tiene enfrente a la persona que alguien busca',
  },

  // Mascotas no usa Rekognition: usa un servicio de embeddings propio por
  // HTTP (src/petfaces.js), así que las dos piezas de arriba no la miran y por
  // eso esta superficie entró sin vigilancia. Que la cara no sea humana no la
  // saca de la categoría: sigue siendo una foto que sale de este proceso hacia
  // un tercero. Se vigila el punto exacto donde los bytes se adjuntan a la
  // petición, que es el análogo de construir el comando de Rekognition.
  {
    nombre: 'el envío de la foto de una mascota al servicio de embeddings',
    define: /form\.append\(\s*['"]image['"]/,
    porque: 'es donde la foto de una mascota sale de este proceso hacia un servicio externo, con un secreto compartido y sin más portero',
  },

  // --- Las puertas -----------------------------------------------------------
  {
    nombre: 'issueSessionCookie',
    define: /function\s+issueSessionCookie\s*\(/,
    porque: 'emite la sesión de /admin, donde se ven los datos sin enmascarar',
  },
  {
    nombre: 'isAllowedEmail',
    define: /function\s+isAllowedEmail\s*\(/,
    porque: 'decide quién puede entrar a /admin',
  },
  {
    nombre: 'requireRelaySecret',
    define: /function\s+requireRelaySecret\s*\(/,
    porque: 'es la única autenticación del webhook, que escribe datos sin sesión de usuario',
  },
];

// ---------------------------------------------------------------------------
// Lectura de CODEOWNERS
// ---------------------------------------------------------------------------

function leerReglas() {
  const texto = fs.readFileSync(RUTA_CODEOWNERS, 'utf8');
  const reglas = [];

  texto.split('\n').forEach((linea, i) => {
    const limpia = linea.replace(/#.*$/, '').trim();
    if (!limpia) return;
    const [patron, ...owners] = limpia.split(/\s+/);
    reglas.push({ patron, owners, numeroDeLinea: i + 1 });
  });

  return reglas;
}

// Traductor de patrón de CODEOWNERS a "¿matchea esta ruta?".
//
// Soporta a propósito solo las tres formas que el archivo usa hoy. Ante
// cualquier otra REVIENTA en vez de devolver `false`: un patrón que esta
// prueba no entiende y que se asume "no matchea" nos haría creer que una ruta
// quedó restringida cuando no lo está — el mismo silencio que existimos para
// evitar.
function matchea(patron, rutaRelativa, numeroDeLinea) {
  if (patron === '*') return true;

  if (patron.startsWith('/') && patron.endsWith('/')) {
    return rutaRelativa.startsWith(patron.slice(1));
  }

  if (patron.startsWith('/') && !patron.includes('*')) {
    return rutaRelativa === patron.slice(1);
  }

  throw new Error(
    `.github/CODEOWNERS línea ${numeroDeLinea}: el patrón «${patron}» usa una ` +
      'forma que test/codeowners.test.js no sabe evaluar.\n\n' +
      'Esta prueba solo entiende tres formas: `*`, `/carpeta/` y `/ruta/exacta.js`. ' +
      'Se niega a adivinar el resto, porque asumir "no matchea" haría que un ' +
      'archivo sin freno se reporte como protegido.\n\n' +
      'Para arreglarlo: reescribí el patrón en una de las tres formas ' +
      'soportadas, o enseñale la forma nueva a la función matchea() de este ' +
      'archivo — y agregale un caso de prueba que demuestre que la evalúa bien.',
  );
}

// Los owners efectivos de una ruta: GANA LA ÚLTIMA COINCIDENCIA, no la más
// específica. Es la regla de CODEOWNERS que más se malinterpreta.
function ownersEfectivos(reglas, rutaRelativa) {
  let owners = [];
  for (const regla of reglas) {
    if (matchea(regla.patron, rutaRelativa, regla.numeroDeLinea)) {
      owners = regla.owners;
    }
  }
  return owners;
}

// Restringida = el agente NO puede aprobarla solo.
function esRestringida(reglas, rutaRelativa) {
  const owners = ownersEfectivos(reglas, rutaRelativa);
  return owners.length > 0 && !owners.includes(AGENTE);
}

function archivosJsDeSrc(dir = path.join(RAIZ, 'src'), acumulado = []) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const completa = path.join(dir, entrada.name);
    if (entrada.isDirectory()) archivosJsDeSrc(completa, acumulado);
    else if (entrada.name.endsWith('.js')) acumulado.push(completa);
  }
  return acumulado;
}

function rutasRestringidasDeclaradas(reglas) {
  return reglas.filter((r) => r.patron !== '*' && !r.owners.includes(AGENTE)).map((r) => r.patron);
}

// ---------------------------------------------------------------------------
// Las pruebas
// ---------------------------------------------------------------------------

test('CODEOWNERS: el catch-all `*` va primero — si va último, se come todo lo demás', () => {
  const reglas = leerReglas();
  const posicion = reglas.findIndex((r) => r.patron === '*');

  assert.ok(posicion !== -1, 'Falta la regla `*` en .github/CODEOWNERS.\n\n' +
    'Sin ella, un archivo que no coincida con ningún otro patrón se queda SIN ' +
    'owners, y la regla de rama no le exige la revisión de un code owner. ' +
    'Agregá `*  @torrenegra @cris-pappcorn @ni500` como primera regla.');

  assert.equal(
    posicion,
    0,
    'La regla `*` está en la posición ' + posicion + ' de .github/CODEOWNERS, y tiene que ser la primera.\n\n' +
      'CODEOWNERS resuelve por ÚLTIMA COINCIDENCIA, no por el patrón más ' +
      'específico. Un `*` debajo de las rutas restringidas les devuelve el ' +
      'agente como owner a todas y desactiva el freno entero, sin que GitHub ' +
      'diga nada.\n\n' +
      'Para arreglarlo: mové la línea `*` arriba de todos los demás patrones.',
  );
});

test('CODEOWNERS: ninguna regla se queda sin owners', () => {
  const reglas = leerReglas();
  for (const regla of reglas) {
    assert.ok(
      regla.owners.length > 0,
      `.github/CODEOWNERS línea ${regla.numeroDeLinea}: el patrón «${regla.patron}» no tiene owners.\n\n` +
        'Una regla sin owners no restringe: QUITA el dueño que la ruta tenía por ' +
        'una regla anterior, y la deja sin nadie a quien pedirle revisión.\n\n' +
        'Para arreglarlo: ponele owners a la regla, o borrá la línea si sobra.',
    );
  }
});

test('CODEOWNERS se protege a sí mismo — el agente no puede aprobar el PR que le quita el freno', () => {
  const reglas = leerReglas();

  for (const ruta of ['.github/CODEOWNERS', '.github/workflows/ci.yml']) {
    assert.ok(
      esRestringida(reglas, ruta),
      `${ruta} NO es una ruta restringida en .github/CODEOWNERS.\n\n` +
        'Es la condición que sostiene todo lo demás. Si el agente es owner de ' +
        'CODEOWNERS, puede aprobar solo el PR que borra las rutas restringidas; ' +
        'si es owner de los workflows, puede aprobar solo el PR que apaga el ' +
        'check `npm test` — que es esta misma prueba.\n\n' +
        'Para arreglarlo: dejá `/.github/` con `@torrenegra @ni500` y sin ' +
        `${AGENTE}.`,
    );
  }
});

test('CODEOWNERS: lo rutinario sigue siendo rutinario — el freno no se comió el repo', () => {
  const reglas = leerReglas();

  // La contraparte de las pruebas de arriba. Un CODEOWNERS que restringe TODO
  // pasaría las otras pruebas y sería igual de malo: el corte es por
  // consecuencia, y la mayoría del repo no tiene consecuencia sobre nadie que
  // esté buscando a un familiar.
  for (const ruta of ['README.md', 'agent.md', 'public/styles.css', 'test/app.test.js', 'src/html.js']) {
    assert.ok(
      !esRestringida(reglas, ruta),
      `${ruta} quedó como ruta restringida en .github/CODEOWNERS, y no debería.\n\n` +
        'Documentación, estilos, pruebas y plantillas son lo rutinario: se ' +
        'mergean con la revisión de un solo mantenedor, para que un arreglo ' +
        'urgente en medio de una emergencia no espere a que coincidan dos husos ' +
        'horarios (CONTRIBUTING.md).\n\n' +
        'Si de verdad hace falta restringir esta ruta, es una decisión de una ' +
        'persona: quitala de esta lista en el mismo PR y explicá por qué.',
    );
  }
});

test('CODEOWNERS: las piezas sensibles siguen viviendo en rutas restringidas', () => {
  const reglas = leerReglas();
  const archivos = archivosJsDeSrc().map((abs) => ({
    ruta: path.relative(RAIZ, abs).split(path.sep).join('/'),
    contenido: fs.readFileSync(abs, 'utf8'),
  }));

  const restringidas = rutasRestringidasDeclaradas(reglas);

  for (const pieza of PIEZAS_VIGILADAS) {
    const dondeVive = archivos.filter((a) => pieza.define.test(a.contenido)).map((a) => a.ruta);

    // (1) La pieza existe. Si no, la prueba no vigila nada y hay que decirlo.
    assert.ok(
      dondeVive.length > 0,
      `No encontré «${pieza.nombre}» en ningún archivo de src/.\n\n` +
        `Esa pieza ${pieza.porque}, y por eso está vigilada acá.\n\n` +
        'Se renombró, se movió fuera de src/, o se borró. Esta prueba no puede ' +
        'vigilar lo que no encuentra: dejarla pasar en silencio es exactamente ' +
        'el modo de falla que existe para evitar.\n\n' +
        'Para arreglarlo, en test/codeowners.test.js:\n' +
        `  - si la pieza cambió de nombre o de forma, actualizá su patrón \`define\`;\n` +
        '  - si dejó de existir, borrá su entrada de PIEZAS_VIGILADAS.\n' +
        'En los dos casos, verificá antes que su ubicación nueva quedó ' +
        'restringida en .github/CODEOWNERS.',
    );

    // (2) Todos los archivos donde vive están restringidos.
    const sinFreno = dondeVive.filter((ruta) => !esRestringida(reglas, ruta));

    assert.deepEqual(
      sinFreno,
      [],
      `«${pieza.nombre}» ahora vive en ${sinFreno.join(', ')}, que NO es una ruta ` +
        'restringida en .github/CODEOWNERS.\n\n' +
        `Esa pieza ${pieza.porque}. Ahí donde está ahora, un PR que la modifique ` +
        'se puede aprobar sin que decida una persona, y el freno que describe ' +
        'CONTRIBUTING.md deja de existir para ella.\n\n' +
        'Para arreglarlo, elegí una:\n' +
        `  a) devolvé la pieza a una ruta ya restringida (${restringidas.join(', ')});\n` +
        `  b) agregá esa ruta nueva a .github/CODEOWNERS con \`@torrenegra @ni500\`\n` +
        `     y sin ${AGENTE}, en el bloque de comentarios que le corresponda;\n` +
        '  c) si la pieza dejó de ser sensible, quitala de PIEZAS_VIGILADAS —\n' +
        '     pero eso lo decide una persona, no es un ajuste de prueba.',
    );
  }
});
