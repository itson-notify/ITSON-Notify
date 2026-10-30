// ITN-27 - POST /internal/grade-snapshots
// Recibe una extracción del worker (ITN-25), la guarda, corre el detector de
// cambios (ITN-24) y notifica los cambios nuevos (ITN-28). Responde solo ids y
// conteos.
const express = require("express");
const { parseGradeSnapshotPayload } = require("../models/gradeSnapshotPayload");
const { saveSnapshot } = require("../repositories/snapshotRepository");
const { createGradeChangeRepository } = require("../repositories/gradeChangeRepository");
const { createNotificationRepository } = require("../repositories/notificationRepository");
const { detectChanges } = require("../services/gradeChangeService");
const { notifyGroupedChanges, retryPendingNotifications } = require("../services/notificationService");
const { SnapshotOwnershipError } = require("../utils/errors");

// Notificaciones de una corrida. Nunca lanza: el snapshot y los cambios ya
// quedaron guardados, y lo que falle queda 'pending' o 'failed' en
// notifications_log para la siguiente corrida.
//   1. Reintenta pendientes del usuario (también en baseline).
//   2. Si no es baseline, notifica `inserted` agrupado por ítem.
// Los logs solo llevan ids de grade_changes y conteos.
async function notificar({ userId, result, repo, channels, logger }) {
  const conteo = { retried: 0, notified: 0, failed: 0 };
  const sumar = (r) => {
    conteo.notified += r.notified;
    conteo.failed += r.failed;
    for (const f of r.results.filter((x) => x.status === "failed")) {
      logger.warn("notificacion_fallida", {
        grade_change_id: f.grade_change_id,
        channel: f.channel,
        attempts: f.attempts,
      });
    }
  };

  try {
    const r = await retryPendingNotifications(userId, { repo, channels });
    conteo.retried = r.retried;
    sumar(r);
  } catch (error) {
    logger.error("reintento_notificaciones_fallido", { step: error.step ?? null, error_code: error.code ?? null });
  }

  if (!result.baseline && result.inserted.length > 0) {
    try {
      sumar(await notifyGroupedChanges(result.inserted, { repo, channels }));
    } catch (error) {
      conteo.failed += 1;
      logger.error("notificacion_no_procesada", { step: error.step ?? null, error_code: error.code ?? null });
    }
  }
  return conteo;
}

function gradeSnapshotsRouter({ supabase, logger, now, channels }) {
  const router = express.Router();
  const repo = createGradeChangeRepository(supabase);
  const notificationRepo = createNotificationRepository(supabase);

  router.post("/", async (req, res) => {
    const parsed = parseGradeSnapshotPayload(req.body, { now: now() });
    if (!parsed.success) {
      logger.warn("payload_rechazado", { issues: parsed.issues.length });
      return res.status(400).json({ error: "cuerpo_invalido", detalles: parsed.issues });
    }
    const payload = parsed.data;

    let saved;
    try {
      saved = await saveSnapshot(supabase, payload);
    } catch (error) {
      if (error instanceof SnapshotOwnershipError) {
        logger.warn("snapshot_de_otro_usuario", { snapshot_id: payload.run_id });
        return res.status(409).json({ error: "snapshot_de_otro_usuario" });
      }
      logger.error("snapshot_no_guardado", {
        snapshot_id: payload.run_id,
        step: error.step ?? null,
        error_code: error.code ?? null,
        compensation: error.compensation ?? null,
      });
      return res.status(500).json({ error: "error_interno" });
    }

    let result;
    try {
      result = await detectChanges({ userId: saved.userId, currentSnapshotId: saved.snapshotId }, repo);
    } catch (error) {
      // El snapshot ya quedó guardado: reenviar el mismo run_id reintenta la
      // detección sin duplicar nada.
      logger.error("deteccion_fallida", {
        snapshot_id: saved.snapshotId,
        step: error.step ?? null,
        error_code: error.code ?? null,
      });
      return res.status(500).json({ error: "error_interno" });
    }

    const notificaciones = await notificar({
      userId: saved.userId,
      result,
      repo: notificationRepo,
      channels,
      logger,
    });

    const respuesta = {
      snapshot_id: saved.snapshotId,
      snapshot_created: saved.created,
      courses: saved.courses,
      items: saved.items,
      baseline: result.baseline,
      reason: result.reason,
      changes_detected: result.changes.length,
      changes_inserted: result.inserted.length,
      notified: notificaciones.notified,
      failed: notificaciones.failed,
    };
    logger.info("snapshot_guardado", { ...respuesta, retried: notificaciones.retried, user_id: saved.userId });
    return res.status(200).json(respuesta);
  });

  return router;
}

module.exports = { gradeSnapshotsRouter };
