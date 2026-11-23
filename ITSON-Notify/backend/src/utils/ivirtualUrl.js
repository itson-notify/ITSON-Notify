// ITN-58g - Enlace a la página de una materia de iVirtual (Moodle). Función pura:
// solo acepta como id de curso un entero positivo de hasta 10 dígitos (string o
// número); cualquier otro valor (vacío, cero, negativo, con espacios, con letras,
// no-string) devuelve null. La URL no se registra en logs.
const BASE = "https://ivirtual.itson.edu.mx/course/view.php?id=";
const ID_VALIDO = /^[1-9][0-9]{0,9}$/;

function urlMateriaIvirtual(id) {
  let texto;
  if (typeof id === "string") texto = id;
  else if (typeof id === "number" && Number.isSafeInteger(id)) texto = String(id);
  else return null;
  if (!ID_VALIDO.test(texto)) return null;
  return `${BASE}${texto}`;
}

module.exports = { urlMateriaIvirtual };
