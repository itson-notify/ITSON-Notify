// ITN-36 - Contrato de los bodies de /internal/credentials. Documentado en
// backend/README.md.
const { z } = require("zod");

// ivirtual_password existe en el esquema de la 007 como último recurso, pero la API
// todavía no lo admite. Por eso no aparece aquí.
const KINDS_POR_PORTAL = {
  ivirtual: ["ivirtual_token"],
  google_classroom: ["google_refresh_token"],
};
const PORTALES = Object.keys(KINDS_POR_PORTAL);
const KINDS = Object.values(KINDS_POR_PORTAL).flat();

// Sobra para un token de Moodle o un refresh token de Google.
const MAX_SECRET_LENGTH = 4096;

// Los resultados de automation/rpa/ivirtual-api/index.js que invalidan la credencial.
const MOTIVOS_RELINK = ["credenciales", "cambio_password"];

const referencia = {
  user: z.object({
    email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
  }),
  portal: z.enum(PORTALES),
  kind: z.enum(KINDS),
};

// El secreto se guarda tal cual: no se recorta ni se cambia a minúsculas.
const secret = z
  .string()
  .min(1)
  .max(MAX_SECRET_LENGTH)
  .refine((v) => v.trim() !== "", { message: "vacío" });

function conKindDelPortal(schema) {
  return schema.superRefine((body, ctx) => {
    if (!KINDS_POR_PORTAL[body.portal].includes(body.kind)) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "no corresponde al portal" });
    }
  });
}

const refSchema = conKindDelPortal(z.object(referencia));
const saveSchema = conKindDelPortal(z.object({ ...referencia, secret }));
const needsRelinkSchema = conKindDelPortal(
  z.object({ ...referencia, reason: z.enum(MOTIVOS_RELINK).optional() }),
);

// Devuelve { success: true, data } o { success: false, issues }. issues solo trae
// ruta y código: nunca el valor recibido, que puede ser el secreto.
function parser(schema) {
  return (body) => {
    const result = schema.safeParse(body);
    if (result.success) return { success: true, data: result.data };
    return {
      success: false,
      issues: result.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    };
  };
}

module.exports = {
  parseCredentialSave: parser(saveSchema),
  parseCredentialRef: parser(refSchema),
  parseCredentialNeedsRelink: parser(needsRelinkSchema),
  MAX_SECRET_LENGTH,
};
