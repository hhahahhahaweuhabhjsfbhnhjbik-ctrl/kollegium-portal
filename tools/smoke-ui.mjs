#!/usr/bin/env node
/**
 * Смоук-тест интерфейса без браузера.
 *
 * Поднимает advokate.html в jsdom, подменяет сеть заранее подготовленными
 * ответами API, выполняет модули web/js и проверяет, что:
 *   • приложение стартует без ошибок JavaScript;
 *   • главная панель заполняется данными;
 *   • витрина «Элита коллегии» рисует ровно 10 наград;
 *   • каждый раздел открывается без исключений;
 *   • в HTML не осталось инлайновой логики.
 *
 * Запуск: node tools/smoke-ui.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(root, relative), "utf8");

/* ── Исходники интерфейса в порядке зависимостей ────────────────────────── */
const moduleFiles = [
  "web/js/data/config.js",
  "web/js/core/dom.js",
  "web/js/views/elite-awards.js",
  "web/js/app.js"
];

/** Превращает ESM-модули в один классический скрипт для jsdom. */
function toClassicScript(sources) {
  return sources.map((source) => source
    // многострочные и однострочные import ... from "..."
    .replace(/^[ \t]*import\s+[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*import\s+["'][^"']+["'];?[ \t]*$/gm, "")
    // export const/let/function/class
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\s/gm, "$1 ")
    // export { ... }
    .replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, "")
  ).join("\n;\n");
}

/* ── Подготовленные ответы API ─────────────────────────────────────────── */
const user = {
  id: 1,
  username: "gka",
  displayName: "Александр Волков",
  role: "ГКА",
  status: "active",
  discordLinked: true,
  discordUsername: "volkov",
  discordAvatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
  memberSince: "2025-01-15",
  createdAt: "2025-01-15T10:00:00.000Z"
};

const profile = {
  id: 1,
  display_name: "Александр Волков",
  role: "ГКА",
  created_at: "2025-01-15T10:00:00.000Z",
  member_since: "2025-01-15",
  reattest_due: "",
  discord_username: "volkov",
  discord_avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
  forum_profile_url: "https://forum.gta5rp.com/members/volkov",
  forum_profile_verified_at: "2025-02-01T10:00:00.000Z",
  document_count: 7,
  lawsuit_count: 3,
  closed_request_count: 12,
  completed_task_count: 5,
  passed_exam_count: 2,
  review_count: 4,
  average_rating: 4.75,
  approved_call_count: 31
};

const award = { kind: "special", title: "Мастер допроса", description: "50 успешных перекрёстных допросов", created_at: "2025-06-01T10:00:00.000Z", granted_by_name: "Совет Коллегии" };

const responses = {
  "/api/health": { ok: true, apiVersion: 4 },
  "/api/auth/me": { user, csrfToken: "csrf-token" },
  "/api/applications": { applications: [] },
  "/api/laws": { laws: { ak: { available: true } } },
  "/api/laws/ak": { name: "Административный кодекс", text: "Статья 1. Общие положения.", sourceNote: "" },
  "/api/attestations": { attestations: [] },
  "/api/documents": { documents: [], approvedCount: 7, myCount: 7 },
  "/api/lawsuits": { lawsuits: [] },
  "/api/promotion-requirements": { lawyerCallsRequired: 25 },
  "/api/tasks": { tasks: [] },
  "/api/calendar": { events: [] },
  "/api/profiles/1": { profile, reviews: [], achievements: [], awards: [award] },
  "/api/attorneys": { attorneys: [] },
  "/api/profile": {
    profile,
    metrics: {},
    promotions: [],
    exams: [],
    attestations: [],
    reprimands: [],
    tasks: [],
    achievements: [],
    awards: [award],
    reviews: [],
    employmentHistory: [],
    absences: [],
    reserve: []
  },
  "/api/achievements": { achievements: [] },
  "/api/reserve": { reserve: [] },
  "/api/absences": { absences: [] },
  "/api/characteristics": { characteristics: [] },
  "/api/academy": { materials: [] },
  "/api/members": { members: [] },
  "/api/colleagues": { colleagues: [] },
  "/api/reprimands": { reprimands: [] },
  "/api/discord/status": {
    linked: true,
    configured: true,
    username: "volkov",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
    linkedAt: "2025-01-16 10:00:00",
    nicknameError: "",
    syncError: ""
  },
  "/api/discord/diagnostics": {
    oauth: { configured: true, clientIdSet: true, clientSecretSet: true, redirectValid: true, redirectHost: "portal.example.com" },
    bot: { configured: true, guildConfigured: true, rolesConfigured: 7 },
    webhooks: [
      { kind: "applications", label: "Заявки и приём в Коллегию", url: "канал заявок · …/123/****", configured: true, sent: 12, failed: 0, retries: 0, lastError: "", lastErrorAt: null, lastSuccessAt: "2026-11-20T00:00:00.000Z" },
      { kind: "exams", label: "Экзамены и повышения", url: "канал экзаменов · …/456/****", configured: true, sent: 3, failed: 1, retries: 2, lastError: "HTTP 500", lastErrorAt: "2026-11-19T23:00:00.000Z", lastSuccessAt: "2026-11-19T22:00:00.000Z" },
      { kind: "logs", label: "Журнал руководства", url: "не настроен", configured: false, sent: 0, failed: 0, retries: 0, lastError: "", lastErrorAt: null, lastSuccessAt: null }
    ],
    queue: { pending: 0, queued: 0 }
  },
  "/api/rating-settings": { weights: { documentsApproved: 2, casesClosed: 2, lawsuitsFiled: 3, tasksCompleted: 2, reviews: 1 }, history: [] },
  "/api/analytics": { period: "30", staff: [], cases: [], documents: [], requests: [], reviews: [], hr: [], series: [] },
  "/api/reports": { period: "2026-11", rows: [] },
  "/api/weekly-reset/preview": { calendar: 0, absences: 0, reprimands: 0, applications: 0 },
  "/api/weekly-reset/history": { runs: [] }
};

/* ── Запуск ────────────────────────────────────────────────────────────── */
const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => problems.push(`jsdom: ${error.message}`));
virtualConsole.on("error", (...args) => problems.push(`console.error: ${args.join(" ")}`));

const html = await read("advokate.html");
const dom = new JSDOM(html, {
  url: "http://127.0.0.1:3000/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole
});
const { window } = dom;
const { document } = window;

window.addEventListener("error", (event) => problems.push(`window.error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => problems.push(`unhandledrejection: ${event.reason?.message || event.reason}`));

const requested = [];
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, "http://127.0.0.1:3000");
  requested.push(`${options.method || "GET"} ${url.pathname}`);
  if (url.pathname === "/web/data/elite-awards.json") {
    const catalog = JSON.parse(await read("web/data/elite-awards.json"));
    return { ok: true, status: 200, json: async () => catalog, text: async () => JSON.stringify(catalog) };
  }
  const payload = responses[url.pathname];
  if (payload === undefined) {
    problems.push(`Необработанный запрос API: ${url.pathname}`);
    return { ok: false, status: 404, json: async () => ({ error: "not found" }), text: async () => "{}" };
  }
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

const sources = await Promise.all(moduleFiles.map((file) => read(file)));
const bundle = toClassicScript(sources);

// Инлайновая логика в HTML запрещена — это отдельное требование к структуре.
if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
  problems.push("В advokate.html остался инлайновый <script> с кодом.");
}

try {
  window.eval(bundle);
} catch (error) {
  problems.push(`Ошибка выполнения модулей: ${error.message}`);
}

/* Ждём асинхронную инициализацию портала. */
const startedAt = Date.now();
while (Date.now() - startedAt < 5000) {
  const ready = document.querySelectorAll("#elite-awards .elite-card").length >= 10;
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/* ── Проверки ──────────────────────────────────────────────────────────── */
const check = (condition, message) => { if (!condition) problems.push(message); };

const eliteCards = document.querySelectorAll("#elite-awards .elite-card");
check(eliteCards.length === 10, `Ожидалось 10 карточек наград, найдено ${eliteCards.length}.`);

const titles = [...document.querySelectorAll("#elite-awards .elite-title")].map((node) => node.textContent.trim());
const expectedTitles = ["Адвокат дела", "Защитник народа", "Мастер допроса", "Правовой архитектор", "Железный аргумент",
  "Хранитель тайны", "Законник", "Несокрушимый", "Властитель города", "Легенда коллегии"];
check(expectedTitles.every((title) => titles.includes(title)), `В витрине нет всех наград. Найдено: ${titles.join(", ")}`);

check(document.querySelectorAll("#elite-awards .elite-card.is-legendary").length === 1, "Легендарная награда должна быть выделена одна.");
check(document.querySelectorAll("#elite-awards .elite-card.is-earned").length === 1, "Полученная награда «Мастер допроса» должна быть отмечена.");
check(document.querySelectorAll("#elite-awards .elite-laurel use").length === 10, "Лавровый венок не подключён к карточкам наград.");
check(document.querySelectorAll("#i-laurel ellipse").length >= 16, "Символ лаврового венка пуст.");
check(document.querySelector("#welcome-title")?.textContent.includes("Александр"), "Заголовок приветствия не заполнен именем сотрудника.");
check(document.querySelector("#document-count")?.textContent === "7", "Счётчик документов не обновился.");

/* Каждый раздел должен открываться без исключений. */
const tabs = [...document.querySelectorAll(".nav-btn[data-tab]")]
  .filter((button) => !button.classList.contains("hidden"))
  .map((button) => button.dataset.tab);

for (const tab of tabs) {
  const button = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  try {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const page = document.querySelector(`#page-${tab}`);
    check(page && page.classList.contains("active"), `Раздел «${tab}» не открылся.`);
  } catch (error) {
    problems.push(`Раздел «${tab}»: ${error.message}`);
  }
}

/* ── Отчёт ─────────────────────────────────────────────────────────────── */
const report = {
  ok: problems.length === 0,
  modules: moduleFiles,
  bundleBytes: bundle.length,
  tabs: tabs.length,
  eliteAwards: eliteCards.length,
  apiCalls: requested.length,
  problems
};
console.log(JSON.stringify(report, null, 2));
dom.window.close();
process.exit(problems.length ? 1 : 0);
