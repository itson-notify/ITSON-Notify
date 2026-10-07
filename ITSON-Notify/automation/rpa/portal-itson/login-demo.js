const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", "..", ".env"),
  quiet: true,
});
const { launchBrowser, createContext, screenshot } = require("./browser");
const { login } = require("./login");

// Códigos de salida: 0 éxito, 1 credenciales incorrectas o error, 2 cambio de contraseña.
const EXIT_CODES = { ok: 0, credenciales: 1, indeterminado: 1, cambio_password: 2 };

const MENSAJES = {
  ok: "¡Login exitoso! La sesión quedó guardada en .auth/",
  credenciales: "Login fallido: credenciales incorrectas. Favor de verificarlas.",
  cambio_password:
    "El portal pide CAMBIO DE CONTRASEÑA. Se detiene el RPA; hay que actualizarla manualmente.",
  indeterminado:
    "Resultado no determinado: puede que se esté ocupando una verificación extra.",
};

async function main() {
  if (!process.env.Id_User || !process.env.P_User) {
    console.error("Faltan Id_User o P_User en ITSON-Notify/.env");
    process.exitCode = 1;
    return;
  }

  const browser = await launchBrowser();
  try {
    const context = await createContext(browser);
    const page = await context.newPage();

    console.log("Abriendo iVirtual...");
    const { status, reusada } = await login(page, {
      usuario: process.env.Id_User,
      password: process.env.P_User,
    });

    console.log(
      status === "ok" && reusada
        ? "¡Login exitoso! Se reutilizó la sesión guardada en .auth/"
        : MENSAJES[status],
    );
    console.log("Página:", new URL(page.url()).pathname);
    console.log("Screenshot:", await screenshot(page, "demo-login.png"));
    process.exitCode = EXIT_CODES[status];
  } catch (error) {
    console.error("Error durante la ejecución del RPA:", error.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
