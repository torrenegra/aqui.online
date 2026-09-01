// SQLite adapter — local development and tests. Zero setup, single file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// #78: the public-registry sweep (source='aggregator') used to push a person
// already marked "Localizada" in the source as status='safe' here, even when
// nobody had ever reported them missing through this app. That row would then
// win "latest status" and count toward the public reunited counter — someone
// who never passed through encontrados.co, inflating a number families and
// rescuers read as this app's own signal.
//
// The feed no longer produces that row going forward (see toUpdate in
// src/sources/colombiatebusca.js), but rows synced before that fix already
// exist. Rather than delete history, "latest status" pretends they were never
// written: whatever real status came before resurfaces, and a person with no
// other update simply has none — neither missing nor reunited.
const AGGREGATOR_SAFE_EXCLUSION = `WHERE NOT (u.source = 'aggregator' AND u.status = 'safe')`;

// La llave que se guarda en suppressed_external_ids nunca es el valor crudo
// (#192, revisión de cris-pappcorn, punto 2 — mismo comentario que en
// src/store/postgres.js): la llave la elige quien empuja, y hay integradores
// que usan el nombre completo de la persona como external_id cuando la
// fuente no trae otro identificador. Guardar el hash mantiene la misma
// garantía de bloqueo por igualdad exacta sin dejar un dato personal en la
// única tabla del esquema que a propósito no se borra nunca.
function hashExternalId(externalId) {
  return crypto.createHash('sha256').update(String(externalId), 'utf8').digest('hex');
}

async function createSqliteAdapter(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      phonetic_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_people_normalized ON people(normalized_name);

    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('safe','injured','missing','deceased','unknown')),
      message TEXT,
      location TEXT,
      lat REAL,
      lng REAL,
      contact TEXT,
      source TEXT NOT NULL CHECK (source IN ('web','whatsapp','api','aggregator','rescate')),
      reporter TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_updates_person ON updates(person_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id ON updates(external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1,
      verify_token TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(person_id, channel, address)
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_person ON subscriptions(person_id);

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
      content BLOB NOT NULL,
      content_type TEXT NOT NULL,
      face_id TEXT,
      face_detail TEXT,
      thumb BLOB,
      thumb_type TEXT,
      thumb_large BLOB,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_photos_face ON photos(face_id);
    CREATE INDEX IF NOT EXISTS idx_photos_subscription ON photos(subscription_id);

    -- Bitácora de coincidencias y de envíos (#116, PR 3 — SOLO esquema; PR 4
    -- escribe en estas tablas). Mismas reglas que en Postgres (ver el
    -- comentario ahí): sin PII, retención heredada de ON DELETE CASCADE sobre
    -- people(id), created_at + índice para un cleanup job futuro.
    CREATE TABLE IF NOT EXISTS match_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      face_id TEXT NOT NULL,
      similarity REAL,
      surface TEXT NOT NULL CHECK (surface IN ('rescate','report','api')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_match_log_person ON match_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_match_log_created ON match_log(created_at);

    -- La columna "source" dice QUIÉN ejecutó el contacto, no por qué medio
    -- (eso es "channel"); "external_ref" es la llave de idempotencia del
    -- registrador externo, siempre un DIGESTO, nunca el id crudo del proveedor. El
    -- porqué completo de las dos columnas está en postgres.js — acá va el
    -- mismo esquema para que los dos motores no se separen.
    CREATE TABLE IF NOT EXISTS contact_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','relevo')),
      result TEXT NOT NULL CHECK (result IN ('enviado','fallido','rechazado')),
      source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','operador')),
      external_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_log_person ON contact_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_contact_log_created ON contact_log(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_log_external_ref
      ON contact_log(external_ref) WHERE external_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contact_log_source ON contact_log(source, created_at);

    -- Constancia de un borrado pedido por la persona misma (#191). Mismas
    -- reglas que en Postgres, y ahí está el comentario largo con el por qué:
    -- es la única tabla que a propósito NO cuelga de people(id) —tiene que
    -- sobrevivir a la fila—, guarda solo la llave y la fecha, y su alcance es
    -- la misma llave externa y nada más.
    CREATE TABLE IF NOT EXISTS suppressed_external_ids (
      external_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS pets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      pet_name TEXT,
      description TEXT,
      contact TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS pet_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
      address TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verify_token TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    CREATE TABLE IF NOT EXISTS pet_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_id INTEGER REFERENCES pets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('report','query')),
      species TEXT NOT NULL CHECK (species IN ('dog','cat')),
      subscription_id INTEGER REFERENCES pet_subscriptions(id) ON DELETE CASCADE,
      content BLOB NOT NULL,
      content_type TEXT NOT NULL,
      embedding TEXT,
      embedding_model TEXT,
      thumb BLOB,
      thumb_type TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      submitted_name TEXT NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_merge_log_person ON merge_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_merge_log_created ON merge_log(created_at);

    -- ===== COLA DE REVISIÓN DE ESTADO (#190) — inicio =====================
    -- La constancia de la salida humana de una ficha en unknown: quién
    -- decidió, cuándo y con qué evidencia. Mismas reglas que en Postgres, y
    -- ahí está el comentario largo con el por qué —incluido por qué NO se
    -- creó un estado público nuevo, por qué el marcador de "probable" es
    -- PRIVADO y vive acá, y por qué el enlace de la noticia sigue viviendo en
    -- updates.source_url—. created_at va como TEXTO ISO en los dos
    -- motores, con el mismo formato: un TIMESTAMPTZ volvería como Date en
    -- Postgres y como string acá.
    CREATE TABLE IF NOT EXISTS status_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      probable_status TEXT NOT NULL CHECK (probable_status IN ('safe','deceased')),
      evidence_note TEXT NOT NULL,
      author TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      update_id INTEGER REFERENCES updates(id) ON DELETE SET NULL,
      recipients INTEGER,
      notify_mode TEXT CHECK (notify_mode IN ('direct','relay')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_status_review_person ON status_review(person_id);
    CREATE INDEX IF NOT EXISTS idx_status_review_created ON status_review(created_at);
    -- ===== COLA DE REVISIÓN DE ESTADO (#190) — fin ========================

    -- Llaves de API por persona. Mismas reglas que en Postgres (ver el
    -- comentario largo de allá): de la llave solo se guarda su SHA-256 y un
    -- prefijo para poder distinguirlas en una lista, label es un ALIAS público
    -- y no el nombre legal de nadie, y una fila no se borra: se revoca.
    -- revoked_at y last_used_at van como TEXTO ISO en los dos motores porque se
    -- comparan en JS. created_by guarda la CUENTA DE OPERACIÓN que emitió la
    -- llave —un correo de ADMIN_EMAILS, nunca texto libre— y el por qué de esa
    -- distinción está en el comentario de Postgres.
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('operator','ingest')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      created_by TEXT,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    -- Quién escribió qué. Misma forma y misma retención que
    -- match_log/contact_log: solo ids y enums, y ON DELETE CASCADE sobre
    -- people(id). api_key_id nulo = la llave de entorno API_KEY, que no tiene
    -- fila. Ver el comentario de Postgres para la dependencia que crea: esta
    -- bitácora es también la prueba de qué llave creó cada ficha.
    CREATE TABLE IF NOT EXISTS api_write_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      update_id INTEGER REFERENCES updates(id) ON DELETE CASCADE,
      api_key_id INTEGER REFERENCES api_keys(id),
      action TEXT NOT NULL CHECK (action IN ('crear','actualizar')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_write_log_person ON api_write_log(person_id);
    CREATE INDEX IF NOT EXISTS idx_api_write_log_update ON api_write_log(update_id);
    CREATE INDEX IF NOT EXISTS idx_api_write_log_key_created ON api_write_log(api_key_id, created_at);
  `);

  // Older dev databases: add the GPS columns if missing.
  for (const col of ['lat', 'lng']) {
    try {
      db.exec(`ALTER TABLE updates ADD COLUMN ${col} REAL`);
    } catch { /* already exists */ }
  }
  try {
    db.exec('ALTER TABLE updates ADD COLUMN contact TEXT');
  } catch { /* already exists */ }
  // De dónde salió la afirmación: el enlace a la noticia que confirma que una
  // persona apareció. Un `safe` con enlace carga su propia prueba; uno sin
  // enlace es una afirmación que nadie puede verificar.
  try {
    db.exec('ALTER TABLE updates ADD COLUMN source_url TEXT');
  } catch { /* already exists */ }
  // Detection geometry (bounding box + landmarks) for the public overlay, and
  // the face thumbnail the public listing loads instead of the full photo.
  for (const col of ['face_detail TEXT', 'thumb BLOB', 'thumb_type TEXT', 'thumb_large BLOB']) {
    try {
      db.exec(`ALTER TABLE photos ADD COLUMN ${col}`);
    } catch { /* already exists */ }
  }
  // El reclamo de rescate NO es lo mismo que la propiedad del número, y venían
  // compartiendo el booleano `verified`. Una suscripción que el bot verificó
  // con SUSCRIBIR prueba que el número es de quien escribe; no dice nada sobre
  // si esa persona tiene a alguien al lado. Se separan:
  //   rescue_state      null | 'asked' | 'confirmed' | 'reported'
  //   rescue_similarity el % de la coincidencia que originó la pregunta, para
  //                     que el relevo no llegue sin el único dato que distingue
  //                     un rescate real de un parecido.
  // `rescue_asked_at` va como TEXTO ISO en los dos motores a propósito: la
  // ventana de 72 h se calcula en JS, y un TIMESTAMPTZ en Postgres volvería
  // como Date mientras SQLite devuelve string — dos formas del mismo dato es
  // exactamente la clase de diferencia que se cuela en producción y no en las
  // pruebas. `created_at` no sirve para esto: una fila de seguidor creada la
  // semana pasada puede recibir la pregunta hoy.
  for (const col of ['rescue_state TEXT', 'rescue_similarity REAL', 'rescue_asked_at TEXT']) {
    try {
      db.exec(`ALTER TABLE subscriptions ADD COLUMN ${col}`);
    } catch { /* already exists */ }
  }
  // Older dev databases: add external_id if missing. Note: SQLite can't widen
  // an existing CHECK constraint via ALTER TABLE, so a pre-existing local
  // ./data/encontrados.db still rejects source='aggregator' until it's recreated
  // (delete the file — it's dev-only and gets rebuilt on next start).
  try {
    db.exec('ALTER TABLE updates ADD COLUMN external_id TEXT');
  } catch { /* already exists */ }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_updates_external_id ON updates(external_id) WHERE external_id IS NOT NULL'
  );
  // Bases de desarrollo anteriores a que contact_log distinguiera QUIÉN
  // contactó. Las filas que ya existen son todas de la app y ese es el
  // DEFAULT, así que la columna no afirma nada nuevo sobre nadie. Igual que
  // con `source` de updates: SQLite no puede agregar el CHECK por ALTER, así
  // que una base local vieja acepta cualquier texto en la columna hasta que
  // se recree — la validación real vive en la ruta, que es por donde entra
  // todo lo externo.
  for (const col of ['source TEXT NOT NULL DEFAULT \'app\'', 'external_ref TEXT']) {
    try {
      db.exec(`ALTER TABLE contact_log ADD COLUMN ${col}`);
    } catch { /* already exists */ }
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_log_external_ref ON contact_log(external_ref) WHERE external_ref IS NOT NULL'
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_contact_log_source ON contact_log(source, created_at)');

  // El WHERE compartido por los tres agregados de contact_log — mismo
  // contrato que `contactLogWhere` en postgres.js (ver ahí el porqué de que
  // el default sea 'app' y no "todo").
  function contactLogWhere({ since, source } = {}) {
    const conds = [];
    const params = [];
    if (since) {
      conds.push('created_at >= ?');
      params.push(since);
    }
    if (source) {
      conds.push('source = ?');
      params.push(source);
    }
    return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  const getPersonStmt = db.prepare('SELECT * FROM people WHERE id = ?');

  // Serializa, por external_id, el chequeo-y-escritura de una admisión
  // (src/report-admission.js) contra la ventana en la que `deletePerson`
  // suprime esa misma llave (#192, condición de carrera señalada por
  // coderabbitai). Un mutex en memoria alcanza acá porque este adaptador vive
  // en UN solo proceso — SQLite es dev/tests, nunca varias instancias sobre el
  // mismo archivo (a diferencia de Postgres en Vercel, que necesita un lock a
  // nivel de base) — así que la garantía es la misma; solo la implementación
  // no tiene por qué serlo. `externalIdLocks` guarda, por llave, la cola de lo
  // que ya está encolado; se borra la entrada cuando nadie quedó esperando
  // detrás, para no crecer para siempre en una instancia que vive días.
  const externalIdLocks = new Map();
  function lockExternalId(externalId, fn) {
    const previous = externalIdLocks.get(externalId) || Promise.resolve();
    const result = previous.then(fn, fn);
    const marker = result.catch(() => {});
    externalIdLocks.set(externalId, marker);
    marker.finally(() => {
      if (externalIdLocks.get(externalId) === marker) externalIdLocks.delete(externalId);
    });
    return result;
  }
  // Pide los locks de una lista de llaves, de una en una, y solo entonces
  // corre `fn` — así dos borrados con llaves en común nunca se traban entre sí
  // por pedirlas en órdenes distintos (acá siempre van ordenadas primero).
  function lockExternalIds(keys, fn) {
    if (!keys.length) return fn();
    const [key, ...rest] = keys;
    return lockExternalId(key, () => lockExternalIds(rest, fn));
  }

  // Las firmas faciales atadas a una o más suscripciones. Hay que leerlas
  // ANTES de borrar la suscripción: `photos.subscription_id` también cascada
  // (ver el esquema arriba), y con la suscripción se va la única fila que
  // decía qué firma retirar de Rekognition — el mismo problema que
  // `faceIdsForPerson` ya resuelve para el borrado de persona (#162).
  function faceIdsForSubscriptionIds(subscriptionIds) {
    if (!subscriptionIds.length) return [];
    const marks = subscriptionIds.map(() => '?').join(',');
    return db
      .prepare(`SELECT face_id FROM photos WHERE subscription_id IN (${marks}) AND face_id IS NOT NULL`)
      .all(...subscriptionIds)
      .map((r) => r.face_id);
  }


  return {
    async withExternalIdLock(externalId, fn) {
      return lockExternalId(externalId, fn);
    },
    async insertPerson(fullName, normalized, phonetic) {
      const info = db
        .prepare('INSERT INTO people (full_name, normalized_name, phonetic_name) VALUES (?, ?, ?)')
        .run(fullName, normalized, phonetic);
      return getPersonStmt.get(info.lastInsertRowid);
    },
    async getPerson(id) {
      return getPersonStmt.get(id);
    },
    async allPeople(limit) {
      return db.prepare('SELECT id, full_name FROM people ORDER BY id LIMIT ?').all(limit);
    },
    async updatePersonName(id, fullName) {
      db.prepare('UPDATE people SET full_name = ? WHERE id = ?').run(fullName, id);
    },
    async exactByNormalized(normalized) {
      return db.prepare('SELECT * FROM people WHERE normalized_name = ?').get(normalized);
    },
    // Dev-scale: return everyone and let the JS scorer rank. The Postgres
    // adapter prefilters with pg_trgm instead.
    async candidatePeople() {
      return db.prepare('SELECT * FROM people').all();
    },
    // Same idempotent-upsert contract as the Postgres adapter: a repeated
    // externalId updates the existing row's status/message/location/lat/lng/
    // reporter/contact instead of inserting a duplicate. Without externalId,
    // behavior is unchanged.
    async insertUpdate(personId, { status, message, location, lat, lng, source, sourceUrl, reporter, contact, externalId }) {
      const extId = externalId || null;
      const info = db
        .prepare(
          `INSERT INTO updates (person_id, status, message, location, lat, lng, source, source_url, reporter, contact, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE SET
             status = excluded.status,
             message = excluded.message,
             location = excluded.location,
             lat = excluded.lat,
             lng = excluded.lng,
             source_url = excluded.source_url,
             reporter = excluded.reporter,
             contact = excluded.contact`
        )
        .run(
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
          extId
        );
      // lastInsertRowid isn't reliable on the DO UPDATE path (no new row is
      // inserted), so look up by external_id (guaranteed unique) when we have one.
      if (extId) {
        return db.prepare('SELECT * FROM updates WHERE external_id = ?').get(extId);
      }
      return db.prepare('SELECT * FROM updates WHERE id = ?').get(info.lastInsertRowid);
    },
    async updatesForPerson(personId) {
      return db
        .prepare('SELECT * FROM updates WHERE person_id = ? ORDER BY created_at DESC, id DESC')
        .all(personId);
    },
    // "El estado actual de una persona es el de su update más reciente" (ver
    // POST /rescate/aviso en src/routes/web.js) es la regla que lee el bot de
    // WhatsApp, GET /api/people y las tarjetas de duplicados — no solo el
    // home. Sin el mismo filtro, esas tres superficies seguirían anunciando
    // "Localizada" por una fila del agregador que el home ya ignora.
    async latestUpdate(personId) {
      return db
        .prepare(
          `SELECT * FROM updates WHERE person_id = ? AND NOT (source = 'aggregator' AND status = 'safe')
           ORDER BY created_at DESC, id DESC LIMIT 1`
        )
        .get(personId);
    },
    // Everyone currently reported missing, most recent report first.
    // Everyone whose LATEST update is 'missing' — not everyone who was EVER
    // reported missing. Under the old "has ANY missing update" filter a person
    // later confirmed alive stayed on the list forever: their family sees them
    // still listed as missing, and rescuers keep looking for someone who is
    // already home.
    // The `reports` count this query used to return is gone: nothing rendered
    // it, and keeping it meant a second full GROUP BY over every update on the
    // busiest page of the site.
    async missingPeople(limit) {
      return db
        .prepare(
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
           LIMIT ?`
        )
        .all(limit);
    },
    // How many people whose LATEST status is 'safe' — the reunited counter.
    // Same "latest status per person" logic as missingPeople above.
    async reunitedCount() {
      return db
        .prepare(
          `WITH latest AS (
             SELECT u.person_id, u.status,
                    ROW_NUMBER() OVER (PARTITION BY u.person_id ORDER BY u.created_at DESC, u.id DESC) AS rn
             FROM updates u
             ${AGGREGATOR_SAFE_EXCLUSION}
           )
           SELECT COUNT(*) AS n FROM latest WHERE rn = 1 AND status = 'safe'`
        )
        .get().n;
    },
    async recentUpdates(limit) {
      return db
        .prepare(
          `SELECT u.*, p.full_name FROM updates u JOIN people p ON p.id = u.person_id
           ORDER BY u.created_at DESC, u.id DESC LIMIT ?`
        )
        .all(limit);
    },
    async subscriptionsForAddress(channel, address) {
      return db
        .prepare('SELECT * FROM subscriptions WHERE channel = ? AND address = ? ORDER BY id DESC')
        .all(channel, address);
    },
    async findSubscription(personId, channel, address) {
      return db
        .prepare('SELECT * FROM subscriptions WHERE person_id = ? AND channel = ? AND address = ?')
        .get(personId, channel, address);
    },
    async insertSubscription(personId, channel, address, verified, verifyToken) {
      db.prepare(
        'INSERT OR IGNORE INTO subscriptions (person_id, channel, address, verified, verify_token) VALUES (?, ?, ?, ?, ?)'
      ).run(personId, channel, address, verified ? 1 : 0, verifyToken || null);
      return this.findSubscription(personId, channel, address);
    },
    async setSubscriptionRescue(id, { state, similarity, askedAt } = {}) {
      db.prepare(
        `UPDATE subscriptions
            SET rescue_state = ?,
                rescue_similarity = COALESCE(?, rescue_similarity),
                rescue_asked_at = COALESCE(?, rescue_asked_at)
          WHERE id = ?`
      ).run(state || null, similarity == null ? null : Number(similarity), askedAt || null, id);
      return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    },
    async verifySubscriptionByToken(token) {
      const sub = db.prepare('SELECT * FROM subscriptions WHERE verify_token = ?').get(token);
      if (!sub) return null;
      db.prepare('UPDATE subscriptions SET verified = 1 WHERE id = ?').run(sub.id);
      return { ...sub, verified: 1 };
    },
    // Igual que deletePerson en src/routes/api.js: los face_id se leen ANTES
    // de borrar la fila, porque la cascada de subscription_id se la lleva
    // junto con la única forma de saber qué firma retirar (#162).
    async deleteSubscriptionByToken(token) {
      const sub = db.prepare('SELECT * FROM subscriptions WHERE verify_token = ?').get(token);
      if (!sub) return null;
      const faceIds = faceIdsForSubscriptionIds([sub.id]);
      db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
      return { ...sub, faceIds };
    },
    async deleteSubscription(personId, channel, address) {
      const sub = db
        .prepare('SELECT id FROM subscriptions WHERE person_id = ? AND channel = ? AND address = ?')
        .get(personId, channel, address);
      if (!sub) return { count: 0, faceIds: [] };
      const faceIds = faceIdsForSubscriptionIds([sub.id]);
      const info = db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
      return { count: info.changes, faceIds };
    },
    async deleteSubscriptionsForAddress(channel, address) {
      const subs = db
        .prepare('SELECT id FROM subscriptions WHERE channel = ? AND address = ?')
        .all(channel, address);
      if (!subs.length) return { count: 0, faceIds: [] };
      const ids = subs.map((s) => s.id);
      const faceIds = faceIdsForSubscriptionIds(ids);
      // Por id, no por (channel, address): ver el comentario equivalente en
      // postgres.js — una suscripción creada entre el SELECT y este DELETE no
      // debe quedar alcanzada por él (#162).
      const marks = ids.map(() => '?').join(',');
      const info = db.prepare(`DELETE FROM subscriptions WHERE id IN (${marks})`).run(...ids);
      return { count: info.changes, faceIds };
    },
    async subscriptionsForPerson(personId) {
      return db.prepare('SELECT * FROM subscriptions WHERE person_id = ?').all(personId);
    },
    async getSubscriptionById(id) {
      return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    },
    async insertPhoto({ personId, kind, updateId, subscriptionId, content, contentType }) {
      const info = db
        .prepare(
          'INSERT INTO photos (person_id, kind, update_id, subscription_id, content, content_type) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(personId, kind, updateId || null, subscriptionId || null, content, contentType);
      return db
        .prepare(
          'SELECT id, person_id, kind, update_id, subscription_id, content_type, face_id, created_at FROM photos WHERE id = ?'
        )
        .get(info.lastInsertRowid);
    },
    async setPhotoFaceId(photoId, faceId) {
      db.prepare('UPDATE photos SET face_id = ? WHERE id = ?').run(faceId, photoId);
    },
    async setPhotoFaceDetail(photoId, detail) {
      db.prepare('UPDATE photos SET face_detail = ? WHERE id = ?').run(
        detail ? JSON.stringify(detail) : null,
        photoId
      );
    },
    async setPhotoThumbnails(photoId, { small, large, contentType }) {
      db.prepare('UPDATE photos SET thumb = ?, thumb_large = ?, thumb_type = ? WHERE id = ?').run(
        small,
        large,
        contentType,
        photoId
      );
    },
    async getPhoto(id) {
      return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    },
    // Just enough to render a face plate. Deliberately NOT getPhoto: that one
    // does SELECT *, dragging the full image and both thumbnails out of the
    // database to read two columns.
    async reportPhotoMeta(id) {
      return db
        .prepare(
          "SELECT id, person_id, kind, content_type, face_id, face_detail, thumb_type FROM photos WHERE id = ? AND kind = 'report'"
        )
        .get(id);
    },
    // One photo per person for the public listing: the earliest report photo
    // that still has bytes and, preferably, a thumbnail to show.
    async reportPhotosForPeople(personIds) {
      if (!personIds.length) return [];
      const marks = personIds.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT id, person_id, content_type, face_id, face_detail, thumb_type FROM photos
           WHERE kind = 'report' AND person_id IN (${marks}) AND length(content) > 0
           ORDER BY person_id, (thumb IS NULL), (thumb_large IS NULL), (face_detail IS NULL), id`
        )
        .all(...personIds);
    },
    // Report photos still missing a thumbnail or the detection geometry. A row
    // whose face_detail holds only a crop (thumbnailed while Rekognition was
    // down) has no "box" yet, so it stays in this set until it gets one — but
    // a row marked no_face is done: Rekognition already looked and found no
    // face, so retrying it every run would burn DetectFaces forever.
    async photosMissingDerivatives(limit) {
      return db
        .prepare(
          `SELECT * FROM photos
           WHERE kind = 'report' AND length(content) > 0
             AND (thumb IS NULL OR thumb_large IS NULL
                  OR face_detail IS NULL
                  OR (face_detail NOT LIKE '%"box"%' AND face_detail NOT LIKE '%"no_face"%'))
           ORDER BY id LIMIT ?`
        )
        .all(limit);
    },
    // Rescue photos are never kept: only the face signature survives.
    async clearPhotoContent(photoId) {
      db.prepare('UPDATE photos SET content = ? WHERE id = ?').run(Buffer.alloc(0), photoId);
    },
    // La misma foto exacta ya indexada para esta persona: su face_id, para
    // reusarlo en vez de sumar una firma nueva por la misma cara (#160 — un
    // reporte re-empujado con la misma foto multiplicaba firmas). face_id
    // IS NOT NULL ya excluye a la fila que se está procesando ahora mismo,
    // que todavía no tiene el suyo escrito.
    async photoFaceIdForContent(personId, kind, content) {
      const row = db
        .prepare(
          `SELECT face_id FROM photos
           WHERE person_id = ? AND kind = ? AND face_id IS NOT NULL AND content = ?
           LIMIT 1`
        )
        .get(personId, kind, content);
      return row ? row.face_id : null;
    },
    async photosByFaceIds(faceIds) {
      if (!faceIds.length) return [];
      const marks = faceIds.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT id, person_id, kind, update_id, subscription_id, face_id FROM photos WHERE face_id IN (${marks})`
        )
        .all(...faceIds);
    },
    // Metadatos de toda foto con firma facial — sin contenido ni derivados:
    // esto alimenta un conteo, no una pantalla.
    async indexedPhotos() {
      return db
        .prepare('SELECT id, person_id, kind, face_id FROM photos WHERE face_id IS NOT NULL ORDER BY id')
        .all();
    },
    // Las firmas faciales de las fotos de una persona. Hay que leerlas ANTES de
    // borrarla: la cascada se lleva las filas de `photos` y con ellas el único
    // registro de qué retirar de la colección de Rekognition.
    async faceIdsForPerson(personId) {
      return db
        .prepare('SELECT face_id FROM photos WHERE person_id = ? AND face_id IS NOT NULL')
        .all(personId)
        .map((r) => r.face_id);
    },
    // Mismo contrato que en Postgres (ver el comentario ahí): `atSubjectRequest`
    // marca el borrado del ARCO, el único que deja constancia, y las dos
    // escrituras van en una transacción para que no exista el estado
    // intermedio. Las llaves se leen ANTES del DELETE porque la cascada se
    // lleva las filas de `updates` y con ellas la única copia.
    async deletePerson(id, { atSubjectRequest = false } = {}) {
      const suppress = db.prepare(
        'INSERT OR IGNORE INTO suppressed_external_ids (external_id) VALUES (?)'
      );
      const externalIdsStmt = db.prepare(
        'SELECT DISTINCT external_id FROM updates WHERE person_id = ? AND external_id IS NOT NULL'
      );
      const remove = db.prepare('DELETE FROM people WHERE id = ?');
      const run = db.transaction(() => {
        const person = getPersonStmt.get(id);
        if (!person) return null;
        let suppressed = 0;
        if (atSubjectRequest) {
          // Se guarda el hash, nunca la llave cruda (#192, revisión de
          // cris-pappcorn, punto 2) — ver el comentario de hashExternalId,
          // arriba.
          for (const row of externalIdsStmt.all(id)) {
            suppressed += suppress.run(hashExternalId(row.external_id)).changes;
          }
        }
        remove.run(id);
        return { ...person, suppressed_external_ids: suppressed };
      });

      // Instantánea de qué llaves podría suprimir este borrado — solo para
      // saber CUÁLES pedir; no es garantía de que sigan siendo las mismas para
      // cuando la transacción de arriba corra. Una llave que aparezca después
      // de esta foto no tiene lock que la proteja todavía, pero la relectura
      // de `externalIdsStmt` YA ADENTRO de la transacción la encuentra y la
      // suprime igual. Lo que eso no cierra —más angosto que la condición de
      // carrera de #192— es una admisión que en ese mismo instante le agrega a
      // ESTA MISMA persona una llave que nadie pidió suprimir todavía.
      const snapshot = atSubjectRequest
        ? externalIdsStmt.all(id).map((r) => r.external_id).sort()
        : [];

      // El MISMO lock que sostiene la admisión entre su chequeo y su escritura
      // (#192) — si el borrado no lo pide antes de escribir, un re-envío que
      // ya pasó el chequeo puede quedar en el aire mientras este borrado
      // suprime y se va, y terminar escribiendo igual: la ficha revive.
      return lockExternalIds(snapshot, () => run());
    },
    // La consulta que hace valer la constancia, en el ingreso. Por llave
    // exacta sobre el hash (#192, revisión de cris-pappcorn, punto 2): una
    // llave distinta para la misma persona no está suprimida, y ese es el
    // límite honesto del mecanismo.
    async isExternalIdSuppressed(externalId) {
      return !!db
        .prepare('SELECT 1 AS uno FROM suppressed_external_ids WHERE external_id = ?')
        .get(hashExternalId(externalId));
    },
    async counts() {
      const n = (sql) => db.prepare(sql).get().n;
      return {
        people: n('SELECT COUNT(*) AS n FROM people'),
        updates: n('SELECT COUNT(*) AS n FROM updates'),
        subscriptions: n('SELECT COUNT(*) AS n FROM subscriptions'),
        subscriptions_verified: n('SELECT COUNT(*) AS n FROM subscriptions WHERE verified = 1'),
        photos: n('SELECT COUNT(*) AS n FROM photos'),
        photos_indexed: n('SELECT COUNT(*) AS n FROM photos WHERE face_id IS NOT NULL'),
        photos_report: n("SELECT COUNT(*) AS n FROM photos WHERE kind = 'report'"),
        photos_query: n("SELECT COUNT(*) AS n FROM photos WHERE kind = 'query'")
      };
    },
    async photosMissingFaceId(limit) {
      return db
        .prepare('SELECT * FROM photos WHERE face_id IS NULL ORDER BY id LIMIT ?')
        .all(limit);
    },
    async countQueryPhotos(subscriptionId) {
      return db
        .prepare("SELECT COUNT(*) AS n FROM photos WHERE subscription_id = ? AND kind = 'query'")
        .get(subscriptionId).n;
    },

    // Bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación;
    // las tablas las creó PR 3). Cada escritura la envuelve `src/logbook.js`
    // en un try/catch — acá abajo no hace falta duplicar esa protección.
    async insertMatchLog({ personId, updateId, faceId, similarity, surface }) {
      db.prepare(
        'INSERT INTO match_log (person_id, update_id, face_id, similarity, surface) VALUES (?, ?, ?, ?, ?)'
      ).run(personId, updateId ?? null, faceId, similarity ?? null, surface);
    },
    // Mismo contrato que el adapter de Postgres (ver ahí los comentarios):
    // la app escribe sin `source` y cae al default 'app'; el registrador
    // externo pasa 'operador' + su digesto + la fecha real del contacto, y
    // recibe `{ inserted }` para distinguir un registro nuevo de un
    // reintento.
    async insertContactLog({ personId, updateId, channel, result, source = 'app', externalRef = null, createdAt = null }) {
      const info = db
        .prepare(
          `INSERT INTO contact_log (person_id, update_id, channel, result, source, external_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))
           ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`
        )
        .run(personId, updateId ?? null, channel, result, source, externalRef, createdAt);
      return { inserted: info.changes > 0 };
    },
    async deleteContactLogByRef(externalRef) {
      const info = db
        .prepare("DELETE FROM contact_log WHERE external_ref = ? AND source = 'operador'")
        .run(externalRef);
      return info.changes > 0;
    },
    async familyContactLogByPerson(personId) {
      return db
        .prepare(
          `SELECT channel, result, source, created_at
           FROM contact_log
           WHERE person_id = ? AND channel <> 'relevo'
           ORDER BY created_at ASC, id ASC`
        )
        .all(personId);
    },
    // #150: registro de cada auto-fusión por nombre — ver el comentario del
    // esquema sobre por qué esta tabla sí guarda un nombre.
    async insertMergeLog({ personId, submittedName, score }) {
      db.prepare(
        'INSERT INTO merge_log (person_id, submitted_name, score) VALUES (?, ?, ?)'
      ).run(personId, submittedName, score);
    },
    // ===== COLA DE REVISIÓN DE ESTADO (#190) — inicio =====================
    // Todos los que están en la cola: las personas cuyo ÚLTIMO estado es
    // `unknown`. La cola no necesita una bandera de "resuelto" — resolver
    // escribe una fila nueva en `updates`, el último estado deja de ser
    // `unknown` y la ficha sale de acá sola.
    //
    // Mismo filtro de "último estado" que missingPeople (AGGREGATOR_SAFE_
    // EXCLUSION): sin él, esta cola y el listado público no estarían mirando
    // el mismo estado.
    //
    // Devuelve la evidencia con la que se va a juzgar, no solo el nombre:
    // message, location y source_url de esa última fila. Todo esto se muestra
    // detrás del gate de /admin.
    async unknownPeople(limit) {
      return db
        .prepare(
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
           LIMIT ?`
        )
        .all(limit);
    },
    async insertStatusReview({ personId, probableStatus, evidenceNote, author, resolved, updateId, recipients, notifyMode }) {
      const info = db
        .prepare(
          `INSERT INTO status_review
             (person_id, probable_status, evidence_note, author, resolved, update_id, recipients, notify_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          personId,
          probableStatus,
          evidenceNote,
          author,
          resolved ? 1 : 0,
          updateId ?? null,
          Number.isFinite(recipients) ? recipients : null,
          notifyMode ?? null
        );
      return db.prepare('SELECT * FROM status_review WHERE id = ?').get(info.lastInsertRowid);
    },
    async statusReviewsForPerson(personId) {
      return db
        .prepare('SELECT * FROM status_review WHERE person_id = ? ORDER BY created_at DESC, id DESC')
        .all(personId);
    },
    // ===== COLA DE REVISIÓN DE ESTADO (#190) — fin ========================
    // --- Llaves de API por persona -------------------------------------
    // Espejo exacto del adapter de Postgres; el POR QUÉ de cada una está allá.
    // La llave en claro no entra acá nunca: quien emite hashea antes de llamar.
    async insertApiKey({ label, keyHash, keyPrefix, scope, createdBy }) {
      const info = db
        .prepare(
          'INSERT INTO api_keys (label, key_hash, key_prefix, scope, created_by) VALUES (?, ?, ?, ?, ?)'
        )
        .run(label, keyHash, keyPrefix, scope, createdBy || null);
      return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(info.lastInsertRowid);
    },
    // Devuelve la fila incluso revocada, a propósito: quien verifica necesita
    // distinguir "no existe" de "se revocó".
    async apiKeyByHash(keyHash) {
      return db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);
    },
    async apiKeysList() {
      return db
        .prepare(
          `SELECT id, label, key_prefix, scope, created_at, created_by, revoked_at, last_used_at
           FROM api_keys ORDER BY id`
        )
        .all();
    },
    async revokeApiKey(id, revokedAt) {
      const info = db
        .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, id);
      if (!info.changes) return undefined;
      return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
    },
    async touchApiKeyUsed(id, nowIso, staleBeforeIso) {
      db.prepare(
        `UPDATE api_keys SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
      ).run(nowIso, id, staleBeforeIso);
    },
    async insertApiWriteLog({ personId, updateId, apiKeyId, action }) {
      db.prepare(
        'INSERT INTO api_write_log (person_id, update_id, api_key_id, action) VALUES (?, ?, ?, ?)'
      ).run(personId, updateId ?? null, apiKeyId ?? null, action);
    },
    // Gana la fila MÁS ANTIGUA de la bitácora: quien creó la ficha, no quien la
    // tocó de último. Sin NULLS LAST (que SQLite solo entiende desde 3.30): no
    // hace falta, porque la única forma de que api_key_id venga nulo acá es que
    // no exista NINGUNA fila de bitácora, y entonces el LEFT JOIN devuelve
    // exactamente una.
    async apiWriteOwnerByExternalId(externalId) {
      return db
        .prepare(
          `SELECT u.id AS update_id, l.api_key_id
           FROM updates u
           LEFT JOIN api_write_log l ON l.update_id = u.id
           WHERE u.external_id = ?
           ORDER BY l.id ASC
           LIMIT 1`
        )
        .get(externalId);
    },
    async countApiWrites(apiKeyId, sinceIso) {
      return db
        .prepare('SELECT COUNT(*) AS n FROM api_write_log WHERE api_key_id = ? AND created_at >= ?')
        .get(apiKeyId, sinceIso).n;
    },
    // Cuenta total y por superficie. `since` (ISO) filtra a lo escrito desde
    // ahí — se usa para la línea de "cambio desde el reporte anterior" del
    // correo operativo; sin `since`, es el acumulado histórico completo.
    async matchLogCounts({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      const total = db.prepare(`SELECT COUNT(*) AS n FROM match_log ${where}`).get(...params).n;
      const bySurface = {};
      for (const surface of ['rescate', 'report', 'api']) {
        const w = since ? 'WHERE created_at >= ? AND surface = ?' : 'WHERE surface = ?';
        const p = since ? [since, surface] : [surface];
        bySurface[surface] = db.prepare(`SELECT COUNT(*) AS n FROM match_log ${w}`).get(...p).n;
      }
      return { total, ...bySurface };
    },
    // Una fila por (channel, result) — el correo pivotea esto en su propia
    // tabla. `since` con el mismo significado que en matchLogCounts.
    async contactLogCounts({ since, source = 'app' } = {}) {
      const { clause, params } = contactLogWhere({ since, source });
      return db
        .prepare(
          `SELECT channel, result, COUNT(*) AS count FROM contact_log ${clause} GROUP BY channel, result ORDER BY channel, result`
        )
        .all(...params);
    },

    // Series por día (#116, PR 6 — el panel). `since` (ISO) siempre viene del
    // llamador ya calculado en JS — nunca aritmética de fechas en SQL — para
    // no depender de qué funciones de fecha trae la versión de SQLite en
    // este runtime. `date(created_at)` sí parsea bien el ISO con 'T'/'Z' que
    // ya usa el resto de este esquema.
    //
    // El corte de "día" es el de Bogotá, no UTC (hotfix): toda la superficie
    // (el pie del correo, el cron, el panel) habla en hora de Bogotá, y entre
    // las 19:00 y la medianoche Bogotá caía en el día SIGUIENTE bajo UTC —
    // cinco horas de cada día contadas en la fila equivocada. El modificador
    // '-5 hours' es el mismo desplazamiento fijo que usa el resto del repo
    // (Colombia no tiene horario de verano — ver report.js) y debe quedar
    // igual al `AT TIME ZONE 'America/Bogota'` del adapter de Postgres:
    // mismo corte de día en los dos motores.
    async matchLogDaily({ since } = {}) {
      const where = since ? 'WHERE created_at >= ?' : '';
      const params = since ? [since] : [];
      return db
        .prepare(
          `SELECT date(created_at, '-5 hours') AS day, COUNT(*) AS count FROM match_log ${where} GROUP BY day ORDER BY day`
        )
        .all(...params);
    },
    async contactLogDaily({ since, source = 'app' } = {}) {
      const { clause, params } = contactLogWhere({ since, source });
      return db
        .prepare(
          `SELECT date(created_at, '-5 hours') AS day, result, COUNT(*) AS count FROM contact_log ${clause} GROUP BY day, result ORDER BY day`
        )
        .all(...params);
    },

    // El primer registro de cada tabla (hotfix post-#127/#128 — "los ceros
    // pre-instrumentación son una mentira por omisión"). Antes de esta fecha
    // la bitácora no existía: no es que no pasó nada, es que no se medía.
    // null si la tabla está vacía — todavía no hay ningún registro.
    async matchLogEarliest() {
      const r = db.prepare('SELECT MIN(created_at) AS min FROM match_log').get();
      return r.min || null;
    },
    async contactLogEarliest({ source = 'app' } = {}) {
      const { clause, params } = contactLogWhere({ source });
      const r = db.prepare(`SELECT MIN(created_at) AS min FROM contact_log ${clause}`).get(...params);
      return r.min || null;
    },

    // Cifras del panel #132 — mismo contrato que el adapter de Postgres (ver
    // ahí el porqué de cada una).
    async updatesBeyondFirstBySource() {
      return db
        .prepare(
          `WITH ranked AS (
             SELECT source, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at ASC, id ASC) AS rn
             FROM updates
           )
           SELECT source, COUNT(*) AS n FROM ranked WHERE rn > 1 GROUP BY source`
        )
        .all();
    },
    // `subscription_id` es nuevo (#132, punto 5) — mismo contrato que el
    // adapter de Postgres (ver ahí el porqué del GROUP BY en vez de DISTINCT).
    async queryPhotoPeople() {
      return db
        .prepare(
          `SELECT ph.person_id AS person_id, p.normalized_name AS normalized_name, MAX(ph.subscription_id) AS subscription_id
           FROM photos ph JOIN people p ON p.id = ph.person_id
           WHERE ph.kind = 'query'
           GROUP BY ph.person_id, p.normalized_name`
        )
        .all();
    },
    async matchLogSimilarityRows() {
      return db.prepare('SELECT similarity, surface FROM match_log').all();
    },

    async insertPet({ species, petName, description, contact }) {
      const info = db
        .prepare('INSERT INTO pets (species, pet_name, description, contact) VALUES (?, ?, ?, ?)')
        .run(species, petName || null, description || null, contact || null);
      return db.prepare('SELECT * FROM pets WHERE id = ?').get(info.lastInsertRowid);
    },
    async getPet(id) {
      return db.prepare('SELECT * FROM pets WHERE id = ?').get(id);
    },
    async markPetResolved(id) {
      db.prepare("UPDATE pets SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(id);
      return db.prepare('SELECT * FROM pets WHERE id = ?').get(id);
    },
    async insertPetPhoto({ petId, kind, species, subscriptionId, content, contentType }) {
      const info = db
        .prepare(
          'INSERT INTO pet_photos (pet_id, kind, species, subscription_id, content, content_type) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(petId || null, kind, species, subscriptionId || null, content, contentType);
      return db
        .prepare('SELECT id, pet_id, kind, species, content_type, created_at FROM pet_photos WHERE id = ?')
        .get(info.lastInsertRowid);
    },
    async getPetPhoto(id) {
      return db.prepare('SELECT * FROM pet_photos WHERE id = ?').get(id);
    },
    async setPetPhotoEmbedding(photoId, embedding, model) {
      db.prepare('UPDATE pet_photos SET embedding = ?, embedding_model = ? WHERE id = ?').run(
        JSON.stringify(embedding),
        model || null,
        photoId
      );
    },
    async setPetPhotoThumbnail(photoId, { small, contentType }) {
      db.prepare('UPDATE pet_photos SET thumb = ?, thumb_type = ? WHERE id = ?').run(small, contentType, photoId);
    },
    async clearPetPhotoContent(photoId) {
      db.prepare('UPDATE pet_photos SET content = ? WHERE id = ?').run(Buffer.alloc(0), photoId);
    },
    // LEFT JOIN porque una foto 'query' no tiene pet_id (nadie sabe todavía de
    // qué mascota es) — el filtro de resuelta solo debe aplicar cuando SÍ hay
    // una mascota asociada (siempre el caso para 'report', nunca para
    // 'query'). Mostrar como "posible avistamiento" a una mascota que ya se
    // marcó como encontrada no ayuda a nadie.
    async petPhotosForMatching(kind, species) {
      return db
        .prepare(
          `SELECT pet_photos.id, pet_photos.pet_id, pet_photos.embedding, pet_photos.embedding_model
           FROM pet_photos
           LEFT JOIN pets ON pets.id = pet_photos.pet_id
           WHERE pet_photos.kind = ? AND pet_photos.species = ? AND pet_photos.embedding IS NOT NULL
             AND (pet_photos.pet_id IS NULL OR pets.resolved_at IS NULL)`
        )
        .all(kind, species);
    },
    // Mismo patrón que photosMissingDerivatives (personas): sin el filtro de
    // contenido no vacío, una foto 'query' que ya se procesó y se le borraron
    // los bytes (nunca va a tener embedding si el matcher estaba caído en su
    // momento y nadie corrió el backfill mientras tanto) queda "pendiente"
    // para siempre y ahoga la red de seguridad con filas que ya no se pueden
    // comparar.
    async petPhotosMissingEmbedding(limit) {
      return db
        .prepare('SELECT * FROM pet_photos WHERE embedding IS NULL AND length(content) > 0 ORDER BY id LIMIT ?')
        .all(limit);
    },
    async petPhotosForPet(petId) {
      return db
        .prepare(
          "SELECT id, pet_id, content_type, thumb_type FROM pet_photos WHERE kind = 'report' AND pet_id = ? ORDER BY id"
        )
        .all(petId);
    },
    // El listado público — espejo de missingPeople: toda mascota sin
    // resolved_at, más reciente primero.
    async lostPets(limit) {
      return db
        .prepare('SELECT * FROM pets WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT ?')
        .all(limit);
    },
    // Espejo de reunitedCount — el contador de buenas noticias.
    async reunitedPetsCount() {
      return db.prepare('SELECT COUNT(*) AS n FROM pets WHERE resolved_at IS NOT NULL').get().n;
    },
    // Una foto por mascota para el listado — espejo de reportPhotosForPeople:
    // la primera foto 'report' que además tenga miniatura gana, para no
    // repetir en el listado el problema de una foto ilegible sin thumb.
    async petPhotosForPets(petIds) {
      if (!petIds.length) return [];
      const marks = petIds.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT id, pet_id, content_type, thumb_type FROM pet_photos
           WHERE kind = 'report' AND pet_id IN (${marks})
           ORDER BY pet_id, (thumb_type IS NULL), id`
        )
        .all(...petIds);
    },

    async close() {
      db.close();
    }
  };
}

module.exports = { createSqliteAdapter };
