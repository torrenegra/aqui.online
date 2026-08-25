// Cuándo un parecido de nombre NO alcanza para fusionar dos reportes (#150).
//
// El veto es estricto —basta que UNA declaración del registro contradiga a la
// que llega— porque los dos errores no cuestan lo mismo: vetar de más deja a
// una persona en dos registros, que el aviso de duplicados ya expone y alguien
// une; vetar de menos junta a dos personas, y marcar a una como localizada saca
// a la otra de la lista de buscados. La regla suave —«que no coincida con
// ninguna»— además se debilita justo en los registros ya contaminados por una
// fusión mala, que son los que hay que dejar de alimentar.

// La edad declarada casi siempre es una estimación, y además se mueve sola: una
// ficha de hace dos años dice 33 y la de hoy dice 35.
const AGE_MARGIN_YEARS = 5;

// Devuelve por qué no se puede fusionar, o null si nada lo impide.
//
// Una señal ausente, de cualquiera de los dos lados, nunca veta: la mayoría de
// los updates no la traen, y sin esta regla el veto se comería casi toda
// fusión legítima.
function mergeBlockReason({ department, age }, updates = []) {
  if (department) {
    for (const u of updates) {
      if (u.department && u.department !== department) return 'department';
    }
  }
  if (age !== null && age !== undefined) {
    for (const u of updates) {
      if (u.age === null || u.age === undefined) continue;
      if (Math.abs(u.age - age) > AGE_MARGIN_YEARS) return 'age';
    }
  }
  return null;
}

module.exports = { AGE_MARGIN_YEARS, mergeBlockReason };
