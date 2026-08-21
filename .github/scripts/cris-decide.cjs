// Decide si Cris puede aprobar y mergear un PR, o si tiene que esperar a una
// persona.
//
// ── Por qué esto existe ──
//
// `main` es producción: Vercel despliega cada merge, así que mergear ES
// desplegar un servicio de emergencia con gente real del otro lado. La regla
// del proyecto (CONTRIBUTING.md) dice que lo rutinario avanza con la revisión
// de un solo mantenedor, y que lo que cambia el comportamiento de cara al
// usuario, el esquema de la base o la privacidad lo decide una persona.
//
// Cris es uno de los cuatro mantenedores. Este módulo le deja despachar la
// mitad rutinaria del trabajo sin que un humano tenga que estar disponible, y
// le prohíbe tocar la otra mitad. Todo lo de abajo es la segunda parte: el
// archivo es mayormente una lista de razones para NO firmar.
//
// ── El invariante ──
//
// Una aprobación de Cris satisface `require_code_owner_reviews` en las rutas
// donde está listado. Entonces cada vez que firma, alguien podría estar
// desplegando código que ningún humano leyó. La única defensa que este archivo
// puede ofrecer es negarse, así que se niega por defecto y aprueba solo cuando
// puede demostrar que el juicio humano ya está en el circuito.
//
// ── Puro a propósito ──
//
// `decide()` no toca la red: mismos insumos, mismo resultado. Todo lo que
// consulta a GitHub vive en `run()`, abajo. Eso es lo que hace que las pruebas
// puedan ejercitar la decisión real en vez de una imitación.

// Los checks que tienen que estar verdes en el commit evaluado. Si alguno no
// corrió, o no concluyó, o concluyó en rojo, no se firma.
//
// Ojo con estos dos, porque no son la misma clase de señal ni prometen lo
// mismo:
//
//   • `npm test` es un CHECK RUN y es el que exige la regla de rama. Verde
//     significa que las pruebas pasaron.
//
//   • `CodeRabbit` NO es un check run: es un COMMIT STATUS (un `context`), y
//     por eso no aparece en `checks.listForRef`. Quien llame tiene que
//     mezclar las dos fuentes — si solo mira check runs, este gate aborta en
//     todos los PRs y el aprobador queda muerto sin que nadie entienda por
//     qué. Y su `conclusion` sola NO alcanza como señal: CodeRabbit reporta
//     `success` tanto cuando revisó y no encontró nada como cuando NO revisó
//     — cupo agotado, PR en draft, y lo que aparezca después (issue #199, dos
//     causas medidas en dos días, por mecanismos distintos). Por eso, para
//     este check puntual, el gate exige además que la `description` lo
//     afirme — ver `CODERABBIT_REVIEWED_RE` más abajo.
const REQUIRED_CHECKS = ['npm test', 'CodeRabbit'];

// El nombre normalizado bajo el que llega el commit status de CodeRabbit
// (ver `statusesComoChecks` en `cris-approve.yml`). Aparte para no repetir el
// literal en el chequeo de abajo.
const CODERABBIT_CHECK = 'CodeRabbit';

// Lista BLANCA, y falla cerrado ante cualquier texto que no reconoce.
//
// Por qué blanca y no negra, que era la alternativa barata: enumerar causas
// de fallo es una carrera que se pierde. Ya van dos, medidas en dos PRs
// reales el mismo día (19-ago-2026) y por mecanismos distintos —cupo
// agotado (`Review rate limited`) y PR en draft (`Review skipped: draft
// pull request`)— y nadie sabe cuántas más hay. Una lista negra deja pasar
// la próxima en silencio, que es exactamente el defecto que este código
// existe para cerrar. La afirmación que hace falta es POSITIVA: *esta
// revisión ocurrió sobre este diff*, no "no coincide con ninguna de las
// causas de fallo que ya conocemos".
//
// El costo se acepta a sabiendas, no por descuido: en esa medición solo se
// vieron 4 descripciones distintas en 2 PRs. Un éxito legítimo cuyo texto no
// empiece con "Review completed" —un PR solo de documentación, una variante
// de copy futura del proveedor— quedaría atascado esperando a una persona.
// Se prefirió eso —una cola más larga, un fallo VISIBLE— sobre la
// alternativa —un merge sobre una revisión que nunca ocurrió, un fallo
// INVISIBLE—. Si el falso positivo aparece en la práctica, esta expresión se
// afina con datos reales; no se adivina hoy.
const CODERABBIT_REVIEWED_RE = /^Review completed/i;

// Y quién tiene permitido FIRMAR ese status. Sin esto, la lista blanca de la
// descripción no protege nada: un commit status no es un check run — lo puede
// crear CUALQUIER cuenta con permiso de escritura al repo, con el `context` y
// la `description` que quiera. O sea que sin validar el emisor, cualquiera con
// push podría escribir un status «CodeRabbit / Review completed» y comprarse la
// firma del agente.
//
// Se compara contra el login del creador, en minúscula. GitHub reporta las
// Apps con el sufijo `[bot]`, y se aceptan las dos formas porque cuál llega
// depende de si el status lo creó la App o su cuenta asociada.
const CODERABBIT_EMISORES = new Set(['coderabbitai', 'coderabbitai[bot]']);

// La segunda etiqueta, y la razón de que este aprobador no sea un clon del de
// otro repo.
//
// CODEOWNERS reparte por RUTA, y hay una categoría de la regla del proyecto que
// no es una ruta: "cambia lo que un usuario ve". Está medido — el PR #157 tocó
// solo `src/adminStats.js` y su prueba, cayó limpio en el catch-all del
// CODEOWNERS, y agregaba una sección nueva que cualquiera ve en el panel. La
// geografía no puede distinguir eso; solo el criterio puede.
//
// Así que el criterio se declara como un HECHO y esta etiqueta lo transporta:
// «¿alguien que usa la app recibiría, vería o haría algo distinto?». La
// etiqueta significa "no". Su AUSENCIA no significa "sí" — significa "nadie lo
// afirmó", y eso basta para no firmar. Falla cerrado a propósito: olvidarla
// cuesta una espera, y ese es el error barato.
const NO_USER_EFFECT_LABEL = 'efecto-usuario:ninguno';

// La etiqueta que dispara todo. Autoriza; no aporta juicio.
const AUTHORIZING_LABEL = 'ready-to-merge';

// Estados de reseña que cuentan como un voto emitido. Un COMMENTED no es ni a
// favor ni en contra: no cubre nada, pero tampoco revierte una aprobación
// anterior, así que no entra acá.
const VOTING_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED']);

// ── CODEOWNERS: el subconjunto tipo gitignore que usa GitHub ──
//
// Gana el ÚLTIMO patrón que coincide, no el más específico. Un patrón sin slash
// inicial ni interior coincide a cualquier profundidad; uno con slash está
// anclado a la raíz.
function compile(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  let anchored = false;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  }
  if (p.includes('/')) anchored = true;
  const body = p
    .replace(/\*\*/g, '\x00GS\x00')
    .replace(/\*/g, '\x00S\x00')
    .replace(/\?/g, '\x00Q\x00')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\x00GS\x00/g, '.*')
    .replace(/\x00S\x00/g, '[^/]*')
    .replace(/\x00Q\x00/g, '[^/]');
  const prefix = anchored ? '^' : '^(?:.*/)?';
  // Un patrón de directorio posee todo lo que cuelga de él; un nombre pelado
  // posee o el archivo mismo o, si es directorio, su subárbol entero.
  const suffix = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(prefix + body + suffix);
}

/**
 * Los owners de UNA ruta.
 *
 * Dos propiedades que este bucle fija y que sostienen todo lo demás:
 *   • gana el ÚLTIMO patrón que coincide (por eso se reasigna, no se acumula);
 *   • los owners NO se acumulan entre reglas. Si se acumularan, el catch-all
 *     `*` volvería a poseer las rutas restringidas, y la firma de Cris —que
 *     está en el catch-all— cubriría el esquema de la base. Todo el reparto de
 *     CODEOWNERS se caería por esta línea.
 */
function ownersOf(rules, file) {
  let found = [];
  for (const r of rules) if (r.re.test(file)) found = r.owners; // gana el último
  return found;
}

function parseCodeowners(text) {
  const rules = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || !owners.length) continue;
    rules.push({
      re: compile(pattern),
      owners: owners.map((o) => o.replace(/^@/, '').toLowerCase()),
    });
  }
  return rules;
}

// Un owner con "/" es un EQUIPO (`@org/equipo`). Resolverlo a personas exigiría
// un scope de organización que este workflow no tiene, y agregarlo ensancharía
// justo el token que no conviene ensanchar. Así que falla cerrado: una
// aprobación individual nunca satisface un handle de equipo. Hoy no hay ninguno
// en el CODEOWNERS de este repo; el día que lo haya, esto no se vuelve un hueco
// silencioso.
const isTeam = (owner) => owner.includes('/');

/**
 * Logins humanos con una aprobación VIGENTE sobre el commit que se está
 * evaluando.
 *
 * Tres anclas, y las tres hacen falta:
 *   • `commit_id === headSha` — una aprobación vieja no cubre código nuevo.
 *     Cuesta cero permisos y no depende de que el descarte automático de
 *     reseñas esté configurado.
 *   • `user.type === 'User'` — una App o un bot no es juicio humano.
 *   • el login de Cris se excluye ANTES de cualquier cálculo. Si su propia
 *     firma contara como cobertura, se estaría autoconcediendo el permiso de
 *     firmar. Eso es un lazo de retroalimentación, no una revisión.
 *
 * Y agrupa por usuario tomando la ÚLTIMA reseña: preguntar si "alguna" reseña
 * fue APPROVED cuenta como aprobación una que su propio autor ya revirtió con
 * un CHANGES_REQUESTED posterior.
 *
 * Lo que esta función NO verifica, dicho en voz alta: el acceso vigente de
 * quien aprobó. Si a alguien se le revocó el acceso después de aprobar, su
 * reseña sigue contando acá. La palanca real de offboarding es otra y es más
 * fuerte — cubrir exige además estar LISTADO en la regla de esa ruta en el
 * CODEOWNERS de la BASE, así que sacar el login de ahí corta la cobertura de
 * inmediato.
 */
function liveApprovers(reviews, headSha, crisLogin) {
  const latestByUser = new Map();
  for (const r of reviews || []) {
    if (!r || !r.user || !r.commit_id) continue;
    if (r.commit_id !== headSha) continue;
    if (r.user.type !== 'User') continue;
    const login = String(r.user.login).toLowerCase();
    if (login === crisLogin) continue;
    if (!VOTING_STATES.has(r.state)) continue;
    const key = [r.submitted_at || '', r.id || 0];
    const prev = latestByUser.get(login);
    if (!prev || key[0] > prev.key[0] || (key[0] === prev.key[0] && key[1] > prev.key[1])) {
      latestByUser.set(login, { state: r.state, key });
    }
  }
  return new Set(
    [...latestByUser].filter(([, v]) => v.state === 'APPROVED').map(([login]) => login)
  );
}

/**
 * La decisión, pura.
 *
 * Devuelve `{ decision, reason?, note?, ... }` donde decision es una de:
 *   'abort'             — algo está mal y es corregible: quita la etiqueta,
 *                         comenta el motivo y deja el job en rojo.
 *   'abstain'           — nada está mal; simplemente no es la llamada de Cris.
 *   'approve_and_merge' — firma y arma el auto-merge nativo de GitHub.
 *   'approve'           — firma NO vinculante (no es owner de nada tocado).
 *   'comment_only'      — no firma: comenta y etiqueta a quien decide.
 */
function decide(input) {
  const {
    crisLogin,
    author: authorRaw,
    authorDisplay = authorRaw,
    labeler: labelerRaw,
    headSha,
    currentHeadSha,
    baseRef,
    draft = false,
    codeowners,
    labels = [],
    files = [],
    reviews = [],
    checkRuns = [],
    requiredChecks = REQUIRED_CHECKS,
  } = input;

  // GitHub no distingue mayúsculas en los logins, y todo con lo que estos se
  // comparan ya está en minúscula. Se normaliza acá, donde se usa, para que la
  // precondición no quede implícita en quien llame.
  const author = String(authorRaw || '').toLowerCase();
  const labeler = String(labelerRaw || '').toLowerCase();
  const labelSet = new Set((labels || []).map((l) => String(l).toLowerCase()));

  const rules = parseCodeowners(codeowners);
  if (!rules.length) {
    return {
      decision: 'abstain',
      reason:
        '`.github/CODEOWNERS` en la rama base está vacío: mi aprobación satisfaría el gate sin respaldo de ningún owner.',
    };
  }

  // La etiqueta que autoriza tiene que estar PUESTA ahora, no solo haber
  // disparado el evento. El workflow arranca por un evento `labeled`, que dice
  // que alguien la puso en algún momento — no que siga ahí cuando llega esta
  // decisión. Si alguien se arrepintió y la quitó mientras corría, esto lo
  // respeta en vez de firmar por inercia.
  if (!labelSet.has(AUTHORIZING_LABEL)) {
    return {
      decision: 'abstain',
      reason: `la etiqueta \`${AUTHORIZING_LABEL}\` ya no está en el PR: sin la orden, no firmo.`,
    };
  }

  // ── El gate objetivo primero: ninguna cobertura humana lo sustituye ──

  if (draft) return { decision: 'abort', reason: 'el PR sigue en draft.' };

  // El head no se puede mover entre el evento y la decisión. Si se movió, la
  // cobertura, el gate de checks y la firma dejarían de referirse al mismo
  // commit — y firmar contra un head distinto del que se evaluó es firmar
  // código no revisado.
  if (currentHeadSha && currentHeadSha !== headSha) {
    return {
      decision: 'abort',
      reason:
        `el head se movió durante la corrida (evalué \`${String(headSha).slice(0, 8)}\`, ` +
        `ahora es \`${String(currentHeadSha).slice(0, 8)}\`). No firmo contra un commit que no evalué.`,
    };
  }

  for (const name of requiredChecks) {
    const runs = checkRuns.filter((c) => c.name === name);
    if (!runs.length) {
      return { decision: 'abort', reason: `el check \`${name}\` no ha corrido en este commit.` };
    }
    // Determinista: una corrida sin fecha utilizable nunca desplaza a una que
    // sí la tiene.
    const cuando = (r) => {
      for (const v of [r.started_at, r.completed_at]) {
        const t = new Date(v).getTime();
        if (!Number.isNaN(t)) return t;
      }
      return 0;
    };
    const porFecha = runs.slice().sort((a, b) => cuando(b) - cuando(a));

    // Gana la última corrida CONCLUIDA, no la última empezada. Poner la
    // etiqueta puede disparar corridas nuevas, y leer la última EMPEZADA hace
    // que Cris se encuentre siempre con una en `queued` y aborte quitándose la
    // etiqueta a sí mismo — un label autodestructivo.
    //
    // Aceptar una conclusión ya emitida es seguro acá: el guard de
    // `currentHeadSha` ya abortó si el head se movió, así que toda corrida de
    // esta lista califica exactamente el mismo diff. Sigue siendo conservador
    // donde importa: si la última concluida es roja, se aborta aunque haya otra
    // en vuelo que pudiera salir verde.
    const ultimaConcluida = porFecha.find((r) => r.status === 'completed');
    if (!ultimaConcluida) {
      return {
        decision: 'abort',
        reason: `el check \`${name}\` todavía no concluye en este commit (estado: ${porFecha[0].status}).`,
      };
    }
    if (ultimaConcluida.conclusion !== 'success') {
      return {
        decision: 'abort',
        reason: `el check \`${name}\` no está verde (estado: ${ultimaConcluida.conclusion}).`,
      };
    }

    // El verde de CodeRabbit no basta por sí solo — ver la nota sobre
    // `CODERABBIT_REVIEWED_RE` arriba. Se exige la afirmación positiva sobre
    // la MISMA entrada que ya se tomó como definitiva (`ultimaConcluida`),
    // nunca sobre otra: mezclar entradas distintas dentro del mismo chequeo
    // reabriría el hueco que esto cierra.
    if (name === CODERABBIT_CHECK) {
      // El emisor va PRIMERO. La descripción es texto libre que escribe quien
      // crea el status, así que preguntarle a un desconocido si revisó no vale
      // más que su palabra; lo que hay que establecer antes es que el que
      // habla sea quien decimos.
      const emisor = String(ultimaConcluida.creator || '').toLowerCase();
      if (!CODERABBIT_EMISORES.has(emisor)) {
        return {
          decision: 'abort',
          reason:
            `el check \`${name}\` está verde, pero lo firmó ${emisor ? `\`${emisor}\`` : 'una cuenta que no puedo identificar'}, ` +
            `que no es CodeRabbit. Un commit status lo puede crear cualquier cuenta con permiso de escritura, ` +
            `así que un verde de un emisor que no reconozco no es una revisión: espera a una persona.`,
        };
      }
      const descripcion = typeof ultimaConcluida.description === 'string' ? ultimaConcluida.description : '';
      if (!CODERABBIT_REVIEWED_RE.test(descripcion)) {
        return {
          decision: 'abort',
          reason:
            `el check \`${name}\` está verde (\`success\`), pero su descripción no afirma que la ` +
            `revisión ocurrió sobre este diff — encontré: ${descripcion ? `"${descripcion}"` : '(sin descripción)'}. ` +
            `Solo cuento como revisión real una descripción que empiece con "Review completed"; cualquier ` +
            `otro texto, conocido o no, espera a una persona (issue #199).`,
        };
      }
    }
  }

  // ── Quién posee qué ──
  // Una ruta sin regla que la matchee no impone gate de code owner, así que
  // sale del conjunto. Tampoco cuenta como "cubierta": no debe ser la vía para
  // que un PR sin ninguna ruta con owner se cuele al caso 1.
  const owned = files
    .map((file) => ({ file, owners: ownersOf(rules, file) }))
    .filter((f) => f.owners.length);
  const union = [...new Set(owned.flatMap((f) => f.owners))];
  const humanOwners = union.filter((o) => o !== crisLogin);
  const tag = humanOwners.length ? humanOwners.map((o) => '@' + o).join(' ') : '(sin code owner humano)';

  // ── Cris nunca aprueba su propio trabajo ──
  // Antes de cualquier cálculo de cobertura, y sin excepción.
  if (author === crisLogin) {
    return {
      decision: 'abstain',
      reason: `el PR es mío — mi propio trabajo necesita ojos humanos. cc ${tag}`,
    };
  }

  // ── El freno que la geografía no puede poner ──
  //
  // Va DESPUÉS del gate objetivo y de la identidad, y ANTES de calcular
  // cobertura, porque no es una condición de firma: es una condición de que
  // este PR sea siquiera candidato a avanzar sin una persona.
  //
  // Se pide un HECHO, no una conclusión. La etiqueta afirma que nadie que use
  // la app recibiría, vería ni haría algo distinto. Si nadie lo afirmó, se
  // espera: la ausencia de la etiqueta no es una acusación, es la falta de una
  // declaración, y este archivo no adivina.
  if (!labelSet.has(NO_USER_EFFECT_LABEL)) {
    return {
      decision: 'comment_only',
      note:
        `El gate objetivo está verde, pero falta la etiqueta \`${NO_USER_EFFECT_LABEL}\`, que es la que ` +
        `afirma el hecho: **¿alguien que usa la app recibiría, vería o haría algo distinto?** ` +
        `Sin esa afirmación no firmo, y no es un tecnicismo: \`main\` es producción, y el reparto por ` +
        `rutas del CODEOWNERS no puede ver un cambio de cara al usuario que viva en una ruta rutinaria. ` +
        `Si el cambio de verdad no altera nada observable, ponla y vuelvo a mirar. Si sí lo altera, ` +
        `entonces la decisión es de una persona y la etiqueta no debe ponerse. cc ${tag}`,
      missingUserEffectLabel: true,
    };
  }

  // ── Cobertura humana POR RUTA ──
  const approvers = liveApprovers(reviews, headSha, crisLogin);
  const isCovered = (f) => {
    // (a) El autor la escribió y la posee: el humano está en el circuito.
    if (f.owners.includes(author)) return true;
    // (b) Un owner humano DE ESA MISMA ruta tiene aprobación vigente sobre este
    //     head. Un owner de otra ruta no la cubre — eso reintroduciría por la
    //     puerta de atrás el modelo "una firma desbloquea todo".
    return f.owners.some((o) => !isTeam(o) && o !== crisLogin && approvers.has(o));
  };

  const uncovered = owned.filter((f) => !isCovered(f)).map((f) => f.file);
  const allCovered = owned.length > 0 && uncovered.length === 0;
  const crisOwnsAll = owned.length > 0 && owned.every((f) => f.owners.includes(crisLogin));
  const crisOwnsAny = owned.some((f) => f.owners.includes(crisLogin));

  const outOfScopeAll = owned.filter((f) => !f.owners.includes(crisLogin)).map((f) => f.file);
  const cap = (list) => (list.length > 5 ? [...list.slice(0, 5), `…+${list.length - 5} más`] : list);
  const fmt = (list) => cap(list).map((f) => '`' + f + '`').join(', ');

  // Cuando el único owner humano de lo tocado ES el autor, el "cc" no lleva a
  // ninguna parte: GitHub no deja aprobar tu propio PR, así que nadie puede
  // satisfacer el gate. No cambia ninguna decisión — solo agrega el diagnóstico,
  // porque la salida es de configuración, no de firma.
  const onlyAuthorOwns = humanOwners.length > 0 && humanOwners.every((o) => o === author);
  const deadlockNote = () => {
    if (!onlyAuthorOwns) return '';
    return (
      `\n\n⚠️ **Nadie puede aprobar esto tal como está**: el único code owner humano de lo tocado es ` +
      `el propio autor (@${authorDisplay}), y GitHub no permite autoaprobarse. Se resuelve con otro ` +
      `owner humano de esas rutas, o partiendo el PR para que lo restringido vaya aparte. ` +
      `(Leo \`CODEOWNERS\` de la rama base, \`${baseRef}\`, así que un cambio ahí solo cuenta cuando ` +
      `ya llegó a esa rama.)`
    );
  };

  const byApproval = owned
    .filter((f) => !f.owners.includes(author) && isCovered(f))
    .map((f) => ({
      file: f.file,
      by: f.owners.filter((o) => !isTeam(o) && o !== crisLogin && approvers.has(o)),
    }));
  const coverageDetail = byApproval.length
    ? ` Cobertura por aprobación vigente sobre este mismo commit: ` +
      cap(byApproval.map((f) => '`' + f.file + '` ← ' + f.by.map((o) => '@' + o).join(' '))).join(', ') +
      '.'
    : '';

  // ── Los cuatro desenlaces ──
  let decision, note;
  if (allCovered && crisOwnsAll) {
    decision = 'approve_and_merge';
    note =
      `Toda ruta con owner de este PR ya tiene juicio humano sobre este commit: el autor ` +
      `(@${authorDisplay}) escribió y posee las suyas, o un owner humano de esa misma ruta ya aprobó.` +
      `${coverageDetail} Soy owner de todas, el gate objetivo está verde, y está declarado que el ` +
      `cambio no altera nada de lo que un usuario recibe, ve o hace. Apruebo y armo el auto-merge ` +
      `nativo: GitHub mergeará cuando se cumplan todas las protecciones.`;
  } else if (!allCovered && crisOwnsAny) {
    // El peligroso: acá la firma de Cris SERÍA la del code owner.
    decision = 'comment_only';
    note =
      `Hay rutas con owner sin juicio humano sobre este commit (${fmt(uncovered)}): el autor ` +
      `(@${authorDisplay}) no las posee y ningún owner humano de ellas ha aprobado sobre ` +
      `\`${String(headSha).slice(0, 8)}\`. Yo **sí** soy owner de parte, así que si aprobara, mi firma ` +
      `*sería* la del code owner y esto mergearía sin que nadie lo hubiera leído. No apruebo. ` +
      `Necesita revisión de ${tag}.`;
  } else if (!crisOwnsAny) {
    decision = 'approve';
    note =
      `No soy code owner de nada de lo tocado, así que mi aprobación **no es vinculante**: el gate ` +
      `sigue esperando a ${tag}. La dejo como señal de que la revisión automática pasó.` +
      deadlockNote();
  } else {
    decision = 'comment_only';
    note =
      `Lo tocado ya tiene juicio humano completo, pero yo solo soy owner de una parte (fuera de mi ` +
      `alcance: ${fmt(outOfScopeAll)}). Si aprobara, mi firma desbloquearía el PR entero — GitHub no ` +
      `ofrece "apruebo solo mi parte". No apruebo. Necesita a ${tag}.` +
      deadlockNote();
  }

  // ── Quién puede dar la orden ──
  //
  // ⚠️ EXCEPCIÓN DELIBERADA, y la más importante de este archivo: el
  // etiquetador PUEDE ser el autor.
  //
  // La consecuencia hay que decirla sin adornos, porque es real: un mantenedor
  // que posee todas las rutas tocadas puede abrir su propio PR, ponerle las dos
  // etiquetas, y esto lo mergea a producción sin que ninguna otra persona lo
  // lea. GitHub bloquea la autoaprobación directa; esta ruta la esquiva.
  //
  // Está así a propósito, y el motivo es que en este proyecto la etiqueta ES la
  // revisión humana. El flujo que esto habilita no es "un humano se aprueba
  // solo": es que el agente escribe, un mantenedor humano lee el diff y lo
  // autoriza poniendo la etiqueta, y el agente firma. Exigir un etiquetador
  // distinto del autor devolvería lo rutinario a esperar a un tercero
  // disponible, que es exactamente el cuello de botella que este archivo viene
  // a quitar en un proyecto de emergencia.
  //
  // Lo que sostiene la excepción, y sin lo cual NO sería aceptable:
  //   • solo alcanza para lo rutinario — las rutas restringidas del CODEOWNERS
  //     (esquema, biometría, privacidad, `web.js`, autenticación, `.github/`)
  //     excluyen al agente, así que ahí su firma no sirve y sigue haciendo falta
  //     una persona distinta;
  //   • el gate objetivo tiene que estar verde en ese commit;
  //   • y alguien tuvo que declarar el hecho de que nada cambia para quien usa
  //     la app.
  //
  // Está escrita también en `CONTRIBUTING.md`, donde la gente que contribuye
  // puede verla, porque una excepción que solo vive en un comentario de código
  // no es una regla del proyecto: es un secreto.
  //
  // Si alguien "arregla" esto agregando `labeler === author` a la condición de
  // abajo, la prueba «un mantenedor puede despachar lo rutinario solo» se cae —
  // y esa prueba está para que el cambio sea una decisión y no un descuido.
  //
  // La etiqueta AUTORIZA; no fabrica cobertura. Quien etiqueta no cuenta como
  // aprobador de nada. Dos fuerzas según lo que esté en juego:
  //   • para MERGEAR, quien etiqueta debe ser owner de las rutas tocadas — la
  //     etiqueta es la orden de zarpe y solo esos owners pueden darla;
  //   • para una firma no vinculante basta cualquier owner humano, porque el
  //     merge sigue bloqueado igual.
  //
  // Cris queda excluido en ambas: si pudiera autorizarse, la etiqueta dejaría
  // de ser una orden humana y sería una nota que se escribe a sí mismo.
  const allHumanOwners = [...new Set(rules.flatMap((r) => r.owners))].filter((o) => o !== crisLogin);
  if (decision === 'approve_and_merge' && (labeler === crisLogin || !union.includes(labeler))) {
    return {
      decision: 'abstain',
      reason:
        `la etiqueta la puso @${labeler || '?'}, que no es code owner de las rutas tocadas. ` +
        `\`${AUTHORIZING_LABEL}\` es la orden de merge, así que solo la acepto de un owner de esas rutas. cc ${tag}`,
    };
  }
  if (decision === 'approve' && (labeler === crisLogin || !allHumanOwners.includes(labeler))) {
    return {
      decision: 'abstain',
      reason: `la etiqueta la puso @${labeler || '?'}, que no es code owner en \`CODEOWNERS\`. cc ${tag}`,
    };
  }

  return {
    decision,
    note,
    approvers: [...approvers],
    uncovered,
    allCovered,
    crisOwnsAll,
    crisOwnsAny,
    humanOwners,
  };
}

module.exports = { decide, liveApprovers, parseCodeowners, ownersOf, compile };
module.exports.REQUIRED_CHECKS = REQUIRED_CHECKS;
module.exports.NO_USER_EFFECT_LABEL = NO_USER_EFFECT_LABEL;
module.exports.AUTHORIZING_LABEL = AUTHORIZING_LABEL;
module.exports.CODERABBIT_CHECK = CODERABBIT_CHECK;
module.exports.CODERABBIT_REVIEWED_RE = CODERABBIT_REVIEWED_RE;
module.exports.CODERABBIT_EMISORES = CODERABBIT_EMISORES;
