// El consentimiento y el copy sensible del flujo de rescate (/rescate):
// la promesa de que la foto de consulta no se guarda, la casilla con la que
// alguien renuncia al aviso a cambio de no indexar su firma facial, y el
// bloque que decide qué contacto se le pinta en pantalla a un rescatista tras
// una coincidencia.
//
// Vivía en src/routes/web.js, que hasta el 19-ago-2026 estaba restringido
// ENTERO porque mezclaba estas piezas con el copy más rutinario del sitio
// (ver .github/CODEOWNERS, bloque "La app pública"). Este módulo es la
// salida que ese bloque pedía: se movieron las funciones tal cual, sin
// cambiar una sola línea de comportamiento observable.
const { esc } = require('./html');

const RESCUE_PRIVACY = `<p class="privacy">🔒 <strong>La foto no se guarda.</strong> Se compara al instante contra las fotos de las personas reportadas como desaparecidas y se borra de inmediato: no queda almacenada en ningún servidor. Solo conservamos su <em>firma facial</em> (un código que no permite reconstruir la imagen) para poder avisarte si alguien empieza a buscar a esta persona.</p>`;

// Opción de consulta efímera. Va APAGADA y el costo se lee ANTES de marcarla,
// porque lo que quita no es un detalle: sin firma facial indexada, esta
// consulta no puede recibir después el aviso de que alguien reportó a esa
// persona — que es lo más útil que hace la app para quien la está buscando.
// Escribirlo suave sería venderle privacidad a alguien que en realidad está
// renunciando al aviso sin darse cuenta.
// Función y no constante: el reintento tiene que poder devolverla MARCADA, y
// parchar una plantilla de texto con un `replace` deja de funcionar en silencio
// el día que alguien reordene los atributos. Acá lo que está en juego es el
// consentimiento de alguien sobre su propia firma facial.
const searchOnlyCheckbox = (checked = false) => `<label class="share-check">
    <input type="checkbox" name="solo_busqueda" value="1"${checked ? ' checked' : ''}>
    Solo consultar ahora: no guarden nada de esta foto
  </label>
  <p class="subtle share-note"><strong>Ojo con lo que esto implica:</strong> no guardamos la firma facial, así que <strong>no vamos a poder avisarte si alguien reporta a esta persona más adelante</strong>. Esta consulta sirve solo para lo que veas ahora en pantalla, y el correo y el WhatsApp de arriba quedan sin efecto. Si la dejas sin marcar, la firma queda guardada y podemos avisarte.</p>`;

// What the rescuer can DO with a match depends on what the report carries.
// Reports typed into the app bring the family's contact; the fichas imported
// from public registries bring none — and a match that ends in "sin datos de
// contacto" is a dead end exactly when it matters most. In that case the app
// flips the ask: the rescuer leaves a number and where the person can be
// found, and the operators relay the aviso back to the source registry (for
// Colombia Te Busca, filling their information form on the rescuer's behalf).
function matchContactBlock(m) {
  // El `contact` de un aviso NO es el contacto de quien la busca: es el
  // teléfono de un tercero que pasó por acá antes, pegado al sitio donde dijo
  // que estaba la persona. Los dos datos caen en el mismo campo que usa el
  // reporte de una familia y hasta acá se pintaban igual, así que el siguiente
  // desconocido que coincidiera con esa cara los veía en pantalla — después de
  // que a quien los dejó le prometimos que su teléfono no se mostraba (#120).
  //
  // El filtro va acá, al PINTAR, y no sobre el dato guardado: así cubre
  // también los avisos que ya estaban escritos, sin tocar la base y sin perder
  // el aviso, que es el insumo con el que un operador hace el relevo.
  //
  // `contactUpdate` lo resuelve identifyRescuedPerson (src/facematch.js) y NO
  // es lo mismo que `m.update`: este último es el más reciente —que puede ser
  // justamente un aviso—, y aquel es el más reciente cuyo contacto es de quien
  // la busca. Mirar solo el último dejaba sin mostrar el teléfono que la
  // familia sí había dejado en un reporte anterior.
  const fromAviso = m.update && m.update.source === 'rescate';
  if (m.contactUpdate && m.contactUpdate.contact) {
    return `<p>📞 <strong>Contacta a quien la busca:</strong> ${esc(m.contactUpdate.contact)}</p>`;
  }
  // La bifurcación de acá arriba existe porque medimos quién estaba llenando
  // este formulario: de 23 avisos recibidos, uno solo tenía forma de rescate.
  // Los demás los mandó gente que está BUSCANDO a esa persona y llegó hasta
  // acá porque el botón que vio decía «¿la tienes contigo?» — y terminaba
  // escribiendo la dirección de la casa de su familiar en un campo que le
  // pedía dónde encontrarla. Preguntar de frente es más barato que adivinar
  // después, y le abre a esa persona la puerta que en realidad venía a buscar.
  //
  // El nombre va DENTRO de la pregunta a propósito: «esa persona» es
  // justamente lo que se venía leyendo al revés.
  const name = esc(m.person.full_name);
  return `<div class="aviso">
  <p><strong>La están buscando, pero el reporte no trae un teléfono al que llamar.</strong>${
    fromAviso ? ' Otra persona ya nos avisó por esta misma ficha y el equipo está haciéndole llegar el aviso a quien la busca.' : ''
  }</p>
  <p class="aviso-pregunta">¿Tienes a ${name} contigo en este momento?</p>
  <details class="aviso-si">
    <summary class="big-btn report">✅ Sí, está aquí conmigo</summary>
    <div class="aviso-si-cuerpo">
      <p>Déjanos tu número y dónde está ${name} ahora: nosotros le hacemos llegar el aviso a quien la busca.</p>
      <form class="stack compact" method="post" action="/rescate/aviso">
        <input type="hidden" name="person_id" value="${esc(m.person.id)}">
        <label class="field-label"><span>Tu teléfono (WhatsApp si tienes) *</span>
          <input name="phone" required maxlength="60" placeholder="Ej. 300 123 4567" autocomplete="tel" inputmode="tel"></label>
        <label class="field-label"><span>¿En qué lugar está ${name} en este momento? *</span>
          <input name="location" required maxlength="160" placeholder="Ej. Hospital San Jorge, Pereira — urgencias"></label>
        <p class="subtle">El sitio donde está <strong>${name}</strong>, no dónde estás tú. Ejemplo: «Hospital San Jorge, Pereira — urgencias» o «Albergue del coliseo, Quibdó».</p>
        <button class="big-btn report" type="submit">Avisar a quien la busca</button>
      </form>
    </div>
  </details>
  <a class="big-btn secondary" href="${esc(`/report?name=${encodeURIComponent(m.person.full_name)}&desde=${encodeURIComponent(m.person.id)}`)}">🙋 No — yo soy quien la está buscando</a>
  <p class="subtle">Si la estás buscando, agrega tu teléfono al reporte: así el rescatista que la encuentre te llama directo, sin que nadie más tenga que intermediar.</p>
</div>`;
}

module.exports = { RESCUE_PRIVACY, searchOnlyCheckbox, matchContactBlock };
