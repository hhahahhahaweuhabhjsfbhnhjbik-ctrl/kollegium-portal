#!/usr/bin/env node
/**
 * Снимает скриншоты интерфейса в настоящем Chromium через DevTools Protocol.
 *
 * Поднимает портал на свободном порту с демонстрационными данными, входит под
 * учётной записью ГКА и фотографирует ключевые экраны: вход, главную панель,
 * раздел наград и панель диагностики Discord. Результат — preview/*.png.
 *
 * Запуск: node tools/preview.mjs
 */
import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPortalServer } from "../server.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const chromePath = process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const outDir = path.join(root, "preview");

/* ─────────────────────────── Портал с демо-данными ─────────────────────── */
const server = createPortalServer({
  dbPath: ":memory:",
  requireDiscordLink: false,
  cookieSecure: false,
  webhookFetch: async () => new Response(null, { status: 204 }),
  webhookApplications: "https://discord.com/api/webhooks/123456789012345678/demo-token",
  webhookExams: "https://discord.com/api/webhooks/223456789012345678/demo-token",
  webhookLogs: "",
  discordClientId: "123456789012345678",
  discordClientSecret: "demo",
  discordRedirectUri: "https://portal.example.com/api/discord/callback",
  discordBotToken: "",
  discordGuildId: ""
});

const db = server.portalDb;
const salt = randomBytes(16);
const hash = "scrypt$" + salt.toString("base64") + "$" +
  scryptSync("CorrectHorseBattery9!", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64");
const insertUser = db.prepare(`INSERT INTO users (username, password_hash, display_name, email, role, status, member_since, discord_username, discord_avatar_url, discord_id, discord_linked_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
insertUser.run("volkov", hash, "Александр Волков", "volkov@example.com", "ГКА", "2025-01-15",
  "volkov", "https://cdn.discordapp.com/embed/avatars/0.png", "1572740171470995456");
insertUser.run("petrova", hash, "Елена Петрова", "petrova@example.com", "Адвокат", "2025-03-02",
  "petrova", "https://cdn.discordapp.com/embed/avatars/1.png", "1572740171470995457");

// Награды и достижения, чтобы витрина выглядела как в рабочем портале.
const awards = [
  ["special", "Мастер допроса", "50 успешных перекрёстных допросов"],
  ["certificate", "Правовой архитектор", "25 договоров без единого оспаривания"],
  ["thanks", "Законник", "Квалификационный экзамен сдан на отлично"]
];
for (const [kind, title, description] of awards) {
  db.prepare("INSERT INTO user_awards (user_id, granted_by, kind, title, description) VALUES (1, 1, ?, ?, ?)")
    .run(kind, title, description);
}
db.prepare("INSERT INTO user_achievements (user_id, achievement_id, awarded_by) VALUES (1, 1, 1)").run();
db.prepare("INSERT INTO user_achievements (user_id, achievement_id, awarded_by) VALUES (1, 4, 1)").run();

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

/* ─────────────────────────────── Вход ──────────────────────────────────── */
const loginResponse = await fetch(new URL("/api/auth/login", baseUrl), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "volkov", password: "CorrectHorseBattery9!" })
});
if (!loginResponse.ok) throw new Error(`Вход не удался: HTTP ${loginResponse.status}`);
const sessionCookie = loginResponse.headers.get("set-cookie").split(";")[0];
const [cookieName, cookieValue] = sessionCookie.split("=");

/* ─────────────────────── DevTools Protocol клиент ──────────────────────── */
const debugPort = 9500 + Math.floor(Math.random() * 400);
// Профиль Chrome держим во временном каталоге ОС, чтобы не засорять проект.
const userDataDir = path.join(os.tmpdir(), `ka-portal-preview-${randomBytes(4).toString("hex")}`);
await mkdir(userDataDir, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--force-color-profile=srgb",
  "--window-size=1440,1080",
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${debugPort}`,
  "about:blank"
], { stdio: "ignore", detached: true });

async function waitForDevTools() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch { /* Chrome ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Chrome не открыл порт отладки.");
}
await waitForDevTools();

const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })
  .then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let messageId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  messageId += 1;
  pending.set(messageId, { resolve, reject });
  socket.send(JSON.stringify({ id: messageId, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function navigate(url) {
  await send("Page.navigate", { url });
  await sleep(1800);
}

const measurements = [];
async function measure(label) {
  const { result } = await send("Runtime.evaluate", {
    expression: `(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), left: Math.round(rect.left) };
      };
      return JSON.stringify({
        innerWidth: window.innerWidth,
        dpr: window.devicePixelRatio,
        body: box("body"),
        main: box("main.shell"),
        page: box(".page.active"),
        card: box(".page.active .card"),
        analytics: box("#analytics-content"),
        analyticsCard: box(".analytics-card"),
        eliteGrid: box(".elite-grid"),
        sidebar: box("#sidebar")
      });
    })()`,
    returnByValue: true
  });
  measurements.push({ label, ...JSON.parse(result.value) });
}

async function shoot(name, { fullPage = false } = {}) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  await sleep(150);
}

/** Открывает раздел портала тем же способом, что и пользователь. */
async function openTab(tab) {
  await send("Runtime.evaluate", {
    expression: `document.querySelector('.nav-btn[data-tab="${tab}"]')?.click()`,
    awaitPromise: true
  });
  await sleep(1400);
}

await mkdir(outDir, { recursive: true });

try {
  /* 1. Экран входа */
  await navigate(`${baseUrl}/`);
  await shoot("01-login");

  /* 2. Главная панель под учётной записью ГКА */
  await send("Network.setCookie", {
    name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/", httpOnly: true
  });
  await navigate(`${baseUrl}/`);
  await sleep(900);
  await measure("home");
  await shoot("02-dashboard");

  /* 3. Достижения и элитные награды */
  await openTab("achievements");
  await measure("achievements");
  await shoot("03-elite-awards");

  /* 4. Панель диагностики Discord */
  await openTab("reports");
  await sleep(900);
  await measure("reports");
  await shoot("04-discord-webhooks");

  /* 5. Профиль сотрудника */
  await openTab("profile");
  await measure("profile");
  await shoot("05-profile");
} finally {
  socket.close();
  try { chrome.kill(); } catch { /* процесс уже завершён */ }
  server.webhookDispatcher?.stop();
  await new Promise((resolve) => server.close(resolve));
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

console.log(JSON.stringify({ ok: true, screenshots: outDir, measurements }, null, 2));
