const test = require('node:test');
const assert = require('node:assert');
const { createSqliteAdapter } = require('../src/store/sqlite');
const { createApp } = require('../src/server');
const { nullMatcher } = require('../src/faces');

async function startApp() {
  const app = await createApp(await createSqliteAdapter(':memory:'), nullMatcher);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const DESTINATIONS = [
  'https://vaki.co/explorar',
  'https://helpcolombia.vaki.org',
  'https://vaki.co/crear'
];

test('las tres opciones de donación están en el pie, en orden y sin adivinar el país', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  for (const path of ['/', '/report', '/rescate', '/privacidad']) {
    const html = await (await fetch(`${base}${path}`)).text();

    // Las tres van juntas y etiquetadas: quien dona elige, el sitio no detecta
    // el país por él. Con VPN o desde la diáspora, adivinar manda a la puerta
    // equivocada.
    let cursor = -1;
    for (const url of DESTINATIONS) {
      const at = html.indexOf(`href="${url}"`);
      assert.ok(at > 0, `falta el enlace a ${url} en ${path}`);
      assert.ok(at > cursor, `los enlaces de donación van en orden fijo en ${path}`);
      cursor = at;
      assert.match(
        html.slice(at, at + 120),
        /target="_blank" rel="noopener"/,
        `${url} debe abrir aparte y sin opener en ${path}`
      );
    }

    // Se dice a dónde llevan ANTES de que la persona haga clic.
    const intro = html.indexOf('Este sitio no recibe donaciones');
    assert.ok(intro > 0 && intro < html.indexOf(`href="${DESTINATIONS[0]}"`), `falta el contexto en ${path}`);
    assert.match(html.slice(intro), /Vaki, una plataforma de recaudo colectivo/);
    // Y se dice el conflicto de interés: quien recomienda estos enlaces
    // cofundó la plataforma a la que llevan. Va con prueba porque es lo
    // primero que se cae en una reescritura de copy, y es justo lo que
    // convierte "puso su empresa en un sitio de catástrofe" en "lo dijo de
    // entrada". Divulgado no cuesta nada; descubierto cuesta caro.
    assert.match(
      html.slice(intro),
      /cofundada por uno de los mantenedores de este sitio/,
      `falta la divulgación del vínculo en ${path}`
    );
  }
});

test('la donación nunca le gana la atención a reportar un desaparecido', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  const html = await (await fetch(`${base}/`)).text();
  const reportar = html.indexOf('Estoy buscando a alguien');
  const rescate = html.indexOf('Rescaté a alguien');
  const asks = html.indexOf('¿Eres parte del equipo de ColombiaTeBusca?');
  const donar = html.indexOf('Este sitio no recibe donaciones');

  assert.ok(rescate > 0 && reportar > 0, 'las dos acciones primarias siguen en la portada');
  assert.ok(donar > reportar, 'la donación va debajo de «Reporta desaparecido»');
  assert.ok(donar > rescate, 'la donación va debajo de la búsqueda del rescatista');
  assert.ok(donar > asks, 'la donación va de última, debajo de las dos invitaciones del pie');

  // Ni un byte de JavaScript ni una regla de CSS nueva por esta sección: es un
  // párrafo más en el estilo que ya existe.
  const css = await (await fetch(`${base}/styles.css`)).text();
  assert.ok(!/vaki|donac/i.test(css), 'la sección de donación no necesita CSS propio');
});
