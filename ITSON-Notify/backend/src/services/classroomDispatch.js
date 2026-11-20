// ITN-50 - Despacho de avisos de tareas nuevas de Classroom.
// Toma los eventos pendientes de classroom_task_events (outbox de la 016), arma
// el aviso "Nueva tarea publicada" y lo envía por los mismos canales que iVirtual
// (log, correo y Push), registrando cada envío en notifications_log.
//
// Idempotencia y reintento (mismas reglas que notificationService):
//   - Cada (evento, canal) tiene una sola fila en el ledger (ver
//     classroomDispatchRepository.claimNotification). Un canal ya 'sent' no se
//     vuelve a enviar; uno 'pending' o 'failed' se reintenta sobre la misma fila.
//   - El evento se marca despachado (delivered_at) solo cuando ningún canal quedó
//     fallido. Si uno falla, el evento sigue pendiente y la siguiente corrida
//     reintenta solo ese canal.
//   - Un canal que llegó a MAX_ATTEMPTS deja de reintentarse y no bloquea el evento.
//
// Baseline: la 017 nunca crea eventos para la primera foto de tareas de un curso.
// Por defensa, un evento solo se envía si su curso ya tiene baseline y el evento
// es posterior a ella, y si la tarea sigue publicada. Si no, se marca despachado
// sin enviar (omitido) para que no se quede en la cola.
//
// Privacidad: los logs llevan solo ids y conteos, nunca título, materia ni correo.
const { entregar, textoTareaNueva, NEW_TASK_SUBJECT } = require("./notificationService");

const CLASSROOM_SOURCE = "classroom";
const REPO_METHODS = ["listPendingEvents", "getEventContext", "markDelivered", "claimNotification", "updateNotification"];

function assertRepo(repo) {
  const faltan = REPO_METHODS.filter((m) => typeof repo?.[m] !== "function");
  if (faltan.length > 0) throw new Error(`Repo incompleto, faltan: ${faltan.join(", ")}`);
}

// "Nueva tarea publicada: Tarea 3 en Cálculo. Fecha de entrega: ... (hora de
// Hermosillo)." o "... Sin fecha de entrega." Mismo texto que las tareas de iVirtual.
function buildClassroomTaskMessage(ctx) {
  return {
    subject: NEW_TASK_SUBJECT,
    text: textoTareaNueva({ itemLabel: ctx.title, subjectName: ctx.courseName, dueAt: ctx.dueAt ?? null }),
  };
}

// true si el evento es una tarea nueva real (posterior a la baseline del curso).
function esEnviable(event, ctx) {
  if (!ctx || ctx.userId !== event.user_id) return false;
  if (ctx.state !== "PUBLISHED") return false;
  if (!ctx.baselineAt) return false;
  const creado = Date.parse(event.created_at);
  const baseline = Date.parse(ctx.baselineAt);
  return Number.isFinite(creado) && Number.isFinite(baseline) && creado > baseline;
}

const TERMINALES = new Set(["sent", "duplicate", "max_attempts"]);

// Devuelve { procesados, enviados, fallidos, omitidos }:
//   procesados  eventos pendientes leídos en esta corrida
//   enviados    eventos que quedaron despachados (todos sus canales salieron)
//   fallidos    eventos que siguen pendientes por la falla de algún canal
//   omitidos    eventos marcados sin enviar (baseline, tarea no publicada, sin contexto)
// Lanza si falla la lectura de la cola o del contexto (la ruta lo atrapa); una
// falla de canal o de escritura de un evento no detiene a los demás.
async function dispatchClassroomTasks({ repo, channels, logger, now = () => Date.now(), limit } = {}) {
  assertRepo(repo);
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("dispatchClassroomTasks requiere al menos un canal");
  }
  const conteo = { procesados: 0, enviados: 0, fallidos: 0, omitidos: 0 };
  const events = await repo.listPendingEvents(limit);
  if (events.length === 0) return conteo;
  const contexto = await repo.getEventContext(events);
  const marcar = async (event) => {
    try {
      await repo.markDelivered(event.id, new Date(now()).toISOString());
      return true;
    } catch (error) {
      logger?.warn("despacho_classroom_marca_fallida", {
        classroom_task_event_id: event.id,
        error_code: error?.code ?? null,
      });
      return false;
    }
  };

  for (const event of events) {
    conteo.procesados += 1;
    const ctx = contexto.get(event.coursework_id);
    if (!esEnviable(event, ctx)) {
      if (await marcar(event)) conteo.omitidos += 1;
      else conteo.fallidos += 1;
      continue;
    }

    const message = buildClassroomTaskMessage(ctx);
    const payload = {
      ...message,
      source: CLASSROOM_SOURCE,
      classroom_task_event_id: event.id,
      course_name: ctx.courseName,
      task_title: ctx.title,
      due_at: ctx.dueAt ?? null,
    };
    const meta = { userId: event.user_id, classroomTaskEventId: event.id };
    let pendiente = false;

    for (const channel of channels) {
      let resultado;
      try {
        const row = await repo.claimNotification({
          event_id: event.id,
          user_id: event.user_id,
          channel: channel.name,
          payload,
        });
        // Un reintento reenvía exactamente el texto que se guardó la primera vez.
        const guardado = row.payload?.text ? row.payload : message;
        resultado = await entregar(row, channel, guardado, meta, repo);
      } catch (error) {
        resultado = { channel: channel.name, status: "failed", attempts: null };
      }
      if (!TERMINALES.has(resultado.status)) {
        pendiente = true;
        logger?.warn("notificacion_fallida", {
          classroom_task_event_id: event.id,
          channel: resultado.channel,
          attempts: resultado.attempts,
        });
      }
    }

    if (!pendiente && (await marcar(event))) conteo.enviados += 1;
    else conteo.fallidos += 1;
  }
  return conteo;
}

module.exports = {
  dispatchClassroomTasks,
  buildClassroomTaskMessage,
  esEnviable,
  CLASSROOM_SOURCE,
  REPO_METHODS,
};
