// Postgres adapter — production (Vercel + Neon/Vercel Postgres).
// Uses pg_trgm (when available) to prefilter fuzzy-search candidates with an index;
// the shared JS scorer in people.js does the final ranking.
const { Pool } = require('pg');
const crypto = require('crypto');

// #78: see the same constant in src/store/sqlite.js for why "latest status"
// must treat an aggregator-sourced 'safe' row as if it were never written.
const AGGREGATOR_SAFE_EXCLUSION = `WHERE NOT (u.source = 'aggregator' AND u.status = 'safe')`;

// La llave que se guarda en suppressed_external_ids nunca es el valor crudo
// (#192, revisión de cris-pappcorn, punto 2): la llave la elige quien empuja,
// y hay integradores que usan el nombre completo de la persona como
// external_id cuando la fuente no trae otro identificador. Guardar el hash
// mantiene la misma garantía de bloqueo — la comparación sigue siendo por
// igualdad exacta, sha256(a) === sha256(b) sii a === b — sin dejar un dato
// personal en la única tabla del esquema que a propósito no se borra nunca.
function hashExternalId(externalId) {
  return crypto.createHash('sha256').update(String(externalId), 'utf8').digest('hex');
}

async function createPostgresAdapter(connectionString) {
  const sslConfig = /localhost|127\.0\.0\.1/.test(connectionString)
    ? undefined
    : { rejectUnauthorized: false };

  const pool = new Pool({
    connectionString,
    max: 3, // serverless: keep pools tiny
    ssl: sslConfig
  });

  // Pool APARTE, chico, solo para sostener un advisory lock TRANSACCIONAL
  // mientras corre la sección crítica que protege (#192) — NUNCA `pool`.
  //
  // Dos consumidores, la misma razón:
  //   - `withExternalIdLock`: `fn` corre los métodos normales del store, que
  //     a su vez hacen `pool.query(...)` en conexiones del pool de arriba; si
  //     la conexión que sostiene el lock viniera de esa MISMA fuente, bastaban
  //     tres admisiones concurrentes de llaves distintas (o tres esperas del
  //     mismo advisory lock) para dejar las tres conexiones de `pool`
  //     ocupadas sosteniendo/esperando el lock, sin ninguna libre para que
  //     `fn` corriera su propio isExternalIdSuppressed/findOrCreatePerson/
  //     insertUpdate — un deadlock del pool entero, no solo de esta llave
  //     (hallazgo de QA).
  //   - `deletePerson` (a solicitud): sostiene el MISMO tipo de lock mientras
  //     su propia transacción corre. Si tomara su conexión de `pool` (como
  //     hacía antes de la revisión de cris-pappcorn, punto 3), varios DELETE
  //     concurrentes esperando un lock que sostiene una admisión en curso —
  //     cuyo `fn` necesita, a su vez, conexiones de `pool` — podían agotarlo
  //     entre los dos lados. `deletePerson` no reentra a `pool` mientras
  //     sostiene su conexión (solo corre sus propias queries en el mismo
  //     client), así que moverlo acá no crea el mismo problema en sentido
  //     contrario.
  //
  // Un pool separado hace que sostener cualquiera de los dos locks JAMÁS le
  // quite una conexión a lo que el otro lado necesita: la única cola posible
  // es la de este pool chico esperando a que otra sección crítica termine —
  // más lento bajo mucha concurrencia, nunca trabado para siempre.
  const lockPool = new Pool({
    connectionString,
    max: 2, // igual de chico; ver el porqué arriba
    ssl: sslConfig
  });

  let hasTrgm = false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    hasTrgm = true;
  } catch (e) {
    console.warn('[store:pg] pg_trgm unavailable, fuzzy prefilter falls back to full scan:', e.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      phonetic_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_people_normalized ON people(normalized_name);

    CREATE TABLE IF NOT EXISTS updates (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('safe','injured','missing','deceased','unknown')),
      message TEXT,
      location TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      contact TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator','rescate')),
      reporter TEXT,
      external_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_updates_person ON updates(person_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT true,
      verify_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(person_id, channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);

    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
      content BYTEA NOT NULL,
      content_type TEXT NOT NULL,
      face_id TEXT,
      face_detail JSONB,
      thumb BYTEA,
      thumb_type TEXT,
      thumb_large BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_photos_face ON photos(face_id);
    CREATE INDEX IF NOT EXISTS idx_photos_subscription ON photos(subscription_id);

    -- Bitácora de coincidencias y de envíos (#116, PR 3 — SOLO esquema; PR 4
    -- escribe en estas tablas). El diseño aprobado es explícito: "sin
    -- teléfonos, sin correos, sin nombres" — cada columna es un ID, un enum o
    -- un número. Un person_id sigue siendo dato vinculable a una persona
    -- (habeas data, Ley 1581), así que ambas heredan la MISMA retención que ya
    -- rige el resto del esquema: ON DELETE CASCADE sobre people(id). Hoy esa
    -- retención es a demanda (DELETE /api/people/:id, la solicitud de borrado
    -- de la política de privacidad) — no existe un TTL automático por edad en
    -- ningún lado de este esquema, y estas tablas no inventan uno. created_at
    -- + su índice quedan listos para que un cleanup job futuro (PR 4 o
    -- posterior) pueda purgar por antigüedad si hace falta.
    CREATE TABLE IF NOT EXISTS match_log (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      face_id TEXT NOT NULL,
      similarity DOUBLE PRECISION,
      surface TEXT NOT NULL CHECK (surface IN ('rescate','report','api')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_match_log_person ON match_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_match_log_created ON match_log(created_at);

    -- La columna "source" dice QUIÉN ejecutó el contacto, no por qué medio
    -- (eso es "channel"). 'app' es todo lo que escribe esta aplicación; 'operador'
    -- es un contacto que una persona del equipo hizo POR FUERA de la app,
    -- desde su propio buzón o su propio teléfono, y que se registra después
    -- por POST /api/contact-log. Son dos hechos distintos y no se pueden
    -- sumar: la serie de 'app' es el instrumento con el que se responde
    -- "¿el relevo está reteniendo?" y "¿la app entregó?", y una fila que la
    -- app nunca envió la vuelve incontestable. Por eso TODAS las funciones
    -- de agregado de abajo filtran por source y su valor por omisión es
    -- 'app' — olvidar el parámetro conserva el significado de siempre.
    --
    -- "external_ref" es la llave de idempotencia del registrador externo: un
    -- DIGESTO (SHA-256 en hex) del id de mensaje del proveedor, nunca el id
    -- crudo. Un wamid de WhatsApp lleva el teléfono del destinatario
    -- codificado en base64: guardarlo acá metería el número de una familia
    -- en esta tabla, que es justo lo que su diseño prohíbe. La ruta valida
    -- la forma del digesto, así que un id crudo no puede entrar aunque
    -- alguien lo intente.
    CREATE TABLE IF NOT EXISTS contact_log (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','relevo')),
      result TEXT NOT NULL CHECK (result IN ('enviado','fallido','rechazado')),
      source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','operador')),
      external_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_contact_log_person ON contact_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_contact_log_created ON contact_log(created_at);

    -- Constancia de que una ficha se borró a solicitud de la persona misma
    -- (#191), y el mecanismo que hace durable ese borrado. Es la única tabla
    -- del esquema que a propósito NO cuelga de people(id): su trabajo es
    -- justamente sobrevivir a la fila.
    --
    -- Sin ella el borrado se deshace solo. El ON CONFLICT (external_id) de
    -- insertUpdate es lo que hace idempotente a un re-envío, y necesita que la
    -- fila exista para chocar con ella; borrada la ficha, un re-envío de la
    -- misma no actualiza nada: inserta de nuevo, y processPhoto le reindexa la
    -- cara. Sin log, sin error y sin contador — para el sistema es una ficha
    -- nueva que entró bien.
    --
    -- Guarda el HASH sha256 de la llave (hex, 64 caracteres) y la fecha, y
    -- nada más: ni nombre, ni foto, ni contacto, ni person_id, ni la llave
    -- cruda. La llave la elige quien empuja, y hay integradores que usan el
    -- nombre completo de la persona como external_id cuando la fuente no
    -- trae otro identificador — guardar el hash evita que alguien que ejerce
    -- su derecho de supresión termine con su nombre en claro, a perpetuidad,
    -- en la única tabla del esquema sin retención. El chequeo sigue siendo
    -- por igualdad exacta (sha256(a) === sha256(b) sii a === b), así que la
    -- garantía de bloqueo no cambia. El punto es impedir que la ficha vuelva,
    -- no poder reconstruir lo que se borró. Por eso tampoco hay una columna
    -- de "motivo" en texto libre: sería otra puerta por la que entraría PII a
    -- esta tabla.
    --
    -- El alcance es la MISMA llave externa y nada más. Un reporte sin
    -- external_id —el formulario web, el bot— no se bloquea jamás, ni siquiera
    -- si es sobre la misma persona: si una familia la reporta de verdad más
    -- adelante, impedírselo sería peor que el problema que esto cierra. Lo que
    -- se suprime es la re-entrada automática de una ficha, no el derecho de
    -- nadie a reportar.
    CREATE TABLE IF NOT EXISTS suppressed_external_ids (
      external_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pets (
      id SERIAL PRIMARY KEY,
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      pet_name TEXT,
      description TEXT,
      contact TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pet_subscriptions (
      id SERIAL PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT false,
      verify_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pet_photos (
      id SERIAL PRIMARY KEY,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      subscription_id INTEGER REFERENCES pet_subscriptions(id) ON DELETE CASCADE,
      content BYTEA NOT NULL,
      content_type TEXT NOT NULL,
      embedding JSONB,
      embedding_model TEXT,
      thumb BYTEA,
      thumb_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (kind <> 'report' OR pet_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos(pet_id);
    CREATE INDEX IF NOT EXISTS idx_pet_photos_kind_species ON pet_photos(kind, species);

    -- Bitácora de auto-fusiones (#150): a diferencia de match_log/contact_log,
    -- ACÁ SÍ guarda un nombre a propósito. findOrCreatePerson no persiste el
    -- fullName del reporte que se fusiona en ningún otro lado (addUpdate no lo
    -- recibe) — sin esta columna, el nombre original desaparece y una fusión
    -- mala queda imposible de deshacer sin adivinar. Se acepta el desvío del
    -- "sin nombres" de las bitácoras anteriores porque el nombre de una persona
    -- reportada ya es dato público del producto (se muestra en /person/:id),
    -- a diferencia de contact/reporter/message, que nunca lo son.
    CREATE TABLE IF NOT EXISTS merge_log (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      submitted_name TEXT NOT NULL,
      score DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_merge_log_person ON merge_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_merge_log_created ON merge_log(created_at);

    -- ===== COLA DE REVISIÓN DE ESTADO (#190) — inicio =====================
    -- Una ficha en unknown no tiene salida, y eso es el issue #190: el
    -- adaptador del registro público manda "Localizada sin vida" a unknown
    -- A PROPÓSITO (src/sources/colombiatebusca.js) porque adivinar sobre la
    -- muerte de alguien no se hace solo — y el efecto es que la ficha se queda
    -- publicada como buscada indefinidamente aunque la confirmación exista.
    -- Esta tabla es la constancia de la salida humana: quién decidió, cuándo,
    -- y con qué evidencia.
    --
    -- Por qué NO hay un estado público nuevo. Se propuso "probablemente
    -- encontrado" y se descartó por dos razones que gobiernan todo el diseño:
    -- (a) unknown YA es ese estacionamiento, y un segundo duplicaría el
    -- problema de la cola en vez de resolverlo; (b) un estado público es un
    -- mensaje a una familia — si una madre lee "probablemente encontrado" en
    -- la ficha de su hijo va a leer esperanza, y si era un homónimo esa
    -- crueldad la causamos nosotros.
    --
    -- Por eso el marcador de "probable" vive ACÁ y es PRIVADO. Ninguna
    -- superficie pública lee esta tabla, y publicUpdate (src/privacy.js)
    -- enumera campo por campo lo que sale de una fila de updates, así que
    -- nada de acá puede filtrarse por una copia en bloque.
    --
    -- Dos clases de fila, distinguidas por resolved:
    --   resolved = false  constancia sin efecto: alguien miró la ficha y dejó
    --                     escrito qué encontró. NO cambia el estado público y
    --                     NO manda ningún aviso.
    --   resolved = true   resolución aplicada: se escribió una fila en
    --                     updates (update_id) y de ahí salieron los avisos.
    --
    -- author es el correo de la sesión de /admin. Es el único lugar del
    -- esquema donde se persiste la identidad de un operador, y es deliberado:
    -- sin eso la cola es un botón sin memoria. Es dato personal del EQUIPO,
    -- no de una persona reportada ni de su familia, y hereda la misma
    -- retención que todo lo demás.
    --
    -- El enlace a la noticia NO se guarda acá: va en updates.source_url,
    -- que ya existe justamente para eso. Esta tabla guarda la DECISIÓN, no
    -- los links.
    --
    -- evidence_note es la justificación privada de quien revisó, y NUNCA se
    -- copia a updates.message: message sí sale al público.
    --
    -- Nada de "cuándo alcanza la evidencia" está codificado acá. El criterio
    -- lo está escribiendo el frente de verificación; esta tabla registra la
    -- evidencia y deja juzgar a la persona. Una regla de umbral incrustada en
    -- el esquema quedaría obsoleta y sería la más difícil de cambiar.
    --
    -- created_at va como TEXTO ISO en los dos motores, con el mismo formato
    -- por defecto en cada uno: un TIMESTAMPTZ vuelve como Date acá y como
    -- string en SQLite, y esa diferencia se cuela en producción y no en las
    -- pruebas.
    --
    -- Retención: hereda la del resto del esquema, ON DELETE CASCADE sobre
    -- people(id). update_id es SET NULL y no CASCADE a propósito — la
    -- constancia de una decisión no debe desaparecer porque se borró la fila
    -- a la que apuntaba; desaparece con la persona, que es la regla.
    CREATE TABLE IF NOT EXISTS status_review (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      probable_status TEXT NOT NULL CHECK (probable_status IN ('safe','deceased')),
      evidence_note TEXT NOT NULL,
      author TEXT NOT NULL,
      resolved BOOLEAN NOT NULL DEFAULT false,
      update_id INTEGER REFERENCES updates(id) ON DELETE SET NULL,
      -- Cuántos suscriptores notificables había cuando la persona decidió: el
      -- MISMO número que la pantalla le mostró antes de confirmar. El
      -- resultado real de cada envío ya vive en contact_log.
      recipients INTEGER,
      -- En qué modo salió el aviso: 'direct' le llega al suscriptor,
      -- 'relay' cae en el buzón de operación marcado [RETENIDO] y no sale
      -- nada a terceros (ver notifyMode en src/notify.js). Sin esta columna,
      -- el registro no dice si la familia se enteró o no.
      notify_mode TEXT CHECK (notify_mode IN ('direct','relay')),
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
    CREATE INDEX IF NOT EXISTS idx_status_review_person ON status_review(person_id);
    CREATE INDEX IF NOT EXISTS idx_status_review_created ON status_review(created_at);
    -- ===== COLA DE REVISIÓN DE ESTADO (#190) — fin ========================

    -- Llaves de API por persona. Hasta acá existía UNA sola llave (la variable
    -- de entorno API_KEY) que abría las siete superficies con llave del API,
    -- incluido el DELETE irreversible que se lleva las firmas faciales.
    -- Repartirla para que un voluntario aporte fichas era repartir escritura
    -- total a produccion sobre datos de personas desaparecidas. Esta tabla
    -- permite emitir llaves que puedan MUCHO menos (ver la columna scope).
    --
    -- Tres reglas que están en las columnas y conviene leer juntas:
    --   1. key_hash guarda el SHA-256 hex de la llave, y la llave en claro NO
    --      se guarda nunca, en ningún lado. Se muestra una sola vez, al
    --      emitirla; perdida, se revoca y se emite otra. No hace falta bcrypt:
    --      la llave es aleatoria de alta entropía, no una contraseña que haya
    --      que estirar contra un diccionario.
    --   2. key_prefix son los primeros caracteres de la llave en claro — lo
    --      único que se puede mostrar en una lista para distinguir dos llaves
    --      sin tener el secreto de ninguna.
    --   3. label es un ALIAS PÚBLICO del dueño, a propósito: no el nombre
    --      legal, no el correo, no el teléfono. Lo mínimo para saber a quién
    --      revocarle. Guardar más convertiría esta tabla en un registro de
    --      datos personales de voluntarios, con su propia retención que habría
    --      que definir (Ley 1581).
    --
    -- Una fila NUNCA se borra: se revoca (revoked_at). Borrarla se llevaría el
    -- único rastro de qué escribió esa llave, que es justo lo que hace falta
    -- para limpiar después de revocarla.
    --
    -- created_by guarda QUIÉN emitió la llave, y lo único que hace que eso no
    -- contradiga la regla 3 de arriba es QUÉ VALORES acepta: un correo que ya
    -- está en ADMIN_EMAILS, o sea una de las pocas cuentas que administran esta
    -- instalación. Es una REFERENCIA A UNA CUENTA DE OPERACIÓN, nunca texto
    -- libre. La distinción es la que resuelve la objeción de privacidad: hubo
    -- antes una bandera (--por) que aceptaba lo que alguien tecleara, y por ahí
    -- entraba justo el nombre legal o el correo de un voluntario; se quitó. Con
    -- la regla nueva ese dato no puede entrar, porque el conjunto de valores
    -- posibles es la allowlist y nada más. Quien lo valida es scripts/api-key.js
    -- contra isAllowedEmail (src/adminAuth.js) — el esquema no lo puede exigir,
    -- porque la allowlist vive en el entorno y no en la base.
    --
    -- Para qué hace falta: la emisión se delega a personas de confianza, y una
    -- llave emitida tiene que poder revocarla quien la emitió además de los
    -- administradores. Sin este dato esa regla no se puede escribir. Ojo con lo
    -- que la columna todavía NO es: es el DATO, no el control. Hoy el CLI ya
    -- implica poder total y no hay sesión contra la cual aplicar autoridad
    -- alguna; eso llega con el panel de /admin. Las filas emitidas antes de esta
    -- regla quedan en NULL, y ese NULL significa "no se registró", no "nadie".
    --
    -- revoked_at y last_used_at van como TEXTO ISO en los DOS motores, por la
    -- misma razón que subscriptions.rescue_asked_at: se leen y se comparan en
    -- JS, y un TIMESTAMPTZ volvería como Date acá y como string en SQLite —
    -- dos formas del mismo dato es lo que se cuela en producción y no en las
    -- pruebas. created_at sí queda nativo, como en el resto del esquema:
    -- nadie lo compara en JS.
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('operator','ingest')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by TEXT,
      revoked_at TEXT,
      last_used_at TEXT
    );
    -- La verificación de CADA request con llave es exactamente esta búsqueda,
    -- así que el índice no es un lujo.
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    -- Quién escribió qué. Sin esta bitácora se puede revocar una llave mala y
    -- quedar igual de ciego: sin saber qué fichas tocó, no se puede limpiar.
    -- Misma forma que match_log/contact_log —SOLO ids y enums, nunca texto
    -- libre— y la MISMA retención: ON DELETE CASCADE sobre people(id), así que
    -- un borrado a solicitud se la lleva.
    --
    -- api_key_id nulo significa "la llave de entorno API_KEY", que no tiene
    -- fila. Es información, no un hueco: distingue lo que escribió el operador
    -- de lo que escribió una llave emitida.
    --
    -- Ojo con la dependencia que esto crea, porque es la única de su tipo en el
    -- esquema: la fila más antigua de una ficha es también la prueba de qué
    -- llave la creó, y de ahí sale la regla de que una llave de ingesta no
    -- pueda pisar lo ajeno. Si la bitácora no se pudo escribir, la ficha queda
    -- SIN dueño demostrable y la regla la rechaza — falla cerrado, que es la
    -- dirección correcta.
    CREATE TABLE IF NOT EXISTS api_write_log (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      api_key_id INTEGER REFERENCES api_keys(id),
      action TEXT NOT NULL CHECK (action IN ('crear','actualizar')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_api_write_log_person ON api_write_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_api_write_log_update ON api_write_log(update_id);
    -- El techo de escrituras por hora de una llave es un COUNT sobre estas dos
    -- columnas, en el camino de CADA escritura suya.
    CREATE INDEX IF NOT EXISTS idx_api_write_log_key_created ON api_write_log(api_key_id, created_at);
  `);
  if (hasTrgm) {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_people_norm_trgm ON people USING gin (normalized_name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_people_phon_trgm ON people USING gin (phonetic_name gin_trgm_ops);
    `);
  }

  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION');
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION');
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS contact TEXT');
  // De dónde salió la afirmación: el enlace a la noticia que confirma que una
  // persona apareció. Un `safe` con enlace carga su propia prueba.
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS source_url TEXT');
  // Detection geometry (bounding box + landmarks) for the public overlay, and
  // the face thumbnail the public listing loads instead of the full photo.
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS face_detail JSONB');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb BYTEA');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_type TEXT');
  await pool.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS thumb_large BYTEA');

  // El reclamo de rescate NO es lo mismo que la propiedad del número, y venían
  // compartiendo el booleano `verified`. Una suscripción que el bot verificó
  // con SUSCRIBIR prueba que el número es de quien escribe; no dice nada sobre
  // si esa persona tiene a alguien al lado. Se separan:
  //   rescue_state      null | 'asked' | 'confirmed' | 'reported'
  //   rescue_similarity el % de la coincidencia que originó la pregunta, para
  //                     que el relevo no llegue sin el único dato que distingue
  //                     un rescate real de un parecido.
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rescue_state TEXT');
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rescue_similarity DOUBLE PRECISION');
  // TEXTO ISO a propósito, igual que en SQLite: la ventana de 72 h se calcula
  // en JS y un TIMESTAMPTZ volvería como Date acá y como string allá — dos
  // formas del mismo dato es lo que se cuela en producción y no en las pruebas.
  // `created_at` no sirve: una fila de seguidor creada la semana pasada puede
  // recibir la pregunta hoy.
  await pool.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS rescue_asked_at TEXT');

  // Integration seam for an external aggregator: external_id lets a caller
  // re-POST the same update idempotently (see insertUpdate below), and
  // 'aggregator' is a real source distinct from the app's own web/whatsapp/api.
  await pool.query('ALTER TABLE updates ADD COLUMN IF NOT EXISTS external_id TEXT');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id
      ON updates(external_id) WHERE external_id IS NOT NULL
  `);
  // Widen the source CHECK for DBs created before 'aggregator' (and later
  // 'rescate', a rescuer's aviso via POST /rescate/aviso) existed.
  // Cheap on this table's scale; matches the ADD COLUMN IF NOT EXISTS pattern above.
  //
  // DROP y ADD van en un SOLO `ALTER TABLE`: Postgres corre el statement en una
  // transacción implícita y toma el lock de la tabla una vez, así que dos
  // instancias arrancando a la vez se serializan. Separados en dos statements
  // se intercalan (A dropea, B dropea, A agrega, B agrega → 42710) y el
  // arranque muere. Postgres procesa el DROP antes que el ADD dentro del mismo
  // ALTER, así que el orden está garantizado.
  await pool.query(`
    ALTER TABLE updates
      DROP CONSTRAINT IF EXISTS updates_source_check,
      ADD  CONSTRAINT updates_source_check
        CHECK (source IN ('web','whatsapp','api','aggregator','rescate'))
  `);

  // Bases creadas antes de que contact_log distinguiera QUIÉN contactó: las
  // filas que ya existen son todas de la app, y ese es exactamente el DEFAULT
  // — el backfill de la columna no necesita decisión de nadie porque no
  // afirma nada nuevo sobre ninguna persona. El CHECK va en el mismo patrón
  // DROP+ADD de un solo ALTER que arriba, por la misma razón de arranque
  // concurrente.
  await pool.query("ALTER TABLE contact_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app'");
  await pool.query('ALTER TABLE contact_log ADD COLUMN IF NOT EXISTS external_ref TEXT');
  await pool.query(`
    ALTER TABLE contact_log
      DROP CONSTRAINT IF EXISTS contact_log_source_check,
      ADD  CONSTRAINT contact_log_source_check
        CHECK (source IN ('app','operador'))
  `);
  // Índice único PARCIAL, igual que updates.external_id: es lo que vuelve
  // idempotente el registro externo (reintentar no duplica) y lo que permite
  // deshacer una fila puntual por su referencia. Las filas de la app llevan
  // external_ref NULL y no entran al índice.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_log_external_ref
      ON contact_log(external_ref) WHERE external_ref IS NOT NULL
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_contact_log_source ON contact_log(source, created_at)');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const all = async (sql, params) => (await pool.query(sql, params)).rows;

  // El WHERE compartido por los tres agregados de contact_log, en un solo
  // sitio para que el filtro por `source` no se pueda aplicar en dos y
  // olvidar en el tercero — que es exactamente cómo una serie empieza a
  // contradecir a la de al lado. `source: null` significa "todas las
  // procedencias" y hay que pedirlo explícitamente.
  function contactLogWhere({ since, source } = {}) {
    const conds = [];
    const params = [];
    if (since) {
      params.push(since);
      conds.push(`created_at >= $${params.length}`);
    }
    if (source) {
      params.push(source);
      conds.push(`source = $${params.length}`);
    }
    return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  // Las firmas faciales atadas a una o más suscripciones. Hay que leerlas
  // ANTES de borrar la suscripción: `photos.subscription_id` también cascada
  // (ver el esquema arriba), y con la suscripción se va la única fila que
  // decía qué firma retirar de Rekognition — el mismo problema que
  // `faceIdsForPerson` ya resuelve para el borrado de persona (#162).
  async function faceIdsForSubscriptionIds(subscriptionIds) {
    if (!subscriptionIds.length) return [];
    const rows = await all(
      'SELECT face_id FROM photos WHERE subscription_id = ANY($1) AND face_id IS NOT NULL',
      [subscriptionIds]
    );
    return rows.map((r) => r.face_id);
  }

  return {
    async insertPerson(fullName, normalized, phonetic) {
      return one(
        'INSERT INTO people (full_name, normalized_name, phonetic_name) VALUES ($1, $2, $3) RETURNING *',
        [fullName, normalized, phonetic]
      );
    },
    async getPerson(id) {
      return one('SELECT * FROM people WHERE id = $1', [id]);
    },
    async allPeople(limit) {
      return all('SELECT id, full_name FROM people ORDER BY id LIMIT $1', [limit]);
    },
    async updatePersonName(id, fullName) {
      await pool.query('UPDATE people SET full_name = $1 WHERE id = $2', [fullName, id]);
    },
    async exactByNormalized(normalized) {
      return one('SELECT * FROM people WHERE normalized_name = $1 LIMIT 1', [normalized]);
    },
    async candidatePeople(normalized, phonetic) {
      if (hasTrgm && normalized) {
        // Trigram similarity + substring on either representation; JS scorer ranks.
        return all(
          `SELECT * FROM people
           WHERE normalized_name % $1
              OR phonetic_name % $2
              OR normalized_name ILIKE '%' || $1 || '%'
           LIMIT 500`,
          [normalized, phonetic || '']
        );
      }
      return all('SELECT * FROM people LIMIT 5000');
    },
    // When externalId is set, this is an idempotent upsert keyed on it: a
    // second POST with the same externalId updates status/message/location/
    // lat/lng/reporter/contact on the SAME timeline row instead of creating a
    // new one (the aggregator re-sending its latest snapshot doesn't duplicate
    // the person's history). Without externalId, behavior is unchanged: a
    // plain insert every time.
    async insertUpdate(personId, { status, message, location, lat, lng, source, sourceUrl, reporter, contact, externalId }) {
      return one(
        `INSERT INTO updates (person_id, status, message, location, lat, lng, source, source_url, reporter, contact, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           status = EXCLUDED.status,
           message = EXCLUDED.message,
           location = EXCLUDED.location,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           source_url = EXCLUDED.source_url,
           reporter = EXCLUDED.reporter,
           contact = EXCLUDED.contact
         RETURNING *`,
        [
          personId,
          status,
          message || null,
          location || null,
          Number.isFinite(lat) ? lat : null,
          Number.isFinite(lng) ? lng : null,
          source,
          sourceUrl || null,
          reporter || null,
          contact || null,
          externalId || null
        ]
      );
    },
    async updatesForPerson(personId) {
      return all('SELECT * FROM updates WHERE person_id = $1 ORDER BY created_at DESC, id DESC', [
        personId
      ]);
    },
    // "El estado actual de una persona es el de su update más reciente" (ver
    // POST /rescate/aviso en src/routes/web.js) es la regla que lee el bot de
    // WhatsApp, GET /api/people y las tarjetas de duplicados — no solo el
    // home. Sin el mismo filtro, esas tres superficies seguirían anunciando
    // "Localizada" por una fila del agregador que el home ya ignora.
    async latestUpdate(personId) {
      return one(
        `SELECT * FROM updates WHERE person_id = $1 AND NOT (source = 'aggregator' AND status = 'safe')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [personId]
      );
    },
    // Everyone whose LATEST update is 'missing' — not everyone who was EVER
    // reported missing. Under the old "has ANY missing update" filter a person
    // later confirmed alive stayed on the list forever: their family sees them
    // still listed as missing, and rescuers keep looking for someone who is
    // already home.
    // The `reports` count this query used to return is gone: nothing rendered
    // it, and keeping it meant a second full GROUP BY over every update on the
    // busiest page of the site.
    async missingPeople(limit) {
      return all(
        `WITH latest AS (
           SELECT u.person_id, u.status, u.created_at,
                  ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM updates u
           ${AGGREGATOR_SAFE_EXCLUSION}
         )
         SELECT p.id, p.full_name, l.status, l.created_at AS last_report
         FROM people p
         JOIN latest l ON l.person_id = p.id AND l.rn = 1
         WHERE l.status = 'missing'
         ORDER BY l.created_at DESC
         LIMIT $1`,
        [limit]
      );
    },
    // How many people whose LATEST status is 'safe' — the reunited counter.
    // Same "latest status per person" logic as missingPeople above.
    async reunitedCount() {
      const r = await one(
        `WITH latest AS (
           SELECT u.person_id, u.status,
                  ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM updates u
           ${AGGREGATOR_SAFE_EXCLUSION}
         )
         SELECT COUNT(*)::int AS n FROM latest WHERE rn = 1 AND status = 'safe'`
      );
      return r.n;
    },
    async recentUpdates(limit) {
      return all(
        `SELECT u.*, p.full_name FROM updates u JOIN people p ON p.id = u.person_id
         ORDER BY u.created_at DESC, u.id DESC LIMIT $1`,
        [limit]
      );
    },
    async subscriptionsForAddress(channel, address) {
      return all('SELECT * FROM subscriptions WHERE channel = $1 AND address = $2 ORDER BY id DESC', [
        channel,
        address
      ]);
    },
    async findSubscription(personId, channel, address) {
      return one(
        'SELECT * FROM subscriptions WHERE person_id = $1 AND channel = $2 AND address = $3',
        [personId, channel, address]
      );
    },
    async insertSubscription(personId, channel, address, verified, verifyToken) {
      await pool.query(
        `INSERT INTO subscriptions (person_id, channel, address, verified, verify_token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (person_id, channel, address) DO NOTHING`,
        [personId, channel, address, !!verified, verifyToken || null]
      );
      return this.findSubscription(personId, channel, address);
    },
    async setSubscriptionRescue(id, { state, similarity, askedAt } = {}) {
      return one(
        `UPDATE subscriptions
            SET rescue_state = $2,
                rescue_similarity = COALESCE($3, rescue_similarity),
                rescue_asked_at = COALESCE($4, rescue_asked_at)
          WHERE id = $1
          RETURNING *`,
        [id, state || null, similarity == null ? null : Number(similarity), askedAt || null]
      );
    },
    async verifySubscriptionByToken(token) {
      return one('UPDATE subscriptions SET verified = true WHERE verify_token = $1 RETURNING *', [
        token
      ]);
    },
    // Igual que deletePerson en src/routes/api.js: los face_id se leen ANTES
    // de borrar la fila, porque la cascada de subscription_id se la lleva
    // junto con la única forma de saber qué firma retirar (#162).
    async deleteSubscriptionByToken(token) {
      const sub = await one('SELECT * FROM subscriptions WHERE verify_token = $1', [token]);
      if (!sub) return null;
      const faceIds = await faceIdsForSubscriptionIds([sub.id]);
      await pool.query('DELETE FROM subscriptions WHERE id = $1', [sub.id]);
      return { ...sub, faceIds };
    },
    async deleteSubscription(personId, channel, address) {
      const sub = await one(
        'SELECT id FROM subscriptions WHERE person_id = $1 AND channel = $2 AND address = $3',
        [personId, channel, address]
      );
      if (!sub) return { count: 0, faceIds: [] };
      const faceIds = await faceIdsForSubscriptionIds([sub.id]);
      const r = await pool.query('DELETE FROM subscriptions WHERE id = $1', [sub.id]);
      return { count: r.rowCount, faceIds };
    },
    async deleteSubscriptionsForAddress(channel, address) {
      const subs = await all('SELECT id FROM subscriptions WHERE channel = $1 AND address = $2', [
        channel,
        address
      ]);
      if (!subs.length) return { count: 0, faceIds: [] };
      const ids = subs.map((s) => s.id);
      const faceIds = await faceIdsForSubscriptionIds(ids);
      // Por id, no por (channel, address): una suscripción creada entre el
      // SELECT de arriba y este DELETE no está en `ids`, así que este WHERE no
      // debe alcanzarla — si la alcanzara, se borraría sin haber leído su
      // face_id, el mismo hueco que cierra el resto de este archivo (#162).
      const r = await pool.query('DELETE FROM subscriptions WHERE id = ANY($1)', [ids]);
      return { count: r.rowCount, faceIds };
    },
    async subscriptionsForPerson(personId) {
      return all('SELECT * FROM subscriptions WHERE person_id = $1', [personId]);
    },
    async getSubscriptionById(id) {
      return one('SELECT * FROM subscriptions WHERE id = $1', [id]);
    },
    async insertPhoto({ personId, kind, updateId, subscriptionId, content, contentType }) {
      return one(
        `INSERT INTO photos (person_id, kind, update_id, subscription_id, content, content_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, person_id, kind, update_id, subscription_id, content_type, face_id, created_at`,
        [personId, kind, updateId || null, subscriptionId || null, content, contentType]
      );
    },
    async setPhotoFaceId(photoId, faceId) {
      await pool.query('UPDATE photos SET face_id = $1 WHERE id = $2', [faceId, photoId]);
    },
    async setPhotoFaceDetail(photoId, detail) {
      await pool.query('UPDATE photos SET face_detail = $1 WHERE id = $2', [
        detail ? JSON.stringify(detail) : null,
        photoId
      ]);
    },
    async setPhotoThumbnails(photoId, { small, large, contentType }) {
      await pool.query(
        'UPDATE photos SET thumb = $1, thumb_large = $2, thumb_type = $3 WHERE id = $4',
        [small, large, contentType, photoId]
      );
    },
    async getPhoto(id) {
      return one('SELECT * FROM photos WHERE id = $1', [id]);
    },
    // Just enough to render a face plate. Deliberately NOT getPhoto: that one
    // does SELECT *, dragging the full image and both thumbnails out of the
    // database to read two columns.
    async reportPhotoMeta(id) {
      return one(
        `SELECT id, person_id, kind, content_type, face_id, face_detail, thumb_type
         FROM photos WHERE id = $1 AND kind = 'report'`,
        [id]
      );
    },
    // One photo per person for the public listing: the earliest report photo
    // that still has bytes and, preferably, a thumbnail to show.
    async reportPhotosForPeople(personIds) {
      if (!personIds.length) return [];
      return all(
        `SELECT DISTINCT ON (person_id) id, person_id, content_type, face_id, face_detail, thumb_type
         FROM photos
         WHERE kind = 'report' AND person_id = ANY($1) AND octet_length(content) > 0
         ORDER BY person_id, (thumb IS NULL), (thumb_large IS NULL), (face_detail IS NULL), id`,
        [personIds]
      );
    },
    // Report photos still missing a thumbnail or the detection geometry. A row
    // whose face_detail holds only a crop (thumbnailed while Rekognition was
    // down) has no "box" yet, so it stays in this set until it gets one — but
    // a row marked no_face is done: Rekognition already looked and found no
    // face, so retrying it every run would burn DetectFaces forever.
    // jsonb_exists, not the ? operator: node-pg reads ? as a placeholder.
    async photosMissingDerivatives(limit) {
      return all(
        `SELECT * FROM photos
         WHERE kind = 'report' AND octet_length(content) > 0
           AND (thumb IS NULL OR thumb_large IS NULL
                OR face_detail IS NULL
                OR NOT (jsonb_exists(face_detail, 'box') OR jsonb_exists(face_detail, 'no_face')))
         ORDER BY id LIMIT $1`,
        [limit]
      );
    },
    // Rescue photos are never kept: only the face signature survives.
    async clearPhotoContent(photoId) {
      await pool.query('UPDATE photos SET content = $1 WHERE id = $2', [Buffer.alloc(0), photoId]);
    },
    // La misma foto exacta ya indexada para esta persona: su face_id, para
    // reusarlo en vez de sumar una firma nueva por la misma cara (#160 — un
    // reporte re-empujado con la misma foto multiplicaba firmas). face_id
    // IS NOT NULL ya excluye a la fila que se está procesando ahora mismo,
    // que todavía no tiene el suyo escrito.
    async photoFaceIdForContent(personId, kind, content) {
      const row = await one(
        `SELECT face_id FROM photos
         WHERE person_id = $1 AND kind = $2 AND face_id IS NOT NULL AND content = $3
         LIMIT 1`,
        [personId, kind, content]
      );
      return row ? row.face_id : null;
    },
    async photosByFaceIds(faceIds) {
      if (!faceIds.length) return [];
      return all(
        'SELECT id, person_id, kind, update_id, subscription_id, face_id FROM photos WHERE face_id = ANY($1)',
        [faceIds]
      );
    },
    // Metadatos de toda foto con firma facial — sin contenido ni derivados:
    // esto alimenta un conteo, no una pantalla.
    async indexedPhotos() {
      return all(
        'SELECT id, person_id, kind, face_id FROM photos WHERE face_id IS NOT NULL ORDER BY id',
        []
      );
    },
    // Las firmas faciales de las fotos de una persona. Hay que leerlas ANTES de
    // borrarla: la cascada se lleva las filas de `photos` y con ellas el único
    // registro de qué retirar de la colección de Rekognition.
    async faceIdsForPerson(personId) {
      const rows = await all(
        'SELECT face_id FROM photos WHERE person_id = $1 AND face_id IS NOT NULL',
        [personId]
      );
      return rows.map((r) => r.face_id);
    },
    // `atSubjectRequest` distingue los dos borrados que hoy existen, y la
    // diferencia no es de forma sino de consecuencia. El del ARCO
    // (DELETE /api/people/:id) es alguien ejerciendo un derecho, y ahí borrar
    // ES suprimir: queda constancia de la llave para que la ficha no vuelva a
    // entrar sola. La purga de registros de prueba borra filas que nadie pidió
    // borrar, así que no suprime nada — bloquear para siempre la llave de un
    // registro de prueba sería un efecto que nadie pidió.
    //
    // Las dos escrituras van en UNA transacción porque las dos mitades sueltas
    // fallan distinto y las dos fallan mal: constancia sin borrado rechazaría
    // los re-envíos de una ficha que sigue publicada y viva, y borrado sin
    // constancia es exactamente el defecto que esto cierra.
    //
    // Las llaves se leen ANTES del DELETE por la misma razón que los face_id
    // (ver faceIdsForPerson arriba): la cascada se lleva las filas de `updates`
    // y con ellas la única copia de la llave.
    async deletePerson(id, { atSubjectRequest = false } = {}) {
      // Instantánea de qué llaves podría suprimir este borrado — solo para
      // saber CUÁLES pedir con pg_advisory_xact_lock antes de escribir; no es
      // garantía de que sigan siendo las mismas para cuando la transacción de
      // abajo corra. Una llave que aparezca después de esta foto no tiene lock
      // que la proteja todavía, pero la relectura de más abajo, YA ADENTRO de
      // la transacción, la vuelve a leer y la suprime igual. Lo que eso no
      // cierra —más angosto que la condición de carrera de #192, que es la
      // que este lock existe para cerrar— es una admisión que en ese mismo
      // instante le agrega a ESTA MISMA persona una llave que nadie pidió
      // suprimir todavía.
      const snapshot = atSubjectRequest
        ? (
            await pool.query(
              'SELECT DISTINCT external_id FROM updates WHERE person_id = $1 AND external_id IS NOT NULL',
              [id]
            )
          ).rows.map((r) => r.external_id).sort()
        : [];

      // La conexión dedicada sale de `lockPool`, NUNCA de `pool` (#192,
      // revisión de cris-pappcorn, punto 3) — ver el comentario largo donde
      // se crea `lockPool`, arriba.
      const client = await lockPool.connect();
      try {
        await client.query('BEGIN');
        // Convierte una espera patológica en un error, en vez de un cuelgue
        // sin límite — mismo razonamiento que en withExternalIdLock, abajo.
        // SET LOCAL es de alcance transaccional: sí funciona detrás de un
        // pooler en modo transacción (SET a secas, no).
        await client.query("SET LOCAL lock_timeout = '5s'");
        // El MISMO lock que sostiene la admisión entre su chequeo y su
        // escritura (#192, `withExternalIdLock` abajo) — si el borrado no lo
        // pide antes de escribir, un re-envío que ya pasó el chequeo puede
        // quedar en el aire mientras este borrado suprime y se va, y terminar
        // escribiendo igual: la ficha revive.
        //
        // pg_advisory_xact_lock, no pg_advisory_lock (revisión de
        // cris-pappcorn, punto 1): un lock de SESIÓN no sobrevive a un pooler
        // en modo transacción (PgBouncer / el endpoint pooled de Neon, que es
        // el que ve `findPostgresUrl()` — ver el comentario largo en
        // withExternalIdLock) — cada sentencia suelta puede repartirse en un
        // backend distinto, y el lock queda tomado para siempre en uno que ya
        // nadie va a liberar. El de transacción se toma y se libera en el
        // MISMO backend porque todo esto es una sola transacción, y se libera
        // SOLO al COMMIT o ROLLBACK — también si el proceso muere a mitad.
        //
        // Van todos en la MISMA conexión que el resto de esta transacción (no
        // una por llave): el `for` no reentra a ningún otro pool.
        //
        // `hashtextextended(_, 0)` da 64 bits en vez de los 32 de `hashtext`:
        // baja la probabilidad de colisión entre llaves distintas que no
        // tenían nada que ver entre sí. Tiene que usar la MISMA forma que
        // `withExternalIdLock` — son espacios de lock distintos, y media
        // migración no serializa nada.
        for (const externalId of snapshot) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [externalId]);
        }
        let suppressed = 0;
        if (atSubjectRequest) {
          // Relectura fresca, YA ADENTRO de la transacción — ver el
          // comentario de `snapshot`, arriba. Se hashea en JS antes de
          // guardar (#192, revisión de cris-pappcorn, punto 2: ver el
          // comentario de la tabla, más arriba, para el porqué).
          const fresh = (
            await client.query(
              'SELECT DISTINCT external_id FROM updates WHERE person_id = $1 AND external_id IS NOT NULL',
              [id]
            )
          ).rows.map((r) => r.external_id);
          if (fresh.length) {
            const res = await client.query(
              `INSERT INTO suppressed_external_ids (external_id)
               SELECT * FROM unnest($1::text[])
               ON CONFLICT (external_id) DO NOTHING`,
              [fresh.map(hashExternalId)]
            );
            suppressed = res.rowCount || 0;
          }
        }
        const deleted = (await client.query('DELETE FROM people WHERE id = $1 RETURNING *', [id]))
          .rows[0];
        await client.query('COMMIT');
        return deleted ? { ...deleted, suppressed_external_ids: suppressed } : null;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        // Nada que liberar a mano: un lock transaccional se suelta solo en el
        // COMMIT o el ROLLBACK de arriba. El pg_advisory_unlock_all() que
        // había acá antes de la revisión de cris-pappcorn (punto 1) liberaba
        // TODOS los locks de sesión del backend donde cayera la conexión —
        // incluidos los de otro cliente lógico que compartiera ese backend a
        // través del pooler — rompiendo su exclusión mutua sin ningún
        // síntoma.
        client.release();
      }
    },
    // La consulta que hace valer la constancia, en el ingreso. Va por llave
    // exacta sobre el hash (#192, revisión de cris-pappcorn, punto 2): una
    // llave distinta para la misma persona no está suprimida, y eso es el
    // límite honesto de este mecanismo (ver el comentario de la tabla).
    async isExternalIdSuppressed(externalId) {
      const r = await one('SELECT 1 FROM suppressed_external_ids WHERE external_id = $1', [
        hashExternalId(externalId)
      ]);
      return !!r;
    },
    // Lock TRANSACCIONAL por external_id: serializa el chequeo-y-escritura de
    // una admisión (src/report-admission.js) contra la ventana en la que
    // `deletePerson({ atSubjectRequest: true })` suprime esa misma llave
    // (#192, condición de carrera señalada por coderabbitai).
    //
    // Es `pg_advisory_xact_lock`, no `pg_advisory_lock` (revisión de
    // cris-pappcorn, punto 1, confirmada leyendo `src/store/index.js`, no
    // adivinada): `findPostgresUrl()` acepta seis nombres de variable y
    // ninguno de los dos que apuntan al endpoint DIRECTO de Neon
    // (`DATABASE_URL_UNPOOLED`, `POSTGRES_URL_NON_POOLING`) está en la lista
    // ni casa con su regex dinámico — así que el código SIEMPRE resuelve el
    // endpoint pooled (PgBouncer en modo transacción), nunca el directo. Bajo
    // ese pooler, un lock de sesión y su unlock pueden caer en backends
    // distintos: el unlock no lanza, devuelve `false` y loguea un WARNING que
    // nadie ve, y el lock queda tomado hasta que el pooler recicle esa
    // conexión — sin timeout, cuelga toda admisión futura con esa llave. No
    // es un "depende del entorno": para llegar al endpoint directo haría
    // falta inventar una variable con un nombre que casualmente termine en
    // `_DATABASE_URL`.
    //
    // El lock transaccional no necesita compartir conexión con lo que
    // protege — necesita estar tomado MIENTRAS ese trabajo corre. Por eso se
    // abre una transacción en esta conexión dedicada, se toma el lock ahí, y
    // `fn` sigue corriendo sobre el `pool` principal sin tocar nada de su
    // código: la exclusión mutua es idéntica a la de antes, porque nunca
    // dependió de la conexión sino del candado. Se libera SOLO al COMMIT o al
    // ROLLBACK — nunca queda un `finally` que no corrió, y si el proceso
    // muere a mitad, el pooler hace ROLLBACK de la transacción abierta al
    // devolver el backend al pool, así que el lock se libera igual.
    //
    // La conexión dedicada sale de `lockPool`, NUNCA de `pool` — ver el
    // comentario largo donde se crea `lockPool`, arriba: si saliera de la
    // misma fuente que `fn` necesita para sus propias queries, alcanzaban
    // tres admisiones concurrentes para agotar el pool entero y dejarlas a
    // las tres esperando una conexión que ninguna puede soltar (hallazgo de
    // QA).
    //
    // `hashtextextended(_, 0)` da un entero de 64 bits (existe desde PG 11),
    // no los 32 de `hashtext()`: baja en la práctica a cero la probabilidad
    // de que dos external_id distintos compartan la llave del lock. Tiene
    // que usar la MISMA forma que `deletePerson` — son espacios de lock
    // distintos, y media migración no serializa nada.
    async withExternalIdLock(externalId, fn) {
      const client = await lockPool.connect();
      try {
        await client.query('BEGIN');
        // Convierte una espera patológica en un error en vez de un cuelgue
        // sin límite. SET LOCAL es de alcance transaccional, así que sí
        // funciona detrás de un pooler en modo transacción (SET a secas, no).
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [externalId]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async counts() {
      const r = await one(`SELECT
        (SELECT COUNT(*) FROM people)::int AS people,
        (SELECT COUNT(*) FROM updates)::int AS updates,
        (SELECT COUNT(*) FROM subscriptions)::int AS subscriptions,
        (SELECT COUNT(*) FROM subscriptions WHERE verified)::int AS subscriptions_verified,
        (SELECT COUNT(*) FROM photos)::int AS photos,
        (SELECT COUNT(*) FROM photos WHERE face_id IS NOT NULL)::int AS photos_indexed,
        (SELECT COUNT(*) FROM photos WHERE kind = 'report')::int AS photos_report,
        (SELECT COUNT(*) FROM photos WHERE kind = 'query')::int AS photos_query`);
      return r;
    },
    async photosMissingFaceId(limit) {
      return all('SELECT * FROM photos WHERE face_id IS NULL ORDER BY id LIMIT $1', [limit]);
    },
    async countQueryPhotos(subscriptionId) {
      const r = await one(
        "SELECT COUNT(*)::int AS n FROM photos WHERE subscription_id = $1 AND kind = 'query'",
        [subscriptionId]
      );
      return r.n;
    },

    // Bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación;
    // las tablas las creó PR 3). Cada escritura la envuelve `src/logbook.js`
    // en un try/catch — acá abajo no hace falta duplicar esa protección.
    async insertMatchLog({ personId, updateId, faceId, similarity, surface }) {
      await pool.query(
        'INSERT INTO match_log (person_id, update_id, face_id, similarity, surface) VALUES ($1, $2, $3, $4, $5)',
        [personId, updateId ?? null, faceId, similarity ?? null, surface]
      );
    },
    // `source`/`externalRef`/`createdAt` solo los usa el registrador externo
    // (POST /api/contact-log): la app escribe sin ellos y cae al default
    // 'app', que es lo que la deja adentro de su propia serie. Devuelve
    // `{ inserted }` porque el reintento de un registro externo NO es un
    // error — es el mismo hecho llegando dos veces, y quien reintenta
    // necesita saber cuál de las dos cosas pasó.
    async insertContactLog({ personId, updateId, channel, result, source = 'app', externalRef = null, createdAt = null }) {
      const row = await one(
        `INSERT INTO contact_log (person_id, update_id, channel, result, source, external_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
         RETURNING id`,
        [personId, updateId ?? null, channel, result, source, externalRef, createdAt]
      );
      return { inserted: !!row };
    },
    // Borra UNA fila externa por su referencia. `source = 'operador'` no es
    // decorativo: es lo que garantiza que este camino jamás pueda borrar un
    // envío que la app sí hizo. Devuelve false si no había nada que borrar
    // — deshacer dos veces es tan idempotente como registrar dos veces.
    async deleteContactLogByRef(externalRef) {
      const row = await one(
        "DELETE FROM contact_log WHERE external_ref = $1 AND source = 'operador' RETURNING id",
        [externalRef]
      );
      return !!row;
    },
    // Los contactos que llegaron A UNA FAMILIA sobre esta persona, en orden.
    // 'relevo' queda afuera EN EL SQL, no en la vista: un relevo es un aviso
    // que la app retuvo y mandó al buzón del equipo, o sea exactamente lo
    // contrario a "se avisó a quien reportó". Filtrarlo acá abajo hace
    // imposible que una vista futura lo muestre como si fuera un aviso
    // entregado.
    async familyContactLogByPerson(personId) {
      return all(
        `SELECT channel, result, source, created_at
         FROM contact_log
         WHERE person_id = $1 AND channel <> 'relevo'
         ORDER BY created_at ASC, id ASC`,
        [personId]
      );
    },
    // #150: registro de cada auto-fusión por nombre — ver el comentario del
    // esquema sobre por qué esta tabla sí guarda un nombre.
    async insertMergeLog({ personId, submittedName, score }) {
      await pool.query(
        'INSERT INTO merge_log (person_id, submitted_name, score) VALUES ($1, $2, $3)',
        [personId, submittedName, score]
      );
    },
    // ===== COLA DE REVISIÓN DE ESTADO (#190) — inicio =====================
    // Ver el comentario gemelo en src/store/sqlite.js: la cola son las
    // personas cuyo ÚLTIMO estado es `unknown`, con el mismo filtro de
    // "último estado" que missingPeople, y sin bandera de "resuelto" porque
    // resolver escribe una fila nueva en `updates` y la ficha sale sola.
    async unknownPeople(limit) {
      return all(
        `WITH latest AS (
           SELECT u.*,
                  ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
           FROM updates u
           ${AGGREGATOR_SAFE_EXCLUSION}
         )
         SELECT p.id, p.full_name,
                l.id AS update_id, l.status, l.message, l.location, l.source,
                l.source_url, l.created_at AS last_report
         FROM people p
         JOIN latest l ON l.person_id = p.id AND l.rn = 1
         WHERE l.status = 'unknown'
         ORDER BY l.created_at DESC
         LIMIT $1`,
        [limit]
      );
    },
    async insertStatusReview({ personId, probableStatus, evidenceNote, author, resolved, updateId, recipients, notifyMode }) {
      return one(
        `INSERT INTO status_review
           (person_id, probable_status, evidence_note, author, resolved, update_id, recipients, notify_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          personId,
          probableStatus,
          evidenceNote,
          author,
          Boolean(resolved),
          updateId ?? null,
          Number.isFinite(recipients) ? recipients : null,
          notifyMode ?? null
        ]
      );
    },
    async statusReviewsForPerson(personId) {
      return all(
        'SELECT * FROM status_review WHERE person_id = $1 ORDER BY created_at DESC, id DESC',
        [personId]
      );
    },
    // ===== COLA DE REVISIÓN DE ESTADO (#190) — fin ========================
    // --- Llaves de API por persona -------------------------------------
    // La llave en claro no entra acá NUNCA: quien emite hashea antes de llamar
    // (hashApiKey vive en src/routes/api.js, junto a la verificación).
    async insertApiKey({ label, keyHash, keyPrefix, scope, createdBy }) {
      return one(
        `INSERT INTO api_keys (label, key_hash, key_prefix, scope, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [label, keyHash, keyPrefix, scope, createdBy || null]
      );
    },
    // Devuelve la fila INCLUSO si está revocada, a propósito: quien verifica
    // necesita distinguir "esta llave no existe" de "existía y se revocó".
    // Filtrar acá por revoked_at IS NULL haría que una llave revocada se vea
    // igual que un token inventado — y en el modo de desarrollo sin API_KEY eso
    // significaría caer al camino abierto, o sea que revocar ABRIRÍA.
    async apiKeyByHash(keyHash) {
      return one('SELECT * FROM api_keys WHERE key_hash = $1', [keyHash]);
    },
    // Sin key_hash: nada que consuma un listado lo necesita, y no exponerlo es
    // gratis.
    async apiKeysList() {
      return all(
        `SELECT id, label, key_prefix, scope, created_at, created_by, revoked_at, last_used_at
         FROM api_keys ORDER BY id`
      );
    },
    // Idempotente: revocar dos veces conserva la primera fecha. Devuelve fila
    // solo si esta llamada fue la que revocó.
    async revokeApiKey(id, revokedAt) {
      return one(
        'UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *',
        [id, revokedAt]
      );
    },
    // "Último uso" con throttle, en UN solo statement a propósito: leer,
    // decidir y escribir desde JS sería una carrera entre instancias por un
    // dato que a nadie le importa al segundo. staleBeforeIso es la marca a
    // partir de la cual vale la pena reescribir.
    async touchApiKeyUsed(id, nowIso, staleBeforeIso) {
      await pool.query(
        `UPDATE api_keys SET last_used_at = $2
         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)`,
        [id, nowIso, staleBeforeIso]
      );
    },
    async insertApiWriteLog({ personId, updateId, apiKeyId, action }) {
      await pool.query(
        'INSERT INTO api_write_log (person_id, update_id, api_key_id, action) VALUES ($1, $2, $3, $4)',
        [personId, updateId ?? null, apiKeyId ?? null, action]
      );
    },
    // De quién es el external_id que un llamador quiere reescribir:
    //   undefined          → no hay ninguna ficha con ese id: está libre.
    //   { api_key_id: null } → la escribió la llave de entorno, o la bitácora no
    //                        alcanzó a registrarla. En los dos casos NO es de
    //                        una llave emitida.
    //   { api_key_id: 7 }  → la escribió la llave 7.
    // Gana la fila MÁS ANTIGUA de la bitácora: quien creó la ficha, no quien la
    // tocó de último.
    async apiWriteOwnerByExternalId(externalId) {
      return one(
        `SELECT u.id AS update_id, l.api_key_id
         FROM updates u
         LEFT JOIN api_write_log l ON l.update_id = u.id
         WHERE u.external_id = $1
         ORDER BY l.id ASC NULLS LAST
         LIMIT 1`,
        [externalId]
      );
    },
    // El techo por hora de una llave. Se cuenta sobre la bitácora y no sobre un
    // contador en memoria porque en Vercel hay varias instancias, y un contador
    // por instancia multiplica el techo por el número de instancias.
    async countApiWrites(apiKeyId, sinceIso) {
      const row = await one(
        'SELECT COUNT(*)::int AS n FROM api_write_log WHERE api_key_id = $1 AND created_at >= $2',
        [apiKeyId, sinceIso]
      );
      return row ? row.n : 0;
    },
    // Cuenta total y por superficie. `since` (ISO) filtra a lo escrito desde
    // ahí — se usa para la línea de "cambio desde el reporte anterior" del
    // correo operativo; sin `since`, es el acumulado histórico completo.
    async matchLogCounts({ since } = {}) {
      const clause = since ? 'WHERE created_at >= $1' : '';
      const totalParams = since ? [since] : [];
      const total = (await one(`SELECT COUNT(*)::int AS n FROM match_log ${clause}`, totalParams)).n;
      const bySurface = {};
      for (const surface of ['rescate', 'report', 'api']) {
        const w = since ? 'WHERE created_at >= $1 AND surface = $2' : 'WHERE surface = $1';
        const p = since ? [since, surface] : [surface];
        bySurface[surface] = (await one(`SELECT COUNT(*)::int AS n FROM match_log ${w}`, p)).n;
      }
      return { total, ...bySurface };
    },
    // Una fila por (channel, result) — el correo pivotea esto en su propia
    // tabla. `since` con el mismo significado que en matchLogCounts.
    //
    // `source` por omisión 'app': un llamador que no diga nada sigue viendo
    // EXACTAMENTE lo que veía antes de que existiera la columna. La
    // alternativa (devolver todo y que cada llamador se acuerde de filtrar)
    // hace que olvidarse contamine la serie en silencio, que es el modo de
    // fallo que esta columna existe para evitar. `source: null` pide todo, y
    // hay que escribirlo.
    async contactLogCounts({ since, source = 'app' } = {}) {
      const { clause, params } = contactLogWhere({ since, source });
      return all(
        `SELECT channel, result, COUNT(*)::int AS count FROM contact_log ${clause} GROUP BY channel, result ORDER BY channel, result`,
        params
      );
    },

    // Series por día (#116, PR 6 — el panel). `since` (ISO) siempre viene del
    // llamador ya calculado en JS, igual que en SQLite — misma razón. El
    // corte de "día" es el de Bogotá, no UTC (hotfix): toda la superficie
    // (el pie del correo, el cron, el panel) habla en hora de Bogotá, y entre
    // las 19:00 y la medianoche Bogotá caía en el día SIGUIENTE bajo UTC —
    // cinco horas de cada día contadas en la fila equivocada. La conversión
    // explícita es igual de necesaria que antes: sin ella, to_char formatea
    // en el huso de la sesión de Postgres, y el corte de "día" tiene que ser
    // el mismo en los dos motores (ver sqlite.js: `date(created_at, '-5 hours')`,
    // el mismo desplazamiento fijo — Colombia no tiene horario de verano).
    async matchLogDaily({ since } = {}) {
      const clause = since ? 'WHERE created_at >= $1' : '';
      const params = since ? [since] : [];
      return all(
        `SELECT to_char(created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
         FROM match_log ${clause} GROUP BY day ORDER BY day`,
        params
      );
    },
    async contactLogDaily({ since, source = 'app' } = {}) {
      const { clause, params } = contactLogWhere({ since, source });
      return all(
        `SELECT to_char(created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS day, result, COUNT(*)::int AS count
         FROM contact_log ${clause} GROUP BY day, result ORDER BY day`,
        params
      );
    },

    // El primer registro de cada tabla (hotfix post-#127/#128 — "los ceros
    // pre-instrumentación son una mentira por omisión"). Antes de esta fecha
    // la bitácora no existía: no es que no pasó nada, es que no se medía.
    // null si la tabla está vacía — todavía no hay ningún registro. Se
    // devuelve como ISO EN UTC, a propósito (a diferencia de matchLogDaily):
    // esto no es un bucket de "día", es un INSTANTE — new Date(...) lo parsea
    // en report.js y el que localiza a Bogotá para mostrarlo es bogotaClock(),
    // no esta función. Cambiarlo a Bogotá acá y seguir marcándolo "Z" mentiría
    // sobre el offset y correría el instante 5 horas. El único punto que sí
    // necesitaba a Bogotá era el bucket de DÍA que deriva de este instante en
    // gatherDailySeries (report.js) — ahí es donde vivía el mismo desfase, y
    // ahí es donde se corrigió (bogotaDayKey), no en el motor de datos.
    async matchLogEarliest() {
      const r = await one("SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS min FROM match_log", []);
      return r.min || null;
    },
    // Mismo default 'app' que los agregados de arriba, y acá el motivo se ve
    // solo: un contacto del operador registrado con fecha del 11-ago correría
    // "envíos medidos desde" hacia atrás y pintaría como instrumentados días
    // en los que la app no había medido nada. La frase "medido desde…" existe
    // precisamente para no mentir por omisión; no puede ser el primer sitio
    // donde se cuela una fila de otra procedencia.
    async contactLogEarliest({ source = 'app' } = {}) {
      const { clause, params } = contactLogWhere({ source });
      const r = await one(
        `SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS min FROM contact_log ${clause}`,
        params
      );
      return r.min || null;
    },

    // Cifras del panel #132 — tres consultas de agregación, sin PII, sin
    // recompute contra Rekognition.
    //
    // Fichas que se sumaron a un registro que YA existía (no fueron la
    // primera actualización de esa persona), por canal de entrada. La
    // clasificación de qué significa cada canal vive en report.js — acá solo
    // el ranking por antigüedad dentro de cada persona (mismo patrón de
    // ROW_NUMBER que ya usan reunitedCount/missingPeople arriba).
    async updatesBeyondFirstBySource() {
      return all(
        `WITH ranked AS (
           SELECT source, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at ASC, id ASC) AS rn
           FROM updates
         )
         SELECT source, COUNT(*)::int AS n FROM ranked WHERE rn > 1 GROUP BY source`
      );
    },
    // Personas distintas con al menos una foto de CONSULTA (kind='query') —
    // el universo del que report.js filtra las ancladas por el flujo de
    // rescate (ver RESCUE_ANCHOR_NORMALIZED_PREFIX en people.js). Sin filtrar
    // acá por nombre a propósito: ese patrón es una convención de la capa de
    // negocio, no algo que el adapter deba conocer.
    // `subscription_id` es nuevo (#132, punto 5): GROUP BY en vez del DISTINCT
    // de antes, para que una persona con más de una foto de consulta siga
    // devolviendo UNA sola fila (el conteo de gatherRescuedPeopleCount sigue
    // siendo "una fila = una persona", sin cambiar su comportamiento). MAX()
    // ignora los NULL: si CUALQUIERA de sus fotos de consulta quedó atada a
    // una suscripción, la fila sale con esa suscripción — "esta persona sí
    // dejó un contacto" es lo único que report.js necesita para clasificar.
    async queryPhotoPeople() {
      return all(
        `SELECT ph.person_id AS person_id, p.normalized_name AS normalized_name, MAX(ph.subscription_id) AS subscription_id
         FROM photos ph JOIN people p ON p.id = ph.person_id
         WHERE ph.kind = 'query'
         GROUP BY ph.person_id, p.normalized_name`
      );
    },
    // Todas las filas de match_log — solo similarity y surface, la materia
    // prima del desglose por tramo de confianza. report.js hace la
    // clasificación en JS (una sola fuente de verdad para los tramos, en vez
    // de repetir los límites en dos motores de SQL distintos).
    async matchLogSimilarityRows() {
      return all('SELECT similarity, surface FROM match_log');
    },

    async insertPet({ species, petName, description, contact }) {
      return one(
        'INSERT INTO pets (species, pet_name, description, contact) VALUES ($1, $2, $3, $4) RETURNING *',
        [species, petName || null, description || null, contact || null]
      );
    },
    async getPet(id) {
      return one('SELECT * FROM pets WHERE id = $1', [id]);
    },
    async markPetResolved(id) {
      return one('UPDATE pets SET resolved_at = now() WHERE id = $1 RETURNING *', [id]);
    },
    async insertPetPhoto({ petId, kind, species, subscriptionId, content, contentType }) {
      return one(
        `INSERT INTO pet_photos (pet_id, kind, species, subscription_id, content, content_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, pet_id, kind, species, content_type, created_at`,
        [petId || null, kind, species, subscriptionId || null, content, contentType]
      );
    },
    async getPetPhoto(id) {
      return one('SELECT * FROM pet_photos WHERE id = $1', [id]);
    },
    async setPetPhotoEmbedding(photoId, embedding, model) {
      await pool.query('UPDATE pet_photos SET embedding = $1, embedding_model = $2 WHERE id = $3', [
        JSON.stringify(embedding),
        model || null,
        photoId
      ]);
    },
    async setPetPhotoThumbnail(photoId, { small, contentType }) {
      await pool.query('UPDATE pet_photos SET thumb = $1, thumb_type = $2 WHERE id = $3', [
        small,
        contentType,
        photoId
      ]);
    },
    async clearPetPhotoContent(photoId) {
      await pool.query('UPDATE pet_photos SET content = $1 WHERE id = $2', [Buffer.alloc(0), photoId]);
    },
    // LEFT JOIN porque una foto 'query' no tiene pet_id (nadie sabe todavía de
    // qué mascota es) — el filtro de resuelta solo debe aplicar cuando SÍ hay
    // una mascota asociada (siempre el caso para 'report', nunca para
    // 'query'). Mostrar como "posible avistamiento" a una mascota que ya se
    // marcó como encontrada no ayuda a nadie.
    async petPhotosForMatching(kind, species) {
      return all(
        `SELECT pet_photos.id, pet_photos.pet_id, pet_photos.embedding, pet_photos.embedding_model
         FROM pet_photos
         LEFT JOIN pets ON pets.id = pet_photos.pet_id
         WHERE pet_photos.kind = $1 AND pet_photos.species = $2 AND pet_photos.embedding IS NOT NULL
           AND (pet_photos.pet_id IS NULL OR pets.resolved_at IS NULL)`,
        [kind, species]
      );
    },
    // Mismo patrón que photosMissingDerivatives (personas): sin el filtro de
    // contenido no vacío, una foto 'query' que ya se procesó y se le borraron
    // los bytes queda "pendiente" para siempre y ahoga la red de seguridad
    // con filas que ya no se pueden comparar.
    async petPhotosMissingEmbedding(limit) {
      return all(
        'SELECT * FROM pet_photos WHERE embedding IS NULL AND octet_length(content) > 0 ORDER BY id LIMIT $1',
        [limit]
      );
    },
    async petPhotosForPet(petId) {
      return all(
        `SELECT id, pet_id, content_type, thumb_type FROM pet_photos
         WHERE kind = 'report' AND pet_id = $1 ORDER BY id`,
        [petId]
      );
    },
    // El listado público — espejo de missingPeople: toda mascota sin
    // resolved_at, más reciente primero.
    async lostPets(limit) {
      return all('SELECT * FROM pets WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT $1', [limit]);
    },
    // Espejo de reunitedCount — el contador de buenas noticias.
    async reunitedPetsCount() {
      const r = await one('SELECT COUNT(*)::int AS n FROM pets WHERE resolved_at IS NOT NULL', []);
      return r.n;
    },
    // Una foto por mascota para el listado — espejo de reportPhotosForPeople:
    // la primera foto 'report' que además tenga miniatura gana, para no
    // repetir en el listado el problema de una foto ilegible sin thumb.
    async petPhotosForPets(petIds) {
      if (!petIds.length) return [];
      return all(
        `SELECT id, pet_id, content_type, thumb_type FROM pet_photos
         WHERE kind = 'report' AND pet_id = ANY($1)
         ORDER BY pet_id, (thumb_type IS NULL), id`,
        [petIds]
      );
    },

    async close() {
      await pool.end();
      await lockPool.end();
    }
  };
}

module.exports = { createPostgresAdapter };
