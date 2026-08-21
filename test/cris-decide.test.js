// El módulo que decide si el agente puede aprobar y mergear un PR.
//
// `main` es producción, así que cada `approve_and_merge` de este módulo es un
// despliegue. Lo que estas pruebas protegen no es que apruebe cuando debe —eso
// es una línea— sino que **se niegue** en cada una de las formas en que se
// tiene que negar. Si alguna se cae en un refactor, el síntoma no es un error:
// es un merge silencioso que nadie leyó.
//
// Se apoyan en el CODEOWNERS REAL del repo a propósito. Un fixture inventado
// probaría el motor de patrones contra un mundo que no existe; contra el
// archivo de verdad, la prueba se entera si alguien mueve a la cuenta del
// agente a una ruta restringida.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { decide, liveApprovers, parseCodeowners, ownersOf } = require('../.github/scripts/cris-decide.cjs');

const CODEOWNERS = fs.readFileSync(path.join(__dirname, '..', '.github', 'CODEOWNERS'), 'utf8');

const CRIS = 'cris-pappcorn';
const HEAD = 'abc1234def5678';

// Un PR sano: autor humano, rutas rutinarias, checks verdes, las dos etiquetas,
// y la etiqueta puesta por un owner que no es el agente. Cada prueba rompe
// exactamente una cosa.
function pr(overrides = {}) {
  return {
    crisLogin: CRIS,
    author: 'ni500',
    authorDisplay: 'ni500',
    labeler: 'ni500',
    headSha: HEAD,
    currentHeadSha: HEAD,
    baseRef: 'main',
    draft: false,
    codeowners: CODEOWNERS,
    labels: ['ready-to-merge', 'efecto-usuario:ninguno'],
    files: ['README.md'],
    reviews: [],
    checkRuns: [
      { name: 'npm test', status: 'completed', conclusion: 'success', started_at: '2026-08-15T10:00:00Z' },
      {
        name: 'CodeRabbit',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-15T10:00:00Z',
        description: 'Review completed',
        creator: 'coderabbitai',
      },
    ],
    ...overrides,
  };
}

test('el camino feliz: rutas rutinarias, todo verde y declarado → aprueba y arma el merge', () => {
  const d = decide(pr());
  assert.equal(d.decision, 'approve_and_merge');
});

// ── El freno propio de este repo ────────────────────────────────────────────
// CODEOWNERS reparte por ruta, y "cambia lo que un usuario ve" no es una ruta.

test('sin la etiqueta que declara el efecto en el usuario, NO firma', () => {
  const d = decide(pr({ labels: ['ready-to-merge'] }));
  assert.equal(d.decision, 'comment_only');
  assert.equal(d.missingUserEffectLabel, true);
  assert.match(d.note, /recibiría, vería o haría algo distinto/i);
});

test('si la etiqueta que autoriza ya no está en el PR, no firma', () => {
  // El workflow arranca por un evento `labeled`, que dice que alguien la puso
  // en algún momento — no que siga ahí. Si alguien se arrepintió mientras
  // corría, esto lo respeta en vez de firmar por inercia.
  const d = decide(pr({ labels: ['efecto-usuario:ninguno'] }));
  assert.equal(d.decision, 'abstain');
  assert.match(d.reason, /ready-to-merge/);
});

test('la ausencia de esa etiqueta no se compensa con nada más', () => {
  // Todo lo demás perfecto —incluida una aprobación humana vigente— y aun así
  // no firma: la declaración falta, y este módulo no la adivina.
  const d = decide(
    pr({
      labels: ['ready-to-merge'],
      reviews: [
        { user: { login: 'torrenegra', type: 'User' }, state: 'APPROVED', commit_id: HEAD, id: 1 },
      ],
    })
  );
  assert.equal(d.decision, 'comment_only');
});

// ── Identidad ───────────────────────────────────────────────────────────────

test('nunca aprueba su propio PR', () => {
  const d = decide(pr({ author: CRIS, authorDisplay: CRIS }));
  assert.equal(d.decision, 'abstain');
  assert.match(d.reason, /mi propio trabajo/i);
});

test('no se autoriza a sí mismo: si él puso la etiqueta, se abstiene', () => {
  const d = decide(pr({ labeler: CRIS }));
  assert.equal(d.decision, 'abstain');
  assert.match(d.reason, /orden de merge/i);
});

test('EXCEPCIÓN DELIBERADA: un mantenedor puede despachar lo rutinario solo', () => {
  // El autor y el etiquetador pueden ser la misma persona. Es la excepción más
  // consecuente del módulo y está acá para que quitarla sea una decisión y no
  // un descuido: si alguien agrega `labeler === author` a la condición, esta
  // prueba se cae y le cuenta por qué existía.
  //
  // Lo que la hace aceptable no está en esta línea sino alrededor: solo aplica
  // a rutas rutinarias (las restringidas excluyen al agente), exige el gate
  // objetivo verde, y exige que alguien haya declarado que nada cambia para
  // quien usa la app. Ver el bloque «Quién puede dar la orden» en el módulo y
  // la sección correspondiente del CONTRIBUTING.
  const d = decide(pr({ author: 'ni500', labeler: 'ni500' }));
  assert.equal(d.decision, 'approve_and_merge');
});

test('la excepción NO se extiende a las rutas restringidas', () => {
  // Mismo caso de arriba —autor y etiquetador son la misma persona— pero
  // tocando privacidad. Acá el agente no es owner, así que su firma no sirve y
  // sigue haciendo falta otra persona.
  const d = decide(pr({ author: 'ni500', labeler: 'ni500', files: ['src/privacy.js'] }));
  assert.notEqual(d.decision, 'approve_and_merge');
});

test('una etiqueta puesta por alguien que no es code owner no autoriza nada', () => {
  const d = decide(pr({ labeler: 'alguien-de-paso' }));
  assert.equal(d.decision, 'abstain');
});

// ── La geografía del CODEOWNERS, contra el archivo real ─────────────────────

test('en una ruta restringida no es owner, así que no puede mergear', () => {
  // El esquema de la base: el CODEOWNERS real lo ancla a personas.
  const d = decide(pr({ files: ['src/store/postgres.js'] }));
  assert.notEqual(d.decision, 'approve_and_merge');
});

test('un PR que mezcla lo rutinario con una ruta restringida tampoco pasa', () => {
  const d = decide(pr({ files: ['README.md', 'src/privacy.js'] }));
  assert.notEqual(d.decision, 'approve_and_merge');
  assert.notEqual(d.decision, 'approve');
});

test('no puede tocar lo que le da poder: `.github/` lo excluye', () => {
  // Si el agente pudiera aprobar cambios a `.github/`, podría firmar el PR que
  // le quita el freno — su propio workflow, su propio CODEOWNERS, o el check
  // obligatorio de la regla de rama. Todo lo demás en este archivo colgaría de
  // ahí.
  const d = decide(pr({ files: ['.github/workflows/cris-approve.yml'] }));
  assert.notEqual(d.decision, 'approve_and_merge');

  const rules = parseCodeowners(CODEOWNERS);
  assert.ok(
    !ownersOf(rules, '.github/workflows/cris-approve.yml').includes(CRIS),
    'NO debería ser owner de su propio workflow'
  );
  assert.ok(!ownersOf(rules, '.github/CODEOWNERS').includes(CRIS), 'NO debería ser owner del CODEOWNERS');
});

test('el gate acepta a CodeRabbit, que llega como commit status y no como check run', () => {
  // CodeRabbit no aparece en `checks.listForRef`: es un `context` de status.
  // Quien llama tiene que mezclar las dos fuentes y normalizarlas, y esta
  // prueba fija esa forma — si alguien deja de mezclarlas, el aprobador aborta
  // en todos los PRs por un check que sí corrió.
  const d = decide(pr());
  assert.equal(d.decision, 'approve_and_merge');

  const sinCodeRabbit = decide(
    pr({
      checkRuns: [
        { name: 'npm test', status: 'completed', conclusion: 'success', started_at: '2026-08-15T10:00:00Z' },
      ],
    })
  );
  assert.equal(sinCodeRabbit.decision, 'abort');
  assert.match(sinCodeRabbit.reason, /CodeRabbit/);
});

// ── La lista blanca de CodeRabbit (issue #199) ──────────────────────────────
//
// `conclusion: 'success'` no basta para este check puntual: CodeRabbit lo
// reporta igual cuando revisó y no encontró nada que cuando NO revisó —cupo
// agotado, PR en draft, y lo que aparezca después—. La única defensa es exigir
// que `description` AFIRME la revisión, en vez de descartar las causas de
// fallo que ya conocemos. Por eso los cuatro casos de abajo: el sano, las dos
// causas medidas en PRs reales el mismo día, y una tercera inventada — esa
// última es la que de verdad separa una lista blanca de una negra. Si solo se
// probaran las dos causas conocidas, un refactor que las volviera un
// blacklist pasaría estas mismas pruebas y el hueco del issue seguiría
// abierto.
function coderabbitStatus(description, creator = 'coderabbitai') {
  return {
    name: 'CodeRabbit',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-08-15T10:00:00Z',
    description,
    creator,
  };
}
const NPM_TEST_OK = {
  name: 'npm test',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-08-15T10:00:00Z',
};

test('CodeRabbit "Review completed": afirma la revisión, pasa', () => {
  const d = decide(pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review completed')] }));
  assert.equal(d.decision, 'approve_and_merge');
});

test('CodeRabbit "Review rate limited": success sin haber revisado, aborta (caso real #186)', () => {
  const d = decide(pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review rate limited')] }));
  assert.equal(d.decision, 'abort');
  assert.match(d.reason, /CodeRabbit/);
  // El `reason` tiene que decir la descripción EXACTA que encontró, para que
  // quien lea el log sepa si fue una causa real o un falso positivo de la
  // lista blanca — no basta con saber que abortó.
  assert.match(d.reason, /Review rate limited/);
});

test('CodeRabbit "Review skipped: draft pull request": success sin haber revisado, aborta (caso real #201)', () => {
  const d = decide(pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review skipped: draft pull request')] }));
  assert.equal(d.decision, 'abort');
  assert.match(d.reason, /CodeRabbit/);
  assert.match(d.reason, /Review skipped: draft pull request/);
});

test('CodeRabbit con una descripción desconocida e inventada TAMBIÉN aborta: la lista es BLANCA, no negra', () => {
  // La prueba que de verdad distingue las dos estrategias. Una lista NEGRA
  // con solo las dos causas de arriba dejaría pasar este texto porque no
  // está en su catálogo de excusas conocidas. La lista BLANCA lo detiene
  // igual, porque nunca afirmó lo único que hace falta: que la revisión
  // ocurrió sobre este diff.
  const d = decide(pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review postponed: quota reshuffled by provider')] }));
  assert.equal(d.decision, 'abort');
  assert.match(d.reason, /CodeRabbit/);
  assert.match(d.reason, /Review postponed: quota reshuffled by provider/);
});

test('los owners NO se acumulan entre reglas: el catch-all no posee lo restringido', () => {
  // Es la línea de la que cuelga todo el reparto. Si `ownersOf` acumulara, el
  // agente —que está en `*`— sería owner del esquema de la base.
  const rules = parseCodeowners(CODEOWNERS);
  assert.ok(ownersOf(rules, 'README.md').includes(CRIS), 'debería ser owner de lo rutinario');
  assert.ok(!ownersOf(rules, 'src/store/postgres.js').includes(CRIS), 'NO debería ser owner del esquema');
});

// ── El gate objetivo ────────────────────────────────────────────────────────

test('un check en rojo aborta', () => {
  const d = decide(
    pr({
      checkRuns: [
        { name: 'npm test', status: 'completed', conclusion: 'failure', started_at: '2026-08-15T10:00:00Z' },
        {
        name: 'CodeRabbit',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-15T10:00:00Z',
        description: 'Review completed',
        creator: 'coderabbitai',
      },
      ],
    })
  );
  assert.equal(d.decision, 'abort');
});

test('un check que no corrió aborta — no se asume verde por ausencia', () => {
  const d = decide({ ...pr(), checkRuns: [{ name: 'npm test', status: 'completed', conclusion: 'success' }] });
  assert.equal(d.decision, 'abort');
  assert.match(d.reason, /CodeRabbit/);
});

test('gana la última corrida CONCLUIDA, no la última empezada', () => {
  // Poner la etiqueta puede disparar corridas nuevas. Leer la última EMPEZADA
  // haría que el agente se encuentre siempre una en `queued` y se quite la
  // etiqueta a sí mismo.
  const d = decide(
    pr({
      checkRuns: [
        { name: 'npm test', status: 'completed', conclusion: 'success', started_at: '2026-08-15T10:00:00Z' },
        { name: 'npm test', status: 'queued', started_at: '2026-08-15T11:00:00Z' },
        {
        name: 'CodeRabbit',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-15T10:00:00Z',
        description: 'Review completed',
        creator: 'coderabbitai',
      },
      ],
    })
  );
  assert.equal(d.decision, 'approve_and_merge');
});

test('si la última concluida es roja, una corrida en vuelo no la rescata', () => {
  const d = decide(
    pr({
      checkRuns: [
        { name: 'npm test', status: 'completed', conclusion: 'failure', started_at: '2026-08-15T10:00:00Z' },
        { name: 'npm test', status: 'in_progress', started_at: '2026-08-15T11:00:00Z' },
        {
        name: 'CodeRabbit',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-08-15T10:00:00Z',
        description: 'Review completed',
        creator: 'coderabbitai',
      },
      ],
    })
  );
  assert.equal(d.decision, 'abort');
});

test('si el head se movió durante la corrida, no firma', () => {
  const d = decide(pr({ currentHeadSha: 'otracosa999' }));
  assert.equal(d.decision, 'abort');
  assert.match(d.reason, /no evalué/i);
});

test('un PR en draft aborta', () => {
  const d = decide(pr({ draft: true }));
  assert.equal(d.decision, 'abort');
});

test('un CODEOWNERS vacío en la base lo deja sin respaldo, y se abstiene', () => {
  const d = decide(pr({ codeowners: '# solo comentarios\n' }));
  assert.equal(d.decision, 'abstain');
});

// ── Aprobaciones vigentes ───────────────────────────────────────────────────

test('una aprobación sobre otro commit no cubre este', () => {
  const vivos = liveApprovers(
    [{ user: { login: 'torrenegra', type: 'User' }, state: 'APPROVED', commit_id: 'viejo000', id: 1 }],
    HEAD,
    CRIS
  );
  assert.equal(vivos.size, 0);
});

test('un CHANGES_REQUESTED posterior revierte el APPROVED del mismo humano', () => {
  const vivos = liveApprovers(
    [
      { user: { login: 'torrenegra', type: 'User' }, state: 'APPROVED', commit_id: HEAD, id: 1, submitted_at: '2026-08-15T10:00:00Z' },
      { user: { login: 'torrenegra', type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: HEAD, id: 2, submitted_at: '2026-08-15T11:00:00Z' },
    ],
    HEAD,
    CRIS
  );
  assert.equal(vivos.size, 0);
});

test('la firma de un bot no es juicio humano, y la del propio agente no cuenta', () => {
  const vivos = liveApprovers(
    [
      { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: HEAD, id: 1 },
      { user: { login: CRIS, type: 'User' }, state: 'APPROVED', commit_id: HEAD, id: 2 },
    ],
    HEAD,
    CRIS
  );
  assert.equal(vivos.size, 0);
});

// ── Quién FIRMA el status, que es la mitad que faltaba ──────────────────────
//
// La lista blanca de la descripción no protege nada por sí sola: un commit
// status NO es un check run — lo puede crear cualquier cuenta con permiso de
// escritura, con el `context` y la `description` que quiera. Preguntarle a un
// desconocido si revisó no vale más que su palabra.

test('un status «CodeRabbit» firmado por otra cuenta no cuenta como revisión', () => {
  const d = decide(
    pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review completed', 'alguien-con-push')] })
  );
  assert.equal(d.decision, 'abort');
  // El motivo tiene que nombrar al emisor: quien lea el log necesita saber
  // QUIÉN lo firmó, no solo que se rechazó.
  assert.match(d.reason, /alguien-con-push/);
});

test('un status sin emisor identificable tampoco pasa', () => {
  // Se borra la propiedad en vez de pasar `undefined`: pasarlo activaría el
  // valor por defecto del parámetro y la prueba mediría lo contrario de lo que
  // dice su nombre. Es el caso de una API que no devuelve `creator`.
  const sinEmisor = coderabbitStatus('Review completed');
  delete sinEmisor.creator;
  const d = decide(pr({ checkRuns: [NPM_TEST_OK, sinEmisor] }));
  assert.equal(d.decision, 'abort');
});

test('se acepta la forma con sufijo [bot], porque GitHub reporta las Apps así', () => {
  // Cuál de las dos formas llega depende de si el status lo creó la App o su
  // cuenta asociada, y ninguna es menos legítima que la otra.
  const d = decide(
    pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review completed', 'coderabbitai[bot]')] })
  );
  assert.equal(d.decision, 'approve_and_merge');
});

test('el emisor se valida ANTES que la descripción', () => {
  // Si el orden se invirtiera, el motivo del rechazo hablaría de la
  // descripción de un impostor — como si su texto fuera el problema y no su
  // identidad.
  const d = decide(pr({ checkRuns: [NPM_TEST_OK, coderabbitStatus('Review rate limited', 'impostor')] }));
  assert.equal(d.decision, 'abort');
  assert.match(d.reason, /impostor/);
});
