#!/usr/bin/env node
/**
 * Browserless smoke test for the redesigned portal and its API-backed views.
 *
 * Run with: node tools/smoke-ui.mjs
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(root, relative), "utf8");
const moduleFiles = [
  "web/js/data/rp-practice.js",
  "web/js/data/rp-interviews.js",
  "web/js/data/rp-interviews-extra.js",
  "web/js/data/config.js",
  "web/js/core/dom.js",
  "web/js/app.js"
];

function toClassicScript(sources) {
  return sources.map((source) => source
    .replace(/^[ \t]*import\s+[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*import\s+["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?[ \t]*$/gm, "")
    .replace(/^export\s+(async\s+function|function|class|const|let|var)\s/gm, "$1 ")
    .replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, "")
  ).join("\n;\n");
}

const user = {
  id: 1,
  username: "gka",
  displayName: "Александр Волков",
  role: "ГКА",
  status: "active",
  discordLinked: true,
  discordAvatarUrl: "https://cdn.discordapp.com/avatars/123456789012345678/avatar-hash.png?size=128"
};
const profile = {
  id: 1,
  display_name: user.displayName,
  role: user.role,
  approved_call_count: 7,
  member_since: "2025-01-15"
};
const attorney = {
  id: 2,
  display_name: "Елена Петрова",
  role: "Адвокат",
  average_rating: 4.5,
  cases_closed: 3,
  calls: 2,
  bails: 1,
  lawsuit_count: 2,
  document_count: 5,
  score: 8
};
const award = {
  title: "Мастер допроса",
  description: "Награда Коллегии",
  created_at: "2025-06-01"
};
const responses = {
  "/api/auth/me": { user, csrfToken: "test-csrf" },
  "/api/profile": { profile, awards: [award], achievements: [] },
  "/api/discord/status": {
    configured: true,
    botConfigured: true,
    botCanDm: true,
    linked: true,
    username: "gka"
  },
  "/api/notifications": {
    notifications: [{
      id: 12,
      notification_type: "activity_report_review",
      title: "Отчёт одобрен",
      body: "Вызов CALL-101 одобрен ГКА.",
      href: "/page/reports",
      created_at: "2026-01-15 12:00:00",
      read_at: null
    }],
    unreadCount: 1,
    discordDmEnabled: true
  },
  "/api/notifications/read-all": { ok: true },
  "/api/activity-reports": {
    canReview: true,
    reports: [{
      id: 101,
      report_type: "call",
      occurred_at: "2026-01-15",
      reference: "CALL-101",
      details: "Подтверждённый вызов.",
      status: "pending",
      decision: "",
      reporter_name: "Елена Петрова",
      reporter_role: "Адвокат"
    }]
  },
  "/api/activity-reports/101": { ok: true, status: "approved" },
  "/api/auth/logout": { ok: true },
  "/api/applications": { applications: [] },
  "/api/promotion-decree": { nextNumber: 0, candidates: [], history: [] },
  "/api/exams/law-progress": {
    available: false,
    stageRole: "ГКА",
    passedSubjects: [],
    lawyerCallsRequired: 0,
    message: "Тесты доступны сотрудникам на карьерном этапе."
  },
  "/api/exams/history": {
    exams: [
      {
        id: 2,
        track: "law:uk",
        title: "Уголовный кодекс",
        score: 4,
        total: 5,
        passed: true,
        created_at: "2026-02-14 12:00:00",
        questions: [{
          question: "Какой срок установлен?",
          selectedAnswer: "Правильный вариант",
          correctAnswer: "Правильный вариант",
          correct: true
        }]
      },
      {
        id: 1,
        track: "Юрист",
        title: "Проверка знаний · Юрист",
        score: 2,
        total: 5,
        passed: false,
        created_at: "2026-01-10 12:00:00",
        questions: [{
          question: "Как поступить?",
          selectedAnswer: "Неверный вариант",
          correctAnswer: "Верный вариант",
          correct: false
        }]
      }
    ]
  },
  "/api/lawsuits": { lawsuits: [] },
  "/api/members": {
    members: [{
      id: 2,
      display_name: "Новый сотрудник",
      username: "staff.login",
      role: "Стажер КА",
      status: "pending",
      document_count: 0,
      lawsuit_count: 0
    }]
  },
  "/api/photozot": {
    photos: [
      { label: "LSPD · фото 1", group_key: "lspd", group_label: "LSPD", url: "/photozot/lspd-1.png" },
      { label: "Федеральная тюрьма · фото 1", group_key: "ft", group_label: "Федеральная тюрьма", url: "/photozot/ft-1.png" }
    ]
  },
  "/api/reprimands": { reprimands: [] },
  "/api/analytics": {
    period: "7",
    trend: [{ period: "2026-01-01", members: 1, lawsuits: 2, documents: 3, requests: 1, promotions: 0, reprimands: 0 }]
  },
  "/api/attorneys": { attorneys: [
    attorney,
    { ...attorney, id: 3, display_name: "Иван Сергеев" },
    { ...attorney, id: 4, display_name: "Пётр Иванов" }
  ] },
  "/api/giveaway": {
    enabled: true,
    weekStart: "2026-01-12",
    weekEnd: "2026-01-18",
    totalPoints: 4,
    participantCount: 1,
    standings: [{
      rank: 1,
      userId: 2,
      displayName: "Елена Петрова",
      role: "Адвокат",
      points: 4,
      calls: 2,
      bails: 1
    }]
  },
  "/api/profiles/2": {
    profile: {
      id: attorney.id,
      display_name: attorney.display_name,
      role: attorney.role,
      average_rating: attorney.average_rating,
      review_count: 2,
      closed_case_count: 3,
      lawsuit_count: 2,
      profile_bio: "Опытный адвокат."
    },
    reviews: [{ rating: 5, comment: "Помогла разобраться.", created_at: "2025-05-01" }]
  },
  "/api/laws": { laws: { ak: { available: true } } },
  "/api/laws/ak": {
    name: "ak.txt",
    text: "Статья 7.3. Полномочия должностного лица.\nСтатья 2.7.3. Иная норма.",
    sourceNote: "Файл: laws/ak.txt"
  },
  "/api/reports": { period: "2026-01", rows: [], totals: {} }
};

const problems = [];
const requested = [];
const activityReportBodies = [];
const completedRpCaseIds = new Set();
let createdCustomCase = null;
const audioTones = [];
let failAttorneyRanking = false;
let resolveAiAssistantResponse;
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => problems.push(`jsdom: ${error.message}`));
virtualConsole.on("error", (...args) => problems.push(`console.error: ${args.join(" ")}`));

const html = await read("advokate.html");
const css = await read("web/css/base.css");
const themeCss = await read("web/css/theme.css");
if (/<(?:button|input|select|textarea)\b[^>]*\bon(?:click|input|change|submit)=/i.test(html)) {
  problems.push("В HTML остался встроенный обработчик события.");
}
const dom = new JSDOM(html, {
  url: "http://127.0.0.1:3000/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole
});
const { window } = dom;
const { document } = window;
window.matchMedia = () => ({ matches: false });
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
window.AudioContext = class {
  constructor() {
    this.currentTime = 0;
    this.state = "running";
    this.destination = {};
  }
  createOscillator() {
    const oscillator = {
      type: "",
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      start() { audioTones.push(this.type); },
      stop() {}
    };
    return oscillator;
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {}
    };
  }
};
window.addEventListener("error", (event) => problems.push(`window.error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) =>
  problems.push(`unhandledrejection: ${event.reason?.message || event.reason}`)
);
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, "http://127.0.0.1:3000");
  const method = options.method || "GET";
  requested.push(`${method} ${url.pathname}`);
  if (url.pathname === "/api/attorneys" && failAttorneyRanking) {
    return { ok: false, status: 503, json: async () => ({ error: "Рейтинг временно недоступен." }) };
  }
  if (url.pathname === "/api/activity-reports" && method === "POST") {
    activityReportBodies.push(JSON.parse(options.body));
  }
  let payload = responses[url.pathname];
  if (url.pathname === "/api/ai-assistant" && method === "POST") {
    payload = await new Promise((resolve) => { resolveAiAssistantResponse = resolve; });
  } else if (url.pathname === "/api/rp-practice/completions") {
    payload = { completedCaseIds: [...completedRpCaseIds] };
  } else if (url.pathname === "/api/rp-practice/answer" && method === "POST") {
    const body = JSON.parse(options.body);
    const correct = body.caseId === "rp_easy_01" && body.answerIndex === 1;
    if (correct) completedRpCaseIds.add(body.caseId);
    payload = {
      correct,
      completed: correct || completedRpCaseIds.has(body.caseId),
      explanation: correct ? "Точный ответ." : "Ответ неверный."
    };
  } else if (url.pathname === "/api/rp-custom-cases" && method === "POST") {
    createdCustomCase = {
      id: "custom-401",
      title: "Личный учебный кейс",
      subtitle: "Разговор с офицером",
      copName: "Офицер Miller",
      copDept: "LSDP",
      ownerId: user.id,
      ownerName: user.displayName,
      status: "private",
      custom: true,
      completed: false,
      startNode: "start",
      questions: [{ text: "Вопрос", options: ["Да", "Нет", "Позже"] }],
      nodes: {
        start: {
          copText: "Опишите обстоятельства дела.",
          choices: [{ text: "Представить позицию защиты", next: "end", delta: 5, debrief: "Ответ принят." }]
        },
        end: { isEnd: true, won: true, copText: "Разговор завершён." }
      }
    };
    payload = { case: createdCustomCase };
  } else if (url.pathname === "/api/rp-custom-cases") {
    payload = { cases: createdCustomCase ? [createdCustomCase] : [] };
  } else if (url.pathname === "/api/notifications/preferences" && method === "PATCH") {
    const preference = JSON.parse(options.body);
    responses["/api/notifications"].discordDmEnabled = preference.discordDmEnabled;
    payload = preference;
  }
  if (payload === undefined) {
    problems.push(`Необработанный запрос API: ${url.pathname}`);
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  }
  return { ok: true, status: 200, json: async () => payload };
};

const sources = await Promise.all(moduleFiles.map((file) => read(file)));
try {
  window.eval(toClassicScript(sources));
} catch (error) {
  problems.push(`Ошибка выполнения модулей: ${error.message}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (!document.querySelector("#app-shell")?.classList.contains("hidden") &&
      document.querySelector("#kpiCalls")?.textContent === "6") break;
  await wait(20);
}

const check = (condition, message) => { if (!condition) problems.push(message); };
check(!document.querySelector("#app-shell")?.classList.contains("hidden"), "Портал не открылся после авторизации.");
check(document.querySelector("#active-user-name")?.textContent === user.displayName, "Имя активного пользователя не показано.");
check(document.querySelector("#user-avatar img")?.getAttribute("src") === user.discordAvatarUrl &&
  document.querySelector("#welcome-avatar img")?.getAttribute("src") === user.discordAvatarUrl,
"Discord-аватар должен отображаться в шапке и приветственном блоке.");
check(document.querySelector("#welcome-calls")?.textContent === "7", "Подтверждённые вызовы профиля не загрузились.");
check(document.querySelector("#network-notice")?.open &&
  Boolean(window.localStorage.getItem(`portal-network-notice:${user.id}`)),
  "Сетевое уведомление должно появляться при входе на главную и сохранять время показа.");
failAttorneyRanking = true;
await window.navigate("dashboard");
check(document.querySelector("#kpiCalls")?.textContent === "6" &&
  document.querySelector("#dashboard-attorneys")?.textContent.includes("Рейтинг временно недоступен."),
"Сбой рейтинга не должен ломать главную страницу и должен показывать понятную ошибку.");
failAttorneyRanking = false;
await window.navigate("dashboard");
check(document.querySelector("#kpiCalls")?.textContent === "6" &&
  document.querySelector("#kpiActivityTitle")?.textContent === "Активность за 7 дней",
"Сводка активности за неделю не загрузилась.");
check(document.querySelector('.sidebar-scroll [data-view="dashboard"] use')?.getAttribute("href") ===
  "/web/icons-sprite.svg#icon-01_overview", "Иконка главной должна использовать переданный SVG-спрайт.");
check(document.querySelector('link[rel="icon"]')?.getAttribute("href") === "/assets/site-icon.png",
  "Вкладка сайта должна использовать присланную иконку.");
check(document.querySelector(".auth-brand img")?.getAttribute("src") === "/assets/site-icon.png" &&
  document.querySelector(".brand-mark img")?.getAttribute("src") === "/assets/site-icon.png",
"Иконка сайта должна отображаться на входе и в шапке.");
const contentArea = document.querySelector(".content-area");
check([...document.querySelectorAll(".page-view")].every((section) => section.parentElement === contentArea),
  "Все страницы должны оставаться внутри основной области контента.");
check(!document.querySelector("#register-invite") &&
  document.querySelector('#registration-kind option[value="staff"]')?.textContent.includes("после одобрения"),
"Регистрация сотрудника не должна требовать код приглашения и должна объяснять ожидание одобрения.");
check(!document.querySelector("#register-email") &&
  !document.querySelector("#globalSearch") &&
  !document.querySelector(".global-search"),
"Email не должен быть в регистрации, а общий поиск — в верхней панели.");
check(!document.querySelector("#discord-dm-enabled") &&
  document.querySelector("#discord-dm-toggle") &&
  document.querySelector("#discord-unlink"),
"Настройки Discord должны использовать переключатель и отдельную кнопку отвязки вместо чекбокса.");
check(document.querySelector("#audit-test-notifications")?.classList.contains("hidden"),
  "Тестовые уведомления аудита должны быть скрыты для аккаунтов, кроме yyte.");
check(document.querySelector(".quick-actions-panel"), "На главной должны быть быстрые переходы.");
check(css.includes(".rp-phone-conversation .ifruit-messages::-webkit-scrollbar-thumb") &&
  css.includes("scrollbar-color: #45516a #0b101b"),
"Полоса прокрутки телефона должна быть оформлена в тёмной теме.");
check([...document.querySelectorAll("#lawsuit-template option")].map((option) => option.value).join(",") ===
  "lawsuit-supreme,lawsuit-federal,motion-supreme,motion-federal,rehabilitation,appeal",
"В форме иска должны остаться шесть поддерживаемых видов документов.");
check([...document.querySelectorAll("#activity-report-type option")].map((option) => option.value).join(",") === "call,bail",
"В ручной отчётности должны быть вызов и залог.");
const sidebar = document.querySelector("#sidebar");
check(!sidebar?.querySelector(".sidebar-scroll [data-view='rating'], .sidebar-scroll [data-view='audit'], .sidebar-scroll [data-view='awards'], .sidebar-scroll [data-view='reports']") &&
  sidebar?.querySelector(".sidebar-footer [data-view='rating']") &&
  sidebar?.querySelector(".sidebar-footer [data-view='audit']") &&
  sidebar?.querySelector(".sidebar-footer [data-view='awards']") &&
  sidebar?.querySelector(".sidebar-scroll [data-view='giveaway']") &&
  sidebar?.querySelector(".sidebar-footer [data-view='reports']"),
"Премии должны быть среди основных разделов, а рейтинги и отчёты — в нижнем блоке сайдбара.");
check(document.querySelector("#audit-search")?.closest("#view-audit") &&
  themeCss.includes(".audit-table-wrap { max-height:") &&
  themeCss.includes("overflow: auto"),
"Поиск и вертикальная прокрутка должны быть размещены в кадровом аудите.");
const networkNotice = document.querySelector("#network-notice");
networkNotice.close();
window.localStorage.removeItem(`portal-network-notice:${user.id}`);
await window.navigate("rating");
const ratingHeaders = [...document.querySelectorAll("#view-rating th")].map((header) => header.textContent.trim());
const ratingRow = [...document.querySelectorAll("#ratingTableBody tr:first-child td")].map((cell) => cell.textContent.trim());
check(ratingHeaders.slice(3).join(",") === "Вызовы,Залоги,Иски,Баллы" &&
  ratingRow.slice(3).join(",") === "2,1,2,8.0",
"Рейтинг должен показывать вызовы, залоги, иски и баллы в этом порядке.");
check(!networkNotice.open, "Сетевое уведомление не должно показываться вне главной страницы.");
await window.navigate("dashboard");
check(networkNotice.open, "Сетевое уведомление должно появиться при возвращении на главную.");
networkNotice.close();
await window.navigate("dashboard");
check(!networkNotice.open, "Сетевое уведомление не должно показываться повторно в течение часа.");
const topAttorneyCards = [...document.querySelectorAll("#dashboard-attorneys .attorney-card")];
check(topAttorneyCards.map((card) => card.querySelector(".attorney-avatar img")?.getAttribute("src")).join(",") ===
  "/assets/role-senior-attorney.png,/assets/role-attorney.png,/assets/role-lawyer.png" &&
  topAttorneyCards[0]?.querySelector(".attorney-stats")?.textContent.includes("Вызовы") &&
  topAttorneyCards[0]?.querySelector(".attorney-stats")?.textContent.includes("Залоги"),
"Карточки топ-3 должны показывать нужные аватары и вызовы с залогами.");
const careerButton = document.querySelector("#careerBranchBtn");
const careerSubmenu = document.querySelector("#careerSubmenu");
check(careerButton?.textContent.includes("Начало пути"), "Раздел обучения должен называться «Начало пути».");
check(careerSubmenu?.textContent.includes("Тесты") &&
  careerSubmenu.textContent.includes("Практика РП") &&
  careerSubmenu.textContent.includes("Мой путь"), "Подветки пути, экзаменов и практики не отображаются.");
check(document.querySelector("#view-career") && document.querySelector("#career-path-tasks") &&
  document.querySelector("[data-action='start-career-path']"),
"Страница «Мой путь» и кнопка старта должны быть в интерфейсе.");
careerButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(5);
check(careerButton?.getAttribute("aria-expanded") === "false" && !careerSubmenu?.classList.contains("open"),
  "Подветка «Начало пути» не сворачивается.");
careerButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(5);
check(careerButton?.getAttribute("aria-expanded") === "true" && careerSubmenu?.classList.contains("open"),
  "Подветка «Начало пути» не раскрывается.");
const approvedBadge = document.createElement("div");
approvedBadge.innerHTML = window.statusBadge("approved");
check(approvedBadge.querySelector('use')?.getAttribute("href") ===
  "/web/icons-sprite.svg#icon-17_check_approved", "Статус «Одобрено» должен отображаться своей иконкой.");
check(document.querySelector(".attorney-card")?.textContent.includes("Елена Петрова"), "Рейтинг адвокатов на главной не отображается.");
document.querySelector('[data-action="attorney-profile"]')?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(25);
check(requested.some((entry) => entry === "GET /api/profiles/2"), "Карточка адвоката не загрузила его профиль.");
check(document.querySelector("#document-dialog-body")?.textContent.includes("Опытный адвокат."),
  "Профиль адвоката не открылся из главной.");
document.querySelector('[data-action="close-document"]')?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

const views = [...new Set([...document.querySelectorAll("[data-view]")]
  .filter((button) => !button.classList.contains("hidden"))
  .map((button) => button.dataset.view))];
const practiceNav = document.querySelector("#practice-nav");
check(!practiceNav?.classList.contains("hidden") && !practiceNav?.disabled &&
  practiceNav?.getAttribute("aria-disabled") === "false" && practiceNav?.dataset.view === "practice",
"Практика должна быть доступна активному сотруднику с правами руководителя.");
check(document.querySelectorAll(".rp-practice-controls [data-level]").length === 3 &&
  Boolean(document.querySelector("#rp-practice-content")),
  "Раздел «Практика РП» должен содержать три кнопки уровней и область кейсов.");
check(!document.querySelector("#law-test-subject") &&
  document.querySelector("#law-exam-buttons") && document.querySelector(".law-exam-grid"),
"Тесты по кодексам должны отображаться кнопками без выпадающего списка.");
for (const view of views) {
  await window.navigate(view);
  await wait(25);
  check(document.querySelector(`#view-${view}`)?.classList.contains("active"), `Экран «${view}» не открылся.`);
}
await window.navigate("audit");
const auditSearch = document.querySelector("#audit-search");
auditSearch.value = "pending";
auditSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
check(document.querySelectorAll("#auditTableBody tr").length === 1 &&
  document.querySelector("#audit-member-count")?.textContent.includes("Найдено 1"),
"Поиск кадрового аудита должен находить аккаунт по статусу.");
auditSearch.value = "staff.login";
auditSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
check(document.querySelectorAll("#auditTableBody tr").length === 1,
"Поиск кадрового аудита должен находить аккаунт по логину.");
auditSearch.value = "нет совпадений";
auditSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
check(document.querySelector("#audit-member-count")?.textContent.includes("Найдено 0"),
"Поиск кадрового аудита должен сообщать, если совпадений нет.");
auditSearch.value = "";
auditSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
await window.navigate("giveaway");
check(requested.includes("GET /api/giveaway") &&
  document.querySelector("#giveaway-ranking")?.textContent.includes("Елена Петрова") &&
  document.querySelector("#giveaway-total-points")?.textContent.includes("4"),
"Страница премии должна загружать и отображать рейтинг очков.");
await window.navigate("practice");
for (const level of ["rp_easy", "rp_medium", "rp_hard"]) {
  document.querySelector(`.rp-practice-controls [data-level="${level}"]`)?.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await wait(10);
  check(document.querySelectorAll("#rp-practice-content .rp-case-card").length === 6 &&
    document.querySelectorAll("#rp-practice-content .rp-case-option").length === 18,
  `${level} должен открывать шесть кейсов с тремя вариантами ответа.`);
}

document.querySelector('.rp-practice-controls [data-level="rp_easy"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
let firstPracticeCard = document.querySelector("#rp-practice-content .rp-case-card");
firstPracticeCard.querySelector('[data-index="0"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
firstPracticeCard = document.querySelector("#rp-practice-content .rp-case-card");
check(!firstPracticeCard.classList.contains("is-completed") &&
  firstPracticeCard.querySelector(".rp-case-explanation.is-incorrect"),
"Неверный ответ не должен закрывать RP-кейс.");
firstPracticeCard.querySelector('[data-index="1"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
firstPracticeCard = document.querySelector("#rp-practice-content .rp-case-card");
check(firstPracticeCard.classList.contains("is-completed") &&
  [...firstPracticeCard.querySelectorAll(".rp-case-option")].every((button) => button.disabled),
"Верный ответ должен закрыть кейс и отключить его варианты.");
await window.navigate("practice");
document.querySelector('.rp-practice-controls [data-level="rp_easy"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
check(document.querySelector("#rp-practice-content .rp-case-card")?.classList.contains("is-completed"),
"Пройденный RP-кейс должен оставаться закрытым после повторной загрузки раздела.");

document.querySelector('[data-action="open-rp-phone"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
check(!document.querySelector("#rp-phone-dialog")?.classList.contains("hidden") &&
  document.querySelectorAll("#rp-phone-case-picker .rp-phone-scenario").length === 4 &&
  document.querySelector("#rp-phone-title")?.textContent === "AI Case" &&
  document.querySelector('.rp-phone-status-icons svg[aria-label="Wi-Fi"]') &&
  document.querySelector(".rp-phone-battery"),
"Интерактивный обзвон должен открываться отдельно на весь экран с выбором сценария.");
const rpScenarioTitles = [...document.querySelectorAll("#rp-phone-case-picker .rp-phone-scenario strong")]
  .map((element) => element.textContent);
check(rpScenarioTitles.includes("Адвокат в КПЗ: допуск, договор и залог") &&
  rpScenarioTitles.includes("Допрос под давлением: тайна и иммунитет"),
"Новые RP-кейсы должны отображаться читаемым русским текстом.");
check([...document.querySelectorAll("#rp-phone-case-picker .rp-scenario-index")]
  .map((element) => element.textContent).join(",") === "01,02,03,04",
"Нумерация кейсов в телефоне должна быть единообразной и двузначной.");
const originalRandom = window.Math.random;
window.Math.random = () => 0;
document.querySelector('#rp-phone-case-picker [data-case-id="case_lspd_kpz"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
window.Math.random = originalRandom;
check(document.querySelector("#rp-phone-messages .msg-cop") &&
  document.querySelectorAll("#rp-phone-choices .choice-reply-btn").length === 3,
"Сценарий телефона должен показывать реплику офицера и варианты ответа.");
const initialRpChoices = [...document.querySelectorAll("#rp-phone-choices .choice-reply-btn")];
const correctInitialChoice = initialRpChoices.find((button) =>
  button.textContent.includes("Вызов принят вовремя"));
check(correctInitialChoice?.dataset.index === "2",
"Правильный вариант встроенного AI Case не должен закрепляться в первой позиции.");
initialRpChoices.find((button) => button.textContent.includes("Ну ладно, раз 6 минут прошло"))
  ?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
check(document.querySelector("#rp-phone-mood")?.textContent.includes("Ухмыляется") &&
  document.querySelector("#rp-phone-messages")?.textContent.includes("сам всё признал") &&
  audioTones.includes("triangle"),
"Ошибочный ответ должен вести по своей ветке и вызывать ухмылку офицера.");
document.querySelector('[data-action="close-rp-phone"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
document.querySelector('[data-action="open-rp-phone"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
check(document.querySelector("#rp-phone-messages")?.textContent.includes("сам всё признал"),
"Закрытие и повторное открытие телефона должно сохранять текущий диалог.");
([...document.querySelectorAll("#rp-phone-choices .choice-reply-btn")].find((button) =>
  button.textContent.includes("Стоп. Ожидание адвоката")))?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
check(document.querySelector("#rp-phone-messages")?.textContent.includes("Предоставь комнату") &&
  document.querySelector("#rp-phone-mood")?.textContent.includes("Злится"),
"Перемешивание вариантов не должно менять связанный с каждым ответом сюжет.");
([...document.querySelectorAll("#rp-phone-choices .choice-reply-btn")].find((button) =>
  button.textContent.includes("Запись обязаны показать")))?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
check(document.querySelector("#rp-phone-mood")?.textContent.includes("Злится"),
"Правильный ответ должен вызывать злость офицера.");
check(audioTones.includes("sawtooth"), "Правильный ответ должен воспроизводить звук злой реакции.");
check(document.querySelector("#rp-phone-choices")?.textContent.includes("Назад к делам") &&
  document.querySelector("#rp-phone-choices")?.textContent.includes("Повторить диалог") &&
  document.querySelector(".rp-phone-end-actions .rp-phone-repeat") &&
  document.querySelector("#rp-phone-messages")?.textContent.includes("доверитель освобождён"),
"Интерактивный сценарий должен завершаться развязкой и отдельными действиями.");
document.querySelector("#rp-phone-sound-toggle")?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
check(document.querySelector("#rp-phone-sound-toggle")?.getAttribute("aria-pressed") === "false" &&
  document.querySelector("#rp-phone-sound-toggle")?.textContent.includes("выключен"),
"Звуковые эффекты должны отключаться отдельной кнопкой.");
document.querySelector('#rp-phone-choices [data-action="rp-phone-back"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
check(!document.querySelector("#rp-phone-case-picker")?.classList.contains("hidden") &&
  document.querySelectorAll("#rp-phone-case-picker .rp-phone-scenario").length === 4,
"Кнопка «Назад к делам» должна сразу возвращать к выбору кейса без перезагрузки.");
document.querySelector('#rp-phone-case-picker [data-case-id="case_fib_interrogation"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
check(document.querySelector("#rp-phone-subtitle")?.textContent.includes("FIB") &&
  document.querySelector("#rp-phone-messages .msg-cop"),
"После возврата можно сразу выбрать и открыть другое дело.");
document.querySelector('[data-action="close-rp-phone"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
document.querySelector('[data-action="open-rp-phone"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
document.querySelector('#rp-phone-choices [data-action="rp-phone-back"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
document.querySelector('#rp-phone-case-picker [data-action="create-rp-custom-case"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
check(document.querySelector("#rp-phone-dialog")?.classList.contains("hidden") &&
  !document.querySelector("#document-dialog")?.classList.contains("hidden"),
"При открытии формы личного AI Case телефон должен закрываться.");
const personalCaseForm = document.querySelector("#rp-custom-case-form");
personalCaseForm.querySelector("[name='details']").value = "Офицер задержал доверителя для проверки обстоятельств.";
personalCaseForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await wait(20);
check(requested.includes("POST /api/rp-custom-cases") &&
  document.querySelector("#document-dialog")?.classList.contains("hidden") &&
  !document.querySelector("#rp-phone-dialog")?.classList.contains("hidden") &&
  document.querySelector("#rp-phone-title")?.textContent === "Офицер Miller" &&
  !document.querySelector("#rp-phone-choices")?.textContent.includes("Опубликовать"),
"Создание личного AI Case должно отправить форму и открыть созданный диалог без публикации.");
document.querySelector('[data-action="close-rp-phone"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);

await window.navigate("laws");
const lawsSearch = document.querySelector("#lawsSearch");
lawsSearch.value = "7.3";
lawsSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
await wait(10);
check(document.querySelectorAll("#lawsSearchResults .law-search-result").length === 1 &&
  document.querySelector("#lawsSearchResults")?.textContent.includes("Источник: ak.txt") &&
  !document.querySelector("#lawsSearchResults")?.textContent.includes("2.7.3"),
"Поиск статьи 7.3 должен показывать источник и не путать её с 2.7.3.");

check(document.querySelector("#lawsuit-preview-code")?.textContent.includes("[TABLE width=\"100%\"]"),
  "BBCode-форма должна показывать предпросмотр.");
check(document.querySelector("#lawsuit-form")?.children[0]?.classList.contains("lawsuit-editor") &&
  document.querySelector("#lawsuit-form")?.children[1]?.classList.contains("lawsuit-forum-panel"),
  "Редактор документа должен располагаться рядом с визуальным предпросмотром форума.");
check(document.querySelector("#lawsuit-forum-preview img")?.getAttribute("src") === "/assets/law-association-seal.png",
  "В предпросмотре должна отображаться присланная печать.");
const claimantField = document.querySelector('#lawsuit-fields [data-lawsuit-field="claimant"]');
claimantField.value = 'Тестовый Истец <img src=x onerror="alert(1)">';
claimantField.dispatchEvent(new window.Event("input", { bubbles: true }));
check(document.querySelector("#lawsuit-preview-code")?.textContent.includes("Тестовый Истец"),
  "Предпросмотр BBCode должен обновляться при вводе.");
check(document.querySelector("#lawsuit-forum-preview")?.textContent.includes('Тестовый Истец <img src=x onerror="alert(1)">') &&
  document.querySelectorAll("#lawsuit-forum-preview img").length === 1,
  "Визуальный предпросмотр должен обновляться при вводе и выводить пользовательский текст безопасно.");
for (const template of [
  "lawsuit-supreme", "lawsuit-federal", "motion-supreme", "motion-federal",
  "rehabilitation", "appeal"
]) {
  const selector = document.querySelector("#lawsuit-template");
  selector.value = template;
  selector.dispatchEvent(new window.Event("change", { bubbles: true }));
  check(Boolean(document.querySelector("#lawsuit-forum-preview .forum-preview-page h2")?.textContent.trim()) &&
    document.querySelector("#lawsuit-forum-preview img")?.getAttribute("src") === "/assets/law-association-seal.png",
    `Визуальный предпросмотр шаблона «${template}» не отобразился.`);
}

for (const [route, view] of [
  ["/page/iski", "lawsuits"],
  ["/page/rating", "rating"],
  ["/page/audit", "audit"],
  ["/page/exams", "tests"],
  ["/page/reports", "reports"]
]) {
  dom.reconfigure({ url: `http://127.0.0.1:3000${route}` });
  await window.enterSession({
    user: { ...user, discordLinked: false, discordAvatarUrl: "" },
    csrfToken: "test-csrf"
  });
  check(document.querySelector(`#view-${view}`)?.classList.contains("active"),
    `Прямой маршрут ${route} должен открывать раздел «${view}» даже без привязки Discord.`);
}
responses["/api/career-path"] = {
  started: true,
  tutorialSeen: true,
  role: "Юрист",
  passedSubjects: [],
  allTestsPassed: true,
  lawsReviewed: true,
  completedCaseIds: [],
  requiredCaseCount: 0,
  generalRpPracticeCompletedCaseIds: [],
  generalRpPracticeRequiredCount: 18,
  completedEvidenceCount: 0,
  requiredEvidenceCount: 2,
  practiceSubmitted: false,
  lawyerPromotionPath: true,
  interviewReady: false,
  interviewPromptDismissed: false,
  canRequestInterview: false
};
dom.reconfigure({ url: "http://127.0.0.1:3000/page/laws" });
await window.enterSession({
  user: { ...user, role: "Юрист", discordLinked: false, discordAvatarUrl: "" },
  csrfToken: "test-csrf"
});
check(document.querySelector("#view-laws")?.classList.contains("active") &&
  !document.querySelector("#practice-nav")?.disabled,
"Карьерная практика должна разблокироваться из раздела законов после загрузки выполненного прогресса юриста.");
check([...document.querySelectorAll(".career-general-practice-only")]
  .every((element) => !element.classList.contains("hidden")),
"Юристу должна быть доступна общая RP-практика.");
await window.enterSession({
  user: { ...user, role: "Стажер КА", discordLinked: false, discordAvatarUrl: "" },
  csrfToken: "test-csrf"
});
check([...document.querySelectorAll(".career-general-practice-only")]
  .every((element) => element.classList.contains("hidden")),
"Стажёру должна быть скрыта общая RP-практика.");
dom.reconfigure({ url: "http://127.0.0.1:3000/page/reports" });
await window.enterSession({
  user: { ...user, discordLinked: false, discordAvatarUrl: "" },
  csrfToken: "test-csrf"
});
check(!document.querySelector("#user-avatar img") &&
  document.querySelector("#user-avatar")?.textContent === "АВ",
"Если Discord не привязан, аватар должен возвращаться к инициалам.");
const approveButton = document.querySelector('#auditTableBody [data-action="update-member-status"]');
check(approveButton?.textContent.trim() === "Одобрить" && approveButton.dataset.status === "active",
  "ГКА должен одобрять новые аккаунты из кадрового аудита.");

check(document.querySelector("#awardsGrid .award-card")?.textContent.includes("Мастер допроса"), "Награда из профиля не отображается.");
check(document.querySelector("#discord-dm-toggle")?.textContent.trim() === "Выключить уведомления" &&
  document.querySelector("#discord-dm-toggle")?.classList.contains("is-enabled"),
"При включённых ЛС должна отображаться зелёная кнопка их отключения.");
document.querySelector("#discord-dm-toggle")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(15);
check(document.querySelector("#discord-dm-toggle")?.textContent.trim() === "Включить уведомления" &&
  document.querySelector("#discord-dm-toggle")?.classList.contains("is-disabled"),
"После отключения ЛС должна отображаться красная кнопка обратного включения.");
document.querySelector("#discord-dm-toggle")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(15);
check(document.querySelector("#discord-dm-toggle")?.textContent.trim() === "Выключить уведомления" &&
  document.querySelector("#discord-dm-toggle")?.classList.contains("is-enabled"),
"Повторное нажатие должно включить ЛС и вернуть зелёную кнопку.");
const examAttempts = [...document.querySelectorAll("#exam-history-list .exam-attempt")];
const examStats = [...document.querySelectorAll("#exam-history-summary .exam-history-stat")]
  .map((item) => `${item.querySelector("span")?.textContent}:${item.querySelector("strong")?.textContent}`);
check(examAttempts.length === 2 &&
  examAttempts[0].classList.contains("is-passed") &&
  examAttempts[0].textContent.includes("4 / 5") &&
  examAttempts[1].classList.contains("is-failed") &&
  examStats.includes("Всего попыток:2") &&
  examStats.includes("Сдано:1") &&
  examAttempts[0].querySelector(".exam-attempt-details")?.open &&
  examAttempts[0].textContent.includes("Правильный вариант"),
"История экзаменов должна показывать попытки, результат, статус и разбор ответов.");
responses["/api/discord/status"] = {
  configured: false,
  botConfigured: false,
  botCanDm: false,
  linked: false
};
await window.loadDiscordSettings();
check(requested.some((entry) => entry === "GET /api/laws"), "Экран законов не запросил данные сервера.");
check(requested.some((entry) => entry === "GET /api/reports"), "Экран отчётности не запросил серверный отчёт.");
window.switchLawsTab("zones");
await wait(15);
check(document.querySelectorAll("#photozotTabs [role='tab']").length === 2 &&
  document.querySelectorAll("#photozotContainer .photozot-card").length === 1,
"Фотографии территорий должны отображаться раздельными категориями.");
document.querySelector("#photozotTabs [data-group='ft']")?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(10);
check(document.querySelector("#photozotContainer")?.textContent.toLocaleLowerCase("ru").includes("федеральная тюрьма"),
  "Выбор категории должен показывать только её фото.");
const photoTrigger = document.querySelector("#photozotContainer .photozot-card a");
const photoViewer = document.querySelector("#photo-viewer");
photoTrigger.focus();
photoTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await wait(10);
check(!photoViewer?.classList.contains("hidden") &&
  document.querySelector("#photo-viewer-image")?.getAttribute("src")?.includes("ft-1.png") &&
  document.body.classList.contains("photo-viewer-open"),
"Нажатие на фото должно открывать просмотр поверх размытого фона.");
document.querySelector("#photo-viewer-close")?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
check(photoViewer?.classList.contains("hidden") && !document.body.classList.contains("photo-viewer-open") &&
  document.activeElement === photoTrigger,
"Крестик должен закрывать просмотр и возвращать фокус к фотографии.");
photoTrigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await wait(10);
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
check(photoViewer?.classList.contains("hidden"), "Escape должен закрывать просмотр фото.");
check(document.querySelector("#activity-report-list .activity-report-card")?.textContent.includes("CALL-101") &&
  document.querySelector('#activity-report-list [data-status="approved"]'),
"ГКА должен видеть индивидуальные отчёты и управлять их одобрением.");
document.querySelector('#activity-report-list [data-status="approved"]')?.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await wait(15);
check(requested.includes("PATCH /api/activity-reports/101"),
  "Одобрение отчёта ГКА не отправило решение на сервер.");
check(document.querySelector("#discord-connect")?.disabled &&
  document.querySelector("#discord-status-message")?.textContent.includes("OAuth"),
"Не настроенная Discord-привязка должна объясняться без видимости успешного подключения.");
document.querySelector("#notification-toggle")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(10);
check(!document.querySelector("#notification-panel")?.classList.contains("hidden") &&
  document.querySelector("#notification-count")?.textContent === "1" &&
  document.querySelector("#notification-list")?.textContent.includes("Отчёт одобрен"),
"Центр уведомлений не показал непрочитанное уведомление.");
document.querySelector('[data-action="read-all-notifications"]')?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await wait(10);
check(requested.includes("POST /api/notifications/read-all"), "Команда «Прочитать все» не вызвала API.");
document.querySelector("#activity-report-type").value = "call";
document.querySelector("#activity-report-type").dispatchEvent(new window.Event("change", { bubbles: true }));
document.querySelector("#activity-report-date").value = "2026-01-15";
document.querySelector("#activity-report-details").value = "Проверка отправки жалобы.";
check(!document.querySelector("#activity-report-link") &&
  !document.querySelector("#activity-report-link-field"),
"В форме сдачи отчёта не должно быть поля ссылки на вызов.");
const reportImage = new window.File([
  new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
], "report.png", { type: "image/png" });
const pasteEvent = new window.Event("paste", { bubbles: true, cancelable: true });
Object.defineProperty(pasteEvent, "clipboardData", {
  value: { items: [{ type: "image/png", getAsFile: () => reportImage }] }
});
document.dispatchEvent(pasteEvent);
await wait(10);
check(!document.querySelector("#activity-report-photo-preview")?.classList.contains("hidden"),
  "Вставленное через Ctrl+V фото должно сразу появиться в предпросмотре.");
check(document.querySelector("#activity-report-photo-preview img")?.getAttribute("src")?.startsWith("data:image/png;base64,"),
  "Предпросмотр фото должен использовать загруженное содержимое, а не временный URL.");
await window.submitActivityReport({ preventDefault() {} });
check(requested.includes("POST /api/activity-reports"), "Форма отчёта не отправила отдельную запись.");
check(activityReportBodies[0]?.reportType === "call" && activityReportBodies[0]?.photo?.name === "report.png" &&
  !("referenceUrl" in activityReportBodies[0]),
  "Отчёт о вызове должен отправлять фото без ссылки.");
document.querySelector("#activity-report-type").value = "bail";
document.querySelector("#activity-report-type").dispatchEvent(new window.Event("change", { bubbles: true }));
check(!document.querySelector("#activity-report-reference") &&
  document.querySelector("#activity-report-form")?.textContent.includes("Нумерация будет назначена автоматически") &&
  !document.querySelector("#activity-report-photo-field")?.classList.contains("hidden") &&
  document.querySelector("#activity-report-details-field")?.classList.contains("hidden") &&
  !document.querySelector("#activity-report-photo")?.required &&
  document.querySelector("#activity-report-form")?.checkValidity(),
"Номер отчёта должен назначаться автоматически, а для залога нужны скриншот и необязательное описание.");
document.querySelector("#activity-report-date").value = "2026-01-16";
document.querySelector("#activity-report-details").value = "Залог принят и зарегистрирован.";
await window.setActivityReportPhoto(reportImage);
await window.submitActivityReport({ preventDefault() {} });
check(activityReportBodies[1]?.reportType === "bail" &&
  activityReportBodies[1]?.photo?.name === "report.png" && activityReportBodies[1]?.details === "",
  "Отчёт о залоге должен отправлять скриншот без текстового описания.");
const insertAiButton = document.querySelector('[data-action="insert-ai-facts"]');
check(insertAiButton.disabled, "Перенос документа ИИ должен быть недоступен до ответа.");
document.querySelector("#ai-lawsuit-question").value = "Меня незаконно задержали.";
const aiRequest = window.askAiAssistant("lawsuit");
await wait(0);
check(insertAiButton.disabled && insertAiButton.textContent.includes("Ожидайте") &&
  document.querySelector("#ai-lawsuit-status")?.getAttribute("aria-busy") === "true",
"Во время подготовки ответа перенос в форму должен быть отключён и показан статус ожидания.");
resolveAiAssistantResponse({
  answer: "{\"facts\":\"Я был задержан. Правовая оценка: статья 12.8 Уголовного кодекса.\"}",
  mode: "lawsuit",
  document: {
    template: "lawsuit-supreme",
    title: "Незаконное задержание",
    facts: "Я был задержан. Правовая оценка: статья 12.8 Уголовного кодекса.",
    claims: "Рассмотреть иск"
  },
  cooldownSeconds: 0
});
await aiRequest;
check(!insertAiButton.disabled && insertAiButton.textContent === "Вставить в форму" &&
  document.querySelector("#ai-lawsuit-status")?.getAttribute("aria-busy") === null,
"Перенос в форму должен стать доступен только после готового ответа ИИ.");
document.querySelector("#ai-lawsuit-question").value = "Какая статья применяется?";
const lawsuitQuestionRequest = window.askAiAssistant("lawsuit");
await wait(0);
resolveAiAssistantResponse({
  answer: "Система исков предназначена только для подготовки исковых документов. Используйте ИИ-помощник в разделе «Законодательство».",
  mode: "lawsuit",
  document: null,
  cooldownSeconds: 0
});
await lawsuitQuestionRequest;
check(insertAiButton.disabled && insertAiButton.textContent === "Только для готового иска" &&
  document.querySelector("#ai-lawsuit-answer")?.textContent.includes("разделе «Законодательство»"),
"В системе исков нельзя вставлять консультационный ответ как текст иска, вопрос направляется к консультанту по законам.");
const careerApplication = {
  id: 44,
  type: "exam",
  user_id: 2,
  stage_role: "Стажер КА",
  requested_role: "Юрист",
  status: "pending",
  display_name: "Кандидат",
  details: "Практика повышения",
  promotion_data: { lawTests: ["ak", "uk", "pk"], practiceSubmittedAt: "2026-01-15T12:00:00.000Z" },
  career_law_passed_subjects: ["ak"],
  rp_practice_cases: [{ id: "base-case", title: "Базовый кейс", completed: false }],
  rp_practice_completed_count: 0,
  rp_practice_required_count: 3,
  promotion_practice: [],
  career_requirements_complete: false
};
window.renderAppeals([careerApplication]);
const careerChecklist = document.querySelector("#appealsList .career-requirements");
check(careerChecklist?.querySelector(".career-requirement.is-complete")?.textContent.includes("Тест АК") &&
  careerChecklist?.querySelectorAll(".career-requirement.is-missing").length >= 4 &&
  !document.querySelector('[data-action="review-career-promotion"]'),
"Неполная заявка должна показывать выполненные/невыполненные пункты и не предлагать решение.");
window.renderAppeals([{
  ...careerApplication,
  career_law_passed_subjects: ["ak", "uk", "pk"],
  rp_practice_cases: [
    { id: "base-case-1", title: "Базовый кейс 1", completed: true },
    { id: "base-case-2", title: "Базовый кейс 2", completed: true },
    { id: "base-case-3", title: "Базовый кейс 3", completed: true }
  ],
  rp_practice_completed_count: 3,
  career_requirements_complete: true
}]);
check(document.querySelectorAll('[data-action="review-career-promotion"]').length === 2 &&
  document.querySelector("#appealsList .career-requirement.is-missing") === null,
"Полная заявка должна показывать все выполненные условия и действия для рассмотрения.");
const careerPracticeNav = document.querySelector("#practice-nav");
window.renderCareerPath({
  role: "Стажер КА",
  passedSubjects: [],
  allTestsPassed: false,
  completedCaseIds: [],
  requiredCaseCount: 3,
  completedEvidenceCount: 0,
  requiredEvidenceCount: 0,
  practiceSubmitted: false
});
check(!careerPracticeNav.disabled && !careerPracticeNav.classList.contains("locked") &&
  !document.querySelector('[data-action="career-path-open-ai"]'),
"Раздел карьерной практики должен открываться для просмотра, а AI Case оставаться закрытым до тестов.");
window.renderCareerPath({
  role: "Стажер КА",
  passedSubjects: ["ak", "uk", "pk"],
  allTestsPassed: true,
  completedCaseIds: [],
  requiredCaseCount: 3,
  completedEvidenceCount: 0,
  requiredEvidenceCount: 0,
  practiceSubmitted: false
});
check(!careerPracticeNav.disabled &&
  Boolean(document.querySelector('[data-action="career-path-open-ai"]')),
"После сдачи тестов переход к карьерному AI Case должен открываться.");
window.renderCareerPath({
  role: "Стажер КА",
  passedSubjects: ["ak", "uk", "pk"],
  allTestsPassed: true,
  completedCaseIds: ["case-1", "case-2", "case-3"],
  requiredCaseCount: 3,
  practiceSubmitted: false
});
check(!document.querySelector('[data-action="career-path-open-ai"]') &&
  document.querySelector("#open-rp-phone")?.disabled,
"После трёх кейсов стажёру не нужно повторно проходить или запускать AI Case.");
window.renderCareerPath({
  role: "Юрист",
  passedSubjects: [],
  allTestsPassed: true,
  lawsReviewed: true,
  completedCaseIds: [],
  requiredCaseCount: 0,
  generalRpPracticeCompletedCaseIds: [],
  generalRpPracticeRequiredCount: 18,
  completedEvidenceCount: 0,
  requiredEvidenceCount: 2,
  practiceSubmitted: false,
  lawyerPromotionPath: true,
  canRequestInterview: false,
  interviewReady: false
});
check(document.querySelector('[data-action="career-path-open-ai"]')?.textContent.includes("Открыть AI Case") &&
  !document.querySelector("#open-rp-phone")?.disabled &&
  document.querySelector("#career-path-tasks")?.textContent.includes("0/18") &&
  Boolean(document.querySelector('[data-target="general"]')),
"Юрист должен иметь постоянный доступ к AI Case и видеть прогресс ситуационных кейсов.");
window.renderCareerPath({
  role: "Юрист",
  passedSubjects: [],
  allTestsPassed: true,
  lawsReviewed: true,
  completedCaseIds: [],
  requiredCaseCount: 0,
  generalRpPracticeCompletedCaseIds: Array.from({ length: 18 }, (_, index) => `rp-${index}`),
  generalRpPracticeRequiredCount: 18,
  completedEvidenceCount: 2,
  requiredEvidenceCount: 2,
  practiceSubmitted: false,
  lawyerPromotionPath: true,
  canRequestInterview: true,
  interviewReady: false
});
check(Boolean(document.querySelector('[data-action="career-interview-ready"]')) &&
  !document.querySelector("#topbar-career-interview-ready")?.classList.contains("hidden") &&
  !document.querySelector('[data-target="submit"]'),
"После 18 кейсов и двух вызовов юристу открывается готовность к обзвону, а не обычная заявка.");
let confirmLogout = false;
window.confirm = () => confirmLogout;
await window.logout();
check(!requested.includes("POST /api/auth/logout"), "Отмена подтверждения не должна завершать сессию.");
confirmLogout = true;
await window.logout();
check(requested.includes("POST /api/auth/logout") &&
  !document.querySelector("#auth-screen")?.classList.contains("hidden"),
"Подтверждённый выход не завершил сессию.");

console.log(JSON.stringify({
  ok: problems.length === 0,
  modules: moduleFiles,
  views: views.length,
  apiCalls: requested.length,
  problems
}, null, 2));
dom.window.close();
process.exit(problems.length ? 1 : 0);
