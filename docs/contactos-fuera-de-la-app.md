# Contactos hechos por fuera de la app

Cuando alguien del equipo le escribe a una familia **desde su propio buzón o su
propio teléfono**, la app no se entera: ese envío no pasó por ninguno de sus
caminos. La consecuencia práctica es que la ficha de esa persona dice "nadie la
ha contactado" cuando sí se la contactó, y el panel cuenta una historia
incompleta.

Este documento explica cómo se registran esos contactos, por qué se guardan
separados de los que hace la app, y cómo se retiran si hace falta.

## Lo que hay que entender primero: son dos hechos distintos

`contact_log` guarda ahora dos cosas que **no se pueden sumar**:

| `source` | Qué es | Qué pregunta responde |
|---|---|---|
| `app` | Un envío que hizo el software: correo, WhatsApp, o un relevo al buzón del equipo | ¿El relevo está reteniendo? ¿La app entregó lo que dijo que iba a entregar? |
| `operador` | Un contacto que hizo una persona, por fuera de la app, y que registró después | ¿A esta familia ya le avisamos? |

La gráfica **"Envíos por canal (acumulado)"** del panel es el instrumento con el
que se responde la primera columna. Si un correo que mandó una persona a mano
apareciera ahí como "Correo: 24", quien mañana investigue por qué hay 88 avisos
retenidos en relevo se encontraría 24 correos que la app nunca mandó, sin
ninguna forma de saber que son otra cosa. Por eso están separados en el dato, no
solo en la presentación:

- Los tres agregados de `contact_log` (`contactLogCounts`, `contactLogDaily`,
  `contactLogEarliest`) filtran por `source`, **y su valor por omisión es
  `'app'`**. Un llamador que no diga nada ve exactamente lo que veía antes de
  que la columna existiera. Pedir todo hay que escribirlo (`source: null`).
- `POST /api/contact-log` **fuerza** `source = 'operador'` del lado del
  servidor. No hay campo que permita otra cosa: un llamador externo no puede
  escribir en la serie de la app ni queriendo.

El caso donde esto más se nota es `contactLogEarliest`, que alimenta la frase
"envíos medidos desde…". Un contacto del equipo con fecha del 11 de agosto
correría esa fecha hacia atrás y pintaría como instrumentados días en los que la
app no había medido nada — justo la mentira por omisión que esa frase existe
para evitar.

## Qué viaja y qué no

Lo que se registra es **el evento, no el destinatario**:

```json
{
  "person_id": 123,
  "channel": "email",
  "result": "enviado",
  "occurred_at": "2026-08-11T15:04:05Z",
  "ref": "<digesto SHA-256 en hexadecimal, 64 caracteres>"
}
```

No hay campo para el nombre, la dirección, el número ni el cuerpo del mensaje, y
no hay dónde guardarlos: las columnas de `contact_log` son ids internos
(`person_id`, `update_id`), tres enums (`channel`, `result`, `source`), la fecha
y `external_ref`, la referencia opaca. Es la misma garantía que ya tenía la
tabla, y este cambio no la relaja.

### Por qué `ref` es un digesto y no el id del mensaje

`ref` es la llave de idempotencia: reintentar con la misma referencia actualiza
el mismo hecho en vez de duplicarlo, y es lo que permite retirar una fila
puntual. Lo natural sería usar el identificador del proveedor —el `Message-ID`
del correo, el `wamid` de WhatsApp— pero **el `wamid` lleva el teléfono del
destinatario codificado en base64 adentro**. Guardarlo crudo metería el número
de una familia en la base de producción.

Así que el identificador se hashea **en la máquina de quien mandó el mensaje** y
solo viaja el digesto:

```
ref = sha256(channel + ":" + message_id)
```

El canal entra al digesto para que el mismo identificador en dos canales
distintos no se pise. `POST /api/contact-log` **valida la forma** del digesto
(`^[a-f0-9]{64}$`) y rechaza cualquier otra cosa: un `wamid` crudo no pasa la
validación, así que el accidente no depende de que alguien haya leído este
documento.

## El endpoint

```
POST   /api/contact-log          Authorization: Bearer <API_KEY>
DELETE /api/contact-log/:ref     Authorization: Bearer <API_KEY>
```

- `channel`: `email` | `whatsapp`. `relevo` no se acepta — es un camino interno
  de la app.
- `result`: `enviado` | `fallido`. `rechazado` no aplica: significa "la app
  decidió por su cuenta no intentar nada", y una persona escribiendo desde su
  buzón no tiene ese estado.
- `occurred_at`: la fecha **real** del contacto, no la de hoy. Se rechaza una
  fecha más de cinco minutos en el futuro —la tolerancia es por el desfase de
  reloj entre máquinas— y también una anterior al 10 de agosto de 2026, el día
  en que el proyecto existe. Las dos cotas atajan el mismo error de zona
  horaria del registrador, que corre la serie de días del panel.
- Respuesta: `201` con `created: true` la primera vez, `200` con `created:
  false` en un reintento. Las dos son éxito.
- `DELETE` solo puede borrar filas con `source = 'operador'`: el filtro vive en
  el adapter, así que este camino no puede tocar un envío que la app sí hizo.

## Dónde se ve

- **Ficha de la persona** (`/person/:id`): un bloque con los avisos que llegaron
  a quien la reportó y cuándo, con el canal y quién lo mandó. **Solo se muestra
  a quien tiene sesión de administración**; para cualquier otro visitante la
  ficha no cambia. Los relevos quedan afuera —se filtran en el SQL, no en la
  vista— porque un relevo es un aviso retenido, no un aviso entregado.
- **Panel** (`/admin/stats`): su propia sección, "Contactos que hizo el equipo
  por fuera de la app", con tabla y sin gráfica, debajo de la de canales de la
  app y explícitamente separada de ella.
- **Reporte por correo**: una tabla aparte dentro de la sección 3.

**La versión pública del bloque de la ficha no existe todavía, y es una decisión
aparte.** Mostrarle a cualquier visitante "se avisó a quien reportó el 12 de
agosto" es información útil para un familiar que no fue quien llenó el reporte —
y a la vez es un detalle corroborante que le sirve a quien quiera hacerse pasar
por el equipo en una llamada. Cae en dos de las tres categorías que decide una
persona (lo que ve un usuario, y privacidad), así que se decide en su propio
issue, no de refilón acá.

## Registrar en bloque (y deshacerlo)

`scripts/registrar-contactos.js` lee un archivo JSONL, calcula los digestos
localmente y llama al endpoint. **En seco por omisión**: sin `--commit` no manda
una sola petición.

```bash
# el archivo, una línea por contacto
{"person_id":123,"channel":"email","result":"enviado","occurred_at":"2026-08-11T15:04:05Z","message_id":"<abc@mail.ejemplo>"}

node scripts/registrar-contactos.js contactos.jsonl                  # ver qué haría
API_KEY=... node scripts/registrar-contactos.js contactos.jsonl --commit
API_KEY=... node scripts/registrar-contactos.js contactos.jsonl --commit --undo
```

El archivo de entrada **se queda en la máquina de quien mandó los mensajes**:
tiene identificadores del proveedor y no tiene por qué salir de ahí. El script
tampoco imprime el `message_id` de vuelta — solo el prefijo del digesto, que
alcanza para rastrear una fila.

Si una línea está mal, no se registra **nada**: es un registro de hechos, y
media carga es peor que ninguna.

### Antes de correrlo con `--commit`

Registrar afirma, sobre cada persona de la lista, que a quien la reportó se le
avisó tal día. Vale la pena que alguien mire y responda:

1. ¿La evidencia existe y es de ese envío? El `message_id` debería salir del
   registro del proveedor (la carpeta de enviados, el log de la API), no de la
   memoria de nadie.
2. ¿El `person_id` es el de la persona correcta? Un id corrido pone el aviso en
   la ficha equivocada, y ahí la afirmación es falsa sobre dos personas a la vez.
3. ¿`occurred_at` es la fecha del envío o la de hoy?
4. ¿Los `result: "fallido"` están completos? Registrar solo los que salieron
   bien deja el mismo sesgo que tendría un canal que solo cuenta sus éxitos.

Si algo sale mal, `--undo` retira exactamente las mismas filas, por las mismas
referencias.
