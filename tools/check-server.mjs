#!/usr/bin/env node
/**
 * Сквозная проверка сервера: поднимает портал на свободном порту и проверяет,
 * что отдаются все файлы интерфейса, что статика защищена от выхода за каталог,
 * что работают новые endpoint'ы диагностики и что проверка webhook действительно
 * доставляет одно сообщение в Discord.
 *
 * Запуск: node tools/check-server.mjs
 */
import { randomBytes, scryptSync } from "node:crypto";
import { createPortalServer } from "../server.mjs";

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

const webhookCalls = [];
const server = createPortalServer({
  dbPath: ":memory:",
  cookieSecure: false,
  webhookApplications: "https://discord.com/api/webhooks/123456789012345678/test-token",
  webhookExams: "https://discord.com/api/webhooks/223456789012345678/test-token",
  webhookLogs: "",
  webhookFetch: async (url, options) => {
    webhookCalls.push({ url: String(url), options });
    return new Response(null, { status: 204 });
  },
  discordClientId: "123456789012345678",
  discordClientSecret: "secret",
  discordRedirectUri: "https://portal.example.com/api/discord/callback",
  discordBotToken: "",
  discordGuildId: ""
});

const db = server.portalDb;
const salt = randomBytes(16);
const passwordHash = "scrypt$" + salt.toString("base64") + "$" +
  scryptSync("CorrectHorseBattery9!", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64");
db.prepare(`INSERT INTO users (username, password_hash, display_name, email, role, status)
  VALUES (?, ?, ?, ?, 'ГКА', 'active')`).run("gka", passwordHash, "Тестовый ГКА", "gka@example.com");

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let cookie = "";
let csrf = "";
const request = async (pathname, { method = "GET", body, raw = false } = {}) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf && method !== "GET") headers["x-csrf-token"] = csrf;
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const payload = raw
    ? Buffer.from(await response.arrayBuffer())
    : await response.json().catch(() => ({}));
  if (payload?.csrfToken) csrf = payload.csrfToken;
  return { status: response.status, headers: response.headers, payload };
};

try {
  /* ── Вход ─────────────────────────────────────────────────────────────── */
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { username: "gka", password: "CorrectHorseBattery9!" }
  });
  check(login.status === 200, `Вход не удался: HTTP ${login.status} ${JSON.stringify(login.payload)}`);

  /* ── HTML ─────────────────────────────────────────────────────────────── */
  const page = await request("/", { raw: true });
  const html = page.payload.toString("utf8");
  check(page.status === 200, `Главная страница: HTTP ${page.status}`);
  check(String(page.headers.get("content-type")).includes("text/html"), "Главная страница должна отдаваться как text/html.");
  check(!/<style[\s>]/i.test(html), "В HTML не должно быть инлайновых <style>.");
  check(!/<script>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), "В HTML не должно быть инлайнового кода.");
  check(html.includes('/api/frontend/loader'), "HTML должен подключать загрузчик приложения.");
  check(html.includes('/web/css/loading.css'), "HTML должен сразу подключать компактные стили экрана загрузки.");
  check(html.includes('id="network-notice"') &&
    html.includes('У некоторых пользователей соединение с хостингом нестабильно'),
  "Страница должна предупреждать о возможных проблемах соединения.");
  check(html.includes('<form method="dialog">'), "Предупреждение должно закрываться без JavaScript.");
  check(!html.includes('/web/css/base.css') && !html.includes('/web/css/theme.css'),
    "Основные CSS не должны загружаться крупными прямыми запросами.");
  const loader = await request("/api/frontend/loader", { raw: true });
  const loaderSource = loader.payload.toString("utf8");
  check(loader.status === 200, `Загрузчик оформления: HTTP ${loader.status}`);
  for (const fileName of ["base.css", "theme.css", "awards.css"]) {
    check(loaderSource.includes(fileName), `Загрузчик должен получать ${fileName} частями.`);
  }
  check(html.includes('/web/icons-sprite.svg#icon-01_overview'), "Главная навигация должна использовать спрайт иконок.");
  for (const route of ["/page/home", "/page/iski", "/page/audit", "/page/decrees", "/page/reports"]) {
    const routePage = await request(route, { raw: true });
    check(routePage.status === 200, `Страница ${route}: HTTP ${routePage.status}`);
    check(routePage.payload.toString("utf8").includes('/api/frontend/loader'), `Страница ${route} должна отдавать приложение.`);
  }

  const csp = String(page.headers.get("content-security-policy") || "");
  check(csp.includes("script-src 'self' blob:"), "CSP должен разрешать blob-модуль загрузчика.");
  check(!/script-src[^;]*'unsafe-inline'/.test(csp), "CSP не должен разрешать инлайновые скрипты.");
  const decreeQueue = await request("/api/promotion-decree");
  check(decreeQueue.status === 200 && decreeQueue.payload.nextNumber === 0,
    "У ГКА должна открываться очередь указов с нумерацией от №000.");

  /* ── Статика ──────────────────────────────────────────────────────────── */
  const assets = [
    ["/web/icons-sprite.svg", "image/svg+xml"],
    ["/web/css/loading.css", "text/css"],
    ["/web/css/base.css", "text/css"],
    ["/web/css/theme.css", "text/css"],
    ["/web/css/awards.css", "text/css"],
    ["/web/js/app.js", "text/javascript"],
    ["/web/js/loader.js", "text/javascript"],
    ["/api/frontend/loader", "text/javascript"],
    ["/api/frontend/module/core/dom.js", "text/javascript"],
    ["/api/frontend/module/data/rp-practice.js", "text/javascript"],
    ["/web/js/core/dom.js", "text/javascript"],
    ["/web/js/data/config.js", "text/javascript"],
    ["/web/data/elite-awards.json", "application/json"],
    ["/assets/collegium-seal.png", "image/png"],
    ["/assets/law-association-seal.png", "image/png"],
    ["/assets/site-icon.png", "image/png"],
    ["/favicon.ico", "image/x-icon"]
  ];
  for (const [pathname, expectedType] of assets) {
    const asset = await request(pathname, { raw: true });
    check(asset.status === 200, `${pathname}: HTTP ${asset.status}`);
    check(String(asset.headers.get("content-type")).startsWith(expectedType),
      `${pathname}: ожидался ${expectedType}, получен ${asset.headers.get("content-type")}`);
    check(asset.payload.length > 0, `${pathname}: пустой ответ`);
    if (pathname === "/web/css/loading.css") {
      check(asset.payload.length < 12 * 1024, "CSS экрана загрузки должен оставаться компактным.");
    }
  }

  /* ── Защита от обхода каталога ────────────────────────────────────────── */
  for (const attack of ["/web/../server.mjs", "/web/%2e%2e/server.mjs", "/web/js/../../.env", "/web/package.json"]) {
    const attempt = await request(attack, { raw: true });
    check(attempt.status === 404, `${attack}: ожидался 404, получен ${attempt.status}`);
  }

  /* ── Диагностика и вебхуки ────────────────────────────────────────────── */
  const diagnostics = await request("/api/discord/diagnostics");
  check(diagnostics.status === 200, `Диагностика Discord: HTTP ${diagnostics.status}`);
  const channels = diagnostics.payload?.webhooks || [];
  check(channels.length === 3, "Диагностика должна возвращать три канала уведомлений.");
  check(channels.every((channel) => !String(channel.url).includes("test-token")),
    "Диагностика не должна раскрывать токен webhook.");
  check(diagnostics.payload?.oauth?.configured === true, "OAuth должен определяться как настроенный.");
  check(diagnostics.payload?.bot?.configured === false, "Бот без токена должен определяться как ненастроенный.");

  const status = await request("/api/webhooks/status");
  check(status.status === 200, `Состояние уведомлений: HTTP ${status.status}`);
  check(Array.isArray(status.payload?.channels) && status.payload.channels.length === 3,
    "Состояние должно содержать три канала.");

  const before = webhookCalls.length;
  const test = await request("/api/webhooks/test", { method: "POST", body: { kind: "applications" } });
  check(test.status === 200, `Проверка канала: HTTP ${test.status} ${JSON.stringify(test.payload)}`);
  check(webhookCalls.length === before + 1, `Проверка канала должна сделать ровно один запрос, сделано ${webhookCalls.length - before}.`);
  const lastCall = webhookCalls.at(-1);
  check(lastCall?.options?.body instanceof FormData, "Проверка канала должна отправлять multipart FormData.");
  const payloadJson = lastCall?.options?.body?.get("payload_json");
  check(typeof payloadJson === "string" && JSON.parse(payloadJson).embeds?.[0]?.title?.includes("Проверка"),
    "Тестовое сообщение должно содержать embed с заголовком проверки.");

  const unknownChannel = await request("/api/webhooks/test", { method: "POST", body: { kind: "unknown" } });
  check(unknownChannel.status === 400, `Неизвестный канал должен отклоняться: HTTP ${unknownChannel.status}`);

  /* ── Каталог наград ───────────────────────────────────────────────────── */
  const catalog = await request("/web/data/elite-awards.json");
  check(catalog.payload?.awards?.length === 10, "Каталог элитных наград должен содержать 10 записей.");

  /* ── Гражданин не должен видеть диагностику ───────────────────────────── */
  const noSession = await fetch(new URL("/api/webhooks/status", baseUrl)).then((response) => response.status);
  check(noSession === 401, `Без сессии состояние уведомлений должно требовать вход: HTTP ${noSession}`);
} finally {
  server.webhookDispatcher?.stop();
  await new Promise((resolve) => server.close(resolve));
}

const report = { ok: problems.length === 0, webhookCalls: webhookCalls.length, problems };
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
