const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const AUTOMATION_DIR = path.join(__dirname, "..", "..");
const SESSION_FILE = path.join(AUTOMATION_DIR, ".auth", "itson-state.json");
const ARTIFACTS_DIR = path.join(AUTOMATION_DIR, ".artifacts");

function launchBrowser() {
  return chromium.launch({
    headless: process.env.HEADLESS !== "false", // En local false para ver navegador
    slowMo: 50,
  });
}

// Crea un contexto con la sesión guardada en .auth/ si existe y es legible.
async function createContext(browser) {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const storageState = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      return await browser.newContext({ storageState });
    } catch {
      // Archivo corrupto: se ignora y se hace login desde cero.
    }
  }
  return browser.newContext();
}

async function saveSession(context) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
}

async function screenshot(page, name) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const file = path.join(ARTIFACTS_DIR, name);
  await page.screenshot({ path: file });
  return file;
}

module.exports = { launchBrowser, createContext, saveSession, screenshot };
