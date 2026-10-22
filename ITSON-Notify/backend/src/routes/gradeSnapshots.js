// ITN-27 - POST /internal/grade-snapshots
// Recibe una extracción del worker (ITN-25), la guarda y corre el detector de
// cambios (ITN-24). Responde solo ids y conteos. No notifica: ese acople es
// de ITN-28.
const express = require("express");
const { parseGradeSnapshotPayload } = require("../models/gradeSnapshotPayload");
const { saveSnapshot } = require("../repositories/snapshotRepository");
const { createGradeChangeRepository } = require("../repositories/gradeChangeRepository");
const { detectChanges } = require("../services/gradeChangeService");
const { SnapshotOwnershipError } = require("../utils/errors");

function gradeSnapshotsRouter({ supabase, logger, now }) {
  const router = express.Router();
  const repo = createGradeChangeRepository(supabase);

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

    const respuesta = {
      snapshot_id: saved.snapshotId,
      snapshot_created: saved.created,
      courses: saved.courses,
      items: saved.items,
      baseline: result.baseline,
      reason: result.reason,
      changes_detected: result.changes.length,
      changes_inserted: result.inserted.length,
    };
    logger.info("snapshot_guardado", { ...respuesta, user_id: saved.userId });
    return res.status(200).json(respuesta);
  });

  return router;
}

module.exports = { gradeSnapshotsRouter };
