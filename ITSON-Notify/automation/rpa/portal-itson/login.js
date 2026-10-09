const { saveSession } = require("./browser");

const BASE_URL = "https://ivirtual.itson.edu.mx";
const LOGIN_URL = `${BASE_URL}/login/index.php`;
const HOME_URL = `${BASE_URL}/my/`;

const SEL_SESION_OK = ".usermenu, #user-menu-toggle";
const SEL_ERROR = "#loginerrormessage, .loginerrors";
const SEL_CAMBIO_PASS = 'input[name="newpassword1"]';
const SEL_FORM_LOGIN = "#username";
const TIMEOUT = 15000;

// Resultados posibles de login():
//   ok               sesión iniciada (o reutilizada desde .auth/)
//   credenciales     el portal rechazó usuario/contraseña
//   cambio_password  el portal exige cambiar la contraseña manualmente
//   indeterminado    no se reconoció la página (p. ej. verificación extra)

async function sesionValida(page) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page
    .locator(`${SEL_SESION_OK}, ${SEL_FORM_LOGIN}`)
    .first()
    .waitFor({ timeout: TIMEOUT })
    .catch(() => {});
  return (
    !page.url().includes("/login/") &&
    (await page.locator(SEL_SESION_OK).count()) > 0
  );
}

async function login(page, { usuario, password }) {
  if (await sesionValida(page)) {
    return { status: "ok", reusada: true };
  }

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator(SEL_FORM_LOGIN).waitFor({ timeout: TIMEOUT });
  await page.fill("#username", usuario);
  await page.fill("#password", password);
  await page.click('#login [type="submit"]');
  await page
    .locator(`${SEL_SESION_OK}, ${SEL_ERROR}, ${SEL_CAMBIO_PASS}`)
    .first()
    .waitFor({ timeout: TIMEOUT })
    .catch(() => {});

  const url = page.url();
  if (
    url.includes("change_password") ||
    (await page.locator(SEL_CAMBIO_PASS).count()) > 0
  ) {
    return { status: "cambio_password" };
  }
  if ((await page.locator(SEL_ERROR).count()) > 0) {
    return { status: "credenciales" };
  }
  if (
    (await page.locator(SEL_SESION_OK).count()) > 0 &&
    !url.includes("/login/")
  ) {
    await saveSession(page.context());
    return { status: "ok", reusada: false };
  }
  return { status: "indeterminado" };
}

module.exports = { login, BASE_URL };
