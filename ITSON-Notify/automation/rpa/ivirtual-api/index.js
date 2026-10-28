const { getToken, MoodleError } = require("./client");
const { fetchGrades } = require("./grades");

// Errorcodes de login/token.php de Moodle que indican que la contraseña se
// debe cambiar manualmente en el portal. Reintentar no sirve.
const ERRORES_CAMBIO_PASSWORD = new Set([
  "forcepasswordchangenotice",
  "passwordisexpired",
]);

// Resultados posibles de extractGrades():
//   ok            calificaciones extraídas
//   credenciales     token.php rechazó usuario/contraseña
//   cambio_password  token.php exige cambiar la contraseña (o ya expiró)
//   error            cualquier otra falla (red, 5xx tras reintentos, error de Moodle)
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
    if (error instanceof MoodleError && ERRORES_CAMBIO_PASSWORD.has(error.errorcode)) {
      return { status: "cambio_password", courses: [] };
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
