import { $, $$, escapeHtml } from "/web/js/core/dom.js?v=20261126-2";
import {
  applicationTypes,
  lawExamSubjects,
  lawMeta,
  rpPracticeCases,
  roles
} from "/web/js/data/config.js?v=20261126-2";
import { rpInterviewCases } from "/web/js/data/rp-interviews.js?v=20261126-2";
import { rpInterviewExtraCases } from "/web/js/data/rp-interviews-extra.js?v=20261126-2";

rpInterviewCases.push(...rpInterviewExtraCases);

const managerRoles = ["ГКА", "ЗГКА"];
const promotionPracticeRanks = Object.freeze({ "Стажер КА": "Юрист", "Юрист": "Адвокат" });
const documentRoles = ["Юрист", "Адвокат", "Ст.Адвокат", ...managerRoles];
const memoItems = [
  "Представиться и проверить личность / полномочия доверителя.",
  "Уточнить причину задержания до начала процессуальных действий.",
  "Проверить наличие полноценной записи с аудио и основания обыска.",
  "Разъяснить право на молчание и один звонок до 3 минут.",
  "Организовать беседу с клиентом в отдельном помещении до 10 минут.",
  "Следить за сроком задержания: максимум 1 час; не считать допрос и ожидание.",
  "Получить показания только после разъяснения прав; фиксировать нарушения.",
  "Сохранять доказательства, тайм-коды и ссылки на видеоматериалы минимум 72 часа.",
  "Проверить применимые нормы УК, АК, ПК и процессуальные сроки.",
  "Не давать обещаний по исходу и не публиковать детали дела.",
  "Согласовать жалобу, иск или ходатайство с доверителем.",
  "При конфликте интересов сообщить о конфликте и передать дело."
];
const statusNames = {
  pending: "Ожидает рассмотрения",
  approved: "Одобрено",
  rejected: "Отклонено",
  submitted: "Подано",
  in_review: "На рассмотрении",
  hearing: "Назначено слушание",
  decided: "Решение внесено",
  active: "Активен",
  suspended: "Приостановлен"
};
const statusIconNames = {
  pending: "32_pending_clock",
  submitted: "32_pending_clock",
  in_review: "32_pending_clock",
  hearing: "32_pending_clock",
  approved: "17_check_approved",
  decided: "17_check_approved",
  active: "17_check_approved",
  rejected: "31_rejected_declined",
  suspended: "33_warning_alert"
};
const reportMetrics = [
  ["documentsCreated", "Создано документов"],
  ["documentsApproved", "Одобрено документов"],
  ["lawsuitsFiled", "Опубликовано исков"],
  ["callsReported", "Одобрено отчётов о вызовах"],
  ["bailReports", "Одобрено отчётов о залогах"],
  ["casesTaken", "Принято обращений"],
  ["casesClosed", "Закрыто обращений"],
  ["examsPassed", "Сдано экзаменов"],
  ["attestationsPassed", "Пройдены аттестации"],
  ["reprimands", "Выговоры"]
];

let currentUser = null;
let csrfToken = "";
let toastTimer = 0;
let quizSession = null;
let rpPracticeLevel = null;
let rpPracticeCompleted = new Set();
let rpPracticeFeedback = new Map();
let rpPhoneSession = null;
let rpPhoneAnswerPending = false;
let rpPhoneReturnFocus = null;
let rpPhoneSoundEnabled = true;
let rpPhoneAudioContext = null;
let rpPhoneCustomCases = [];
let rpCareerPracticeProgress = null;
let careerPathState = null;
let careerOfferPromptActive = false;
let careerOfferApplicationId = 0;
let activeStampDrag = null;
let lawExamJustPassed = "";
let loadedLaws = [];
let photozotPhotos = [];
let activePhotozotGroup = "";
let activityReportPhoto = null;
let activityReportPhotoUrl = "";
let activityReportPhotoRequest = 0;
let photoViewerReturnFocus = null;
let currentView = "dashboard";
let auditMembers = [];
let auditReprimandCounts = new Map();
let promotionPracticeState = null;
let promotionDecreeState = null;
let discordDmEnabled = true;
let discordSettings = null;
let aiLawsAnswer = "";
let aiLawsuitAnswer = "";
let aiGeneratedLawsuitDocument = null;
let aiCooldownTimer = null;
let aiCooldownSeconds = 0;
const activityReportLabels = {
  call: "Вызов",
  bail: "Залог"
};
const viewPaths = {
  dashboard: "/page/home",
  career: "/page/career",
  memo: "/page/memo",
  appeals: "/page/appeals",
  lawsuits: "/page/iski",
  tests: "/page/exams",
  practice: "/page/practice",
  laws: "/page/laws",
  rating: "/page/rating",
  audit: "/page/audit",
  decrees: "/page/decrees",
  awards: "/page/awards",
  giveaway: "/page/giveaway",
  reports: "/page/reports"
};
const viewsByPath = new Map(Object.entries(viewPaths).map(([name, path]) => [path, name]));

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (csrfToken && !["GET", "HEAD"].includes(method)) headers["x-csrf-token"] = csrfToken;
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status}).`);
  return data;
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3800);
}

function formatAiAnswer(text) {
  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .replace(/(?:^|\n)\s*#{2,6}\s*/g, "\n")
    .replace(/^[ \t]+/gm, "")
    .trim();
  if (!normalized) return "";

  const blocks = normalized.split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return "";

    const hasOnlyListItems = lines.every((line) => /^(?:[-*•]|[-*•]\s+)\s*/.test(line));
    if (hasOnlyListItems) {
      return `<ul>${lines.map((line) =>
        `<li>${formatAiInline(escapeHtml(line.replace(/^[-*•]\s*/, "").trim()))}</li>`
      ).join("")}</ul>`;
    }

    const numbered = lines.every((line) => /^\d+[.)]\s+/.test(line));
    if (numbered) {
      return `<ol>${lines.map((line) =>
        `<li>${formatAiInline(escapeHtml(line.replace(/^\d+[.)]\s*/, "").trim()))}</li>`
      ).join("")}</ol>`;
    }

    return lines.map((line) => {
      if (/^[-*•]\s/.test(line)) {
        return `<p class="ai-answer-bullet">${formatAiInline(escapeHtml(line.replace(/^[-*•]\s*/, "").trim()))}</p>`;
      }
      if (/^\d+[.)]\s/.test(line)) {
        return `<p class="ai-answer-step">${formatAiInline(escapeHtml(line.trim()))}</p>`;
      }
      if (/^[A-ZА-ЯЁ][^.!?]{2,80}:$/.test(line) || /^(?:Правовой анализ|Практический ответ|Применимые нормы|Требования)$/iu.test(line)) {
        return `<h4>${formatAiInline(escapeHtml(line))}</h4>`;
      }
      return `<p>${formatAiInline(escapeHtml(line))}</p>`;
    }).join("");
  }).join("");
}

function formatAiInline(text) {
  return text
    .replace(/\*\*\s*(.*?)\s*\*\*/g, "<strong>$1</strong>")
    .replace(/__\s*(.*?)\s*__/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function setAiCooldown(seconds) {
  aiCooldownSeconds = Number(seconds || 60);
  window.clearInterval(aiCooldownTimer);
  $$("[data-action='ask-ai-laws'], [data-action='ask-ai-lawsuit']").forEach((button) => {
    button.disabled = true;
  });
  const update = () => {
    $$("[data-action='ask-ai-laws'], [data-action='ask-ai-lawsuit']").forEach((button) => {
      const lawsuit = button.dataset.action === "ask-ai-lawsuit";
      button.innerHTML = `<span class="ai-cooldown-ring"></span><span>Повтор через ${aiCooldownSeconds} сек.</span>`;
      button.setAttribute("aria-label", `Повторный запрос доступен через ${aiCooldownSeconds} секунд`);
      if (aiCooldownSeconds <= 0) {
        button.disabled = false;
        button.innerHTML = lawsuit
          ? '<svg class="icon icon-sm"><use href="/web/icons-sprite.svg#icon-23_motion_petition"></use></svg> Составить иск'
          : '<svg class="icon icon-sm"><use href="/web/icons-sprite.svg#icon-15_search_archive"></use></svg> Получить ответ';
        button.removeAttribute("aria-label");
      }
    });
    if (aiCooldownSeconds <= 0) {
      window.clearInterval(aiCooldownTimer);
      aiCooldownTimer = null;
      return;
    }
    aiCooldownSeconds -= 1;
  };
  update();
  aiCooldownTimer = window.setInterval(update, 1000);
}

async function askAiAssistant(mode) {
  const lawsuit = mode === "lawsuit";
  const question = $(lawsuit ? "#ai-lawsuit-question" : "#ai-laws-question").value.trim();
  const status = $(lawsuit ? "#ai-lawsuit-status" : "#ai-laws-status");
  const answerNode = $(lawsuit ? "#ai-lawsuit-answer" : "#ai-laws-answer");
  const copyButton = $(`[data-action="${lawsuit ? "copy-ai-lawsuit" : "copy-ai-laws"}"]`);
  if (question.length < 3) {
    notify("Опишите ситуацию или задайте юридический вопрос.");
    $(lawsuit ? "#ai-lawsuit-question" : "#ai-laws-question").focus();
    return;
  }
  const insertButton = lawsuit ? $(`[data-action="insert-ai-facts"]`) : null;
  if (lawsuit) {
    aiGeneratedLawsuitDocument = null;
    aiLawsuitAnswer = "";
    insertButton.disabled = true;
    insertButton.textContent = "Ожидайте ответ ИИ…";
  }
  status.className = "ai-assistant-status is-loading";
  status.textContent = lawsuit
    ? "Готовлю проект иска по описанным обстоятельствам…"
    : "Анализирую весь комплект законов штата и формирую практический ответ. Сложный запрос может занять больше времени…";
  status.classList.remove("hidden");
  status.setAttribute("aria-busy", "true");
  answerNode.classList.add("hidden");
  copyButton.disabled = true;
  const submitButton = $(`[data-action="${lawsuit ? "ask-ai-lawsuit" : "ask-ai-laws"}"]`);
  submitButton.disabled = true;
  try {
    const data = await api("/api/ai-assistant", {
      method: "POST",
      body: { question, mode }
    });
    const answer = data.answer || "";
    if (Number(data.cooldownSeconds) > 0) setAiCooldown(data.cooldownSeconds);
    else submitButton.disabled = false;
    if (lawsuit) {
      aiGeneratedLawsuitDocument = data.document || null;
      const generated = Boolean(aiGeneratedLawsuitDocument);
      aiLawsuitAnswer = data.document?.facts
        ? `${data.document.facts}${data.document.claims ? `\n\nТребования:\n${data.document.claims}` : ""}`
        : "";
      if (generated) {
        const courtName = data.document.template.includes("supreme")
          ? "Верховный суд"
          : data.document.template.includes("federal")
            ? "Окружной суд"
            : "Подходящая форма документа";
        answerNode.innerHTML = `<h4>Документ подготовлен</h4><p>ИИ выбрал: <strong>${escapeHtml(courtName)}</strong>. Нажмите «Вставить в форму», чтобы перенести описательную часть, требования и известные данные в конструктор.</p>`;
      } else {
        answerNode.innerHTML = formatAiAnswer(answer);
      }
    } else {
      aiLawsAnswer = answer;
      answerNode.innerHTML = formatAiAnswer(answer);
    }
    answerNode.classList.remove("hidden");
    window.requestAnimationFrame(() => {
      answerNode.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    status.className = "ai-assistant-status";
    status.textContent = lawsuit
      ? aiGeneratedLawsuitDocument
        ? "Проект иска подготовлен. Проверьте все сведения перед подачей."
        : "Система исков составляет только иски. Для вопросов о законах используйте консультанта в разделе «Законодательство»."
      : "Ответ подготовлен ИИ на основе загруженной базы. Перед подачей проверьте нормы с руководством.";
    status.removeAttribute("aria-busy");
    copyButton.disabled = false;
    if (insertButton) {
      insertButton.disabled = !aiGeneratedLawsuitDocument;
      insertButton.textContent = aiGeneratedLawsuitDocument ? "Вставить в форму" : "Только для готового иска";
    }
  } catch (error) {
    status.className = "ai-assistant-status";
    status.textContent = error.message;
    status.removeAttribute("aria-busy");
    if (insertButton) insertButton.textContent = "Ответ не получен";
    submitButton.disabled = false;
  }
}

async function copyAiAnswer(answer) {
  await navigator.clipboard.writeText(answer);
  notify("Ответ ИИ скопирован.");
}

function applyGeneratedLawsuitDocument(document) {
  if (!document || typeof document !== "object") return false;
  const template = $("#lawsuit-template");
  const form = $("#lawsuit-form");
  const allowed = new Set([
    "lawsuit-supreme",
    "lawsuit-federal",
    "motion-supreme",
    "motion-federal",
    "rehabilitation",
    "appeal"
  ]);
  template.value = allowed.has(document.template) ? document.template : "lawsuit-supreme";
  renderLawsuitFields();

  $("#lawsuit-title").value = String(document.title || "").slice(0, 150);
  Object.entries(document).forEach(([key, value]) => {
    if (key === "template" || key === "title") return;
    const field = $(`[data-lawsuit-field="${key}"]`);
    if (!field) return;
    field.value = key === "filingDate" && !value
      ? ""
      : String(value || "");
  });
  renderLawsuitPreview();
  form.classList.remove("hidden");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  notify("ИИ подготовил документ. Все поля можно изменить вручную.");
  return true;
}

function insertAiLawsuitFacts() {
  if (!aiGeneratedLawsuitDocument) return;
  applyGeneratedLawsuitDocument(aiGeneratedLawsuitDocument);
}

function formatNotificationDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function localDateValue(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function loadNotifications() {
  const data = await api("/api/notifications");
  discordDmEnabled = Boolean(data.discordDmEnabled);
  renderDiscordPreferenceButton();
  const count = Number(data.unreadCount || 0);
  const badge = $("#notification-count");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.classList.toggle("hidden", count === 0);
  const notifications = data.notifications || [];
  $("#notification-list").innerHTML = notifications.length
    ? notifications.map((item) => `
      <button class="notification-item${item.read_at ? "" : " unread"}" type="button"
        data-action="open-notification" data-id="${Number(item.id)}" data-href="${escapeHtml(item.href || "")}">
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.body)}</p>
        ${item.discord_error ? `<small class="notification-delivery-error">Discord: ${escapeHtml(item.discord_error)}</small>` : ""}
        <small>${escapeHtml(formatNotificationDate(item.created_at))}</small>
      </button>`).join("")
    : `<div class="notification-empty">Новых уведомлений пока нет.</div>`;
}

async function toggleNotifications(button) {
  const panel = $("#notification-panel");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  button.setAttribute("aria-expanded", String(opening));
  if (opening) await loadNotifications();
}

async function readAllNotifications() {
  await api("/api/notifications/read-all", { method: "POST", body: {} });
  await loadNotifications();
}

async function openNotification(button) {
  const href = button.dataset.href;
  await api(`/api/notifications/${encodeURIComponent(button.dataset.id)}/read`, {
    method: "PATCH",
    body: {}
  });
  $("#notification-panel").classList.add("hidden");
  $("#notification-toggle")?.setAttribute("aria-expanded", "false");
  await loadNotifications();
  if (href && href.startsWith("/page/")) window.location.assign(href);
}

function roleName(user) {
  return user.role === "Гражданин" ? "Гражданин" : user.role;
}

function displayRole(user) {
  const names = {
    "ГКА": "Глава Коллегии (ГКА)",
    "ЗГКА": "Зам. Главы Коллегии (ЗГКА)",
    "Ст.Адвокат": "Старший адвокат",
    "Адвокат": "Адвокат",
    "Юрист": "Юрист",
    "Гражданин": "Гражданин"
  };
  if (user.role === "ЗГКА" && user.hasFullGkaAccess) {
    return "Зам. Главы Коллегии (ЗГКА [A])";
  }
  return names[user.role] || roleName(user);
}

function userInitials(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase("ru-RU")).join("") || "—";
}

function renderUserAvatar(element, user) {
  const initials = userInitials(user.displayName);
  const avatarUrl = String(user.discordAvatarUrl || "");
  const isDiscordCdnUrl = /^https:\/\/cdn\.discordapp\.com\/(?:avatars\/\d+\/[\w-]+\.(?:png|gif|webp)|embed\/avatars\/\d+\.png)(?:\?size=\d{2,4})?$/.test(avatarUrl);
  if (!isDiscordCdnUrl) {
    element.textContent = initials;
    return;
  }
  const image = document.createElement("img");
  image.src = avatarUrl;
  image.alt = "";
  image.decoding = "async";
  image.addEventListener("error", () => {
    element.textContent = initials;
  }, { once: true });
  element.replaceChildren(image);
}

function displayDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "—";
}

function isManager() {
  return managerRoles.includes(currentUser?.role);
}

function canUseDocuments() {
  return documentRoles.includes(currentUser?.role);
}

function setHidden(selector, hidden) {
  $$(selector).forEach((element) => element.classList.toggle("hidden", hidden));
}

function applyRoleVisibility() {
  const citizen = currentUser.role === "Гражданин";
  const manager = isManager();
  const hasPractice = currentUser.role !== "Гражданин";
  const careerPathRole = Object.hasOwn(promotionPracticeRanks, currentUser.role);
  setHidden(".staff-only", citizen);
  setHidden(".citizen-only", !citizen);
  setHidden(".manager-only", !manager);
  setHidden(".head-only", currentUser.role !== "ГКА" && !currentUser.hasFullGkaAccess);
  setHidden(".document-only", !canUseDocuments());
  setHidden(".practice-only", !hasPractice);
  setHidden(".career-path-only", !careerPathRole);
  setHidden(".career-general-practice-only", careerPathRole);
  const practiceNav = $("#practice-nav");
  const practiceLocked = !hasPractice || careerPathRole;
  practiceNav.disabled = practiceLocked;
  practiceNav.classList.toggle("locked", practiceLocked);
  practiceNav.setAttribute("aria-disabled", String(practiceLocked));
  if (hasPractice) practiceNav.dataset.view = "practice";
  else practiceNav.removeAttribute("data-view");
  if (careerPathRole) $("#open-rp-phone").disabled = true;
  $("#practice-nav-label").textContent = careerPathRole ? "Карьерная практика" : "Практика РП";
  careerPathState = null;
  updateActivityReportFields();
  $("#appeals-list-card").classList.toggle("col-span-8", citizen);
  $("#appeals-list-card").classList.toggle("col-span-12", !citizen);
  $("#active-user-name").textContent = currentUser.displayName;
  $("#active-user-role").textContent = displayRole(currentUser);
  $("#access-role").textContent = displayRole(currentUser);
  renderUserAvatar($("#user-avatar"), currentUser);
  $("#welcome-name").textContent = currentUser.displayName;
  $("#welcome-role").textContent = displayRole(currentUser);
  renderUserAvatar($("#welcome-avatar"), currentUser);
  $("#login-open").classList.add("hidden");
  $("#logout-button").classList.remove("hidden");

}

function showAuth(message = "") {
  currentUser = null;
  $("#session-loading").classList.add("hidden");
  $("#app-shell").classList.add("hidden");
  $("#pending-screen").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  $("#auth-error").textContent = message;
  $("#login-open").classList.remove("hidden");
  $("#logout-button").classList.add("hidden");
}

async function enterSession(session) {
  currentUser = session.user;
  csrfToken = session.csrfToken || "";
  if (!currentUser) {
    showAuth();
    return;
  }
  if (currentUser.status !== "active") {
    $("#session-loading").classList.add("hidden");
    $("#auth-screen").classList.add("hidden");
    $("#app-shell").classList.add("hidden");
    $("#pending-screen").classList.remove("hidden");
    $("#pending-message").textContent = currentUser.status === "pending"
      ? "Регистрация прошла успешно. Доступ сотрудника будет открыт после решения руководства."
      : "Доступ к аккаунту приостановлен. Обратитесь к руководству коллегии.";
    return;
  }
  $("#session-loading").classList.add("hidden");
  $("#auth-screen").classList.add("hidden");
  $("#pending-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  applyRoleVisibility();
  if (Object.hasOwn(promotionPracticeRanks, currentUser.role)) {
    try {
      await loadCareerPath({ showIntro: false });
    } catch (error) {
      notify(`Не удалось загрузить прогресс карьерного пути: ${error.message}`);
    }
  }
  const requestedView = viewsByPath.get(window.location.pathname) || "dashboard";
  await navigate(viewIsAllowed(requestedView) ? requestedView : "dashboard");
  try {
    await loadNotifications();
  } catch (error) {
    notify(`Не удалось загрузить уведомления: ${error.message}`);
  }
  const discordResult = new URLSearchParams(window.location.search).get("discord");
  if (discordResult) {
    window.history.replaceState(null, "", window.location.pathname);
    notify(discordResult === "linked" ? "Discord успешно привязан." : "Не удалось привязать Discord.");
  }
}

function authMode(mode) {
  const register = mode === "register";
  $("#login-form").classList.toggle("hidden", register);
  $("#register-form").classList.toggle("hidden", !register);
  $("#show-login").classList.toggle("btn-gold", !register);
  $("#show-register").classList.toggle("btn-gold", register);
  $("#auth-error").textContent = "";
}

function statusBadge(status) {
  const icon = statusIconNames[status];
  return `<span class="status-pill">${icon
    ? `<svg class="icon icon-sm" aria-hidden="true"><use href="/web/icons-sprite.svg#icon-${icon}"></use></svg>`
    : ""}<span>${escapeHtml(statusNames[status] || status || "—")}</span></span>`;
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function openModal(title, content, purpose = "") {
  const dialog = $("#document-dialog");
  dialog.dataset.purpose = purpose;
  dialog.querySelector(".modal-card").classList.toggle("career-intro-modal", purpose === "career-path-intro");
  $("#document-dialog-title").textContent = title;
  $("#document-dialog-body").innerHTML = content;
  dialog.classList.remove("hidden");
}

function closeModal() {
  const dialog = $("#document-dialog");
  dialog.classList.add("hidden");
  dialog.dataset.purpose = "";
  dialog.querySelector(".modal-card").classList.remove("career-intro-modal");
}

function openPhotoViewer(url, label, trigger) {
  photoViewerReturnFocus = trigger || document.activeElement;
  const image = $("#photo-viewer-image");
  image.src = url;
  image.alt = label;
  $("#photo-viewer-caption").textContent = label;
  $("#photo-viewer").classList.remove("hidden");
  document.body.classList.add("photo-viewer-open");
  $("#photo-viewer-close").focus();
}

function closePhotoViewer() {
  $("#photo-viewer").classList.add("hidden");
  $("#photo-viewer-image").removeAttribute("src");
  $("#photo-viewer-caption").textContent = "";
  document.body.classList.remove("photo-viewer-open");
  const returnFocus = photoViewerReturnFocus;
  photoViewerReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function viewIsAllowed(name) {
  const section = $(`#view-${name}`);
  return Boolean(section && !section.classList.contains("hidden"));
}

async function navigate(name) {
  if (!currentUser || !viewIsAllowed(name)) {
    notify("Этот раздел недоступен для вашей роли.");
    return;
  }
  currentView = name;
  $$(".page-view").forEach((section) => section.classList.toggle("active", section.id === `view-${name}`));
  $$("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  const loaders = {
    dashboard: loadDashboard,
    career: loadCareerPath,
    lawsuits: loadLawsuits,
    appeals: loadAppeals,
    laws: loadLaws,
    tests: loadTests,
    practice: loadRpPractice,
    memo: renderMemo,
    awards: loadAwards,
    rating: loadRating,
    audit: loadAudit,
    decrees: loadPromotionDecrees,
    giveaway: loadGiveaway,
    reports: loadReports
  };
  try {
    await loaders[name]?.();
  } catch (error) {
    notify(error.message);
  }
}

function careerPathTaskMarkup(task, index) {
  const stateClass = task.done ? "is-complete" : task.locked ? "is-locked" : "is-current";
  const status = task.done ? "Выполнено" : task.locked ? "Закрыто" : "Текущий шаг";
  return `<article class="career-path-task ${stateClass}">
    <span class="career-path-task-number">${String(index + 1).padStart(2, "0")}</span>
    <div class="career-path-task-copy">
      <strong>${escapeHtml(task.title)}</strong>
      <small>${escapeHtml(task.description)}</small>
    </div>
    <div class="career-path-task-actions">
      <span class="career-path-task-status">${status}</span>
      ${task.action || ""}
    </div>
  </article>`;
}

function renderCareerPath(data) {
  careerPathState = data;
  const role = data.role;
  const passedSubjects = new Set(data.passedSubjects || []);
  const allTestsPassed = Boolean(data.allTestsPassed);
  const lawsReady = role !== "Юрист" || Boolean(data.lawsReviewed);
  const completedCases = (data.completedCaseIds || []).length;
  const requiredCases = Number(data.requiredCaseCount || (role === "Юрист" ? 3 : 1));
  const casesReady = completedCases >= requiredCases;
  const callsReady = Number(data.completedEvidenceCount || 0) >= Number(data.requiredEvidenceCount || 0);
  const practiceSubmitted = Boolean(data.practiceSubmitted);
  const tasks = [];

  if (role === "Юрист") {
    tasks.push({
      title: "Изучить законодательство",
      description: "Откройте базу законов, изучите нужные материалы, затем вернитесь сюда и подтвердите шаг.",
      done: lawsReady,
      locked: false,
      action: lawsReady ? "" : `<button class="btn" type="button" data-view="laws">Открыть законы</button>
        <button class="btn btn-gold" type="button" data-action="career-path-study">Изучил · продолжить</button>`
    });
  }

  const examLabels = { ak: "АК", uk: "УК", pk: "ПК" };
  const examDescriptions = {
    ak: "Первый тест этапа. После успешной сдачи откроется следующий.",
    uk: "Откроется после сдачи АК.",
    pk: "Последний тест по кодексам. Откроется после сдачи УК."
  };
  for (const [index, subject] of ["ak", "uk", "pk"].entries()) {
    const done = passedSubjects.has(subject);
    const priorPassed = index === 0 || passedSubjects.has(["ak", "uk", "pk"][index - 1]);
    const available = lawsReady && !done && priorPassed;
    tasks.push({
      title: `Сдать тест ${examLabels[subject]}`,
      description: examDescriptions[subject],
      done,
      locked: !done && !available,
      action: available
        ? `<button class="btn btn-gold" type="button" data-action="career-path-open-view" data-target="tests">Перейти к тесту</button>`
        : ""
    });
  }

  tasks.push({
    title: `Пройти базовые AI Case · ${completedCases}/${requiredCases}`,
    description: role === "Стажер КА"
      ? "Достаточно успешно пройти один базовый диалог с сотрудником."
      : "Пройдите три базовых диалога, чтобы перейти к подтверждениям совместных вызовов.",
    done: casesReady,
    locked: !allTestsPassed || !lawsReady,
    action: allTestsPassed && lawsReady && !casesReady
      ? `<button class="btn btn-gold" type="button" data-action="career-path-open-ai">Открыть AI Case</button>`
      : ""
  });

  if (role === "Юрист") {
    tasks.push({
      title: `Подтвердить совместные вызовы · ${Number(data.completedEvidenceCount || 0)}/${Number(data.requiredEvidenceCount || 2)}`,
      description: "Добавьте два подтверждения совместных вызовов с адвокатом. Этот этап откроется после AI Case.",
      done: callsReady,
      locked: !casesReady,
      action: casesReady && !callsReady
        ? `<button class="btn btn-gold" type="button" data-action="career-path-open-practice" data-target="slots">Перейти к подтверждениям</button>`
        : ""
    });
  }

  const canSubmit = casesReady && callsReady;
  tasks.push({
    title: role === "Стажер КА" ? "Подать заявку на повышение до юриста" : "Подать заявку на повышение до адвоката",
    description: practiceSubmitted
      ? "Заявка отправлена. Дождитесь решения ГКА или ЗГКА — роль изменится только после одобрения."
      : "Проверьте итоговые условия и подтвердите отправку заявки. До решения руководства текущая роль не изменится.",
    done: practiceSubmitted,
    locked: !canSubmit,
    action: canSubmit && !practiceSubmitted
      ? `<button class="btn btn-gold" type="button" data-action="career-path-open-practice" data-target="submit">Проверить и отправить</button>`
      : ""
  });

  const completedCount = tasks.filter((task) => task.done).length;
  const percent = tasks.length ? Math.round((completedCount / tasks.length) * 100) : 0;
  $("#career-path-role").textContent = role;
  $("#career-path-summary").textContent = role === "Стажер КА"
    ? "Проходите экзамены и базовую практику по порядку. После выполнения требований отправьте заявку на повышение."
    : "Сначала изучите законодательство, затем последовательно выполните задания этапа юриста.";
  $("#career-path-progress-bar").style.width = `${percent}%`;
  $("#career-path-progress-label").textContent = `${completedCount} из ${tasks.length} этапов выполнено`;
  $("#career-path-tasks").innerHTML = tasks.map(careerPathTaskMarkup).join("");
  const openAi = $("#open-rp-phone");
  if (openAi) openAi.disabled = !allTestsPassed || !lawsReady || casesReady;
  const practiceNav = $("#practice-nav");
  if (practiceNav && Object.hasOwn(promotionPracticeRanks, role)) {
    const practiceAvailable = allTestsPassed && lawsReady &&
      (!casesReady || (role === "Юрист" && !callsReady) || !practiceSubmitted);
    practiceNav.disabled = !practiceAvailable;
    practiceNav.classList.toggle("locked", !practiceAvailable);
    practiceNav.setAttribute("aria-disabled", String(!practiceAvailable));
  }
}

async function loadCareerPath({ showIntro = true } = {}) {
  if (!Object.hasOwn(promotionPracticeRanks, currentUser.role)) return;
  let data = await api("/api/career-path");
  if (!data.started) {
    await api("/api/career-path/start", { method: "POST", body: {} });
    data = await api("/api/career-path");
  }
  renderCareerPath(data);
  if (showIntro && !data.tutorialSeen) showCareerPathIntro(data);
}

function showCareerPathIntro(data) {
  const lawyer = data.role === "Юрист";
  const steps = lawyer
    ? ["Изучить законы", "Тесты АК · УК · ПК", "3 базовых AI Case", "2 совместных вызова"]
    : ["Тест АК", "Тест УК", "Тест ПК", "1 базовый AI Case"];
  openModal("Ваш карьерный путь", `<div class="career-intro-content">
      <div class="career-intro-heading">
        <span class="career-intro-icon" aria-hidden="true">✦</span>
        <div>
          <span class="career-intro-eyebrow">ПЕРСОНАЛЬНЫЙ МАРШРУТ · ${escapeHtml(data.role)}</span>
          <h3>${lawyer ? "Новый этап — юрист" : "Начните путь стажёра"}</h3>
        </div>
      </div>
      <p class="career-intro-copy">${lawyer
        ? "Изучите законодательство, затем возвращайтесь к маршруту и проходите задания по порядку."
        : "Ваши задания открываются по очереди. Выполните текущий шаг — следующий появится автоматически."}</p>
      <ol class="career-intro-steps">${steps.map((step, index) => `<li>
        <span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(step)}</strong>
      </li>`).join("")}</ol>
      <div class="career-intro-actions">
        <button class="btn btn-gold" type="button" data-action="career-path-intro">Показать мой путь <span aria-hidden="true">→</span></button>
        <button class="btn btn-outline" type="button" data-action="career-path-dismiss">Позже</button>
      </div>
      <small class="career-intro-note">Путь всегда можно открыть с главной страницы или из меню «Начало пути».</small>
    </div>`, "career-path-intro");
}

async function startCareerPath() {
  await api("/api/career-path/start", { method: "POST", body: {} });
  const data = await api("/api/career-path");
  if (!data.tutorialSeen) {
    showCareerPathIntro(data);
    return;
  }
  await navigate("career");
}

async function continueCareerPathIntro() {
  await api("/api/career-path/tutorial-seen", { method: "POST", body: {} });
  closeModal();
  await navigate("career");
}

async function dismissCareerPathIntro() {
  await api("/api/career-path/tutorial-seen", { method: "POST", body: {} });
  closeModal();
  if (careerPathState) careerPathState.tutorialSeen = true;
  await navigate("dashboard");
  window.history.replaceState(null, "", viewPaths.dashboard);
}

async function completeCareerPathStudy() {
  await api("/api/career-path/study", { method: "POST", body: {} });
  notify("Шаг изучения законодательства отмечен. Открыты тесты по порядку.");
  await loadCareerPath({ showIntro: false });
  await navigate("tests");
}

async function openCareerPathView(button) {
  const target = button.dataset.target;
  await navigate(target);
}

async function openCareerPathPractice(button) {
  await navigate("practice");
  const target = button.dataset.target === "slots" ? "#promotion-practice-panel" : "#submit-promotion-practice";
  $(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function openCareerPathAi() {
  await navigate("practice");
  await openRpPhone();
}

async function loadDashboard() {
  const [profileData, applicationData, lawsuitData, analyticsData] = await Promise.all([
    api("/api/profile"),
    api("/api/applications"),
    canUseDocuments() ? api("/api/lawsuits") : Promise.resolve({ lawsuits: [] }),
    isManager() ? api("/api/analytics?period=7") : Promise.resolve(null)
  ]);
  const profile = profileData.profile;
  const openApplications = applicationData.applications.filter((item) =>
    ["citizen_help", "citizen_complaint"].includes(item.type) && !item.completed_at);
  const openLawsuits = lawsuitData.lawsuits.filter((item) => !["decided", "rejected"].includes(item.status));
  $("#welcome-member-since").textContent = displayDate(profile.member_since || profile.created_at);
  $("#welcome-calls").textContent = String(profile.approved_call_count || 0);
  $("#welcome-lawsuits").textContent = String(openLawsuits.length);
  $("#welcome-appeals").textContent = String(openApplications.length);
  $("#kpiLawsuits").textContent = String(openLawsuits.length);
  $("#kpiAppeals").textContent = String(openApplications.length);
  $("#nav-appeals-count").textContent = String(openApplications.length);
  $("#nav-lawsuits-count").textContent = String(openLawsuits.length);
  const openHelp = openApplications.filter((item) => item.type === "citizen_help").length;
  const openComplaints = openApplications.filter((item) => item.type === "citizen_complaint").length;
  $("#kpiAppealsNote").textContent = `${openHelp} помощи · ${openComplaints} жалоб`;
  if (analyticsData) {
    const activity = (analyticsData.trend || []).reduce((total, point) =>
      total + Number(point.documents || 0) + Number(point.lawsuits || 0) + Number(point.requests || 0), 0);
    $("#kpiActivityTitle").textContent = "Активность за 7 дней";
    $("#kpiActivityNote").textContent = "Документы, иски и обращения";
    $("#kpiCalls").textContent = String(activity);
  } else {
    $("#kpiActivityTitle").textContent = "Подтверждённые вызовы";
    $("#kpiActivityNote").textContent = "По вашему профилю";
    $("#kpiCalls").textContent = String(profile.approved_call_count || 0);
  }
  try {
    const attorneyData = await api("/api/attorneys?period=week");
    $("#kpiStaff").textContent = String((attorneyData.attorneys || []).length);
    renderDashboardAttorneys(attorneyData.attorneys || []);
  } catch (error) {
    $("#kpiStaff").textContent = "—";
    $("#dashboard-attorneys").innerHTML =
      `<p class="text-muted">Не удалось загрузить рейтинг адвокатов: ${escapeHtml(error.message)}</p>`;
  }
  showNetworkNoticeIfDue();
}

function showNetworkNoticeIfDue() {
  const notice = $("#network-notice");
  if (notice.open) return;
  const storageKey = `portal-network-notice:${currentUser.id}`;
  const lastShown = Number(localStorage.getItem(storageKey) || 0);
  const now = Date.now();
  if (Number.isFinite(lastShown) && now - lastShown < 60 * 60 * 1000) return;
  notice.showModal();
  localStorage.setItem(storageKey, String(now));
}

function renderDashboardAttorneys(attorneys) {
  const topAttorneys = attorneys.slice(0, 3);
  const rankAvatars = [
    "/assets/role-senior-attorney.png",
    "/assets/role-attorney.png",
    "/assets/role-lawyer.png"
  ];
  $("#dashboard-attorneys").innerHTML = topAttorneys.length ? topAttorneys.map((attorney, index) => {
    const citizen = currentUser.role === "Гражданин";
    const rating = Number(attorney.average_rating || 0);
    const avatar = `<img src="${rankAvatars[index]}" alt="">`;
    const action = citizen
      ? `<button class="attorney-action" type="button" data-action="select-attorney" data-id="${Number(attorney.id)}">Выбрать адвоката <span aria-hidden="true">→</span></button>`
      : `<button class="attorney-action" type="button" data-action="attorney-profile" data-id="${Number(attorney.id)}">Профиль адвоката <span aria-hidden="true">→</span></button>`;
    return `<article class="attorney-card">
      <div class="attorney-card-top">
        <span class="attorney-rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="attorney-rating"><svg class="icon icon-sm"><use href="/web/icons-sprite.svg#icon-07_top_lawyers"></use></svg>${rating ? `${rating.toFixed(1)} / 5` : "Нет отзывов"}</span>
      </div>
      <div class="attorney-identity">
        <span class="attorney-avatar">${avatar}</span>
        <span><strong>${escapeHtml(attorney.display_name)}</strong><small>${escapeHtml(attorney.role)}</small></span>
      </div>
      <div class="attorney-stats">
        <span><small>Вызовы</small><strong>${Number(attorney.calls || 0)}</strong></span>
        <span><small>Залоги</small><strong>${Number(attorney.bails || 0)}</strong></span>
        <span><small>Иски</small><strong>${Number(attorney.lawsuit_count || 0)}</strong></span>
      </div>
      ${action}
    </article>`;
  }).join("") : emptyState("Адвокаты пока не появились в рейтинге.");
}

async function selectAttorney(id) {
  await navigate("appeals");
  const lawyerSelect = $("#appealLawyer");
  if (!lawyerSelect || ![...lawyerSelect.options].some((option) => option.value === String(id))) {
    notify("Не удалось выбрать адвоката. Обновите список и попробуйте ещё раз.");
    return;
  }
  lawyerSelect.value = String(id);
}

async function viewAttorneyProfile(id) {
  const data = await api(`/api/profiles/${Number(id)}`);
  const profile = data.profile;
  const rating = Number(profile.average_rating || 0);
  const reviews = (data.reviews || []).map((review) =>
    `<article class="profile-review"><strong>${Number(review.rating)}/5 · ${escapeHtml(review.created_at || "")}</strong><p>${escapeHtml(review.comment || "Без комментария")}</p></article>`
  ).join("");
  openModal(profile.display_name, `<div class="attorney-profile-summary">
    <span class="attorney-avatar">${escapeHtml(userInitials(profile.display_name))}</span>
    <div><strong>${escapeHtml(profile.role)}</strong><p>${escapeHtml(profile.profile_bio || "Описание профиля не заполнено.")}</p></div>
  </div>
  <div class="report-summary">
    <div><strong>${rating ? `${rating.toFixed(1)} / 5` : "Нет оценок"}</strong><span>Средняя оценка</span></div>
    <div><strong>${Number(profile.review_count || 0)}</strong><span>Отзывы</span></div>
    <div><strong>${Number(profile.closed_case_count || 0)}</strong><span>Закрытые обращения</span></div>
    <div><strong>${Number(profile.lawsuit_count || 0)}</strong><span>Опубликованные иски</span></div>
    <div><strong>${Number(profile.approved_call_count || 0)}</strong><span>Одобренные вызовы · за всё время</span></div>
    <div><strong>${Number(profile.approved_bail_count || 0)}</strong><span>Одобренные залоги · за всё время</span></div>
  </div>
  <h3 class="profile-reviews-title">Последние отзывы</h3>
  ${reviews || emptyState("Отзывов пока нет.")}`);
}

async function loadLawsuits() {
  const data = await api("/api/lawsuits");
  const rows = (data.lawsuits || []).filter((item) =>
    item.forum_status !== "rejected" && item.status !== "rejected");
  $("#lawsuitsTableBody").innerHTML = rows.length ? rows.map((item) => {
    const courtIcons = {
      "lawsuit-supreme": "20_supreme_court",
      "lawsuit-federal": "21_district_court",
      appeal: "24_appeal_cassation"
    };
    const courtIcon = courtIcons[item.template];
    const actions = [
      `<button class="btn" type="button" data-action="view-document" data-id="${Number(item.document_id)}"><svg class="icon icon-sm"><use href="/web/icons-sprite.svg#icon-16_folder_docs"></use></svg> Заявление</button>`,
      `<button class="btn" type="button" data-action="lawsuit-history" data-id="${Number(item.id)}">История</button>`
    ];
    if (Number(item.user_id) === Number(currentUser.id) &&
      ["draft", "rejected"].includes(item.forum_status)) {
      actions.push(`<form class="forum-link-form" data-forum-link-form data-document-id="${Number(item.document_id)}">
        <label>Ссылка на опубликованную тему<input class="input" type="url" name="forumUrl" required maxlength="500"
          value="${escapeHtml(item.forum_url || "")}" placeholder="https://forum.../topic/..."></label>
        <button class="btn btn-gold" type="submit">Отправить ссылку на одобрение</button>
      </form>`);
    }
    if (isManager() && item.forum_status === "pending") {
      actions.push(`<div class="forum-link-review-actions">
        <button class="btn btn-gold" type="button" data-action="review-forum-link" data-id="${Number(item.document_id)}" data-status="approved">Одобрить ссылку</button>
        <button class="btn" type="button" data-action="review-forum-link" data-id="${Number(item.document_id)}" data-status="rejected">Отклонить</button>
      </div>`);
    }
    if (isManager() && item.forum_status === "approved" && !["decided", "rejected"].includes(item.status)) {
      actions.push(`<button class="btn" type="button" data-action="review-lawsuit" data-id="${Number(item.id)}" data-status="${escapeHtml(item.status)}">Рассмотреть</button>`);
    }
    const publicationStatus = item.forum_status === "approved"
      ? `<span class="forum-status is-approved">Публикация одобрена</span>`
      : item.forum_status === "pending"
        ? `<span class="forum-status is-pending">Ссылка ожидает проверки</span>`
        : item.forum_status === "rejected"
          ? `<span class="forum-status is-rejected">Ссылка отклонена: ${escapeHtml(item.forum_review_note || "добавьте ссылку повторно")}</span>`
          : `<span class="forum-status">Ссылка ещё не добавлена</span>`;
    return `<tr>
      <td>#${Number(item.id)}</td>
      <td><span class="court-label">
        <span class="court-label-icon">${courtIcon ? `<svg class="icon icon-sm"><use href="/web/icons-sprite.svg#icon-${courtIcon}"></use></svg>` : ""}</span>
        <span>${escapeHtml(item.court || item.template || "—")}</span>
      </span></td>
      <td>${escapeHtml(item.display_name || "—")}</td>
      <td><strong>${escapeHtml(item.title)}</strong><br>${publicationStatus}
        ${item.forum_url ? `<br><a href="${escapeHtml(item.forum_url)}" target="_blank" rel="noopener noreferrer">Открыть тему на форуме ↗</a>` : ""}</td>
      <td>${statusBadge(item.status)}<div class="table-actions" style="margin-top:8px">${actions.join("")}</div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="5">${emptyState("Исков пока нет.")}</td></tr>`;
}

function lawsuitFieldValue(key) {
  const field = $(`[data-lawsuit-field="${key}"]`);
  return field ? field.value.trim() : "";
}

function renderLawsuitFields() {
  const template = $("#lawsuit-template").value;
  const common = [
    ["claimant", "Имя и фамилия истца / заявителя", "text", true],
    ["claimantId", "Номер ID-карты", "text", true],
    ["claimantPhone", "Номер телефона", "text", false],
    ["claimantEmail", "Электронная почта", "text", false]
  ];
  let fields = common;
  if (template.includes("lawsuit")) fields = [
    ...common,
    ["repName", "Имя и фамилия представителя", "text", false],
    ["repId", "Номер ID-карты представителя", "text", false],
    ["repLicense", "Лицензия / статус адвоката", "text", false],
    ["defendant", "Имя и фамилия ответчика", "text", true],
    ["organization", "Организация ответчика", "text", false],
    ["badge", "Идентификационный знак", "text", false],
    ["facts", "Описание ситуации и нарушений", "textarea", true],
    ["claims", "Требования к суду", "textarea", true],
    ["evidence", "Доказательства", "textarea", false],
    ["feeProof", "Доказательства уплаты пошлины", "text", false],
    ["filingDate", "Дата подачи", "date", true],
    ["signature", "Подпись истца / представителя", "text", true]
  ];
  if (template.includes("motion")) fields = [
    ["motionType", "Тип документа", "select", true, ["Ходатайство", "Возражение", "Довод"]],
    ["claimant", "Имя и фамилия", "text", true],
    ["claimantId", "Номер ID-карты", "text", true],
    ["motionSubject", "Тема обращения", "text", true],
    ["facts", "Прошение и обстоятельства", "textarea", true],
    ["email", "Электронная почта", "text", false],
    ["idCopy", "Копия ID-карты", "text", false],
    ["evidence", "Доказательства", "textarea", false],
    ["otherDocs", "Иная информация", "textarea", false],
    ["filingDate", "Дата", "date", true],
    ["signature", "Подпись", "text", true]
  ];
  if (template === "rehabilitation") fields = [
    ["claimant", "Имя и фамилия заявителя", "text", true],
    ["passport", "Номер паспорта", "text", true],
    ["email", "Электронная почта", "text", true],
    ["phone", "Номер телефона", "text", true],
    ["convictionDate", "Дата осуждения", "text", true],
    ["articles", "Статьи осуждения", "textarea", true],
    ["feeReady", "Готовность оплатить пошлину ($25 000–$350 000)", "select", true, ["Да", "Нет"]],
    ["passportCopy", "Копия паспорта", "text", false],
    ["otherDocs", "Иные документы", "textarea", false],
    ["filingDate", "Дата подачи", "date", true],
    ["signature", "Подпись", "text", true]
  ];
  if (template === "appeal") fields = [
    ["claimant", "Имя и фамилия заявителя", "text", true],
    ["claimantId", "Номер ID-карты", "text", true],
    ["facts", "Основания обращения", "textarea", true],
    ["claims", "Требования", "textarea", true],
    ["evidence", "Доказательства", "textarea", false],
    ["filingDate", "Дата подачи", "date", true],
    ["signature", "Подпись", "text", true]
  ];
  $("#lawsuit-fields").innerHTML = fields.map(([key, label, type, required, options]) => {
    const wide = type === "textarea";
    const control = type === "textarea"
      ? `<textarea class="input" rows="4" data-lawsuit-field="${key}"${required ? " required" : ""}></textarea>`
      : type === "select"
        ? `<select class="input" data-lawsuit-field="${key}"${required ? " required" : ""}>${options.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}</select>`
        : `<input class="input" type="${type}" data-lawsuit-field="${key}"${required ? " required" : ""}>`;
    return `<label class="${wide ? "wide" : ""}">${escapeHtml(label)}${control}</label>`;
  }).join("");
  if ($("#lawsuit-fields [type=date]")) {
    const date = $("#lawsuit-fields [type=date]");
    if (date) date.value = localDateValue();
  }
  renderLawsuitPreview();
}

function buildLawsuitBbcode() {
  const template = $("#lawsuit-template").value;
  const value = lawsuitFieldValue;
  if (template === "appeal") {
    const titles = { appeal: "АПЕЛЛЯЦИЯ" };
    return `[TABLE width="100%"]
[TR]
[td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ[/FONT][/SIZE][/RIGHT]
[CENTER][SIZE=6][FONT=times new roman][B]${titles[template]}[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman]
Заявитель: ${value("claimant")}
Номер ID-карты: ${value("claimantId")}

Основания:
${value("facts")}

Требования:
${value("claims")}

Доказательства:
${value("evidence")}

[RIGHT]Дата подачи: ${value("filingDate")}
Подпись: ${value("signature")}[/RIGHT][/FONT][/SIZE][/td]
[/TR]
[/TABLE]`;
  }
  if (template === "rehabilitation") {
    return `[TABLE width="100%"]
[TR]
[td width="100.0000%"][RIGHT][FONT=times new roman][SIZE=5]В ВЕРХОВНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012[/SIZE][/FONT][/RIGHT]
[CENTER][B][SIZE=5][FONT=times new roman]ЗАЯВЛЕНИЕ НА ЮРИДИЧЕСКУЮ РЕАБИЛИТАЦИЮ[/FONT][/SIZE][/B][/CENTER]
[SIZE=5][FONT=times new roman][B]I. ИНФОРМАЦИЯ О ЗАЯВИТЕЛЕ.[/B]
[LIST]
[*]Имя Фамилия: ${value("claimant")}
[*]Номер паспорта: ${value("passport")}
[*]Электронная почта: ${value("email")}
[*]Номер телефона: ${value("phone")}
[/LIST]
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
Я, гражданин ${value("claimant")}, был осужден ${value("convictionDate")} по статьям ${value("articles")}. Прошу Верховный Суд штата Сан-Андреас рассмотреть заявление на юридическую реабилитацию и аннулировать ранее полученные судимости.
Готовы ли вы уплатить государственную пошлину: ${value("feeReady")}
[B]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ.[/B]
[LIST=1]
[*]Копия паспорта: ${value("passportCopy")}
[*]Иные документы: ${value("otherDocs")}
[/LIST]
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/B]
На основании изложенного прошу суд аннулировать запись о судимости.
[RIGHT]Город Лос-Сантос, штат Сан-Андреас
${value("filingDate")}
${value("claimant")}
${value("signature")}[/RIGHT][/FONT][/SIZE][/td]
[/TR]
[/TABLE]`;
  }
  if (template.includes("motion")) {
    const supreme = template === "motion-supreme";
    return `[TABLE width="100%"]
[TR]
[td width="100.0000%"][RIGHT][FONT=times new roman][SIZE=5]В ${supreme ? "ВЕРХОВНЫЙ" : "ОКРУЖНОЙ"} СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012[/SIZE][/FONT][/RIGHT]
[CENTER][B][${value("motionType").toUpperCase()}][/B]
о "${value("motionSubject")}[/CENTER]
[JUSTIFY]Я, ${value("claimant")}, прошу суд ${value("facts")}[/JUSTIFY]
Я прилагаю следующую информацию:
[LIST]
[*]Номер ID-карты: ${value("claimantId")}
[*]Копия ID-карты: ${value("idCopy")}
[*]Электронная почта: ${value("email")}
[*]Доказательства: ${value("evidence")}
[*]Иная информация: ${value("otherDocs")}
[RIGHT]Город Лос-Сантос, штат Сан-Андреас
${value("filingDate")}
${value("claimant")}
${value("signature")}[/RIGHT]
[/LIST][/td]
[/TR]
[/TABLE]`;
  }
  const supreme = template === "lawsuit-supreme";
  return `[TABLE width="100%"]
[TR]
[td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]В ${supreme ? "ВЕРХОВНЫЙ" : "ОКРУЖНОЙ"} СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012[/FONT][/SIZE][/RIGHT]
[CENTER][SIZE=6][FONT=times new roman][B]ИСКОВОЕ ЗАЯВЛЕНИЕ[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman]
[B]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА.[/B]
[B]Данные истца[/B]
[LIST]
[*]Имя и фамилия: ${value("claimant")}
[*]Номер ID-карты: ${value("claimantId")}
[*]Номер телефона: ${value("claimantPhone")}
[*]Электронная почта: ${value("claimantEmail")}
[/LIST]
[B]Данные представителя истца[/B]
[LIST]
[*]Имя и фамилия: ${value("repName")}
[*]Номер ID-карты представителя: ${value("repId")}
[*]Данные о лицензии адвоката: ${value("repLicense")}
[/LIST]
[B]Данные ответчика[/B]
[LIST]
[*]Имя и фамилия: ${value("defendant")}
[*]Организация: ${value("organization")}
[*]Идентификационный знак: ${value("badge")}
[/LIST]
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ[/B]
${value("facts")}
[B]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ[/B]
[LIST=1]
[*]Доказательства: ${value("evidence")}
[*]Доказательства уплаты пошлины: ${value("feeProof")}
[/LIST]
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ[/B]
На основании вышеизложенного прошу суд:
[LIST=1]
${value("claims").split("\n").filter(Boolean).map((claim) => `[*]${claim}`).join("\n")}
[/LIST][/FONT][/SIZE]
[RIGHT][SIZE=5][FONT=times new roman]Дата подачи заявления: ${value("filingDate")}
Подпись истца или его представителя: ${value("signature")}[/FONT][/SIZE][/RIGHT][/td]
[/TR]
[/TABLE]`;
}

function renderLawsuitPreview() {
  const preview = $("#lawsuit-preview-code");
  if (preview) preview.textContent = buildLawsuitBbcode();
  const forumPreview = $("#lawsuit-forum-preview");
  if (forumPreview) forumPreview.innerHTML = buildLawsuitForumPreview();
}

function forumPreviewList(items) {
  return `<ul>${items.map(([label, key]) =>
    `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(lawsuitFieldValue(key) || "—")}</li>`
  ).join("")}</ul>`;
}

function forumPreviewSection(title, content) {
  return `<section class="forum-preview-section"><h3>${escapeHtml(title)}</h3>${content}</section>`;
}

function buildLawsuitForumPreview() {
  const template = $("#lawsuit-template").value;
  const supreme = !template.includes("federal");
  const court = `${supreme ? "ВЕРХОВНЫЙ" : "ОКРУЖНОЙ"} СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ`;
  const titles = {
    "lawsuit-supreme": "ИСКОВОЕ ЗАЯВЛЕНИЕ",
    "lawsuit-federal": "ИСКОВОЕ ЗАЯВЛЕНИЕ",
    "motion-supreme": lawsuitFieldValue("motionType").toUpperCase(),
    "motion-federal": lawsuitFieldValue("motionType").toUpperCase(),
    rehabilitation: "ЗАЯВЛЕНИЕ НА ЮРИДИЧЕСКУЮ РЕАБИЛИТАЦИЮ",
    appeal: "АПЕЛЛЯЦИОННАЯ ЖАЛОБА"
  };
  let content = "";

  if (template.includes("lawsuit")) {
    content = [
      forumPreviewSection("I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА", `
        <h4>Данные истца</h4>${forumPreviewList([
          ["Имя и фамилия", "claimant"], ["Номер ID-карты", "claimantId"],
          ["Номер телефона", "claimantPhone"], ["Электронная почта", "claimantEmail"]
        ])}
        <h4>Данные представителя истца</h4>${forumPreviewList([
          ["Имя и фамилия", "repName"], ["Номер ID-карты", "repId"],
          ["Лицензия / статус адвоката", "repLicense"]
        ])}
        <h4>Данные ответчика</h4>${forumPreviewList([
          ["Имя и фамилия", "defendant"], ["Организация", "organization"],
          ["Идентификационный знак", "badge"]
        ])}`),
      forumPreviewSection("II. ОПИСАТЕЛЬНАЯ ЧАСТЬ", `<p>${escapeHtml(lawsuitFieldValue("facts") || "—")}</p>`),
      forumPreviewSection("III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ", forumPreviewList([
        ["Доказательства", "evidence"], ["Доказательства уплаты пошлины", "feeProof"]
      ])),
      forumPreviewSection("IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ", `
        <p>На основании вышеизложенного прошу суд:</p>
        <ol>${lawsuitFieldValue("claims").split(/\r?\n/).filter(Boolean)
          .map((claim) => `<li>${escapeHtml(claim)}</li>`).join("") || "<li>—</li>"}</ol>`)
    ].join("");
  } else if (template.includes("motion")) {
    content = forumPreviewSection(`ОБРАЩЕНИЕ: ${lawsuitFieldValue("motionSubject") || "тема обращения"}`, `
      <p>Я, <strong>${escapeHtml(lawsuitFieldValue("claimant") || "—")}</strong>, прошу суд ${escapeHtml(lawsuitFieldValue("facts") || "—")}</p>
      <h4>Прилагаемая информация</h4>${forumPreviewList([
        ["Номер ID-карты", "claimantId"], ["Копия ID-карты", "idCopy"],
        ["Электронная почта", "email"], ["Доказательства", "evidence"], ["Иная информация", "otherDocs"]
      ])}`);
  } else if (template === "rehabilitation") {
    content = [
      forumPreviewSection("I. ИНФОРМАЦИЯ О ЗАЯВИТЕЛЕ", forumPreviewList([
        ["Имя и фамилия", "claimant"], ["Номер паспорта", "passport"],
        ["Электронная почта", "email"], ["Номер телефона", "phone"]
      ])),
      forumPreviewSection("II. ОПИСАТЕЛЬНАЯ ЧАСТЬ", `
        <p>Я, ${escapeHtml(lawsuitFieldValue("claimant") || "—")}, был осуждён ${escapeHtml(lawsuitFieldValue("convictionDate") || "—")} по статьям ${escapeHtml(lawsuitFieldValue("articles") || "—")}.</p>
        <p>Готовность уплатить государственную пошлину: <strong>${escapeHtml(lawsuitFieldValue("feeReady") || "—")}</strong></p>`),
      forumPreviewSection("III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ", forumPreviewList([
        ["Копия паспорта", "passportCopy"], ["Иные документы", "otherDocs"]
      ])),
      forumPreviewSection("IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ", "<p>Прошу суд рассмотреть заявление на юридическую реабилитацию.</p>")
    ].join("");
  } else {
    content = [
      forumPreviewSection("ИНФОРМАЦИЯ О ЗАЯВИТЕЛЕ", forumPreviewList([
        ["Имя и фамилия", "claimant"], ["Номер ID-карты", "claimantId"]
      ])),
      forumPreviewSection("ОСНОВАНИЯ И ТРЕБОВАНИЯ", `
        <h4>Основания обращения</h4><p>${escapeHtml(lawsuitFieldValue("facts") || "—")}</p>
        <h4>Требования к суду</h4><p>${escapeHtml(lawsuitFieldValue("claims") || "—")}</p>`),
      forumPreviewSection("ДОКАЗАТЕЛЬСТВА", `<p>${escapeHtml(lawsuitFieldValue("evidence") || "—")}</p>`)
    ].join("");
  }

  return `<article class="forum-preview-page">
    <header class="forum-preview-header">
      <img src="/assets/law-association-seal.png" alt="Печать Коллегии адвокатов">
      <strong>КОЛЛЕГИЯ АДВОКАТОВ · SAN ANDREAS</strong>
      <span>Форма судебного документа</span>
    </header>
    <div class="forum-preview-divider" aria-hidden="true"><i></i></div>
    <div class="forum-preview-address">${court}<br>ШТАТА САН-АНДРЕАС,<br>Истворн Уэй, Рокфорд Хиллс, Лос-Сантос, 90012.</div>
    <h2>${escapeHtml(titles[template] || "СУДЕБНЫЙ ДОКУМЕНТ")}</h2>
    <h3 class="forum-preview-case-title">${escapeHtml($("#lawsuit-title").value.trim() || "Название дела")}</h3>
    ${content}
    <footer class="forum-preview-signature">
      <span>Дата подачи: ${escapeHtml(lawsuitFieldValue("filingDate") || "—")}</span>
      <span>Подпись: ${escapeHtml(lawsuitFieldValue("signature") || "—")}</span>
    </footer>
  </article>`;
}

async function copyLawsuitBbcode() {
  await navigator.clipboard.writeText(buildLawsuitBbcode());
  notify("BBCode скопирован.");
}

async function submitLawsuit() {
  const title = $("#lawsuit-title").value.trim();
  const content = buildLawsuitBbcode();
  if (content.length < 100) {
    notify("Заполните обязательные поля судебной формы.");
    return;
  }
  const data = await api("/api/lawsuits", {
    method: "POST",
    body: {
      template: $("#lawsuit-template").value,
      title,
      bbcode: content
    }
  });
  $("#lawsuit-form").reset();
  renderLawsuitFields();
  $("#lawsuit-form").classList.add("hidden");
  const notice = $("#lawsuit-publication-notice");
  notice.textContent = `Иск #${data.id} создан. Добавьте ссылку на опубликованную тему в строке ниже — после этого ГКА или ЗГКА проверит публикацию.`;
  notice.classList.remove("hidden");
  notify(`Иск #${data.id} создан. Добавьте ссылку на форум в реестре.`);
  await loadLawsuits();
}

async function submitForumLink(event) {
  const form = event.target.closest("[data-forum-link-form]");
  if (!form) return;
  event.preventDefault();
  const documentId = Number(form.dataset.documentId);
  const forumUrl = form.elements.namedItem("forumUrl").value.trim();
  const result = await api(`/api/documents/${encodeURIComponent(documentId)}/forum`, {
    method: "POST",
    body: { forumUrl }
  });
  notify(result.warning
    ? `Ссылка отправлена на проверку. ${result.warning}`
    : "Ссылка отправлена ГКА и ЗГКА на одобрение.");
  await loadLawsuits();
}

async function reviewForumLink(button) {
  const status = button.dataset.status;
  const note = status === "rejected"
    ? window.prompt("Укажите причину отклонения ссылки (не менее 4 символов):", "")?.trim() || ""
    : "";
  if (status === "rejected" && note.length < 4) {
    notify("Для отклонения укажите причину длиной не менее 4 символов.");
    return;
  }
  await api(`/api/documents/${encodeURIComponent(button.dataset.id)}/forum`, {
    method: "PATCH",
    body: { status, note }
  });
  notify(status === "approved" ? "Ссылка одобрена. Иск учтён в отчётности." : "Ссылка отклонена.");
  await loadLawsuits();
}

function renderCareerRequirements({
  stageRole,
  passedSubjects = [],
  cases = [],
  requiredCaseCount = 0,
  completedCaseCount = 0,
  slots = [],
  evidenceRequiredCount = 0
}) {
  const rows = [];
  const subjects = [
    ["ak", "Тест АК"],
    ["uk", "Тест УК"],
    ["pk", "Тест ПК"]
  ];
  subjects.forEach(([subject, label]) => {
    rows.push(renderCareerRequirementRow(label, passedSubjects.includes(subject)));
  });
  if (requiredCaseCount > 0) {
    rows.push(renderCareerRequirementRow(
      "Требование по базовым AI Case",
      completedCaseCount >= requiredCaseCount,
      `Пройдено ${completedCaseCount} из ${cases.length || 3}; требуется ${requiredCaseCount}.`
    ));
    cases.forEach((scenario) => {
      rows.push(renderCareerRequirementRow(
        scenario.title || scenario.id,
        Boolean(scenario.completed),
        scenario.subtitle || ""
      ));
    });
  }
  if (stageRole === "Юрист" && evidenceRequiredCount > 0) {
    slots.slice(0, evidenceRequiredCount).forEach((slot, index) => {
      const complete = !slot.skipped && Boolean(slot.partnerName?.trim()) &&
        Boolean(slot.evidenceUrl || slot.hasImage);
      const missing = [
        !slot.partnerName?.trim() ? "адвокат не указан" : "",
        !(slot.evidenceUrl || slot.hasImage) ? "нет ссылки или скриншота" : ""
      ].filter(Boolean).join(" · ");
      rows.push(renderCareerRequirementRow(
        `Совместный вызов ${index + 1}`,
        complete,
        complete ? `Адвокат: ${slot.partnerName}` : missing
      ));
    });
  } else if (stageRole === "Стажер КА") {
    rows.push(renderCareerRequirementRow("Совместные вызовы с адвокатом", null, "Не требуются на этом этапе."));
  }
  return `<ul class="career-requirements" aria-label="Статус требований повышения">${rows.join("")}</ul>`;
}

function renderCareerRequirementRow(label, complete, detail = "") {
  const state = complete === null ? "Не требуется" : complete ? "Выполнено" : "Не выполнено";
  const stateClass = complete === null ? "is-not-required" : complete ? "is-complete" : "is-missing";
  return `<li class="career-requirement ${stateClass}">
    <span class="career-requirement-state">${state}</span>
    <span class="career-requirement-copy"><strong>${escapeHtml(label)}</strong>${detail
      ? `<small>${escapeHtml(detail)}</small>` : ""}</span>
  </li>`;
}

function renderAppeals(applications) {
  const appeals = applications.filter((item) => ["citizen_help", "citizen_complaint"].includes(item.type));
  const careerApplications = applications.filter((item) =>
    item.type === "exam" && ["Стажер КА", "Юрист"].includes(item.stage_role) &&
    (Number(item.user_id) === Number(currentUser.id) || item.promotion_data?.practiceSubmittedAt));
  const appealCards = appeals.map((item) => {
    const actions = [`<button class="btn" type="button" data-action="application-details" data-id="${Number(item.id)}">Подробнее</button>`];
    if (["ГКА", "ЗГКА", "Адвокат", "Ст.Адвокат"].includes(currentUser.role)) {
      if (!item.assigned_to && !item.completed_at) {
        actions.push(`<button class="btn" type="button" data-action="assign-appeal" data-id="${Number(item.id)}">Назначить себе</button>`);
      } else if (Number(item.assigned_user_id) === Number(currentUser.id) && !item.completed_at) {
        actions.push(`<button class="btn" type="button" data-action="close-appeal" data-id="${Number(item.id)}">Завершить</button>`);
      }
    }
    return `<article class="laws-item">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <h3>#${Number(item.id)} · ${escapeHtml(item.display_name || "Заявитель")}</h3>
        ${statusBadge(item.completed_at ? "approved" : item.status)}
      </div>
      <p>${escapeHtml(item.details || "")}</p>
      <div class="meta text-muted">${escapeHtml(item.created_at || "")}${item.assigned_name ? ` · Исполнитель: ${escapeHtml(item.assigned_name)}` : ""}${item.requested_lawyer_name ? ` · Адвокат: ${escapeHtml(item.requested_lawyer_name)}` : ""}</div>
      <div class="table-actions" style="margin-top:10px">${actions.join("")}</div>
    </article>`;
  });
  const promotionCards = careerApplications.map((item) => {
    const data = item.promotion_data || {};
    const lawBundle = Array.isArray(data.lawTests) &&
      ["ak", "uk", "pk"].every((subject) => data.lawTests.includes(subject));
    const submitted = Boolean(data.practiceSubmittedAt);
    const requirements = lawBundle
      ? renderCareerRequirements({
        stageRole: item.stage_role,
        passedSubjects: item.career_law_passed_subjects || [],
        cases: item.rp_practice_cases || [],
        requiredCaseCount: Number(item.rp_practice_required_count || 0),
        completedCaseCount: Number(item.rp_practice_completed_count || 0),
        slots: item.promotion_practice || [],
        evidenceRequiredCount: item.stage_role === "Юрист" ? (item.promotion_practice || []).length : 0
      })
      : "";
    const canReview = Number(item.user_id) !== Number(currentUser.id) && item.status === "pending" &&
      submitted && (!lawBundle || item.career_requirements_complete === true) &&
      (currentUser.role === "ГКА" || currentUser.role === "ЗГКА" || currentUser.hasFullGkaAccess ||
        (currentUser.role === "Ст.Адвокат" && item.stage_role === "Стажер КА"));
    const actions = canReview
      ? `<button class="btn btn-gold" type="button" data-action="review-career-promotion" data-id="${Number(item.id)}" data-status="approved">Принять</button>
         <button class="btn" type="button" data-action="review-career-promotion" data-id="${Number(item.id)}" data-status="rejected">Отклонить</button>`
      : "";
    const practice = submitted
      ? (item.promotion_practice || []).map((slot) => {
        if (slot.skipped) {
          return `<li><strong>Слот ${Number(slot.slotNo)}:</strong> пропущен</li>`;
        }
        const evidence = [
          slot.evidenceUrl
            ? `<a href="${escapeHtml(slot.evidenceUrl)}" target="_blank" rel="noopener noreferrer">Откат / ссылка</a>`
            : "",
          slot.photoUrl
            ? `<a href="${escapeHtml(slot.photoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(slot.imageName || "Скриншот")}</a>`
            : ""
        ].filter(Boolean).join(" · ");
        return `<li><strong>Слот ${Number(slot.slotNo)}:</strong> ${escapeHtml(slot.partnerName || "—")} · ${evidence || "доказательство не найдено"}</li>`;
      }).join("")
      : "";
    return `<article class="laws-item career-promotion-application">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <h3>Заявка #${Number(item.id)} · ${escapeHtml(item.display_name || "Сотрудник")}: ${escapeHtml(item.stage_role)} → ${escapeHtml(item.requested_role || promotionPracticeRanks[item.stage_role])}</h3>
        ${statusBadge(item.status)}
      </div>
      <p>${escapeHtml(submitted
        ? item.result || item.details || "Практика отправлена на рассмотрение."
        : "Черновик этапа: заполните практику совместных задержаний и отправьте заявку.")}</p>
      <div class="meta text-muted">
        ${lawBundle
          ? item.stage_role === "Стажер КА"
            ? `Тесты АК/УК/ПК: ${Array.isArray(item.career_law_passed_subjects) ? item.career_law_passed_subjects.length : 0}/3 · AI Case: ${Number(item.rp_practice_completed_count || 0)}/${Number(item.rp_practice_required_count || 1)} необходимых`
            : `Тесты АК/УК/ПК: ${Array.isArray(item.career_law_passed_subjects) ? item.career_law_passed_subjects.length : 0}/3 · AI Case: ${Number(item.rp_practice_completed_count || 0)}/${Number(item.rp_practice_required_count || 3)} · Подтверждения вызовов: ${(item.promotion_practice || []).filter((slot) => !slot.skipped && slot.partnerName?.trim() && (slot.evidenceUrl || slot.hasImage)).length}/${(item.promotion_practice || []).length}`
          : item.stage_role === "Юрист"
          ? `Вызовы: ${Number(data.completedCalls || 0)} / ${Number(data.requiredCalls || 0)} · Пробный иск: ${escapeHtml(data.trialLawsuitReference || "не указан")} · Обзвон: ${item.interview_status === "ready" ? "готов" : "ожидает"}`
          : Array.isArray(data.lawTests) ? "Три обязательных теста по АК, УК и ПК сданы." : "Обязательный карьерный тест сдан."}
      </div>
      ${requirements}
      ${submitted ? `<details class="career-practice-evidence"><summary>Практика задержаний · доказательства</summary><ol>${practice}</ol></details>` : ""}
      ${actions ? `<div class="table-actions" style="margin-top:10px">${actions}</div>` : ""}
    </article>`;
  });
  const sections = [];
  if (appealCards.length) sections.push(`<div class="appeal-list-section"><h3>Обращения граждан</h3>${appealCards.join("")}</div>`);
  if (promotionCards.length) sections.push(`<div class="appeal-list-section"><h3>${managerRoles.includes(currentUser.role) || currentUser.role === "Ст.Адвокат" ? "Заявки на повышение" : "Мои этапы повышения"}</h3>${promotionCards.join("")}</div>`);
  $("#appealsList").innerHTML = sections.length ? sections.join("") : emptyState("Обращений и заявок на повышение пока нет.");
}

async function loadAppeals() {
  const data = await api("/api/applications");
  renderAppeals(data.applications || []);
  if (currentUser.role === "Гражданин") {
    const ranking = await api("/api/attorneys?period=all");
    const attorneys = ranking.attorneys || [];
    $("#appealLawyer").innerHTML = `<option value="">Не выбирать адвоката</option>${attorneys.map((attorney) =>
      `<option value="${Number(attorney.id)}">${escapeHtml(attorney.display_name)} · ${escapeHtml(attorney.role)}</option>`
    ).join("")}`;
  }
}

function getPromotionDecreeSelection() {
  const selected = $$("[data-decree-entry]:checked", $("#promotion-decree-candidates"));
  const applicationIds = selected.map((checkbox) => Number(checkbox.value));
  const passports = {};
  for (const id of applicationIds) {
    passports[String(id)] = $(`[data-decree-passport="${id}"]`, $("#promotion-decree-candidates")).value.trim();
  }
  return { applicationIds, passports };
}

function renderPromotionDecreeCandidates(data) {
  promotionDecreeState = data;
  const number = String(Number(data.nextNumber || 0)).padStart(3, "0");
  $("#promotion-decree-number").textContent = `Следующий №${number}`;
  const candidates = data.candidates || [];
  $("#promotion-decree-candidates").innerHTML = candidates.length
    ? candidates.map((entry) => `<article class="promotion-decree-candidate">
        <label class="promotion-decree-candidate-select">
          <input type="checkbox" data-decree-entry value="${Number(entry.applicationId)}" checked>
          <span><strong>${escapeHtml(entry.characterName)}</strong><small>Заявка #${Number(entry.applicationId)} · ${escapeHtml(entry.fromRole)} → ${escapeHtml(entry.toRole)}</small></span>
        </label>
        <label class="promotion-decree-passport">Номер паспорта
          <input class="input" type="text" maxlength="40" data-decree-passport="${Number(entry.applicationId)}"
            value="${escapeHtml(entry.passportId)}" placeholder="Укажите номер паспорта">
        </label>
      </article>`).join("")
    : emptyState("Новых одобренных повышений для указа пока нет.");
  $("#promotion-decree-history").innerHTML = (data.history || []).length
    ? `<ul>${data.history.map((item) =>
      `<li>Указ №${String(Number(item.decree_number)).padStart(3, "0")} · ${Number(item.item_count)} записей · ${escapeHtml(item.sent_at)}</li>`
    ).join("")}</ul>`
    : `<p class="text-muted">Отправленных указов пока нет.</p>`;
  $("#promotion-decree-preview").value = "";
  $("#send-promotion-decree").disabled = true;
  $("#promotion-decree-status").textContent = candidates.length
    ? `Доступно новых повышений: ${candidates.length}. Снимите отметку, чтобы удалить запись из этого указа.`
    : "Все новые одобренные повышения уже включены в отправленные указы.";
}

async function loadPromotionDecrees() {
  if (!(currentUser.role === "ГКА" || currentUser.hasFullGkaAccess)) {
    throw new Error("Указы может формировать только ГКА.");
  }
  renderPromotionDecreeCandidates(await api("/api/promotion-decree"));
}

function invalidatePromotionDecreePreview(target) {
  if (!target.closest("#promotion-decree-candidates")) return;
  $("#promotion-decree-preview").value = "";
  $("#send-promotion-decree").disabled = true;
}

async function previewPromotionDecree() {
  const selection = getPromotionDecreeSelection();
  if (!selection.applicationIds.length) throw new Error("Выберите хотя бы одно повышение для указа.");
  const preview = await api("/api/promotion-decree/preview", {
    method: "POST",
    body: selection
  });
  $("#promotion-decree-preview").value = preview.bbcode;
  $("#send-promotion-decree").disabled = false;
  $("#promotion-decree-status").textContent =
    `Предпросмотр указа №${String(Number(preview.decreeNumber)).padStart(3, "0")} · записей: ${preview.count}. Проверьте текст перед отправкой.`;
}

async function sendPromotionDecree() {
  const selection = getPromotionDecreeSelection();
  if (!selection.applicationIds.length || !$("#promotion-decree-preview").value) {
    throw new Error("Сначала сформируйте предпросмотр указа.");
  }
  const number = String(Number(promotionDecreeState?.nextNumber || 0)).padStart(3, "0");
  if (!window.confirm(`Отправить указ №${number} (${selection.applicationIds.length} записей) в ваш Discord?`)) return;
  const result = await api("/api/promotion-decree/send", {
    method: "POST",
    body: selection
  });
  notify(result.logWarning
    ? `Указ №${result.decreeNumber} отправлен в личные сообщения Discord. Предупреждение журнала: ${result.logWarning}`
    : `Указ №${result.decreeNumber} отправлен в личные сообщения Discord.`);
  await loadPromotionDecrees();
}

async function submitAppeal() {
  const characterName = $("#appealName").value.trim();
  const description = $("#appealText").value.trim();
  const details = `Персонаж: ${characterName}\n\n${description}`.trim();
  if (characterName.length < 2 || description.length < 4 || details.length > 2000) {
    notify("Укажите имя персонажа и описание обращения (от 4 до 2000 символов).");
    return;
  }
  const body = { type: $("#appealType").value, details };
  if ($("#appealLawyer").value) body.lawyerId = Number($("#appealLawyer").value);
  const result = await api("/api/applications", { method: "POST", body });
  $("#appealName").value = "";
  $("#appealText").value = "";
  $("#appealLawyer").value = "";
  notify(`Обращение #${result.id} отправлено.`);
  await loadAppeals();
}

async function loadLaws() {
  const list = $("#lawsContainer");
  list.innerHTML = emptyState("Загрузка законодательной базы…");
  const index = await api("/api/laws");
  const available = Object.entries(index.laws || {}).filter(([, law]) => law.available);
  const results = await Promise.all(available.map(async ([key]) => {
    try {
      const law = await api(`/api/laws/${encodeURIComponent(key)}`);
      return { key, law };
    } catch (error) {
      return { key, error: error.message };
    }
  }));
  loadedLaws = results.filter((result) => result.law).map(({ key, law }) => ({
    key,
    name: law.name || lawMeta[key] || key,
    text: law.text || "",
    sourceNote: law.sourceNote || ""
  }));
  const errors = results.filter((result) => result.error);
  list.innerHTML = loadedLaws.length
    ? `${errors.length ? `<p class="text-muted">Не удалось загрузить: ${errors.map((item) => `${escapeHtml(item.key)} (${escapeHtml(item.error)})`).join("; ")}</p>` : ""}
      ${loadedLaws.map((law) => `<details class="laws-item" data-law>
        <summary><strong>${escapeHtml(lawMeta[law.key] || law.name)}</strong></summary>
        <p class="text-muted">${escapeHtml(law.sourceNote)}</p>
        <pre class="document-content">${escapeHtml(law.text)}</pre>
      </details>`).join("")}`
    : emptyState(errors.map((item) => `${item.key}: ${item.error}`).join("; ") || "Нет доступных нормативных актов.");
  filterLaws();
}

async function loadPhotozot() {
  const container = $("#photozotContainer");
  container.innerHTML = emptyState("Загрузка фото зон…");
  const data = await api("/api/photozot");
  photozotPhotos = data.photos || [];
  const groupOrder = ["lspd", "lssd", "fib", "ft", "ng", "ems", "gov", "lsia", "court", "other"];
  const groups = [...new Map(photozotPhotos.map((photo) => [photo.group_key, photo.group_label])).entries()]
    .sort(([left], [right]) => groupOrder.indexOf(left) - groupOrder.indexOf(right));
  if (!groups.some(([key]) => key === activePhotozotGroup)) activePhotozotGroup = groups[0]?.[0] || "";
  renderPhotozotGroup(groups);
}

function renderPhotozotGroup(groups = [...new Map(photozotPhotos.map((photo) => [photo.group_key, photo.group_label])).entries()]) {
  const tabs = $("#photozotTabs");
  const container = $("#photozotContainer");
  if (!photozotPhotos.length) {
    tabs.innerHTML = "";
    container.innerHTML = emptyState("Фото зон пока не добавлены.");
    return;
  }
  tabs.innerHTML = groups.map(([key, label]) => {
    const active = key === activePhotozotGroup;
    const count = photozotPhotos.filter((photo) => photo.group_key === key).length;
    return `<button class="photozot-tab${active ? " is-active" : ""}" type="button" role="tab"
      data-action="select-photozot-group" data-group="${escapeHtml(key)}" aria-selected="${active}">
      ${escapeHtml(label)}<span>${count}</span>
    </button>`;
  }).join("");
  const photos = photozotPhotos.filter((photo) => photo.group_key === activePhotozotGroup);
  container.innerHTML = photos.length
    ? photos.map((photo) => `
      <article class="photozot-card">
        <a href="${escapeHtml(photo.url)}" aria-label="Открыть фото: ${escapeHtml(photo.label)}">
          <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.label)}" loading="lazy">
        </a>
        <strong>${escapeHtml(photo.label)}</strong>
      </article>`).join("")
    : emptyState("В этой категории пока нет фотографий.");
}

function switchLawsTab(tab) {
  const showZones = tab === "zones";
  const showFees = tab === "fees";
  const showComplaints = tab === "complaints";
  $("#lawsTextTab").classList.toggle("hidden", showZones || showFees || showComplaints);
  $("#lawsZonesTab").classList.toggle("hidden", !showZones);
  $("#lawsFeesTab").classList.toggle("hidden", !showFees);
  $("#lawsComplaintsTab").classList.toggle("hidden", !showComplaints);
  $$("[data-laws-tab]").forEach((button) => {
    const active = button.dataset.lawsTab === tab;
    button.classList.toggle("btn-gold", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (showZones) loadPhotozot().catch((error) => notify(error.message));
}

function filterLaws() {
  const query = $("#lawsSearch").value.trim().slice(0, 100);
  const list = $("#lawsContainer");
  const results = $("#lawsSearchResults");
  const searching = Boolean(query);
  list.classList.toggle("hidden", searching);
  results.classList.toggle("hidden", !searching);
  if (!searching) {
    results.innerHTML = "";
    return;
  }

  const articleQuery = /^\d+(?:\.\d+)*$/.test(query);
  const queryLower = query.toLocaleLowerCase("ru");
  const matches = [];
  for (const law of loadedLaws) {
    const text = law.text.replace(/\r\n?/g, "\n");
    const lowerText = text.toLocaleLowerCase("ru");
    let offset = 0;
    let lawMatches = 0;
    while (matches.length < 60 && lawMatches < 3) {
      const index = lowerText.indexOf(queryLower, offset);
      if (index < 0) break;
      offset = index + Math.max(queryLower.length, 1);
      if (articleQuery && (
        /[\d.]/.test(text[index - 1] || "") ||
        /\d/.test(text[index + query.length] || "") ||
        text[index + query.length] === "." && /\d/.test(text[index + query.length + 1] || "")
      )) continue;

      const lineStart = text.lastIndexOf("\n", index) + 1;
      const lineEndIndex = text.indexOf("\n", index);
      const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
      let start = lineStart;
      let end = lineEnd;
      const line = text.slice(lineStart, lineEnd);
      const articleHeading = /^\s*(?:Статья\s+)?\d+(?:\.\d+)*(?:[.)\s:—-]|$)/i;
      if (articleQuery && articleHeading.test(line)) {
        const remaining = text.slice(lineEnd + 1);
        const nextHeading = remaining.search(/^\s*(?:Статья\s+)?\d+(?:\.\d+)*(?:[.)\s:—-]|$)/im);
        end = nextHeading < 0 ? text.length : lineEnd + 1 + nextHeading;
      } else {
        start = Math.max(0, index - 130);
        end = Math.min(text.length, index + query.length + 240);
      }
      end = Math.min(end, start + 1600);

      matches.push({
        title: lawMeta[law.key] || law.name,
        source: law.name,
        text: text.slice(start, end).trim(),
        article: articleQuery
      });
      lawMatches += 1;
    }
    if (matches.length >= 60) break;
  }

  results.innerHTML = matches.length
    ? `<p class="laws-search-summary">Найдено совпадений: <strong>${matches.length}</strong>${matches.length === 60 ? " · показаны первые 60" : ""}</p>
      ${matches.map((match) => `<article class="law-search-result">
        <h3>${escapeHtml(match.title)}${match.article ? ` · статья ${escapeHtml(query)}` : ""}</h3>
        <small>Источник: ${escapeHtml(match.source)}</small>
        <p>${highlightLawSearchText(match.text, query)}</p>
      </article>`).join("")}`
    : emptyState(`По запросу «${query}» совпадений не найдено.`);
}

function highlightLawSearchText(text, query) {
  const queryLower = query.toLocaleLowerCase("ru");
  const lowerText = text.toLocaleLowerCase("ru");
  let cursor = 0;
  let output = "";
  let count = 0;
  while (count < 12) {
    const index = lowerText.indexOf(queryLower, cursor);
    if (index < 0) break;
    output += `${escapeHtml(text.slice(cursor, index))}<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>`;
    cursor = index + query.length;
    count += 1;
  }
  return output + escapeHtml(text.slice(cursor));
}

function renderExamHistory(exams) {
  const attempts = Array.isArray(exams) ? exams : [];
  const passed = attempts.filter((exam) => exam.passed).length;
  const totalQuestions = attempts.reduce((sum, exam) => sum + Number(exam.total || 0), 0);
  const correctAnswers = attempts.reduce((sum, exam) => sum + Number(exam.score || 0), 0);
  const average = totalQuestions ? Math.round((correctAnswers / totalQuestions) * 100) : 0;
  $("#exam-history-summary").innerHTML = [
    ["Всего попыток", attempts.length],
    ["Сдано", passed],
    ["Не сдано", attempts.length - passed],
    ["Точность ответов", `${average}%`]
  ].map(([label, value]) => `<div class="exam-history-stat"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#exam-history-list").innerHTML = attempts.length ? attempts.map((exam, index) => {
    const percent = exam.total ? Math.round((exam.score / exam.total) * 100) : 0;
    const isPassed = Boolean(exam.passed);
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    return `<article class="exam-attempt ${isPassed ? "is-passed" : "is-failed"}">
      <div class="exam-attempt-heading">
        <div>
          <h4>${escapeHtml(exam.title || exam.track || "Экзамен")}</h4>
          <span class="exam-attempt-meta">${escapeHtml(formatNotificationDate(exam.created_at) || exam.created_at || "")}</span>
        </div>
        <div class="exam-attempt-result">
          <strong>${Number(exam.score || 0)} / ${Number(exam.total || 0)} · ${percent}%</strong>
          <span class="exam-status-pill ${isPassed ? "is-passed" : "is-failed"}">${isPassed ? "Сдан" : "Не сдан"}</span>
        </div>
      </div>
      ${questions.length ? `<details class="exam-attempt-details" ${index === 0 ? "open" : ""}>
        <summary>Разбор ответов: ${questions.length}</summary>
        <ol>${questions.map((item) => {
          const answered = Boolean(item.selectedAnswer);
          const stateClass = answered ? item.correct ? "is-correct" : "is-incorrect" : "is-unavailable";
          return `<li class="exam-question-review ${stateClass}">
            <p>${escapeHtml(item.question)}</p>
            <span>Ваш ответ: ${escapeHtml(item.selectedAnswer || "не сохранился в этой записи")}</span>
            <span>Правильный ответ: ${escapeHtml(item.correctAnswer || "нет данных")}</span>
            <span>${answered ? item.correct ? "Ответ верный" : "Ответ неверный" : "Подробности ответа недоступны"}</span>
          </li>`;
        }).join("")}</ol>
      </details>` : ""}
    </article>`;
  }).join("") : emptyState("Вы ещё не проходили тесты. После первой попытки здесь появятся баллы, статус и разбор ответов.");
}

async function loadTests() {
  const practicePromise = promotionPracticeRanks[currentUser.role]
    ? api("/api/promotion-practice")
    : Promise.resolve(null);
  const [applications, history, progress, practice] = await Promise.all([
    api("/api/applications"),
    api("/api/exams/history"),
    api("/api/exams/law-progress"),
    practicePromise
  ]);
  renderExamHistory(history.exams);
  renderLawExamButtons(progress);
  if (practice) renderPromotionPractice(practice);
  const careerApplication = (applications.applications || [])
    .filter((item) => item.type === "exam" && Array.isArray(item.promotion_data?.lawTests) &&
      item.stage_role === currentUser.role)
    .sort((left, right) => Number(right.id) - Number(left.id))[0];
  const promotionData = careerApplication?.promotion_data || {};
  const lawBundle = Array.isArray(promotionData.lawTests) &&
    ["ak", "uk", "pk"].every((subject) => promotionData.lawTests.includes(subject));
  const canRequestInterview = Boolean(careerApplication && careerApplication.status === "pending" &&
    careerApplication.stage_role === "Юрист" && !lawBundle);
  $("#interview-actions").classList.toggle("hidden", !canRequestInterview);
  if (canRequestInterview) {
    const ready = careerApplication.interview_status === "ready";
    const hasPromotionReport = Number(promotionData.completedCalls) >= Number(progress.lawyerCallsRequired || 0) &&
      Boolean(promotionData.trialLawsuitReference);
    $("#interview-status").textContent = ready
      ? "Готовность отмечена. Руководство увидит заявку и сможет принять решение после обзвона."
      : hasPromotionReport
        ? "Все три теста сданы, отчёт заполнен. Отметьте готовность к обзвону."
        : "Все три теста сданы. Сначала заполните данные о вызовах и пробном иске.";
    $("#interview-toggle").dataset.id = String(careerApplication.id);
    $("#interview-toggle").dataset.status = ready ? "ready" : "waiting";
    $("#interview-toggle").disabled = !ready && !hasPromotionReport;
    $("#interview-toggle").textContent = ready
      ? "Отложить обзвон"
      : hasPromotionReport ? "Отметить готовность к обзвону" : "Сначала заполните отчёт";
  }
  const report = $("#law-promotion-report");
  const canSubmitReport = Boolean(canRequestInterview && currentUser.role === "Юрист" && !lawBundle);
  report.classList.toggle("hidden", !canSubmitReport);
  if (canSubmitReport) {
    const saved = careerApplication.promotion_data || {};
    $("#law-promotion-report-hint").textContent =
      `Для перехода требуется не менее ${Number(progress.lawyerCallsRequired || 0)} вызовов и пробный иск.`;
    $("#law-promotion-form").dataset.applicationId = String(careerApplication.id);
    $("#law-promotion-calls").value = saved.completedCalls || "";
    $("#law-promotion-lawsuit").value = saved.trialLawsuitReference || "";
  }
  const status = $("#law-career-application-status");
  const requestButton = $("#request-promotion-from-tests");
  const completedCount = (progress.passedSubjects || []).length;
  const isPromotionRole = ["Стажер КА", "Юрист"].includes(currentUser.role);
  requestButton.classList.add("hidden");
  if (careerApplication?.status === "pending" && lawBundle) {
    if (promotionData.practiceSubmittedAt) {
      status.textContent = currentUser.role === "Стажер КА"
        ? "Заявка на повышение до юриста отправлена. Ожидайте решения ГКА или ЗГКА."
        : "Заявка на повышение до адвоката отправлена. Ожидайте решения ГКА или ЗГКА.";
    } else {
      const rpCount = practice?.rpPracticeCompletedCaseIds?.length || 0;
      const rpRequired = practice?.rpPracticeRequiredCount || (currentUser.role === "Стажер КА" ? 1 : 3);
      const evidenceCount = practice?.evidenceCompletedCount || 0;
      const evidenceRequired = practice?.evidenceRequiredCount || (currentUser.role === "Юрист" ? 2 : 0);
      status.textContent = [
        `Тесты АК/УК/ПК: ${completedCount}/3.`,
        `Базовые AI Case: ${rpCount}/${rpRequired}.`,
        evidenceRequired ? `Совместные задержания с адвокатом: ${evidenceCount}/${evidenceRequired}.` : "",
        practice?.offerDeclinedAt && practice.canSubmit
          ? "Вы пока отказались от заявки. Когда будете готовы, нажмите кнопку ниже."
          : practice?.canSubmit
            ? "Все условия выполнены. Подтвердите подачу заявки."
            : practice?.readinessMessage || ""
      ].filter(Boolean).join(" ");
      if (practice?.canSubmit) {
        requestButton.dataset.applicationId = String(careerApplication.id);
        requestButton.classList.remove("hidden");
      }
    }
    status.classList.remove("hidden");
  } else if (careerApplication?.status === "rejected") {
    status.textContent = careerApplication.result || "Заявка отклонена. Тесты этого этапа снова доступны.";
    status.classList.remove("hidden");
  } else if (isPromotionRole && completedCount === 3) {
    status.textContent = "Три теста сданы. Заявка на повышение формируется.";
    status.classList.remove("hidden");
  } else {
    status.classList.add("hidden");
  }
  if (practice?.canSubmit && lawBundle && !practice.offerDeclinedAt && !promotionData.practiceSubmittedAt) {
    await maybeOfferCareerPromotion(practice);
  }
  if (isPromotionRole) await loadCareerPath();
}

const lawExamTracks = [
  { subject: "ak", label: "Административный", short: "АК" },
  { subject: "uk", label: "Уголовный", short: "УК" },
  { subject: "pk", label: "Процессуальный", short: "ПК" }
];

function renderLawExamButtons(progress) {
  const container = $("#law-exam-buttons");
  $("#law-exam-role").textContent = currentUser.role;
  if (!progress.available) {
    container.innerHTML = `<p class="rp-practice-empty">${escapeHtml(progress.message || "Тесты по АК, УК и ПК доступны стажёрам, юристам и адвокатам.")}</p>`;
    $("#law-exam-progress-note").textContent = "";
    return;
  }
  const passed = new Set(progress.passedSubjects || []);
  const careerPathRole = Object.hasOwn(promotionPracticeRanks, currentUser.role);
  const nextSubject = progress.nextSubject || "";
  container.innerHTML = lawExamTracks.map(({ subject, label, short }, index) => {
    const completed = passed.has(subject);
    const locked = !completed && careerPathRole &&
      (subject !== nextSubject || (currentUser.role === "Юрист" && !progress.lawsReviewed));
    const storageKey = `law-exam-stamp:${currentUser.id}:${progress.stageRole}:${subject}`;
    const savedAngle = localStorage.getItem(storageKey);
    let angle = savedAngle === null ? Number.NaN : Number(savedAngle);
    if (!Number.isFinite(angle) || angle < -179 || angle > 179) {
      angle = Math.round(Math.random() * 36 - 18);
      localStorage.setItem(storageKey, String(angle));
    }
    return `<article class="law-exam-card${completed ? " is-completed" : ""}${locked ? " is-locked" : ""}">
      <div class="law-exam-card-heading"><span class="law-exam-number">${String(index + 1).padStart(2, "0")}</span>
        <strong>${label}</strong><span class="badge ${completed ? "badge-gold" : "badge-info"}">${completed ? "СДАН" : short}</span></div>
      ${completed
        ? `<div class="law-exam-stamp${lawExamJustPassed === subject ? " is-dropping" : ""}" data-stamp-subject="${subject}"
            data-stamp-stage="${escapeHtml(progress.stageRole)}" data-stamp-angle="${angle}" role="img"
            aria-label="Тест ${label} сдан. Потяните печать, чтобы повернуть её." title="Потяните печать, чтобы повернуть">
            <img src="/assets/exam-passed-stamp.png?v=2" alt="ПРОЙДЕНО" style="--stamp-angle:${angle}deg">
          </div>`
        : `<button class="btn btn-gold" type="button" data-action="start-law-exam" data-subject="${subject}" ${locked ? "disabled" : ""}>
            ${locked ? "Сначала выполните предыдущий шаг" : `Начать тест ${short} <span aria-hidden="true">→</span>`}
          </button>`}
    </article>`;
  }).join("");
  $$(".law-exam-stamp.is-dropping", container).forEach((stamp) => {
    stamp.querySelector("img").addEventListener("animationend", () => stamp.classList.remove("is-dropping"), { once: true });
  });
  lawExamJustPassed = "";
  const remaining = lawExamTracks.filter(({ subject }) => !passed.has(subject)).map(({ short }) => short);
  $("#law-exam-progress-note").textContent = currentUser.role === "Юрист" && !progress.lawsReviewed
    ? "Сначала изучите законодательство в разделе «Мой путь» и отметьте выполнение шага."
    : remaining.length
    ? `Сдано ${passed.size} из 3. Тесты открываются по порядку. Осталось: ${remaining.join(", ")}.`
    : currentUser.role === "Адвокат"
      ? "Все тесты текущего этапа пройдены. Адвокат — последняя ступень с доступом к этим экзаменам."
      : "Все три теста сданы. Выполните базовые AI Case и практику; после этого портал предложит подать заявку.";
}

async function startExam(subject = "") {
  if (subject && !lawExamTracks.some((track) => track.subject === subject)) {
    throw new Error("Выберите экзамен по АК, УК или ПК.");
  }
  if (!subject) {
    if (!window.confirm("Подтверждаете, что ознакомились с материалами подготовки к экзамену?")) return;
    await api("/api/exams/start", { method: "POST", body: { studyConfirmed: true } });
  }
  const suffix = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  const data = await api(`/api/exams/current${suffix}`);
  quizSession = { ...data, subject };
  $("#quiz-title").textContent = subject
    ? `${lawExamSubjects[subject] || subject}: тест`
    : `Карьерный тест · ${data.track}`;
  $("#quiz-questions").innerHTML = data.questions.map((question, index) =>
    `<fieldset class="quiz-question" data-question="${index}">
      <legend><span class="quiz-number">${index + 1}</span>${escapeHtml(question.q)}</legend>
      ${question.answers.map((answer, answerIndex) => `<label class="quiz-answer">
        <input type="radio" name="answer-${index}" value="${answerIndex}" required>
        <span>${escapeHtml(answer)}</span>
      </label>`).join("")}
    </fieldset>`
  ).join("");
  const updateQuizProgress = () => {
    const answered = $$("input[type=radio]:checked", $("#quiz-form")).length;
    const total = data.questions.length;
    $("#quiz-progress-label").textContent = `Ответы: ${answered} из ${total}`;
    $("#quiz-progress-bar").style.width = `${total ? (answered / total) * 100 : 0}%`;
  };
  $$("input[type=radio]", $("#quiz-form")).forEach((input) => input.addEventListener("change", updateQuizProgress));
  updateQuizProgress();
  $("#quiz-dialog").classList.remove("hidden");
}

async function submitQuiz(event) {
  event.preventDefault();
  if (!quizSession) return;
  const answers = quizSession.questions.map((_, index) => {
    const selected = $(`input[name="answer-${index}"]:checked`, $("#quiz-form"));
    return selected ? Number(selected.value) : -1;
  });
  if (answers.some((answer) => answer < 0)) {
    notify("Ответьте на каждый вопрос.");
    return;
  }
  const body = { answers };
  if (quizSession.subject) body.subject = quizSession.subject;
  const examTitle = quizSession.subject
    ? lawExamSubjects[quizSession.subject] || "Тест по законодательству"
    : `Проверка знаний · ${quizSession.track}`;
  const completedLawSubject = quizSession.subject;
  const result = await api("/api/exams", { method: "POST", body });
  $("#quiz-dialog").classList.add("hidden");
  quizSession = null;
  if (result.passed && completedLawSubject) lawExamJustPassed = completedLawSubject;
  if (result.user) {
    await enterSession({ user: result.user, csrfToken });
  }
  $("#exam-latest-result").className = `exam-latest-result ${result.passed ? "is-passed" : "is-failed"}`;
  $("#exam-latest-result").innerHTML = `<span class="exam-result-status">${result.passed ? "ТЕСТ СДАН" : "ТЕСТ НЕ СДАН"}</span>
    <div><strong>${escapeHtml(examTitle)}</strong><span>${Number(result.score)} из ${Number(result.total)} правильных · ${Math.round((result.score / result.total) * 100)}%</span></div>
    ${result.interviewRequired ? "<p>Следующий шаг — отметка готовности и обзвон с руководством.</p>" : ""}`;
  $("#exam-latest-result").classList.remove("hidden");
  await loadTests();
  if (currentView === "tests") $("#exam-latest-result").scrollIntoView({ behavior: "smooth", block: "center" });
  const nextStep = result.applicationCreated
    ? " Теперь выполните базовые AI Case и требования практики; после этого можно будет подать заявку."
    : "";
  notify(`Результат: ${result.score}/${result.total}. ${result.passed ? "Тест сдан." : "Тест не сдан."}${nextStep}`);
}

async function toggleInterview(button) {
  const status = button.dataset.status === "ready" ? "waiting" : "ready";
  await api(`/api/applications/${encodeURIComponent(button.dataset.id)}/interview`, {
    method: "PATCH",
    body: { status }
  });
  notify(status === "ready" ? "Готовность к обзвону отмечена." : "Обзвон отложен.");
  await loadTests();
}

async function submitLawPromotionData(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const applicationId = Number(form.dataset.applicationId);
  const completedCalls = Number($("#law-promotion-calls").value);
  const trialLawsuitReference = $("#law-promotion-lawsuit").value.trim();
  if (!applicationId) throw new Error("Заявка на повышение не найдена.");
  await api(`/api/applications/${encodeURIComponent(applicationId)}/promotion-data`, {
    method: "PATCH",
    body: { completedCalls, trialLawsuitReference }
  });
  notify("Данные для заявки на повышение сохранены.");
  await loadTests();
}

function beginStampRotation(event) {
  const stamp = event.target.closest("[data-stamp-subject]");
  if (!stamp || !currentUser || event.button !== 0) return;
  event.preventDefault();
  const bounds = stamp.getBoundingClientRect();
  const pointerAngle = Math.atan2(event.clientY - bounds.top - bounds.height / 2,
    event.clientX - bounds.left - bounds.width / 2) * 180 / Math.PI;
  const angle = Number(stamp.dataset.stampAngle);
  activeStampDrag = {
    stamp,
    pointerId: event.pointerId,
    startPointerAngle: pointerAngle,
    startStampAngle: Number.isFinite(angle) ? angle : 0
  };
  stamp.setPointerCapture(event.pointerId);
}

function rotateStamp(event) {
  if (!activeStampDrag || activeStampDrag.pointerId !== event.pointerId) return;
  const { stamp } = activeStampDrag;
  const bounds = stamp.getBoundingClientRect();
  const pointerAngle = Math.atan2(event.clientY - bounds.top - bounds.height / 2,
    event.clientX - bounds.left - bounds.width / 2) * 180 / Math.PI;
  const turn = ((pointerAngle - activeStampDrag.startPointerAngle + 540) % 360) - 180;
  const angle = Math.max(-179, Math.min(179, activeStampDrag.startStampAngle + turn));
  stamp.dataset.stampAngle = String(Math.round(angle));
  stamp.querySelector("img").style.setProperty("--stamp-angle", `${angle}deg`);
}

function finishStampRotation(event) {
  if (!activeStampDrag || activeStampDrag.pointerId !== event.pointerId) return;
  const { stamp } = activeStampDrag;
  const key = `law-exam-stamp:${currentUser.id}:${stamp.dataset.stampStage}:${stamp.dataset.stampSubject}`;
  localStorage.setItem(key, stamp.dataset.stampAngle);
  activeStampDrag = null;
}

async function reviewCareerPromotion(button) {
  const status = button.dataset.status;
  let note = "";
  if (status === "rejected") {
    note = window.prompt("Укажите причину отклонения заявки:", "")?.trim() || "";
    if (note.length < 4) {
      notify("Укажите причину отклонения длиной не менее 4 символов.");
      return;
    }
  } else if (!window.confirm("Подтвердить результаты тестов и одобрить повышение?")) {
    return;
  }
  const application = (await api("/api/applications")).applications
    .find((item) => Number(item.id) === Number(button.dataset.id));
  if (!application) throw new Error("Заявка на повышение больше недоступна.");
  const lawBundle = Array.isArray(application.promotion_data?.lawTests) &&
    ["ak", "uk", "pk"].every((subject) => application.promotion_data.lawTests.includes(subject));
  const criteria = status === "approved" && application.stage_role === "Юрист"
    ? lawBundle
      ? { practiceVerified: true }
      : { callsVerified: true, trialLawsuitVerified: true, interviewPassed: true }
    : status === "approved" && application.stage_role === "Стажер КА"
      ? Number(application.career_flow) === 1 ? { headApproved: true } : { lectureVerified: true }
      : {};
  await api(`/api/applications/${encodeURIComponent(button.dataset.id)}/review`, {
    method: "PATCH",
    body: { status, note, criteria }
  });
  notify(status === "approved" ? "Повышение одобрено." : "Заявка отклонена, тесты этапа снова доступны.");
  await loadAppeals();
}

const rpPracticeLevelNames = {
  rp_easy: "Первый уровень",
  rp_medium: "Второй уровень",
  rp_hard: "Третий уровень"
};

function renderPromotionPractice(data) {
  const panel = $("#promotion-practice-panel");
  panel.classList.toggle("hidden", !data.eligible);
  if (!data.eligible) return;
  promotionPracticeState = data;
  $("#promotion-practice-role").textContent = data.stageRole;
  const slots = data.slots || [];
  const resolvedCount = slots.filter((slot) => slot.skipped ||
    (slot.partnerName && (slot.evidenceUrl || slot.hasImage))).length;
  const careerCasesComplete = data.stageRole !== "Юрист" || !data.lawBundle ||
    (data.rpPracticeCompletedCaseIds || []).length >= Number(data.rpPracticeRequiredCount || 3);
  const careerSlotsLocked = data.stageRole === "Юрист" && data.lawBundle && !careerCasesComplete;
  $("#promotion-practice-instructions").textContent = data.lawBundle
    ? data.stageRole === "Стажер КА"
      ? "Стажёру достаточно пройти один базовый AI Case. Совместные задержания с адвокатом не требуются."
      : careerCasesComplete
        ? "После трёх базовых AI Case добавьте два подтверждения совместных вызовов с адвокатом."
        : "Сначала пройдите три базовых AI Case. После этого откроются два подтверждения совместных вызовов с адвокатом."
    : "Заполните три обязательных слота и прикрепите ссылку на откат или скриншот. Остальные три можно выполнить или пропустить.";
  const isNewCareerFlow = Boolean(data.lawBundle);
  const traineeStage = data.stageRole === "Стажер КА";
  const checklist = $("#promotion-practice-checklist");
  checklist.innerHTML = isNewCareerFlow
    ? renderCareerRequirements({
      stageRole: data.stageRole,
      passedSubjects: data.passedLawSubjects || [],
      cases: data.rpPracticeCases || [],
      requiredCaseCount: Number(data.rpPracticeRequiredCount || 0),
      completedCaseCount: (data.rpPracticeCompletedCaseIds || []).length,
      slots,
      evidenceRequiredCount: Number(data.evidenceRequiredCount || 0)
    })
    : "";
  checklist.classList.toggle("hidden", !isNewCareerFlow);
  $("#promotion-practice-progress").textContent = isNewCareerFlow
    ? traineeStage
      ? `${data.rpPracticeCompletedCaseIds.length}/${data.rpPracticeRequiredCount} AI Case`
      : careerSlotsLocked
        ? `${data.rpPracticeCompletedCaseIds.length}/${data.rpPracticeRequiredCount} AI Case`
        : `${data.evidenceCompletedCount}/2 ссылок`
    : `${resolvedCount} из 6`;
  $("#promotion-practice-slots").classList.toggle("hidden",
    (isNewCareerFlow && traineeStage) || careerSlotsLocked);
  $("#promotion-practice-slots").innerHTML = slots.map((slot) => {
    const optional = !isNewCareerFlow && Number(slot.slotNo) > 3;
    const proofLinks = [
      slot.evidenceUrl
        ? `<a href="${escapeHtml(slot.evidenceUrl)}" target="_blank" rel="noopener noreferrer">Открыть ссылку</a>`
        : "",
      slot.photoUrl
        ? `<a href="${escapeHtml(slot.photoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(slot.imageName || "Скриншот")}</a>`
        : ""
    ].filter(Boolean);
    return `<article class="promotion-practice-slot${slot.skipped ? " is-skipped" : ""}" data-practice-slot="${Number(slot.slotNo)}">
      <div class="promotion-practice-slot-heading">
        <h3>Слот ${Number(slot.slotNo)}</h3>
        <span class="badge ${optional ? "badge-info" : "badge-gold"}">${optional ? "МОЖНО СКИП" : "ОБЯЗАТЕЛЬНЫЙ"}</span>
      </div>
      ${slot.skipped ? `<p class="promotion-practice-skipped">Слот пропущен. При желании заполните его вместо скипа.</p>` : ""}
      <label>Адвокат на совместном вызове
        <input class="input" type="text" maxlength="80" required data-practice-partner value="${escapeHtml(slot.partnerName)}" ${data.submittedAt ? "disabled" : ""}>
      </label>
      <label>Ссылка на откат
        <input class="input" type="url" maxlength="500" placeholder="https://..." data-practice-evidence value="${escapeHtml(slot.evidenceUrl)}" ${data.submittedAt ? "disabled" : ""}>
      </label>
      <label>Скриншот (необязательно, JPG / PNG / WebP, до 2 МБ)
        <input class="input" type="file" accept="image/jpeg,image/png,image/webp" data-practice-image ${data.submittedAt ? "disabled" : ""}>
      </label>
      ${proofLinks.length ? `<p class="promotion-practice-proof">${proofLinks.join(" · ")}</p>` : ""}
      <div class="promotion-practice-slot-actions">
        <button class="btn btn-gold" type="button" data-action="save-promotion-practice-slot" data-slot="${Number(slot.slotNo)}"
          ${data.submittedAt ? "disabled" : ""}>Сохранить слот</button>
        ${optional ? `<button class="btn" type="button" data-action="skip-promotion-practice-slot" data-slot="${Number(slot.slotNo)}"
          ${data.submittedAt ? "disabled" : ""}>Скип</button>` : ""}
      </div>
    </article>`;
  }).join("");
  const status = $("#promotion-practice-status");
  const submitButton = $("#submit-promotion-practice");
  const readiness = $("#promotion-practice-readiness");
  submitButton.dataset.applicationId = String(data.applicationId || "");
  submitButton.classList.toggle("hidden", !data.canSubmit);
  submitButton.disabled = !data.canSubmit;
  submitButton.textContent = data.submittedAt ? "Заявка отправлена" : "Подать заявку на повышение";
  if (data.submittedAt) {
    status.textContent = "Заявка отправлена. ГКА или ЗГКА рассмотрят её в разделе обращений.";
    readiness.textContent = "Редактирование слотов закрыто после отправки.";
  } else if (isNewCareerFlow && traineeStage) {
    status.textContent = "Стажёру нужно пройти один из трёх базовых AI Case. Совместные задержания с адвокатом не требуются.";
    readiness.textContent = data.canSubmit
      ? "Все условия выполнены. Подтвердите подачу заявки на юриста."
      : data.readinessMessage || "Заявка откроется после сдачи тестов и базовой AI-практики.";
  } else if (careerSlotsLocked) {
    status.textContent = "Сначала пройдите три базовых AI Case. Подтверждения совместных вызовов пока закрыты.";
    readiness.textContent = `Пройдено AI Case: ${data.rpPracticeCompletedCaseIds.length}/${data.rpPracticeRequiredCount}.`;
  } else if (isNewCareerFlow) {
    status.textContent = "Для повышения до адвоката пройдите три базовых AI Case и приложите подтверждения двух совместных вызовов с адвокатом.";
    readiness.textContent = data.canSubmit
      ? "Все условия выполнены. Подтвердите подачу заявки на адвоката."
      : data.readinessMessage || "Заявка откроется после сдачи тестов, практик и двух совместных вызовов.";
  } else if (data.practiceComplete) {
    status.textContent = "Практика выполнена: обязательные слоты заполнены, дополнительные заполнены или пропущены.";
    readiness.textContent = data.canSubmit
      ? "Все требования текущего этапа выполнены — можно отправить заявку."
      : data.readinessMessage || "Сначала сдайте необходимые тесты и выполните остальные условия этапа.";
  } else {
    status.textContent = "Заполните три обязательных слота. Для слотов 4–6 добавьте задержание или нажмите «Скип».";
    readiness.textContent = data.readinessMessage || "Заявка на повышение станет доступна после выполнения практики и тестов.";
  }
}

function maybeOfferCareerPromotion(data, { force = false } = {}) {
  if (!data?.lawBundle || !data.canSubmit || data.submittedAt ||
      careerOfferPromptActive || (!force && data.offerDeclinedAt)) return;
  careerOfferApplicationId = Number(data.applicationId);
  if (!Number.isSafeInteger(careerOfferApplicationId) || careerOfferApplicationId < 1) return;
  const nextRole = promotionPracticeRanks[data.stageRole];
  $("#career-promotion-offer-description").textContent =
    `Вы сдали АК, УК и ПК и выполнили практику${data.stageRole === "Юрист"
      ? ", включая три базовых AI Case и два вызова с адвокатом"
      : " — один базовый AI Case"}. Хотите подать заявку на повышение до «${nextRole}»? Должность изменится только после одобрения ГКА или ЗГКА.`;
  const dialog = $("#career-promotion-offer-dialog");
  dialog.classList.remove("hidden");
  careerOfferPromptActive = true;
  dialog.querySelector("[data-decision='yes']").focus();
}

async function answerCareerPromotionOffer(button) {
  if (!careerOfferPromptActive || !careerOfferApplicationId) return;
  const dialog = $("#career-promotion-offer-dialog");
  const buttons = $$("[data-action='answer-career-promotion-offer']", dialog);
  const declined = button.dataset.decision !== "yes";
  buttons.forEach((item) => { item.disabled = true; });
  try {
    if (!declined) {
      const result = await api(`/api/applications/${careerOfferApplicationId}/promotion-practice/submit`, {
        method: "POST",
        body: {}
      });
      const warnings = [result.webhookWarning, result.notificationWarning].filter(Boolean).join(" ");
      notify(warnings
        ? `Заявка отправлена. Предупреждение: ${warnings}`
        : "Заявка отправлена. ГКА или ЗГКА рассмотрят её на сайте.");
    } else {
      await api(`/api/applications/${careerOfferApplicationId}/promotion-practice/decline`, {
        method: "POST",
        body: {}
      });
    }
    dialog.classList.add("hidden");
    careerOfferPromptActive = false;
    careerOfferApplicationId = 0;
    if (declined) {
      await loadCareerPath({ showIntro: false });
      notify("Хорошо, заявка не отправлена. Путь можно открыть с главной в любое время.");
      await navigate("dashboard");
      window.history.replaceState(null, "", viewPaths.dashboard);
      return;
    }
    await loadPromotionPractice({ prompt: false });
    await loadTests();
  } finally {
    if (!dialog.classList.contains("hidden")) {
      buttons.forEach((item) => { item.disabled = false; });
    }
  }
}

async function loadPromotionPractice({ prompt = true } = {}) {
  const panel = $("#promotion-practice-panel");
  if (!["Стажер КА", "Юрист"].includes(currentUser.role)) {
    panel.classList.add("hidden");
    promotionPracticeState = null;
    return null;
  }
  const data = await api("/api/promotion-practice");
  renderPromotionPractice(data);
  if (prompt) maybeOfferCareerPromotion(data);
  return data;
}

async function savePromotionPracticeSlot(button) {
  const slotNo = Number(button.dataset.slot);
  const slot = button.closest("[data-practice-slot]");
  const file = slot.querySelector("[data-practice-image]").files[0];
  if (file && file.size > 2 * 1024 * 1024) {
    throw new Error("Скриншот не должен превышать 2 МБ.");
  }
  const body = {
    slotNo,
    partnerName: slot.querySelector("[data-practice-partner]").value.trim(),
    evidenceUrl: slot.querySelector("[data-practice-evidence]").value.trim()
  };
  if (file) body.image = { name: file.name, type: file.type, data: await fileAsBase64(file, "скриншот") };
  await api("/api/promotion-practice/slots", { method: "POST", body });
  notify(`Слот ${slotNo} сохранён.`);
  await loadPromotionPractice();
}

async function skipPromotionPracticeSlot(button) {
  const slotNo = Number(button.dataset.slot);
  await api("/api/promotion-practice/slots", {
    method: "POST",
    body: { slotNo, skip: true }
  });
  notify(`Слот ${slotNo} пропущен.`);
  await loadPromotionPractice();
}

async function submitPromotionPractice(button) {
  const data = promotionPracticeState;
  const applicationId = Number(button.dataset.applicationId || data?.applicationId);
  if (!Number.isSafeInteger(applicationId) || applicationId < 1 || !data?.canSubmit) {
    throw new Error("Сначала сдайте тесты и выполните условия текущего этапа.");
  }
  maybeOfferCareerPromotion(data, { force: true });
}

async function loadRpPractice() {
  if (Object.hasOwn(promotionPracticeRanks, currentUser.role)) {
    await loadPromotionPractice();
    await loadCareerPath();
    return;
  }
  const [data] = await Promise.all([
    api("/api/rp-practice/completions"),
    loadPromotionPractice()
  ]);
  rpPracticeCompleted = new Set(data.completedCaseIds || []);
  renderRpPractice();
}

function startRpPractice(level) {
  if (!Object.hasOwn(rpPracticeLevelNames, level)) {
    notify("Выберите уровень RP-практики.");
    return;
  }
  rpPracticeLevel = level;
  $$("[data-action='start-rp-practice']").forEach((button) => {
    const active = button.dataset.level === level;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderRpPractice();
}

function renderRpPractice() {
  const container = $("#rp-practice-content");
  if (!rpPracticeLevel) {
    container.innerHTML = `<div class="rp-practice-empty">Выберите уровень, чтобы увидеть короткие RP-кейсы. Верно решённые кейсы будут закрыты.</div>`;
    return;
  }
  const cases = rpPracticeCases.filter((question) => question.level === rpPracticeLevel);
  if (!cases.length) {
    container.innerHTML = `<div class="rp-practice-empty">Для этого уровня пока нет кейсов.</div>`;
    return;
  }
  const completedCount = cases.filter((question) => rpPracticeCompleted.has(question.id)).length;
  container.innerHTML = `<div class="rp-level-summary">
      <div><span class="badge badge-gold">${escapeHtml(rpPracticeLevelNames[rpPracticeLevel])}</span>
        <strong>${completedCount} / ${cases.length} пройдено</strong></div>
      <p>${completedCount === cases.length
        ? "Все кейсы этого уровня пройдены. Ожидайте загрузки новых ситуаций."
        : "Решите каждый кейс правильно — он станет закрытым и больше не будет доступен для повторного прохождения."}</p>
    </div>
    <div class="rp-case-list">${cases.map((question, index) => {
      const completed = rpPracticeCompleted.has(question.id);
      const feedback = rpPracticeFeedback.get(question.id);
      return `<article class="rp-case-card${completed ? " is-completed" : ""}">
        <div class="rp-case-meta"><span>Кейс ${String(index + 1).padStart(2, "0")}</span>
          <span>${completed ? "Пройден · закрыт" : escapeHtml(question.category)}</span></div>
        <h3>${escapeHtml(question.question)}</h3>
        <div class="rp-case-options" role="group" aria-label="Варианты ответа">
          ${question.options.map((option, answerIndex) => `<button class="rp-case-option" type="button"
            data-action="answer-rp-case" data-case-id="${escapeHtml(question.id)}" data-index="${answerIndex}"
            ${completed ? "disabled" : ""}>${escapeHtml(option)}</button>`).join("")}
        </div>
        ${feedback ? `<div class="rp-case-explanation ${feedback.correct ? "is-correct" : "is-incorrect"}" role="status">
          <strong>${feedback.correct ? "Верно · кейс закрыт" : "Пока неверно · попробуйте ещё раз"}</strong>
          <p>${escapeHtml(feedback.explanation)}</p>
        </div>` : ""}
      </article>`;
    }).join("")}</div>`;
}

async function answerRpPracticeCase(button) {
  const caseId = button.dataset.caseId;
  if (!caseId || rpPracticeCompleted.has(caseId)) return;
  const answerIndex = Number(button.dataset.index);
  if (!Number.isInteger(answerIndex)) return;
  button.disabled = true;
  try {
    const result = await api("/api/rp-practice/answer", {
      method: "POST",
      body: { caseId, answerIndex }
    });
    rpPracticeFeedback.set(caseId, {
      correct: result.correct,
      explanation: result.explanation
    });
    if (result.completed) rpPracticeCompleted.add(caseId);
    renderRpPractice();
  } finally {
    if (button.isConnected && !rpPracticeCompleted.has(caseId)) button.disabled = false;
  }
}

async function openRpPhone() {
  rpPhoneReturnFocus = document.activeElement;
  $("#rp-phone-dialog").classList.remove("hidden");
  document.body.classList.add("rp-phone-open");
  await loadRpPhoneCustomCases();
  renderRpPhone();
  $("[data-action='close-rp-phone']").focus();
}

function closeRpPhone() {
  $("#rp-phone-dialog").classList.add("hidden");
  document.body.classList.remove("rp-phone-open");
  const returnFocus = rpPhoneReturnFocus;
  rpPhoneReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function toggleRpPhoneSound() {
  rpPhoneSoundEnabled = !rpPhoneSoundEnabled;
  const button = $("#rp-phone-sound-toggle");
  button.setAttribute("aria-pressed", String(rpPhoneSoundEnabled));
  button.setAttribute("aria-label", `${rpPhoneSoundEnabled ? "Выключить" : "Включить"} звуковые эффекты`);
  button.querySelector("span").textContent = rpPhoneSoundEnabled ? "Звук включён" : "Звук выключен";
}

function playRpPhoneReaction(correct, finished, won) {
  if (!rpPhoneSoundEnabled) return;
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return;
  if (!rpPhoneAudioContext) {
    try {
      rpPhoneAudioContext = new AudioContextConstructor();
    } catch (error) {
      notify(`Не удалось запустить звуковые эффекты: ${error.message}`);
      return;
    }
  }
  const context = rpPhoneAudioContext;
  const tones = correct
    ? [
      { frequency: 190, endFrequency: 130, delay: 0, duration: 0.18, type: "sawtooth", volume: 0.045 },
      { frequency: 145, endFrequency: 105, delay: 0.14, duration: 0.23, type: "sawtooth", volume: 0.04 }
    ]
    : [
      { frequency: 410, endFrequency: 360, delay: 0, duration: 0.12, type: "triangle", volume: 0.035 },
      { frequency: 310, endFrequency: 265, delay: 0.13, duration: 0.16, type: "triangle", volume: 0.04 }
    ];
  if (finished) tones.push(won
    ? { frequency: 520, endFrequency: 790, delay: 0.3, duration: 0.25, type: "triangle", volume: 0.045 }
    : { frequency: 245, endFrequency: 155, delay: 0.3, duration: 0.28, type: "sawtooth", volume: 0.04 });
  const playTones = () => {
    const now = context.currentTime;
    for (const tone of tones) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startsAt = now + tone.delay;
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, startsAt);
      oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, startsAt + tone.duration);
      gain.gain.setValueAtTime(tone.volume, startsAt);
      gain.gain.exponentialRampToValueAtTime(0.001, startsAt + tone.duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startsAt);
      oscillator.stop(startsAt + tone.duration);
    }
  };
  if (context.state === "suspended") {
    context.resume()
      .then(playTones)
      .catch(() => notify("Браузер не разрешил воспроизвести звук. Проверьте настройки аудио."));
    return;
  }
  playTones();
}

function setRpPhoneMood(mood, label) {
  const safeMood = ["neutral", "smug", "tense", "angry"].includes(mood) ? mood : "neutral";
  $("#rp-cop-avatar").className = `cop-avatar-wrap mood-${safeMood}`;
  $("#rp-phone-mood").className = `cop-mood-pill ${safeMood}`;
  $("#rp-phone-mood").textContent = label;
  $("#rp-cop-flush").setAttribute("opacity", safeMood === "angry" ? "0.32" : safeMood === "tense" ? "0.12" : "0");
  $("#rp-cop-vein").setAttribute("opacity", safeMood === "angry" ? "1" : "0");
  $("#rp-cop-brow-left").setAttribute("d", safeMood === "angry" ? "M33 29 47 36" : safeMood === "smug" ? "M34 30 Q40 27 47 32" : "M34 33 47 34");
  $("#rp-cop-brow-right").setAttribute("d", safeMood === "angry" ? "M67 29 53 36" : safeMood === "smug" ? "M53 34 66 34" : "M53 34 66 33");
  $("#rp-cop-mouth").setAttribute("d", safeMood === "angry" ? "M42 59 Q50 53 58 59" : safeMood === "smug" ? "M43 56 Q51 59 58 53" : "M44 56 56 56");
}

function findRpPhoneScenario(caseId) {
  return rpInterviewCases.find((item) => item.id === caseId) ||
    rpPhoneCustomCases.find((item) => item.id === caseId);
}

async function loadRpPhoneCustomCases() {
  if (promotionPracticeRanks[currentUser.role]) {
    rpPhoneCustomCases = [];
    rpCareerPracticeProgress = await api("/api/rp-career-practice");
    const completed = new Set(rpCareerPracticeProgress.completedCaseIds || []);
    for (const item of rpCareerPracticeProgress.cases || []) {
      const scenario = rpInterviewCases.find((entry) => entry.id === item.id);
      if (scenario) scenario.completed = completed.has(item.id);
    }
    return;
  }
  rpCareerPracticeProgress = null;
  const data = await api("/api/rp-custom-cases");
  rpPhoneCustomCases = data.cases || [];
}

async function startRpPhoneCase(caseId) {
  const scenario = findRpPhoneScenario(caseId);
  if (!scenario) throw new Error("Интерактивный кейс не найден.");
  const careerPractice = Boolean(rpCareerPracticeProgress?.caseIds?.includes(caseId));
  if (careerPractice) {
    if (rpCareerPracticeProgress.completedCaseIds.includes(caseId)) return;
    await api("/api/rp-career-practice/start", { method: "POST", body: { caseId } });
  }
  const node = scenario.nodes[scenario.startNode];
  if (!node) throw new Error("У кейса не настроено начало диалога.");
  rpPhoneSession = {
    caseId,
    careerPractice,
    nodeId: scenario.startNode,
    step: 1,
    leverage: 50,
    mood: "neutral",
    moodLabel: "Спокоен",
    finished: false,
    lastDebrief: "",
    history: [
      { sender: "system", text: "AI Case · Вызов принят" },
      { sender: "cop", text: node.copText }
    ]
  };
  renderRpPhone();
}

async function answerRpPhoneChoice(index) {
  if (!rpPhoneSession || rpPhoneSession.finished || rpPhoneAnswerPending) return;
  rpPhoneAnswerPending = true;
  renderRpPhone();
  try {
    await applyRpPhoneChoice(index);
  } finally {
    rpPhoneAnswerPending = false;
    renderRpPhone();
  }
}

async function applyRpPhoneChoice(index) {
  if (!rpPhoneSession || rpPhoneSession.finished) return;
  const scenario = findRpPhoneScenario(rpPhoneSession.caseId);
  if (!scenario) throw new Error("Интерактивный кейс не найден.");
  const node = scenario.nodes[rpPhoneSession.nodeId];
  const choice = node?.choices?.[index];
  if (!choice) return;
  const careerPracticeResult = rpPhoneSession.careerPractice
    ? await api("/api/rp-career-practice/answer", {
      method: "POST",
      body: { caseId: rpPhoneSession.caseId, choiceIndex: index }
    })
    : null;
  const nextNode = scenario.nodes[choice.next];
  if (!nextNode) throw new Error("В сценарии не найден следующий вопрос.");
  if (careerPracticeResult &&
      careerPracticeResult.finished !== Boolean(nextNode.isEnd)) {
    throw new Error("Состояние карьерного RP-кейса не совпало с сервером. Начните кейс заново.");
  }
  rpPhoneSession.history.push({ sender: "lawyer", text: choice.text });
  rpPhoneSession.leverage = Math.max(0, Math.min(100, rpPhoneSession.leverage + choice.delta));
  rpPhoneSession.lastDebrief = choice.debrief;
  rpPhoneSession.nodeId = choice.next;
  rpPhoneSession.step += 1;
  rpPhoneSession.finished = Boolean(nextNode.isEnd);
  const caseWon = scenario.custom
    ? rpPhoneSession.leverage >= 50
    : nextNode.won;
  const responseMood = scenario.custom && !rpPhoneSession.finished
    ? choice.delta > 0
      ? scenario.officerKindness >= 4 ? "tense" : "angry"
      : scenario.officerKindness === 1 ? "angry" : scenario.officerKindness === 2 ? "tense" : "smug"
    : "";
  rpPhoneSession.mood = rpPhoneSession.finished
    ? caseWon ? "angry" : "smug"
    : responseMood || (choice.delta > 0 ? "angry" : "smug");
  rpPhoneSession.moodLabel = rpPhoneSession.finished
    ? caseWon ? "Злится · победа защиты" : "Ухмыляется · ошибка защиты"
    : rpPhoneSession.mood === "tense"
      ? "Напряжён"
      : rpPhoneSession.mood === "angry"
        ? "Злится"
        : rpPhoneSession.mood === "neutral" ? "Спокоен" : "Ухмыляется";
  rpPhoneSession.history.push({ sender: "cop", text: nextNode.copText });
  if (nextNode.isEnd) {
    rpPhoneSession.history.push({
      sender: "system",
      text: caseWon ? "ИТОГ · доверитель освобождён" : "ИТОГ · доверитель отправлен под стражу"
    });
    if (rpPhoneSession.careerPractice) {
      scenario.completed = Boolean(careerPracticeResult.completed);
      if (!scenario.completed) {
        rpPhoneSession.history.push({
          sender: "system",
          text: "Практика не засчитана. Повторите кейс и добейтесь успешного исхода."
        });
      } else {
        rpCareerPracticeProgress.completedCaseIds = careerPracticeResult.completedCaseIds;
      }
    }
    if (scenario.custom && scenario.ownerId === Number(currentUser.id)) {
      await api(`/api/rp-custom-cases/${Number(scenario.id.slice("custom-".length))}/complete`, {
        method: "POST",
        body: {}
      });
      scenario.completed = true;
    }
  }
  playRpPhoneReaction(choice.delta > 0, rpPhoneSession.finished, caseWon);
  renderRpPhone();
  if (careerPracticeResult?.completed) {
    await Promise.all([
      loadPromotionPractice(),
      loadCareerPath()
    ]);
  }
}

async function startNextRpPhoneCase() {
  const currentIndex = rpInterviewCases.findIndex((item) => item.id === rpPhoneSession?.caseId);
  if (currentIndex < 0 || !rpInterviewCases.length) {
    showRpPhonePicker();
    return;
  }
  const next = rpInterviewCases[(currentIndex + 1) % rpInterviewCases.length];
  await startRpPhoneCase(next.id);
}

function renderRpPhone() {
  const picker = $("#rp-phone-case-picker");
  const conversation = $("#rp-phone-conversation");
  const session = rpPhoneSession;
  picker.classList.toggle("hidden", Boolean(session));
  conversation.classList.toggle("hidden", !session);
  $("#rp-phone-clock").textContent = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
  const soundButton = $("#rp-phone-sound-toggle");
  soundButton.setAttribute("aria-pressed", String(rpPhoneSoundEnabled));
  soundButton.setAttribute("aria-label", `${rpPhoneSoundEnabled ? "Выключить" : "Включить"} звуковые эффекты`);
  soundButton.querySelector("span").textContent = rpPhoneSoundEnabled ? "Звук включён" : "Звук выключен";
  if (!session) {
    $("#rp-phone-title").textContent = "AI Case";
    $("#rp-phone-subtitle").textContent = "Выберите RP-ситуацию";
    $("#rp-phone-step").textContent = "Подготовка";
    $("#rp-phone-chance").textContent = "Шанс защиты · 50%";
    $("#rp-phone-leverage").style.width = "50%";
    setRpPhoneMood("neutral", "Спокоен");
    const careerMode = Boolean(rpCareerPracticeProgress);
    const scenarios = careerMode
      ? rpCareerPracticeProgress.cases.map((item) => rpInterviewCases.find((scenario) => scenario.id === item.id))
        .filter(Boolean)
      : [...rpInterviewCases, ...rpPhoneCustomCases];
    picker.innerHTML = `<div class="rp-phone-picker-intro"><span class="badge badge-gold">AI CASE · СИМУЛЯТОР</span>
      <h2>Выберите дело</h2><p>${careerMode
        ? `Для этапа «${escapeHtml(rpCareerPracticeProgress.stageRole)}» доступны три базовые практики. Пройдено: ${rpCareerPracticeProgress.completedCaseIds.length}/${rpCareerPracticeProgress.requiredCount}.`
        : "Каждое решение меняет ход разговора. Выберите кейс, защитите доверителя и доведите дело до нужного исхода."}</p></div>
      ${careerMode ? "" : `<button class="btn btn-gold" type="button" data-action="create-rp-custom-case">Создать свой кейс</button>`}
      ${scenarios.map((scenario, index) => {
        const completed = Boolean(careerMode && rpCareerPracticeProgress.completedCaseIds.includes(scenario.id));
        return `<button class="rp-phone-scenario${completed ? " is-completed" : ""}" type="button"
        data-action="select-rp-phone-case" data-case-id="${escapeHtml(scenario.id)}" ${completed ? "disabled" : ""}>
        <span class="rp-scenario-index">${String(index + 1).padStart(2, "0")}</span>
        <span><strong>${escapeHtml(scenario.title)}</strong><small>${escapeHtml(scenario.subtitle)}</small>
          <em>${completed ? "✓ Пройдено · " : ""}${escapeHtml(scenario.copName)} · ${escapeHtml(scenario.copDept)}${scenario.custom
            ? ` · ${escapeHtml(scenario.status === "public" ? "Публичный кейс" : scenario.ownerName || "Личный кейс")}`
            : ""}</em></span>
        <b aria-hidden="true">→</b>
      </button>`;
      }).join("")}`;
    return;
  }

  const scenario = findRpPhoneScenario(session.caseId);
  const node = scenario?.nodes[session.nodeId];
  if (!scenario || !node) throw new Error("Текущий диалог не найден.");
  $("#rp-phone-title").textContent = scenario.copName;
  $("#rp-phone-subtitle").textContent = scenario.copDept;
  $("#rp-phone-step").textContent = `Ход ${session.step}${session.finished ? " · завершено" : ""}`;
  $("#rp-phone-chance").textContent = `Шанс защиты · ${session.leverage}%`;
  $("#rp-phone-leverage").style.width = `${session.leverage}%`;
  setRpPhoneMood(session.mood, session.moodLabel);
  $("#rp-phone-messages").innerHTML = session.history.map((message) =>
    message.sender === "system"
      ? `<div class="msg-system">${escapeHtml(message.text)}</div>`
      : `<div class="rp-chat-bubble ${message.sender === "cop" ? "msg-cop" : "msg-lawyer"}">${escapeHtml(message.text)}</div>`
  ).join("");
  $("#rp-phone-debrief").innerHTML = session.lastDebrief
    ? `<div class="rp-phone-debrief-card"><strong>Разбор выбранного ответа</strong><p>${escapeHtml(session.lastDebrief)}</p></div>`
    : "";
  const customCaseControls = scenario.custom && scenario.ownerId === Number(currentUser.id)
    ? scenario.status === "public"
      ? `<p class="text-muted">Кейс уже опубликован для сотрудников.</p>`
      : scenario.status === "pending"
        ? `<p class="text-muted">Кейс ожидает решения ГКА в Discord.</p>`
        : scenario.completed
          ? `<button class="btn btn-gold" type="button" data-action="publish-rp-custom-case"
              data-case-id="${escapeHtml(scenario.id)}">Опубликовать</button>`
          : ""
    : "";
  $("#rp-phone-choices").innerHTML = session.finished
    ? `<div class="rp-phone-end-actions">
         <button class="btn btn-gold" type="button" data-action="rp-phone-back">Назад к делам</button>
         ${session.careerPractice && scenario.completed ? "" : `<button class="rp-phone-repeat" type="button" data-action="restart-rp-phone">Повторить диалог</button>`}
         ${customCaseControls}
       </div>`
    : `<button class="btn" type="button" data-action="rp-phone-back">Назад к делам</button>
      ${node.choices.map((choice, index) => `<button class="choice-reply-btn" type="button"
        data-action="answer-rp-phone" data-index="${index}" ${rpPhoneAnswerPending ? "disabled" : ""}><span class="rp-reply-number">${index + 1}</span>${escapeHtml(choice.text)}</button>`
      ).join("")}`;
  $("#rp-phone-messages").scrollTop = $("#rp-phone-messages").scrollHeight;
}

function showRpPhonePicker() {
  rpPhoneSession = null;
  renderRpPhone();
}

function openRpCustomCaseForm() {
  const scaleOptions = [1, 2, 3, 4, 5].map((level) =>
    `<option value="${level}">${level}</option>`
  ).join("");
  const depthOptions = [1, 2, 3, 4, 5].map((level) =>
    `<option value="${level}">${level} · ${[0, 3, 6, 12, 24, 48][level]} вопросов</option>`
  ).join("");
  openModal("Создать свой AI Case", `<form id="rp-custom-case-form" class="activity-report-form">
    <label>Основа ситуации
      <textarea class="input" name="details" minlength="10" maxlength="1500" rows="5" required
        placeholder="Опишите задержание, сотрудника ведомства и обстоятельства дела"></textarea>
    </label>
    <label>Сложность
      <select class="input" name="difficulty" required>${scaleOptions}</select>
    </label>
    <label>Доброта госслужащего
      <select class="input" name="officerKindness" required>${scaleOptions}</select>
    </label>
    <label>Углублённое понимание дела
      <select class="input" name="depth" required>${depthOptions}</select>
    </label>
    <p class="text-muted">Количество вопросов задаёт глубина: 3, 6, 12, 24 или 48. У каждого вопроса будет 3 варианта ответа.</p>
    <div class="table-actions">
      <button class="btn btn-gold" type="submit">Создать кейс с ИИ</button>
      <button class="btn" type="button" data-action="close-document">Отмена</button>
    </div>
  </form>`);
}

async function createRpCustomCase(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector("button[type='submit']");
  submitButton.disabled = true;
  submitButton.textContent = "ИИ создаёт кейс…";
  try {
    const formData = new FormData(form);
    const result = await api("/api/rp-custom-cases", {
      method: "POST",
      body: {
        details: String(formData.get("details") || "").trim(),
        difficulty: Number(formData.get("difficulty")),
        officerKindness: Number(formData.get("officerKindness")),
        depth: Number(formData.get("depth"))
      }
    });
    rpPhoneCustomCases = [result.case, ...rpPhoneCustomCases.filter((item) => item.id !== result.case.id)];
    closeModal();
    notify(`Личный кейс готов: ${result.case.questions.length} вопросов.`);
    startRpPhoneCase(result.case.id);
  } finally {
    if (submitButton.isConnected) {
      submitButton.disabled = false;
      submitButton.textContent = "Создать кейс с ИИ";
    }
  }
}

async function publishRpCustomCase(button) {
  const caseId = String(button.dataset.caseId || "");
  const numericId = Number(caseId.replace(/^custom-/, ""));
  if (!Number.isSafeInteger(numericId) || numericId < 1) throw new Error("Не удалось определить личный кейс.");
  const result = await api(`/api/rp-custom-cases/${numericId}/publish`, {
    method: "POST",
    body: {}
  });
  const scenario = rpPhoneCustomCases.find((item) => item.id === caseId);
  if (scenario) scenario.status = result.status;
  notify("Кейс отправлен в Discord на проверку ГКА.");
  renderRpPhone();
}

function renderMemo() {
  $("#memoChecklist").innerHTML = memoItems.map((item, index) =>
    `<label class="memo-check"><input type="checkbox" data-memo-item="${index}"><span>${escapeHtml(item)}</span></label>`
  ).join("");
}

async function copyMemo() {
  const checked = $$("[data-memo-item]:checked").map((input) => memoItems[Number(input.dataset.memoItem)]);
  const text = ["Памятка адвоката", ...memoItems.map((item, index) =>
    `${checked.includes(item) ? "[x]" : "[ ]"} ${item}`
  )].join("\n");
  await navigator.clipboard.writeText(text);
  notify("Шаблон памятки скопирован.");
}

async function loadAwards() {
  const status = await api("/api/discord/status");
  const data = status.linked ? await api("/api/profile") : { awards: [], achievements: [] };
  const awards = (data.awards || []).map((award) => ({
    title: award.title,
    description: award.description || "Награда Коллегии",
    date: award.created_at,
    tier: award.kind === "elite" ? "legendary" : "gold"
  }));
  const achievements = (data.achievements || []).map((achievement) => ({
    title: achievement.title,
    description: achievement.description || "Достижение профиля",
    date: achievement.awarded_at,
    tier: "silver"
  }));
  const items = [...awards, ...achievements];
  $("#awardsGrid").innerHTML = items.length ? items.map((item) =>
    `<article class="award-card tier-${escapeHtml(item.tier)}">
      <span class="award-emblem"><svg class="icon icon-lg"><use href="/web/icons-sprite.svg#icon-12_achievements_badges"></use></svg></span>
      <h3 class="award-title">${escapeHtml(item.title)}</h3>
      <p class="award-desc">${escapeHtml(item.description)}</p>
      ${item.date ? `<span class="award-date">${escapeHtml(item.date)}</span>` : ""}
    </article>`
  ).join("") : emptyState("Наград и достижений пока нет.");
  await loadDiscordSettings(status);
}

function renderDiscordPreferenceButton() {
  const button = $("#discord-dm-toggle");
  if (!button) return;
  button.textContent = discordDmEnabled ? "Выключить уведомления" : "Включить уведомления";
  button.classList.toggle("is-enabled", discordDmEnabled);
  button.classList.toggle("is-disabled", !discordDmEnabled);
  button.setAttribute("aria-pressed", String(discordDmEnabled));
  button.disabled = !discordSettings?.linked || !discordSettings?.botCanDm;
}

async function loadDiscordSettings(discordStatus = null) {
  const [settings, notifications] = await Promise.all([
    discordStatus ? Promise.resolve(discordStatus) : api("/api/discord/status"),
    api("/api/notifications")
  ]);
  discordSettings = settings;
  discordDmEnabled = Boolean(notifications.discordDmEnabled);
  const connected = Boolean(discordSettings.linked);
  const statusPill = $("#discord-link-status");
  const connectButton = $("#discord-connect");
  const unlinkButton = $("#discord-unlink");
  const preference = $("#discord-dm-toggle");
  statusPill.textContent = connected
    ? `Привязан: ${discordSettings.username || "Discord"}`
    : "Discord не привязан";
  connectButton.disabled = connected || !discordSettings.configured;
  connectButton.classList.toggle("hidden", connected);
  unlinkButton.classList.toggle("hidden", !connected);
  preference.classList.toggle("hidden", !connected);
  renderDiscordPreferenceButton();

  const message = connected
    ? discordSettings.botCanDm
      ? discordDmEnabled
        ? "Личные сообщения бота разрешены. Нажмите зелёную кнопку, если хотите их выключить."
        : "Личные сообщения бота выключены. Нажмите красную кнопку, чтобы снова получать уведомления."
      : "Discord привязан, но бот не настроен для личных сообщений."
    : discordSettings.configured
      ? "Подключите Discord, чтобы получать личные уведомления. Привязку можно сменить в любой момент."
      : "Привязка необязательна. Для подключения Discord владелец сайта должен настроить OAuth.";
  $("#discord-status-message").textContent = message;
}

async function connectDiscord() {
  const result = await api("/api/discord/link", { method: "POST", body: {} });
  window.location.assign(result.authorizeUrl);
}

async function unlinkDiscord() {
  if (!window.confirm("Отвязать текущий Discord от аккаунта? После этого можно будет подключить другой.")) return;
  const result = await api("/api/discord/unlink", { method: "POST", body: {} });
  currentUser.discordLinked = false;
  currentUser.discordUsername = "";
  currentUser.discordAvatarUrl = "";
  renderUserAvatar($("#user-avatar"), currentUser);
  renderUserAvatar($("#welcome-avatar"), currentUser);
  await loadDiscordSettings();
  notify(result.discordWarning
    ? `Discord отвязан. ${result.discordWarning}`
    : "Discord отвязан. Теперь можно подключить другой аккаунт.");
}

async function toggleDiscordDmPreference(button) {
  button.disabled = true;
  try {
    const result = await api("/api/notifications/preferences", {
      method: "PATCH",
      body: { discordDmEnabled: !discordDmEnabled }
    });
    discordDmEnabled = Boolean(result.discordDmEnabled);
    renderDiscordPreferenceButton();
    notify(discordDmEnabled
      ? "Бот снова будет присылать уведомления в ЛС."
      : "Бот больше не будет присылать уведомления в ЛС.");
  } catch (error) {
    throw error;
  } finally {
    renderDiscordPreferenceButton();
  }
}

async function loadRating() {
  try {
    const period = $("#rating-period").value || "all";
    const data = await api(`/api/attorneys?period=${encodeURIComponent(period)}`);
    const rows = data.attorneys || [];
    $("#ratingTableBody").innerHTML = rows.length ? rows.map((attorney, index) =>
      `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(attorney.display_name)}</td>
        <td>${escapeHtml(attorney.role)}</td>
        <td>${Number(attorney.calls || 0)}</td>
        <td>${Number(attorney.bails || 0)}</td>
        <td>${Number(attorney.lawsuit_count || 0)}</td>
        <td>${Number(attorney.score || 0).toFixed(1)}</td>
      </tr>`
    ).join("") : `<tr><td colspan="7">${emptyState("Адвокатов в рейтинге пока нет.")}</td></tr>`;
  } catch (error) {
    $("#ratingTableBody").innerHTML = `<tr><td colspan="7">${escapeHtml(error.message)}</td></tr>`;
    throw error;
  }
}

async function loadAudit() {
  const [memberData, reprimandData] = await Promise.all([
    api("/api/members"),
    api("/api/reprimands")
  ]);
  const members = memberData.members || [];
  const reprimands = reprimandData.reprimands || [];
  $("#audit-test-notifications").classList.toggle("hidden", currentUser.username !== "yyte");
  auditMembers = members;
  auditReprimandCounts = new Map();
  reprimands.forEach((item) => auditReprimandCounts.set(
    Number(item.user_id), (auditReprimandCounts.get(Number(item.user_id)) || 0) + 1
  ));
  $("#reprimand-member").innerHTML = `<option value="">Выберите сотрудника</option>${members
    .filter((member) => member.status === "active" && member.role !== "Гражданин" &&
      Number(member.id) !== Number(currentUser.id) &&
      (currentUser.hasFullGkaAccess || (member.role !== "ГКА" && !member.hasFullGkaAccess)))
    .map((member) => `<option value="${Number(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("")}`;
  renderAuditMembers();
}

function renderAuditMembers() {
  const search = $("#audit-search").value.trim().toLocaleLowerCase("ru");
  const statusLabels = { active: "Активен", pending: "Ожидает одобрения", suspended: "Приостановлен" };
  const members = auditMembers.filter((member) => [
    member.display_name,
    member.username,
    member.role,
    member.status,
    statusLabels[member.status] || ""
  ].join(" ").toLocaleLowerCase("ru").includes(search));
  $("#audit-member-count").textContent = search
    ? `Найдено ${members.length} из ${auditMembers.length}`
    : `Всего аккаунтов: ${auditMembers.length}`;
  $("#auditTableBody").innerHTML = members.length ? members.map((member) =>
    `<tr>
      <td>${escapeHtml(member.display_name)}<br><span class="text-muted">#${Number(member.id)}</span></td>
      <td>${escapeHtml(displayRole(member))}<br>${statusBadge(member.status)}</td>
      <td>${auditReprimandCounts.get(Number(member.id)) || 0}</td>
      <td>${Number(member.document_count || 0)}</td>
      <td>${Number(member.lawsuit_count || 0)}</td>
      <td>${(managerRoles.includes(currentUser.role) || currentUser.hasFullGkaAccess) && Number(member.id) !== Number(currentUser.id) ? `<div class="member-controls">
        ${member.role !== "Гражданин" && (currentUser.role === "ГКА" || currentUser.hasFullGkaAccess) ? `
          <select class="input" data-member-role="${Number(member.id)}" data-original-role="${escapeHtml(member.role)}" aria-label="Должность: ${escapeHtml(member.display_name)}">
            ${roles.map((role) => `<option value="${escapeHtml(role)}"${role === member.role ? " selected" : ""}>${escapeHtml(role)}</option>`).join("")}
          </select>
          <button class="btn" type="button" data-action="update-member-role" data-id="${Number(member.id)}" disabled>Сохранить</button>
          <button class="btn" type="button" data-action="update-member-status" data-id="${Number(member.id)}" data-status="${member.status === "active" ? "suspended" : "active"}">${member.status === "pending" ? "Одобрить" : member.status === "suspended" ? "Восстановить" : "Приостановить"}</button>` : ""}
        ${managerRoles.includes(currentUser.role) ? `<button class="btn" type="button" data-action="dismiss-member" data-id="${Number(member.id)}">${member.role === "Гражданин" ? "Удалить гражданина" : "Уволить и удалить"}</button>` : ""}
      </div>` : "—"}</td>
    </tr>`
  ).join("") : `<tr><td colspan="6">${emptyState(search ? "Совпадений не найдено." : "Состав коллегии пуст.")}</td></tr>`;
}

async function loadGiveaway() {
  const data = await api("/api/giveaway");
  $("#giveaway-status").textContent = data.enabled ? "Конкурс идёт" : "Начисление на паузе";
  $("#giveaway-status").classList.toggle("is-active", data.enabled);
  $("#giveaway-status").classList.toggle("is-paused", !data.enabled);
  $("#giveaway-period").textContent = `${displayDate(data.weekStart)} — ${displayDate(data.weekEnd)}`;
  $("#giveaway-total-points").textContent = Number(data.totalPoints || 0).toLocaleString("ru-RU");
  $("#giveaway-participants").textContent = Number(data.participantCount || 0).toLocaleString("ru-RU");
  const standings = data.standings || [];
  $("#giveaway-ranking").innerHTML = standings.length ? standings.map((member) =>
    `<article class="giveaway-ranking-row${member.rank === 1 ? " is-leader" : ""}">
      <span class="giveaway-rank">${Number(member.rank)}</span>
      <span class="giveaway-ranking-person">
        <strong>${escapeHtml(member.displayName)}</strong>
        <small>${escapeHtml(member.role)}</small>
      </span>
      <span class="giveaway-ranking-metric">
        <span>${Number(member.calls)} выз.</span>
        <small>по 1 баллу</small>
      </span>
      <span class="giveaway-ranking-metric">
        <span>${Number(member.bails)} залог.</span>
        <small>по 2 балла</small>
      </span>
      <strong class="giveaway-ranking-score">${Number(member.points)} б.</strong>
    </article>`
  ).join("") : emptyState("На этой неделе пока нет подтверждённых отчётов.");
}

async function updateMemberRole(button) {
  const memberId = Number(button.dataset.id);
  const select = $(`[data-member-role="${memberId}"]`);
  const result = await api(`/api/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    body: { role: select.value }
  });
  const warnings = [result.discordWarning, result.nicknameWarning, result.logWarning].filter(Boolean);
  notify(warnings.length ? `Должность сохранена. ${warnings.join(" ")}` : "Должность сотрудника сохранена.");
  await loadAudit();
}

async function updateMemberStatus(button) {
  const status = button.dataset.status;
  if (status === "suspended" && !window.confirm("Приостановить доступ этому сотруднику?")) return;
  const result = await api(`/api/members/${encodeURIComponent(button.dataset.id)}`, {
    method: "PATCH",
    body: { status }
  });
  const warnings = [result.discordWarning, result.nicknameWarning, result.logWarning].filter(Boolean);
  notify(warnings.length ? `Доступ сотрудника обновлён. ${warnings.join(" ")}` : "Доступ сотрудника обновлён.");
  await loadAudit();
}

async function dismissMember(button) {
  const reason = window.prompt("Укажите причину удаления аккаунта (от 4 до 1000 символов):", "")?.trim() || "";
  if (reason.length < 4 || reason.length > 1000) {
    notify("Причина должна содержать от 4 до 1000 символов.");
    return;
  }
  if (!window.confirm("Аккаунт и связанные с ним данные будут удалены без возможности восстановления. Продолжить?")) return;
  const result = await api(`/api/members/${encodeURIComponent(button.dataset.id)}/dismiss`, {
    method: "POST",
    body: { reason }
  });
  const warnings = [result.dmWarning, result.discordWarning].filter(Boolean);
  notify(warnings.length
    ? `Аккаунт удалён. ${warnings.join(" ")}`
    : "Аккаунт и связанные данные удалены.");
  await loadAudit();
}

async function purgeAllMembers() {
  if (currentUser.role !== "ГКА" && !currentUser.hasFullGkaAccess) {
    notify("Массовое удаление доступно только руководителю с полным доступом.");
    return;
  }
  const reason = window.prompt("Укажите общую причину удаления аккаунтов (от 4 до 1000 символов):", "")?.trim() || "";
  if (reason.length < 4 || reason.length > 1000) {
    notify("Причина должна содержать от 4 до 1000 символов.");
    return;
  }
  if (!window.confirm("Будут безвозвратно удалены все аккаунты и данные, кроме вашего текущего аккаунта. Продолжить?")) return;
  const confirmation = window.prompt("Для подтверждения введите: УДАЛИТЬ ВСЕ", "")?.trim() || "";
  if (confirmation !== "УДАЛИТЬ ВСЕ") {
    notify("Массовое удаление отменено: подтверждение не совпало.");
    return;
  }
  const result = await api("/api/members/purge-all", {
    method: "POST",
    body: { reason, confirmation }
  });
  const deliveryWarnings = (result.warnings || []).length;
  notify(deliveryWarnings
    ? `Удалено аккаунтов: ${Number(result.deletedCount)}. Для ${deliveryWarnings} аккаунтов не удалось отправить уведомление или снять Discord-роли.`
    : `Удалено аккаунтов: ${Number(result.deletedCount)}. Ваш текущий аккаунт сохранён.`);
  await loadAudit();
}

async function testAuditNotification(button) {
  if (currentUser.username !== "yyte") {
    throw new Error("Тестовые уведомления доступны только владельцу аккаунта.");
  }
  const result = await api("/api/notifications/test", {
    method: "POST",
    body: { type: button.dataset.type }
  });
  notify(result.warning
    ? `Тестовое уведомление сохранено, но Discord не доставил ЛС: ${result.warning}`
    : result.discordSent
      ? "Тестовое сообщение отправлено только в ваш Discord."
      : "Тест записан в уведомлениях портала; отправка ЛС отключена.");
  await loadNotifications();
}

function fileAsBase64(file, label = "фотографию выговора") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error(`Не удалось прочитать ${label}.`));
      else resolve(value.slice(comma + 1));
    });
    reader.addEventListener("error", () => reject(new Error(`Не удалось прочитать ${label}.`)));
    reader.readAsDataURL(file);
  });
}

async function submitReprimand(event) {
  event.preventDefault();
  const file = $("#reprimand-photo").files[0];
  if (!file) {
    notify("Приложите фотографию к выговору.");
    return;
  }
  const photo = {
    name: file.name,
    type: file.type,
    data: await fileAsBase64(file)
  };
  const result = await api("/api/reprimands", {
    method: "POST",
    body: {
      userId: Number($("#reprimand-member").value),
      reason: $("#reprimand-reason").value.trim(),
      photo
    }
  });
  $("#reprimand-form").reset();
  notify(`Выговор #${result.id} оформлен.`);
  await loadAudit();
}

function formatReportPeriod(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error("Выберите корректный месяц отчёта.");
  return value;
}

async function loadMonthlyReports() {
  const period = formatReportPeriod($("#reportPeriod").value);
  const data = await api(`/api/reports?period=${encodeURIComponent(period)}`);
  const totals = data.totals || {};
  const summary = reportMetrics.map(([key, label]) =>
    `<div><strong>${Number(totals[key] || 0)}</strong><br><span class="text-muted">${label}</span></div>`
  ).join("");
  const rows = data.rows || [];
  $("#reportsFeed").innerHTML = `
    <div class="report-summary">${summary}</div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Сотрудник</th><th>Должность</th>${reportMetrics.map(([, label]) => `<th>${label}</th>`).join("")}</tr></thead>
        <tbody>${rows.length ? rows.map((row) => `<tr>
          <td>${escapeHtml(row.displayName)}</td><td>${escapeHtml(row.role)}</td>
          ${reportMetrics.map(([key]) => `<td>${Number(row[key] || 0)}</td>`).join("")}
        </tr>`).join("") : `<tr><td colspan="${reportMetrics.length + 2}">${emptyState("Нет записей за выбранный период.")}</td></tr>`}</tbody>
      </table>
    </div>
    <p class="text-muted">Отчёт за ${escapeHtml(data.period)} · сформирован ${escapeHtml(data.generatedAt || "")}</p>`;
}

async function loadActivityReports() {
  const restricted = currentUser.role === "Юрист";
  $("#activity-report-form").classList.toggle("hidden", restricted);
  $("#activity-report-restriction").classList.toggle("hidden", !restricted);
  if (restricted) {
    $("#activity-reports-title").textContent = "Отчёты появятся после одобрения";
    $("#activity-report-list").innerHTML = "";
    return;
  }
  const data = await api("/api/activity-reports");
  const reports = data.reports || [];
  $("#activity-reports-title").textContent = data.canReview ? "Отчёты на одобрение" : "Мои отчёты";
  $("#activity-report-list").innerHTML = reports.length ? reports.map((report) => `
    <article class="activity-report-card">
      <div class="activity-report-heading">
        <strong>${escapeHtml(activityReportLabels[report.report_type] || report.report_type)}</strong>
        ${statusBadge(report.status)}
      </div>
      <div class="activity-report-meta">
        ${escapeHtml(report.occurred_at)} · ${escapeHtml(report.reference)}
        ${data.canReview ? ` · ${escapeHtml(report.reporter_name)} (${escapeHtml(report.reporter_role)})` : ""}
      </div>
      <p>${escapeHtml(report.details)}</p>
      ${report.attachment_name ? `<a class="activity-report-attachment" href="/api/activity-reports/${Number(report.id)}/photo" target="_blank" rel="noopener">
        <img src="/api/activity-reports/${Number(report.id)}/photo" alt="Фото-доказательство к отчёту">
        <span>${escapeHtml(report.attachment_name)}</span>
      </a>` : ""}
      ${report.decision ? `<p class="activity-report-meta">Решение ГКА: ${escapeHtml(report.decision)}</p>` : ""}
      ${data.canReview && report.status === "pending" ? `
        <div class="activity-report-actions">
          <button class="btn btn-gold" type="button" data-action="review-activity-report" data-id="${Number(report.id)}" data-status="approved">Одобрить</button>
          <button class="btn" type="button" data-action="review-activity-report" data-id="${Number(report.id)}" data-status="rejected">Отклонить</button>
        </div>` : ""}
    </article>`).join("") : emptyState(data.canReview ? "Нет отправленных отчётов." : "Вы ещё не отправляли отчёты.");
}

function renderActivityReportPhoto() {
  const preview = $("#activity-report-photo-preview");
  if (!activityReportPhoto) {
    preview.innerHTML = "";
    preview.classList.add("hidden");
    return;
  }
  preview.innerHTML = `<img src="${activityReportPhotoUrl}" alt="Предпросмотр фото отчёта">
    <div><strong>${escapeHtml(activityReportPhoto.name)}</strong>
      <button class="text-button" type="button" data-action="remove-activity-report-photo">Удалить фото</button>
    </div>`;
  preview.classList.remove("hidden");
}

function updateActivityReportFields() {
  const reportType = $("#activity-report-type").value;
  const callOption = $("#activity-report-type option[value='call']");
  const canSubmitCall = ["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(currentUser?.role);
  callOption.hidden = !canSubmitCall;
  if (!canSubmitCall && reportType === "call") $("#activity-report-type").value = "bail";
  const isCallReport = $("#activity-report-type").value === "call";
  $("#activity-report-photo-field").classList.toggle("hidden", !isCallReport);
  $("#activity-report-upload-hint").classList.toggle("hidden", !isCallReport);
  if (!isCallReport) clearActivityReportPhoto();
}

async function setActivityReportPhoto(file) {
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Выберите изображение JPG, PNG или WebP.");
  }
  if (file.size > 15 * 1024 * 1024) throw new Error("Размер фото не должен превышать 15 МБ.");
  const requestId = ++activityReportPhotoRequest;
  activityReportPhoto = null;
  activityReportPhotoUrl = "";
  renderActivityReportPhoto();
  const dataUrl = await readActivityReportPhoto(file);
  if (requestId !== activityReportPhotoRequest) return;
  activityReportPhoto = file;
  activityReportPhotoUrl = dataUrl;
  renderActivityReportPhoto();
}

function clearActivityReportPhoto() {
  activityReportPhotoRequest += 1;
  activityReportPhoto = null;
  activityReportPhotoUrl = "";
  $("#activity-report-photo").value = "";
  renderActivityReportPhoto();
}

function handleActivityReportPaste(event) {
  if (!$("#view-reports").classList.contains("active")) return;
  const imageItem = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith("image/"));
  const file = imageItem?.getAsFile();
  if (!file) return;
  event.preventDefault();
  setActivityReportPhoto(file)
    .then(() => {
      if (activityReportPhoto === file) notify("Скриншот добавлен к отчёту.");
    })
    .catch((error) => notify(error.message));
}

function readActivityReportPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Не удалось прочитать фото отчёта."));
        return;
      }
      resolve(reader.result);
    });
    reader.addEventListener("error", () => reject(new Error("Не удалось прочитать фото отчёта.")));
    reader.readAsDataURL(file);
  });
}

async function loadReports() {
  await loadActivityReports();
  if (isManager()) await loadMonthlyReports();
}

async function submitActivityReport(event) {
  event.preventDefault();
  const reportType = $("#activity-report-type").value;
  const photo = reportType === "call" ? activityReportPhoto : null;
  if (reportType === "call" && !photo) throw new Error("Добавьте фото-доказательство к отчёту о вызове.");
  const photoData = photo ? activityReportPhotoUrl : null;
  const result = await api("/api/activity-reports", {
    method: "POST",
    body: {
      reportType,
      occurredAt: $("#activity-report-date").value,
      details: $("#activity-report-details").value.trim(),
      ...(photo ? { photo: {
        name: photo.name,
        type: photo.type,
        data: photoData
      } } : {})
    }
  });
  $("#activity-report-form").reset();
  clearActivityReportPhoto();
  updateActivityReportFields();
  $("#activity-report-date").value = localDateValue();
  notify("Отчёт отправлен ГКА на одобрение. Уведомление в Discord появится после одобрения.");
  await loadActivityReports();
}

async function reviewActivityReport(button) {
  const status = button.dataset.status;
  const decision = status === "rejected"
    ? window.prompt("Укажите причину отказа (не менее 4 символов):", "")?.trim() || ""
    : "";
  if (status === "rejected" && decision.length < 4) {
    notify("Для отказа укажите причину длиной не менее 4 символов.");
    return;
  }
  const result = await api(`/api/activity-reports/${encodeURIComponent(button.dataset.id)}`, {
    method: "PATCH",
    body: { status, decision }
  });
  notify(status === "approved"
    ? result.warning
      ? `Отчёт одобрен и учтён в статистике, но Discord не уведомлён: ${result.warning}`
      : "Отчёт одобрен, учтён в статистике и отправлен в Discord."
    : "Отчёт отклонён.");
  await loadReports();
}

async function startNewWeek() {
  const preview = await api("/api/weekly-reset/preview");
  const counts = Object.entries(preview.counts || {}).map(([key, value]) => `${key}: ${value}`).join(", ");
  if (!window.confirm(`Запустить новую неделю? В архив будут перенесены: ${counts || "данные отчётного периода"}.`)) return;
  const result = await api("/api/weekly-reset", { method: "POST", body: { confirmed: true } });
  const warnings = result.discordWarnings || [];
  notify(warnings.length
    ? `Новая неделя запущена, архив создан, но отчёт не доставлен в Discord: ${warnings.join(" ")}`
    : "Новая неделя запущена, архив создан. Итоги опубликованы в канале Discord.");
  if (result.run?.counts) await loadAudit();
}

async function viewDocument(id) {
  const data = await api(`/api/documents/${encodeURIComponent(id)}`);
  const document = data.document;
  openModal(document.title || "Заявление", `<p class="text-muted">${escapeHtml(document.template || "")} · ${escapeHtml(document.created_at || "")}</p>
    <pre class="document-content">${escapeHtml(document.bbcode || "")}</pre>
    ${document.forum_url ? `<p><a href="${escapeHtml(document.forum_url)}" target="_blank" rel="noopener noreferrer"><svg class="icon icon-sm"><use href="/web/icons-sprite.svg#icon-18_external_link_portal"></use></svg> Открыть тему на форуме</a></p>` : ""}`);
}

async function viewLawsuitHistory(id) {
  const data = await api(`/api/lawsuits/${encodeURIComponent(id)}/history`);
  const history = data.history || [];
  openModal(`История иска #${id}`, history.length
    ? `<div class="laws-list">${history.map((item) =>
      `<article class="laws-item"><strong>${escapeHtml(item.event_type)}</strong><p>${escapeHtml(item.details || "")}</p><small>${escapeHtml(item.actor_name || "Система")} · ${escapeHtml(item.created_at || "")}</small></article>`
    ).join("")}</div>`
    : emptyState("История пока пуста."));
}

async function reviewLawsuit(button) {
  const current = button.dataset.status;
  const choices = current === "submitted"
    ? ["in_review", "rejected"]
    : current === "in_review"
      ? ["hearing", "decided", "rejected"]
      : ["decided", "rejected"];
  const choice = window.prompt(`Новый статус: ${choices.join(", ")}`, choices[0]);
  if (!choice || !choices.includes(choice)) return;
  const decision = ["decided", "rejected"].includes(choice)
    ? window.prompt("Укажите результат или причину (минимум 4 символа):", "")
    : "";
  if (["decided", "rejected"].includes(choice) && (!decision || decision.trim().length < 4)) {
    notify("Для итогового решения нужна причина длиной от 4 символов.");
    return;
  }
  await api(`/api/lawsuits/${encodeURIComponent(button.dataset.id)}`, {
    method: "PATCH",
    body: { status: choice, decision: decision || "" }
  });
  notify("Решение по иску сохранено.");
  await loadLawsuits();
}

async function handleAppealAction(button) {
  const id = encodeURIComponent(button.dataset.id);
  if (button.dataset.action === "application-details") {
    const data = await api("/api/applications");
    const item = data.applications.find((application) => Number(application.id) === Number(button.dataset.id));
    if (!item) throw new Error("Обращение больше недоступно.");
    openModal(`Обращение #${item.id}`, `<p><strong>Заявитель:</strong> ${escapeHtml(item.display_name || "")}</p>
      <p><strong>Тип:</strong> ${escapeHtml(item.type || "")}</p>
      <p><strong>Статус:</strong> ${escapeHtml(statusNames[item.status] || item.status || "")}</p>
      <pre class="document-content">${escapeHtml(item.details || "")}</pre>`);
    return;
  }
  if (button.dataset.action === "assign-appeal") {
    await api(`/api/applications/${id}/assign`, { method: "PATCH", body: {} });
    notify("Обращение назначено вам.");
  } else {
    await api(`/api/applications/${id}/close`, { method: "PATCH", body: {} });
    notify("Обращение завершено.");
  }
  await loadAppeals();
}

async function logout() {
  if (!window.confirm("Выйти из аккаунта?")) return;
  await api("/api/auth/logout", { method: "POST", body: {} });
  csrfToken = "";
  showAuth();
}

function toggleSidebar() {
  const sidebar = $("#sidebar");
  if (window.matchMedia("(max-width: 768px)").matches) sidebar.classList.toggle("mobile-open");
  else sidebar.classList.toggle("collapsed");
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === "toggle-sidebar") toggleSidebar();
  else if (action === "toggle-notifications") await toggleNotifications(button);
  else if (action === "read-all-notifications") await readAllNotifications();
  else if (action === "open-notification") await openNotification(button);
  else if (action === "connect-discord") await connectDiscord();
  else if (action === "unlink-discord") await unlinkDiscord();
  else if (action === "toggle-discord-dm") await toggleDiscordDmPreference(button);
  else if (action === "test-audit-notification") await testAuditNotification(button);
  else if (action === "review-activity-report") await reviewActivityReport(button);
  else if (action === "remove-activity-report-photo") clearActivityReportPhoto();
  else if (action === "select-photozot-group") {
    activePhotozotGroup = button.dataset.group;
    renderPhotozotGroup();
  }
  else if (action === "toggle-career") {
    const expanded = $("#careerSubmenu").classList.toggle("open");
    button.setAttribute("aria-expanded", String(expanded));
  }
  else if (action === "start-career-path") await startCareerPath();
  else if (action === "career-path-intro") await continueCareerPathIntro();
  else if (action === "career-path-dismiss") await dismissCareerPathIntro();
  else if (action === "career-path-study") await completeCareerPathStudy();
  else if (action === "career-path-open-view") await openCareerPathView(button);
  else if (action === "career-path-open-practice") await openCareerPathPractice(button);
  else if (action === "career-path-open-ai") await openCareerPathAi();
  else if (action === "toggle-lawsuit-form") $("#lawsuit-form").classList.toggle("hidden");
  else if (action === "ask-ai-laws") await askAiAssistant("laws");
  else if (action === "ask-ai-lawsuit") await askAiAssistant("lawsuit");
  else if (action === "copy-ai-laws") await copyAiAnswer(aiLawsAnswer);
  else if (action === "copy-ai-lawsuit") await copyAiAnswer(aiLawsuitAnswer);
  else if (action === "insert-ai-facts") insertAiLawsuitFacts();
  else if (action === "submit-appeal") await submitAppeal();
  else if (action === "start-career-exam") await startExam();
  else if (action === "start-law-exam") await startExam(button.dataset.subject);
  else if (action === "toggle-interview") await toggleInterview(button);
  else if (action === "start-rp-practice") startRpPractice(button.dataset.level);
  else if (action === "answer-rp-case") await answerRpPracticeCase(button);
  else if (action === "open-rp-phone") await openRpPhone();
  else if (action === "close-rp-phone") closeRpPhone();
  else if (action === "toggle-rp-phone-sound") toggleRpPhoneSound();
  else if (action === "select-rp-phone-case") await startRpPhoneCase(button.dataset.caseId);
  else if (action === "answer-rp-phone") await answerRpPhoneChoice(Number(button.dataset.index));
  else if (action === "next-rp-phone-case") await startNextRpPhoneCase();
  else if (action === "rp-phone-back") showRpPhonePicker();
  else if (action === "restart-rp-phone") await startRpPhoneCase(rpPhoneSession?.caseId);
  else if (action === "create-rp-custom-case") openRpCustomCaseForm();
  else if (action === "publish-rp-custom-case") await publishRpCustomCase(button);
  else if (action === "copy-lawsuit-bbcode") await copyLawsuitBbcode();
  else if (action === "copy-memo") await copyMemo();
  else if (action === "start-new-week") await startNewWeek();
  else if (action === "load-reports") await loadReports();
  else if (action === "refresh-giveaway") await loadGiveaway();
  else if (action === "update-member-role") await updateMemberRole(button);
  else if (action === "update-member-status") await updateMemberStatus(button);
  else if (action === "dismiss-member") await dismissMember(button);
  else if (action === "purge-all-members") await purgeAllMembers();
  else if (action === "view-document") await viewDocument(button.dataset.id);
  else if (action === "lawsuit-history") await viewLawsuitHistory(button.dataset.id);
  else if (action === "review-lawsuit") await reviewLawsuit(button);
  else if (action === "review-forum-link") await reviewForumLink(button);
  else if (action === "review-career-promotion") await reviewCareerPromotion(button);
  else if (action === "save-promotion-practice-slot") await savePromotionPracticeSlot(button);
  else if (action === "skip-promotion-practice-slot") await skipPromotionPracticeSlot(button);
  else if (action === "submit-promotion-practice") await submitPromotionPractice(button);
  else if (action === "answer-career-promotion-offer") await answerCareerPromotionOffer(button);
  else if (action === "refresh-promotion-decree") await loadPromotionDecrees();
  else if (action === "preview-promotion-decree") await previewPromotionDecree();
  else if (action === "send-promotion-decree") await sendPromotionDecree();
  else if (["application-details", "assign-appeal", "close-appeal"].includes(action)) await handleAppealAction(button);
  else if (action === "select-attorney") await selectAttorney(button.dataset.id);
  else if (action === "attorney-profile") await viewAttorneyProfile(button.dataset.id);
  else if (action === "close-document") {
    if ($("#document-dialog").dataset.purpose === "career-path-intro") await dismissCareerPathIntro();
    else closeModal();
  }
  else if (action === "close-photo-viewer") closePhotoViewer();
  else if (action === "close-quiz") {
    $("#quiz-dialog").classList.add("hidden");
    quizSession = null;
  }
}

async function handleClick(event) {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    event.preventDefault();
    const viewName = viewButton.dataset.view;
    if (!currentUser || !viewIsAllowed(viewName) || !viewPaths[viewName]) {
      await navigate(viewName);
      return;
    }
    window.location.assign(viewPaths[viewName]);
    return;
  }
  const photoLink = event.target.closest(".photozot-card a");
  if (photoLink) {
    event.preventDefault();
    openPhotoViewer(photoLink.href, photoLink.querySelector("img")?.alt || "Фото территории", photoLink);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  try {
    await handleAction(button);
  } catch (error) {
    notify(error.message);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      body: {
        username: $("#login-username").value.trim(),
        password: $("#login-password").value
      }
    });
    await enterSession(session);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
}

async function handleRegistration(event) {
  event.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const accountType = $("#registration-kind").value;
    const firstName = $("#register-first-name").value.trim();
    const lastName = $("#register-last-name").value.trim();
    if (!/^[A-Za-zА-Яа-яЁё]{2,40}$/.test(firstName) || !/^[A-Za-zА-Яа-яЁё]{2,40}$/.test(lastName)) {
      throw new Error("Укажите имя и фамилию отдельно: только буквы, от 2 символов.");
    }
    const session = await api("/api/auth/register", {
      method: "POST",
      body: {
        accountType,
        username: $("#register-username").value.trim(),
        displayName: `${firstName} ${lastName}`,
        firstName,
        lastName,
        password: $("#register-password").value
      }
    });
    await enterSession(session);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
}

document.addEventListener("click", (event) => {
  handleClick(event).catch((error) => notify(error.message));
});
document.addEventListener("paste", handleActivityReportPaste);
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && !event.target.closest(".notification-center")) {
    $("#notification-panel").classList.add("hidden");
    $("#notification-toggle").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("change", (event) => {
  if (event.target.closest("#promotion-decree-candidates")) {
    invalidatePromotionDecreePreview(event.target);
    return;
  }
  if (event.target.closest("#activity-report-type")) {
    updateActivityReportFields();
    return;
  }
  const photoInput = event.target.closest("#activity-report-photo");
  if (photoInput) {
    if (photoInput.files[0]) {
      setActivityReportPhoto(photoInput.files[0]).catch((error) => {
        clearActivityReportPhoto();
        notify(error.message);
      });
    } else clearActivityReportPhoto();
    return;
  }
  const select = event.target.closest("[data-member-role]");
  if (!select) return;
  const saveButton = select.closest(".member-controls").querySelector('[data-action="update-member-role"]');
  saveButton.disabled = select.value === select.dataset.originalRole;
});
document.addEventListener("input", (event) => {
  if (event.target instanceof Element) invalidatePromotionDecreePreview(event.target);
});

$("#login-form").addEventListener("submit", (event) => {
  handleLogin(event).catch((error) => notify(error.message));
});
$("#register-form").addEventListener("submit", (event) => {
  handleRegistration(event).catch((error) => notify(error.message));
});
$("#quiz-form").addEventListener("submit", (event) => {
  submitQuiz(event).catch((error) => notify(error.message));
});
$("#reprimand-form").addEventListener("submit", (event) => {
  submitReprimand(event).catch((error) => notify(error.message));
});
$("#activity-report-form").addEventListener("submit", (event) => {
  submitActivityReport(event).catch((error) => notify(error.message));
});
document.addEventListener("submit", (event) => {
  if (event.target instanceof HTMLFormElement && event.target.id === "rp-custom-case-form") {
    createRpCustomCase(event).catch((error) => notify(error.message));
  }
});
$("#lawsuit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitLawsuit().catch((error) => notify(error.message));
});
$("#lawsuitsTableBody").addEventListener("submit", (event) =>
  submitForumLink(event).catch((error) => notify(error.message))
);
$("#logout-button").addEventListener("click", () => logout().catch((error) => notify(error.message)));
$("#pending-logout").addEventListener("click", () => logout().catch((error) => notify(error.message)));
$("#login-open").addEventListener("click", () => showAuth());
$("#show-login").addEventListener("click", () => authMode("login"));
$("#show-register").addEventListener("click", () => authMode("register"));
$("#lawsSearch").addEventListener("input", filterLaws);
$$("[data-laws-tab]").forEach((button) => {
  button.addEventListener("click", () => switchLawsTab(button.dataset.lawsTab));
});
$("#lawsuit-template").addEventListener("change", renderLawsuitFields);
$("#lawsuit-form").addEventListener("input", renderLawsuitPreview);
$("#law-promotion-form").addEventListener("submit", (event) =>
  submitLawPromotionData(event).catch((error) => notify(error.message)));
document.addEventListener("pointerdown", beginStampRotation);
document.addEventListener("pointermove", rotateStamp);
document.addEventListener("pointerup", finishStampRotation);
document.addEventListener("pointercancel", finishStampRotation);
$("#rating-period").addEventListener("change", () => {
  if (currentUser && currentView === "rating") loadRating().catch((error) => notify(error.message));
});
$("#audit-search").addEventListener("input", renderAuditMembers);
$("#document-dialog").addEventListener("click", (event) => {
  if (event.target !== $("#document-dialog")) return;
  const dismiss = $("#document-dialog").dataset.purpose === "career-path-intro"
    ? dismissCareerPathIntro()
    : Promise.resolve(closeModal());
  dismiss.catch((error) => notify(error.message));
});
$("#career-promotion-offer-dialog").addEventListener("click", (event) => {
  if (event.target !== $("#career-promotion-offer-dialog")) return;
  const dismissButton = $("#career-promotion-offer-dialog").querySelector("[data-decision='no']");
  answerCareerPromotionOffer(dismissButton).catch((error) => notify(error.message));
});
$("#photo-viewer").addEventListener("click", (event) => {
  if (event.target === $("#photo-viewer")) closePhotoViewer();
});
$("#rp-phone-dialog").addEventListener("click", (event) => {
  if (event.target === $("#rp-phone-dialog")) closeRpPhone();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#document-dialog").dataset.purpose === "career-path-intro") {
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissCareerPathIntro().catch((error) => notify(error.message));
    return;
  }
  if (event.key === "Escape" && !$("#career-promotion-offer-dialog").classList.contains("hidden")) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const dismissButton = $("#career-promotion-offer-dialog").querySelector("[data-decision='no']");
    answerCareerPromotionOffer(dismissButton).catch((error) => notify(error.message));
    return;
  }
  if (event.key === "Escape" && !$("#rp-phone-dialog").classList.contains("hidden")) {
    event.preventDefault();
    closeRpPhone();
    return;
  }
  if (event.key === "Escape" && !$("#photo-viewer").classList.contains("hidden")) {
    event.preventDefault();
    closePhotoViewer();
  }
});
$("#quiz-dialog").addEventListener("click", (event) => {
  if (event.target === $("#quiz-dialog")) {
    $("#quiz-dialog").classList.add("hidden");
    quizSession = null;
  }
});

async function initialize() {
  authMode("login");
  renderLawsuitFields();
  const now = new Date();
  $("#reportPeriod").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  $("#activity-report-date").value = localDateValue(now);
  renderMemo();
  authMode("login");
  try {
    const session = await api("/api/auth/me");
    csrfToken = session.csrfToken || "";
    if (session.user) await enterSession(session);
    else showAuth();
  } catch (error) {
    showAuth(error.message);
  }
}

function initializeSnow() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.className = "snow-layer";
  layer.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 28; index += 1) {
    const flake = document.createElement("span");
    flake.className = "snowflake";
    flake.style.setProperty("--snow-left", `${Math.random() * 100}%`);
    flake.style.setProperty("--snow-size", `${1 + Math.random() * 2.2}px`);
    flake.style.setProperty("--snow-opacity", `${0.2 + Math.random() * 0.35}`);
    flake.style.setProperty("--snow-duration", `${16 + Math.random() * 18}s`);
    flake.style.setProperty("--snow-delay", `${-Math.random() * 32}s`);
    flake.style.setProperty("--snow-drift", `${Math.round(Math.random() * 100 - 50)}px`);
    layer.append(flake);
  }
  document.body.append(layer);
}

initializeSnow();
initialize();
window.setInterval(() => {
  if (currentUser?.status === "active") {
    loadNotifications().catch((error) => console.error("Не удалось обновить уведомления:", error.message));
  }
}, 45000);
