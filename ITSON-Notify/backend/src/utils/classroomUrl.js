// ITN-58e - Validación del enlace de una tarea de Google Classroom antes de mandarlo
// al frontend. Función pura: solo acepta https://classroom.google.com/... sin
// credenciales ni puerto. Cualquier otro valor (http, otro host, javascript:, data:,
// subdominio falso tipo classroom.google.com.evil.com, no-string) devuelve null.
const HOSTS_PERMITIDOS = new Set(["classroom.google.com"]);
const LARGO_MAXIMO = 2048;

function urlClassroomSegura(value) {
  if (typeof value !== "string") return null;
  const texto = value.trim();
  if (texto === "" || texto.length > LARGO_MAXIMO) return null;
  let url;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!HOSTS_PERMITIDOS.has(url.hostname)) return null;
  if (url.username || url.password || url.port) return null;
  return url.href;
}

module.exports = { urlClassroomSegura };
