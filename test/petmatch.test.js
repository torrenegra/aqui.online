const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createPetStore } = require('../src/pets');

// Vectores ya normalizados a propósito: la similitud coseno entre dos
// vectores idénticos es 1 (100%), y entre estos dos "distintos" cae bajo
// cualquier umbral razonable — no hace falta un modelo real para probar la
// lógica de comparación.
const VECTOR_A = [1, 0, 0];
const VECTOR_B = [0, 1, 0];

// Fotos reales, chiquitas, para que `toMatchable` (dentro de processPetPhoto)
// las acepte de verdad: un Buffer.from('texto') no es una imagen, sharp no lo
// puede decodificar, y la foto queda marcada `unreadable` sin llegar nunca a
// compararse. Mismo patrón que ya usa test/rescue.test.js — un JPEG real de
// color plano, determinístico a partir de la etiqueta, cacheado. 100x100
// alcanza acá: a diferencia de las pruebas de personas, mascotas no necesita
// geometría de recorte de cara.
const jpegCache = new Map();
async function photoBytes(label) {
  if (!jpegCache.has(label)) {
    let h = 0;
    for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 16777216;
    jpegCache.set(
      label,
      await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 }
        }
      })
        .jpeg()
        .toBuffer()
    );
  }
  return jpegCache.get(label);
}

// El matcher de mentira sigue leyendo la clave con bytes.toString('utf8') —
// eso no cambia. Lo que cambia es CON QUÉ se construye el diccionario en cada
// prueba: ya no es el literal 'toby', sino la representación utf8 de los
// bytes reales que da `photoBytes('toby')`. Esos bytes le llegan intactos a
// embed() porque toMatchable no los toca cuando ya son un JPEG chico y
// derecho (ver el "fast path" en src/photo.js), así que la clave calza.
function fakePetMatcherFor(vectors) {
  let calls = 0;
  return {
    enabled: true,
    status: 'fake',
    async embed(bytes) {
      calls++;
      const key = bytes.toString('utf8');
      return vectors[key] ? { embedding: vectors[key], model: 'fake-model' } : null;
    },
    get calls() {
      return calls;
    }
  };
}

async function setup() {
  const adapter = await createSqliteAdapter(':memory:');
  const petStore = createPetStore(adapter);
  return { petStore };
}

test('una foto de reporte sin coincidencias previas se guarda y no arma ningún match', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const toby = await photoBytes('toby');
  const matcher = fakePetMatcherFor({ [toby.toString('utf8')]: VECTOR_A });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Toby', description: null, contact: '300 111 2222' });
  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    petId: pet.id,
    kind: 'report',
    species: 'dog',
    bytes: toby,
    contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 0);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.deepEqual(stored.embedding, VECTOR_A);
  assert.ok(stored.content.length > 0, 'una foto de REPORTE sí conserva sus bytes');
});

test('una foto "encontré" que coincide con un reporte muestra el contacto de quien lo puso, y no guarda sus bytes', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const toby = await photoBytes('toby');
  const encontrado = await photoBytes('encontrado');
  const matcher = fakePetMatcherFor({
    [toby.toString('utf8')]: VECTOR_A,
    [encontrado.toString('utf8')]: VECTOR_A
  });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Toby', description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: toby, contentType: 'image/jpeg'
  });

  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'dog', bytes: encontrado, contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].pet_id, pet.id);
  assert.ok(matches[0].similarity > 90);

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(stored.content.length, 0, 'la foto de quien encontró a la mascota nunca se conserva');
});

test('no cruza especies: un perro parecido no aparece al buscar un gato', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const perro = await photoBytes('perro');
  const buscando = await photoBytes('buscando');
  const matcher = fakePetMatcherFor({
    [perro.toString('utf8')]: VECTOR_A,
    [buscando.toString('utf8')]: VECTOR_A
  });

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perro, contentType: 'image/jpeg'
  });

  const { matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'cat', bytes: buscando, contentType: 'image/jpeg'
  });
  assert.equal(matches.length, 0, 'especies distintas nunca deben coincidir');
});

test('sin PET_MATCH_API_URL (matcher deshabilitado), la foto se guarda igual y sin comparar', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');
  delete process.env.PET_MATCH_API_URL;
  const matcher = createPetMatcher();

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  const perro = await photoBytes('perro');
  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perro, contentType: 'image/jpeg'
  });
  assert.equal(matches.length, 0);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(stored.embedding, null, 'sin servicio, no hay embedding que guardar');
  assert.ok(stored.content.length > 0, 'la foto se guarda de todos modos');
});

test('backfillUnindexedPetPhotos recoge lo que quedó sin embedding y lo compara', async () => {
  const { petStore } = await setup();
  const { processPetPhoto, backfillUnindexedPetPhotos } = require('../src/petmatch');
  delete process.env.PET_MATCH_API_URL;
  const { createPetMatcher } = require('../src/petfaces');
  const offlineMatcher = createPetMatcher();

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  const perro = await photoBytes('perro');
  await processPetPhoto(petStore, offlineMatcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perro, contentType: 'image/jpeg'
  });

  const onlineMatcher = fakePetMatcherFor({ [perro.toString('utf8')]: VECTOR_A });
  const result = await backfillUnindexedPetPhotos(petStore, onlineMatcher, 100);
  assert.equal(result.processed, 1);

  const stored = (await petStore.petPhotosForMatching('report', 'dog'))[0];
  assert.deepEqual(stored.embedding, VECTOR_A);
});

test('un error de base al comparar no revienta processPetPhoto ni deja sin borrar los bytes de una foto "encontré"', async () => {
  const { petStore } = await setup();
  // Envoltura de mentira: todo lo demás pasa por el petStore real, pero
  // petPhotosForMatching (la lectura que matchPetPhoto hace para comparar)
  // revienta — como lo haría un error transitorio de base en un despliegue
  // serverless. embed() ya tuvo éxito para cuando esto pasa; lo que se prueba
  // es que ese fallo, DESPUÉS de embed(), no se escapa de processPetPhoto ni
  // le impide borrar los bytes de una foto 'query' (garantía de privacidad,
  // no cosmética).
  const flakyStore = {
    ...petStore,
    async petPhotosForMatching() {
      throw new Error('conexión a la base perdida (de mentira, para la prueba)');
    }
  };
  const { processPetPhoto } = require('../src/petmatch');
  const buscando = await photoBytes('buscando');
  const matcher = fakePetMatcherFor({ [buscando.toString('utf8')]: VECTOR_A });

  const { photo, matches } = await processPetPhoto(flakyStore, matcher, {
    kind: 'query',
    species: 'dog',
    bytes: buscando,
    contentType: 'image/jpeg'
  });

  assert.deepEqual(matches, [], 'un fallo al comparar se degrada a "sin coincidencias", no revienta');

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'los bytes de una foto "encontré" se borran igual, aunque falle la comparación'
  );
});

test('con matcher deshabilitado, una foto "encontré" borra sus bytes aunque no se haya comparado', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');
  delete process.env.PET_MATCH_API_URL;
  const matcher = createPetMatcher();

  const encontrado = await photoBytes('encontrado');
  const { photo } = await processPetPhoto(petStore, matcher, {
    kind: 'query',
    species: 'dog',
    bytes: encontrado,
    contentType: 'image/jpeg'
  });

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'una foto "encontré" borra sus bytes incluso cuando el matcher está deshabilitado'
  );
});

test('cuando embed() devuelve null para una foto "encontré", se borran sus bytes igual', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const encontrado = await photoBytes('encontrado');

  // Un matcher que devuelve null (falla) para cualquier foto
  const failingMatcher = {
    enabled: true,
    status: 'fake',
    async embed(bytes) {
      return null;
    }
  };

  const { photo } = await processPetPhoto(petStore, failingMatcher, {
    kind: 'query',
    species: 'dog',
    bytes: encontrado,
    contentType: 'image/jpeg'
  });

  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'una foto "encontré" borra sus bytes cuando embed() falla (devuelve null)'
  );
});

test('una foto "encontré" ilegible también borra su contenido (nunca queda guardada)', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  // toMatchable rechaza esto de plano: no es una imagen decodificable.
  const basura = Buffer.from('esto no es una imagen');
  const matcher = fakePetMatcherFor({});

  const { photo, matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query',
    species: 'dog',
    bytes: basura,
    contentType: 'image/jpeg'
  });

  assert.equal(photo.unreadable, true);
  assert.deepEqual(matches, []);
  const stored = await petStore.getPetPhoto(photo.id);
  assert.equal(
    stored.content.length,
    0,
    'una foto "encontré" ilegible debe perder sus bytes igual que cualquier otra foto "encontré"'
  );
});

test('una mascota ya marcada como encontrada no vuelve a aparecer en nuevas coincidencias', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const perdido = await photoBytes('perdido-resuelto');
  const encontrado = await photoBytes('encontrado-resuelto');
  const matcher = fakePetMatcherFor({
    [perdido.toString('utf8')]: VECTOR_A,
    [encontrado.toString('utf8')]: VECTOR_A
  });

  const pet = await petStore.addPet({ species: 'dog', petName: 'Firulais', description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcher, {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perdido, contentType: 'image/jpeg'
  });

  await petStore.markPetResolved(pet.id);

  const { matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'dog', bytes: encontrado, contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 0, 'una mascota ya resuelta no debe salir como posible coincidencia');
});

// Cicatriz: matchPetPhoto comparaba cualquier par de embeddings con similitud
// coseno sin mirar qué modelo los generó. Dos modelos distintos viven en
// espacios vectoriales distintos — un número "alto" de similitud entre ellos
// no significa nada, y antes SÍ producía una coincidencia si los vectores
// (de mentira, en la prueba) resultaban parecidos por casualidad.
test('dos fotos con vectores idénticos NO coinciden si vienen de modelos distintos', async () => {
  const { petStore } = await setup();
  const { processPetPhoto } = require('../src/petmatch');
  const perdido = await photoBytes('modelo-viejo');
  const buscando = await photoBytes('modelo-nuevo');

  function matcherFor(model) {
    return {
      enabled: true,
      status: 'fake',
      async embed() {
        return { embedding: VECTOR_A, model };
      }
    };
  }

  const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 111 2222' });
  await processPetPhoto(petStore, matcherFor('modelo-viejo'), {
    petId: pet.id, kind: 'report', species: 'dog', bytes: perdido, contentType: 'image/jpeg'
  });

  const { matches } = await processPetPhoto(petStore, matcherFor('modelo-nuevo'), {
    kind: 'query', species: 'dog', bytes: buscando, contentType: 'image/jpeg'
  });

  assert.equal(matches.length, 0, 'vectores idénticos de modelos distintos no deben coincidir');
});

test('nunca más de MAX_PET_MATCHES coincidencias, y siempre ordenadas de mayor a menor similitud', async () => {
  const { petStore } = await setup();
  const { processPetPhoto, MAX_PET_MATCHES } = require('../src/petmatch');

  // Vectores [1, y, 0] con y creciente: contra una consulta [1, 0, 0], la
  // similitud coseno cae monótonamente al crecer y, así que este orden de
  // creación es también el orden esperado de mayor a menor similitud.
  // sim(y) = 1/sqrt(1+y^2) * 100 — para y=0.5 da ~89.4, todavía por encima
  // del umbral (80), así que las 6 quedan como candidatas antes del tope.
  const ys = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const vectors = {};
  const petIdByY = {};
  for (const y of ys) {
    const label = `candidato-y${y}`;
    const bytes = await photoBytes(label);
    vectors[bytes.toString('utf8')] = [1, y, 0];
  }
  const queryLabel = 'buscando-entre-varios';
  const queryBytes = await photoBytes(queryLabel);
  vectors[queryBytes.toString('utf8')] = [1, 0, 0];
  const matcher = fakePetMatcherFor(vectors);

  for (const y of ys) {
    const pet = await petStore.addPet({ species: 'dog', petName: null, description: null, contact: '300 000 0000' });
    petIdByY[y] = pet.id;
    const bytes = await photoBytes(`candidato-y${y}`);
    await processPetPhoto(petStore, matcher, {
      petId: pet.id, kind: 'report', species: 'dog', bytes, contentType: 'image/jpeg'
    });
  }

  const { matches } = await processPetPhoto(petStore, matcher, {
    kind: 'query', species: 'dog', bytes: queryBytes, contentType: 'image/jpeg'
  });

  assert.equal(matches.length, MAX_PET_MATCHES, `nunca deben volver más de ${MAX_PET_MATCHES} coincidencias`);
  for (let i = 1; i < matches.length; i++) {
    assert.ok(
      matches[i - 1].similarity >= matches[i].similarity,
      'las coincidencias deben venir ordenadas de mayor a menor similitud'
    );
  }
  const matchedPetIds = matches.map((m) => m.pet_id);
  for (const y of [0, 0.1, 0.2, 0.3, 0.4]) {
    assert.ok(matchedPetIds.includes(petIdByY[y]), `el candidato y=${y} debía estar entre los ${MAX_PET_MATCHES} mejores`);
  }
  assert.ok(
    !matchedPetIds.includes(petIdByY[0.5]),
    'el candidato con menor similitud debía quedar fuera del tope'
  );
});

test('backfillUnindexedPetPhotos borra bytes de una foto "encontré" después de procesarla', async () => {
  const { petStore } = await setup();
  const { processPetPhoto, backfillUnindexedPetPhotos } = require('../src/petmatch');
  const { createPetMatcher } = require('../src/petfaces');

  // Primero, guardar una foto "encontré" con matcher deshabilitado
  delete process.env.PET_MATCH_API_URL;
  const offlineMatcher = createPetMatcher();

  const encontrado = await photoBytes('encontrado');
  const { photo: pendingPhoto } = await processPetPhoto(petStore, offlineMatcher, {
    kind: 'query',
    species: 'dog',
    bytes: encontrado,
    contentType: 'image/jpeg'
  });

  // Verificar que los bytes están presente (porque el matcher estaba deshabilitado al procesarla inicialmente)
  let stored = await petStore.getPetPhoto(pendingPhoto.id);
  // Nota: la foto se borra incluso con matcher deshabilitado (eso es lo que el test anterior verifica),
  // así que aquí crearemos la foto sin usar processPetPhoto
  const { petStore: petStore2 } = await setup();
  const fotoSinProcesar = await petStore2.addPetPhoto({
    kind: 'query',
    species: 'dog',
    content: encontrado,
    contentType: 'image/jpeg'
  });

  // Ahora ejecutar backfill con un matcher que funciona
  const workingMatcher = fakePetMatcherFor({ [encontrado.toString('utf8')]: VECTOR_A });
  const result = await backfillUnindexedPetPhotos(petStore2, workingMatcher, 100);

  assert.equal(result.processed, 1, 'backfill procesó 1 foto');

  // Verificar que el embedding se guardó Y los bytes se borraron
  stored = await petStore2.getPetPhoto(fotoSinProcesar.id);
  assert.deepEqual(stored.embedding, VECTOR_A, 'el embedding se guardó correctamente');
  assert.equal(
    stored.content.length,
    0,
    'los bytes de una foto "encontré" se borran después de backfill'
  );
});

// Cicatriz: backfillUnindexedPetPhotos solo borraba los bytes de una foto
// 'query' dentro de la rama de éxito — si embed() fallaba o el servicio
// devolvía null, los bytes se quedaban en la base hasta el siguiente
// reintento (y para siempre si nunca vuelve a tener éxito). Rompía la misma
// garantía de privacidad que el resto de la suite ya prueba para el camino
// principal.
test('backfillUnindexedPetPhotos borra los bytes de una foto "encontré" aunque embed() vuelva a fallar', async () => {
  const { petStore } = await setup();
  const { backfillUnindexedPetPhotos } = require('../src/petmatch');
  const encontrado = await photoBytes('encontre-que-sigue-fallando');

  const fotoSinProcesar = await petStore.addPetPhoto({
    kind: 'query',
    species: 'dog',
    content: encontrado,
    contentType: 'image/jpeg'
  });

  const failingMatcher = {
    enabled: true,
    status: 'fake',
    async embed() {
      return null;
    }
  };
  const result = await backfillUnindexedPetPhotos(petStore, failingMatcher, 100);
  assert.equal(result.failed, 1);

  const stored = await petStore.getPetPhoto(fotoSinProcesar.id);
  assert.equal(
    stored.content.length,
    0,
    'los bytes de una foto "encontré" deben borrarse aunque el backfill no haya logrado generar un embedding'
  );
});

// El borrado de la foto de «encontré» vive FUERA del try — y eso se verifica
// por ALCANCE, no por cercanía de texto.
//
// Por qué hace falta esta prueba y no basta la de codeowners.test.js: allá el
// patrón `kind === 'query') await petStore.clearPetPhotoContent(` solo
// establece que las dos cosas están pegadas en el texto. Si alguien mueve esa
// línea DENTRO del try y conserva la forma, aquel patrón sigue coincidiendo —
// y la promesa se rompe en silencio: un error transitorio de base dejaría los
// bytes de la foto guardados para siempre.
//
// Acá se mide lo que de verdad importa: que la llamada ocurra después de que
// cierra el bloque que puede fallar.
test('el borrado de una foto «query» corre aunque guardar el embedding o comparar fallen', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'src', 'petmatch.js'), 'utf8');

  function finDelBloque(desde) {
    let profundidad = 0;
    for (let i = desde; i < fuente.length; i++) {
      if (fuente[i] === '{') profundidad++;
      else if (fuente[i] === '}') {
        profundidad--;
        if (profundidad === 0) return i;
      }
    }
    return -1;
  }

  // Todo se mide DENTRO del cuerpo de processPetPhoto. Sin acotar, un borrado
  // de otra función (backfillUnindexedPetPhotos hace uno parecido) alcanzaría
  // para que la prueba pase mientras esta función se queda con los bytes.
  const firma = fuente.indexOf('async function processPetPhoto(');
  assert.ok(firma !== -1, 'no encontré processPetPhoto — ¿se renombró?');
  // El `{` del CUERPO, no el del destructuring de los parámetros: la firma es
  // `processPetPhoto(petStore, petMatcher, { petId, kind, ... }) {`, así que el
  // primer `{` después del nombre abre la lista de parámetros y delimitaría un
  // trozo de dos líneas en vez de la función.
  const inicioCuerpo = fuente.indexOf(') {', firma) + 2;
  const finCuerpo = finDelBloque(inicioCuerpo);
  assert.ok(finCuerpo !== -1, 'no pude delimitar el cuerpo de processPetPhoto');
  const cuerpo = fuente.slice(inicioCuerpo, finCuerpo);

  // `await matchPetPhoto(` y no `matchPetPhoto(` a secas: lo segundo cae en la
  // DEFINICIÓN de esa otra función, que está antes y fuera de cualquier try.
  const dentroDelTry = cuerpo.indexOf('await matchPetPhoto(');
  assert.ok(dentroDelTry !== -1, 'no encontré la llamada a matchPetPhoto dentro de processPetPhoto');
  const inicioTry = cuerpo.lastIndexOf('try {', dentroDelTry);
  assert.ok(inicioTry !== -1, 'matchPetPhoto ya no está dentro de un try — revisa si la promesa sigue en pie');

  function finDelBloqueEn(texto, desde) {
    let profundidad = 0;
    for (let i = desde; i < texto.length; i++) {
      if (texto[i] === '{') profundidad++;
      else if (texto[i] === '}') {
        profundidad--;
        if (profundidad === 0) return i;
      }
    }
    return -1;
  }
  const finTry = finDelBloqueEn(cuerpo, cuerpo.indexOf('{', inicioTry));
  const inicioCatch = cuerpo.indexOf('{', cuerpo.indexOf('catch', finTry));
  const finCatch = finDelBloqueEn(cuerpo, inicioCatch);
  assert.ok(finCatch !== -1, 'no pude encontrar el cierre del catch');

  // Y se exige el borrado DE SU PROPIA FOTO: `photo.id`, no cualquier borrado.
  const borrado = /if\s*\(\s*kind\s*===\s*'query'\s*\)\s*await\s+petStore\.clearPetPhotoContent\s*\(\s*photo\.id\s*\)/g;
  const posiciones = [...cuerpo.matchAll(borrado)].map((m) => m.index);
  assert.ok(posiciones.length > 0, "no encontré `clearPetPhotoContent(photo.id)` guardado por `kind === 'query'`");
  assert.ok(
    posiciones.some((p) => p > finCatch),
    'el borrado de la foto «query» quedó DENTRO del bloque que puede fallar.\n\n' +
      'Si guardar el embedding o comparar lanza, el borrado no corre y los bytes de la foto de\n' +
      'quien encontró la mascota se quedan en la base — justo lo que la promesa dice que no pasa.\n' +
      'Tiene que ir después de que cierra el catch, incondicional.'
  );
});
