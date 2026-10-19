const path = require("path");
const fs = require("fs");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", "..", ".env"),
  quiet: true,
});
const { extractGrades } = require("./index");

// Uso: npm run extract:grades [-- --out archivo.json]
// Sin --out imprime el JSON en stdout; los mensajes van a stderr.
// Códigos de salida (igual que login-demo.js): 0 éxito, 1 credenciales o error.
const EXIT_CODES = { ok: 0, credenciales: 1, error: 1 };

const MENSAJES = {
  credenciales: "Extracción fallida: credenciales incorrectas. Favor de verificarlas.",
  error: "Extracción fallida:",
};

function parseOut(argv) {
  const i = argv.indexOf("--out");
  if (i === -1) return null;
  const file = argv[i + 1];
  if (!file || file.startsWith("--")) {
    throw new Error("--out requiere un nombre de archivo");
  }
  return path.resolve(file);
}

async function main() {
  let outFile;
  try {
    outFile = parseOut(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (!process.env.Id_User || !process.env.P_User) {
    console.error("Faltan Id_User o P_User en ITSON-Notify/.env");
    process.exitCode = 1;
    return;
  }

  console.error("Consultando iVirtual (API de Moodle)...");
  const result = await extractGrades({
    usuario: process.env.Id_User,
    password: process.env.P_User,
  });

  if (result.status !== "ok") {
    console.error(
      result.status === "error"
        ? `${MENSAJES.error} ${result.error}`
        : MENSAJES[result.status],
    );
    process.exitCode = EXIT_CODES[result.status];
    return;
  }

  const items = result.courses.reduce((n, c) => n + c.items.length, 0);
  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${json}\n`);
    console.error(`Guardado en ${outFile}`);
  } else {
    console.log(json);
  }
  console.error(`¡Listo! ${result.courses.length} curso(s), ${items} ítem(s).`);
  process.exitCode = EXIT_CODES.ok;
}

main().catch((error) => {
  console.error("Error durante la extracción:", error.message);
  process.exitCode = 1;
});
