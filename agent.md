# Instrucciones para agentes (AI y humanos)

## Regla principal: SIEMPRE publicar a producción

**Todo cambio debe quedar en producción inmediatamente.** Después de cualquier
modificación al código:

1. Corre las pruebas: `npm test` (deben quedar en verde).
2. Haz commit con mensaje claro y push a la rama de trabajo.
3. **Abre el PR de inmediato y llévalo a `main`.** `main` está protegida: todo
   entra por PR, con CI en verde y la aprobación de un mantenedor distinto de
   quien lo escribió; el push directo ya no existe. Vercel despliega `main` a
   producción automáticamente, así que **mergear *es* desplegar**.
4. No dejes trabajo "pendiente de deploy": si está en `main`, está vivo; si no
   está en `main`, no existe.

Este es un servicio de emergencias: un cambio útil que no está publicado no
ayuda a nadie. La otra cara de la misma moneda: lo que cambia comportamiento de
cara al usuario, el esquema de la base o privacidad **espera a que lo decida una
persona** — ver [`CONTRIBUTING.md`](CONTRIBUTING.md) y [`CLAUDE.md`](CLAUDE.md).

## Contexto del proyecto

- **encontrados.co**: conecta a quien RESCATA a una persona con quien la BUSCA.
  - Rescatista: sube una foto de la persona que tiene al lado → reconocimiento
    facial → ve quién la busca y su contacto. La foto NUNCA se guarda: se borra
    tras indexar su firma facial. Solo los rescatistas pueden registrar avisos.
  - Familia: reporta un desaparecido (1–3 fotos, nombre, lugar, contacto).
    NO puede registrar alertas ni ver resultados de búsqueda.
  - El contacto de quien reporta solo se muestra a un rescatista tras una
    coincidencia facial; nunca en páginas públicas.
- Toda la interfaz y los mensajes al usuario son **en español**.
- Canales activos: web, API REST y **WhatsApp** (activo desde el 12-ago-2026;
  antes estaba implementado pero dormido y la interfaz no podía nombrarlo).
  (Telegram fue retirado.)
- WhatsApp — la regla que manda sobre todas las demás en ese canal:
  **por WhatsApp NUNCA sale el contacto de una familia.** Ni en texto libre
  dentro de la ventana de 24 h, ni en ningún modo de envío. Un aviso con
  contacto que iba a un número se convierte en relevo al buzón del operador
  (`notifyFaceMatch` en `src/facematch.js`).
  - Meta solo entrega **plantillas aprobadas** para lo que iniciamos nosotros, y
    lo que dicen esas plantillas ES el contrato del flujo: el código se ajusta a
    ellas, no al revés. No inventes plantillas ni cambies sus parámetros.
    - `confirmacion_rescatista_encontrados` (`es_CO`, `{{1}}` = nombre) —
      pregunta si la persona está con quien recibe el mensaje o si lo que hizo
      fue reportarla. Se responde **SÍ** o **REPORTE**, escrito, exacto.
    - `ficha_fuente_rescatista_encontrados` (`es_CO`, `{{1}}` = nombre,
      `{{2}}` = URL de la ficha) — lo único que sale tras un SÍ: manda a marcar
      a la persona como localizada en el registro público de origen, que es
      quien sí tiene el contacto de la familia.
  - Una ficha reportada por la web no tiene registro de origen y **no hay
    plantilla aprobada para ese caso**: ahí no se le manda nada al rescatista y
    decide el operador.
  - `es` y `es_CO` son idiomas distintos para Meta: pedir el que no es equivale
    a que no llegue nada.
- Fotos — dos reglas distintas según quién las sube:
  - **Rescatista** (`kind='query'`): la foto NUNCA se guarda ni se muestra. Se
    compara, se indexa su firma facial y los bytes se borran de inmediato. Solo
    sobreviven los metadatos faciales.
  - **Reporte de desaparecido** (`kind='report'`): la foto SÍ se guarda y SÍ se
    publica, en la lista de personas desaparecidas, con los puntos de detección
    facial dibujados encima (`facePlate()` en `src/html.js`). Es el propósito
    del reporte: que un rescatista reconozca a la persona.
  - `GET /photo/:id` (foto completa) y `GET /photo/:id/thumb` (miniatura del
    rostro) sirven únicamente fotos `kind='report'`. Nunca ampliarlos a fotos
    de rescatistas.
- La lista pública NUNCA carga la foto completa: usa la miniatura cuadrada de
  240px recortada sobre el rostro (`src/thumbs.js`), ~3 KB en vez de cientos.
  Y ni siquiera esa se descarga sola si la conexión es mala: la regla vive en
  `thumbnailsAreAffordable()` (`src/html.js`), que se testea en Node y se
  manda al navegador con `toString()` — hay una sola copia, no la dupliques.
  En 2G, 3G lento o con ahorro de datos se muestra un botón «Ver foto» y la
  decisión es del visitante. Mucha gente consulta esto con una barra de señal.
- Poner al día fotos ya guardadas (miniatura + geometría) — tres formas, todas
  idempotentes, y la geometría de una foto ya indexada siempre con
  `DetectFaces`, nunca con `IndexFaces` (reindexarla duplicaría el rostro):
  - **Solo**: cada visita al inicio dispara un barrido de 5 fotos como mucho,
    una vez por minuto por instancia, después de enviar la página.
  - **`/fotos/actualizar`**: se abre en el navegador, SIN API key. Es seguro
    sin ella porque no avisa a nadie, no indexa, y solo toca fotos a las que
    les falta algo: cuando no falta nada no hace ni cuesta nada.
  - **`POST /api/reindex`**: reindexa además las fotos sin firma facial y
    manda los avisos pendientes; por eso esa sí exige la API key.
- Colombia Te Busca: el formulario de reporte **ya no** ofrece «Reportar también
  en ColombiaTeBusca.com». La casilla existió hasta agosto de 2026 y mandaba el
  reporte a `AVISO_EMAIL` para que un operador llenara su formulario a mano —
  ese registro no tiene forma programática de recibir un reporte—. El paso
  humano nunca se cerró: 119 familias la marcaron y ninguna se publicó, así que
  se retiró la casilla en vez de sostener una promesa que no se cumplía
  ([#84](https://github.com/encontradosco/encontrados/issues/84)). Con ella se
  fueron las casillas que solo servían a su formulario (nombre de quien
  reporta, departamento, municipio y lugar), y con eso **un reporte web ya no
  guarda `reporter`** — la columna sigue viva y la siguen llenando el API y los
  agregadores, y `maskReporter()` la sigue publicando reducida. Nada se borró:
  las solicitudes ya recibidas siguen en el buzón y en `contact_log` bajo el
  canal `relevo`. Si su equipo abre una vía programática, la casilla vuelve;
  la invitación a integrarse sigue al pie de cada página (`src/html.js`).
- **Aviso de rescatista** (`matchContactBlock()` + `POST /rescate/aviso`): cuando
  la ficha que coincide no trae contacto de la familia —las importadas de
  registros públicos no lo traen— el rescatista deja su teléfono y dónde está la
  persona. El aviso entra a la línea de tiempo con estado `missing` a propósito
  (un avistamiento sin verificar no puede sacar a nadie de la lista) y el dato
  viaja en `contact`, que nunca sale público. De ahí en adelante **no hay nada
  automático**: se tría, se le pregunta al rescatista si está con la persona o si
  la estaba reportando, y si confirma se le pasa la ficha del registro de origen
  para que la actualice allá — ese registro es quien tiene el contacto de la
  familia, nosotros no. El flujo completo y el criterio de triage aplicable a
  mano: [`docs/avisos-de-rescatista.md`](docs/avisos-de-rescatista.md).
- El contacto de quien reporta se pide en DOS casillas, teléfono y correo, con
  la misma obligación de siempre: al menos una. Se juntan en la columna
  `contact` (`composeContact()` en `src/routes/web.js`), que sigue siendo texto
  libre y que nada parsea — es lo que se le muestra a un rescatista tras una
  coincidencia. `POST /report` sigue aceptando el campo `contact` a secas.
- `/ideas` y `/bug`: los dos enlaces del pie. Lo que se envía se abre como issue
  en GitHub (`GITHUB_TOKEN`); sin token cae a correo a `AVISO_EMAIL` para
  abrirlo a mano — nunca se pierde. Los formularios avisan que **es público**
  y mandan a `/report` a quien en realidad busca a alguien: un issue queda
  indexado para siempre y ahí no puede terminar el teléfono de una familia.
- Producción: Vercel (función serverless única + Postgres/Neon). Dev/tests: SQLite.
- Remitente de correo fijo: `a@torrenegra.com` (SendGrid).
- Suscripciones por correo requieren verificación; toda alerta lleva enlace de baja.
- **Modo relevo (`NOTIFY_MODE`, por omisión `relay`).** Ningún aviso a un
  tercero sale solo: se manda a `AVISO_EMAIL` para que una persona verifique al
  destinatario y lo enrute. La razón es dura: entregarle el contacto de una
  familia a un desconocido que dice haber rescatado a alguien es un vector de
  extorsión, y el aviso de coincidencia facial lleva ese contacto en el cuerpo.
  Se releva `notifySubscribers()` (`src/notify.js`, correo y WhatsApp) y
  `notifyFaceMatch()` (`src/facematch.js`). **La verificación de correo no se
  releva**: va al dueño de la dirección confirmando lo que él mismo pidió, no
  protege a nadie y sin ella no hay suscripción verificada. El relevo es
  explícito en la capa de notificación, **no dentro de `sendEmail()`**: un
  interceptor global se llevaría también la verificación y cualquier correo que
  se agregue después, y el bug sería invisible. `NOTIFY_MODE=direct` devuelve el
  envío directo; `GET /api/diag` dice en qué modo está.
- El matching difuso de nombres vive en `src/names.js` + `people.js`; los umbrales
  (0.85 merge / 0.55 búsqueda) están calibrados — no los cambies sin pruebas.

## Mapa del código

Express 4 con HTML renderizado en el servidor a punta de template strings. No
hay framework de frontend ni paso de build: lo que se lee es lo que corre.

- `api/index.js` — entrada serverless. Construye la app una sola vez por
  instancia y reusa la promesa; todo lo demás cuelga de ahí.
- `src/server.js` — `createApp(adapter?, matcher?)`: estáticos, `/health`,
  `/api`, `/webhooks`, la web, el 404 y el manejador de errores. Los dos
  parámetros existen para las pruebas; producción lo llama sin ellos.
- `src/store/index.js` — elige el motor. Si aparece cualquier variable de
  conexión a Postgres (`DATABASE_URL`, `POSTGRES_URL`, `STORAGE_URL`… y de
  hecho cualquier `*_POSTGRES_URL` que inyecte la integración) usa
  `store/postgres.js`; si no, `store/sqlite.js`.
- `src/store/postgres.js` y `src/store/sqlite.js` — el mismo contrato sobre dos
  motores. El esquema se crea solo al arrancar (`CREATE TABLE IF NOT EXISTS` +
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`): **no hay carpeta de migraciones**,
  así que una columna nueva se agrega ahí y hay que agregarla en los dos. Desde
  #116 (PR 3) también viven ahí `match_log` y `contact_log` — la bitácora de
  coincidencias y de envíos, solo IDs y enums, sin PII, con `ON DELETE CASCADE`
  sobre `people(id)` (misma retención que el resto del esquema). Desde PR 4
  tienen escritor: `insertMatchLog`/`insertContactLog` (escritura) y
  `matchLogCounts`/`contactLogCounts` (agregados, con `since` opcional para
  ventanas — los usa el reporte por correo). Desde #191 vive ahí también
  `suppressed_external_ids`, la constancia de un borrado pedido por la persona
  misma: guarda solo el **hash sha256** de la llave externa (nunca el valor
  crudo — la llave la elige quien empuja, y puede traer un nombre) y la
  fecha, y es **la única tabla que a propósito NO cuelga de `people(id)`** —
  tiene que sobrevivir a la fila, porque su trabajo es impedir que la ficha
  vuelva a entrar sola. La admisión y el borrado a solicitud serializan el
  chequeo-y-escritura de una misma llave con un advisory lock **transaccional**
  por `external_id` (`withExternalIdLock` en los dos adaptadores) — no de
  sesión: bajo el endpoint pooled de Neon, que es el único que
  `findPostgresUrl()` puede resolver, un lock de sesión y su unlock pueden
  caer en backends distintos y quedar tomado para siempre.
  `contact_log` distingue además **quién** contactó: `source` es `'app'` (lo
  que mandó el software) u `'operador'` (lo que una persona del equipo mandó
  por fuera de la app y registró después). **Los tres agregados de
  `contact_log` filtran por `source` y su default es `'app'`**, así que un
  llamador que no diga nada sigue viendo la serie de siempre — pedir todo hay
  que escribirlo (`source: null`). No es cosmético: mezclar las dos vuelve
  incontestable la única pregunta que la gráfica de canales sirve para
  responder. `external_ref` (índice único parcial) es la llave de idempotencia
  del registro externo, siempre un digesto. Ver
  [`docs/contactos-fuera-de-la-app.md`](docs/contactos-fuera-de-la-app.md).
- `src/logbook.js` — `logMatch`/`logContact` (#116, PR 4): la capa que
  instrumenta `facematch.js` y `notify.js` escribiendo en `match_log`/
  `contact_log`. Regla de oro, aplicada acá una sola vez para todo el árbol de
  llamadas: **un fallo escribiendo la bitácora nunca tumba ni retrasa el flujo
  principal** — cada función atrapa su propio error y sigue.
- `src/people.js` — `createStore(adapter)`, la capa de dominio encima del
  adaptador (búsqueda, merge, suscripciones, fotos). Exporta `STATUSES` y
  `SOURCES`.
- `src/names.js` — normalización, clave fonética, distancia de edición y
  `matchScore`. También `titleCaseName`, que es lo que hace legible la lista
  pública cuando alguien escribió el nombre en mayúsculas sostenidas.
- `src/faces.js` — el proveedor de reconocimiento: Rekognition, o `nullMatcher`
  cuando no hay credenciales. Nunca tumba la app; degrada.
- `src/facematch.js` — la orquestación encima del proveedor: `processPhoto`,
  `identifyRescuedPerson` (el flujo del rescatista), `forgetPersonFaces` (el
  borrado) y los dos barridos, `backfillUnindexedPhotos` y
  `backfillPhotoDerivatives`. Cada camino que produce una coincidencia real
  (`matchStoredPhoto`, `identifyRescuedPerson`) y cada intento de aviso
  (`notifyFaceMatch`, `requestRescueConfirmation`, `resolveRescueAnswer`) llama
  a `src/logbook.js` (#116, PR 4).
- `src/thumbs.js` — el recorte cuadrado sobre el rostro, con `sharp`, en dos
  tamaños (240 para la lista, 480 para la ficha).
- `src/html.js` — `layout()`, `esc()`, `facePlate()`, `statusBadge()` y los
  scripts que van al navegador como texto.
- `src/routes/web.js` — todas las páginas: `/`, `/report`, `/rescate`,
  `/person/:id`, `/photo/:id{,/thumb,/face}`, `/verify`, `/unsubscribe`,
  `/ideas`, `/bug`, `/privacidad`, `/terminos`, `/api-doc` y
  `/mantenimiento` ≡ `/fotos/actualizar`. Es el archivo más grande del repo.
  `/person/:id` tiene **un solo bloque condicionado a quién mira**: la
  bitácora de avisos a quien reportó (`contactHistoryBlock`), que solo se
  renderiza con sesión de administración —`readSession(req)`— y que para
  cualquier otro visitante no cambia ni un byte de la página. Cuando aparece,
  la respuesta lleva `Cache-Control: private, no-store`: dejó de ser la misma
  para todo el mundo. La versión pública de ese bloque **no existe** y es una
  decisión aparte (cambia lo que lee una familia y abre superficie de
  ingeniería social) — no la agregues sin issue.
- `src/routes/api.js` — el JSON: `/api/people`, `/api/updates`,
  `/api/people/:id/subscriptions`, `/api/reindex`, `/api/match-stats`,
  `/api/contact-log` y los `/api/diag*`.
  `POST /api/contact-log` registra un contacto que se hizo **por fuera de la
  app** (un correo desde el buzón de alguien del equipo, un WhatsApp desde su
  teléfono). Tres garantías que están en el código, no en un párrafo:
  fuerza `source = 'operador'` —un llamador externo no puede escribir en la
  serie de la app ni queriendo—; no acepta ningún campo que identifique al
  destinatario; y exige que `ref` sea un digesto SHA-256, porque el `wamid`
  de WhatsApp lleva el teléfono del destinatario codificado adentro y crudo
  no puede entrar. `DELETE /api/contact-log/:ref` lo retira, y solo puede
  tocar filas `source = 'operador'`. Detalle:
  [`docs/contactos-fuera-de-la-app.md`](docs/contactos-fuera-de-la-app.md).
- `src/routes/webhooks.js` — WhatsApp (Meta Cloud API), dormido. El `GET` es el
  handshake y es una lectura; el `POST` escribe en la base y exige la
  credencial del relevo (`WHATSAPP_RELAY_SECRET`, cabecera `X-Relay-Secret`).
- `src/adminAuth.js` + `src/routes/admin.js` — "Sign in with Vercel" para
  `/admin` (#116, PR 5): login, callback, sesión propia (cookie firmada con
  HMAC, sin tabla en la base — igual de stateless que `verify_token`), logout
  y el middleware `requireAdminSession`, montado sobre `/admin` y
  `/api/admin/*`. El sitio sigue público; solo esas dos rutas quedan detrás
  del gate. Sin `ADMIN_EMAILS` configurada, cerrado para todos — ver
  `docs/admin-auth-setup.md` para el setup de dashboard que le toca a un
  humano.
- `src/adminStats.js` — el panel de estadísticas (#116, PR 6), montado en
  `GET /admin/stats`. SOLO cifras agregadas — misma clase de dato que ya es
  pública en `GET /api/diag`; nunca un nombre, contacto, `person_id`,
  `face_id` ni `update_id`. Reusa `table()`/`section()`/`pivotContact()`/…
  de `src/report.js` para que el correo y el panel nunca puedan
  contradecirse. Detrás de `statsGate` (`src/adminAuth.js`): cerrado por
  `requireAdminSession` salvo que `PUBLIC_STATS=1` lo abra temporalmente
  (decisión del operador, mientras el auth de Vercel termina de
  configurarse) — `noindex` + banner visible cuando está abierto. El
  drill-down por ID que resolvería nombres/contactos en vivo **no existe
  todavía**; cuando exista, nace en `/api/admin/*` con `requireAdminSession`
  — ese prefijo NUNCA lee `PUBLIC_STATS`.
  **Hotfix post-#127:** el embudo (la sección que depende de
  `computeMatchStats`, el recompute contra Rekognition — medido en 28,7s en
  prod con ~110 fotos) casi tumbó `/admin/stats` con un 504
  (`maxDuration` estaba en 30s). `GET /admin/stats` ahora SOLO llama a
  `gatherCheapReportData` (`src/report.js` — bitácora + conteos + serie de
  7 días, todo con índice, nunca Rekognition); el embudo se pide aparte,
  después de renderizar, a `GET /admin/stats/funnel` (mismo `statsGate`,
  fragmento HTML inyectado por un script vanilla inline). Si ese fragmento
  falla o expira, la sección lo dice — nunca un cero que parezca un dato
  real. `gatherReportData` (el correo, que sí puede pagar el recompute
  completo porque corre en su propio cron) ahora compone
  `gatherCheapReportData` + `gatherFunnelStats`, y mide cuánto tarda esa
  segunda parte — el correo trae esa duración en el pie, y una corrida que
  pase de 60s deja un `console.warn` con umbral explícito.
  **Hotfix siguiente (investigación del panel mostrando 4 coincidencias / 0
  envíos):** confirmado en el código, no supuesto — `/rescate` deja el
  correo y el WhatsApp del rescatista como **opcionales** (`rescueForm()` en
  `src/routes/web.js`, y el checkbox "solo búsqueda"), y
  `notifyRescuerOfMatches` (`src/facematch.js`) solo llama a
  `notifyFaceMatch`/`requestRescueConfirmation` cuando existe una
  suscripción — sin correo ni teléfono no hay a quién avisar, así que 0
  envíos con coincidencias reales es el comportamiento correcto: el
  rescatista ya vio el contacto de la familia EN PANTALLA (esa es la
  entrega), y `match_log` (superficie `rescate`) ya captura exactamente eso.
  No es un hueco de instrumentación — verificado con evidencia de código,
  no con una corrida.
  **Hotfix "los ceros pre-instrumentación mienten por omisión" +
  visualización:** `store.matchLogEarliest()`/`contactLogEarliest()` (`MIN
  (created_at)`, null si la tabla está vacía) le dan a
  `gatherCheapReportData`/`gatherDailySeries` (`src/report.js`) un punto de
  corte real — antes de esa fecha no es "cero", es "sin instrumentación", y
  el panel lo muestra como `—` (nunca 0) con `instrumentedSinceNote()`
  declarando desde cuándo se mide, en el correo y en el panel. `src/charts.js`
  agrega columnas SVG generadas en el servidor (sin dependencias, sin CDN, sin
  framework) para la serie de 7 días, envíos por canal y el embudo — paleta
  de estado (bueno/alerta/crítico) para enviado/fallido/rechazado, un único
  azul para series de un solo valor, `role="img"` + `aria-label` agregado en
  cada SVG, y las tablas de siempre debajo — nunca reemplazadas — para quien
  lee sin JS o con lector de pantalla.
- `src/privacy.js` — `publicUpdate()` y `maskReporter()`: la única puerta por
  la que una fila de `updates` sale a una respuesta pública.
- `src/duplicates.js` — detección de reportes repetidos. Siempre consultiva.
- `src/github.js` (issues de `/ideas` y `/bug`), `src/notify.js` (SendGrid y
  WhatsApp), `src/bot.js` (motor conversacional), `src/env.js` (carga `.env`).

Trampas al editar, todas con cicatriz:

- Express 4 no atrapa errores de una función async. Toda ruta async va envuelta
  en el `wrap()` que ya está definido en el archivo.
- El HTML se arma concatenando strings: **todo dato que venga de afuera pasa por
  `esc()`**. No hay nada más protegiéndolo.
- `matcher.enabled` es un getter sobre un matcher que se construye perezosamente.
  Hay que `await matcher.ensureReady()` **antes** de leerlo: en un arranque en
  frío da `false` con Rekognition perfectamente disponible, y ese camino guarda
  la foto sin indexar.
- `src/env.js` es una foto congelada al cargar el módulo, pero de paso vuelca el
  `.env` dentro de `process.env`. Lo que pueda cambiar en caliente —o lo que una
  prueba necesite borrar para ejercitar el camino "sin configurar"— se lee de
  `process.env`, no del snapshot. Así lo hacen `src/github.js` y `/api/diag`.
- Nunca devuelvas una fila de `updates` cruda en una respuesta pública: pasa por
  `publicUpdate()`. `contact` no sale nunca y `reporter` sale enmascarado.
- `SOURCES` (lo que acepta el API) son cuatro; el `CHECK` de la tabla acepta
  además `'rescate'`, que solo escribe el flujo web del rescatista. Un `source`
  desconocido en `POST /api/updates` no es un error: cae a `'api'`.
- `external_id` tiene índice único parcial y el insert es un upsert. Por eso el
  reintento es idempotente — y por eso la fila puede terminar en una persona
  distinta a la que devolvió `findOrCreatePerson`; hay que resolver el dueño
  real antes de notificar (está comentado en `POST /api/updates`).
- Ese upsert es idempotente **mientras la fila exista**. Si la ficha se borró,
  el `ON CONFLICT` no tiene con qué chocar y un re-envío insertaba de nuevo, con
  la cara reindexada y sin dejar rastro. Por eso el ingreso consulta
  `suppressed_external_ids` **antes de crear nada**, y vive en
  `src/report-admission.js` y no en el handler del API: ahí protege a las tres
  puertas y a la que se agregue mañana. El alcance es la misma llave y nada más
  — un reporte sin `external_id` no se bloquea nunca (#191).

## Correr y probar

```bash
npm install
npm run dev     # SQLite en ./data/encontrados.db → http://localhost:3000
npm test
```

`npm run dev` es `node --watch src/server.js`: sin `DATABASE_URL` levanta SQLite
local, y sin credenciales de AWS levanta el `nullMatcher`. O sea que el flujo
del rescatista se puede abrir, pero no va a encontrar a nadie. Para trabajar en
matching de verdad hacen falta credenciales; para todo lo demás, no.

Las pruebas son `node --test` sobre `test/**/*.test.js` — sin framework, sin
mocks mágicos. Las convenciones, que conviene calcar al agregar una:

- Cada prueba levanta su propia app con `createApp(await createSqliteAdapter(':memory:'), matcher)`
  y la escucha en el puerto 0. Nada se comparte entre archivos.
- El matcher es el `nullMatcher` de `src/faces.js`, o uno falso local cuando la
  prueba sí necesita coincidencias (`test/rescue.test.js` tiene el patrón: bytes
  idénticos = mismo rostro, y una geometría con la forma exacta que devuelve
  Rekognition).
- `test/helpers.js` levanta servidores HTTP de mentira para SendGrid y GitHub y
  los enchufa por `SENDGRID_API_BASE` / `GITHUB_API_BASE`. Existen para que las
  pruebas recorran el camino de "sí se mandó", no solo el de la falla — y para
  que un `GITHUB_TOKEN` en el shell de alguien no abra issues de verdad.
- CI corre lo mismo en Node 22, en cada PR y en `main` (`.github/workflows/ci.yml`).

Si `npm test` muere con `ERR_DLOPEN_FAILED` o un `NODE_MODULE_VERSION` que no
cuadra, es `better-sqlite3` compilado para otro Node: `npm rebuild better-sqlite3`
y vuelve a correr. No es el cambio, es el entorno.

## Invariantes de serverless

`vercel.json` reenvía **todo** a `/api`, así que la aplicación entera es una
sola función. De ahí salen tres reglas que no son negociables:

- **El disco es de solo lectura salvo `/tmp`.** Nada se escribe al lado del
  código. Si no hay Postgres, `store/index.js` cae a un SQLite en `/tmp` que
  sirve para no quedar caídos, pero **no persiste entre invocaciones**;
  `/api/diag` lo reporta como `sqlite (efímero)`.
- **El estado en memoria es por instancia, y hay varias.** El barrido de fotos
  del inicio (una tanda por minuto) y el tope de `/ideas` y `/bug` (10 cada 10
  minutos) son techos blandos: N instancias son N cubetas. Están así a
  propósito y comentados como tales — sirven para acotar una ráfaga de una
  instancia, no para defender nada. Un contador que de verdad tenga que ser uno
  solo va en la base de datos.
- **Una instancia vive mucho y se congela sin avisar.** Por eso el matcher
  reintenta inicializarse (máximo una vez por minuto) en vez de quedarse
  apagado para siempre, y por eso todo trabajo de fondo es idempotente y
  reanudable: si la instancia se congela a mitad del barrido, la siguiente
  visita lo retoma sin duplicar nada.
- **`maxDuration` (`vercel.json`, hoy 120s en plan Pro) es de la función
  entera, no de una ruta.** Cualquier request que corra dentro de
  `api/index.js` — una página que un navegador está esperando, o el cron del
  correo — comparte el mismo presupuesto. `computeMatchStats` (el recompute
  del embudo contra Rekognition, #117) es lo único caro de esta app y medía
  28,7s en prod con ~110 fotos, creciendo con el tamaño del registro: **nunca
  debe correr adentro del camino síncrono de una página** — así fue el 504 de
  `/admin/stats` que motivó subir `maxDuration` de 30 a 120 y diferir el
  embudo a `GET /admin/stats/funnel` (hotfix post-#127, ver `src/adminStats.js`).
  El cron (`POST /api/report/send`, `src/report.js`) sí puede pagarlo porque
  corre solo, sin nadie esperando — pero corre contra el MISMO techo, y el
  correo ahora trae su propia duración en el pie para que crecer sea visible
  antes de volver a rozarlo. Pendiente, declarado y no resuelto: la
  concurrencia de `computeMatchStats` (`MATCH_STATS_CONCURRENCY = 3`,
  `src/facematch.js`) nunca se ajustó contra la cuota real de SearchFaces de
  la cuenta — us-east-1 default hasta 50 TPS según la doc pública de AWS, muy
  por encima de 3, pero eso es el default de la REGIÓN, no necesariamente la
  cuota configurada de esta cuenta. Subirla a ciegas en una app de respuesta
  a emergencia no es una decisión de hotfix.

## Variables de entorno

Ninguna es obligatoria para arrancar; casi todas apagan una función al faltar,
en silencio y a propósito. `GET /api/diag` dice cuáles están puestas (por
presencia y huella, nunca el valor).

| Variable | Si falta |
|---|---|
| `BASE_URL` | Se deriva de `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`, o `http://localhost:3000`. Es lo que se pega en los enlaces de los correos. |
| `PORT` | 3000. Solo aplica a `npm run dev` / `npm start`; en Vercel nadie escucha un puerto. |
| `DATABASE_URL` (o `POSTGRES_URL`, `STORAGE_URL`, `NEON_DATABASE_URL`…) | SQLite. En local, un archivo; **en Vercel, un `/tmp` efímero que se pierde**. |
| `DB_PATH` | `./data/encontrados.db`. Solo para SQLite local. |
| `API_KEY` | Los `POST` del API quedan **abiertos** y `DELETE /api/people/:id` responde 503. Las lecturas de información de personas son públicas siempre, con o sin llave; la excepción es `GET /api/match-stats`, que es operativa y dispara búsquedas en Rekognition, así que pide llave. |
| `SENDGRID_API_KEY` | No sale ningún correo: ni verificación de suscripción, ni alertas, ni avisos. Se le hace `trim()` porque un salto de línea pegado sin querer devuelve 401. |
| `EMAIL_FROM` | `a@torrenegra.com`. Tiene que ser un remitente verificado en SendGrid o SendGrid responde 403. |
| `AVISO_EMAIL` | El aviso del rescatista no se manda. Falla en silencio: quien reportó ve su página de éxito igual. Y con `NOTIFY_MODE=relay` (el modo por omisión) tampoco sale ningún aviso a terceros: quedan en el log como `[notify:relevo] PERDIDO`. |
| `NOTIFY_MODE` | `relay`. Los avisos a terceros se retienen y se relevan a `AVISO_EMAIL`; `direct` los manda derecho al destinatario. Cualquier otro valor cae a `relay`: el interruptor falla cerrado. |
| `GITHUB_TOKEN` | `/ideas` y `/bug` siguen funcionando pero caen a correo a `AVISO_EMAIL`. El síntoma es un tracker vacío, que se parece mucho a que nadie escribió. |
| `GITHUB_REPO` | `encontradosco/encontrados`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Sin reconocimiento facial: las fotos se guardan pero no se indexan ni coinciden. Las miniaturas igual se generan, centradas. `POST /api/reindex` las recoge después. |
| `AWS_REGION` | `us-east-1`. |
| `FACE_COLLECTION_ID` | `aqui-faces` — el nombre anterior al cambio de marca, a propósito. **No lo renombres**: apuntaría a una colección nueva y vacía y rompería el matching de todos los que ya están indexados. |
| `FACE_MATCH_THRESHOLD` | 90. |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | El canal queda dormido (que es su estado actual). |
| `WHATSAPP_VERIFY_TOKEN` | `encontrados-verify`. Es el handshake del webhook de Meta. |
| `WHATSAPP_RELAY_SECRET` | `POST /webhooks/whatsapp` responde **403 a todo**. Es la única variable que al faltar cierra en vez de abrir: ese POST escribe en la base, y su único cliente legítimo es el relevo que verifica la firma de Meta y reenvía. El `GET` del handshake no la usa. Se genera con `openssl rand -hex 32`. |
| `VERCEL_APP_CLIENT_ID` / `VERCEL_APP_CLIENT_SECRET` | `/admin/login/start` responde **503**: no arranca un login de "Sign in with Vercel" a medias. Ver `docs/admin-auth-setup.md` para crear la App en el dashboard. |
| `ADMIN_SESSION_SECRET` | Mismo 503 que arriba — firma la cookie de sesión propia de `/admin` (nada que ver con el client secret de Vercel). Rotarla cierra todas las sesiones activas de golpe. |
| `ADMIN_EMAILS` | `/admin` queda **cerrada para todos**, incluso para quien complete un login real y válido en Vercel — otra que falla cerrado, no abierto. Correos separados por coma, nunca hardcodeados (repo público). |
| `PUBLIC_STATS` | `GET /admin/stats` sigue **detrás de sesión** (el default). Solo el valor exacto `1` la abre sin sesión — ventana temporal mientras el auth de Vercel termina de configurarse (#116, PR 6). Cerrarla es borrar la variable, no un PR. El drill-down por ID (`/api/admin/*`) nunca lee esta variable. |
| `PET_MATCH_API_URL` | Matching de mascotas apagado; las fotos se guardan igual. El servicio (pet-matcher) vive en un repo separado, no en este monorepo — [`github.com/encontradosco/pet-matcher`](https://github.com/encontradosco/pet-matcher) (privado). Ya desplegado en Fly.io (`pet-matcher.fly.dev`, org `encontrados`, cuenta de pago — siempre prendido, sin el límite de 5 minutos del trial). En Vercel, esta variable todavía no está puesta. |
| `PET_MATCH_THRESHOLD` | `80`. Sin calibrar todavía con fotos reales — ver el documento de diseño. |
| `PET_MATCH_SHARED_SECRET` | No se manda el header `x-pet-matcher-secret` en `/embed`; si `PET_MATCH_API_URL` sí está puesta, el servicio de mascotas responde 503 (falla cerrado del lado de pet-matcher) y el matching queda igual de apagado que sin `PET_MATCH_API_URL`. Mismo patrón que `WHATSAPP_RELAY_SECRET`: se genera con `openssl rand -hex 32` y tiene que ser idéntica en los dos lados. |

`SENDGRID_API_BASE`, `GITHUB_API_BASE`, `WHATSAPP_API_BASE`,
`VERCEL_OAUTH_API_BASE` y `VERCEL_OAUTH_AUTHORIZE_URL` existen solo para que
las pruebas apunten a sus servidores falsos. No se definen en producción.

## Endpoints operativos

Para diagnosticar sin abrir la base de datos. Los tres primeros son de solo
lectura y por eso no piden llave; lo que gasta cuota, indexa o le escribe a
alguien, sí:

- `GET /api/diag` — **sin llave.** Configuración y autodiagnóstico en vivo:
  motor de base de datos y si responde, conteos, estado del matcher, fotos
  pendientes de indexar, presencia de cada credencial y el bloque
  `notifications` (modo de entrega, si hay buzón de relevo, y la combinación
  fatal `relay_without_mailbox`). Nunca muestra un secreto: de la llave de
  SendGrid enseña largo y prefijo, y del buzón solo si está puesto. Es lo
  primero que hay que mirar cuando algo "no está pasando" en producción.
- `GET /api/diag/sendgrid?email=…` — **sin llave.** Le pregunta a SendGrid por
  supresiones (rebotes, bloqueos, spam), remitentes verificados y autenticación
  del dominio. Un 202 al enviar solo significa "aceptado"; acá están las
  razones por las que aun así el correo no llegó.
- `GET /health` — un `{ ok: true }` para el monitoreo.
- `POST /api/diag/test-email` — **con llave.** Manda un correo real y traduce
  la respuesta de SendGrid a una frase accionable. Gasta cuota, así que no es
  un `GET`.
- `POST /api/contact-log` / `DELETE /api/contact-log/:ref` — **con llave.**
  Registra (y retira) un contacto hecho por fuera de la app. Idempotente por
  `ref`; el registro en bloque lo hace `scripts/registrar-contactos.js`, que
  **corre en seco por omisión** y hashea los identificadores del proveedor en
  la máquina de quien mandó los mensajes. Ver
  [`docs/contactos-fuera-de-la-app.md`](docs/contactos-fuera-de-la-app.md).
- `POST /api/maintenance/purge-test-data` — **sin llave**, y es seguro sin ella
  porque solo puede tocar una lista fija de nombres de prueba que está en el
  código. Cualquier otra cosa la ignora. Retira también las firmas faciales de
  lo que borra, con el mismo orden que el DELETE del ARCO; el radio no cambia,
  y cuando no hay nada que purgar no gasta ni una llamada a Rekognition.
- `DELETE /api/people/:id` — **con llave**, y deshabilitado (503) si no hay
  `API_KEY`. Cumple el borrado que promete la política de privacidad, y se lleva
  las dos copias del rastro: la fila (en cascada) y las firmas faciales de sus
  fotos, que viven en la colección de Rekognition y a las que la cascada no
  llega. **El orden importa y está elegido:** los `face_id` se leen antes del
  borrado (después la cascada ya se los llevó) pero las firmas se retiran
  *después*, ya sabiendo que la ficha se fue — al revés, un fallo de base en el
  medio dejaba una persona listada como desaparecida y permanentemente
  invisible para el matcher, que es la huérfana que sí le cuesta algo a
  alguien. Es **best effort a propósito**: un Rekognition caído no puede
  bloquear un borrado ya prometido, así que la fila se va igual y la respuesta
  trae `faces.unconfirmed` con lo que quedó, más `faces.face_matching` en
  `false` si el matcher estaba apagado. Reintentar el DELETE ya no sirve —la
  persona no existe y sus ids se fueron con ella—, así que esa respuesta y la
  línea `[facematch:olvido]` del log son el único rastro para limpiarlo a mano.
  Desde #191 este borrado además **deja constancia**: en la misma transacción
  del adaptador escribe en `suppressed_external_ids` el **hash sha256** de las
  llaves externas con las que esa ficha podría volver a entrar (nunca la
  llave cruda), y la respuesta trae cuántas fueron en `suppressed_external_ids`
  (el conteo, no las llaves). Sin eso el borrado duraba hasta el siguiente
  re-envío del agregador.
  `POST /api/maintenance/purge-test-data` usa el mismo orden y también retira
  firmas, pero **no suprime llaves**, y esa es la única diferencia entre los dos
  caminos de borrado: la supresión es constancia de que alguien ejerció un
  derecho, y un registro de prueba lo sembramos nosotros.
- `GET /api/match-stats` — **con llave.** Recomputa el cruce facial histórico
  buscando por `face_id` contra la colección (las firmas sobreviven aunque la
  foto del rescatista se haya borrado) y devuelve solo cifras agregadas: fotos
  de consulta que coinciden con algún reporte, personas distintas a cada lado,
  la misma cara consultada más de una vez, y coincidencias contra firmas
  colgadas sin foto en la base. No escribe nada y no notifica a nadie, pero es
  una lectura con llave: gasta búsquedas de Rekognition y sus cifras son de
  operación, no información de emergencia. Si `failed` viene > 0, los totales
  son un piso, no el techo.
- `/fotos/actualizar` y `POST /api/reindex` — ver "Poner al día fotos" arriba:
  la primera es la segura sin llave, la segunda es la que indexa y avisa.
