# Llaves de API con alcance

Cómo emitir, entregar y revocar una llave de API, y qué puede hacer cada
alcance. Para el detalle de cada endpoint, ver `agent.md`.

## Por qué existen

Hasta agosto de 2026 el API tenía **una** llave: la variable de entorno
`API_KEY`. Esa llave abre **todas** las superficies con llave, incluido
`DELETE /api/people/:id` —que es irreversible y se lleva las firmas faciales— y
`POST /api/diag/test-email`, que manda correo a cualquier dirección desde el
dominio. Darle esa llave a alguien para que aporte datos era darle **escritura
total a producción sobre datos de personas desaparecidas**.

Ahora hay dos alcances. `API_KEY` sigue funcionando igual, como llave de
operación, así que nada de lo que ya existe cambia.

| | `operator` | `ingest` |
|---|---|---|
| Rutas | todas las rutas con llave, **salvo dos** (ver abajo) | **solo** `POST /api/updates` |
| Estados que puede afirmar | todos | `missing`, `unknown` |
| `safe` / `deceased` / `injured` | se guardan tal cual | se estacionan en `unknown` |
| Puede sobreescribir por `external_id` | cualquiera | **solo las fichas que creó** |
| `source` | lo que declare | forzado a `aggregator` |
| `reporter` / `contact` | se guardan | se descartan |
| Manda avisos a familias | sí | **no** |
| Techo de escrituras | sin techo | 120 por hora |

**`API_KEY` no es lo mismo que una llave `operator` emitida**, y la diferencia
son dos rutas que verifican `API_KEY` directamente, sin pasar por el alcance:

- `DELETE /api/people/:id` — el borrado a solicitud del titular. **Ninguna llave
  emitida puede borrar**, ni con alcance `operator`. Es a propósito: es
  irreversible y se lleva las firmas faciales.
- `ALL /api/report/send` — el reporte operativo recurrente. Acepta `API_KEY` o el
  `CRON_SECRET` de Vercel, y nada más.

Todo lo demás que exige llave —suscripciones, `reindex`, cifras de operación,
correo de prueba, la bitácora de contactos externos— sí lo abre una llave
`operator`.

## Emitir una llave

Hoy se emite por línea de comandos. El panel en `/admin` es el siguiente paso y
va aparte a propósito: una tanda que agregara "llaves por persona" **sin** el
alcance acotado sería peor que no hacer nada, porque permitiría emitir con dos
clics una llave de poder total.

```bash
npm run api-key -- emitir --alias voluntario-1 --alcance ingest --emisor <tu correo de ADMIN_EMAILS>
npm run api-key -- listar
npm run api-key -- revocar --id 3
```

Corre contra la misma base que el servidor: SQLite en local, Postgres si el
entorno trae `DATABASE_URL` / `POSTGRES_URL`. **Emitir una llave de producción es
una operación de producción.**

Cuatro cosas que conviene saber antes de correrlo:

1. **La llave se muestra una sola vez.** De ella solo se guarda su SHA-256 y un
   prefijo de 8 caracteres. No hay forma de recuperarla: perdida, se revoca y se
   emite otra.
2. **`--alias` es un alias público.** No el nombre legal, no el correo, no el
   teléfono. Alcanza para saber a quién revocarle; guardar más convertiría la
   tabla en un registro de datos personales de voluntarios, con su propia
   retención por definir (Ley 1581).
3. **`--emisor` es una cuenta de operación, no una persona.** Es obligatoria y
   solo acepta un correo que ya está en `ADMIN_EMAILS`. Ver
   [Quién emitió cada llave](#quién-emitió-cada-llave).
4. **Emitir la primera llave cierra el modo abierto de desarrollo.** Sin
   `API_KEY` configurada y sin ninguna llave emitida, una petición **sin
   cabecera** recibe alcance `operator`, para poder desarrollar en local sin
   credenciales. Conviene ser exacto con qué abre eso: **todo lo que está detrás
   del alcance**, que no son solo los `POST` —también `GET /api/match-stats` y
   `DELETE /api/contact-log/:ref`—. La única que no abre es
   `DELETE /api/people/:id`, que compara contra `API_KEY` directamente y queda
   deshabilitada si no está configurada.

   Dos precisiones más, porque el modo abierto es la única puerta que falla
   abierta:

   - Solo la **ausencia** de credenciales usa esta excepción. Una llave
     desconocida o revocada recibe `401` incluso en modo abierto: equivocarse de
     llave cierra, no abre.
   - En cuanto existe una llave emitida la puerta se cierra sola, en el request
     siguiente: una petición sin cabecera recibe `401` en vez de alcance de
     operación.

   Igual, **configurá `API_KEY`** en cualquier despliegue.

Entregala por un canal que no la deje escrita. Un gestor de contraseñas sirve
para **entregar** el secreto una vez; el registro de quién tiene qué es la tabla,
no el gestor.

## Quién emitió cada llave

`--emisor` es **obligatoria** al emitir, y el único valor que acepta es un correo
que ya está en `ADMIN_EMAILS` — la misma allowlist que abre `/admin`. Queda
guardado en `api_keys.created_by`, normalizado a minúsculas, y `listar` lo
muestra.

**Por qué una cuenta y no un nombre.** Hubo antes una bandera de texto libre
(`--por`) y se quitó antes de mergear: lo que terminaba en la base era el nombre
legal o el correo de un voluntario, o sea exactamente lo que `--alias` existe
para no guardar. Lo que volvió no es esa bandera con otro nombre. La diferencia
es qué **valores** son posibles: una referencia a una cuenta de operación no
puede contener el dato personal de un voluntario, porque el conjunto de valores
aceptados es ese puñado de cuentas y ninguno más. Se guarda quién emitió sin
abrir la puerta que la objeción de privacidad quería cerrar.

**Para qué sirve.** La emisión se delega: una persona de confianza se reúne con
quien aspira a aportar datos y, si pasa el filtro, le emite una llave `ingest`.
Una llave emitida así tiene que poder revocarla **quien la emitió**, además de
quienes administran. Ese modelo de autoridad **todavía no está implementado**, y
no podría estarlo hoy: se aplica contra una sesión autenticada, y por línea de
comandos ya se tiene poder total. Llega con el panel de `/admin`, que va aparte.
Lo que este dato hace es volverlo posible.

Dos consecuencias prácticas:

- **`created_by` en `NULL` significa "no se registró", no "nadie".** Las llaves
  emitidas antes de esta regla no tienen emisor y `listar` las muestra como
  `sin registrar`.
- **La allowlist tiene que estar en la terminal desde la que corrés el comando**,
  no solo en Vercel. Sin `ADMIN_EMAILS` configurada acá no hay contra qué
  validar, y el comando se niega a emitir. El error distingue ese caso —falta la
  allowlist en este entorno— del otro —tu correo no está en ella—, porque se
  arreglan en lados distintos.

## Revocar

```bash
npm run api-key -- revocar --id 3
```

Hoy revocar por línea de comandos no verifica quién revoca: quien puede correr el
comando puede revocar cualquier llave. Es la misma razón de arriba, y por eso no
hay columna `revoked_by` todavía — anotar un dato que nada verifica sería peor
que no tenerlo.

Surte efecto en el request siguiente: la verificación no tiene caché.

**La fila no se borra, se marca revocada.** Borrarla se llevaría el único rastro
de qué escribió esa llave — que es justo lo que hace falta para limpiar después
de revocarla.

## Qué decirle a quien recibe una llave `ingest`

El script imprime esto al emitirla. Va también acá porque es la parte que no es
técnica:

- **La foto solo puede venir de una fuente pública.** Se usa únicamente para el
  cruce facial y nunca se muestra, pero subir la foto de una persona desde una
  fuente privada convierte un aporte en una filtración de datos biométricos.
- **Solo información pública.** Ningún dato de una fuente privada entra por acá.
- **La llave es personal y no se comparte.**
- Un hallazgo que dice que la persona **apareció** también sirve: entra como
  candidato en `unknown` y la respuesta lo dice. No hay que forzarlo a `missing`
  ni dejarlo afuera.

## El estado de estacionamiento

Una llave `ingest` que manda `safe`, `deceased` o `injured` **no** es rechazada y
**no** se convierte en `missing`: la ficha entra en `unknown` y la respuesta trae

```json
"status_coercion": { "requested": "safe", "stored": "unknown", "reason": "…" }
```

Es la decisión más delicada de todo el alcance, así que vale decir por qué en las
dos direcciones:

- **Convertirlo en `missing` sería lo peor que puede hacer este código.** Buena
  parte de lo que se encuentra en fuentes públicas es gente que ya apareció.
  Tomar una nota que dice "fue encontrada sana y salva" y publicar que sigue
  desaparecida es peor que no ingerir nada.
- **Rechazarlo perdería el hallazgo** y quien empuja no sabría por qué.

`unknown` es el estado de estacionamiento que este repo ya usa para exactamente
esto: el adaptador del registro público manda `"Localizada sin vida"` a `unknown`
a propósito, porque *"adivinar sobre la muerte de alguien no se hace solo"*
(`src/sources/colombiatebusca.js`). Acá se reusa ese principio.

⚠️ **La salida de `unknown` es humana y es una cola.** Un `unknown` no se
convierte solo en `safe` ni en `deceased`: sale por la cola de revisión de
estado, donde una persona mira la evidencia y decide
([issue #190](https://github.com/encontradosco/encontrados/issues/190),
`src/statusReview.js`). Con voluntarios corriendo la ingesta esa cola va a
crecer mucho más rápido que hoy, así que su capacidad —cuánta gente la
atiende— es el cuello de botella de este frente.

## Quién escribió qué

Cada escritura de `POST /api/updates` **cuya bitácora se alcanza a escribir**
queda en `api_write_log` con la llave que la hizo. Solo ids y enums, nunca texto
libre, y se borra con la persona (`ON DELETE CASCADE` sobre `people(id)`), igual
que `match_log` y `contact_log`.

`api_key_id` nulo significa **una escritura sin llave emitida**, y hoy eso cubre
dos casos que la bitácora **no distingue**: la `API_KEY` de entorno y el modo
abierto de desarrollo. Los dos principales llevan `id: null` a propósito —no
tienen fila en `api_keys`—, así que leyendo la bitácora no se puede separar una
escritura autenticada con `API_KEY` de una anónima en un despliegue sin
credenciales. Es una razón más para **configurar `API_KEY` siempre**: con ella
puesta el modo abierto ni existe, y el nulo vuelve a tener un solo significado.

La salvedad no es retórica y está desarrollada más abajo: si esa escritura falla,
una llave `ingest` recibe `503` y la ficha queda **sin fila**, mientras que para
una llave `operator` el reporte sigue en pie —también sin fila—. O sea que la
bitácora es completa salvo por fallas de escritura, y de ahí sale todo lo que
viene después.

Esa bitácora hace dos trabajos, y el segundo es fácil de pasar por alto: sostiene
el **techo por hora** y es la **prueba de qué llave creó cada ficha**, de donde
sale la regla de que una llave `ingest` no pueda pisar lo ajeno. O sea que para
una llave `ingest` no es observabilidad: es el control.

Por eso, **si la bitácora no se puede escribir, una llave `ingest` recibe `503`**,
no `201`. La ficha ya quedó guardada —no se pierde el hallazgo, y la respuesta
trae su `person_id`—, pero seguir de largo dejaría a esa llave sin techo y con
permiso de pisar cualquier `external_id`, sin que nada lo indicara afuera.

**Ese `503` no se reintenta**, y conviene saber por qué antes de programar un
reintento automático: la ficha existe pero no tiene fila en la bitácora, o sea
que quedó **sin dueño demostrable**. Volver a mandar el mismo `external_id`
—con esa llave o con cualquier otra— se rechaza con `403`, porque una ficha sin
dueño no es de nadie y la regla falla cerrado. Y mandarlo **sin** `external_id`
crearía una ficha duplicada. Lo que hay que hacer es avisar: una bitácora caída
es una falla de operación y la resuelve un operador (`API_KEY`), que no está
sujeto a esta regla.

Para una llave `operator` se conserva la regla de las otras bitácoras del repo:
un fallo de bitácora **nunca** tumba un reporte, porque ahí no sostiene ningún
control.
