// Alertas técnicas al chat del equipo por Telegram (ITN-38). Lo usará
// monitors/alertas.js cuando se conecte el aviso de fallos del RPA (ITN-39).
// Guía para crear el bot y obtener el chat_id: docs/telegram-alertas.md.
//
// Vive en automation/ porque el worker-rpa de Railway solo despliega esa
// carpeta (rootDirectory) y es quien detecta los fallos. No tiene
// dependencias: usa el fetch de Node >= 20.
//
// Reglas:
//   - Token y chat_id solo de variables de entorno (TELEGRAM_BOT_TOKEN,
//     TELEGRAM_CHAT_ID). Nunca se imprimen.
//   - Nunca lanza: si falta configuración, el mensaje no pasa el filtro o
//     Telegram falla, devuelve { ok: false, motivo } y el proceso sigue.
//   - Solo mensajes técnicos cortos. Se rechaza (no se "limpia") cualquier
//     texto que parezca llevar contraseñas, tokens o datos de alumnos.

const MAX_LONGITUD = 300;
const TIMEOUT_MS = 10_000;

// Cada regla describe algo que nunca debe salir hacia Telegram. Se busca la
// forma "clave=valor" y no la palabra sola, para que un aviso como
// "Extracción detenida: cambio_password" sí pase.
const PATRONES_PROHIBIDOS = [
  { motivo: "token de bot de Telegram", re: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/ },
  { motivo: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { motivo: "header de autorización", re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i },
  {
    motivo: "credencial con valor",
    re: /\b(pass(word)?|contrase(ñ|n)a|pwd|p_user|id_user|token|wstoken|secret|api[_-]?key|x-api-key|service_role\w*|authorization)\b\s*["']?\s*[:=]\s*\S+/i,
  },
  { motivo: "parámetro sensible en URL", re: /[?&](password|token|wstoken|key|apikey)=/i },
  { motivo: "correo electrónico", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // Matrículas (11 dígitos), teléfonos e IDs largos. Las fechas ISO no
  // chocan porque sus números van separados por guiones o dos puntos.
  { motivo: "número largo (matrícula, teléfono o ID)", re: /\d{6,}/ },
  { motivo: "CURP", re: /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/i },
  { motivo: "cadena larga tipo llave o hash", re: /[A-Za-z0-9_+/=-]{32,}/ },
];

// Devuelve null si el texto se puede enviar, o el motivo del rechazo. El
// motivo es genérico y nunca repite el fragmento encontrado.
function validarMensaje(texto) {
  if (typeof texto !== "string" || texto.trim() === "") return "mensaje vacío";
  if (texto.length > MAX_LONGITUD) return `mensaje de más de ${MAX_LONGITUD} caracteres`;
  const regla = PATRONES_PROHIBIDOS.find(({ re }) => re.test(texto));
  return regla ? `posible dato sensible (${regla.motivo})` : null;
}

async function sendTeamAlert(
  texto,
  { env = process.env, fetchFn = globalThis.fetch, log = console.error } = {},
) {
  try {
    const motivoRechazo = validarMensaje(texto);
    if (motivoRechazo) {
      log(`Alerta de Telegram rechazada: ${motivoRechazo}.`);
      return { ok: false, motivo: "rechazado" };
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      log("Alerta de Telegram no enviada: faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID.");
      return { ok: false, motivo: "sin_configuracion" };
    }

    const respuesta = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Sin parse_mode: texto plano, así nada del mensaje se interpreta como
      // Markdown/HTML.
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!respuesta.ok) {
      // La descripción de Telegram ("chat not found", "Unauthorized"...) no
      // incluye el token; la URL sí, por eso nunca se imprime.
      const cuerpo = await respuesta.json().catch(() => ({}));
      log(`Telegram respondió ${respuesta.status}: ${cuerpo.description ?? "sin descripción"}.`);
      return { ok: false, motivo: "error_telegram", status: respuesta.status };
    }
    return { ok: true };
  } catch (error) {
    // Solo el tipo de error: el mensaje de un fallo de red podría traer la URL.
    log(`Alerta de Telegram no enviada: ${error?.name ?? "error"} al llamar a la API.`);
    return { ok: false, motivo: "error_red" };
  }
}

module.exports = { sendTeamAlert, validarMensaje, MAX_LONGITUD };
