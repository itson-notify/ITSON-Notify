// ITN-28 - Notificación al detectar cambios de calificación y tareas nuevas.
// Recibe filas de grade_changes (de `inserted` en detectChanges, ITN-24), las
// agrupa por ítem, envía un aviso por cada canal disponible y registra cada
// envío en notifications_log. La persistencia va detrás de un repo inyectado
// (contrato en README.md), igual que gradeChangeService.

// Después de este número de intentos fallidos ya no se reintenta el canal.
const MAX_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 500;

const REPO_METHODS = ["claimNotification", "updateNotification"];
const GROUPED_REPO_METHODS = [...REPO_METHODS, "getItemContext"];
const RETRY_REPO_METHODS = ["listPendingNotifications", "updateNotification"];

const SUBJECT = "ITSON Notify: cambio de calificación";
const NEW_TASK_SUBJECT = "ITSON Notify: nueva tarea";

const FIELD_LABELS = {
  grade_value: "calificación",
  grade_text: "calificación (texto)",
  grade_label: "nombre de la actividad",
};

function assertRepo(repo, methods = REPO_METHODS) {
  const faltan = methods.filter((m) => typeof repo?.[m] !== "function");
  if (faltan.length > 0) {
    throw new Error(`Repo incompleto, faltan: ${faltan.join(", ")}`);
  }
}

function assertChannels(channels, fn) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error(`${fn} requiere al menos un canal`);
  }
}

const show = (value) => (value === null || value === undefined ? "sin valor" : value);

const actividadDe = (context) =>
  context.itemLabel === null ? "Total del curso" : context.itemLabel || "Una actividad";

// Un ítem creado sin calificación numérica (solo grade_label o grade_value null)
// es una tarea recién publicada.
function esTareaNuevaRow(gradeChange) {
  if (gradeChange.change_type !== "created") return false;
  if (gradeChange.field_name === "grade_label") return true;
  return (
    gradeChange.field_name === "grade_value" &&
    (gradeChange.current_value === null || gradeChange.current_value === undefined)
  );
}

// Arma el mensaje. Solo usa la materia, la actividad y los valores: nunca
// email, nombre, matrícula, ids de usuario ni credenciales.
//   context.subjectName  nombre de la materia (opcional)
//   context.itemLabel    nombre de la actividad; null = total del curso
function buildMessage(gradeChange, context = {}) {
  const campo = FIELD_LABELS[gradeChange.field_name] ?? gradeChange.field_name;
  const donde = context.subjectName ? ` en ${context.subjectName}` : "";

  if (esTareaNuevaRow(gradeChange)) {
    const ctx =
      context.itemLabel === undefined && gradeChange.field_name === "grade_label" && gradeChange.current_value
        ? { ...context, itemLabel: gradeChange.current_value }
        : context;
    return { subject: NEW_TASK_SUBJECT, text: `Nueva tarea publicada: ${actividadDe(ctx)}${donde}.` };
  }

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

  return { subject: SUBJECT, text: `${actividadDe(context)}${donde} ${detalle}.` };
}

// Una parte del mensaje agrupado por cada campo que cambió.
function describirCampo(row, campo) {
  switch (row.change_type) {
    case "created":
      return `${campo} nueva: ${show(row.current_value)}`;
    case "deleted":
      return `ya no tiene ${campo} (antes: ${show(row.previous_value)})`;
    default:
      return `${campo} de ${show(row.previous_value)} a ${show(row.current_value)}`;
  }
}

// Mensaje de un grupo de filas del mismo ítem, p. ej.
// "Tarea 3 en Cálculo: calificación de 8 a 9."
// Si el ítem es nuevo ('created') y aún no tiene nota, se avisa como tarea nueva.
// grade_value y grade_text describen la misma nota: si cambiaron los dos, solo
// se muestra grade_value; si solo cambió grade_text, se muestra ese como
// "calificación". El cambio de grade_label solo se menciona si es un renombre
// ('updated'): en un ítem creado o borrado el nombre ya va al inicio.
// Mismas reglas de privacidad que buildMessage.
function buildGroupedMessage(rows, context = {}) {
  const porCampo = new Map(rows.map((r) => [r.field_name, r]));
  const partes = [];
  const nota = porCampo.get("grade_value") ?? porCampo.get("grade_text");
  const labelRow = porCampo.get("grade_label");

  const sinNota = !nota || nota.current_value === null || nota.current_value === undefined;
  if (rows.length > 0 && rows.every((r) => r.change_type === "created") && sinNota) {
    const ctx =
      context.itemLabel === undefined && labelRow?.current_value
        ? { ...context, itemLabel: labelRow.current_value }
        : context;
    const donde = ctx.subjectName ? ` en ${ctx.subjectName}` : "";
    return { subject: NEW_TASK_SUBJECT, text: `Nueva tarea publicada: ${actividadDe(ctx)}${donde}.` };
  }

  if (nota) partes.push(describirCampo(nota, "calificación"));
  if (labelRow?.change_type === "updated") {
    partes.push(describirCampo(labelRow, FIELD_LABELS.grade_label));
  }
  for (const row of rows) {
    if (!FIELD_LABELS[row.field_name]) partes.push(describirCampo(row, row.field_name));
  }

  const donde = context.subjectName ? ` en ${context.subjectName}` : "";
  return { subject: SUBJECT, text: `${actividadDe(context)}${donde}: ${partes.join("; ")}.` };
}

// Agrupa filas de grade_changes por (subject_id, external_item_id). Cada grupo
// se reclama en notifications_log con su id menor (claimId), así la misma
// llave sale siempre igual aunque cambie el orden de `inserted`.
function groupChanges(rows) {
  const grupos = new Map();
  for (const row of rows) {
    const key = `${row.subject_id}\u0000${row.external_item_id}`;
    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(row);
  }
  return [...grupos.values()].map((filas) => {
    const ids = filas.map((r) => r.id).sort();
    const [primera] = filas;
    const borrado = filas.every((r) => r.change_type === "deleted");
    return {
      claimId: ids[0],
      ids,
      rows: filas,
      userId: primera.user_id,
      subjectId: primera.subject_id,
      externalItemId: primera.external_item_id,
      // Donde vive el label: un ítem borrado ya no está en el snapshot actual.
      snapshotId: borrado ? primera.previous_snapshot_id : primera.current_snapshot_id,
    };
  });
}

const errorTexto = (err) => String(err?.message ?? err).slice(0, MAX_ERROR_LENGTH);

// Envía un mensaje por un canal sobre una fila ya reclamada de
// notifications_log y la actualiza. No lanza: un fallo queda 'failed'.
async function entregar(row, channel, message, meta, repo) {
  if (row.status === "sent") return { channel: channel.name, status: "duplicate", attempts: row.attempts };
  if (row.attempts >= MAX_ATTEMPTS) {
    return { channel: channel.name, status: "max_attempts", attempts: row.attempts };
  }

  const attempts = row.attempts + 1;
  try {
    await channel.send({ subject: message.subject, text: message.text }, meta);
    await repo.updateNotification(row.id, {
      status: "sent",
      attempts,
      error: null,
      sent_at: new Date().toISOString(),
    });
    return { channel: channel.name, status: "sent", attempts };
  } catch (err) {
    const error = errorTexto(err);
    try {
      await repo.updateNotification(row.id, { status: "failed", attempts, error });
    } catch {
      // La fila sigue 'pending' y se reintenta en la siguiente corrida.
    }
    return { channel: channel.name, status: "failed", attempts, error };
  }
}

// Envía el aviso de un grade_change por cada canal.
//   gradeChange  fila de grade_changes con id y user_id
//   deps.repo    repo de notifications_log (ver README.md)
//   deps.channels canales de buildChannels()
//   deps.context { subjectName, itemLabel } para el texto (opcional)
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
  assertChannels(channels, "notifyGradeChange");

  const message = buildMessage(gradeChange, context);
  const results = [];
  const meta = { userId: gradeChange.user_id, gradeChangeId: gradeChange.id };

  for (const channel of channels) {
    const row = await repo.claimNotification({
      user_id: gradeChange.user_id,
      grade_change_id: gradeChange.id,
      channel: channel.name,
      payload: message,
    });
    results.push(await entregar(row, channel, message, meta, repo));
  }

  return results;
}

const contar = (resultados) => ({
  notified: resultados.filter((r) => r.status === "sent").length,
  failed: resultados.filter((r) => r.status === "failed").length,
});

// Notifica las filas de `inserted`: un aviso por ítem y canal.
//   inserted       filas de grade_changes con id y user_id
//   deps.repo      claimNotification, updateNotification, getItemContext
//   deps.channels  canales de buildChannels()
//
// Cada grupo se reclama con grade_change_id = claimId y el payload guarda el
// mensaje armado más grade_change_ids (todos los ids del grupo), para que un
// reintento reenvíe exactamente lo mismo. No lanza por fallas de canal ni de
// Supabase: si falla el contexto se usan los textos de respaldo; si falla el
// reclamo de un grupo, cuenta como fallido y se sigue con el resto.
//
// Devuelve { notified, failed, results: [{ grade_change_id, grade_change_ids, channel, status, attempts }] }.
async function notifyGroupedChanges(inserted, { repo, channels } = {}) {
  assertRepo(repo, GROUPED_REPO_METHODS);
  assertChannels(channels, "notifyGroupedChanges");
  if (inserted.some((r) => !r?.id || !r?.user_id)) {
    throw new Error("notifyGroupedChanges requiere filas de grade_changes con id y user_id");
  }

  const grupos = groupChanges(inserted);
  let contexto = new Map();
  try {
    contexto = await repo.getItemContext(grupos);
  } catch {
    // Sin materia ni label: buildGroupedMessage usa sus textos de respaldo.
  }

  const results = [];
  for (const grupo of grupos) {
    const ctx = contexto.get(`${grupo.subjectId}\u0000${grupo.externalItemId}`) ?? {};
    const message = buildGroupedMessage(grupo.rows, ctx);
    const meta = { userId: grupo.userId, gradeChangeId: grupo.claimId, gradeChangeIds: grupo.ids };

    for (const channel of channels) {
      let resultado;
      try {
        const row = await repo.claimNotification({
          user_id: grupo.userId,
          grade_change_id: grupo.claimId,
          channel: channel.name,
          payload: { ...message, grade_change_ids: grupo.ids },
        });
        resultado = await entregar(row, channel, message, meta, repo);
      } catch (err) {
        resultado = { channel: channel.name, status: "failed", attempts: null, error: errorTexto(err) };
      }
      results.push({ grade_change_id: grupo.claimId, grade_change_ids: grupo.ids, ...resultado });
    }
  }

  return { ...contar(results), results };
}

// Reintenta las notificaciones 'pending' o 'failed' de un usuario con
// attempts < MAX_ATTEMPTS, reenviando el payload guardado. Si el canal de una
// fila ya no está disponible (p. ej. sin RESEND_API_KEY), la fila se deja
// igual. No lanza por fallas de canal; una falla al leer los pendientes sí
// lanza (la ruta la atrapa).
//
// Devuelve { retried, notified, failed, results }.
async function retryPendingNotifications(userId, { repo, channels } = {}) {
  assertRepo(repo, RETRY_REPO_METHODS);
  assertChannels(channels, "retryPendingNotifications");
  if (!userId) throw new Error("retryPendingNotifications requiere userId");

  const pendientes = await repo.listPendingNotifications(userId, MAX_ATTEMPTS);
  const porNombre = new Map(channels.map((c) => [c.name, c]));
  const results = [];

  for (const row of pendientes) {
    const channel = porNombre.get(row.channel);
    if (!channel || !row.payload?.text) continue;
    const meta = {
      userId: row.user_id ?? userId,
      gradeChangeId: row.grade_change_id,
      gradeChangeIds: row.payload.grade_change_ids ?? [row.grade_change_id],
    };
    const resultado = await entregar(row, channel, row.payload, meta, repo);
    results.push({ grade_change_id: row.grade_change_id, ...resultado });
  }

  return { retried: results.length, ...contar(results), results };
}

module.exports = {
  notifyGradeChange,
  notifyGroupedChanges,
  retryPendingNotifications,
  buildMessage,
  buildGroupedMessage,
  groupChanges,
  REPO_METHODS,
  GROUPED_REPO_METHODS,
  RETRY_REPO_METHODS,
  MAX_ATTEMPTS,
  SUBJECT,
  NEW_TASK_SUBJECT,
};