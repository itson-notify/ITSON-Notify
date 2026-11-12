// ITN-36 - /internal/credentials, detrás de requireApiKey como grade-snapshots.
// ITN-51 - Mínimo privilegio: el worker solo lee (POST /get) y marca (POST
// /needs-relink). Guardar y borrar los hace el alumno en /api/credentials/ivirtual.
// El secreto solo sale en la respuesta 200 de POST /get. Los logs llevan user_id,
// portal, kind, key_version y códigos; nunca el body ni el correo.
const express = require("express");
const {
  parseCredentialRef,
  parseCredentialNeedsRelink,
} = require("../models/credentialPayload");
const { createCredentialRepository } = require("../repositories/credentialRepository");
const { createCredentialService } = require("../services/credentialService");
const {
  CredentialDecryptError,
  CredentialNotFoundError,
  CredentialNeedsRelinkError,
} = require("../utils/errors");

function credentialsRouter({ supabase, logger, now, credentialCrypto }) {
  const router = express.Router();
  const service = createCredentialService({
    repo: createCredentialRepository(supabase),
    crypto: credentialCrypto,
    now,
  });

  // Que ningún proxy ni cliente guarde estas respuestas.
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Valida el body, corre la operación y traduce sus errores. Si falla el descifrado
  // no se marca needs_relink: una llave mal configurada marcaría a todos los estudiantes.
  const ruta = (parse, evento, operacion) => async (req, res) => {
    const parsed = parse(req.body);
    if (!parsed.success) {
      logger.warn("credencial_body_rechazado", { issues: parsed.issues.length });
      return res.status(400).json({ error: "cuerpo_invalido", detalles: parsed.issues });
    }
    const { user, portal, kind, ...resto } = parsed.data;
    const entrada = { email: user.email, portal, kind, ...resto };
    try {
      return await operacion(entrada, res);
    } catch (error) {
      if (error instanceof CredentialNotFoundError) {
        logger.warn("credencial_no_encontrada", { portal, kind });
        return res.status(404).json({ error: "no_encontrado" });
      }
      if (error instanceof CredentialNeedsRelinkError) {
        logger.warn("credencial_requiere_revinculacion", { portal, kind });
        return res.status(409).json({ error: "requiere_revinculacion" });
      }
      if (error instanceof CredentialDecryptError) {
        logger.error("credencial_no_descifrable", { portal, kind });
        return res.status(500).json({ error: "error_interno" });
      }
      logger.error(evento, { portal, kind, step: error.step ?? null, error_code: error.code ?? null });
      return res.status(500).json({ error: "error_interno" });
    }
  };

  router.post(
    "/get",
    ruta(parseCredentialRef, "credencial_no_leida", async (entrada, res) => {
      const { userId, keyVersion, secret } = await service.readSecret(entrada);
      const { portal, kind } = entrada;
      logger.info("credencial_leida", { user_id: userId, portal, kind, key_version: keyVersion });
      return res.status(200).json({ portal, kind, secret });
    }),
  );

  router.post(
    "/needs-relink",
    ruta(parseCredentialNeedsRelink, "credencial_no_marcada", async (entrada, res) => {
      const { userId, portal, kind, status } = await service.markNeedsRelink(entrada);
      logger.warn("credencial_marcada_revinculacion", {
        user_id: userId,
        portal,
        kind,
        status,
        reason: entrada.reason ?? null,
      });
      return res.status(200).json({ portal, kind, status });
    }),
  );

  return router;
}

module.exports = { credentialsRouter };
