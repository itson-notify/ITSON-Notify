// ITN-55 - Validación del perfil ITSON que el alumno guarda en /api/itson-profile
// y la regla que amarra la matrícula al correo institucional de la sesión.
const { z } = require("zod");

// 11 dígitos que empiezan con 00000 (la forma que pide la API y el Onboarding).
const MATRICULA = /^00000\d{6}$/;
// Código de carrera, p. ej. INSOF. Sin lista cerrada todavía.
const CAREER = /^[A-Z]{2,8}$/;

// Dominios cuyo correo identifica al alumno. Un correo de Gmail no sirve: cualquiera
// puede crear uno que termine con los dígitos de otra matrícula.
const DOMINIOS_INSTITUCIONALES = Object.freeze(["potros.itson.edu.mx"]);

// Dígitos finales de la matrícula que deben coincidir con el final de la parte
// local del correo (pedro.izquierdo252587@... con 00000252587).
const DIGITOS_COMPARADOS = 6;

const schema = z.object({
  matricula: z.string().trim().regex(MATRICULA),
  career: z.string().trim().toUpperCase().regex(CAREER),
});

// Devuelve { success: true, data: { matricula, career } } o { success: false, issues }.
// issues solo trae ruta y código, nunca el valor. Campos extra (userId, email,
// user) se descartan.
function parseItsonProfile(body) {
  const result = schema.safeParse(body);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  };
}

// Revisa que la matrícula sea la del dueño del correo de la sesión. Devuelve null si
// coincide o el código de error:
//   correo_no_institucional  el correo no es de un dominio institucional
//   correo_sin_matricula     la parte local no termina con al menos 6 dígitos
//   matricula_no_coincide    los últimos 6 dígitos no son los del correo
function verificarMatriculaConCorreo(matricula, email) {
  const [local, dominio] = String(email ?? "").toLowerCase().split("@");
  if (!local || !DOMINIOS_INSTITUCIONALES.includes(dominio)) return "correo_no_institucional";
  const digitos = /(\d+)$/.exec(local)?.[1] ?? "";
  if (digitos.length < DIGITOS_COMPARADOS) return "correo_sin_matricula";
  if (digitos.slice(-DIGITOS_COMPARADOS) !== String(matricula).slice(-DIGITOS_COMPARADOS)) {
    return "matricula_no_coincide";
  }
  return null;
}

// Pista para mostrar en Ajustes: solo los últimos 4 dígitos.
const pistaMatricula = (matricula) => `${"•".repeat(7)}${String(matricula).slice(-4)}`;

module.exports = {
  parseItsonProfile,
  verificarMatriculaConCorreo,
  pistaMatricula,
  MATRICULA,
  CAREER,
  DOMINIOS_INSTITUCIONALES,
};
