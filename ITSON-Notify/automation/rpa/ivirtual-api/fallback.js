// ============================================================================
//  RESPALDO, NO CAMINO PRINCIPAL.
//  El camino principal es extractGrades() de ./index (API de Moodle).
//  Este wrapper solo entra si la API falla de forma persistente, es decir,
//  si extractGrades() devuelve 'error' después de agotar sus reintentos.
// ============================================================================
//
// Qué hace el respaldo HOY: abre Playwright e intenta el login existente de
// ../portal-itson/login.js para distinguir "iVirtual está caído" de "solo la
// API de servicios web falla" (p. ej. si ITSON deshabilita moodle_mobile_app).
// NO extrae calificaciones del HTML: ese scraper todavía no existe, así que
// el resultado siempre trae courses vacío y status 'error'.
//
// No se usa cuando el status es 'credenciales': el login web fallaría igual y
// solo sumaría intentos fallidos a la cuenta.
const { extractGrades } = require("./index");

async function extractGradesWithFallback(credenciales, opts) {
  const result = await extractGrades(credenciales, opts);
  if (result.status !== "error") {
    return { ...result, source: "api" };
  }

  // Playwright se carga solo aquí para que el camino principal no dependa de él.
  const { launchBrowser, createContext } = require("../portal-itson/browser");
  const { login } = require("../portal-itson/login");

  let portalLogin;
  const browser = await launchBrowser();
  try {
    const context = await createContext(browser);
    const page = await context.newPage();
    ({ status: portalLogin } = await login(page, credenciales));
  } catch (error) {
    portalLogin = "error";
    result.error = `${result.error}; respaldo Playwright: ${error.message}`;
  } finally {
    await browser.close();
  }

  return {
    status: "error",
    courses: [],
    source: "playwright",
    error: result.error,
    errorcode: result.errorcode,
    // 'ok' aquí significa que el portal web responde pero la API no:
    // hay que revisar el servicio moodle_mobile_app en iVirtual.
    portalLogin,
  };
}

module.exports = { extractGradesWithFallback };
