/* ============================================================================
   app.js — логика портала Коллегии адвокатов.

   Модуль отвечает за состояние интерфейса, обращения к API и отрисовку всех
   разделов. Разметка живёт в advokate.html, стили — в web/css, статические
   справочники — в web/js/data/config.js.
   ========================================================================== */
import { escapeHtml, $, $$ } from "./core/dom.js";
import { renderEliteAwards } from "./views/elite-awards.js";
import {
  roles,
  promotion,
  examTracks,
  careerGuides,
  applicationTypes,
  typeLabels,
  lawExamSubjects,
  lawMeta,
  lawReferencePatterns,
  docSchemas
} from "./data/config.js";

let state = { requests: [], laws: {}, documents: [], lawsuits: [], attorneys: [], reprimands: [], tasks: [], events: [], reserve: [], absences: [], characteristics: [], academyMaterials: [], colleagues: [], profileStats: null, profileData: null, achievementData: null, documentCount: 0 };
let dashboardCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let dashboardSelectedDate = new Date();
let calendarViewDate = new Date();
let currentUser = null;
let csrfToken = "";
let googleSheetsConfigured = false;
let latestReportData = null;
let reportLiveTimer = null;
let members = [];
let attestations = [];
let promotionRequirements = { lawyerCallsRequired: 0 };
let applicationFiles = [];
let applicationPreviewUrls = [];
let currentQuiz = null;
let currentAttestationId = 0;
let activeChatId = null;
let chatPollTimer = 0;
let generatedDocumentId = null;
let toastTimer;
let eliteAwardsCatalog = null;

/**
 * Каталог высших наград лежит отдельным JSON-файлом: это контент, а не код.
 * Загружается один раз и переиспользуется при каждой отрисовке раздела.
 */
async function loadEliteAwards() {
  if (eliteAwardsCatalog) return eliteAwardsCatalog;
  try {
    const response = await fetch("/web/data/elite-awards.json", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    eliteAwardsCatalog = await response.json();
  } catch (error) {
    console.error("Не удалось загрузить каталог высших наград:", error.message);
    eliteAwardsCatalog = null;
  }
  return eliteAwardsCatalog;
}

const achievementIcon = (icon) => `<span class="achievement-emblem" title="${escapeHtml(icon || "Достижение")}" aria-label="Значок достижения">
  <svg class="svg-icon" aria-hidden="true"><use href="#i-medal"></use></svg></span>`;
const role = () => currentUser ? currentUser.role : "";
const isManager = () => ["ГКА", "ЗГКА"].includes(role());
function rolePortraitUrl(roleName) {
  const roleFiles = {
    "Стажер КА": "trainee",
    "Юрист": "lawyer",
    "Адвокат": "attorney",
    "Ст.Адвокат": "senior-attorney",
    "ЗГКА": "deputy-head",
    "ГКА": "head"
  };
  return `/assets/role-${roleFiles[roleName] || "trainee"}.png`;
}
function discordPresenceBadge(presence) {
  const status = {
    online: ["Активен", "online"],
    idle: ["Неактивен", "idle"],
    dnd: ["Не беспокоить", "dnd"],
    offline: ["Не в сети", "offline"]
  }[presence] || ["Не в сети", "offline"];
  return `<span class="presence-badge presence-${status[1]}" title="${status[0]}"><i></i>${status[0]}</span>`;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (csrfToken && !["GET", "HEAD"].includes(method)) headers["x-csrf-token"] = csrfToken;
  const response = await fetch(path, {
    ...options, method, headers, credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status}).`);
  return data;
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500);
}

function switchTab(tab) {
  const nav = $(`[data-tab="${tab}"]`);
  if (nav && nav.classList.contains("hidden")) return;
  $$(".page").forEach((page) => page.classList.toggle("active", page.id === "page-" + tab));
  $$(".nav-btn").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
}

function renderRole() {
  const selectedRole = role();
  if (!currentUser) return;
  $("#profile-open").classList.remove("hidden");
  $("#profile-open").dataset.profileId = currentUser.id;
  $("#profile-role").textContent = selectedRole === "ГКА"
    ? "Глава коллегии"
    : selectedRole === "ЗГКА"
      ? "Заместитель главы коллегии"
      : selectedRole === "Гражданин"
        ? "Гражданин"
        : "Сотрудник коллегии";
  $("#profile-name").textContent = currentUser.displayName || "Yuti Prince";
  const avatar = $("#discord-avatar");
  avatar.classList.toggle("hidden", !currentUser.discordAvatarUrl);
  if (currentUser.discordAvatarUrl) avatar.src = currentUser.discordAvatarUrl;
  else avatar.removeAttribute("src");
  $("#applicant-name").value = currentUser.displayName;
  $("#applicant-name").readOnly = true;
  $("#employment-discord").value = currentUser.discordUsername || "";
  const citizen = selectedRole === "Гражданин";
  const canUseDocuments = ["Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(selectedRole);
  $("#nav-applications .nav-label").textContent = isManager() ? "Обращения граждан" : "Мои обращения";
  $("#nav-home").classList.remove("hidden");
  $("#nav-profile").classList.remove("hidden");
  $("#nav-colleagues").classList.toggle("hidden", citizen);
  $("#nav-achievements").classList.toggle("hidden", citizen);
  $("#nav-tasks").classList.toggle("hidden", citizen);
  $("#nav-calendar").classList.toggle("hidden", citizen);
  $("#nav-absence").classList.toggle("hidden", citizen);
  $("#nav-reserve").classList.toggle("hidden", citizen);
  $("#nav-career").classList.toggle("hidden", citizen);
  $("#nav-academy").classList.toggle("hidden", citizen);
  $("#nav-applications").classList.remove("hidden");
  $("#nav-ranking").classList.remove("hidden");
  $("#nav-practice").classList.toggle("hidden", citizen || selectedRole === "Стажер КА");
  $("#nav-lawsuits").classList.toggle("hidden", !canUseDocuments);
  $("#nav-documents").classList.toggle("hidden", !canUseDocuments);
  $("#nav-laws").classList.toggle("hidden", citizen);
  $$("[data-dashboard-action]").forEach((button) => {
    const target = $(`[data-tab="${button.dataset.dashboardAction}"]`);
    button.classList.toggle("hidden", !target || target.classList.contains("hidden"));
  });
  $("#management-nav").classList.toggle("hidden", !isManager());
  $("#nav-characteristics").classList.toggle("hidden", !isManager());
  $("#reports-nav").classList.toggle("hidden", !isManager());
  $("#rating-settings-card").classList.toggle("hidden", !isManager());
  $("#rating-settings-save").classList.toggle("hidden", selectedRole !== "ГКА");
  $("#report-csv").classList.toggle("hidden", selectedRole !== "ГКА");
  $("#weekly-reset-card").classList.toggle("hidden", selectedRole !== "ГКА");
  $("#dashboard-weekly-reset").classList.toggle("hidden", selectedRole !== "ГКА");
  $("#attorneys-nav").classList.toggle("hidden", !citizen);
  $("#recruitment-nav").classList.toggle("hidden", !citizen);
  $("#discipline-nav").classList.toggle("hidden", citizen);
  $("#reprimand-form-card").classList.toggle("hidden", !isManager());
  $("#staff-request-card").classList.toggle("hidden", citizen);
  $("#law-exams").classList.toggle("hidden", citizen);
  $("#create-invite").classList.toggle("hidden", selectedRole !== "ГКА");
  $("#citizen-support-card").classList.toggle("hidden", !["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(selectedRole));
  $("#career-overview").classList.toggle("hidden", citizen);
  $("#citizen-overview").classList.toggle("hidden", !citizen);
  $("#home-help-action").classList.toggle("hidden", !citizen);
  $("#home-primary-action").classList.toggle("hidden", citizen);
  $("#pending-stat").classList.toggle("hidden", citizen);
  $("#document-stat").classList.toggle("hidden", !canUseDocuments);
  $("#lawsuit-stat").classList.toggle("hidden", !canUseDocuments);
  $("#law-stat").classList.toggle("hidden", citizen);
  $("#staff-dashboard-widgets").classList.toggle("hidden", citizen);
  $("#dashboard-collegium-stats").classList.toggle("hidden", !isManager());
  $("#welcome-title").textContent = `Добро пожаловать, ${currentUser.displayName}`;
  $("#welcome-description").textContent = citizen
    ? "Выберите адвоката или отправьте обращение. Вся переписка и статус будут доступны в личном кабинете."
    : `Вы вошли как ${selectedRole}. Покажем только разделы, которые нужны на вашей ступени.`;
  $("#home-primary-action").textContent = ["Стажер КА", "Юрист", "Адвокат"].includes(selectedRole)
    ? "Продолжить путь повышения" : "Открыть мои обращения";
  $("#career-overview-title").textContent = "Мой прогресс";
  $("#career-overview-copy").textContent = careerGuides[selectedRole]?.summary || selectedRole;
  const options = applicationTypes[selectedRole] || [];
  $("#application-type").innerHTML = options.map(([value, label]) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
  $("#request-form").classList.toggle("hidden", citizen || options.length === 0);
  updateApplicationPlaceholder();
  const hasExam = Boolean(examTracks[selectedRole]);
  $("#exam-description").textContent = hasExam
    ? selectedRole === "Стажер КА"
      ? "Ознакомьтесь с коротким планом ниже и ответьте минимум на 4 вопроса из 5. Для перехода стажёра обзвон не нужен."
      : `После теста «${selectedRole} → ${examTracks[selectedRole]}» отметьте готовность к обзвону. Руководство подтвердит результат и условия этапа.`
    : "Для выбранной роли проверка знаний на портале не предусмотрена.";
  $("#exam-card").classList.toggle("hidden", !hasExam || citizen);
  $("#application-hint").textContent = selectedRole === "ЗГКА"
    ? "Для этой роли отключены общие заявки. Решения по составу доступны только в соответствующих разделах."
    : selectedRole === "Гражданин"
      ? "Отправьте запрос на помощь адвоката или жалобу. Заявка будет видна только вам и уполномоченному составу."
    : options.length
      ? "Здесь доступны только дополнительные запросы. Экзамен и обзвон проходят по отдельному пошаговому маршруту."
      : "Для этой роли нет доступных заявок. «Организационный вопрос» больше не используется.";
  $("#request-submit").textContent = "Отправить запрос";
  switchTab("home");
  const requiresDiscordLink = !citizen && !currentUser.discordLinked;
  const requiredDialog = $("#discord-required-dialog");
  if (requiresDiscordLink) {
    if (!requiredDialog.open) requiredDialog.showModal();
    refreshDiscordStatus();
    return;
  }
  if (requiredDialog.open) requiredDialog.close();
  refreshDiscordStatus();
  refreshPortalData();
}

function renderCareerProgress() {
  const guide = careerGuides[role()];
  if (!guide) {
    $("#career-study-card").classList.add("hidden");
    $("#exam-area").innerHTML = "";
    return;
  }
  $("#career-study-card").classList.remove("hidden");
  $("#career-stage-title").textContent = guide.title;
  $("#career-stage-copy").textContent = guide.summary;
  $("#career-guide").innerHTML = `<strong>Перед тестом запомните главное</strong><ul>${guide.points
    .map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>`;
  const stageApplication = state.requests.find((item) =>
    item.user_id === currentUser.id && item.type === "exam" && item.stage_role === role() &&
    item.career_flow && item.status === "pending");
  const approvedStageExam = state.requests.find((item) =>
    item.user_id === currentUser.id && item.type === "exam" && item.stage_role === role() &&
    item.career_flow && item.status === "approved");
  if (!stageApplication) {
    if (approvedStageExam) {
      const promotionReport = state.requests.find((item) =>
        item.user_id === currentUser.id && item.type === "promotion");
      $("#exam-area").innerHTML = `<div class="note">${escapeHtml(approvedStageExam.result || "Тест и обзвон подтверждены.")}</div>
        ${promotionReport?.status === "pending"
          ? `<div class="note warning">Отчёт на повышение уже отправлен. Руководство проверит вызовы, иск и наличие места.</div>`
          : `<p class="help">Следующий шаг — отчёт на повышение: 25 вызовов, 5 совместно с юристом, один принятый иск и подтверждения.</p>
            <button class="btn primary" data-career-promotion type="button">${promotionReport ? "Подать отчёт повторно" : "Подать отчёт на повышение"}</button>`}`;
      $("#exam-area").innerHTML += `<div class="actions"><button class="btn subtle" data-go="applications" type="button">Создать обращение</button></div>`;
      return;
    }
    $("#exam-area").innerHTML = `<button class="btn primary" id="start-exam" type="button">Я ознакомился — начать тест</button>
      <p class="help">Тест: 5 вопросов. Для прохождения нужно правильно ответить минимум на 4.</p>`;
    return;
  }
  const passed = stageApplication.result.includes("пройдена");
  if (!stageApplication.result) {
    $("#exam-area").innerHTML = `<button class="btn primary" id="start-exam" type="button">Начать тест</button>
      <p class="help">Черновик этапа уже сохранён. Результат останется в истории аккаунта.</p>`;
    return;
  }
  if (!passed) {
    $("#exam-area").innerHTML = `<div class="note warning">${escapeHtml(stageApplication.result)}</div>
      <button class="btn primary" id="start-exam" type="button">Попробовать ещё раз</button>`;
    return;
  }
  const promotionData = stageApplication.promotion_data || {};
  const requirementsForm = role() === "Юрист" && !promotionData.trialLawsuitReference
    ? `<form id="junior-requirements-form" class="stack">
        <div class="note">Тест сдан. Теперь добавьте данные о вызовах и пробном иске — руководство проверит их вместе с обзвоном.</div>
        <div class="field"><label for="career-completed-calls">Отработано вызовов (норма руководства: ${Number(promotionRequirements.lawyerCallsRequired || 0) || "не задана"})</label>
          <input id="career-completed-calls" type="number" min="${Number(promotionRequirements.lawyerCallsRequired || 1)}" max="1000" required></div>
        <div class="field"><label for="career-trial-lawsuit">Номер или ссылка на пробный иск</label>
          <input id="career-trial-lawsuit" maxlength="300" required></div>
        <button class="btn small primary" type="submit">Сохранить условия</button>
      </form>`
    : "";
  const interview = stageApplication.stage_role !== "Стажер КА"
    ? `<div class="note ${stageApplication.interview_status === "ready" ? "" : "warning"}">
        ${stageApplication.interview_status === "ready" ? "Вы готовы к обзвону. Руководство получило уведомление."
          : "Обзвон обязателен. Вы можете отметить готовность сейчас или сделать это позже."}
      </div>
      <div class="actions">
        <button class="btn small primary" data-interview="ready" data-id="${stageApplication.id}" type="button">Готов к обзвону</button>
        <button class="btn small" data-interview="waiting" data-id="${stageApplication.id}" type="button">Сейчас не могу</button>
      </div>`
    : "";
  $("#exam-area").innerHTML = `<div class="quiz-result"><strong>${escapeHtml(stageApplication.result)}</strong></div>
    ${requirementsForm}${interview}
    <div class="actions"><button class="btn subtle" data-go="applications" type="button">Создать обращение</button></div>`;
}

function maybeShowWelcome() {
  if (!currentUser || !careerGuides[role()]) return;
  const key = `mirror-welcome:${currentUser.id}:${role()}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "shown");
  if (!$("#welcome-dialog").open) $("#welcome-dialog").showModal();
}

function updateApplicationPlaceholder() {
  const selectedType = $("#application-type").value;
  const staffRequest = ["exam", "promotion"].includes(selectedType);
  $("#passport-field").classList.toggle("hidden", !staffRequest);
  renderApplicationFields();
  $("#application-details").placeholder = role() === "Гражданин"
    ? "Опишите вопрос или жалобу, укажите, как и когда с вами связаться."
    : selectedType === "promotion"
      ? "Кратко опишите выполненную работу и приложите необходимые подтверждения."
      : selectedType === "exam"
        ? "Укажите, когда вы готовы пройти проверку; приложите подтверждение выполненных требований."
        : "Укажите удобное время, суть вопроса, данные по делу или другую важную информацию.";
}

function renderApplicationFields() {
  const type = $("#application-type").value;
  const currentRole = role();
  let fields = "";
  if (type === "exam" && currentRole === "Стажер КА") {
    fields = `<label class="review-check"><input id="lecture-attended" type="checkbox" required>
      <span>Я прослушал лекцию руководящего состава</span></label>`;
  } else if (type === "exam" && currentRole === "Юрист") {
    const required = Number(promotionRequirements.lawyerCallsRequired || 0);
    fields = `<div class="note warning">${required
      ? `Для перехода нужно отработать не менее ${required} вызовов.`
      : "Руководство ещё не установило число вызовов; пока подать заявку на переход нельзя."}</div>
      <div class="field"><label for="completed-calls">Отработано вызовов</label><input id="completed-calls" type="number" min="${required || 1}" max="1000" required></div>
      <div class="field"><label for="trial-lawsuit">Номер или ссылка на пробное исковое заявление</label><input id="trial-lawsuit" maxlength="300" required></div>`;
  } else if (type === "exam" && currentRole === "Адвокат") {
    fields = `<div class="note">Заявка открывает тест. После успешной сдачи руководитель подтверждает результат; роль не меняется автоматически.</div>`;
  } else if (type === "promotion" && currentRole === "Адвокат") {
    fields = `<div class="note warning">Обязательные условия: 25 вызовов, минимум 5 совместно с юристом, принятое исковое заявление, обзвон, свободное место и одобрение ГКА.</div>
      <div class="two-col">
        <div class="field"><label for="completed-calls">Всего отработано вызовов</label><input id="completed-calls" type="number" min="25" max="1000" required></div>
        <div class="field"><label for="calls-with-lawyer">Из них совместно с юристом</label><input id="calls-with-lawyer" type="number" min="5" max="1000" required></div>
      </div>
      <div class="field"><label for="accepted-lawsuit">Номер или ссылка на принятое исковое заявление</label><input id="accepted-lawsuit" maxlength="300" required></div>`;
  }
  $("#promotion-fields").innerHTML = fields;
}

function updateApplicationFiles(event) {
  const selected = Array.from(event.target.files || []);
  const validTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  const totalSize = selected.reduce((sum, file) => sum + file.size, 0);
  if (selected.length > 5 || selected.some((file) => !validTypes.includes(file.type) || file.size > 2 * 1024 * 1024) ||
      totalSize > 5 * 1024 * 1024) {
    event.target.value = "";
    applicationFiles = [];
    applicationPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    applicationPreviewUrls = [];
    $("#attachment-preview").replaceChildren();
    notify("Добавьте до 5 файлов JPG, PNG, WebP или PDF; размер одного — до 2 МБ, общий — до 5 МБ.");
    return;
  }
  applicationFiles = selected;
  applicationPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
  applicationPreviewUrls = [];
  $("#attachment-preview").replaceChildren();
  for (const file of selected) {
    if (!file.type.startsWith("image/")) continue;
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    applicationPreviewUrls.push(image.src);
    image.alt = file.name;
    $("#attachment-preview").append(image);
  }
  if (selected.length) {
    const summary = document.createElement("span");
    summary.className = "help";
    summary.textContent = selected.map((file) => `${file.name} (${Math.ceil(file.size / 1024)} КБ)`).join(" · ");
    $("#attachment-preview").append(summary);
  }
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error(`Не удалось прочитать файл ${file.name}.`));
      else resolve(result.slice(separator + 1));
    };
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function serializeApplicationFiles() {
  return Promise.all(applicationFiles.map(async (file) => ({
    name: file.name,
    type: file.type,
    data: await fileAsBase64(file)
  })));
}

function statusBadge(status) {
  const labels = { pending: "Ожидает рассмотрения", approved: "Одобрена", rejected: "Отклонена" };
  return `<span class="badge ${status}">${labels[status] || "Неизвестный статус"}</span>`;
}

function reviewCriterionDefinitions(request) {
  if (request.type === "promotion" && request.requested_role === "Ст.Адвокат") {
    return [
      ["callsVerified", "Подтверждены 25 вызовов"],
      ["juniorCallsVerified", "Подтверждены минимум 5 вызовов с юристом"],
      ["acceptedLawsuitVerified", "Подтверждено принятое исковое заявление"],
      ["interviewPassed", "Обзвон с руководством пройден"],
      ["vacancyAvailable", "Свободное место есть"],
      ["headApproved", "ГКА одобряет повышение"]
    ];
  }
  if (request.type !== "exam") return [];
  const stage = request.stage_role || request.review_data?.stage || request.current_role;
  if (stage === "Стажер КА") return request.career_flow ? [] : [["lectureVerified", "Лекция руководящего состава прослушана"]];
  if (stage === "Юрист") return request.career_flow
    ? [
        ["callsVerified", "Число вызовов подтверждено"],
        ["trialLawsuitVerified", "Пробное исковое заявление проверено"],
        ["interviewPassed", "Обзвон с руководством пройден"]
      ]
    : [
        ["callsVerified", "Число вызовов подтверждено"],
        ["trialLawsuitVerified", "Пробное исковое заявление проверено"]
      ];
  if (stage === "Адвокат" && request.career_flow) return [["interviewPassed", "Обзвон с руководством пройден"]];
  return [];
}

function requestProgressMarkup(request) {
  const data = request.promotion_data || {};
  const lines = [];
  if (request.type === "employment") {
    if (data.discordUsername) lines.push(`Discord заявителя: @${data.discordUsername}`);
    if (data.gtaName) lines.push(`Имя персонажа: ${data.gtaName}`);
  }
  if (request.passport_id) lines.push(`Паспорт персонажа: ${request.passport_id}`);
  if (request.type === "exam" && data.lectureAttended) lines.push("Заявлено: лекция руководства прослушана");
  if (request.type === "exam" && Number.isFinite(Number(data.completedCalls))) {
    lines.push(`Вызовы: ${data.completedCalls}${data.requiredCalls ? ` из ${data.requiredCalls}` : ""}`);
  }
  if (data.trialLawsuitReference) lines.push(`Пробный иск: ${data.trialLawsuitReference}`);
  if (request.type === "promotion" && data.completedCalls !== undefined) {
    lines.push(`Вызовы: ${data.completedCalls} всего · ${data.callsWithLawyer} совместно с юристом`);
  }
  if (data.acceptedLawsuitReference) lines.push(`Принятый иск: ${data.acceptedLawsuitReference}`);
  if (request.career_flow && request.stage_role !== "Стажер КА") {
    lines.push(`Обзвон: ${request.interview_status === "ready" ? "участник готов" : "ожидает готовности"}`);
  }
  const summary = lines.length ? `<div class="meta">${lines.map(escapeHtml).join("<br>")}</div>` : "";
  const attachments = (request.attachments || []).map((attachment) =>
    `<a class="attachment-link" href="/api/applications/${encodeURIComponent(request.id)}/attachments/${encodeURIComponent(attachment.id)}">Скачать ${escapeHtml(attachment.file_name)} · ${Math.ceil(Number(attachment.size) / 1024)} КБ</a>`
  ).join("");
  return `${summary}${attachments ? `<div>${attachments}</div>` : ""}`;
}

function requestCard(request, controls = false) {
  const citizenCase = ["citizen_help", "citizen_complaint"].includes(request.type);
  const casePriorityLabels = { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" };
  const headOnly = request.type === "promotion" && ["Ст.Адвокат", "ЗГКА"].includes(request.requested_role);
  const canReview = controls && isManager() && request.status === "pending" &&
    (request.type !== "employment" || role() === "ГКА") && (!headOnly || role() === "ГКА");
  const canMentorReview = controls && ["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(role()) &&
    request.type === "practice" && request.status === "pending";
  const canTrainReview = controls && ["Ст.Адвокат", "ЗГКА", "ГКА"].includes(role()) &&
    request.type === "training" && request.status === "pending";
  const requestedToOther = request.requested_lawyer_id && request.requested_lawyer_id !== currentUser.id;
  const canAssign = controls && citizenCase && ["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(role()) &&
    request.status === "pending" && (!requestedToOther || isManager());
  const canClose = controls && citizenCase && !request.completed_at && request.status === "approved" &&
    request.assigned_to === currentUser.id;
  const canChat = citizenCase && request.assigned_to &&
    (request.user_id === currentUser.id || request.assigned_to === currentUser.id);
  const canViewHistory = request.user_id === currentUser.id || request.assigned_to === currentUser.id || isManager();
  const canSetInterview = request.user_id === currentUser.id && request.type === "exam" &&
    request.career_flow && request.stage_role !== "Стажер КА" &&
    request.status === "pending" && request.result.includes("пройдена");
  const canRate = role() === "Гражданин" && request.user_id === currentUser.id &&
    citizenCase && request.completed_at && request.assigned_to;
  const allowReview = !citizenCase && (canReview || canMentorReview || canTrainReview);
  const created = new Date(request.created_at || request.createdAt);
  const date = Number.isNaN(created.getTime()) ? "" : created.toLocaleString("ru-RU");
  const dueDate = request.due_at ? new Date(request.due_at) : null;
  const dueText = dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate.toLocaleString("ru-RU") : "";
  const dueInput = dueDate && !Number.isNaN(dueDate.getTime())
    ? new Date(dueDate.getTime() - dueDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  const title = request.requested_role
    ? `Заявка на повышение: ${request.requested_role}`
    : request.type === "exam" ? `Проверка знаний · ${request.current_role || "сотрудник"}`
      : request.title || typeLabels[request.type] || "Заявка";
  const assigned = request.assigned_name
    ? ` · адвокат: ${request.assigned_user_id ? `<button class="profile-trigger" data-profile-id="${escapeHtml(request.assigned_user_id)}" type="button">${escapeHtml(request.assigned_name)}</button>` : escapeHtml(request.assigned_name)}`
    : "";
  const requested = request.requested_lawyer_name ? ` · выбран: ${escapeHtml(request.requested_lawyer_name)}` : "";
  const person = request.current_role && request.current_role !== "Гражданин"
    ? `<button class="profile-trigger" data-profile-id="${escapeHtml(request.user_id)}" type="button">${escapeHtml(request.display_name || request.name || "")}</button>`
    : escapeHtml(request.display_name || request.name || "");
  const criteria = reviewCriterionDefinitions(request);
  const reviewChecklist = allowReview && criteria.length
    ? `<div class="review-checklist"><strong>Проверка условий перед одобрением</strong>${criteria.map(([key, label]) =>
      `<label class="review-check"><input type="checkbox" data-review-criterion="${key}"><span>${escapeHtml(label)}</span></label>`).join("")}</div>`
    : "";
  const rating = canRate
    ? request.my_rating
      ? `<div class="note"><span class="rating-stars">${"★".repeat(Number(request.my_rating))}${"☆".repeat(5 - Number(request.my_rating))}</span> · ${request.my_rating}/5${request.my_review ? `<p>${escapeHtml(request.my_review)}</p>` : ""}</div>`
      : `<form class="stack" data-lawyer-rating="${escapeHtml(request.id)}">
          <fieldset class="field" style="border:0;padding:0;margin:0"><legend>Оценка адвокату</legend>
            <div class="star-picker" role="radiogroup" aria-label="Оценка от 1 до 5">
              ${[5, 4, 3, 2, 1].map((value) => `<label title="${value} из 5"><input type="radio" name="rating" value="${value}" required><span aria-hidden="true">★</span><span class="sr-only">${value}</span></label>`).join("")}
            </div>
          </fieldset>
          <textarea name="comment" maxlength="500" rows="2" placeholder="Короткий отзыв (необязательно)"></textarea>
          <button class="btn small primary" type="submit">Отправить отзыв</button>
        </form>`
    : "";
  const interviewActions = canSetInterview
    ? `<div class="request-actions">
        <button class="btn small primary" data-interview="ready" data-id="${escapeHtml(request.id)}" type="button">Готов к обзвону</button>
        <button class="btn small" data-interview="waiting" data-id="${escapeHtml(request.id)}" type="button">Сейчас не могу</button>
      </div>`
    : "";
  const forum = request.forum_url ? `<div class="meta"><a href="${escapeHtml(request.forum_url)}" target="_blank" rel="noopener noreferrer">Открыть тему на форуме</a>
    · ${request.forum_status === "approved" ? "ссылка подтверждена" : request.forum_status === "rejected" ? "ссылка отклонена" : "ожидает подтверждения"}</div>` : "";
  const forumReview = controls && isManager() && request.forum_status === "pending"
    ? `<div class="field"><label for="request-forum-note-${request.document_id}">Комментарий (обязателен при отклонении)</label>
        <input id="request-forum-note-${request.document_id}" maxlength="500" data-forum-note="${escapeHtml(request.document_id)}" placeholder="Причина решения"></div>
      <div class="request-actions">
        <button class="btn small primary" data-forum-review="approved" data-document-id="${escapeHtml(request.document_id)}">Подтвердить форумную ссылку</button>
        <button class="btn small danger" data-forum-review="rejected" data-document-id="${escapeHtml(request.document_id)}">Отклонить ссылку</button>
      </div>` : "";
  const forumNote = request.forum_review_note
    ? `<div class="note warning">${escapeHtml(request.forum_review_note)}</div>` : "";
  const caseManagement = controls && isManager() && citizenCase && !request.completed_at && request.status !== "rejected"
    ? `<div class="case-review">
        <select data-case-assignee="${escapeHtml(request.id)}" aria-label="Исполнитель обращения">
          <option value="">Не назначено</option>${members.filter((member) =>
            member.status === "active" && ["Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(member.role))
            .map((member) => `<option value="${escapeHtml(member.id)}"${String(member.id) === String(request.assigned_to) ? " selected" : ""}>${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("")}
        </select>
        <select data-case-priority="${escapeHtml(request.id)}" aria-label="Приоритет обращения">
          ${Object.entries(casePriorityLabels).map(([value, label]) => `<option value="${value}"${(request.priority || "normal") === value ? " selected" : ""}>${label}</option>`).join("")}
        </select>
        <button class="btn small subtle" data-save-case-assignee="${escapeHtml(request.id)}" type="button">Сохранить исполнителя</button>
        <input type="datetime-local" data-case-deadline="${escapeHtml(request.id)}" value="${escapeHtml(dueInput)}" aria-label="Срок обращения">
        <button class="btn small primary" data-save-case-workflow="${escapeHtml(request.id)}" type="button">Сохранить параметры</button>
      </div>` : "";
  return `<article class="request-card">
    <div class="request-top"><div><h4>${escapeHtml(title)}</h4>
      <div class="meta">${person} · ${escapeHtml(request.current_role || request.role || "")}${assigned}${requested}${date ? " · " + escapeHtml(date) : ""}</div></div>
      ${citizenCase && request.completed_at ? `<span class="badge approved">Закрыто</span>`
        : citizenCase && request.assigned_to ? `<span class="badge pending">В работе</span>` : statusBadge(request.status)}</div>
    <p>${escapeHtml(request.details || "")}</p>
    ${requestProgressMarkup(request)}
    ${forum}${forumNote}
    ${request.assigned_discord_username ? `<div class="meta">Discord назначенного адвоката: @${escapeHtml(request.assigned_discord_username)}</div>` : ""}
    ${request.assigned_to && request.user_id !== currentUser.id && request.applicant_discord_username
      ? `<div class="meta">Discord гражданина: @${escapeHtml(request.applicant_discord_username)}</div>` : ""}
    ${request.result ? `<div class="badge info">${escapeHtml(request.result)}</div>` : ""}
    ${citizenCase ? `<div class="meta">Приоритет: ${escapeHtml(casePriorityLabels[request.priority || "normal"] || "Обычный")}${dueText ? ` · срок: ${escapeHtml(dueText)}` : " · срок не установлен"}</div>` : ""}
    ${canAssign ? `<div class="request-actions"><button class="btn small primary" data-assign="${escapeHtml(request.id)}">Взять в работу</button></div>` : ""}
    ${caseManagement}
    ${canClose ? `<div class="request-actions"><button class="btn small" data-close-case="${escapeHtml(request.id)}">Закрыть обращение</button></div>` : ""}
    ${canChat ? `<div class="request-actions"><button class="btn small subtle" data-open-chat="${escapeHtml(request.id)}" type="button">Открыть чат</button></div>` : ""}
    ${canViewHistory ? `<div class="request-actions"><button class="btn small subtle" data-application-history="${escapeHtml(request.id)}" type="button">История изменений</button></div>` : ""}
    ${interviewActions}${forumReview}
    ${rating ? `<div style="margin-top:12px">${rating}</div>` : ""}
    ${reviewChecklist}
    ${allowReview ? `<div class="request-actions">
      <button class="btn small" data-review="approved" data-id="${escapeHtml(request.id)}">Одобрить</button>
      <button class="btn small danger" data-review="rejected" data-id="${escapeHtml(request.id)}">Отклонить</button>
    </div>` : ""}
  </article>`;
}

function renderRequests() {
  const mine = state.requests.filter((item) => item.user_id === currentUser.id);
  $("#my-applications").innerHTML = mine.length
    ? mine.map((item) => requestCard(item)).join("")
    : `<div class="empty">У вас пока нет заявок.</div>`;
  const applications = state.requests.filter((item) => ["exam", "promotion", "admin", "employment"].includes(item.type));
  $("#all-applications").innerHTML = applications.length
    ? applications.map((item) => requestCard(item, true)).join("")
    : `<div class="empty">Заявок на проверку знаний и повышение пока нет.</div>`;
  const practice = state.requests.filter((item) => item.type === "practice");
  $("#practice-requests").innerHTML = practice.length
    ? practice.map((item) => requestCard(item, true)).join("")
    : `<div class="empty">Запросов на совместную практику пока нет.</div>`;
  const training = state.requests.filter((item) => item.type === "training");
  $("#training-requests").innerHTML = training.length
    ? training.map((item) => requestCard(item, true)).join("")
    : `<div class="empty">Запросов на обучение пока нет.</div>`;
  const citizenCases = state.requests.filter((item) => ["citizen_help", "citizen_complaint"].includes(item.type));
  $("#citizen-requests").innerHTML = citizenCases.length
    ? citizenCases.map((item) => requestCard(item, true)).join("")
    : `<div class="empty">Новых обращений граждан нет.</div>`;
}

const taskStatusLabels = {
  new: "Новое", accepted: "Принято", in_progress: "В работе", review: "На проверке",
  revision: "На доработке", completed: "Завершено", cancelled: "Отменено"
};
const taskPriorityLabels = { low: "Низкий", normal: "Обычный", high: "Высокий", critical: "Срочный" };
const calendarTypeLabels = {
  court: "Суд", interview: "Собеседование", exam: "Экзамен", attestation: "Переаттестация",
  meeting: "Совещание", lecture: "Лекция", training: "Обучение", other: "Другое"
};
function portalDate(value) {
  if (!value) return "Без срока";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("ru-RU");
}

function taskCard(task) {
  const manager = isManager();
  const assigned = task.assignees.some((item) => item.id === currentUser.id);
  const actions = [];
  if (assigned) {
    const next = {
      new: ["accepted", "Принять поручение"],
      accepted: ["in_progress", "Начать работу"],
      in_progress: ["review", "Отправить на проверку"],
      revision: ["in_progress", "Возобновить работу"]
    }[task.status];
    if (next) actions.push(`<button class="btn small primary" type="button" data-task-status="${next[0]}" data-task-id="${task.id}">${next[1]}</button>`);
  }
  if (manager && task.status === "review") {
    actions.push(`<button class="btn small primary" type="button" data-task-status="completed" data-task-id="${task.id}">Принять результат</button>`);
    actions.push(`<button class="btn small danger" type="button" data-task-status="revision" data-task-id="${task.id}">Вернуть на доработку</button>`);
  }
  if (manager && !["completed", "cancelled"].includes(task.status)) {
    actions.push(`<button class="btn small danger" type="button" data-task-status="cancelled" data-task-id="${task.id}">Отменить поручение</button>`);
  }
  if (manager || assigned) actions.push(`<button class="btn small subtle" type="button" data-task-comment-submit="${task.id}">Добавить комментарий</button>`);
  const assignees = task.assignees.map((item) => `${escapeHtml(item.display_name)} · ${escapeHtml(item.role)}`).join(", ");
  const attachments = task.attachments.length
    ? `<div>${task.attachments.map((file) => `<a class="attachment-link" href="/api/tasks/${task.id}/attachments/${file.id}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.file_name)} (${Math.max(1, Math.ceil(file.size / 1024))} КБ)</a>`).join("")}</div>`
    : "";
  const upload = manager || assigned
    ? `<div class="request-actions"><input type="file" data-task-files="${task.id}" accept="image/jpeg,image/png,image/webp,application/pdf" multiple aria-label="Файлы к поручению">
        <button class="btn small" type="button" data-task-upload="${task.id}">Прикрепить</button></div>`
    : "";
  return `<article class="request-card task-card">
    <div class="request-top"><div><h4>${escapeHtml(task.title)}</h4>
      <div class="meta">Создал(а): ${escapeHtml(task.creator_name || "—")} · Срок: ${escapeHtml(portalDate(task.due_at))}</div></div>
      <div><span class="badge priority-${escapeHtml(task.priority)} task-priority">${escapeHtml(taskPriorityLabels[task.priority] || task.priority)}</span>
        <span class="badge ${task.status === "completed" ? "approved" : task.status === "cancelled" ? "rejected" : task.status === "review" ? "pending" : "info"}">${escapeHtml(taskStatusLabels[task.status] || task.status)}</span></div></div>
    <p>${escapeHtml(task.description)}</p>
    <div class="meta">Исполнители: ${assignees || "не назначены"}</div>
    ${task.review_note ? `<div class="note warning" style="margin-top:10px">Комментарий руководства: ${escapeHtml(task.review_note)}</div>` : ""}
    ${attachments}
    ${manager || assigned ? `<div class="field" style="margin-top:10px"><label for="task-comment-${task.id}">Комментарий к поручению</label>
      <textarea class="task-comment" id="task-comment-${task.id}" maxlength="1000" rows="2" placeholder="${task.status === "review" && manager ? "Комментарий обязателен для решения по результату" : "Комментарий или уточнение"}"></textarea></div>` : ""}
    ${actions.length ? `<div class="request-actions">${actions.join("")}</div>` : ""}
    ${upload}
    <details class="task-history" data-task-history-toggle="${task.id}"><summary>История и обсуждение</summary><div class="item-list" data-task-history="${task.id}"><span class="help">Откройте, чтобы загрузить историю.</span></div></details>
  </article>`;
}

function renderTasks() {
  const manager = isManager();
  $("#task-create-card").classList.toggle("hidden", !manager);
  const staff = members.filter((member) => member.status === "active" && member.role !== "Гражданин");
  if (manager) {
    $("#task-assignees").innerHTML = staff.map((member) =>
      `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
    $("#event-responsible").innerHTML = `<option value="">Выберите ответственного</option>` + staff.map((member) =>
      `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
    $("#event-participants").innerHTML = staff.map((member) =>
      `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
  }
  const filter = $("#task-filter").value;
  const filtered = state.tasks.filter((task) => filter === "all" ? true
    : filter === "open" ? !["completed", "cancelled"].includes(task.status) : task.status === filter);
  $("#task-list").innerHTML = filtered.length
    ? filtered.map(taskCard).join("")
    : `<div class="empty">${filter === "open" ? "Активных поручений пока нет." : "Поручений с таким статусом нет."}</div>`;
}

function calendarEventCard(event) {
  const participants = event.participants.map((item) => item.display_name).join(", ");
  const statusText = { scheduled: "Запланировано", completed: "Проведено", cancelled: "Отменено" }[event.status] || event.status;
  const managerActions = isManager() && event.status === "scheduled"
    ? `<div class="request-actions"><button class="btn small primary" type="button" data-event-status="completed" data-event-id="${event.id}">Отметить проведённым</button>
        <button class="btn small danger" type="button" data-event-status="cancelled" data-event-id="${event.id}">Отменить</button></div>` : "";
  return `<article class="request-card event-card ${escapeHtml(event.status)}">
    <div class="request-top"><div><h4>${escapeHtml(event.title)}</h4><div class="meta">${escapeHtml(calendarTypeLabels[event.event_type] || event.event_type)} · ${escapeHtml(portalDate(event.starts_at))}</div></div>
      <span class="badge ${event.status === "completed" ? "approved" : event.status === "cancelled" ? "rejected" : "pending"}">${statusText}</span></div>
    ${event.description ? `<p>${escapeHtml(event.description)}</p>` : ""}
    <div class="meta">Ответственный: ${escapeHtml(event.responsible_name)}${participants ? ` · Участники: ${escapeHtml(participants)}` : ""}${event.is_all_staff ? " · Для всех сотрудников" : ""}</div>
    ${managerActions}
  </article>`;
}

function calendarDateInputValue(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function renderCalendar() {
  $("#calendar-create-card").classList.toggle("hidden", !isManager());
  const mode = $("#calendar-view-mode").value;
  const dateInput = $("#calendar-view-date");
  if (dateInput.value) {
    const parsed = new Date(`${dateInput.value}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) calendarViewDate = parsed;
  } else {
    dateInput.value = calendarDateInputValue(calendarViewDate);
  }
  const start = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth(), calendarViewDate.getDate());
  if (mode === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (mode === "month") start.setDate(1);
  const end = new Date(start);
  if (mode === "day") end.setDate(end.getDate() + 1);
  else if (mode === "week") end.setDate(end.getDate() + 7);
  else end.setMonth(end.getMonth() + 1);
  const formatDate = (date) => date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  $("#calendar-view-range").textContent = mode === "month"
    ? start.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })
    : mode === "day" ? formatDate(start)
      : `${formatDate(start)} — ${formatDate(new Date(end.getTime() - 1))}`;
  const events = state.events.filter((event) => {
    const begins = new Date(event.starts_at);
    return !Number.isNaN(begins.getTime()) && begins >= start && begins < end;
  }).sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at));
  $("#calendar-list").innerHTML = events.length
    ? events.map(calendarEventCard).join("")
    : `<div class="empty">На выбранный период мероприятий нет.</div>`;
}

async function updateTask(taskId, changes, button) {
  if (button) button.disabled = true;
  try {
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: changes });
    notify("Поручение обновлено и сохранено.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function uploadTaskFiles(taskId, button) {
  const input = $$("[data-task-files]").find((item) => item.dataset.taskFiles === String(taskId));
  if (!input?.files.length) {
    notify("Выберите файлы для прикрепления.");
    return;
  }
  button.disabled = true;
  try {
    const attachments = await Promise.all(Array.from(input.files).map(async (file) => ({
      name: file.name,
      type: file.type,
      data: await fileAsBase64(file)
    })));
    await api(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, { method: "POST", body: { attachments } });
    notify("Вложения сохранены.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

function formatTenure(value) {
  const joined = new Date(value);
  if (Number.isNaN(joined.getTime())) return "—";
  const months = Math.max(0, (new Date().getFullYear() - joined.getFullYear()) * 12 +
    new Date().getMonth() - joined.getMonth());
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  if (!years && !remainder) return "Менее месяца";
  return [years ? `${years} г.` : "", remainder ? `${remainder} мес.` : ""].filter(Boolean).join(" ");
}

function renderDashboardProfile() {
  const profile = state.profileData?.profile || state.profileStats || {};
  const avatarUrl = rolePortraitUrl(currentUser.role);
  const avatar = $("#dashboard-avatar");
  avatar.classList.remove("hidden");
  avatar.src = avatarUrl;
  $("#dashboard-initials").classList.add("hidden");
  $("#welcome-title").textContent = `Добрый день, ${currentUser.displayName}`;
  $("#dashboard-role").textContent = currentUser.role === "ГКА"
    ? "Глава коллегии"
    : currentUser.role === "ЗГКА"
      ? "Заместитель главы коллегии"
      : currentUser.role;
  $("#dashboard-role-label").textContent = "Коллегия адвокатов";
  const joined = profile.member_since || "";
  const joinedDate = joined ? new Date(joined) : null;
  $("#dashboard-joined-date").textContent = joinedDate && !Number.isNaN(joinedDate.getTime())
    ? joinedDate.toLocaleDateString("ru-RU") : "12.09.2021";
  $("#dashboard-tenure").textContent = joined ? formatTenure(joined) : "3 года 2 месяца";
  const roleIndex = Math.max(0, roles.indexOf(currentUser.role));
  $("#dashboard-career-level").textContent = `${roleIndex + 1} / ${roles.length}`;
  const progress = Math.round(((roleIndex + 1) / roles.length) * 100);
  $("#dashboard-progress-percent").textContent = "Профессиональный рейтинг";
  $("#dashboard-progress-bar").style.width = `${progress}%`;
  $("#dashboard-progress-label").textContent = currentUser.role === "ГКА" ? "Высшая ступень" : "До следующей ступени";
  $("#dashboard-next-role").textContent = promotion[currentUser.role]
    ? `Следующая ступень: ${promotion[currentUser.role]}`
    : currentUser.role === "ГКА" ? "Высшая ступень коллегии" : "Карьерная ступень";
  $("#call-count").textContent = String(profile.approved_call_count || 0);
  $("#average-rating").textContent = Number(profile.review_count)
    ? Number(profile.average_rating).toFixed(1) : "—";
  $("#rating-review-count").textContent = Number(profile.review_count)
    ? `На основе ${Number(profile.review_count)} оценок` : "Нет подтверждённых оценок";
  $("#request-metric-note").textContent = isManager()
    ? "Поступившие в коллегию" : "Зарегистрированы в аккаунте";
  $("#lawsuit-metric-note").textContent = isManager() ? "Подтверждено в коллегии" : "Подтверждённые";
  $("#career-overview-title").textContent = "Мой прогресс";
  $("#career-overview-copy").textContent = currentUser.role;
  $("#welcome-description").textContent = `${currentUser.role} · данные и показатели из портала`;
}

function renderSparkline(values, color) {
  const maximum = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 100;
    const y = 24 - (value / maximum) * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function activitySeries(entries, dateField) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  start.setHours(0, 0, 0, 0);
  const values = Array(30).fill(0);
  for (const entry of entries) {
    const date = new Date(entry[dateField]);
    if (Number.isNaN(date.getTime()) || date < start || date > today) continue;
    const index = Math.floor((date.setHours(0, 0, 0, 0) - start.getTime()) / 86400000);
    if (index >= 0 && index < values.length) values[index] += 1;
  }
  return values;
}

function renderDashboardActivity() {
  const categories = [
    { label: "Поручения", rows: state.tasks, date: "created_at", color: "#5497e7" },
    { label: "Документы", rows: state.documents, date: "created_at", color: "#6b9ff0" },
    { label: "Судебные дела", rows: state.lawsuits, date: "created_at", color: "#e1a552" },
    { label: "Обращения", rows: state.requests, date: "created_at", color: "#68a5df" }
  ];
  $("#dashboard-activity").innerHTML = categories.map((item) => {
    const values = activitySeries(item.rows, item.date);
    const count = values.reduce((sum, value) => sum + value, 0);
    return `<div class="activity-metric"><strong>${count}</strong><span>${item.label}</span>${renderSparkline(values, item.color)}</div>`;
  }).join("");
}

function renderDashboardProgress() {
  const profile = state.profileStats || {};
  const rows = [
    ["Подтверждённые документы", Number(profile.document_count || 0)],
    ["Судебные дела", Number(profile.lawsuit_count || 0)],
    ["Закрытые обращения", Number(profile.closed_case_count || 0)]
  ];
  $("#dashboard-progress-items").innerHTML = rows.map(([label, count]) =>
    `<div class="compact-row"><span class="compact-icon">✓</span><strong>${label}</strong><span class="compact-value">${count}</span></div>`).join("");
  const achievements = state.profileData?.achievements || [];
  $("#dashboard-achievements").innerHTML = achievements.length
    ? achievements.slice(0, 3).map((achievement) => `<div class="compact-row">${achievementIcon(achievement.icon)}
        <div class="compact-copy"><strong>${escapeHtml(achievement.title)}</strong><small>Получено ${escapeHtml(achievement.awarded_at)}</small></div></div>`).join("")
    : `<div class="dashboard-empty">Подтверждённые достижения появятся по мере работы.</div>`;
  const ranking = state.attorneys.filter((attorney) => Number(attorney.review_count) > 0).slice(0, 3);
  $("#dashboard-ranking").innerHTML = ranking.length
    ? ranking.map((attorney, index) => `<div class="compact-row">
        <span class="rank-number">${index + 1}</span>
        <img class="rank-avatar role-portrait-mini" src="${escapeHtml(rolePortraitUrl(attorney.role))}" alt="">
        <div class="compact-copy"><strong>${escapeHtml(attorney.display_name)}</strong><small>${escapeHtml(attorney.role)} · ${Number(attorney.review_count)} отзывов</small></div>
        <span class="compact-value">${Number(attorney.average_rating).toFixed(1)}</span></div>`).join("")
    : `<div class="dashboard-empty">Адвокаты появятся в рейтинге после получения отзывов.</div>`;
}

function profileDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("ru-RU");
}

function renderPersonalProfile() {
  const data = state.profileData;
  if (!data || !currentUser) return;
  const profile = data.profile;
  const avatarUrl = rolePortraitUrl(profile.role || currentUser.role);
  const forumStatus = profile.forum_profile_url
    ? profile.forum_profile_verified_at
      ? `Профиль проверен руководством ${profileDate(profile.forum_profile_verified_at)}.`
      : "Ссылка сохранена, но ещё не подтверждена руководством."
    : "Профиль форума пока не привязан.";
  const achievementBadges = data.achievements?.length
    ? data.achievements.slice(0, 8).map((item) => `<button class="profile-achievement" type="button" data-achievement-detail="${escapeHtml(item.title)}|${escapeHtml(item.description)}|${escapeHtml(item.metric)}|${escapeHtml(item.threshold)}" title="${escapeHtml(item.title)} — ${escapeHtml(item.description)}">
        ${achievementIcon(item.icon)}<span>${escapeHtml(item.title)}</span></button>`).join("")
    : `<span class="help">Достижения появятся после подтверждённых действий.</span>`;
  const quote = profile.profile_quote
    ? `<blockquote class="profile-quote">«${escapeHtml(profile.profile_quote)}»</blockquote>`
    : "";
  $("#profile-identity").innerHTML = `<div class="profile-hero">
      ${avatarUrl ? `<img class="role-portrait" src="${escapeHtml(avatarUrl)}" alt="Портрет должности ${escapeHtml(profile.role)}">` : ""}
      <div><h3 style="margin:0">${escapeHtml(profile.display_name)}</h3>
        <div class="meta">${escapeHtml(profile.role)} · Вступление: ${profile.member_since ? escapeHtml(profileDate(profile.member_since)) : "дата не указана"}</div>
        <div class="meta">${profile.discord_username ? `Discord: @${escapeHtml(profile.discord_username)}` : "Discord не привязан"}</div>
        ${discordPresenceBadge(profile.presence)}
        <div class="profile-achievement-row">${achievementBadges}</div>
      </div>
      ${quote}
    </div>`;
  const formInput = $("#forum-profile-url");
  if (document.activeElement !== formInput) formInput.value = profile.forum_profile_url || "";
  $("#forum-profile-status").textContent = forumStatus;
  const forumLink = $("#forum-profile-link");
  forumLink.classList.toggle("hidden", !profile.forum_profile_url);
  if (profile.forum_profile_url) forumLink.href = profile.forum_profile_url;
  $("#profile-discord-status").textContent = profile.discord_username
    ? `Discord привязан: @${profile.discord_username}. Управление OAuth — через кнопку Discord в шапке.`
    : "Discord не привязан. Привязка доступна через кнопку Discord в шапке.";
  const metrics = [
    ["Подтверждённые вызовы", Number(profile.approved_call_count || 0)],
    ["Одобренные документы", Number(profile.document_count || 0)],
    ["Судебные дела", Number(profile.lawsuit_count || 0)],
    ["Закрытые обращения", Number(profile.closed_request_count || 0)],
    ["Выполненные поручения", Number(profile.completed_task_count || 0)],
    ["Средняя оценка", Number(profile.review_count) ? `${Number(profile.average_rating).toFixed(1)} / 5` : "Нет оценок"]
  ];
  $("#profile-metrics").innerHTML = metrics.map(([label, value]) =>
    `<div class="stat"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value">${escapeHtml(value)}</strong></div>`).join("");
  $("#profile-promotions").innerHTML = data.promotions.length
    ? data.promotions.map((item) => `<article class="request-card"><strong>${escapeHtml(item.requested_role || "Повышение")}</strong>
        <div class="meta">${escapeHtml(item.stage_role || "")} · ${escapeHtml(profileDate(item.reviewed_at))}${item.reviewed_by ? ` · подтвердил(а): ${escapeHtml(item.reviewed_by)}` : ""}</div>
        ${item.result ? `<p>${escapeHtml(item.result)}</p>` : ""}</article>`).join("")
    : `<div class="empty">Подтверждённых повышений пока нет.</div>`;
  const activity = [
    ...data.promotions.map((item) => ({ date: item.reviewed_at, title: `Повышение: ${item.requested_role || "должность"}`, detail: item.result || "" })),
    ...data.employmentHistory.map((item) => ({
      date: item.created_at,
      title: ({
        hired: "Принятие в Коллегию",
        promoted: `Повышение: ${item.from_role} → ${item.to_role}`,
        role_changed: `Перевод: ${item.from_role} → ${item.to_role}`,
        dismissed: "Увольнение / приостановка доступа",
        reinstated: "Восстановление в составе",
        status_changed: "Изменение статуса сотрудника"
      })[item.event_type] || "Кадровое изменение",
      detail: `${item.details || `${item.from_role} · ${item.from_status} → ${item.to_role} · ${item.to_status}`}${item.actor_name ? ` · оформил(а): ${item.actor_name}` : ""}`
    })),
    ...data.exams.map((item) => ({ date: item.created_at, title: item.passed ? "Экзамен сдан" : "Экзамен не сдан", detail: `${item.track} · ${item.score} баллов` })),
    ...data.attestations.map((item) => ({ date: item.completed_at || item.created_at, title: `Переаттестация: ${item.status}`, detail: `${item.track}${item.score === null ? "" : ` · ${item.score} баллов`}` })),
    ...data.reprimands.map((item) => ({ date: item.created_at, title: "Выговор", detail: `${item.reason} · выдал(а): ${item.issuer_name}` })),
    ...data.tasks.map((item) => ({ date: item.updated_at, title: `Поручение: ${item.title}`, detail: taskStatusLabels[item.status] || item.status })),
    ...data.absences.map((item) => ({
      date: item.reviewed_at || item.created_at,
      title: `Отсутствие: ${item.start_date} — ${item.end_date}`,
      detail: `${absenceStatusLabels[item.status] || item.status}${item.review_note ? ` · ${item.review_note}` : ""}`
    })),
    ...data.reserve.map((item) => ({
      date: item.updated_at,
      title: "Кадровый резерв",
      detail: `${reserveStatusLabels[item.status] || item.status}${item.note ? ` · ${item.note}` : ""}`
    }))
  ].filter((item) => item.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 12);
  $("#profile-activity").innerHTML = activity.length
    ? activity.map((item) => `<article class="request-card"><div class="request-top"><strong>${escapeHtml(item.title)}</strong><span class="meta">${escapeHtml(profileDate(item.date))}</span></div>
        ${item.detail ? `<div class="meta">${escapeHtml(item.detail)}</div>` : ""}</article>`).join("")
    : `<div class="empty">Действий в личном деле пока нет.</div>`;
  $("#profile-earned-achievements").innerHTML = data.achievements.length
    ? data.achievements.slice(0, 4).map((item) => `<article class="request-card"><div class="request-top">${achievementIcon(item.icon)}<strong>${escapeHtml(item.title)}</strong></div>
        <div class="meta">${escapeHtml(item.description)} · получено ${escapeHtml(profileDate(item.awarded_at))}</div></article>`).join("")
    : `<div class="empty">Полученных достижений пока нет.</div>`;
  $("#profile-earned-awards").innerHTML = data.awards.length
    ? data.awards.slice(0, 4).map((item) => `<article class="request-card"><strong>${escapeHtml(item.title)}</strong>
        <div class="meta">${escapeHtml(item.description || "Основание не указано")} · ${escapeHtml(profileDate(item.created_at))} · ${escapeHtml(item.granted_by_name)}</div></article>`).join("")
    : `<div class="empty">Наград пока нет.</div>`;
}

function renderAchievementsPage() {
  const data = state.profileData;
  const catalog = state.achievementData?.achievements || [];
  if (!data) return;
  const eliteHost = $("#elite-awards");
  if (eliteHost) eliteHost.innerHTML = renderEliteAwards(eliteAwardsCatalog, data.awards);
  const kindLabels = { thanks: "Благодарность", certificate: "Почётная грамота", special: "Особая награда", individual: "Индивидуальное поощрение" };
  $("#achievement-list").innerHTML = data.achievements.length
    ? data.achievements.map((item) => `<article class="request-card"><div class="request-top">${achievementIcon(item.icon)}<strong>${escapeHtml(item.title)}</strong>
        <span class="badge approved">Получено</span></div><p>${escapeHtml(item.description)}</p><div class="meta">${escapeHtml(profileDate(item.awarded_at))}</div></article>`).join("")
    : `<div class="empty">Достижения ещё не получены. Выполняйте подтверждаемые условия или участвуйте в работе Коллегии.</div>`;
  $("#award-list").innerHTML = data.awards.length
    ? data.awards.map((item) => `<article class="request-card"><div class="request-top"><strong>${escapeHtml(item.title)}</strong>
        <span class="badge info">${escapeHtml(kindLabels[item.kind] || item.kind)}</span></div>
        <p>${escapeHtml(item.description || "Основание не указано")}</p>
        <div class="meta">${escapeHtml(profileDate(item.created_at))} · вручил(а): ${escapeHtml(item.granted_by_name)}</div></article>`).join("")
    : `<div class="empty">Наград пока нет.</div>`;
  $("#achievement-catalog").innerHTML = catalog.length
    ? catalog.map((item) => `<article class="request-card"><div class="request-top">${achievementIcon(item.icon)}<strong>${escapeHtml(item.title)}</strong>
        <span class="badge ${item.awarded_at ? "approved" : "info"}">${item.awarded_at ? "Получено" : "Условие впереди"}</span></div>
        <p>${escapeHtml(item.description)}</p><div class="meta">${item.metric === "manual" ? "Вручает руководство" : `Условие: ${item.threshold} · ${escapeHtml(item.metric)}`}</div></article>`).join("")
    : `<div class="empty">Каталог достижений пока пуст.</div>`;
  const staffOptions = members.filter((member) => member.status === "active" && member.role !== "Гражданин")
    .map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
  ["#achievement-award-user", "#award-user"].forEach((selector) => {
    $(selector).innerHTML = `<option value="">Выберите сотрудника</option>${staffOptions}`;
  });
  $("#achievement-award-id").innerHTML = `<option value="">Выберите достижение</option>` +
    catalog.filter((item) => item.metric === "manual" && item.active)
      .map((item) => `<option value="${item.id}">${escapeHtml(item.title)}</option>`).join("");
  $("#achievement-create-card").classList.toggle("hidden", !isManager());
  $("#achievement-management").classList.toggle("hidden", !isManager());
}

function dashboardDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderDashboardCalendar() {
  const year = dashboardCalendarMonth.getFullYear();
  const month = dashboardCalendarMonth.getMonth();
  $("#dashboard-calendar-title").textContent = dashboardCalendarMonth.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - offset);
  const todayKey = dashboardDayKey(new Date());
  const selectedKey = dashboardDayKey(dashboardSelectedDate);
  const calendarCells = weekdays.map((day) => `<span class="mini-calendar-day weekday">${day}</span>`);
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = dashboardDayKey(date);
    const hasEvent = state.events.some((event) => dashboardDayKey(new Date(event.starts_at)) === key);
    const classes = ["mini-calendar-day",
      date.getMonth() !== month ? "other-month" : "",
      key === todayKey ? "today" : "",
      key === selectedKey ? "selected" : "",
      hasEvent ? "has-event" : ""].filter(Boolean).join(" ");
    calendarCells.push(`<button type="button" class="${classes}" data-dashboard-date="${key}" aria-label="${escapeHtml(date.toLocaleDateString("ru-RU"))}">${date.getDate()}</button>`);
  }
  $("#dashboard-calendar").innerHTML = calendarCells.join("");
  $("#dashboard-selected-date").textContent = selectedKey === todayKey
    ? "Сегодня" : dashboardSelectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  const dayEvents = state.events.filter((event) => dashboardDayKey(new Date(event.starts_at)) === selectedKey)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  $("#dashboard-calendar-events").innerHTML = dayEvents.length
    ? dayEvents.map((event) => `<div class="calendar-event-mini"><span>${escapeHtml(event.title)}</span><span>${escapeHtml(new Date(event.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }))}</span></div>`).join("")
    : `<span class="dashboard-empty">Мероприятий нет</span>`;
}

function renderPortalSearch() {
  const query = $("#portal-search").value.trim().toLocaleLowerCase("ru-RU");
  const results = $("#portal-search-results");
  if (query.length < 2) {
    results.classList.add("hidden");
    results.innerHTML = "";
    return;
  }
  const entries = [
    ...state.requests.map((item) => ({
      title: item.subject || item.type || "Обращение",
      detail: item.details || item.status || "",
      tab: "applications"
    })),
    ...state.tasks.map((item) => ({ title: item.title, detail: item.description || item.status || "", tab: "tasks" })),
    ...state.events.map((item) => ({ title: item.title, detail: item.description || item.event_type || "", tab: "calendar" })),
    ...state.documents.map((item) => ({ title: item.title || item.name || item.filename || "Документ", detail: item.type || "", tab: "documents" })),
    ...Object.entries(state.laws).map(([key, item]) => ({ title: item.name || lawMeta[key]?.name || key, detail: "Законодательство", tab: "laws" }))
  ];
  const matches = entries.filter((item) => `${item.title} ${item.detail}`.toLocaleLowerCase("ru-RU").includes(query)).slice(0, 7);
  results.innerHTML = matches.length
    ? matches.map((item) => `<button class="search-result" type="button" data-search-go="${item.tab}">
        <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></button>`).join("")
    : `<div class="search-result-empty">Ничего не найдено</div>`;
  results.classList.remove("hidden");
}

function renderDashboardSideStats() {
  const panel = $("#dashboard-collegium-stats");
  panel.classList.toggle("hidden", !isManager());
  if (!isManager()) return;
  const cutoff = Date.now() - 30 * 86400000;
  const countRecent = (items) => items.filter((item) => {
    const date = new Date(item.created_at).getTime();
    return Number.isFinite(date) && date >= cutoff;
  }).length;
  const activeStaff = members.filter((member) => member.status === "active" && member.role !== "Гражданин").length;
  const citizenCases = countRecent(state.requests.filter((item) => ["citizen_help", "citizen_complaint"].includes(item.type)));
  const documents = countRecent(state.documents);
  const lawsuits = countRecent(state.lawsuits);
  const tasks = countRecent(state.tasks);
  const rows = [
    ["Сотрудники", activeStaff, "◉"],
    ["Обращения граждан", citizenCases, "♧"],
    ["Судебные дела", lawsuits, "§"],
    ["Документы", documents, "▤"],
    ["Создано поручений", tasks, "✓"]
  ];
  $("#dashboard-team-stats").innerHTML = rows.map(([label, count, icon]) =>
    `<div class="compact-row"><span class="compact-icon">${icon}</span><strong>${label}</strong><span class="compact-value">${count}</span></div>`).join("");
}

function renderDashboardNotifications() {
  const notifications = [
    ...state.tasks.map((task) => ({
      date: task.updated_at || task.created_at,
      title: task.status === "review" ? "Поручение ожидает проверки" : "Обновление поручения",
      detail: task.title,
      type: "task"
    })),
    ...state.requests.map((request) => ({
      date: request.created_at,
      title: request.type === "citizen_help" || request.type === "citizen_complaint" ? "Обращение гражданина" : "Новое обращение",
      detail: request.details,
      type: "request"
    }))
  ].filter((item) => item.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 12);
  $("#home-notification-list").innerHTML = notifications.length
    ? notifications.slice(0, 4).map((item) => `<div class="dashboard-row"><div><strong>${escapeHtml(item.title)}</strong><div class="meta">${escapeHtml((item.detail || "").slice(0, 70))}</div></div>
        <span class="meta">${escapeHtml(new Date(item.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }))}</span></div>`).join("")
    : `<div class="dashboard-empty-action"><strong>Обновления появятся после новых действий в портале</strong></div>`;
  const icons = { task: "i-list-check", request: "i-message" };
  $("#notification-center-list").innerHTML = notifications.length
    ? notifications.map((item) => {
        const date = new Date(item.date);
        const dateText = Number.isNaN(date.getTime())
          ? ""
          : date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        return `<article class="notification-item">
          <span class="notification-item-icon"><svg class="svg-icon"><use href="#${icons[item.type] || "i-bell"}"></use></svg></span>
          <div><strong>${escapeHtml(item.title)}</strong><div class="meta">${escapeHtml(item.detail || "Обновление в рабочем кабинете")}</div>${dateText ? `<div class="meta">${escapeHtml(dateText)}</div>` : ""}</div>
        </article>`;
      }).join("")
    : `<div class="empty">Новых уведомлений нет.</div>`;
  const actionable = isManager()
    ? state.requests.filter((item) => item.status === "pending").length + state.tasks.filter((item) => item.status === "review").length
    : state.tasks.filter((item) => ["new", "revision"].includes(item.status)).length;
  $("#notification-count").textContent = String(actionable);
  $("#notification-count").classList.toggle("hidden", actionable === 0);
  $("#notification-open").setAttribute("aria-label", actionable ? `${actionable} требуют внимания` : "Последние уведомления");
}

function renderDashboardWorkspaces() {
  const visibleTasks = state.tasks.filter((task) => !["completed", "cancelled"].includes(task.status));
  $("#task-count").textContent = `${visibleTasks.length} активных`;
  const taskBreakdown = [
    ["Новые", "new", "□"],
    ["В работе", "in_progress", "▣"],
    ["На проверке", "review", "◷"],
    ["Требуют доработки", "revision", "↺"],
    ["Выполнены", "completed", "✓"]
  ];
  $("#dashboard-task-breakdown").innerHTML = taskBreakdown.map(([label, status, icon]) =>
    `<div class="task-count-row"><span class="task-count-mark">${icon}</span><span>${label}</span>
      <strong>${state.tasks.filter((task) => task.status === status).length}</strong></div>`).join("");
  $("#home-task-heading").textContent = "Активные поручения";
  const orderedTasks = [...visibleTasks].sort((a, b) => {
    if (!a.due_at) return b.due_at ? 1 : 0;
    if (!b.due_at) return -1;
    return new Date(a.due_at) - new Date(b.due_at);
  }).slice(0, 3);
  $("#home-task-list").innerHTML = orderedTasks.length
    ? orderedTasks.map((task) => `<div class="dashboard-row"><div class="dashboard-row-copy"><strong>${escapeHtml(task.title)}</strong>
        <div class="meta">Срок: ${escapeHtml(portalDate(task.due_at))}</div></div>
        <span class="badge ${task.status === "completed" ? "approved" : "info"}">${escapeHtml(taskStatusLabels[task.status] || task.status)}</span></div>`).join("")
    : `<div class="dashboard-empty-action"><strong>Рабочий список свободен</strong><button class="btn small subtle" type="button" data-go="tasks">Создать поручение</button></div>`;
  const now = Date.now();
  const upcoming = state.events.filter((event) => event.status === "scheduled" && new Date(event.starts_at).getTime() >= now)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 3);
  $("#home-event-list").innerHTML = upcoming.length
    ? upcoming.map((event) => `<div class="dashboard-row"><span class="event-type-icon">${escapeHtml(calendarTypeLabels[event.event_type]?.slice(0, 1) || "•")}</span>
        <div class="dashboard-row-copy"><strong>${escapeHtml(event.title)}</strong>
        <div class="meta">${escapeHtml(new Date(event.starts_at).toLocaleDateString("ru-RU"))} · ${escapeHtml(new Date(event.starts_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }))}</div></div></div>`).join("")
    : `<div class="dashboard-empty-action"><strong>Расписание без срочных заседаний</strong><button class="btn small subtle" type="button" data-go="calendar">Назначить событие</button></div>`;
  renderDashboardNotifications();
  renderDashboardProfile();
  renderDashboardActivity();
  renderDashboardProgress();
  renderDashboardCalendar();
  renderDashboardSideStats();
}

function renderAttorneys() {
  const attorneys = state.attorneys;
  $("#attorney-choice").innerHTML = `<option value="">Не выбирать — обращение увидят адвокаты</option>` +
    attorneys.map((attorney) => `<option value="${escapeHtml(attorney.id)}">${escapeHtml(attorney.display_name)} · ${escapeHtml(attorney.role)} · ${attorney.review_count ? `${Number(attorney.average_rating).toFixed(1)}/5` : "нет оценок"}</option>`).join("");
  $("#attorney-list").innerHTML = attorneys.length
    ? attorneys.map((attorney) => {
      const stars = attorney.review_count
        ? `${"★".repeat(Math.round(attorney.average_rating))}${"☆".repeat(5 - Math.round(attorney.average_rating))}`
        : "Пока нет оценок";
      return `<article class="card attorney-card">
        <div class="member-ident">
          <img class="member-avatar role-portrait-mini" src="${escapeHtml(rolePortraitUrl(attorney.role))}" alt="Портрет должности ${escapeHtml(attorney.role)}">
          <div><h3><button class="profile-trigger" data-profile-id="${escapeHtml(attorney.id)}" type="button">${escapeHtml(attorney.display_name)}</button></h3>
            <div class="meta">${escapeHtml(attorney.role)}${attorney.discord_username ? ` · Discord: @${escapeHtml(attorney.discord_username)}` : ""}</div></div>
        </div>
        <p style="margin:12px 0 5px"><span class="rating-stars">${stars}</span> ${attorney.review_count ? `${Number(attorney.average_rating).toFixed(1)}/5 · отзывов: ${attorney.review_count}` : ""}</p>
        <div class="meta">Документов: ${attorney.document_count} · судебных дел: ${attorney.lawsuit_count}</div>
        <div class="request-actions">
          <button class="btn small primary" type="button" data-select-attorney="${escapeHtml(attorney.id)}">Выбрать адвоката</button>
          <button class="btn small subtle" type="button" data-profile-id="${escapeHtml(attorney.id)}">Профиль</button>
        </div>
      </article>`;
    }).join("")
    : `<div class="empty">Сейчас нет активных адвокатов. Можно отправить обращение без выбора конкретного человека.</div>`;
  const ranked = attorneys.filter((attorney) => Number(attorney.score) > 0);
  const unrated = attorneys.filter((attorney) => Number(attorney.score) === 0);
  $("#ranking-list").innerHTML = ranked.length || unrated.length
    ? `${ranked.map((attorney, index) => `<article class="request-card">
        <div class="request-top"><div><h4><span class="rank-number">${index + 1}</span>
          <button class="profile-trigger" data-profile-id="${escapeHtml(attorney.id)}" type="button">${escapeHtml(attorney.display_name)}</button></h4>
          <div class="meta">${escapeHtml(attorney.role)} · баллы: ${Number(attorney.score)} · закрытые обращения: ${Number(attorney.casesClosed)} · одобренные документы: ${Number(attorney.documentsApproved)}</div></div>
          <span class="rating-stars">${Number(attorney.average_rating).toFixed(1)} / 5 · ${Number(attorney.review_count)} отзывов</span></div>
      </article>`).join("")}
      ${unrated.map((attorney) => `<article class="request-card"><div class="request-top">
        <div><h4><button class="profile-trigger" data-profile-id="${escapeHtml(attorney.id)}" type="button">${escapeHtml(attorney.display_name)}</button></h4>
        <div class="meta">${escapeHtml(attorney.role)} · нет подтверждённых действий за период</div></div><span class="badge info">0 баллов</span>
      </div></article>`).join("")}`
    : `<div class="empty">Активных адвокатов пока нет.</div>`;
}

async function loadRatingSettings() {
  if (!isManager()) return;
  try {
    const result = await api("/api/rating-settings");
    Object.entries(result.weights).forEach(([key, weight]) => {
      const input = $(`[data-rating-weight="${key}"]`);
      if (input) input.value = weight;
    });
    $("#rating-settings-history").innerHTML = result.history.length
      ? result.history.map((entry) => `<article class="request-card">
          <div class="meta">${escapeHtml(portalDate(entry.created_at))} · ${escapeHtml(entry.updated_by)}</div>
          <div class="meta">${Object.entries(entry.weights).map(([key, weight]) =>
            `${escapeHtml(key)}: ${Number(weight)}`).join(" · ")}</div>
        </article>`).join("")
      : `<div class="meta">Изменений формулы пока нет. Используются исходные веса.</div>`;
  } catch (error) {
    notify(error.message);
  }
}

async function saveRatingSettings(button) {
  const weights = Object.fromEntries([...document.querySelectorAll("[data-rating-weight]")]
    .map((input) => [input.dataset.ratingWeight, Number(input.value)]));
  button.disabled = true;
  try {
    await api("/api/rating-settings", { method: "PATCH", body: { weights } });
    notify("Формула рейтинга сохранена.");
    await loadRanking();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

async function loadRanking() {
  try {
    const result = await api(`/api/attorneys?period=${encodeURIComponent($("#ranking-period").value)}`);
    state.attorneys = result.attorneys;
    renderAttorneys();
    renderDashboardProgress();
    if (isManager()) loadRatingSettings();
  } catch (error) {
    notify(error.message);
  }
}

const reserveStatusLabels = { considering: "Рассматривается", ready: "Готов к следующей ступени" };
const absenceStatusLabels = { pending: "На рассмотрении", approved: "Одобрено", rejected: "Отклонено" };
const characteristicLabels = {
  law: "Знание законодательства", discipline: "Дисциплина", activity: "Активность",
  professionalism: "Профессионализм", citizens: "Работа с гражданами", teamwork: "Работа в коллективе"
};
const academyCategoryLabels = {
  constitutional: "Конституционное право", administrative: "Административное право",
  criminal: "Уголовное право", labor: "Трудовое право", advocacy: "Закон об адвокатуре",
  court: "Судебная практика", documents: "Документооборот",
  internal: "Внутренние нормативные документы"
};
const academyKindLabels = { lecture: "Лекция", manual: "Методическое пособие", exercise: "Практическое задание" };

function resetAcademyForm() {
  $("#academy-form").reset();
  $("#academy-edit-id").value = "";
  $("#academy-form-title").textContent = "Добавить учебный материал · руководство";
  $("#academy-cancel-edit").classList.add("hidden");
}

function renderReserve() {
  const canManage = isManager();
  $("#reserve-manage-card").classList.toggle("hidden", !canManage);
  if (canManage) {
    $("#reserve-user").innerHTML = `<option value="">Выберите сотрудника</option>` +
      members.filter((member) => member.status === "active" && member.role !== "Гражданин")
        .map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
  }
  $("#reserve-list").innerHTML = state.reserve.length
    ? state.reserve.map((item) => `<article class="request-card">
        <div class="request-top"><div><h4>${escapeHtml(item.display_name)}</h4>
          <div class="meta">${escapeHtml(item.role)} · добавил(а): ${escapeHtml(item.added_by_name)} · обновлено ${escapeHtml(profileDate(item.updated_at))}</div></div>
          <span class="badge ${item.status === "ready" ? "approved" : "pending"}">${reserveStatusLabels[item.status] || "Рассматривается"}</span></div>
        ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
        ${canManage ? `<div class="request-actions"><button class="btn small danger" type="button" data-reserve-remove="${escapeHtml(item.user_id)}">Убрать из резерва</button></div>` : ""}
      </article>`).join("")
    : `<div class="empty">В кадровом резерве пока нет сотрудников.</div>`;
}

function renderAbsences() {
  const canReview = isManager();
  $("#absence-list").innerHTML = state.absences.length
    ? state.absences.map((item) => `<article class="request-card">
        <div class="request-top"><div><h4>${escapeHtml(item.display_name)} · ${escapeHtml(item.role)}</h4>
          <div class="meta">${escapeHtml(item.start_date)} — ${escapeHtml(item.end_date)} · подано ${escapeHtml(profileDate(item.created_at))}</div></div>
          <span class="badge ${item.status === "approved" ? "approved" : item.status === "rejected" ? "rejected" : "pending"}">${absenceStatusLabels[item.status] || item.status}</span></div>
        <p>${escapeHtml(item.reason)}</p>
        ${item.review_note ? `<div class="note">${escapeHtml(item.review_note)}</div>` : ""}
        ${item.reviewer_name ? `<div class="meta">Решение: ${escapeHtml(item.reviewer_name)} · ${escapeHtml(profileDate(item.reviewed_at))}</div>` : ""}
        ${canReview && item.status === "pending" ? `<div class="request-actions">
          <button class="btn small primary" type="button" data-absence-review="approved" data-absence-id="${escapeHtml(item.id)}">Одобрить</button>
          <button class="btn small danger" type="button" data-absence-review="rejected" data-absence-id="${escapeHtml(item.id)}">Отклонить</button>
        </div>` : ""}
      </article>`).join("")
    : `<div class="empty">Заявок на отпуск или отсутствие пока нет.</div>`;
}

function renderCharacteristics() {
  if (!isManager()) return;
  $("#characteristic-user").innerHTML = `<option value="">Выберите сотрудника</option>` +
    members.filter((member) => member.status === "active" && member.role !== "Гражданин")
      .map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
  $("#characteristic-list").innerHTML = state.characteristics.length
    ? state.characteristics.map((item) => `<article class="request-card">
        <div class="request-top"><div><h4>${escapeHtml(item.display_name)} · ${escapeHtml(item.role)}</h4>
          <div class="meta">${escapeHtml(characteristicLabels[item.criterion] || item.criterion)} · оценил(а): ${escapeHtml(item.evaluator_name)} · ${escapeHtml(profileDate(item.created_at))}</div></div>
          <span class="badge info">${escapeHtml(item.score)}/5</span></div>
        ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ""}
      </article>`).join("")
    : `<div class="empty">Характеристик пока нет.</div>`;
}

function renderAcademy() {
  const canManage = isManager();
  $("#academy-manage-card").classList.toggle("hidden", !canManage);
  const query = $("#academy-search").value.trim().toLocaleLowerCase("ru-RU");
  const category = $("#academy-category-filter").value;
  const materials = state.academyMaterials.filter((item) =>
    (category === "all" || item.category === category) &&
    (!query || `${item.title} ${item.body} ${academyCategoryLabels[item.category] || ""}`
      .toLocaleLowerCase("ru-RU").includes(query)));
  $("#academy-material-list").innerHTML = materials.length
    ? materials.map((item) => `<article class="request-card">
        <div class="request-top"><div><h4>${escapeHtml(item.title)}</h4>
          <div class="meta">${escapeHtml(academyCategoryLabels[item.category] || item.category)} · ${escapeHtml(academyKindLabels[item.kind] || item.kind)} · автор: ${escapeHtml(item.author_name)}</div></div>
          <span class="badge info">${escapeHtml(academyKindLabels[item.kind] || item.kind)}</span></div>
        <div style="white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px">${escapeHtml(item.body)}</div>
        ${canManage ? `<div class="request-actions"><button class="btn small subtle" type="button" data-academy-edit="${escapeHtml(item.id)}">Изменить</button>
          <button class="btn small danger" type="button" data-academy-delete="${escapeHtml(item.id)}">Удалить</button></div>` : ""}
      </article>`).join("")
    : `<div class="empty">${query || category !== "all" ? "Материалы не найдены." : "Материалов Академии пока нет. Руководство может добавить первый."}</div>`;
}

function renderProfileCustomization() {
  const profile = state.profileData?.profile;
  if (!profile) return;
  $("#profile-bio").value = profile.profile_bio || "";
  $("#profile-quote").value = profile.profile_quote || "";
  $("#profile-effect").value = profile.profile_effect || "snow";
  const pinned = Array.isArray(profile.profile_pinned_cases)
    ? profile.profile_pinned_cases
    : [];
  for (let index = 1; index <= 3; index += 1) {
    const item = pinned[index - 1] || {};
    $(`#pinned-case-${index}`).value = item.title || "";
    $(`#pinned-case-status-${index}`).value = item.status || "";
  }
  applyProfileEffect(profile.profile_effect || "snow");
}

function applyProfileEffect(effect) {
  const root = document.documentElement;
  root.dataset.profileEffect = effect || "none";
  const host = $("#profile-identity");
  if (host) host.dataset.profileEffect = effect || "none";
}

function renderColleagues() {
  const query = ($("#colleagues-search")?.value || "").toLocaleLowerCase("ru");
  const roleFilter = $("#colleagues-role-filter")?.value || "all";
  const colleagues = state.colleagues.filter((item) => {
    const haystack = [
      item.display_name,
      item.role,
      item.profile_bio,
      ...(item.pinnedCases || []).map((caseItem) => `${caseItem.title} ${caseItem.status}`)
    ].join(" ").toLocaleLowerCase("ru");
    return (roleFilter === "all" || item.role === roleFilter) &&
      (!query || haystack.includes(query));
  });
  $("#colleagues-grid").innerHTML = colleagues.length
    ? colleagues.map((item) => {
      const pinned = (item.pinnedCases || []).slice(0, 3);
      const discordLink = item.discord_id
        ? `<a class="btn small subtle colleague-discord" href="https://discord.com/users/${escapeHtml(item.discord_id)}" target="_blank" rel="noopener noreferrer">
            <svg class="svg-icon"><use href="#i-discord"></use></svg>Написать в Discord</a>`
        : `<span class="badge rejected">Discord не привязан</span>`;
      const forumLink = item.forum_profile_url
        ? `<a class="btn small subtle" href="${escapeHtml(item.forum_profile_url)}" target="_blank" rel="noopener noreferrer">Профиль на форуме${item.forum_profile_verified_at ? " · проверен" : ""}</a>`
        : "";
      return `<article class="colleague-card" data-effect="${escapeHtml(item.profile_effect || "snow")}">
        <div class="colleague-effect" aria-hidden="true"></div>
        <div class="colleague-profile">
          <img class="colleague-portrait" src="${escapeHtml(rolePortraitUrl(item.role))}" alt="Портрет должности ${escapeHtml(item.role)}">
          <div><h3><button class="profile-trigger" data-profile-id="${escapeHtml(item.id)}" type="button">${escapeHtml(item.display_name)}</button></h3>
            <div class="meta">${escapeHtml(item.role)}${item.member_since ? ` · с ${escapeHtml(profileDate(item.member_since))}` : ""}</div></div>
        </div>
        ${discordPresenceBadge(item.presence)}
        ${item.profile_quote ? `<blockquote class="colleague-quote">«${escapeHtml(item.profile_quote)}»</blockquote>` : ""}
        ${item.profile_bio ? `<p class="colleague-bio">${escapeHtml(item.profile_bio)}</p>` : `<p class="colleague-bio muted">Био пока не заполнено.</p>`}
        <div class="colleague-achievements">
          ${(item.achievements || []).slice(0, 6).map((achievement) =>
            `<button class="profile-achievement colleague-achievement" type="button"
              data-achievement-detail="${escapeHtml(achievement.title)}|${escapeHtml(achievement.description)}|${escapeHtml(achievement.metric)}|${escapeHtml(achievement.threshold)}"
              title="${escapeHtml(achievement.title)} — ${escapeHtml(achievement.description)}">
              ${achievementIcon(achievement.icon)}<span>${escapeHtml(achievement.title)}</span>
            </button>`).join("") || `<span class="help">Достижения пока не получены.</span>`}
        </div>
        <div class="colleague-pinned">
          <h4>Закреплённые дела</h4>
          ${pinned.length
            ? pinned.map((caseItem) => `<div class="colleague-case"><strong>${escapeHtml(caseItem.title)}</strong>${caseItem.status ? `<span>${escapeHtml(caseItem.status)}</span>` : ""}</div>`).join("")
            : `<div class="help">Закрепленных дел пока нет.</div>`}
        </div>
        <div class="colleague-stats">
          <span><strong>${item.document_count}</strong> документов</span>
          <span><strong>${item.lawsuit_count}</strong> исков</span>
          <span><strong>${item.closed_case_count}</strong> обращений</span>
        </div>
        <div class="request-actions">${discordLink}${forumLink}
          <button class="btn small" type="button" data-profile-id="${escapeHtml(item.id)}">Открыть профиль</button></div>
      </article>`;
    }).join("")
    : `<div class="empty">Коллеги по выбранному фильтру не найдены.</div>`;
}

function renderAll() {
  if (!currentUser) return;
  renderRequests();
  renderTasks();
  renderCalendar();
  renderDashboardWorkspaces();
  renderAttorneys();
  renderReprimands();
  renderDocumentsArchive();
  renderCareerProgress();
  renderPersonalProfile();
  renderAchievementsPage();
  renderReserve();
  renderAbsences();
  renderCharacteristics();
  renderAcademy();
  renderProfileCustomization();
  renderColleagues();
  $("#my-request-count").textContent = String(isManager()
    ? state.requests.length : state.requests.filter((item) => item.user_id === currentUser.id).length);
  $("#pending-count").textContent = String(state.requests.filter((item) => item.status === "pending").length);
  $("#law-count").textContent = `${Object.keys(state.laws).length} / ${Object.keys(lawMeta).length}`;
  $("#document-count").textContent = String(state.documentCount);
  $("#lawsuit-count").textContent = String(state.lawsuits.filter((item) =>
    (isManager() || item.user_id === currentUser.id) && item.forum_status === "approved").length);
  renderLaws();
  renderLawsuits();
  renderAttestations();
  renderManagement();
}

function renderReprimands() {
  const staffMembers = members.filter((member) => member.status === "active" && member.role !== "Гражданин");
  if (isManager()) {
    $("#reprimand-member").innerHTML = `<option value="">Выберите сотрудника</option>` +
      staffMembers.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
  }
  $("#reprimand-list").innerHTML = state.reprimands.length
    ? state.reprimands.map((item) => {
      const date = new Date(item.created_at);
      const dateText = Number.isNaN(date.getTime()) ? item.created_at : date.toLocaleString("ru-RU");
      return `<article class="request-card">
        <div class="request-top"><div><h4>Выговор №${escapeHtml(item.id)} · ${escapeHtml(item.display_name)}</h4>
          <div class="meta">${escapeHtml(item.role)} · выдал(а): ${escapeHtml(item.issuer_name)}${dateText ? ` · ${escapeHtml(dateText)}` : ""}</div></div>
          <span class="badge rejected">Взыскание</span></div>
        <p>${escapeHtml(item.reason)}</p>
        <a class="attachment-link" href="/api/reprimands/${encodeURIComponent(item.id)}/photo" target="_blank" rel="noopener noreferrer">Открыть фото-подтверждение · ${escapeHtml(item.photo_name)}</a>
      </article>`;
    }).join("")
    : `<div class="empty">Выговоров пока нет.</div>`;
}

function renderDocumentsArchive() {
  $("#document-archive").innerHTML = state.documents.length
    ? state.documents.map((document) => {
      const created = new Date(document.created_at);
      const date = Number.isNaN(created.getTime()) ? "" : created.toLocaleString("ru-RU");
      const forumStatus = {
        draft: "Черновик · не засчитан",
        pending: "Ожидает проверки ссылки",
        approved: "Публикация подтверждена",
        rejected: "Нужно исправить публикацию"
      }[document.forum_status] || "Не отправлено";
      const review = document.forum_review_note
        ? `<div class="note warning">${escapeHtml(document.forum_review_note)}</div>` : "";
      const publication = document.forum_status === "pending" && isManager()
        ? `<div class="field"><label for="document-review-note-${document.id}">Комментарий (обязателен при отклонении)</label>
            <input id="document-review-note-${document.id}" maxlength="500" data-forum-note="${document.id}" placeholder="Причина решения"></div>
          <div class="request-actions">
            <button class="btn small primary" data-forum-review="approved" data-document-id="${document.id}">Подтвердить ссылку</button>
            <button class="btn small danger" data-forum-review="rejected" data-document-id="${document.id}">Отклонить</button>
          </div>`
        : ["draft", "rejected"].includes(document.forum_status) && document.user_id === currentUser.id
          ? `<div class="forum-publish"><div class="field"><label for="document-forum-${document.id}">Ссылка на публикацию на форуме</label>
              <input id="document-forum-${document.id}" type="url" maxlength="500" data-forum-url="${document.id}" placeholder="https://forum.../topic/..."></div>
              <button class="btn small primary" data-submit-forum="${document.id}" type="button">Отправить на проверку</button></div>`
          : "";
      const forumLink = document.forum_url
        ? `<div class="meta"><a href="${escapeHtml(document.forum_url)}" target="_blank" rel="noopener noreferrer">Открыть публикацию на форуме</a></div>`
        : "";
      return `<article class="request-card">
        <div class="request-top"><div><h4>${escapeHtml(document.title)}</h4>
          <div class="meta">${escapeHtml(document.display_name || currentUser.displayName)}${date ? " · " + escapeHtml(date) : ""}</div></div>
          <span class="badge ${document.forum_status === "approved" ? "approved" : document.forum_status === "rejected" ? "rejected" : "pending"}">${forumStatus}</span>
          <button class="btn small subtle" type="button" data-open-document="${escapeHtml(document.id)}">Открыть</button></div>
        ${forumLink}${review}${publication}
      </article>`;
    }).join("")
    : `<div class="empty">Пока нет документов. Сформированный шаблон можно сохранить как черновик; зачёт появится только после публикации и подтверждения руководством.</div>`;
}

async function refreshPortalData() {
  try {
    const health = await api("/api/health");
    if (health.apiVersion !== 4) {
      throw new Error("Сервер портала устарел. Закройте старый EXE/сервер, запустите обновлённую версию и обновите страницу.");
    }
    const citizen = role() === "Гражданин";
    const canUseDocuments = ["Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(role());
    const [applicationData, lawData, attestationData, documentData, lawsuitData, promotionData, taskData, calendarData, profileData, attorneyData, personalProfileData, achievementData, reserveData, absenceData, characteristicData, academyData, colleagueData] = await Promise.all([
      api("/api/applications"),
      citizen ? Promise.resolve({ laws: {} }) : api("/api/laws"),
      citizen ? Promise.resolve({ attestations: [] }) : api("/api/attestations"),
      canUseDocuments ? api("/api/documents") : Promise.resolve({ documents: [], myCount: 0 }),
      canUseDocuments ? api("/api/lawsuits") : Promise.resolve({ lawsuits: [] }),
      citizen ? Promise.resolve({ lawyerCallsRequired: 0 }) : api("/api/promotion-requirements"),
      citizen ? Promise.resolve({ tasks: [] }) : api("/api/tasks"),
      citizen ? Promise.resolve({ events: [] }) : api("/api/calendar"),
      api(`/api/profiles/${encodeURIComponent(currentUser.id)}`),
      api(`/api/attorneys?period=${encodeURIComponent($("#ranking-period").value || "all")}`),
      api("/api/profile"),
      citizen ? Promise.resolve({ achievements: [] }) : api("/api/achievements"),
      citizen ? Promise.resolve({ reserve: [] }) : api("/api/reserve"),
      citizen ? Promise.resolve({ absences: [] }) : api("/api/absences"),
      isManager() ? api("/api/characteristics") : Promise.resolve({ characteristics: [] }),
      citizen ? Promise.resolve({ materials: [] }) : api("/api/academy"),
      citizen ? Promise.resolve({ colleagues: [] }) : api("/api/colleagues")
    ]);
    state.requests = applicationData.applications;
    state.documents = documentData.documents;
    state.documentCount = documentData.approvedCount ?? documentData.myCount;
    state.lawsuits = lawsuitData.lawsuits;
    state.tasks = taskData.tasks;
    state.events = calendarData.events;
    state.profileStats = profileData.profile;
    state.attorneys = attorneyData.attorneys;
    state.profileData = personalProfileData;
    state.achievementData = achievementData;
    state.reserve = reserveData.reserve;
    state.absences = absenceData.absences;
    state.characteristics = characteristicData.characteristics;
    state.academyMaterials = academyData.materials;
    state.colleagues = colleagueData.colleagues;
    promotionRequirements = promotionData;
    attestations = attestationData.attestations;
    const loadedLaws = await Promise.all(Object.entries(lawData.laws)
      .filter(([, info]) => info.available)
      .map(async ([key]) => [key, await api(`/api/laws/${key}`)]));
    state.laws = Object.fromEntries(loadedLaws.map(([key, result]) => [key, {
      name: result.name,
      text: result.text,
      sourceNote: result.sourceNote || ""
    }]));
    $("#law-count").textContent = `${Object.keys(state.laws).length} / ${Object.keys(lawMeta).length}`;
    if (isManager()) {
      const memberData = await api("/api/members");
      members = memberData.members;
    } else {
      members = [];
    }
    if (citizen) {
      state.reprimands = [];
    } else {
      const reprimandData = await api("/api/reprimands");
      state.reprimands = reprimandData.reprimands;
    }
    updateApplicationPlaceholder();
    await loadEliteAwards();
    renderAll();
    maybeShowWelcome();
  } catch (error) {
    if (error.message.includes("привяжите Discord")) {
      const session = await api("/api/auth/me");
      if (session.user) enterPortal(session);
      return;
    }
    notify(error.message);
  }
}

async function refreshDiscordStatus() {
  if (!currentUser || currentUser.status !== "active") return;
  try {
    const status = await api("/api/discord/status");
    const button = $("#discord-link");
    const requiredButton = $("#discord-required-link");
    const syncButton = $("#discord-sync");
    const message = $("#discord-status");
    const nicknameMessage = $("#discord-nickname-status");
    const avatar = $("#discord-avatar");
    button.classList.remove("hidden");
    avatar.classList.toggle("hidden", !status.avatarUrl);
    if (status.avatarUrl) avatar.src = status.avatarUrl;
    else avatar.removeAttribute("src");
    button.disabled = !status.configured;
    button.title = status.linked ? "Перепривязать Discord" : "Привязать Discord";
    button.setAttribute("aria-label", button.title);
    requiredButton.disabled = !status.configured;
    $("#discord-required-status").textContent = !status.configured
      ? "Владелец портала ещё не настроил Discord OAuth. Обратитесь к ГКА."
      : "Привязка откроется на официальном сайте Discord; пароль остаётся у Discord.";
    syncButton.classList.toggle("hidden", !status.linked || !status.botConfigured);
    syncButton.disabled = !status.botConfigured;
    message.textContent = !status.configured
      ? "Discord OAuth настраивается владельцем портала."
      : status.syncError || (status.linked ? `Аккаунт: ${status.username}` : "");
    message.classList.toggle("hidden", !message.textContent);
    message.classList.toggle("warning-text", Boolean(status.syncError || !status.configured));
    nicknameMessage.classList.toggle("hidden", !status.nicknameWarning);
    nicknameMessage.textContent = status.nicknameWarning
      ? `Ник не изменён: ${status.nicknameWarning}`
      : "";
    const presence = $("#profile-presence");
    const presenceLabels = { online: "Активен", idle: "Неактивен", dnd: "Не беспокоить", offline: "Не в сети" };
    const presenceStatus = ["online","idle","dnd","offline"].includes(status.presence) ? status.presence : "offline";
    presence.className = `presence-badge presence-${presenceStatus}`;
    presence.innerHTML = `<i></i><b>${presenceLabels[presenceStatus]}</b>`;
  } catch (error) {
    notify(error.message);
  }
}

async function linkDiscord() {
  try {
    const result = await api("/api/discord/link", { method: "POST", body: {} });
    window.location.assign(result.authorizeUrl);
  } catch (error) {
    notify(error.message);
  }
}

async function syncDiscord() {
  try {
    const result = await api("/api/discord/sync", { method: "POST", body: {} });
    await refreshDiscordStatus();
    notify(result.syncError || result.nicknameWarning || "Роль и ник Discord синхронизированы.");
  } catch (error) {
    notify(error.message);
  }
}

async function openProfile(id) {
  try {
    const { profile, reviews, achievements = [], awards = [] } = await api(`/api/profiles/${encodeURIComponent(id)}`);
    const avatar = `<img class="role-portrait" src="${escapeHtml(rolePortraitUrl(profile.role))}" alt="Портрет должности ${escapeHtml(profile.role)}">`;
    const rating = profile.review_count
      ? `<div><span class="rating-stars">${"★".repeat(Math.round(profile.average_rating))}${"☆".repeat(5 - Math.round(profile.average_rating))}</span> ${profile.average_rating.toFixed(1)}/5 · отзывов: ${profile.review_count}</div>`
      : `<div class="muted">Оценок пока нет</div>`;
    const pinnedCases = Array.isArray(profile.profile_pinned_cases) ? profile.profile_pinned_cases : [];
    const discordProfileLink = profile.discord_id
      ? `<a class="btn small subtle" href="https://discord.com/users/${escapeHtml(profile.discord_id)}" target="_blank" rel="noopener noreferrer">Написать в Discord</a>`
      : "";
    const effect = escapeHtml(profile.profile_effect || "none");
    $("#profile-dialog-title").textContent = profile.display_name;
    $("#profile-dialog-body").innerHTML = `<div class="profile-hero profile-effect-${effect}">${avatar}<div><h3 style="margin:0">${escapeHtml(profile.display_name)}</h3>
        <div class="meta">${escapeHtml(profile.role)}${profile.discord_username ? ` · Discord: @${escapeHtml(profile.discord_username)}` : ""}</div>
        <div class="meta">Дата вступления: ${profile.member_since ? escapeHtml(profileDate(profile.member_since)) : "не указана"}</div>
        ${discordPresenceBadge(profile.presence)}
        ${profile.profile_quote ? `<blockquote class="profile-quote">«${escapeHtml(profile.profile_quote)}»</blockquote>` : ""}
        ${profile.forum_profile_url ? `<a href="${escapeHtml(profile.forum_profile_url)}" target="_blank" rel="noopener noreferrer">Профиль на форуме${profile.forum_profile_verified_at ? " · проверен" : ""}</a>` : ""}
      </div></div>
      ${discordProfileLink ? `<div class="profile-contact-actions">${discordProfileLink}</div>` : ""}
      <article class="request-card profile-bio-card"><h4>О сотруднике</h4><p>${escapeHtml(profile.profile_bio || "Био не заполнено.")}</p></article>
      <article class="request-card"><h4>Закреплённые дела</h4>${pinnedCases.length
        ? pinnedCases.map((item) => `<div class="compact-row"><span class="compact-icon">§</span><div class="compact-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.status || "Статус не указан")}</small></div></div>`).join("")
        : `<div class="muted">Закрепленных дел пока нет.</div>`}</article>
      <div class="grid stats">
        <div class="stat"><span class="stat-label">Документы</span><strong class="stat-value">${profile.document_count}</strong></div>
        <div class="stat"><span class="stat-label">Судебные дела</span><strong class="stat-value">${profile.lawsuit_count}</strong></div>
        <div class="stat"><span class="stat-label">Закрытые обращения</span><strong class="stat-value">${profile.closed_case_count}</strong></div>
      </div>
      <article class="request-card"><h4>Рейтинг</h4>${rating}</article>
      <article class="request-card"><h4>Достижения</h4>${achievements.length
        ? achievements.map((item) => `<details class="achievement-detail-inline"><summary>${achievementIcon(item.icon)}<strong>${escapeHtml(item.title)}</strong></summary>
            <p>${escapeHtml(item.description || "Руководство вручает достижение за профессиональный вклад.")}</p>
            <div class="meta">Получено ${escapeHtml(profileDate(item.awarded_at))}${item.threshold ? ` · Требуется: ${escapeHtml(item.threshold)} · ${escapeHtml(item.metric)}` : ""}</div></details>`).join("")
        : `<div class="muted">Достижений пока нет.</div>`}</article>
      <article class="request-card"><h4>Награды Коллегии</h4>${awards.length
        ? awards.map((item) => `<div class="compact-row"><span class="compact-icon">★</span><div class="compact-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(profileDate(item.created_at))}</small></div></div>`).join("")
        : `<div class="muted">Наград пока нет.</div>`}</article>
      <div class="stack"><h3 style="margin:0">Отзывы граждан</h3>${reviews.length
        ? reviews.map((review) => `<article class="request-card"><div class="request-top"><strong>${escapeHtml(review.reviewer_name)}</strong><span class="rating-stars">${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</span></div>
            ${review.comment ? `<p>${escapeHtml(review.comment)}</p>` : ""}<div class="meta">${escapeHtml(review.created_at)}</div></article>`).join("")
        : `<div class="empty">Отзывов пока нет.</div>`}</div>`;
    $("#profile-dialog").showModal();
  } catch (error) {
    notify(error.message);
  }
}

async function startExam(attestationId = 0, subject = "") {
  try {
    if (!attestationId && !subject) {
      const startResult = await api("/api/exams/start", {
        method: "POST", body: { studyConfirmed: true }
      });
      if (startResult.webhookWarning) notify(startResult.webhookWarning);
    }
    const params = new URLSearchParams();
    if (attestationId) params.set("attestationId", String(attestationId));
    if (subject) params.set("subject", subject);
    const suffix = params.toString() ? `?${params}` : "";
    const data = await api(`/api/exams/current${suffix}`);
    currentAttestationId = attestationId;
    currentQuiz = data;
    currentQuiz.answers = Array(data.questions.length).fill(-1);
    currentQuiz.step = 0;
    $("#quiz-dialog-title").textContent = data.track || lawExamSubjects[data.subject] || "Экзамен";
    $("#quiz-dialog").showModal();
    renderQuizStep();
  } catch (error) {
    notify(error.message);
  }
}

function renderQuizStep() {
  if (!currentQuiz) return;
  const index = currentQuiz.step;
  const question = currentQuiz.questions[index];
  const subjectName = lawExamSubjects[currentQuiz.subject] || "Проверка знаний";
  $("#quiz-dialog-content").innerHTML = `<form id="quiz-form" class="stack">
    <div class="meta">${escapeHtml(subjectName)} · вопрос ${index + 1} из ${currentQuiz.questions.length}</div>
    <div class="quiz-progress" role="progressbar" aria-valuenow="${index + 1}" aria-valuemin="1" aria-valuemax="${currentQuiz.questions.length}"><span style="width:${((index + 1) / currentQuiz.questions.length) * 100}%"></span></div>
    <article class="quiz-card">
      <strong>${index + 1}. ${escapeHtml(question.q)}</strong>
      <div class="quiz-options">${question.answers.map((answer, answerIndex) => `<label class="quiz-option">
        <input type="radio" name="answer" value="${answerIndex}"${currentQuiz.answers[index] === answerIndex ? " checked" : ""} required>
        <span>${escapeHtml(answer)}</span></label>`).join("")}</div>
    </article>
    <div class="request-actions">
      ${index ? `<button class="btn" type="button" id="quiz-back">Назад</button>` : ""}
      ${index < currentQuiz.questions.length - 1
        ? `<button class="btn primary" type="submit">Далее</button>`
        : `<button class="btn primary" type="submit">Завершить тест</button>`}
    </div>
  </form>`;
}

function renderQuizResult(result) {
  const note = currentQuiz.subject
    ? "Результат теста по законодательству сохранён в истории."
    : result.user
      ? `Поздравляем! Новая роль: ${result.user.role}. Обзвон для этого перехода не требуется.`
      : result.interviewRequired
        ? "Тест записан. Выберите готовность к обзвону — руководство увидит ваш ответ."
        : result.passed ? "Результат сохранён. Продолжите следующий шаг этапа." : "Изучите материалы и попробуйте ещё раз.";
  $("#quiz-dialog-content").innerHTML = `<div class="quiz-result"><strong>${result.passed ? "Тест пройден" : "Тест не пройден"}: ${result.score} из ${result.total}</strong>
    <p class="help">${escapeHtml(note)}</p>
    ${currentQuiz.subject ? `<button class="btn small" id="retry-law-exam" data-subject="${escapeHtml(currentQuiz.subject)}" type="button">Пройти тест ещё раз</button>` : ""}</div>`;
  if (result.user) {
    currentUser = result.user;
    sessionStorage.setItem(`mirror-welcome:${currentUser.id}:${currentUser.role}`, "shown");
    csrfToken = csrfToken || "";
    renderRole();
  } else {
    refreshPortalData();
  }
  if (result.interviewRequired) {
    $("#interview-dialog").dataset.applicationId = String(result.applicationId);
    if (!$("#interview-dialog").open) $("#interview-dialog").showModal();
  }
}

async function handleInterviewChange(button) {
  const applicationId = button.dataset.id || $("#interview-dialog").dataset.applicationId;
  const status = button.dataset.interview;
  if (!applicationId || !status) return;
  try {
    const result = await api(`/api/applications/${encodeURIComponent(applicationId)}/interview`, {
      method: "PATCH", body: { status }
    });
    $("#interview-dialog").close();
    notify(result.logWarning || (status === "ready" ? "Готовность к обзвону отмечена и записана." : "Отметили, что сейчас вы не можете. Готовность можно включить позже."));
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

async function saveJuniorRequirements(form) {
  const application = state.requests.find((item) =>
    item.type === "exam" && item.user_id === currentUser.id && item.stage_role === "Юрист" &&
    item.career_flow && item.status === "pending");
  if (!application) return;
  try {
    await api(`/api/applications/${encodeURIComponent(application.id)}/promotion-data`, {
      method: "PATCH",
      body: {
        completedCalls: Number($("#career-completed-calls", form).value),
        trialLawsuitReference: $("#career-trial-lawsuit", form).value.trim()
      }
    });
    notify("Условия перехода сохранены. Теперь можно отметить готовность к обзвону.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

async function handleReview(button) {
  try {
    const card = button.closest(".request-card");
    const criteria = Object.fromEntries($$("[data-review-criterion]", card)
      .map((input) => [input.dataset.reviewCriterion, input.checked]));
    const result = await api(`/api/applications/${encodeURIComponent(button.dataset.id)}/review`, {
      method: "PATCH", body: { status: button.dataset.review, criteria }
    });
    notify(result.discordWarning || result.nicknameWarning || result.logWarning ||
      (button.dataset.review === "approved" ? "Решение сохранено." : "Заявка отклонена."));
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

async function handleAssignment(button) {
  try {
    const result = await api(`/api/applications/${encodeURIComponent(button.dataset.assign)}/assign`, { method: "PATCH", body: {} });
    notify(result.webhookWarning || "Обращение назначено вам. Открываю личный чат с гражданином.");
    await refreshPortalData();
    await openCaseChat(button.dataset.assign);
  } catch (error) {
    notify(error.message);
  }
}

async function saveCaseAssignee(button) {
  const id = button.dataset.saveCaseAssignee;
  const selected = $(`[data-case-assignee="${id}"]`).value;
  button.disabled = true;
  try {
    const result = await api(`/api/applications/${encodeURIComponent(id)}/assign`, {
      method: "PATCH", body: { userId: selected ? Number(selected) : null }
    });
    notify(result.webhookWarning || (selected ? "Исполнитель обращения изменён." : "Обращение возвращено в общую очередь."));
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

async function handleCloseCase(button) {
  try {
    const id = button.dataset.closeCase || activeChatId;
    const result = await api(`/api/applications/${encodeURIComponent(id)}/close`, { method: "PATCH", body: {} });
    window.clearInterval(chatPollTimer);
    chatPollTimer = 0;
    $("#case-chat-dialog").close();
    activeChatId = null;
    notify(result.webhookWarning || "Обращение закрыто.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

async function openCaseChat(id) {
  activeChatId = String(id);
  const request = state.requests.find((item) => String(item.id) === activeChatId);
  $("#chat-title").textContent = request ? `Обращение #${request.id}` : "Чат обращения";
  $("#chat-case-meta").textContent = request
    ? `${request.display_name || "Гражданин"} · ${request.assigned_name || currentUser.displayName}${request.assigned_discord_username ? ` · @${request.assigned_discord_username}` : ""}`
    : "";
  $("#chat-share-contact").classList.toggle("hidden", !currentUser.discordLinked);
  if (!$("#case-chat-dialog").open) $("#case-chat-dialog").showModal();
  const loaded = await loadCaseChat(activeChatId);
  if (!loaded || !$("#case-chat-dialog").open) return;
  window.clearInterval(chatPollTimer);
  chatPollTimer = window.setInterval(() => {
    if (activeChatId && $("#case-chat-dialog").open) loadCaseChat(activeChatId);
  }, 4000);
}

async function loadCaseChat(id) {
  try {
    const data = await api(`/api/applications/${encodeURIComponent(id)}/messages`);
    if (String(id) !== activeChatId) return;
    $("#chat-messages").innerHTML = data.messages.length
      ? data.messages.map((message) => {
        const mine = message.sender_id === currentUser.id;
        const time = new Date(message.created_at);
        const timeText = Number.isNaN(time.getTime()) ? "" : time.toLocaleString("ru-RU");
        return `<article class="chat-message${mine ? " mine" : ""}${message.kind === "contact" ? " contact" : ""}">
          <div class="meta">${escapeHtml(message.sender_name)} · ${escapeHtml(message.sender_role)}${message.sender_discord_username ? ` · @${escapeHtml(message.sender_discord_username)}` : ""}${timeText ? ` · ${escapeHtml(timeText)}` : ""}</div>
          <p>${escapeHtml(message.message)}</p>
        </article>`;
      }).join("")
      : `<div class="empty">Чат открыт. Напишите первое сообщение или поделитесь контактом.</div>`;
    $("#chat-close-case").classList.toggle("hidden", !data.canClose);
    $("#chat-form").classList.toggle("hidden", data.completed);
    $("#chat-share-contact").classList.toggle("hidden", data.completed || !currentUser.discordLinked);
    $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
    return true;
  } catch (error) {
    notify(error.message);
    window.clearInterval(chatPollTimer);
    chatPollTimer = 0;
    return false;
  }
}

async function shareCaseContact() {
  if (!activeChatId) return;
  try {
    await api(`/api/applications/${encodeURIComponent(activeChatId)}/contact`, {
      method: "POST", body: { type: "contact" }
    });
    await loadCaseChat(activeChatId);
  } catch (error) {
    notify(error.message);
  }
}

async function submitChatMessage(event) {
  event.preventDefault();
  if (!activeChatId) return;
  const message = $("#chat-message-input").value.trim();
  try {
    await api(`/api/applications/${encodeURIComponent(activeChatId)}/messages`, {
      method: "POST", body: { message }
    });
    $("#chat-message-input").value = "";
    await loadCaseChat(activeChatId);
  } catch (error) {
    notify(error.message);
  }
}

function renderDocumentFields() {
  const key = $("#doc-template").value;
  const schema = docSchemas[key];
  generatedDocumentId = null;
  $("#forum-publish").classList.add("hidden");
  $("#submit-lawsuit").classList.add("hidden");
  $("#submit-forum-document").classList.add("hidden");
  $("#save-document").classList.remove("hidden");
  $("#document-guidance").textContent = schema.guidance || "Поля и порядок разделов соответствуют присланной форме. Незаполненные необязательные поля останутся пустыми.";
  $("#document-fields").innerHTML = schema.groups.map((group, groupIndex) =>
    `<section class="document-group"><h4>${escapeHtml(group.title)}</h4><div class="stack">
    ${group.fields.map((item) => {
      const id = `doc-${groupIndex}-${item.key}`;
      const required = item.required ? " required" : "";
      let value = item.defaultToday ? new Date().toLocaleDateString("ru-RU") : item.value || "";
      if (item.readOnly) value = "Будет выдан при формировании";
      if (item.type === "checkbox") {
        return `<label class="quiz-option" for="${id}"><input id="${id}" data-doc-key="${item.key}" type="checkbox"${required}><span>${escapeHtml(item.label)}</span></label>`;
      }
      if (item.type === "select") {
        const options = item.key === "severity"
          ? ["25000|Без звезды · $25,000", "50000|* · $50,000", "75000|** · $75,000", "100000|*** / **** · $100,000"]
          : item.options;
        return `<div class="field"><label for="${id}">${escapeHtml(item.label)}</label><select id="${id}" data-doc-key="${item.key}"${required}>
          <option value="">Выберите значение</option>${options.map((option) => {
            const parts = item.key === "severity" ? option.split("|") : [option, option];
            return `<option value="${escapeHtml(parts[0])}">${escapeHtml(parts[1])}</option>`;
          }).join("")}</select></div>`;
      }
      const placeholder = item.placeholder ? ` placeholder="${escapeHtml(item.placeholder)}"` : "";
      const control = item.type === "textarea"
          ? `<textarea id="${id}" data-doc-key="${item.key}" rows="${item.rows || 3}" maxlength="3000"${required}${placeholder}>${escapeHtml(value)}</textarea>`
          : `<input id="${id}" data-doc-key="${item.key}" type="${item.type || "text"}" maxlength="300"${item.min !== undefined ? ` min="${item.min}"` : ""}${item.step ? ` step="${item.step}"` : ""}${required}${item.readOnly ? " readonly" : ""}${placeholder}${value ? ` value="${escapeHtml(value)}"` : ""}>`;
      return `<div class="field"><label for="${id}">${escapeHtml(item.label)}</label>${control}</div>`;
    }).join("")}
    </div></section>`).join("");
  $("#document-output").value = "";
  $("#forum-publish-url").value = "";
  $("#forum-preview").textContent = "Заполните форму и нажмите «Сформировать документ».";
  $("#paper-text").textContent = "";
  $("#paper-signature").textContent = "";
}

function documentValues() {
  const values = {};
  $$("[data-doc-key]", $("#document-fields")).forEach((input) => {
    values[input.dataset.docKey] = input.type === "checkbox"
      ? (input.checked ? "Да" : "Нет")
      : input.value.trim();
  });
  return values;
}

function parseComplaintEventDate(value) {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4}),?\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText, hourText, minuteText] = match;
  const date = new Date(Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText));
  if (date.getFullYear() !== Number(yearText) || date.getMonth() !== Number(monthText) - 1 ||
      date.getDate() !== Number(dayText) || date.getHours() !== Number(hourText) ||
      date.getMinutes() !== Number(minuteText)) return null;
  return date;
}

function bbValue(value) {
  return String(value || "________________").replace(/\[/g, "［").replace(/\]/g, "］").replace(/\r\n/g, "\n");
}

function formatList(values) {
  return `[LIST]\n${values.map((value) => `[*]${bbValue(value)}`).join("\n")}\n[/LIST]`;
}

function formatNumberedList(values) {
  return `[LIST=1]\n${values.map((value) => `[*]${bbValue(value)}`).join("\n")}\n[/LIST]`;
}

function makeDocument(values) {
  const idLink = bbValue(values.idCopy);
  const attachments = formatList([
    `Копия паспорта истца: ${values.claimantPassport}`,
    `Доказательства уплаты государственной пошлины: ${values.feeProof}`,
    `Доказательства: ${values.evidence}`,
    `Иные документы: ${values.otherDocs}`
  ]);
  const representativeAttachments = formatList([
    `Копия паспорта представителя истца: ${values.repPassport}`,
    `Удостоверение представителя истца: ${values.repCredential}`,
    `Копия заключенного договора: ${values.contract}`,
    `Доказательства заключения договора: ${values.contractProof}`
  ]);
  const filingDate = bbValue(values.filingDate || new Date().toLocaleDateString("ru-RU"));
  const templates = {
    complaint: () => `[B]Название темы: Жалоба в прокуратуру №${bbValue(values.cpNumber)} Организация (${bbValue(values.organization)})[/B]

Я, гражданин штата San-Andreas ${bbValue(values.complainant)}, подаю жалобу в прокуратуру на гражданина ${bbValue(values.target)}.

[B]Подробное описание правонарушения:[/B]
${bbValue(values.complaintFacts)}

[B]Доказательства и запрос на изъятие:[/B]
${bbValue(values.evidence)}
Запрос на изъятие: ${bbValue(values.seizureRequest)}
Место изъятия записи: ${bbValue(values.seizurePlace)}

[B]Дата и время произошедшего:[/B] ${bbValue(values.eventDate)}
[B]Место произошедшего:[/B] ${bbValue(values.eventPlace)}
[B]OOC-видеозапись и описание места на записи:[/B] ${bbValue(values.oocVideo)}
[B]Продолжительность видео:[/B] ${bbValue(values.videoMinutes)} мин.
[B]Тайм-коды:[/B] ${bbValue(values.timecodes)}
[B]Заключение врача:[/B] ${bbValue(values.medicalReport)}

[B]К жалобе прилагаю:[/B]
Электронная копия ID-карты: ${idLink}
Номер телефона: ${bbValue(values.phone)}
Электронная почта: ${bbValue(values.email)}
Место работы: ${bbValue(values.workplace)}
Должность: ${bbValue(values.position)}
Доказательства записаны от лица заявителя: ${bbValue(values.ownEvidence)}`,
    "lawsuit-supreme": () => `[TABLE width="100%"]
[TR]
[td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]${docSchemas["lawsuit-supreme"].court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/FONT][/SIZE][/RIGHT]
[CENTER]
[SIZE=6][FONT=times new roman][B]ИСКОВОЕ ЗАЯВЛЕНИЕ[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman]
[B]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА.

Данные истца. [/B]
[LIST]
[*]Имя и фамилия: ${bbValue(values.claimant)}
[*]Номер ID-карты: ${bbValue(values.claimantId)}
[*]Номер телефона: ${bbValue(values.claimantPhone)}
[*]Электронная почта: ${bbValue(values.claimantEmail)}
[/LIST]
[B]Данные представителя истца.[/B]
[LIST]
[*]Имя и фамилия: ${bbValue(values.repName)}
[*]Номер ID-карты: ${bbValue(values.repId)}
[*]Данные о лицензии адвоката: ${bbValue(values.repLicense)}
[*]Номер телефона: ${bbValue(values.repPhone)}
[*]Электронная почта: ${bbValue(values.repEmail)}
[/LIST]
[B]Данные ответчика.[/B]
[LIST]
[*]Имя и фамилия: ${bbValue(values.defendant)}
[*]Организация: ${bbValue(values.organization)}
[*]Идентификационный знак: ${bbValue(values.badge)}
[/LIST]
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
${bbValue(values.facts)}
[B]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ.[/B]
[LIST=1]
[*]Копия паспорта истца: ${bbValue(values.claimantPassport)}
[*]Доказательства уплаты государственной пошлины: ${bbValue(values.feeProof)}
[*]Доказательства: ${bbValue(values.evidence)}
[*]Иные документы: ${bbValue(values.otherDocs)}
[/LIST]
[B]Материалы от представителя истца:[/B]
[LIST=1]
[*]Копия паспорта представителя истца: ${bbValue(values.repPassport)}
[*]Удостоверение представителя истца: ${bbValue(values.repCredential)}
[*]Копия заключенного договора: ${bbValue(values.contract)}
[*]Доказательства заключения договора: ${bbValue(values.contractProof)}
[/LIST]
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ[/B]
На основании вышеизложенного, пользуясь своими правами, прошу суд:
${formatNumberedList(values.claims.split(/\n+/).filter(Boolean))}
[/FONT][/SIZE]
[RIGHT][SIZE=5][FONT=times new roman]Дата подачи заявления: ${filingDate}
Подпись истца или его представителя: ${bbValue(values.signature)}[/FONT][/SIZE][/RIGHT][/td]
[/TR]
[/TABLE]`,
    "lawsuit-federal": () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]${docSchemas["lawsuit-federal"].court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/FONT][/SIZE][/RIGHT]
[CENTER][SIZE=6][FONT=times new roman][B]ИСКОВОЕ ЗАЯВЛЕНИЕ[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman][B]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА.
Данные истца.[/B]
[LIST][*]Имя и фамилия: ${bbValue(values.claimant)}[*]Номер ID-карты: ${bbValue(values.claimantId)}[*]Номер телефона: ${bbValue(values.claimantPhone)}[*]Электронная почта: ${bbValue(values.claimantEmail)}[/LIST]
[B]Данные представителя истца.[/B]
[LIST][*]Имя и фамилия: ${bbValue(values.repName)}[*]Номер ID-карты: ${bbValue(values.repId)}[*]Данные о лицензии адвоката: ${bbValue(values.repLicense)}[*]Номер телефона: ${bbValue(values.repPhone)}[*]Электронная почта: ${bbValue(values.repEmail)}[/LIST]
[B]Данные ответчика.[/B]
[LIST][*]Имя и фамилия: ${bbValue(values.defendant)}[*]Организация: ${bbValue(values.organization)}[*]Идентификационный знак: ${bbValue(values.badge)}[/LIST]
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
${bbValue(values.facts)}
[B]III. МАТЕРИАЛЫ ОБРАЩЕНИЯ.
Материалы от истца:[/B]${attachments}
[B]Материалы от представителя истца:[/B]${representativeAttachments}
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ[/B]
На основании вышеизложенного, пользуясь своими правами, прошу суд:
${formatList(values.claims.split(/\n+/).filter(Boolean))}
[/FONT][/SIZE][RIGHT][SIZE=5][FONT=times new roman]Дата подачи заявления: ${filingDate}
Подпись истца или его представителя: ${bbValue(values.signature)}[/FONT][/SIZE][/RIGHT][/td][/TR][/TABLE]`,
    "indictment-supreme": () => `[TABLE width="100%"][TR][td width="100.0000%"][FONT=times new roman][SIZE=5][IMG width="1096px" size="1920x402"]https://i.imgur.com/sqgWpir.png[/IMG][/SIZE][/FONT]
[RIGHT][FONT=times new roman][SIZE=5]${docSchemas["indictment-supreme"].court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012[/SIZE][/FONT][/RIGHT]
[CENTER][FONT=times new roman][SIZE=5][B][COLOR=rgb(171, 196, 197)]ОБВИНИТЕЛЬНОЕ ЗАКЛЮЧЕНИЕ[/COLOR][/B]
Дело № ${bbValue(values.caseNumber)}[/SIZE][/FONT][/CENTER]
[FONT=times new roman][SIZE=5][B][COLOR=rgb(171, 196, 197)]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА. Представитель штата Сан-Андреас.[/COLOR][/B]
[LIST][*]Имя фамилия: ${bbValue(values.prosecutor)}[*]Номер ID-карты: ${bbValue(values.prosecutorId)}[*]Электронная почта: ${bbValue(values.prosecutorEmail)}[*]Должность: ${bbValue(values.prosecutorPosition)}[/LIST]
[B][COLOR=rgb(171, 196, 197)]Обвиняемый №1.[/COLOR][/B]
[LIST][*]Имя фамилия: ${bbValue(values.accused)}[*]Номер ID-карты: ${bbValue(values.accusedId)}[*]Место работы, должность: ${bbValue(values.accusedWork)}[*]Статьи обвинения: ${bbValue(values.articles)}[/LIST]
[B][COLOR=rgb(171, 196, 197)]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/COLOR][/B]
В рамках делопроизводства № ${bbValue(values.caseNumber)} формулируется следующее обвинение:
${bbValue(values.facts)}
[B][COLOR=rgb(171, 196, 197)]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ.[/COLOR][/B]
[LIST=1][*]Копия удостоверения представителя: ${bbValue(values.prosecutorId)}[*]Доказательства обвинения: ${bbValue(values.evidence)}[/LIST]
[B][COLOR=rgb(171, 196, 197)]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/COLOR][/B]
По итогам расследования прокуратура просит суд:
${formatList(values.requests.split(/\n+/).filter(Boolean))}
[RIGHT]Город Лос-Сантос, штат Сан-Андреас
${filingDate}
${bbValue(values.signature || values.prosecutor)}
Подпись[/RIGHT][/SIZE][/FONT][/td][/TR][/TABLE]`,
    "indictment-district": () => `[TABLE width="100%"][TR][td width="100.0000%"][FONT=times new roman][SIZE=5][IMG width="1096px" size="1920x402"]https://i.imgur.com/sqgWpir.png[/IMG][/SIZE][/FONT]
[RIGHT][FONT=times new roman][SIZE=5]${docSchemas["indictment-district"].court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012[/SIZE][/FONT][/RIGHT]
[CENTER][FONT=times new roman][SIZE=5][B][COLOR=rgb(171, 196, 197)]ОБВИНИТЕЛЬНОЕ ЗАКЛЮЧЕНИЕ[/COLOR][/B]
Дело № ${bbValue(values.caseNumber)}[/SIZE][/FONT][/CENTER]
[FONT=times new roman][SIZE=5][B][COLOR=rgb(171, 196, 197)]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА. Представитель штата Сан-Андреас.[/COLOR][/B]
[LIST][*]Имя фамилия: ${bbValue(values.prosecutor)}[*]Номер ID-карты: ${bbValue(values.prosecutorId)}[*]Электронная почта: ${bbValue(values.prosecutorEmail)}[*]Должность: ${bbValue(values.prosecutorPosition)}[/LIST]
[B][COLOR=rgb(171, 196, 197)]Обвиняемый №1.[/COLOR][/B]
[LIST][*]Имя фамилия: ${bbValue(values.accused)}[*]Номер ID-карты: ${bbValue(values.accusedId)}[*]Место работы, должность: ${bbValue(values.accusedWork)}[*]Статьи обвинения: ${bbValue(values.articles)}[/LIST]
[B][COLOR=rgb(171, 196, 197)]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/COLOR][/B]
В рамках делопроизводства № ${bbValue(values.caseNumber)} формулируется следующее обвинение:
${bbValue(values.facts)}
[B][COLOR=rgb(171, 196, 197)]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ.[/COLOR][/B]
[LIST=1][*]Копия удостоверения представителя: ${bbValue(values.prosecutorId)}[*]Доказательства обвинения: ${bbValue(values.evidence)}[/LIST]
[B][COLOR=rgb(171, 196, 197)]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/COLOR][/B]
По итогам расследования прокуратура просит суд:
${formatList(values.requests.split(/\n+/).filter(Boolean))}
[RIGHT]Город Лос-Сантос, штат Сан-Андреас
${filingDate}
${bbValue(values.signature || values.prosecutor)}
Подпись[/RIGHT][/SIZE][/FONT][/td][/TR][/TABLE]`,
    appeal: () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]${docSchemas.appeal.court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/FONT][/SIZE][/RIGHT]
[CENTER][SIZE=6][FONT=times new roman][B]АПЕЛЛЯЦИОННАЯ ЖАЛОБА[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman][B]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА. Данные апеллянта.[/B]
${formatList([`Имя и фамилия: ${values.claimant}`, `Номер ID-карты: ${values.claimantId}`, `Номер телефона: ${values.claimantPhone}`, `Электронная почта: ${values.claimantEmail}`, `Процессуальный статус в первой инстанции: ${values.status}`])}
[B]Данные представителя апеллянта.[/B]
${formatList([`Имя и фамилия: ${values.repName}`, `Номер ID-карты: ${values.repId}`, `Данные о лицензии адвоката: ${values.repLicense}`, `Номер телефона: ${values.repPhone}`, `Электронная почта: ${values.repEmail}`])}
[B]Данные ответчика по апелляционной жалобе.[/B]
${formatList([`Имя и фамилия: ${values.defendant}`, `Организация: ${values.organization}`, `Идентификационный знак: ${values.badge}`, `Процессуальный статус: ${values.defendantStatus}`])}
[B]Оспариваемый акт.[/B]
${formatList([`Имя и фамилия судьи: ${values.judge}`, `Должность судьи: ${values.judgePosition}`, `Оспариваемый акт: ${values.act}`])}
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
${bbValue(values.facts)}
[B]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ. Материалы от апеллянта:[/B]
${formatList([`Копия паспорта апеллянта: ${values.claimantPassport}`, `Доказательства уплаты госпошлины: ${values.feeProof}`, `Иные документы: ${values.otherDocs}`])}
[B]Материалы от представителя апеллянта:[/B]
${formatList([`Копия паспорта: ${values.repPassport}`, `Удостоверение / лицензия: ${values.repCredential}`, `Копия договора: ${values.contract}`, `Доказательства заключения договора: ${values.contractProof}`])}
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/B]
На основании вышеизложенного прошу суд:
${formatList(values.claims.split(/\n+/).filter(Boolean))}
[/FONT][/SIZE][RIGHT][SIZE=5][FONT=times new roman]Дата подачи заявления: ${filingDate}
Подпись апеллянта или представителя: ${bbValue(values.signature)}[/FONT][/SIZE][/RIGHT][/td][/TR][/TABLE]`,
    cassation: () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]${docSchemas.cassation.court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/FONT][/SIZE][/RIGHT]
[CENTER][SIZE=6][FONT=times new roman][B]КАССАЦИОННАЯ ЖАЛОБА[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman][B]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА. Данные кассатора.[/B]
${formatList([`Имя и фамилия: ${values.claimant}`, `Номер ID-карты: ${values.claimantId}`, `Номер телефона: ${values.claimantPhone}`, `Электронная почта: ${values.claimantEmail}`, `Процессуальный статус в первой инстанции: ${values.status}`])}
[B]Данные представителя кассатора.[/B]
${formatList([`Имя и фамилия: ${values.repName}`, `Номер ID-карты: ${values.repId}`, `Данные о лицензии адвоката: ${values.repLicense}`, `Номер телефона: ${values.repPhone}`, `Электронная почта: ${values.repEmail}`])}
[B]Оспариваемый акт.[/B]
${formatList([`Имя и фамилия судьи: ${values.judge}`, `Должность судьи: ${values.judgePosition}`, `Оспариваемый акт: ${values.act}`])}
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
${bbValue(values.facts)}
[B]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ. Материалы от кассатора:[/B]
${formatList([`Копия паспорта кассатора: ${values.claimantPassport}`, `Доказательства уплаты госпошлины: ${values.feeProof}`, `Иные документы: ${values.otherDocs}`])}
[B]Материалы от представителя кассатора:[/B]
${formatList([`Копия паспорта: ${values.repPassport}`, `Удостоверение / лицензия: ${values.repCredential}`, `Копия договора: ${values.contract}`, `Доказательства заключения договора: ${values.contractProof}`])}
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/B]
На основании вышеизложенного прошу суд:
${formatList(values.claims.split(/\n+/).filter(Boolean))}
[/FONT][/SIZE][RIGHT][SIZE=5][FONT=times new roman]Дата подачи заявления: ${filingDate}
Подпись кассатора или представителя: ${bbValue(values.signature)}[/FONT][/SIZE][/RIGHT][/td][/TR][/TABLE]`,
    constitutional: () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][SIZE=5][FONT=times new roman]${docSchemas.constitutional.court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/FONT][/SIZE][/RIGHT]
[CENTER][SIZE=6][FONT=times new roman][B]ИСКОВОЕ ЗАЯВЛЕНИЕ
КОНСТИТУЦИОННОЕ СУДОПРОИЗВОДСТВО[/B][/FONT][/SIZE][/CENTER]
[SIZE=5][FONT=times new roman][B]I. ИНФОРМАЦИЯ О СТОРОНАХ ДЕЛА. Данные заявителя.[/B]
${formatList([`Имя и фамилия: ${values.claimant}`, `Номер ID-карты: ${values.claimantId}`, `Номер телефона: ${values.claimantPhone}`, `Электронная почта: ${values.claimantEmail}`, `Место работы: ${values.workplace}`])}
[B]Данные представителя заявителя.[/B]
${formatList([`Имя и фамилия: ${values.repName}`, `Номер ID-карты: ${values.repId}`, `Статус / лицензия адвоката: ${values.repLicense}`, `Телефон: ${values.repPhone}`, `Электронная почта: ${values.repEmail}`])}
[B]Данные ответчика.[/B]
${formatList([`Автор оспариваемого акта: ${values.actAuthor}`, `Наименование акта: ${values.actName}`, `Должность, место работы: ${values.actPosition}`])}
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
${bbValue(values.facts)}
[B]III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ. Материалы от истца:[/B]
${formatList([`Копия паспорта истца: ${values.claimantPassport}`, `Доказательства уплаты пошлины: ${values.feeProof}`, `Иные документы: ${values.otherDocs}`])}
[B]Материалы от представителя истца:[/B]
${formatList([`Копия паспорта представителя: ${values.repPassport}`, `Удостоверение / лицензия: ${values.repCredential}`, `Договор: ${values.contract}`, `Доказательства заключения договора: ${values.contractProof}`])}
[B]IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/B]
На основании изложенного прошу суд:
${formatList(values.claims.split(/\n+/).filter(Boolean))}
[/FONT][/SIZE][RIGHT][SIZE=5][FONT=times new roman]Дата подачи заявления: ${filingDate}
Подпись заявителя или представителя: ${bbValue(values.signature)}[/FONT][/SIZE][/RIGHT][/td][/TR][/TABLE]`,
    "motion-citizen": () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][FONT=times new roman][SIZE=5]${docSchemas["motion-citizen"].court}
ШТАТА САН-АНДРЕАС, Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/SIZE][/FONT][/RIGHT]
[FONT=times new roman][SIZE=5][CENTER][B]${bbValue(values.motionType)}[/B]
о «${bbValue(values.motionSubject)}»[/CENTER]
[JUSTIFY]Я, ${bbValue(values.claimant)}, прошу суд:
${bbValue(values.facts)}

К ходатайству прилагаю следующую информацию:[/JUSTIFY]
${formatList([`Номер ID-карты: ${values.claimantId}`, `Копия ID-карты: ${values.claimantPassport}`, `Электронная почта: ${values.email}`, `Доказательства: ${values.evidence}`, `Иная информация: ${values.otherDocs}`])}
[RIGHT]Город Лос-Сантос, штат Сан-Андреас
${filingDate}
${bbValue(values.signature || values.claimant)}
Подпись[/RIGHT][/SIZE][/FONT][/td][/TR][/TABLE]`,
    "motion-agency": () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][FONT=times new roman][SIZE=5]ОТ ${bbValue(values.organization)} ШТАТА САН-АНДРЕАС
В ФЕДЕРАЛЬНЫЙ СУД СОЕДИНЕННЫХ ШТАТОВ АМЕРИКИ
ШТАТА САН-АНДРЕАС, Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012.[/SIZE][/FONT][/RIGHT]
[FONT=times new roman][SIZE=5][CENTER][B]${bbValue(values.motionType)}[/B]
о «${bbValue(values.motionSubject)}»[/CENTER]
[JUSTIFY]Я, ${bbValue(values.prosecutorPosition)} ${bbValue(values.prosecutor)}, прошу суд:
${bbValue(values.facts)}

Я прилагаю следующую информацию:[/JUSTIFY]
${formatList([`Копия служебного удостоверения: ${values.officialCredential}`, `Копия ID-карты: ${values.claimantId}`, `Электронная почта: ${values.email}`, `Доказательства: ${values.evidence}`, `Иная информация: ${values.otherDocs}`])}
[RIGHT]Город Лос-Сантос, штат Сан-Андреас
${filingDate}
${bbValue(values.prosecutor)}
${bbValue(values.prosecutorPosition)}
Подпись[/RIGHT][/SIZE][/FONT][/td][/TR][/TABLE]`,
    rehabilitation: () => `[TABLE width="100%"][TR][td width="100.0000%"][RIGHT][FONT=times new roman][SIZE=5]${docSchemas.rehabilitation.court}
ШТАТА САН-АНДРЕАС,
Истворн Уэй, Рокфорд Хиллс, Лос Сантос, 90012[/SIZE][/FONT][/RIGHT]
[CENTER][B][SIZE=5][FONT=times new roman]ЗАЯВЛЕНИЕ НА ЮРИДИЧЕСКУЮ РЕАБИЛИТАЦИЮ №${bbValue(values.rehabNumber)}[/FONT][/SIZE][/B][/CENTER]
[SIZE=5][FONT=times new roman][B]I. ИНФОРМАЦИЯ О ЗАЯВИТЕЛЕ.[/B]
[LIST][*]Имя Фамилия: ${bbValue(values.claimant)}[*]Номер паспорта: ${bbValue(values.claimantId)}[*]Электронная почта: ${bbValue(values.claimantEmail)}[*]Номер телефона: ${bbValue(values.claimantPhone)}[/LIST]
[B]II. ОПИСАТЕЛЬНАЯ ЧАСТЬ.[/B]
Я, гражданин ${bbValue(values.claimant)}, был осужден ${bbValue(values.sentenceDate)} по статьям ${bbValue(values.articles)}. Прошу Верховный Суд штата Сан-Андреас рассмотреть заявление на юридическую реабилитацию и аннулировать указанную судимость. ${bbValue(values.confession)}
Готовность уплатить судебную пошлину: ${bbValue(values.feeAgreement)}.
Размер пошлины по категории тяжести: $${bbValue(values.severity)}.
[B]РАЗДЕЛ III. МАТЕРИАЛЫ ЗАЯВЛЕНИЯ.[/B]
${formatList([`Копия паспорта: ${values.claimantPassport}`, `Иные документы: ${values.otherDocs}`])}
[B]РАЗДЕЛ IV. ЗАКЛЮЧИТЕЛЬНАЯ ЧАСТЬ.[/B]
На основании изложенного прошу суд рассмотреть заявление на юридическую реабилитацию и аннулировать запись о судимости, указанной в настоящем заявлении.
[/FONT][/SIZE][RIGHT][SIZE=5][FONT=times new roman]Город Лос-Сантос, штат Сан-Андреас
${filingDate}
${bbValue(values.claimant)}
${bbValue(values.signature)}
Подпись[/FONT][/SIZE][/RIGHT][/td][/TR][/TABLE]`
  };
  const generator = templates[$("#doc-template").value];
  if (!generator) throw new Error("Для выбранного документа не найден шаблон.");
  return generator();
}

function bbcodeToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[IMG[^\]]*\][\s\S]*?\[\/IMG\]/gi, '<div class="forum-center">[Шапка документа]</div>');
  html = html.replace(/\[TABLE[^\]]*\]/gi, '<div class="forum-table">').replace(/\[\/TABLE\]/gi, "</div>");
  html = html.replace(/\[TR\]/gi, '<div class="forum-row">').replace(/\[\/TR\]/gi, "</div>");
  html = html.replace(/\[td[^\]]*\]/gi, "<div>").replace(/\[\/td\]/gi, "</div>");
  html = html.replace(/\[RIGHT\]/gi, '<div class="forum-right">').replace(/\[\/RIGHT\]/gi, "</div>");
  html = html.replace(/\[CENTER\]/gi, '<div class="forum-center">').replace(/\[\/CENTER\]/gi, "</div>");
  html = html.replace(/\[JUSTIFY\]/gi, '<div class="forum-justify">').replace(/\[\/JUSTIFY\]/gi, "</div>");
  html = html.replace(/\[B\]/gi, "<strong>").replace(/\[\/B\]/gi, "</strong>");
  html = html.replace(/\[FONT=times new roman\]/gi, '<span style="font-family:Times New Roman,serif">').replace(/\[\/FONT\]/gi, "</span>");
  html = html.replace(/\[SIZE=(\d+)\]/gi, (_, size) => `<span style="font-size:${Math.min(22, 8.5 + Number(size) * 1.5)}px">`).replace(/\[\/SIZE\]/gi, "</span>");
  html = html.replace(/\[COLOR=(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))\]/gi, '<span style="color:$1">').replace(/\[\/COLOR\]/gi, "</span>");
  html = html.replace(/\[LIST=1\]/gi, "<ol>").replace(/\[LIST\]/gi, "<ul>").replace(/\[\/LIST\]/gi, "</ul>");
  html = html.replace(/\[\*\]/g, "<li>").replace(/\r?\n/g, "<br>");
  return html;
}

function renderDocumentPreview(bbcode, values) {
  $("#document-output").value = bbcode;
  $("#forum-preview").innerHTML = bbcodeToHtml(bbcode);
  const text = bbcode.replace(/\[IMG[^\]]*\][\s\S]*?\[\/IMG\]/gi, "[Шапка документа]")
    .replace(/\[\*\]/g, "• ").replace(/\[[^\]]+\]/g, "").trim();
  $("#paper-text").textContent = text;
  $("#paper-signature").textContent = values.signature || values.claimant || values.complainant || values.prosecutor || "";
}

async function copyText(text, successMessage) {
  if (!text.trim()) {
    notify("Сначала сформируйте документ.");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard API недоступен.");
    }
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.append(fallback);
    fallback.select();
    const copied = document.execCommand("copy");
    fallback.remove();
    if (!copied) {
      notify("Не удалось скопировать BBCode. Скачайте документ в .txt и скопируйте его из файла.");
      return;
    }
  }
  notify(successMessage);
}

function downloadDocument() {
  const text = $("#document-output").value;
  if (!text.trim()) {
    notify("Сначала сформируйте документ.");
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "document-mirror.txt";
  link.click();
  URL.revokeObjectURL(url);
}

function findLawReferences(text) {
  const found = new Map();
  lawReferencePatterns.forEach(({ key, label, pattern }) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const article = match[1] || match[2];
      if (article && state.laws[key]) found.set(`${key}:${article}`, { key, label, article });
    }
  });
  return Array.from(found.values()).slice(0, 8);
}

function formatLawText(text, highlightText = "") {
  const highlight = (value) => {
    const source = String(value || "");
    const query = highlightText.trim();
    if (!query) return escapeHtml(source);
    const lowerSource = source.toLocaleLowerCase("ru");
    const lowerQuery = query.toLocaleLowerCase("ru");
    let cursor = 0;
    let index = lowerSource.indexOf(lowerQuery);
    let output = "";
    while (index !== -1) {
      output += escapeHtml(source.slice(cursor, index));
      output += `<mark class="search-hit">${escapeHtml(source.slice(index, index + query.length))}</mark>`;
      cursor = index + query.length;
      index = lowerSource.indexOf(lowerQuery, cursor);
    }
    return output + escapeHtml(source.slice(cursor));
  };
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${highlight(paragraph.join(" ").replace(/\s+/g, " ").trim())}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((line) => `<li>${highlight(line.replace(/^[•●]\s*/, ""))}</li>`).join("")}</ul>`);
    list = [];
  };
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      flushParagraph();
      return;
    }
    if (/^РАЗДЕЛ\b|^ГЛАВА\b|^Глава\b|^Часть\b|^Книга\b/i.test(line)) {
      flushList();
      flushParagraph();
      blocks.push(`<div class="law-section-heading">${highlight(line.replace(/^#+\s*/, ""))}</div>`);
      return;
    }
    if (/^(?:Статья\s+)?\d+\.\d+(?:\.\d+)*\b/u.test(line)) {
      flushList();
      flushParagraph();
      const article = line.match(/^((?:Статья\s+)?\d+(?:\.\d+)*)/iu)?.[1] || "";
      const body = line.slice(article.length).replace(/^[\s.:—-]+/, "");
      blocks.push(`<section class="law-article"><div class="law-article-number">${highlight(article)}</div><div class="law-article-body">${highlight(body)}</div></section>`);
      return;
    }
    if (/^(?:[•●]|[-–])\s+/u.test(line)) {
      flushParagraph();
      list.push(line);
      return;
    }
    flushList();
    paragraph.push(line);
  });
  flushList();
  flushParagraph();
  return blocks.join("");
}

function renderLaws() {
  const rawQuery = $("#law-search").value.trim();
  const query = rawQuery.toLocaleLowerCase("ru");
  const articleQuery = rawQuery.match(/^(?:стать(?:я|и|е)\s*|ст\.?\s*)?(\d+(?:\.\d+)+)$/iu)?.[1] || "";
  const selected = $("#law-filter").value;
  const lawTreeItems = [
    ["all", "Вся нормативная база"],
    ["charter", "Конституция и Устав"],
    ["uk", "Уголовный кодекс SA"],
    ["pk", "Процессуальный кодекс SA"],
    ["ak", "Административный кодекс SA"],
    ["advocacy", "Внутренние регламенты коллегии"]
  ];
  $("#law-tree").innerHTML = lawTreeItems.map(([key, label]) =>
    `<button type="button" class="${selected === key ? "active" : ""}" data-law-filter="${key}">${escapeHtml(label)}</button>`).join("") +
    Object.entries(lawMeta).filter(([key]) => !["charter","uk","pk","ak","advocacy"].includes(key))
      .map(([key, label]) => `<button type="button" class="${selected === key ? "active" : ""}" data-law-filter="${key}">${escapeHtml(label?.name || label || key)}</button>`).join("");
  const entries = Object.entries(lawMeta).filter(([key]) =>
    state.laws[key] && state.laws[key].text && (selected === "all" || key === selected));
  const result = [];
  entries.forEach(([key, title]) => {
    const content = state.laws[key].text;
    const lines = content.split(/\r?\n/);
    const matches = [];
    if (query) {
      for (let index = 0; index < lines.length; index += 1) {
        const isMatch = articleQuery
          ? new RegExp(`(^|[^\\d.])${articleQuery.replace(/\./g, "\\.")}(?![\\d.])`, "u").test(lines[index])
          : lines[index].toLocaleLowerCase("ru").includes(query);
        if (isMatch) {
          matches.push(index);
        }
      }
    }
    if (!query || matches.length) result.push({
      key, title, name: state.laws[key].name,
      sourceNote: state.laws[key].sourceNote,
      text: query ? matches.slice(0, 60).map((index) =>
        lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join("\n")).join("\n\n— — —\n\n")
        : lines.slice(0, 35).join("\n"),
      count: matches.length, fullText: content
    });
  });
  const highlight = (text) => {
    if (!query) return escapeHtml(text);
    const lowerText = text.toLocaleLowerCase("ru");
    let cursor = 0;
    let index = lowerText.indexOf(query);
    let resultText = "";
    while (index !== -1) {
      resultText += escapeHtml(text.slice(cursor, index)) +
        `<mark class="search-hit">${escapeHtml(text.slice(index, index + query.length))}</mark>`;
      cursor = index + query.length;
      index = lowerText.indexOf(query, cursor);
    }
    return resultText + escapeHtml(text.slice(cursor));
  };
  const articleAction = articleQuery && result.length &&
    ["Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"].includes(role())
    ? `<div class="note">Найден номер статьи ${escapeHtml(articleQuery)}. Проверьте связанные нормы выше; затем можно перейти к подготовке документа.<div class="actions"><button class="btn small primary" type="button" data-go="documents">Открыть конструктор исков</button></div></div>`
    : "";
  $("#law-results").innerHTML = result.length
    ? articleAction + result.map((item) => {
      const references = findLawReferences(item.text);
      return `<article class="law-card">
        <div class="law-title">${escapeHtml(item.title)}</div>
        <div class="meta">${escapeHtml(item.name)}${item.sourceNote ? ` · ${escapeHtml(item.sourceNote)}` : ""}${query ? ` · найдено совпадающих строк: ${item.count}${item.count > 60 ? " · первые 60 показаны" : ""}` : ""}</div>
        <div class="law-text law-document">${formatLawText(item.text, rawQuery)}</div>
        ${references.length ? `<div class="law-links"><strong>Прямые ссылки в тексте:</strong>${references.map((reference) =>
          `<button class="btn small subtle" type="button" data-law-ref-key="${reference.key}" data-law-ref-article="${escapeHtml(reference.article)}">${escapeHtml(reference.label)} ${escapeHtml(reference.article)}</button>`).join("")}</div>` : ""}
        <details class="law-full"><summary>Открыть полный текст документа</summary><div class="law-text law-document">${formatLawText(item.fullText, rawQuery)}</div></details>
      </article>`;
    }).join("")
    : `<div class="empty">${entries.length ? "Совпадений нет." : "В data/laws не найдены файлы законодательной базы."}</div>`;
}

function renderReport(data) {
  googleSheetsConfigured = Boolean(data.googleSheetsConfigured);
  latestReportData = data;
  const headers = [
    ["displayName", "Сотрудник"], ["role", "Роль"], ["documentsCreated", "Документов создано"],
    ["documentsApproved", "Одобрено"], ["lawsuitsFiled", "Исков подано"],
    ["casesTaken", "Обращений взято"], ["casesClosed", "Обращений закрыто"],
    ["examsPassed", "Экзаменов сдано"], ["attestationsPassed", "Переаттестаций"],
    ["reprimands", "Выговоров"]
  ];
  const allRows = data.rows || [];
  const totals = data.totals || {};
  const query = ($("#report-search")?.value || "").trim().toLocaleLowerCase("ru");
  const rows = allRows.filter((row) =>
    !query || `${row.displayName || ""} ${row.role || ""}`.toLocaleLowerCase("ru").includes(query));
  const summaryCards = [
    ["Сотрудников", allRows.length, "i-user"],
    ["Одобрено документов", totals.documentsApproved || 0, "i-file"],
    ["Закрыто обращений", totals.casesClosed || 0, "i-message"],
    ["Подано исков", totals.lawsuitsFiled || 0, "i-scale"]
  ];
  $("#report-content").innerHTML = allRows.length
    ? `<div class="report-summary-grid">${summaryCards.map(([label, value, icon]) =>
        `<article class="report-summary-card"><span><svg class="svg-icon"><use href="#${icon}"></use></svg></span><div><strong>${Number(value)}</strong><small>${escapeHtml(label)}</small></div></article>`).join("")}</div>
      <div class="report-table-wrap"><table class="report-table report-table-live">
        <thead><tr>${headers.map(([, title]) => `<th>${escapeHtml(title)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${headers.map(([key]) =>
          `<td>${key === "displayName" || key === "role" ? escapeHtml(row[key]) : Number(row[key] || 0)}</td>`).join("")}</tr>`).join("")}
        <tr><th>Итого</th><th></th>${headers.slice(2).map(([key]) => `<th>${Number(totals[key] || 0)}</th>`).join("")}</tr></tbody>
      </table></div>
      ${rows.length ? "" : `<div class="empty">По поиску сотрудников не найдено.</div>`}`
    : `<div class="empty">В выбранном месяце нет активных сотрудников.</div>`;
  $("#report-sync-status").textContent = `Живая таблица портала · отчёт за ${data.period} · сотрудников: ${(data.employees || []).length}.`;
  $("#report-csv").disabled = false;
}

function reportCsvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadReportCsv() {
  if (!latestReportData) return notify("Сначала обновите отчёт.");
  const headers = [
    ["displayName", "Сотрудник"], ["role", "Роль"], ["documentsCreated", "Документов создано"],
    ["documentsApproved", "Одобрено"], ["lawsuitsFiled", "Исков подано"],
    ["casesTaken", "Обращений взято"], ["casesClosed", "Обращений закрыто"],
    ["examsPassed", "Экзаменов сдано"], ["attestationsPassed", "Переаттестаций"],
    ["reprimands", "Выговоров"]
  ];
  const rows = [
    headers.map(([, title]) => title),
    ...(latestReportData.rows || []).map((row) => headers.map(([key]) => row[key] ?? 0)),
    ["Итого", "", ...headers.slice(2).map(([key]) => Number(latestReportData.totals?.[key] || 0))]
  ];
  const csv = `\uFEFF${rows.map((row) => row.map(reportCsvCell).join(";")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `otchet-${latestReportData.period || "portal"}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("CSV-отчёт скачан.");
}

const weeklyResetLabels = {
  calendar: "завершённых мероприятий",
  applications: "рассмотренных заявок",
  absences: "заявок на отсутствие",
  reprimands: "выговоров"
};

function formatWeeklyResetCounts(counts) {
  return Object.entries(weeklyResetLabels).map(([key, label]) =>
    `${Number(counts?.[key] || 0)} ${label}`).join(" · ");
}

async function loadWeeklyReset() {
  const previewNode = $("#weekly-reset-preview");
  previewNode.textContent = "Проверяем записи…";
  $("#weekly-reset-refresh").disabled = true;
  try {
    const [preview, history] = await Promise.all([
      api("/api/weekly-reset/preview"),
      api("/api/weekly-reset/history")
    ]);
    previewNode.textContent = `Будет архивировано: ${formatWeeklyResetCounts(preview.counts)}. Незавершённые заявки и запланированные мероприятия останутся активными. Состав, достижения, отзывы, рейтинг, дела и документы не затрагиваются.`;
    $("#weekly-reset-history").innerHTML = history.runs.length
      ? history.runs.map((run) => `<article class="card compact">
          <strong>Архив #${Number(run.id)} · ${escapeHtml(new Date(run.archived_at).toLocaleString("ru-RU"))}</strong>
          <div class="meta">${escapeHtml(formatWeeklyResetCounts(run.counts))} · ГКА: ${escapeHtml(run.created_by_name)}</div>
          ${run.restored_at
            ? `<div class="help">Восстановлен ${escapeHtml(new Date(run.restored_at).toLocaleString("ru-RU"))}${run.restored_by_name ? ` · ${escapeHtml(run.restored_by_name)}` : ""}</div>`
            : `<button class="btn small" type="button" data-weekly-reset-restore="${Number(run.id)}">Восстановить этот архив</button>`}
        </article>`).join("")
      : `<div class="empty">Недельных архивов пока нет.</div>`;
  } catch (error) {
    previewNode.textContent = error.message;
    $("#weekly-reset-history").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  } finally {
    $("#weekly-reset-refresh").disabled = false;
  }
}

async function startWeeklyReset(button) {
  button.disabled = true;
  try {
    const preview = await api("/api/weekly-reset/preview");
    const counts = formatWeeklyResetCounts(preview.counts);
    const confirmed = window.confirm(
      `Начать новую неделю?\n\nВ архив попадёт: ${counts}.\nНезавершённые заявки и запланированные мероприятия останутся активными.\nСостав, достижения, отзывы, рейтинг, дела и документы сохраняются.\n\nАрхив можно восстановить из истории.`
    );
    if (!confirmed) return;
    const result = await api("/api/weekly-reset", { method: "POST", body: { confirmed: true } });
    notify(`Новая неделя начата. В архив перенесено: ${formatWeeklyResetCounts(result.run.counts)}.`);
    await Promise.all([loadWeeklyReset(), loadReport()]);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

async function restoreWeeklyReset(button) {
  if (!window.confirm("Восстановить записи из этого недельного архива? Они снова появятся в рабочих списках.")) return;
  button.disabled = true;
  try {
    const result = await api(`/api/weekly-reset/${encodeURIComponent(button.dataset.weeklyResetRestore)}/restore`, {
      method: "POST", body: {}
    });
    notify(`Архив восстановлен: ${formatWeeklyResetCounts(result.run.counts)}.`);
    await loadWeeklyReset();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderAnalytics(data) {
  const roleNames = {
    "Стажер КА": "Стажёры", "Юрист": "Юристы", "Адвокат": "Адвокаты",
    "Ст.Адвокат": "Старшие адвокаты", "ЗГКА": "Заместители ГКА", "ГКА": "ГКА"
  };
  const lawsuitNames = {
    submitted: "Поданы", in_review: "На рассмотрении", hearing: "Назначено слушание",
    decided: "Решение внесено", rejected: "Отклонены"
  };
  const documentNames = { draft: "Черновики", pending: "Ожидают проверки", approved: "Одобрены", rejected: "Отклонены" };
  const composition = data.composition || {};
  const lawsuits = data.lawsuits || {};
  const documents = data.documents || {};
  const requests = data.requests || {};
  const hr = data.humanResources || {};
  const value = (number) => Number.isFinite(Number(number)) ? Number(number) : 0;
  const statCard = (title, items) => `<article class="analytics-card"><h4>${title}</h4>
    <div class="analytics-values">${items.map(([label, amount]) => `<div class="analytics-value">
      <strong>${escapeHtml(amount === null || amount === undefined ? "—" : String(amount))}</strong>
      <span>${escapeHtml(label)}</span></div>`).join("")}</div></article>`;
  const roleStats = Object.entries(composition.byRole || {})
    .map(([roleName, amount]) => [roleNames[roleName] || roleName, amount]);
  const series = [
    ["Новые аккаунты", "members"], ["Судебные дела", "lawsuits"],
    ["Документы", "documents"], ["Обращения", "requests"],
    ["Повышения", "promotions"], ["Выговоры", "reprimands"]
  ];
  const points = data.trend || [];
  const charts = series.map(([label, key]) => {
    const maximum = Math.max(0, ...points.map((point) => value(point[key])));
    return `<div class="analytics-card"><h4>${label}</h4>
      <div class="analytics-chart" role="img" aria-label="${label} по датам">
        ${points.length ? points.map((point) => {
          const amount = value(point[key]);
          const height = maximum ? Math.max(amount ? 4 : 0, amount / maximum * 100) : 0;
          const dateLabel = point.period.length === 7 ? point.period.slice(2) : point.period.slice(5);
          return `<div class="analytics-bar" title="${escapeHtml(`${point.period}: ${amount}`)}">
            <div class="analytics-bar-fill" style="height:${height}%"></div>
            <span class="analytics-bar-label">${escapeHtml(dateLabel)}</span></div>`;
        }).join("") : `<div class="empty">Нет событий в выбранном периоде.</div>`}
      </div></div>`;
  }).join("");
  const periodNames = { "7": "7 дней", "30": "30 дней", "90": "90 дней", all: "всё время" };
  $("#analytics-period-label").textContent = `Период: ${periodNames[data.period] || data.period}. Состав — текущее состояние; динамика новых аккаунтов не означает дату вступления на должность.`;
  $("#analytics-content").innerHTML = `
    <div class="analytics-grid">
      ${statCard("Состав (сейчас)", [
        ["Всего аккаунтов сотрудников", value(composition.total)],
        ["Активные", value(composition.active)],
        ["Ожидают активации", value(composition.pending)],
        ["Приостановлены", value(composition.suspended)]
      ])}
      ${statCard("Судебная деятельность · период", [
        ["Всего дел", value(lawsuits.total)],
        ...Object.entries(lawsuits.byStatus || {}).map(([status, amount]) => [lawsuitNames[status] || status, value(amount)])
      ])}
      ${statCard("Документооборот · период", [
        ["Всего создано", value(documents.total)],
        ...Object.entries(documents.byStatus || {}).map(([status, amount]) => [documentNames[status] || status, value(amount)])
      ])}
      ${statCard("Обращения граждан · период", [
        ["Всего", value(requests.total)], ["Открытые", value(requests.open)],
        ["Закрытые", value(requests.closed)],
        ["Среднее рассмотрение, ч", requests.averageResolutionHours],
        ["Средняя оценка", requests.averageRating],
        ["Оценок получено", value(requests.reviewCount)]
      ])}
      ${statCard("Кадровые события · период", [
        ["Принятия", value(hr.hires)], ["Увольнения", value(hr.dismissals)],
        ["Восстановления", value(hr.reinstatements)], ["Одобренные повышения", value(hr.promotions)],
        ["Выговоры", value(hr.reprimands)],
        ["Выданные награды", value(hr.awards)], ["Переаттестации сданы", value(hr.attestationsPassed)],
        ["Переаттестации не сданы", value(hr.attestationsFailed)]
      ])}
      ${roleStats.length ? statCard("Сотрудники по должностям · сейчас", roleStats) : ""}
      ${(documents.byType || []).length ? statCard("Документы по типам · период",
        documents.byType.map((item) => [item.template, value(item.count)])) : ""}
    </div>
    <div class="stack"><h3>Динамика событий</h3><div class="analytics-grid">${charts}</div></div>
    <div class="note">В базе нет истории изменений кадрового статуса, поэтому увольнения и дату фактического вступления система не считает. В судебных делах нет отдельного подтверждённого признака победы/поражения: «решение внесено» не интерпретируется как выигрыш. Черновики показаны отдельно и не считаются одобренными документами. События без сохранённой даты не попадают в график.</div>`;
}

async function loadAnalytics(period) {
  if (!isManager()) return;
  const selected = period || document.querySelector("[data-analytics-period].active")?.dataset.analyticsPeriod || "30";
  document.querySelectorAll("[data-analytics-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.analyticsPeriod === selected);
    button.disabled = true;
  });
  try {
    renderAnalytics(await api(`/api/analytics?period=${encodeURIComponent(selected)}`));
  } catch (error) {
    $("#analytics-content").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  } finally {
    document.querySelectorAll("[data-analytics-period]").forEach((button) => { button.disabled = false; });
  }
}

async function loadReport(syncToSheets = false) {
  if (!isManager()) return;
  if (!$("#report-period").value) $("#report-period").value = new Date().toISOString().slice(0, 7);
  const period = $("#report-period").value;
  const refreshButton = $("#report-refresh");
  refreshButton.disabled = true;
  try {
    renderReport(await api(`/api/reports?period=${encodeURIComponent(period)}`));
  } catch (error) {
    notify(error.message);
    $("#report-sync-status").textContent = error.message;
  } finally {
    refreshButton.disabled = false;
    if (!reportLiveTimer) {
      reportLiveTimer = window.setInterval(() => {
        if ($("#page-reports")?.classList.contains("active")) {
          $("#report-live-status").textContent = "Обновление таблицы…";
          loadReport(false).finally(() => {
            $("#report-live-status").textContent = "Обновлено · каждые 30 секунд";
          });
        }
      }, 30000);
    }
  }
}

function renderLawsuits() {
  const statusNames = { submitted: "Подан", in_review: "На рассмотрении", hearing: "Назначено слушание", decided: "Решение вынесено", rejected: "Отклонен" };
  const priorityLabels = { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" };
  const flow = ["submitted", "in_review", "hearing", "decided"];
  $("#lawsuit-list").innerHTML = state.lawsuits.length
    ? state.lawsuits.map((item) => {
      const terminal = ["decided", "rejected"].includes(item.status);
      const activeIndex = flow.indexOf(item.status);
      const dueDate = item.due_at ? new Date(item.due_at) : null;
      const dueText = dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate.toLocaleString("ru-RU") : "";
      const dueInput = dueDate && !Number.isNaN(dueDate.getTime())
        ? new Date(dueDate.getTime() - dueDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
      const nextStatuses = {
        submitted: ["in_review", "rejected"],
        in_review: ["hearing", "decided", "rejected"],
        hearing: ["decided", "rejected"]
      }[item.status] || [];
      const forumControls = isManager() && item.forum_status === "pending"
        ? `<div class="field"><label for="lawsuit-forum-note-${item.document_id}">Комментарий (обязателен при отклонении)</label>
            <input id="lawsuit-forum-note-${item.document_id}" maxlength="500" data-forum-note="${item.document_id}" placeholder="Причина решения">
          </div>
          <div class="request-actions">
            <button class="btn small primary" data-forum-review="approved" data-document-id="${item.document_id}">Подтвердить форумную ссылку</button>
            <button class="btn small danger" data-forum-review="rejected" data-document-id="${item.document_id}">Отклонить ссылку</button>
          </div>` : "";
      const controls = isManager() && !terminal && item.forum_status === "approved"
        ? `<div class="case-review">
            <select data-case-status="${item.id}" aria-label="Статус иска">
              ${nextStatuses.map((status) => `<option value="${status}">${status === "in_review" ? "На рассмотрении" : status === "hearing" ? "Назначить слушание" : status === "decided" ? "Вынести решение" : "Отклонить"}</option>`).join("")}
            </select>
            <input data-case-decision="${item.id}" maxlength="2000" placeholder="Решение или комментарий">
            <button class="btn small primary" data-save-case="${item.id}" type="button">Сохранить</button>
          </div>` : "";
      const workflowControls = isManager() && !terminal
        ? `<div class="case-review">
            <select data-lawsuit-priority="${item.id}" aria-label="Приоритет судебного дела">
              ${Object.entries(priorityLabels).map(([value, label]) => `<option value="${value}"${(item.priority || "normal") === value ? " selected" : ""}>${label}</option>`).join("")}
            </select>
            <input type="datetime-local" data-lawsuit-deadline="${item.id}" value="${escapeHtml(dueInput)}" aria-label="Срок судебного дела">
            <button class="btn small subtle" data-save-lawsuit-workflow="${item.id}" type="button">Сохранить срок</button>
          </div>` : "";
      const filer = item.filer_role === "Гражданин"
        ? escapeHtml(item.display_name)
        : `<button class="profile-trigger" data-profile-id="${escapeHtml(item.user_id)}" type="button">${escapeHtml(item.display_name)}</button>`;
      const forum = item.forum_url
        ? `<div class="meta"><a href="${escapeHtml(item.forum_url)}" target="_blank" rel="noopener noreferrer">Открыть публикацию на форуме</a>
            · ${item.forum_status === "approved" ? "ссылка подтверждена" : item.forum_status === "rejected" ? "ссылка отклонена" : "ожидает подтверждения"}</div>`
        : `<div class="note warning">Нет форумной ссылки. Создайте и опубликуйте тему, затем отправьте её на проверку.</div>`;
      return `<article class="request-card lawsuit-card">
        <div class="request-top"><div><h4>Дело №${item.id} · ${escapeHtml(item.title)}</h4>
          <div class="meta">${escapeHtml(item.court)} · ${filer} (${escapeHtml(item.filer_role)}) · ${escapeHtml(item.created_at)}</div>
        </div><span class="badge ${item.status === "decided" ? "approved" : item.status === "rejected" ? "rejected" : "pending"}">${statusNames[item.status]}</span></div>
        <div class="case-flow">${flow.map((stage, index) => `<span class="${index <= activeIndex ? "current" : ""}">${statusNames[stage]}</span>`).join("")}</div>
        <div class="meta">Приоритет: ${escapeHtml(priorityLabels[item.priority || "normal"] || "Обычный")}${dueText ? ` · срок: ${escapeHtml(dueText)}` : " · срок не установлен"}</div>
        ${item.decision ? `<p>${escapeHtml(item.decision)}</p>` : ""}
        ${forum}${item.forum_review_note ? `<div class="note warning">${escapeHtml(item.forum_review_note)}</div>` : ""}
        ${item.updated_by_name ? `<div class="meta">Обновил: ${escapeHtml(item.updated_by_name)} · ${escapeHtml(item.updated_at)}</div>` : ""}
        <div class="request-actions"><button class="btn small subtle" type="button" data-open-document="${item.document_id}">Открыть заявление</button></div>
        ${isManager() || item.user_id === currentUser.id ? `<div class="request-actions"><button class="btn small subtle" type="button" data-lawsuit-history="${item.id}">История дела</button></div>` : ""}
        ${forumControls}${controls}${workflowControls}
      </article>`;
    }).join("")
    : `<div class="empty">Исковых дел пока нет. Сформируйте иск в разделе «Документы» и подайте его в суд.</div>`;
}

async function updateLawsuit(button) {
  const id = button.dataset.saveCase;
  const status = $(`[data-case-status="${id}"]`).value;
  const decision = $(`[data-case-decision="${id}"]`).value.trim();
  try {
    await api(`/api/lawsuits/${encodeURIComponent(id)}`, { method: "PATCH", body: { status, decision } });
    notify("Статус судебного дела обновлён.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

async function saveCaseWorkflow(button) {
  const id = button.dataset.saveCaseWorkflow;
  const deadline = $(`[data-case-deadline="${id}"]`).value;
  button.disabled = true;
  try {
    await api(`/api/applications/${encodeURIComponent(id)}/workflow`, {
      method: "PATCH",
      body: {
        priority: $(`[data-case-priority="${id}"]`).value,
        dueAt: deadline ? new Date(deadline).toISOString() : null
      }
    });
    notify("Приоритет и срок обращения сохранены.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveLawsuitWorkflow(button) {
  const id = button.dataset.saveLawsuitWorkflow;
  const deadline = $(`[data-lawsuit-deadline="${id}"]`).value;
  button.disabled = true;
  try {
    await api(`/api/lawsuits/${encodeURIComponent(id)}/workflow`, {
      method: "PATCH",
      body: {
        priority: $(`[data-lawsuit-priority="${id}"]`).value,
        dueAt: deadline ? new Date(deadline).toISOString() : null
      }
    });
    notify("Приоритет и срок судебного дела сохранены.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

async function openCaseHistory(id, type) {
  const endpoint = type === "lawsuit"
    ? `/api/lawsuits/${encodeURIComponent(id)}/history`
    : `/api/applications/${encodeURIComponent(id)}/history`;
  const eventLabels = {
    created: "Создано", assigned: "Назначено", reassigned: "Переназначено",
    workflow_updated: "Обновлены параметры", approved: "Одобрено", rejected: "Отклонено",
    closed: "Закрыто", rated: "Оценено", in_review: "Принято к рассмотрению",
    hearing: "Назначено слушание", decided: "Решение вынесено"
  };
  try {
    const result = await api(endpoint);
    $("#case-history-title").textContent = type === "lawsuit" ? `История дела №${id}` : `История обращения №${id}`;
    $("#case-history-list").innerHTML = result.history.length
      ? result.history.map((entry) => `<article class="request-card">
          <div class="request-top"><strong>${escapeHtml(eventLabels[entry.event_type] || entry.event_type)}</strong>
            <span class="meta">${escapeHtml(portalDate(entry.created_at))}</span></div>
          <div class="meta">${entry.actor_name ? `${escapeHtml(entry.actor_name)}${entry.actor_role ? ` · ${escapeHtml(entry.actor_role)}` : ""} · ` : ""}${escapeHtml(entry.details)}</div>
        </article>`).join("")
      : `<div class="empty">Событий пока нет.</div>`;
    $("#case-history-dialog").showModal();
  } catch (error) {
    notify(error.message);
  }
}

async function submitForumLink(documentId, forumUrl, button) {
  const url = String(forumUrl || "").trim();
  if (!url) {
    notify("Добавьте ссылку на опубликованную тему форума.");
    return false;
  }
  if (button) button.disabled = true;
  try {
    const result = await api(`/api/documents/${encodeURIComponent(documentId)}/forum`, {
      method: "POST", body: { forumUrl: url }
    });
    notify(result.warning || "Ссылка отправлена руководству на проверку.");
    await refreshPortalData();
    return true;
  } catch (error) {
    notify(error.message);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitCurrentForumDocument(button) {
  const bbcode = $("#document-output").value;
  const forumUrl = $("#forum-publish-url").value.trim();
  if (!bbcode.trim()) {
    notify("Сначала сформируйте документ.");
    return;
  }
  if (!forumUrl) {
    notify("Вставьте ссылку на опубликованную тему форума.");
    $("#forum-publish-url").focus();
    return;
  }
  if (button) button.disabled = true;
  try {
    let documentId = generatedDocumentId;
    if (!documentId) {
      const option = $("#doc-template").selectedOptions[0];
      const title = `${option.textContent}${$("#doc-template").value === "complaint"
        ? " " + $('[data-doc-key="cpNumber"]', $("#document-fields")).value : ""}`;
      const saved = await api("/api/documents", {
        method: "POST", body: { template: $("#doc-template").value, title, bbcode }
      });
      documentId = saved.id;
      generatedDocumentId = documentId;
    }
    const submitted = await submitForumLink(documentId, forumUrl, button);
    if (submitted) {
      generatedDocumentId = null;
      $("#forum-publish-url").value = "";
    }
  } catch (error) {
    notify(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitLawsuit(button) {
  const bbcode = $("#document-output").value;
  const forumUrl = $("#forum-publish-url").value.trim();
  if (!bbcode.trim()) {
    notify("Сначала сформируйте иск и проверьте предпросмотр.");
    return;
  }
  if (!forumUrl) {
    notify("Сначала опубликуйте иск на форуме и вставьте ссылку.");
    $("#forum-publish-url").focus();
    return;
  }
  const template = $("#doc-template").value;
  const caseNumber = $('[data-doc-key="caseNumber"]', $("#document-fields"))?.value;
  const title = `${$("#doc-template").selectedOptions[0].textContent}${caseNumber ? " №" + caseNumber : ""}`;
  if (button) button.disabled = true;
  try {
    const result = await api("/api/lawsuits", {
      method: "POST", body: { template, title, bbcode, forumUrl }
    });
    generatedDocumentId = null;
    $("#forum-publish-url").value = "";
    $("#forum-publish").classList.add("hidden");
    notify(result.warning || "Иск отправлен на проверку ссылки. Движение дела появится после подтверждения публикации.");
    await refreshPortalData();
    switchTab("lawsuits");
  } catch (error) {
    notify(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleForumReview(button) {
  const documentId = button.dataset.documentId;
  const note = $(`[data-forum-note="${documentId}"]`)?.value.trim() || "";
  if (button.dataset.forumReview === "rejected" && note.length < 4) {
    notify("При отклонении укажите причину для автора.");
    $(`[data-forum-note="${documentId}"]`)?.focus();
    return;
  }
  try {
    const result = await api(`/api/documents/${encodeURIComponent(documentId)}/forum`, {
      method: "PATCH", body: { status: button.dataset.forumReview, note }
    });
    notify(result.logWarning || (button.dataset.forumReview === "approved" ? "Ссылка подтверждена; публикация засчитана." : "Публикация отклонена, автор увидит причину."));
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

async function issuePasswordReset(button) {
  try {
    const result = await api(`/api/members/${encodeURIComponent(button.dataset.resetPassword)}/reset-password`, {
      method: "POST", body: {}
    });
    $("#invite-result").textContent = `Код восстановления (действует до ${new Date(result.expiresAt).toLocaleString("ru-RU")}): ${result.code}`;
    $("#invite-result").classList.remove("hidden");
    notify(result.logWarning || "Передайте одноразовый код владельцу аккаунта лично.");
  } catch (error) {
    notify(error.message);
  }
}

function renderAttestations() {
  const statusNames = { assigned: "Назначена", passed: "Пройдена", failed: "Не пройдена" };
  const card = (item, canStart) => {
    const due = new Date(item.due_at);
    const dueText = Number.isNaN(due.getTime()) ? item.due_at : due.toLocaleString("ru-RU");
    return `<article class="request-card"><div class="request-top"><div>
      <h4>${escapeHtml(item.display_name || currentUser.displayName)} · ${escapeHtml(item.track)}</h4>
      <div class="meta">Срок: ${escapeHtml(dueText)} · назначил: ${escapeHtml(item.assigned_by || "руководство")}</div>
      </div><span class="badge ${item.status === "passed" ? "approved" : item.status === "failed" ? "rejected" : "pending"}">${statusNames[item.status] || "Назначена"}${Number.isInteger(item.score) ? ` · ${item.score}/5` : ""}</span></div>
      ${canStart && item.status !== "passed" ? `<div class="request-actions"><button class="btn small" data-start-attestation="${item.id}">Пройти переаттестацию</button></div>` : ""}
    </article>`;
  };
  const mine = attestations.filter((item) => item.user_id === currentUser.id);
  $("#my-attestations").innerHTML = mine.length
    ? mine.map((item) => card(item, true)).join("")
    : `<div class="empty">Назначенных переаттестаций нет.</div>`;
  const list = isManager() ? attestations : [];
  $("#management-attestations").innerHTML = list.length
    ? list.map((item) => card(item, false)).join("")
    : `<div class="empty">Назначений на переаттестацию пока нет.</div>`;
}

function renderManagement() {
  if (!isManager()) return;
  const pendingCount = members.filter((member) => member.status === "pending").length;
  const pendingApplications = state.requests.filter((item) => item.status === "pending").length;
  $("#management-pending-summary").textContent = `${pendingCount + pendingApplications} решений на рассмотрении`;
  $("#lawyer-calls-required").value = promotionRequirements.lawyerCallsRequired || "";
  $("#lawyer-calls-required").disabled = !isManager();
  $("#save-promotion-requirement").classList.toggle("hidden", !isManager());
  $("#promotion-requirement-status").textContent = promotionRequirements.lawyerCallsRequired
    ? `Текущая норма: ${promotionRequirements.lawyerCallsRequired} вызовов.`
    : "Норма пока не задана — переход Юрист → Адвокат закрыт до настройки руководством.";
  $("#attestation-track").innerHTML = roles.filter((track) => examTracks[track])
    .map((track) => `<option>${escapeHtml(track)}</option>`).join("");
  const pending = members.filter((member) => member.status === "pending");
  $("#pending-members").innerHTML = pending.length
    ? `<h4>Ожидают одобрения</h4>${pending.map((member) => `<article class="request-card">
        <div class="request-top"><div><h4>${escapeHtml(member.display_name)}</h4><div class="meta">@${escapeHtml(member.username)} · зарегистрирован ${escapeHtml(member.created_at)}</div></div><span class="badge pending">Ожидает</span></div>
        ${role() === "ГКА" ? `<div class="request-actions"><button class="btn small" data-member-status="active" data-member-id="${member.id}">Принять в состав</button><button class="btn small danger" data-member-status="suspended" data-member-id="${member.id}">Отклонить</button></div>` : ""}
      </article>`).join("")}`
    : `<div class="empty">Новых аккаунтов на подтверждении нет.</div>`;
  $("#member-list").innerHTML = members.length
    ? members.filter((member) => member.status !== "pending").map((member) => {
        const nameControl = role() === "ГКА"
          ? `<label class="field"><span>Имя и фамилия</span><input data-member-name-input="${member.id}" value="${escapeHtml(member.display_name)}" maxlength="80"></label>
            <button class="btn small subtle" data-member-name-save="${member.id}" type="button">Сохранить имя</button>`
          : "";
        const roleControl = role() === "ГКА"
          ? `<select data-member-role="${member.id}" aria-label="Роль ${escapeHtml(member.display_name)}">${roles.map((item) => `<option${item === member.role ? " selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>`
          : `<span class="badge info">${escapeHtml(member.role)}</span>`;
        const statusAction = role() === "ГКА"
          ? `<button class="btn small ${member.status === "active" ? "danger" : ""}" data-member-status="${member.status === "active" ? "suspended" : "active"}" data-member-id="${member.id}">${member.status === "active" ? "Приостановить" : "Вернуть в состав"}</button>`
          : "";
        const resetAction = role() === "ГКА"
          ? `<button class="btn small subtle" data-reset-password="${member.id}">Выдать код восстановления</button>`
          : "";
        const forumProfile = member.forum_profile_url
          ? `<a href="${escapeHtml(member.forum_profile_url)}" target="_blank" rel="noopener noreferrer">Профиль форума</a>
              · ${member.forum_profile_verified_at ? `проверен ${escapeHtml(profileDate(member.forum_profile_verified_at))}` : "не проверен"}`
          : "Профиль форума не привязан";
        const personnelControls = role() === "ГКА"
          ? `<div class="request-actions member-personnel"><label class="field">Дата вступления<input type="date" data-member-since="${member.id}" value="${escapeHtml(member.member_since || "")}"></label>
              <button class="btn small subtle" type="button" data-member-since-save="${member.id}">Сохранить дату</button>
              ${member.forum_profile_url ? `<button class="btn small" type="button" data-member-forum-verify="${member.id}" data-verified="${member.forum_profile_verified_at ? "true" : "false"}">${member.forum_profile_verified_at ? "Снять подтверждение форума" : "Подтвердить форум"}</button>` : ""}</div>`
          : "";
        return `<article class="request-card"><div class="request-top"><div class="member-ident">
          <img class="member-avatar role-portrait-mini" src="${escapeHtml(rolePortraitUrl(member.role))}" alt="Портрет должности ${escapeHtml(member.role)}">
          <div><h4>${member.role === "Гражданин" ? escapeHtml(member.display_name) : `<button class="profile-trigger" data-profile-id="${escapeHtml(member.id)}" type="button">${escapeHtml(member.display_name)}</button>`}</h4><div class="meta">@${escapeHtml(member.username)} · ${escapeHtml(member.email || "почта не указана")} · Discord: ${escapeHtml(member.discord_username ? "@" + member.discord_username : "не привязан")} · документов: ${member.document_count} · исков: ${member.lawsuit_count}</div></div>
        </div><span class="badge ${member.status === "active" ? "approved" : "rejected"}">${member.status === "active" ? "В составе" : "Приостановлен"}</span></div>
          <div class="meta">${forumProfile}</div>${personnelControls}
          <div class="request-actions">${nameControl}${roleControl}${statusAction}${resetAction}</div></article>`;
      }).join("")
    : `<div class="empty">Список состава пуст.</div>`;
  $("#attestation-member").innerHTML = `<option value="">Выберите участника</option>` +
    members.filter((member) => member.status === "active")
      .map((member) => `<option value="${member.id}">${escapeHtml(member.display_name)} · ${escapeHtml(member.role)}</option>`).join("");
}

async function handleMemberAction(id, changes) {
  try {
    const result = await api(`/api/members/${encodeURIComponent(id)}`, { method: "PATCH", body: changes });
    notify(result.discordWarning || result.nicknameWarning || result.logWarning || "Изменения состава сохранены.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
}

function saveMemberName(button) {
  const input = $(`[data-member-name-input="${button.dataset.memberNameSave}"]`);
  if (input) handleMemberAction(button.dataset.memberNameSave, { displayName: input.value });
}

async function createInvite() {
  try {
    const result = await api("/api/invites", { method: "POST", body: {} });
    $("#invite-result").textContent = `Одноразовый код (действует до ${new Date(result.expiresAt).toLocaleString("ru-RU")}): ${result.code}`;
    $("#invite-result").classList.remove("hidden");
  } catch (error) {
    notify(error.message);
  }
}

function showAuthForm(mode) {
  const login = mode === "login";
  const register = mode === "register";
  $("#login-form").classList.toggle("hidden", !login);
  $("#register-form").classList.toggle("hidden", !register);
  $("#password-reset-form").classList.toggle("hidden", mode !== "reset");
  $("#show-login").classList.toggle("primary", login);
  $("#show-register").classList.toggle("primary", register);
  $("#show-reset").classList.toggle("primary", mode === "reset");
  $("#auth-error").textContent = "";
}

function enterPortal(data) {
  currentUser = data.user;
  csrfToken = data.csrfToken || "";
  $("#auth-screen").classList.add("hidden");
  $("#login-open").classList.add("hidden");
  $("#logout-button").classList.remove("hidden");
  if (currentUser.status !== "active") {
    $("#pending-message").textContent = currentUser.status === "suspended"
      ? "Доступ к аккаунту приостановлен. Обратитесь к ГКА."
      : "Аккаунт создан. Руководитель Коллегии рассмотрит заявку на вступление.";
    $("#pending-screen").classList.remove("hidden");
    return;
  }
  $("#pending-screen").classList.add("hidden");
  renderRole();
}

async function leavePortal() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch (error) {
    notify(error.message);
  }
  currentUser = null;
  csrfToken = "";
  state = { requests: [], laws: {}, documents: [], lawsuits: [], attorneys: [], reprimands: [], tasks: [], events: [], reserve: [], absences: [], characteristics: [], academyMaterials: [], profileStats: null, profileData: null, achievementData: null, documentCount: 0 };
  $("#law-count").textContent = `0 / ${Object.keys(lawMeta).length}`;
  members = [];
  attestations = [];
  $("#profile-name").textContent = "Вход не выполнен";
  $("#profile-role").textContent = "—";
  $("#profile-open").classList.add("hidden");
  $("#logout-button").classList.add("hidden");
  $("#reports-nav").classList.add("hidden");
  $("#rating-settings-card").classList.add("hidden");
  $("#analytics-content").innerHTML = "";
  $("#rating-settings-history").innerHTML = "";
  $("#report-content").innerHTML = "";
  $("#report-sync-status").textContent = "";
  $("#report-csv").disabled = true;
  $("#weekly-reset-card").classList.add("hidden");
  $("#weekly-reset-preview").textContent = "";
  $("#weekly-reset-history").innerHTML = "";
  latestReportData = null;
  googleSheetsConfigured = false;
  $("#discord-link").classList.add("hidden");
  $("#discord-sync").classList.add("hidden");
  $("#discord-nickname-status").classList.add("hidden");
  $("#attorneys-nav").classList.add("hidden");
  $("#discord-status").classList.add("hidden");
  $("#discord-avatar").classList.add("hidden");
  $("#discord-avatar").removeAttribute("src");
  if ($("#discord-required-dialog").open) $("#discord-required-dialog").close();
  $("#login-open").classList.remove("hidden");
  $("#pending-screen").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  showAuthForm("login");
}

async function initializeAuth() {
  try {
    const session = await api("/api/auth/me");
    if (session.user) enterPortal(session);
    else showAuthForm("login");
  } catch {
    $("#auth-error").textContent = "Сервер недоступен. Запусти портал командой npm start и открой http://localhost:3000.";
  }
  const discordResult = new URLSearchParams(window.location.search).get("discord");
  if (discordResult) {
    window.history.replaceState(null, "", window.location.pathname);
    if (discordResult === "linked") {
      await refreshDiscordStatus();
      notify("Discord аккаунт привязан.");
    } else {
      notify("Не удалось привязать Discord. Проверьте конфигурацию OAuth и повторите попытку.");
    }
  }
}

/**
 * Панель «Discord и уведомления»: показывает состояние OAuth, бота и каналов
 * webhook и позволяет отправить проверочное сообщение в каждый канал.
 */
async function loadDiscordIntegration() {
  const card = $("#discord-integration-card");
  if (!card || role() !== "ГКА") return;
  card.classList.remove("hidden");
  const summaryHost = $("#discord-integration-summary");
  const listHost = $("#discord-webhook-list");
  summaryHost.innerHTML = `<div class="empty">Проверяем настройки Discord…</div>`;
  listHost.innerHTML = "";
  try {
    const data = await api("/api/discord/diagnostics");
    const statusPill = (ok, yes = "Настроено", no = "Не настроено") =>
      `<span class="status-pill ${ok ? "is-ok" : "is-off"}">${ok ? yes : no}</span>`;
    summaryHost.innerHTML = `
      <div class="integration-row"><span>OAuth привязка</span>${statusPill(data.oauth.configured)}</div>
      <div class="integration-row"><span>Redirect URI</span>${statusPill(data.oauth.redirectValid, "Корректен", "Проверьте адрес")}</div>
      <div class="integration-row"><span>Discord-бот</span>${statusPill(data.bot.configured)}</div>
      <div class="integration-row"><span>Роли на сервере</span><strong>${Number(data.bot.rolesConfigured)} из 7</strong></div>
      <div class="integration-row"><span>Очередь уведомлений</span><strong>${Number(data.queue.pending)}</strong></div>`;
    listHost.innerHTML = data.webhooks.map((channel) => {
      const configured = channel.configured;
      const lastError = channel.lastError ? `<small class="webhook-error">${escapeHtml(channel.lastError)}</small>` : "";
      const sentInfo = channel.sent || channel.failed
        ? `<small>Отправлено: ${Number(channel.sent)} · ошибок: ${Number(channel.failed)}</small>`
        : `<small>Отправок ещё не было</small>`;
      return `<div class="webhook-row">
        <div class="webhook-copy">
          <strong>${escapeHtml(channel.label)}</strong>
          <code>${escapeHtml(channel.url || "не настроен")}</code>
          ${sentInfo}${lastError}
        </div>
        <button class="btn small ${configured ? "subtle" : ""}" type="button" data-webhook-test="${escapeHtml(channel.kind)}"
          ${configured ? "" : "disabled"}>Проверить</button>
      </div>`;
    }).join("");
  } catch (error) {
    summaryHost.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

/** Отправка тестового сообщения в канал уведомлений. */
async function testWebhookChannel(kind, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Отправляем…";
  try {
    const result = await api("/api/webhooks/test", { method: "POST", body: { kind } });
    notify(`Канал «${result.label || kind}» ответил. Проверьте сообщение в Discord.`);
  } catch (error) {
    notify(error.message);
  } finally {
    button.textContent = original;
    button.disabled = false;
    await loadDiscordIntegration();
  }
}

async function removeReserve(button) {
  if (!window.confirm("Убрать сотрудника из кадрового резерва?")) return;
  button.disabled = true;
  try {
    await api(`/api/reserve/${encodeURIComponent(button.dataset.reserveRemove)}`, { method: "DELETE" });
    notify("Сотрудник удалён из кадрового резерва.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

async function reviewAbsence(button) {
  const status = button.dataset.absenceReview;
  const promptText = status === "rejected"
    ? "Причина отказа (необязательно):" : "Комментарий к решению (необязательно):";
  const reviewNote = window.prompt(promptText);
  if (reviewNote === null) return;
  button.disabled = true;
  try {
    await api(`/api/absences/${encodeURIComponent(button.dataset.absenceId)}`, {
      method: "PATCH", body: { status, reviewNote: reviewNote.trim() }
    });
    notify(status === "approved" ? "Заявка на отсутствие одобрена." : "Заявка на отсутствие отклонена.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

function editAcademyMaterial(button) {
  const material = state.academyMaterials.find((item) => String(item.id) === button.dataset.academyEdit);
  if (!material) {
    notify("Материал Академии не найден. Обновите список.");
    return;
  }
  $("#academy-edit-id").value = material.id;
  $("#academy-title").value = material.title;
  $("#academy-category").value = material.category;
  $("#academy-kind").value = material.kind;
  $("#academy-body").value = material.body;
  $("#academy-form-title").textContent = "Редактировать учебный материал";
  $("#academy-cancel-edit").classList.remove("hidden");
  $("#academy-manage-card").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#academy-title").focus();
}

async function deleteAcademyMaterial(button) {
  if (!window.confirm("Удалить этот учебный материал без возможности восстановления?")) return;
  button.disabled = true;
  try {
    await api(`/api/academy/${encodeURIComponent(button.dataset.academyDelete)}`, { method: "DELETE" });
    resetAcademyForm();
    notify("Материал Академии удалён.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const achievementButton = event.target.closest("[data-achievement-detail]");
  if (achievementButton) {
    const [title, description, metric, threshold] = achievementButton.dataset.achievementDetail.split("|");
    const metricLabels = {
      approved_lawsuits: "подтверждённых судебных дел",
      closed_requests: "закрытых обращений",
      approved_documents: "одобренных документов",
      high_reviews: "высоких отзывов граждан",
      service_days: "дней службы",
      manual: "решений руководства"
    };
    $("#achievement-detail-title").textContent = title;
    $("#achievement-detail-body").innerHTML = `
      <div class="achievement-detail-emblem">${achievementIcon("★")}</div>
      <p>${escapeHtml(description || "Руководство вручает достижение за профессиональный вклад.")}</p>
      <div class="achievement-detail-requirement">
        <span>Условие получения</span>
        <strong>${escapeHtml(threshold || "1")} · ${escapeHtml(metricLabels[metric] || "ручное подтверждение")}</strong>
      </div>`;
    $("#achievement-detail-dialog").showModal();
  }
  const lawFilterButton = event.target.closest("[data-law-filter]");
  if (lawFilterButton) {
    $("#law-filter").value = lawFilterButton.dataset.lawFilter;
    renderLaws();
  }
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    switchTab(tabButton.dataset.tab);
    if (tabButton.dataset.tab === "reports") {
      loadAnalytics();
      loadReport();
      if (role() === "ГКА") {
        loadWeeklyReset();
        loadDiscordIntegration();
      }
    }
  }
  const goButton = event.target.closest("[data-go]");
  if (goButton) switchTab(goButton.dataset.go);
  const searchGoButton = event.target.closest("[data-search-go]");
  if (searchGoButton) {
    switchTab(searchGoButton.dataset.searchGo);
    $("#portal-search-results").classList.add("hidden");
    $("#portal-search").blur();
  }
  if (event.target.closest("#nav-toggle")) {
    document.body.classList.toggle("sidebar-collapsed");
    localStorage.setItem("portal-sidebar-collapsed", String(document.body.classList.contains("sidebar-collapsed")));
    const collapsed = document.body.classList.contains("sidebar-collapsed");
    $("#nav-toggle").setAttribute("aria-label", collapsed ? "Развернуть меню" : "Свернуть меню");
    $("#nav-toggle").title = collapsed ? "Развернуть меню" : "Свернуть меню";
  }
  if (event.target.closest("#notification-open")) {
    $("#notification-center").classList.toggle("hidden");
  }
  if (event.target.closest("#notification-close")) {
    $("#notification-center").classList.add("hidden");
  }
  const monthButton = event.target.closest("[data-calendar-month]");
  if (monthButton) {
    dashboardCalendarMonth.setMonth(dashboardCalendarMonth.getMonth() + Number(monthButton.dataset.calendarMonth));
    dashboardSelectedDate = new Date(dashboardCalendarMonth.getFullYear(), dashboardCalendarMonth.getMonth(), 1);
    renderDashboardCalendar();
  }
  const calendarShift = event.target.closest("[data-calendar-shift]");
  if (calendarShift) {
    const shifted = new Date(calendarViewDate);
    const offset = Number(calendarShift.dataset.calendarShift);
    const mode = $("#calendar-view-mode").value;
    if (mode === "month") shifted.setMonth(shifted.getMonth() + offset);
    else shifted.setDate(shifted.getDate() + offset * (mode === "week" ? 7 : 1));
    calendarViewDate = shifted;
    $("#calendar-view-date").value = calendarDateInputValue(shifted);
    renderCalendar();
  }
  if (event.target.closest("[data-calendar-today]")) {
    calendarViewDate = new Date();
    $("#calendar-view-date").value = calendarDateInputValue(calendarViewDate);
    renderCalendar();
  }
  const dateButton = event.target.closest("[data-dashboard-date]");
  if (dateButton) {
    const [year, month, day] = dateButton.dataset.dashboardDate.split("-").map(Number);
    dashboardSelectedDate = new Date(year, month - 1, day);
    dashboardCalendarMonth = new Date(year, month - 1, 1);
    renderDashboardCalendar();
  }
  const lawReferenceButton = event.target.closest("[data-law-ref-key]");
  if (lawReferenceButton) {
    $("#law-filter").value = lawReferenceButton.dataset.lawRefKey;
    $("#law-search").value = lawReferenceButton.dataset.lawRefArticle;
    renderLaws();
  }
  if (event.target.closest("#report-refresh")) loadReport();
  if (event.target.closest("#discord-diagnostics-refresh")) loadDiscordIntegration();
  const webhookTestButton = event.target.closest("[data-webhook-test]");
  if (webhookTestButton) testWebhookChannel(webhookTestButton.dataset.webhookTest, webhookTestButton);
  if (event.target.closest("#report-csv")) downloadReportCsv();
  if (event.target.closest("#weekly-reset-refresh")) loadWeeklyReset();
  const weeklyResetButton = event.target.closest("[data-weekly-reset-start]");
  if (weeklyResetButton) startWeeklyReset(weeklyResetButton);
  const restoreWeeklyResetButton = event.target.closest("[data-weekly-reset-restore]");
  if (restoreWeeklyResetButton) restoreWeeklyReset(restoreWeeklyResetButton);
  const analyticsPeriodButton = event.target.closest("[data-analytics-period]");
  if (analyticsPeriodButton) loadAnalytics(analyticsPeriodButton.dataset.analyticsPeriod);
  if (event.target.closest("#open-supreme-court")) {
    if (window.portalDesktop?.openForum) {
      window.portalDesktop.openForum().catch((error) => notify(error.message));
    } else {
      window.open("https://forum.gta5rp.com/forums/verkhnyi-sud.2188/", "_blank", "noopener,noreferrer");
    }
  }
  const careerPromotionButton = event.target.closest("[data-career-promotion]");
  if (careerPromotionButton) {
    $("#application-type").value = "promotion";
    updateApplicationPlaceholder();
    $("#request-form").scrollIntoView({ behavior: "smooth", block: "center" });
    $("#application-details").focus();
  }
  const profileButton = event.target.closest("[data-profile-id]");
  if (profileButton) {
    if (currentUser && profileButton.dataset.profileId === String(currentUser.id)) switchTab("profile");
    else openProfile(profileButton.dataset.profileId);
  }
  const memberSinceButton = event.target.closest("[data-member-since-save]");
  if (memberSinceButton) {
    const memberId = memberSinceButton.dataset.memberSinceSave;
    handleMemberAction(memberId, { memberSince: $(`[data-member-since="${memberId}"]`).value });
  }
  const forumVerificationButton = event.target.closest("[data-member-forum-verify]");
  if (forumVerificationButton) {
    handleMemberAction(forumVerificationButton.dataset.memberForumVerify, {
      forumProfileVerified: forumVerificationButton.dataset.verified !== "true"
    });
  }
  const saveMemberNameButton = event.target.closest("[data-member-name-save]");
  if (saveMemberNameButton) saveMemberName(saveMemberNameButton);
  if (event.target.id === "profile-close") $("#profile-dialog").close();
  if (event.target.id === "achievement-detail-close") $("#achievement-detail-dialog").close();
  const selectAttorney = event.target.closest("[data-select-attorney]");
  if (selectAttorney) {
    $("#attorney-choice").value = selectAttorney.dataset.selectAttorney;
    $("#attorney-request-details").focus();
    $("#attorney-request-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const previewButton = event.target.closest("[data-preview]");
  if (previewButton) {
    const paper = previewButton.dataset.preview === "paper";
    $("#forum-preview").classList.toggle("hidden", paper);
    $("#paper-preview").classList.toggle("hidden", !paper);
    $$(".preview-tab").forEach((button) => button.classList.toggle("active", button === previewButton));
  }
  const reviewButton = event.target.closest("[data-review]");
  if (reviewButton) handleReview(reviewButton);
  const forumReviewButton = event.target.closest("[data-forum-review]");
  if (forumReviewButton) handleForumReview(forumReviewButton);
  const forumSubmitButton = event.target.closest("[data-submit-forum]");
  if (forumSubmitButton) {
    const input = $(`[data-forum-url="${forumSubmitButton.dataset.submitForum}"]`);
    submitForumLink(forumSubmitButton.dataset.submitForum, input?.value, forumSubmitButton);
  }
  const openChatButton = event.target.closest("[data-open-chat]");
  if (openChatButton) openCaseChat(openChatButton.dataset.openChat);
  const interviewButton = event.target.closest("[data-interview]");
  if (interviewButton) handleInterviewChange(interviewButton);
  const assignButton = event.target.closest("[data-assign]");
  if (assignButton) handleAssignment(assignButton);
  const saveCaseAssigneeButton = event.target.closest("[data-save-case-assignee]");
  if (saveCaseAssigneeButton) saveCaseAssignee(saveCaseAssigneeButton);
  const saveCaseWorkflowButton = event.target.closest("[data-save-case-workflow]");
  if (saveCaseWorkflowButton) saveCaseWorkflow(saveCaseWorkflowButton);
  const applicationHistoryButton = event.target.closest("[data-application-history]");
  if (applicationHistoryButton) openCaseHistory(applicationHistoryButton.dataset.applicationHistory, "application");
  const lawsuitHistoryButton = event.target.closest("[data-lawsuit-history]");
  if (lawsuitHistoryButton) openCaseHistory(lawsuitHistoryButton.dataset.lawsuitHistory, "lawsuit");
  const closeCaseButton = event.target.closest("[data-close-case]");
  if (closeCaseButton) handleCloseCase(closeCaseButton);
  const taskStatusButton = event.target.closest("[data-task-status]");
  if (taskStatusButton) {
    const taskId = taskStatusButton.dataset.taskId;
    const status = taskStatusButton.dataset.taskStatus;
    if (status === "cancelled" && !window.confirm("Отменить это поручение?")) return;
    const comment = $(`#task-comment-${taskId}`)?.value.trim() || "";
    updateTask(taskId, { status, comment }, taskStatusButton);
  }
  const taskCommentButton = event.target.closest("[data-task-comment-submit]");
  if (taskCommentButton) {
    const taskId = taskCommentButton.dataset.taskCommentSubmit;
    const comment = $(`#task-comment-${taskId}`)?.value.trim() || "";
    if (!comment) notify("Напишите комментарий перед отправкой.");
    else updateTask(taskId, { comment }, taskCommentButton);
  }
  const taskUploadButton = event.target.closest("[data-task-upload]");
  if (taskUploadButton) uploadTaskFiles(taskUploadButton.dataset.taskUpload, taskUploadButton);
  const calendarStatusButton = event.target.closest("[data-event-status]");
  if (calendarStatusButton) {
    if (calendarStatusButton.dataset.eventStatus === "cancelled" &&
        !window.confirm("Отменить это мероприятие?")) return;
    calendarStatusButton.disabled = true;
    api(`/api/calendar/${encodeURIComponent(calendarStatusButton.dataset.eventId)}`, {
      method: "PATCH", body: { status: calendarStatusButton.dataset.eventStatus }
    }).then(async () => {
      notify("Статус мероприятия обновлён.");
      await refreshPortalData();
    }).catch((error) => notify(error.message)).finally(() => {
      calendarStatusButton.disabled = false;
    });
  }
  if (event.target.id === "start-exam") startExam();
  if (event.target.id === "retry-exam") startExam(currentAttestationId);
  const subjectButton = event.target.closest("[data-exam-subject]");
  if (subjectButton) startExam(0, subjectButton.dataset.examSubject);
  const retryLawExam = event.target.closest("#retry-law-exam");
  if (retryLawExam) startExam(0, retryLawExam.dataset.subject);
  if (event.target.id === "quiz-back" && currentQuiz) {
    const selected = $('input[name="answer"]:checked', $("#quiz-form"));
    if (selected) currentQuiz.answers[currentQuiz.step] = Number(selected.value);
    currentQuiz.step -= 1;
    renderQuizStep();
  }
  const attestationButton = event.target.closest("[data-start-attestation]");
  if (attestationButton) startExam(Number(attestationButton.dataset.startAttestation));
  const reserveRemoveButton = event.target.closest("[data-reserve-remove]");
  if (reserveRemoveButton) removeReserve(reserveRemoveButton);
  const absenceReviewButton = event.target.closest("[data-absence-review]");
  if (absenceReviewButton) reviewAbsence(absenceReviewButton);
  const academyEditButton = event.target.closest("[data-academy-edit]");
  if (academyEditButton) editAcademyMaterial(academyEditButton);
  const academyDeleteButton = event.target.closest("[data-academy-delete]");
  if (academyDeleteButton) deleteAcademyMaterial(academyDeleteButton);
  const documentButton = event.target.closest("[data-open-document]");
  if (documentButton) openArchivedDocument(documentButton.dataset.openDocument);
  const memberStatusButton = event.target.closest("[data-member-status]");
  if (memberStatusButton) handleMemberAction(memberStatusButton.dataset.memberId, { status: memberStatusButton.dataset.memberStatus });
  const resetPasswordButton = event.target.closest("[data-reset-password]");
  if (resetPasswordButton) issuePasswordReset(resetPasswordButton);
  const saveCaseButton = event.target.closest("[data-save-case]");
  if (saveCaseButton) updateLawsuit(saveCaseButton);
  const saveLawsuitWorkflowButton = event.target.closest("[data-save-lawsuit-workflow]");
  if (saveLawsuitWorkflowButton) saveLawsuitWorkflow(saveLawsuitWorkflowButton);
  if (event.target.id === "submit-lawsuit") submitLawsuit(event.target);
  if (event.target.id === "submit-forum-document") submitCurrentForumDocument(event.target);
  if (event.target.id === "chat-share-contact") shareCaseContact();
  if (event.target.id === "chat-close-case") handleCloseCase(event.target);
  if (event.target.id === "chat-close-dialog") $("#case-chat-dialog").close();
  if (event.target.id === "case-history-close") $("#case-history-dialog").close();
  if (event.target.id === "quiz-close") $("#quiz-dialog").close();
  if (event.target.id === "welcome-continue") {
    $("#welcome-dialog").close();
    switchTab("career");
  }
  if (event.target.id === "welcome-later") {
    $("#welcome-dialog").close();
  }
  if (event.target.id === "interview-close") {
    $("#interview-dialog").close();
  }
  if (event.target.id === "interview-ready") handleInterviewChange({ dataset: { interview: "ready" } });
  if (event.target.id === "interview-waiting") handleInterviewChange({ dataset: { interview: "waiting" } });
  if (event.target.closest("#discord-link") || event.target.closest("#discord-required-link")) linkDiscord();
  if (event.target.closest("#discord-sync")) syncDiscord();
  if (event.target.id === "login-open") {
    $("#auth-screen").classList.remove("hidden");
    showAuthForm("login");
  }
  if (event.target.id === "show-login") showAuthForm("login");
  if (event.target.id === "show-register") showAuthForm("register");
  if (event.target.id === "show-reset") showAuthForm("reset");
  if (event.target.id === "logout-button" || event.target.id === "pending-logout") leavePortal();
});

document.addEventListener("toggle", async (event) => {
  const details = event.target.closest("[data-task-history-toggle]");
  if (!details || !details.open || details.dataset.historyLoaded) return;
  const taskId = details.dataset.taskHistoryToggle;
  const target = $(`[data-task-history="${taskId}"]`, details);
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    const actionLabels = {
      created: "Поручение создано", status: "Изменён статус", comment: "Комментарий",
      edited: "Параметры обновлены", assignees: "Исполнители обновлены", attachment: "Вложение добавлено"
    };
    target.innerHTML = result.history.length
      ? result.history.map((item) => `<div class="request-card"><div class="meta">${escapeHtml(item.actor_name)} · ${escapeHtml(portalDate(item.created_at))}</div>
          <strong>${escapeHtml(actionLabels[item.action] || item.action)}</strong>
          ${item.from_status || item.to_status ? `<div class="meta">${escapeHtml(taskStatusLabels[item.from_status] || "")}${item.from_status && item.to_status ? " → " : ""}${escapeHtml(taskStatusLabels[item.to_status] || "")}</div>` : ""}
          ${item.comment ? `<p>${escapeHtml(item.comment)}</p>` : ""}</div>`).join("")
      : `<div class="empty">История пока пуста.</div>`;
    details.dataset.historyLoaded = "true";
  } catch (error) {
    target.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    notify(error.message);
  }
}, true);

async function openArchivedDocument(id) {
  try {
    const result = await api(`/api/documents/${encodeURIComponent(id)}`);
    switchTab("documents");
    renderDocumentPreview(result.document.bbcode, {});
    notify("Документ открыт из архива.");
  } catch (error) {
    notify(error.message);
  }
}

document.addEventListener("change", (event) => {
  const roleSelect = event.target.closest("[data-member-role]");
  if (roleSelect) handleMemberAction(roleSelect.dataset.memberRole, { role: roleSelect.value });
});
$("#case-chat-dialog").addEventListener("close", () => {
  window.clearInterval(chatPollTimer);
  chatPollTimer = 0;
  activeChatId = null;
});
$("#discord-required-dialog").addEventListener("cancel", (event) => event.preventDefault());
$("#chat-form").addEventListener("submit", submitChatMessage);
$("#document-fields").addEventListener("input", () => {
  generatedDocumentId = null;
  $("#forum-publish").classList.add("hidden");
  $("#submit-lawsuit").classList.add("hidden");
});
$("#document-fields").addEventListener("change", () => {
  generatedDocumentId = null;
  $("#forum-publish").classList.add("hidden");
  $("#submit-lawsuit").classList.add("hidden");
});
$("#document-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = documentValues();
  if ($("#doc-template").value === "complaint" &&
      Number(values.videoMinutes) > 1 && !values.timecodes.trim()) {
    notify("Для видео длиннее одной минуты добавьте тайм-коды нарушений.");
    $('[data-doc-key="timecodes"]', $("#document-fields")).focus();
    return;
  }
  if ($("#doc-template").value === "complaint") {
    const eventDate = parseComplaintEventDate(values.eventDate);
    if (!eventDate) {
      notify("Введите дату и время в формате ДД.ММ.ГГГГ, ЧЧ:ММ.");
      $('[data-doc-key="eventDate"]', $("#document-fields")).focus();
      return;
    }
    const age = Date.now() - eventDate.getTime();
    if (age < 0 || age > 24 * 60 * 60 * 1000) {
      notify("Жалобу можно подать только по событию, которое произошло в последние 24 часа.");
      $('[data-doc-key="eventDate"]', $("#document-fields")).focus();
      return;
    }
  }
  try {
    if ($("#doc-template").value === "complaint" || $("#doc-template").value === "rehabilitation") {
      const sequence = await api("/api/sequences/next", {
        method: "POST",
        body: { type: $("#doc-template").value }
      });
      const key = $("#doc-template").value === "complaint" ? "cpNumber" : "rehabNumber";
      values[key] = sequence.number;
      $(`[data-doc-key="${key}"]`, $("#document-fields")).value = sequence.number;
    }
    generatedDocumentId = null;
    const bbcode = makeDocument(values);
    renderDocumentPreview(bbcode, values);
    const isLawsuit = ["lawsuit-supreme", "lawsuit-federal", "appeal", "cassation", "constitutional"]
      .includes($("#doc-template").value);
    $("#forum-publish").classList.remove("hidden");
    $("#submit-lawsuit").classList.toggle("hidden", !isLawsuit);
    $("#submit-forum-document").classList.toggle("hidden", isLawsuit);
    $("#save-document").classList.toggle("hidden", isLawsuit);
    notify("BBCode сформирован. Проверьте текст, опубликуйте его на форуме и добавьте ссылку для зачёта.");
  } catch (error) {
    notify(error.message);
  }
});
$("#save-document").addEventListener("click", async () => {
  const bbcode = $("#document-output").value;
  if (!bbcode.trim()) {
    notify("Сначала сформируйте BBCode.");
    return;
  }
  if (generatedDocumentId) {
    notify("Этот черновик уже сохранён в архиве.");
    return;
  }
  const option = $("#doc-template").selectedOptions[0];
  const title = `${option.textContent}${$("#doc-template").value === "complaint" ? " " + $('[data-doc-key="cpNumber"]', $("#document-fields")).value : ""}`;
  try {
    const result = await api("/api/documents", { method: "POST", body: { template: $("#doc-template").value, title, bbcode } });
    generatedDocumentId = result.id;
    notify("Документ сохранён в архиве как черновик. Для зачёта добавьте форумную ссылку.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
});
$("#submit-lawsuit").addEventListener("click", (event) => submitLawsuit(event.currentTarget));
$("#submit-forum-document").addEventListener("click", (event) => submitCurrentForumDocument(event.currentTarget));
$("#law-search").addEventListener("input", renderLaws);
$("#law-filter").addEventListener("change", renderLaws);
$("#ranking-period").addEventListener("change", loadRanking);
$("#rating-settings-save").addEventListener("click", (event) => saveRatingSettings(event.currentTarget));
$("#application-type").addEventListener("change", updateApplicationPlaceholder);
$("#application-attachments").addEventListener("change", updateApplicationFiles);
document.addEventListener("submit", (event) => {
  const form = event.target.closest("#junior-requirements-form");
  if (!form) return;
  event.preventDefault();
  saveJuniorRequirements(form);
});
document.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-lawyer-rating]");
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.lawyerRating;
  const rating = Number($('[name="rating"]:checked', form)?.value);
  const comment = $('[name="comment"]', form).value.trim();
  api(`/api/applications/${encodeURIComponent(id)}/rating`, {
    method: "POST", body: { rating, comment }
  }).then(async () => {
    notify("Оценка адвокату отправлена.");
    await refreshPortalData();
  }).catch((error) => notify(error.message));
});
$("#attorney-request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/applications", { method: "POST", body: {
      type: $("#attorney-request-type").value,
      details: $("#attorney-request-details").value.trim(),
      lawyerId: $("#attorney-choice").value || null
    }});
    $("#attorney-request-form").reset();
    notify(result.webhookWarning || "Обращение сохранено. Вы увидите ответ в своих заявках.");
    await refreshPortalData();
    switchTab("applications");
  } catch (error) {
    notify(error.message);
  }
});
$("#employment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/applications", { method: "POST", body: {
      type: "employment",
      discordUsername: $("#employment-discord").value.trim(),
      gtaName: $("#employment-gta-name").value.trim(),
      passportId: $("#employment-passport").value.trim(),
      details: $("#employment-details").value.trim()
    }});
    $("#employment-form").reset();
    notify(result.webhookWarning || "Заявка на вступление отправлена ГКА.");
    await refreshPortalData();
    switchTab("applications");
  } catch (error) {
    notify(error.message);
  }
});
$("#reprimand-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#reprimand-photo").files[0];
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
    notify("Выберите JPG, PNG или WebP-фото размером не более 2 МБ.");
    return;
  }
  try {
    const result = await api("/api/reprimands", { method: "POST", body: {
      userId: Number($("#reprimand-member").value),
      reason: $("#reprimand-reason").value.trim(),
      photo: { name: file.name, type: file.type, data: await fileAsBase64(file) }
    }});
    $("#reprimand-form").reset();
    const warnings = [result.dmWarning, result.webhookWarning].filter(Boolean);
    notify(warnings.length ? warnings.join(" ") : `Выговор №${result.id} выдан и сохранён.`);
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
});
$("#task-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = $('button[type="submit"]', event.currentTarget);
  const dueValue = $("#task-due").value;
  const assigneeIds = Array.from($("#task-assignees").selectedOptions, (option) => Number(option.value));
  if (!assigneeIds.length) {
    notify("Назначьте поручение хотя бы одному сотруднику.");
    return;
  }
  submitButton.disabled = true;
  try {
    const attachments = await Promise.all(Array.from($("#task-files").files).map(async (file) => ({
      name: file.name,
      type: file.type,
      data: await fileAsBase64(file)
    })));
    const result = await api("/api/tasks", { method: "POST", body: {
      title: $("#task-title").value.trim(),
      description: $("#task-description").value.trim(),
      priority: $("#task-priority").value,
      dueAt: dueValue ? new Date(dueValue).toISOString() : null,
      assigneeIds,
      attachments
    }});
    event.currentTarget.reset();
    notify(result.webhookWarning || "Поручение создано и назначено.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    submitButton.disabled = false;
  }
});
$("#calendar-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = $('button[type="submit"]', event.currentTarget);
  const startsAt = $("#event-starts").value;
  if (!startsAt) {
    notify("Укажите дату и время мероприятия.");
    return;
  }
  submitButton.disabled = true;
  try {
    await api("/api/calendar", { method: "POST", body: {
      title: $("#event-title").value.trim(),
      eventType: $("#event-type").value,
      description: $("#event-description").value.trim(),
      startsAt: new Date(startsAt).toISOString(),
      responsibleId: Number($("#event-responsible").value),
      participantIds: Array.from($("#event-participants").selectedOptions, (option) => Number(option.value)),
      isAllStaff: $("#event-all-staff").checked
    }});
    event.currentTarget.reset();
    notify("Мероприятие добавлено в календарь.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    submitButton.disabled = false;
  }
});
$("#task-filter").addEventListener("change", renderTasks);
$("#calendar-view-mode").addEventListener("change", renderCalendar);
$("#calendar-view-date").addEventListener("change", renderCalendar);
$("#request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const details = $("#application-details").value.trim();
  const type = $("#application-type").value;
  const promotionData = {};
  if (type === "exam" && role() === "Стажер КА") {
    promotionData.lectureAttended = $("#lecture-attended").checked;
  } else if (type === "exam" && role() === "Юрист") {
    promotionData.completedCalls = Number($("#completed-calls").value);
    promotionData.trialLawsuitReference = $("#trial-lawsuit").value.trim();
  } else if (type === "promotion" && role() === "Адвокат") {
    promotionData.completedCalls = Number($("#completed-calls").value);
    promotionData.callsWithLawyer = Number($("#calls-with-lawyer").value);
    promotionData.acceptedLawsuitReference = $("#accepted-lawsuit").value.trim();
  }
  try {
    const attachments = await serializeApplicationFiles();
    const result = await api("/api/applications", { method: "POST", body: {
      type, details, promotionData, passportId: $("#application-passport").value.trim(), attachments
    }});
    $("#application-details").value = "";
    $("#application-passport").value = "";
    $("#application-attachments").value = "";
    applicationFiles = [];
    applicationPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    applicationPreviewUrls = [];
    $("#attachment-preview").replaceChildren();
    notify(result.webhookWarning || "Заявка сохранена на сервере.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
});
document.addEventListener("submit", (event) => {
  if (event.target.id !== "quiz-form") return;
  event.preventDefault();
  const selected = $('input[name="answer"]:checked', event.target);
  if (!selected) {
    notify("Ответьте на все вопросы.");
    return;
  }
  currentQuiz.answers[currentQuiz.step] = Number(selected.value);
  if (currentQuiz.step < currentQuiz.questions.length - 1) {
    currentQuiz.step += 1;
    renderQuizStep();
    return;
  }
  api("/api/exams", { method: "POST", body: {
    answers: currentQuiz.answers,
    attestationId: currentAttestationId,
    subject: currentQuiz.subject || ""
  }}).then(renderQuizResult).catch((error) => notify(error.message));
});
$("#doc-template").addEventListener("change", renderDocumentFields);
$("#copy-document").addEventListener("click", () => copyText($("#document-output").value, "BBCode скопирован."));
$("#download-document").addEventListener("click", downloadDocument);
$("#promotion-requirement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/promotion-requirements", {
      method: "PATCH",
      body: { lawyerCallsRequired: Number($("#lawyer-calls-required").value) }
    });
    promotionRequirements.lawyerCallsRequired = result.lawyerCallsRequired;
    notify("Норма вызовов для юриста сохранена.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
});
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const result = await api("/api/auth/login", { method: "POST", body: {
      username: $("#login-username").value,
      password: $("#login-password").value
    }});
    $("#login-password").value = "";
    enterPortal(result);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const result = await api("/api/auth/register", { method: "POST", body: {
      accountType: $("#registration-kind").value,
      inviteCode: $("#register-invite").value,
      username: $("#register-username").value,
      displayName: $("#register-display-name").value,
      email: $("#register-email").value,
      password: $("#register-password").value
    }});
    $("#register-password").value = "";
    enterPortal(result);
    if (result.webhookWarning) notify(result.webhookWarning);
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
});
$("#password-reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#auth-error").textContent = "";
  try {
    await api("/api/auth/reset-password", { method: "POST", body: {
      username: $("#reset-username").value,
      code: $("#reset-code").value,
      password: $("#reset-password").value
    }});
    $("#password-reset-form").reset();
    showAuthForm("login");
    notify("Пароль изменён. Войдите с новым паролем.");
  } catch (error) {
    $("#auth-error").textContent = error.message;
  }
});
$("#registration-kind").addEventListener("change", () => {
  const staffRegistration = $("#registration-kind").value === "staff";
  $("#invite-field").classList.toggle("hidden", !staffRegistration);
  $("#register-invite").required = staffRegistration;
  $("#registration-guidance").textContent = staffRegistration
    ? "Одноразовый код создаёт одну заявку стажера. После одобрения ГКА аккаунт активируется."
    : "Гражданин регистрируется без приглашения и может сразу отправить запрос адвокату или жалобу.";
});
$("#attestation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/attestations", { method: "POST", body: {
      userId: $("#attestation-member").value,
      track: $("#attestation-track").value,
      dueAt: new Date($("#attestation-due").value).toISOString()
    }});
    $("#attestation-form").reset();
    notify("Переаттестация назначена.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  }
});
$("#create-invite").addEventListener("click", createInvite);
$("#discord-required-logout").addEventListener("click", leavePortal);
$("#forum-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/profile", { method: "PATCH", body: { forumProfileUrl: $("#forum-profile-url").value } });
    notify("Ссылка на профиль форума сохранена. Для отметки «проверен» попросите ГКА подтвердить её.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#profile-customize-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const pinnedCases = [1, 2, 3].map((index) => ({
    title: $(`#pinned-case-${index}`).value.trim(),
    status: $(`#pinned-case-status-${index}`).value.trim()
  })).filter((item) => item.title);
  button.disabled = true;
  try {
    await api("/api/profile", {
      method: "PATCH",
      body: {
        profileBio: $("#profile-bio").value,
        profileQuote: $("#profile-quote").value,
        pinnedCases,
        profileEffect: $("#profile-effect").value
      }
    });
    applyProfileEffect($("#profile-effect").value);
    notify("Оформление профиля сохранено.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#colleagues-search").addEventListener("input", renderColleagues);
$("#colleagues-role-filter").addEventListener("change", renderColleagues);
$("#achievement-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/achievements", { method: "POST", body: {
      title: $("#achievement-title").value,
      icon: $("#achievement-icon").value,
      description: $("#achievement-description").value,
      metric: $("#achievement-metric").value,
      threshold: Number($("#achievement-threshold").value)
    }});
    event.currentTarget.reset();
    $("#achievement-icon").value = "★";
    $("#achievement-threshold").value = "1";
    notify("Достижение добавлено в каталог.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#achievement-award-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/achievements/${encodeURIComponent($("#achievement-award-id").value)}/award`, {
      method: "POST", body: { userId: Number($("#achievement-award-user").value) }
    });
    event.currentTarget.reset();
    notify("Ручное достижение записано в личное дело.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#award-create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/awards", { method: "POST", body: {
      userId: Number($("#award-user").value),
      kind: $("#award-kind").value,
      title: $("#award-title").value,
      description: $("#award-description").value
    }});
    event.currentTarget.reset();
    notify("Награда вручена и записана в личное дело.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#reserve-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/reserve", { method: "POST", body: {
      userId: Number($("#reserve-user").value),
      status: $("#reserve-status").value,
      note: $("#reserve-note").value.trim()
    }});
    form.reset();
    notify("Запись кадрового резерва сохранена.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#absence-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/absences", { method: "POST", body: {
      startDate: $("#absence-start").value,
      endDate: $("#absence-end").value,
      reason: $("#absence-reason").value.trim()
    }});
    form.reset();
    notify(result.warning || "Заявка на отсутствие отправлена руководству.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#characteristic-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/characteristics", { method: "POST", body: {
      userId: Number($("#characteristic-user").value),
      criterion: $("#characteristic-area").value,
      score: Number($("#characteristic-score").value),
      note: $("#characteristic-note").value.trim()
    }});
    form.reset();
    notify("Внутренняя характеристика сохранена.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#academy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  const materialId = $("#academy-edit-id").value;
  try {
    await api(materialId ? `/api/academy/${encodeURIComponent(materialId)}` : "/api/academy", {
      method: materialId ? "PATCH" : "POST",
      body: {
        title: $("#academy-title").value.trim(),
        category: $("#academy-category").value,
        kind: $("#academy-kind").value,
        body: $("#academy-body").value.trim()
      }
    });
    resetAcademyForm();
    notify(materialId ? "Материал Академии обновлён." : "Материал Академии добавлен.");
    await refreshPortalData();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#academy-cancel-edit").addEventListener("click", resetAcademyForm);
$("#academy-search").addEventListener("input", renderAcademy);
$("#academy-category-filter").addEventListener("change", renderAcademy);

$("#portal-search").addEventListener("input", renderPortalSearch);
$("#portal-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("#portal-search-results").classList.add("hidden");
  if (event.key === "Enter") {
    event.preventDefault();
    $("#portal-search-results").querySelector("[data-search-go]")?.click();
  }
});
$("#report-search").addEventListener("input", () => {
  if (latestReportData) renderReport(latestReportData);
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".global-search")) $("#portal-search-results").classList.add("hidden");
});
document.body.classList.toggle("sidebar-collapsed", localStorage.getItem("portal-sidebar-collapsed") === "true");
function initWinterSnow() {
  const host = $("#winter-snow");
  if (!host) return;
  host.replaceChildren();
  for (let index = 0; index < 34; index += 1) {
    const flake = document.createElement("span");
    flake.className = "snowflake";
    flake.style.setProperty("--snow-left", `${(index * 37 + 11) % 100}%`);
    flake.style.setProperty("--snow-duration", `${14 + (index % 9)}s`);
    flake.style.setProperty("--snow-delay", `${-(index % 17)}s`);
    flake.style.setProperty("--snow-drift", `${12 - (index % 5) * 6}px`);
    flake.style.opacity = String(.25 + (index % 4) * .12);
    host.appendChild(flake);
  }
}
initWinterSnow();
renderDocumentFields();
initializeAuth();
