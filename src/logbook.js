// La bitácora de coincidencias y de envíos (#116, PR 4 — la instrumentación;
// PR 3 creó las dos tablas). Instrumenta, no gobierna: cada match en pantalla
// y cada intento de aviso ya iban a pasar de todos modos — esto solo deja
// rastro de que pasaron.
//
// Regla de oro: un fallo escribiendo la bitácora NUNCA rompe ni retrasa el
// flujo principal. Un rescatista parado al lado de una persona, o un envío
// real, mandan sobre nuestra observabilidad — siempre. Por eso cada función
// atrapa su propio error, lo manda a console.error (para que sí quede en los
// logs de Vercel) y sigue como si nada.

async function logMatch(store, { personId, updateId, faceId, similarity, surface }) {
  try {
    await store.insertMatchLog({
      personId,
      updateId: updateId ?? null,
      faceId,
      similarity: similarity == null ? null : similarity,
      surface
    });
  } catch (e) {
    console.error(
      `[logbook:match] no se pudo registrar la coincidencia (persona ${personId}, superficie ${surface}) — el match sigue en pie:`,
      e.message
    );
  }
}

async function logContact(store, { personId, updateId, channel, result }) {
  try {
    await store.insertContactLog({ personId, updateId: updateId ?? null, channel, result });
  } catch (e) {
    console.error(
      `[logbook:contact] no se pudo registrar el envío (persona ${personId}, canal ${channel}, resultado ${result}) — el envío sigue en pie:`,
      e.message
    );
  }
}

// #150: registra cada auto-fusión de findOrCreatePerson (nombre ≥ 0.85).
// `store` puede ser el store completo o el adapter crudo — solo hace falta
// que tenga insertMergeLog, igual que logMatch/logContact.
async function logMerge(store, { personId, submittedName, score }) {
  try {
    await store.insertMergeLog({ personId, submittedName, score });
  } catch (e) {
    console.error(
      `[logbook:merge] no se pudo registrar la auto-fusión (persona ${personId}) — la fusión sigue en pie:`,
      e.message
    );
  }
}

// Registra una escritura del API junto con la llave que la hizo (apiKeyId nulo
// = la llave de entorno API_KEY, que no tiene fila en la tabla).
//
// ATENCIÓN a la diferencia con las otras tres de este archivo: esta bitácora no
// solo instrumenta, también SOSTIENE una regla. La fila más antigua de una ficha
// es la prueba de qué llave la creó, y de ahí sale que una llave de ingesta no
// pueda pisar fichas ajenas (ver src/routes/api.js). Si esta escritura falla, la
// ficha queda sin dueño demostrable y la siguiente corrección de esa misma llave
// se RECHAZA: molesto, pero es la dirección segura. Lo que no puede pasar, igual
// que en las otras tres, es que un fallo de bitácora tumbe un reporte que ya
// está guardado.
//
// Por eso —y esta es la segunda diferencia con las otras tres— DEVUELVE si pudo
// escribir. Sigue sin lanzar: quien llama decide qué hacer con el fallo. La
// ruta del API usa eso para no seguir de largo cuando la que escribe es una
// llave de ingesta, cuyos dos controles (el techo por hora y el dueño de la
// ficha) se cuentan sobre esta misma tabla y desaparecerían en silencio.
async function logApiWrite(store, { personId, updateId, apiKeyId, action }) {
  try {
    await store.insertApiWriteLog({
      personId,
      updateId: updateId ?? null,
      apiKeyId: apiKeyId ?? null,
      action
    });
    return true;
  } catch (e) {
    console.error(
      `[logbook:api] no se pudo registrar la escritura (persona ${personId}, llave ${apiKeyId ?? 'entorno'}, ${action}) — la ficha quedó guardada, pero quien llama decide qué hacer: una llave de ingesta responde 503 y esa ficha queda sin dueño demostrable (no se puede reintentar, hay que resolverla a mano), y para el operador el reporte sigue en pie:`,
      e.message
    );
    return false;
  }
}

// Traduce el { ok, ... } que ya devuelven sendEmail/sendWhatsApp/relayToOperators
// a un resultado del enum de contact_log. Cualquier envío que sí se intentó
// (llegó a llamar al proveedor, o al relevo) es 'enviado' o 'fallido' — nunca
// 'rechazado'. 'rechazado' es un valor aparte para cuando la app decide, por
// su cuenta, no intentar nada (ver notifyFaceMatch: una suscripción sin
// verificar en modo directo).
function resultFromSend(res) {
  return res && res.ok ? 'enviado' : 'fallido';
}

module.exports = { logMatch, logContact, logMerge, logApiWrite, resultFromSend };
