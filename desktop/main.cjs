const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const appId = "com.mirror.ka-portal";
const dataDirectory = () => app.getPath("userData");
const configPath = () => path.join(dataDirectory(), "desktop-config.json");
const databasePath = () => path.join(dataDirectory(), "portal.sqlite");
let portalModule;
let portalInstance;
let setupWindow;
let mainWindow;
let forumWindow;
let shuttingDown = false;
let activeConfig;
const supremeCourtForumUrl = "https://forum.gta5rp.com/forums/verkhnyi-sud.2188/";

app.setAppUserModelId(appId);

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseSecureUrl(value, label, { optional = false } = {}) {
  const text = String(value || "").trim();
  if (!text && optional) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}: укажите полный адрес, например https://portal.example.com.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label}: разрешены только HTTP- и HTTPS-адреса.`);
  }
  if (url.protocol !== "https:" && !isLocalHost(url.hostname)) {
    throw new Error(`${label}: для адресов вне этого ПК требуется HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label}: логин и пароль нельзя встраивать в адрес.`);
  }
  return url.toString().replace(/\/+$/, "");
}

async function loadEnvironment() {
  const candidates = [
    path.join(dataDirectory(), ".env"),
    path.join(app.getAppPath(), ".env")
  ];
  for (const envPath of candidates) {
    try {
      await fs.access(envPath);
      if (typeof process.loadEnvFile !== "function") {
        throw new Error("Для загрузки .env этому приложению требуется Node.js 20.12 или новее.");
      }
      process.loadEnvFile(envPath);
      return envPath;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return "";
}

async function getPortalModule() {
  if (!portalModule) {
    const modulePath = path.join(app.getAppPath(), "server.mjs");
    portalModule = import(pathToFileURL(modulePath).href);
  }
  return portalModule;
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Не удалось прочитать настройки приложения: ${error.message}`);
  }
}

async function writeConfig(config) {
  await fs.mkdir(dataDirectory(), { recursive: true });
  const temporaryPath = `${configPath()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  await fs.rename(temporaryPath, configPath());
}

function makeWindow({ width = 1280, height = 850, title = "Коллегия адвокатов" } = {}) {
  return new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    title,
    backgroundColor: "#0d1016",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });
}

async function showSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = makeWindow({ width: 760, height: 760, title: "Настройка портала" });
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
  await setupWindow.loadFile(path.join(__dirname, "setup.html"));
}

async function showPortal(config) {
  activeConfig = config;
  const isHost = config.mode === "host";
  let targetUrl;
  if (isHost) {
    const { startPortal } = await getPortalModule();
    const externalOrigin = config.publicUrl
      ? new URL(config.publicUrl).origin
      : process.env.DISCORD_REDIRECT_URI
        ? new URL(process.env.DISCORD_REDIRECT_URI).origin
        : "";
    const discordRedirectUri = config.publicUrl
      ? new URL("/api/discord/callback", externalOrigin).toString()
      : undefined;
    let existingPortal = false;
    try {
      const existingResponse = await fetch("http://127.0.0.1:3000/api/health", {
        signal: AbortSignal.timeout(3000)
      });
      existingPortal = existingResponse.ok &&
        (await existingResponse.json())?.ok === true;
    } catch {
      existingPortal = false;
    }
    if (existingPortal) {
      portalInstance = null;
    } else {
    try {
      portalInstance = await startPortal({
        host: "127.0.0.1",
        port: 3000,
        dbPath: databasePath(),
        publicUrl: config.publicUrl || "",
        discordRedirectUri
      });
    } catch (error) {
      existingPortal = false;
      try {
        const response = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(3000) });
        if (response.ok) {
          const health = await response.json();
          existingPortal = health?.ok === true;
        }
      } catch {
        existingPortal = false;
      }
      if (!existingPortal || !String(error.message).includes("Порт 3000")) throw error;
    }
    }
    targetUrl = externalOrigin || `http://127.0.0.1:${portalInstance?.port || 3000}`;
    targetUrl = `${targetUrl}/`;
  } else {
    targetUrl = config.serverUrl;
  }

  mainWindow = makeWindow();
  const targetOrigin = new URL(targetUrl).origin;
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    let url;
    try {
      url = new URL(navigationUrl);
    } catch {
      event.preventDefault();
      return;
    }
    const isDiscordAuthorization = url.origin === "https://discord.com" && url.pathname === "/oauth2/authorize";
    if (url.origin !== targetOrigin && !isDiscordAuthorization) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      return { action: "deny" };
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      void dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Не удалось открыть портал",
        message: "Проверьте адрес сервера и подключение к интернету.",
        detail: `${description}\n${failedUrl}`
      });
    }
  });
  await mainWindow.loadURL(targetUrl);
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
}

async function showForumWindow() {
  if (forumWindow && !forumWindow.isDestroyed()) {
    forumWindow.focus();
    return;
  }
  forumWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Верховный суд — форум GTA5RP",
    autoHideMenuBar: true,
    webPreferences: {
      partition: "persist:gta5rp-forum",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  forumWindow.on("closed", () => {
    forumWindow = null;
  });
  forumWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    let url;
    try {
      url = new URL(navigationUrl);
    } catch {
      event.preventDefault();
      return;
    }
    if (url.protocol !== "https:") event.preventDefault();
  });
  forumWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" &&
          ["forum.gta5rp.com", "gta5rp.com", "www.gta5rp.com"].includes(parsed.hostname)) {
        void forumWindow.loadURL(parsed.toString());
      } else if (parsed.protocol === "https:") {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      return { action: "deny" };
    }
    return { action: "deny" };
  });
  await forumWindow.loadURL(supremeCourtForumUrl);
}

async function reconfigure() {
  await showSetupWindow();
  if (portalInstance) {
    await portalInstance.close();
    portalInstance = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
    mainWindow = null;
  }
}

function configureMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: "Портал",
    submenu: [
      {
        label: "Скопировать адрес для сотрудников",
        click: async () => {
          const url = activeConfig?.mode === "client" ? activeConfig.serverUrl : activeConfig?.publicUrl;
          if (!url) {
            await dialog.showMessageBox({
              type: "info",
              title: "Адрес не настроен",
              message: "Добавьте внешний HTTPS-адрес в настройках сервера ГКА."
            });
            return;
          }
          clipboard.writeText(url);
          await dialog.showMessageBox({
            type: "info",
            title: "Адрес скопирован",
            message: "HTTPS-адрес портала скопирован в буфер обмена."
          });
        }
      },
      {
        label: "Изменить подключение",
        click: () => {
          void reconfigure().catch((error) => dialog.showMessageBox({
            type: "error",
            title: "Не удалось изменить подключение",
            message: error.message
          }));
        }
      },
      { type: "separator" },
      { role: "quit", label: "Выход" }
    ]
  }]));
}

ipcMain.handle("setup:get-state", async () => {
  const module = await getPortalModule();
  return {
    config: await readConfig(),
    adminExists: module.initialAdminExists(databasePath()),
    dataDirectory: dataDirectory(),
    envPath: path.join(dataDirectory(), ".env")
  };
});

ipcMain.handle("setup:save", async (_event, rawSettings) => {
  if (!rawSettings || !["host", "client"].includes(rawSettings.mode)) {
    throw new Error("Выберите режим запуска.");
  }
  const settings = { mode: rawSettings.mode };
  if (settings.mode === "client") {
    settings.serverUrl = parseSecureUrl(rawSettings.serverUrl, "Адрес сервера");
  } else {
    settings.publicUrl = parseSecureUrl(rawSettings.publicUrl, "Внешний HTTPS-адрес", { optional: true });
    const module = await getPortalModule();
    const adminExists = module.initialAdminExists(databasePath());
    if (!adminExists) {
      await module.createInitialAdminAccount(databasePath(), {
        username: rawSettings.username,
        displayName: rawSettings.displayName,
        password: rawSettings.password
      });
    }
  }
  await writeConfig(settings);
  await showPortal(settings);
  return { ok: true };
});

ipcMain.handle("portal:open-forum", async () => {
  await showForumWindow();
  return { ok: true };
});

app.whenReady().then(async () => {
  try {
    await loadEnvironment();
    configureMenu();
    const config = await readConfig();
    if (config?.mode === "host" || config?.mode === "client") {
      if (config.mode === "client") config.serverUrl = parseSecureUrl(config.serverUrl, "Адрес сервера");
      await showPortal(config);
      return;
    }
    await showSetupWindow();
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Ошибка запуска",
      message: "Приложение не удалось запустить.",
      detail: error.message
    });
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!portalInstance || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void portalInstance.close().then(() => {
    portalInstance = null;
    app.exit(0);
  }).catch(async (error) => {
    await dialog.showMessageBox({
      type: "error",
      title: "Ошибка остановки",
      message: "Не удалось корректно остановить сервер.",
      detail: error.message
    });
    app.exit(1);
  });
});
