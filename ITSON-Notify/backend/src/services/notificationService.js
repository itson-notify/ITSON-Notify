// ITN-28 - Notificación de prueba al detectar un cambio de calificación.
// Recibe una fila de grade_changes (de `inserted` en detectChanges, ITN-24),
// la envía por cada canal disponible y registra cada envío en
// notifications_log. La persistencia va detrás de un repo inyectado
// (contrato en README.md), igual que gradeChangeService.

// Después de este número de intentos fallidos ya no se reintenta el canal.
const MAX_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 500;

const REPO_METHODS = ["claimNotification", "updateNotification"];

const FIELD_LABELS = {
  grade_value: "calificación",
  grade_text: "calificación (texto)",
  grade_label: "nombre de la actividad",
};

function assertRepo(repo) {
  const faltan = REPO_METHODS.filter((m) => typeof repo?.[m] !== "function");
  if (faltan.length > 0) {
    throw new Error(`Repo incompleto, faltan: ${faltan.join(", ")}`);
  }
}

const show = (value) => (value === null || value === undefined ? "sin valor" : value);

// Arma el mensaje. Solo usa la materia, la actividad y los valores: nunca
// email, nombre, matrícula, ids de usuario ni credenciales.
//   context.subjectName  nombre de la materia (opcional)
//   context.itemLabel    nombre de la actividad; null = total del curso
function buildMessage(gradeChange, context = {}) {
  const campo = FIELD_LABELS[gradeChange.field_name] ?? gradeChange.field_name;
  const actividad =
    context.itemLabel === null ? "Total del curso" : context.itemLabel || "Una actividad";
  const donde = context.subjectName ? ` en ${context.subjectName}` : "";

  let detalle;
  switch (gradeChange.change_type) {
    case "created":
      detalle = `tiene ${campo} nueva: ${show(gradeChange.current_value)}`;
      break;
    case "deleted":
      detalle = `ya no tiene ${campo} (antes: ${show(gradeChange.previous_value)})`;
      break;
    default:
      detalle = `cambió de ${show(gradeChange.previous_value)} a ${show(gradeChange.current_value)} (${campo})`;
  }

  return {
    subject: "ITSON Notify: cambio de calificación",
    text: `${actividad}${donde} ${detalle}.`,
  };
}

// Envía el aviso de un grade_change por cada canal.
//   gradeChange  fila de grade_changes con id y user_id
//   deps.repo     repo de notifications_log (ver README.md)
//   deps.channels canales de buildChannels()
//   deps.context  { subjectName, itemLabel } para el texto (opcional)
//
// Devuelve un resultado por canal:
//   { channel, status: 'sent' | 'duplicate' | 'failed' | 'max_attempts', attempts, error? }
//
// Idempotencia: claimNotification usa el unique (grade_change_id, channel) de
// la migración 002. Si el canal ya quedó 'sent', no se vuelve a enviar; si
// quedó 'pending' o 'failed', se reintenta sobre la misma fila.
// Un canal que falla no detiene a los demás ni lanza error.
async function notifyGradeChange(gradeChange, { repo, channels, context } = {}) {
  assertRepo(repo);
  if (!gradeChange?.id || !gradeChange?.user_id) {
    throw new Error("notifyGradeChange requiere un grade_change con id y user_id");
  }
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("notifyGradeChange requiere al menos un canal");
  }

  const message = buildMessage(gradeChange, context);
  const results = [];

  for (const channel of channels) {
    const row = await repo.claimNotification({
      user_id: gradeChange.user_id,
      grade_change_id: gradeChange.id,
      channel: channel.name,
      payload: message,
    });

    if (row.status === "sent") {
      results.push({ channel: channel.name, status: "duplicate", attempts: row.attempts });
      continue;
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      results.push({ channel: channel.name, status: "max_attempts", attempts: row.attempts });
      continue;
    }

    const attempts = row.attempts + 1;
    try {
      await channel.send(message, { gradeChangeId: gradeChange.id });
      await repo.updateNotification(row.id, {
        status: "sent",
        attempts,
        error: null,
        sent_at: new Date().toISOString(),
      });
      results.push({ channel: channel.name, status: "sent", attempts });
    } catch (err) {
      const error = String(err?.message ?? err).slice(0, MAX_ERROR_LENGTH);
      await repo.updateNotification(row.id, { status: "failed", attempts, error });
      results.push({ channel: channel.name, status: "failed", attempts, error });
    }
  }

  return results;
}

module.exports = { notifyGradeChange, buildMessage, REPO_METHODS, MAX_ATTEMPTS };
