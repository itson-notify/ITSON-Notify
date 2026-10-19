const { getToken, MoodleError } = require("./client");
const { fetchGrades } = require("./grades");

// Resultados posibles de extractGrades():
//   ok            calificaciones extraídas
//   credenciales  token.php rechazó usuario/contraseña
//   error         cualquier otra falla (red, 5xx tras reintentos, error de Moodle)
//
// El token solo vive en la variable local `token` de esta función: no se
// guarda en disco, no se devuelve y no se loguea.
async function extractGrades({ usuario, password }, opts) {
  try {
    const token = await getToken({ usuario, password }, opts);
    const courses = await fetchGrades(token, opts);
    return { status: "ok", courses };
  } catch (error) {
    if (error instanceof MoodleError && error.errorcode === "invalidlogin") {
      return { status: "credenciales", courses: [] };
    }
    return {
      status: "error",
      courses: [],
      error: error.message,
      errorcode: error.errorcode ?? null,
    };
  }
}

module.exports = { extractGrades };
