// ITN-55 - Códigos de gradeValue de la API REST de ITSON (getGrades).
// Único lugar donde se tratan. Observado en respuestas reales:
//   "-"       sin calificación (materias en curso y semestres que no empiezan)
//   "0".."10" calificación numérica
//   "A"       SIGNIFICADO SIN CONFIRMAR. No se interpreta: se guarda, se compara y se
//             muestra como el texto literal "A", sin convertirlo a número ni a otra
//             palabra. Si ITSON confirma qué significa, se decide aquí.
// Ningún código se interpreta: todos menos "-" se guardan y se muestran tal cual.

// Valor que la API usa para "sin calificación". En el snapshot se guarda null.
const SIN_CALIFICACION = "-";

// Forma aceptada de un código ya normalizado (sin el "-").
const CODIGO_VALIDO = /^[0-9A-Z]{1,3}$/;

// "-" (o vacío) es null; lo demás se recorta y se deja como texto.
function normalizarCodigo(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  if (texto === "" || texto === SIN_CALIFICACION) return null;
  return texto;
}

// Texto del aviso: el código literal ("9", "A"); null es "sin calificación".
function describirCodigo(codigo) {
  if (codigo === null || codigo === undefined) return "sin calificación";
  return String(codigo);
}

module.exports = { SIN_CALIFICACION, CODIGO_VALIDO, normalizarCodigo, describirCodigo };
