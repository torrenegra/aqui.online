# 📍 encontrados.co

Conecta a quien **rescata** a una persona con quien la **busca** — tras el terremoto en Colombia del lunes 10 de agosto.

1. **Rescatista** (voluntario, bombero, policía, hospital): sube la foto de la persona que tiene consigo. Se compara por reconocimiento facial contra los reportes de desaparecidos y se le muestra **quién la busca y cómo contactarlo**. La foto **se borra de inmediato**: solo queda su firma facial, para poder avisarle si alguien la busca más tarde. Puede registrar un aviso por correo.
2. **Familia**: reporta a una persona desaparecida con 1–3 fotos, nombre, el lugar donde cree que estaba y su teléfono o correo de contacto. No registra alertas ni ve resultados de búsqueda.

El contacto de quien reporta **solo** se revela a un rescatista cuando el rostro coincide; nunca aparece en páginas públicas.

Cuando la ficha que coincide **no trae** contacto de la familia —pasa con las importadas de registros públicos— la app invierte la pregunta: el rescatista deja su teléfono y dónde está la persona, y ese **aviso de rescatista** lo trabaja un humano, paso por paso y sin automatismos. El camino completo, con el criterio de triage: [**docs/avisos-de-rescatista.md**](docs/avisos-de-rescatista.md).

Las fotos siguen dos reglas opuestas según quién las suba. La de un **rescatista** no se guarda ni se muestra jamás: se compara, se indexa su firma facial y los bytes se borran. La de un **reporte de desaparecido** sí se guarda y sí se publica —recortada al rostro, con los puntos de detección facial dibujados encima— porque de eso se trata: que un rescatista reconozca a la persona que tiene al lado. La lista carga solo la miniatura, y ni siquiera esa si la conexión es mala.

Diseño ultraliviano a propósito: HTML renderizado en el servidor, un CSS pequeño, sin frameworks — funciona en teléfonos viejos y conexiones débiles.

## Correr local

```bash
npm install
npm run dev     # SQLite en ./data/encontrados.db, http://localhost:3000
npm test
```

### Con Docker (opcional)

No necesitas Node ni compilar módulos nativos en el equipo. Solo Docker.

```bash
docker compose up --build          # http://localhost:3000
docker compose run --rm app npm run seed   # datos sintéticos en la base local
docker compose run --rm app npm test       # las pruebas dentro del contenedor
```

El contenedor usa Node 22, igual que CI. El código va por un bind mount, así
que editar un archivo en el equipo reinicia el servidor adentro. La base SQLite
queda en `./data`, que ya está en `.gitignore`. Sin credenciales el
reconocimiento facial y el correo quedan apagados, igual que fuera de Docker.

## Deploy en Vercel

1. Importa el repo en Vercel (framework: **Other**). `vercel.json` enruta todo a la función `api/index.js` (Express completo); `/public` lo sirve el CDN.
2. Agrega **Vercel Postgres / Neon** al proyecto → define `POSTGRES_URL` (o `DATABASE_URL`). El esquema y los índices `pg_trgm` se crean solos en el primer arranque.
3. Variables de entorno (ver `.env.example`): `BASE_URL`, `SENDGRID_API_KEY` (remitente fijo: `a@torrenegra.com`), `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` (Rekognition), y cuando haya credenciales de WhatsApp: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`. Opcional: `API_KEY` (obligatoria si se emiten llaves con alcance — ver [`docs/llaves-de-api.md`](docs/llaves-de-api.md)).

### WhatsApp (Meta Cloud API) — pendiente de credenciales; el canal está implementado pero sin referencias en la interfaz hasta activarlo

1. En [Meta for Developers](https://developers.facebook.com), crea una app con el producto WhatsApp y toma `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`.
2. Configura el webhook apuntando al **relevo** que verifica la firma HMAC de Meta, no a este servidor: el relevo reenvía el cuerpo intacto a `https://encontrados.co/webhooks/whatsapp` agregando la cabecera `X-Relay-Secret`. Verify token = `WHATSAPP_VERIFY_TOKEN`, suscrito al campo `messages`.
3. Define `WHATSAPP_RELAY_SECRET` con el mismo valor en los dos lados (`openssl rand -hex 32`). El `POST` del webhook escribe en la base, así que **sin esa variable responde 403 a todo**: falla cerrado a propósito.
4. Comandos: `AYUDA`, `BUSCAR <nombre>`, `BIEN|HERIDO|DESAPARECIDO <nombre>: <nota> @ <lugar>`, `SUSCRIBIR <nombre>`, `BAJA <nombre>` / `BAJA TODO`. Un mensaje sin comando se trata como búsqueda.

## API

Lecturas públicas; si defines `API_KEY`, los POST requieren `Authorization: Bearer <API_KEY>`.

`API_KEY` es la llave de **operación**: abre las siete superficies con llave,
incluido el `DELETE` irreversible. Para que alguien aporte datos sin recibir todo
eso se emiten llaves con alcance acotado, guardadas en la base
(`npm run api-key -- emitir --alias voluntario-1 --alcance ingest --emisor <correo>`)
— ver
[`docs/llaves-de-api.md`](docs/llaves-de-api.md). Una llave `ingest` solo puede
usar `POST /api/updates`, solo afirma `missing`/`unknown`, no puede sobreescribir
fichas que no creó y no le manda avisos a nadie.

```bash
# Reportar (crea la persona si no existe; matching difuso para no duplicar)
curl -X POST https://encontrados.co/api/updates \
  -H 'Content-Type: application/json' \
  -d '{"name":"Juan Pérez","status":"safe","message":"Confirmado por teléfono","location":"Albergue San José","reporter":"María"}'

# Buscar (tolera typos, acentos, nombres incompletos)
curl 'https://encontrados.co/api/people?q=jaun%20peres'

# Detalle + historial
curl https://encontrados.co/api/people/1

# Suscribir
curl -X POST https://encontrados.co/api/people/1/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{"channel":"email","address":"familia@ejemplo.com"}'
```

`status` ∈ `safe | injured | missing | deceased | unknown`.

## Arquitectura

```
src/
  names.js        # normalización, clave fonética, puntaje difuso
  people.js       # lógica compartida (búsqueda, merge de personas, suscripciones)
  store/          # adaptadores: postgres.js (prod/Vercel), sqlite.js (dev/tests)
  bot.js          # motor conversacional (WhatsApp)
  notify.js       # salidas: SendGrid, WhatsApp Cloud API
  routes/         # web (HTML servido del servidor), api (JSON), webhooks
api/index.js      # entry point serverless para Vercel
```

Al llegar un reporte nuevo se notifica a todos los suscriptores **verificados** de esa persona (correo y/o WhatsApp), excepto a quien reportó.

## Suscripciones: verificación y baja

- **Correo**: la suscripción nace sin verificar; se envía un correo con enlace `/verify?token=…`. No se manda ninguna alerta hasta confirmar.
- **WhatsApp**: verificadas implícitamente (la persona escribe desde su propio número).
- **Baja**: toda alerta (correo y WhatsApp) incluye un enlace personal `/unsubscribe?token=…` de un clic. En el bot también funciona `BAJA <nombre>` / `BAJA TODO`.

## Contribuir

El proyecto es abierto y se corre local en dos comandos, **sin credenciales de
nada**:

```bash
npm install
npm run dev     # SQLite local, http://localhost:3000
```

- [**CONTRIBUTING.md**](CONTRIBUTING.md) — cómo mandar un cambio, qué conviene
  conversar antes de construirlo, y las reglas duras sobre datos personales.
- [**SECURITY.md**](SECURITY.md) — un hallazgo de seguridad o privacidad **no va
  en un issue público**.
- [**CODE_OF_CONDUCT.md**](CODE_OF_CONDUCT.md).
- [**CLAUDE.md**](CLAUDE.md) y [**.claude/**](.claude/README.md) — si trabajas
  con un agente: las reglas que carga solo, los comandos de lo que más se
  repite, y un arranque rápido para el primer día.

Buenos puntos de entrada: los issues marcados
[`good first issue`](https://github.com/encontradosco/encontrados/labels/good%20first%20issue)
y [`help wanted`](https://github.com/encontradosco/encontrados/labels/help%20wanted).
