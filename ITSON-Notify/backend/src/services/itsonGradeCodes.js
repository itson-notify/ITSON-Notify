// ITN-55 - Códigos de gradeValue de la API REST de ITSON (getGrades).
// Único lugar donde se interpretan. Observado en respuestas reales:
//   "-"       sin calificación (materias en curso y semestres que no empiezan)
//   "0".."10" calificación numérica
//   "A"       acreditada: resultado final sin nota numérica (probable)
// Otros códigos se guardan y se muestran tal cual.

// Valor que la API usa para "sin calificación". En el snapshot se guarda null.
const SIN_CALIFICACION = "-";

// Texto que se muestra en el aviso para los códigos que no son números.
const DESCRIPCION_CODIGO = Object.freeze({
  A: "acreditada",
});

// Forma aceptada de un código ya normalizado (sin el "-").
const CODIGO_VALIDO = /^[0-9A-Z]{1,3}$/;

// "-" (o vacío) es null; lo demás se recorta y se deja como texto.
function normalizarCodigo(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (texto === "" || texto === SIN_CALIFICACION) return null;
  return texto;
}

// Texto del aviso: "acreditada" para "A", el código tal cual para lo demás.
function describirCodigo(codigo) {
  if (codigo === null || codigo === undefined) return "sin calificación";
  return DESCRIPCION_CODIGO[codigo] ?? String(codigo);
}

module.exports = { SIN_CALIFICACION, DESCRIPCION_CODIGO, CODIGO_VALIDO, normalizarCodigo, describirCodigo };
