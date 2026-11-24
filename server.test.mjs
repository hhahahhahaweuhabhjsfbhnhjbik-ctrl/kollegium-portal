import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDiscordCitizenRequest, createInitialAdminAccount, createPortalServer as createPortalServerInstance, initialAdminExists, issueDiscordInvite,
  runDiscordPortalAction, runDiscordPortalCommand, startPortal
} from "./server.mjs";
import { canControlService, parseTechCommand } from "./discord-bot.mjs";

const createPortalServer = (options = {}) => createPortalServerInstance(options);

async function createClient(baseUrl) {
  let cookie = "";
  let csrf = "";
  const request = async (path, method = "GET", body) => {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (cookie) headers.cookie = cookie;
    if (csrf) headers["x-csrf-token"] = csrf;
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    if (data.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data };
  };
  request.raw = async (path) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    const response = await fetch(new URL(path, baseUrl), { headers });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: Buffer.from(await response.arrayBuffer())
    };
  };
  request.cookie = () => cookie;
  request.csrfToken = () => csrf;
  return request;
}

test("Discord tech commands accept only explicit actions and are admin-only", () => {
  assert.equal(parseTechCommand("!tech on"), "on");
  assert.equal(parseTechCommand("!TECH OFF"), "off");
  assert.equal(parseTechCommand("!tech restart"), "restart");
  assert.equal(parseTechCommand("!tech"), "help");
  assert.equal(parseTechCommand("!tech run something"), null);
  assert.equal(parseTechCommand("/tech restart"), null);
  assert.equal(canControlService({ authorId: "owner", ownerId: "owner", isAdministrator: false }), true);
  assert.equal(canControlService({ authorId: "admin", ownerId: "owner", isAdministrator: true }), true);
  assert.equal(canControlService({ authorId: "member", ownerId: "owner", isAdministrator: false }), false);
});

test("desktop first run creates a single active GKA account", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portal-desktop-"));
  const dbPath = path.join(directory, "portal.sqlite");
  try {
    assert.equal(initialAdminExists(dbPath), false);
    await createInitialAdminAccount(dbPath, {
      username: "desktop.gka",
      displayName: "Глава Коллегии",
      password: "DesktopPassword!23"
    });
    assert.equal(initialAdminExists(dbPath), true);
    await assert.rejects(createInitialAdminAccount(dbPath, {
      username: "second.gka",
      displayName: "Второй",
      password: "DesktopPassword!23"
    }), /ГКА уже создан/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Discord citizen request creates a portal application", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portal-discord-help-"));
  const dbPath = path.join(directory, "portal.sqlite");
  let portal;
  try {
    portal = await startPortal({ dbPath, host: "127.0.0.1", port: 0, startBot: false });
    const result = await createDiscordCitizenRequest({
      db: portal.server.portalDb,
      discordId: "123456789012345678",
      discordUsername: "citizen_test",
      displayName: "Иван Иванов",
      details: "Нужна консультация по задержанию сотрудниками полиции.",
      webhookUrl: ""
    });
    assert.ok(result.applicationId > 0);
    const citizen = portal.server.portalDb.prepare("SELECT role,status,discord_id FROM users WHERE discord_id=?")
      .get("123456789012345678");
    assert.equal(citizen.role, "Гражданин");
    assert.equal(citizen.status, "active");
    assert.equal(citizen.discord_id, "123456789012345678");
    await assert.rejects(createDiscordCitizenRequest({
      db: portal.server.portalDb,
      discordId: "123456789012345678",
      discordUsername: "citizen_test",
      displayName: "Иван Иванов",
      details: "Повторное обращение до ответа адвоката.",
      webhookUrl: ""
    }), /уже есть активное обращение/);
  } finally {
    if (portal) await portal.close().catch(() => {});
    if (portal?.server?.portalDb) {
      try { portal.server.portalDb.close(); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop server serves the portal and shuts down cleanly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portal-host-"));
  const portal = await startPortal({
    dbPath: path.join(directory, "portal.sqlite"),
    host: "127.0.0.1",
    port: 0,
    startBot: false
  });
  try {
    const response = await fetch(`http://127.0.0.1:${portal.port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Коллегия адвокатов/);
    const memo = await fetch(`http://127.0.0.1:${portal.port}/pamyatka_advokata.html`);
    assert.equal(memo.status, 200);
    assert.equal(memo.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(memo.headers.get("content-security-policy"), /frame-ancestors 'self'/);
    assert.match(await memo.text(), /Памятка адвоката/);
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /COPY [^\r\n]*\bpamyatka_advokata\.html\b[^\r\n]*\.\//);
    assert.match(dockerfile, /^COPY photozot \.\/photozot$/m);
    const health = await fetch(`http://127.0.0.1:${portal.port}/api/health`);
    assert.deepEqual(await health.json(), { ok: true, apiVersion: 4, maintenance: false });

    portal.server.portalDb.prepare(`INSERT INTO portal_settings (key, value)
      VALUES ('maintenance_mode', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    const maintenance = await fetch(`http://127.0.0.1:${portal.port}/`);
    assert.equal(maintenance.status, 503);
    assert.match(await maintenance.text(), /Технические работы/);
    const maintenanceHealth = await fetch(`http://127.0.0.1:${portal.port}/api/health`);
    assert.deepEqual(await maintenanceHealth.json(), { ok: true, apiVersion: 4, maintenance: true });

    portal.server.portalDb.prepare("UPDATE portal_settings SET value = 'off' WHERE key = 'maintenance_mode'").run();
    assert.equal((await fetch(`http://127.0.0.1:${portal.port}/`)).status, 200);
  } finally {
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Discord invite button issues one code per day and rolls back failed DMs", async () => {
  const server = createPortalServer({ dbPath: ":memory:" });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const passwordHash = scryptSync("CorrectHorseBattery9!", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("gka", `scrypt$${salt.toString("base64")}$${passwordHash.toString("base64")}`, "Глава", "ГКА", "active");

  try {
    const sentCodes = [];
    await issueDiscordInvite(db, "12345678901234567", async (code) => sentCodes.push(code), "");
    assert.match(sentCodes[0], /^[A-Za-z0-9_-]{24}$/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invites").get().count, 1);
    await assert.rejects(
      issueDiscordInvite(db, "12345678901234567", async () => {}, ""),
      /Повторный код можно запросить/
    );

    await assert.rejects(
      issueDiscordInvite(db, "12345678901234568", async () => { throw new Error("DM closed"); }, ""),
      /Не удалось отправить код/
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invites").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM discord_invite_issuance").get().count, 1);
  } finally {
    db.close();
  }
});

test("Discord portal commands require a linked active account and matching server role", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("DiscordCommandsPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role, discordId) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,discord_id) VALUES (?,?,?,?, 'active',?)"
  ).run(username, passwordHash, displayName, role, discordId).lastInsertRowid);
  const attorneyId = addUser("discord-attorney", "Адвокат Discord", "Адвокат", "23456789012345678");
  const managerId = addUser("discord-manager", "ГКА Discord", "ГКА", "34567890123456789");
  const roleIds = { "Адвокат": "attorney-role", "ГКА": "manager-role" };
  const taskId = Number(db.prepare(`INSERT INTO tasks (title,description,status,created_by)
    VALUES ('Задача на проверку','Проверить заключение','review',?)`).run(managerId).lastInsertRowid);
  db.prepare("INSERT INTO task_assignees (task_id,user_id,assigned_by) VALUES (?,?,?)")
    .run(taskId, attorneyId, managerId);

  try {
    const profile = await runDiscordPortalCommand({
      db, discordUserId: "23456789012345678", commandName: "profile",
      memberRoleIds: ["attorney-role"], roleIds
    });
    assert.match(profile, /Адвокат Discord/);
    await assert.rejects(runDiscordPortalCommand({
      db, discordUserId: "23456789012345678", commandName: "profile",
      memberRoleIds: ["manager-role"], roleIds
    }), /Роль Discord не совпадает/);
    const startDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const absence = await runDiscordPortalCommand({
      db, discordUserId: "23456789012345678", commandName: "absence",
      options: { startDate, endDate: startDate, reason: "Плановое отсутствие" },
      memberRoleIds: ["attorney-role"], roleIds,
      notifyAbsence: async () => "Уведомление отправлено."
    });
    assert.match(absence, /Уведомление отправлено/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM absence_requests WHERE user_id = ?").get(attorneyId).count, 1);
    await assert.rejects(runDiscordPortalCommand({
      db, discordUserId: "23456789012345678", commandName: "absence",
      options: { startDate, endDate: startDate, reason: "Повторная заявка" },
      memberRoleIds: ["attorney-role"], roleIds
    }), /уже подана/);
    await assert.rejects(runDiscordPortalCommand({
      db, discordUserId: "23456789012345678", commandName: "report",
      memberRoleIds: ["attorney-role"], roleIds
    }), /только руководству/);
    const report = await runDiscordPortalCommand({
      db, discordUserId: "34567890123456789", commandName: "report",
      memberRoleIds: ["manager-role"], roleIds
    });
    assert.match(report, /Краткий отчёт за 30 дней/);
    assert.throws(() => runDiscordPortalAction({
      db, discordUserId: "23456789012345678", action: `task-complete:${taskId}`,
      memberRoleIds: ["attorney-role"], roleIds
    }), /только руководству/);
    assert.match(runDiscordPortalAction({
      db, discordUserId: "34567890123456789", action: `task-complete:${taskId}`,
      memberRoleIds: ["manager-role"], roleIds
    }), /подтверждено/);
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId).status, "completed");
    assert.throws(() => runDiscordPortalAction({
      db, discordUserId: "34567890123456789", action: `task-complete:${taskId}`,
      memberRoleIds: ["manager-role"], roleIds
    }), /уже рассмотрено/);
  } finally {
    db.close();
  }
});

test("staff accounts require website approval, server-approved exams, attestations and law access", async () => {
  const webhookRequests = [];
  const discordRequests = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    webhookApplications: "https://discord.com/api/webhooks/123456789012345678/test-token",
    webhookLogs: "https://discord.com/api/webhooks/123456789012345678/test-token",
    webhookFetch: async (_url, options) => {
      webhookRequests.push(options);
      return new Response(null, { status: 204 });
    },
    discordBotToken: "test-bot-token",
    discordGuildId: "",
    discordFetch: async (url, options) => {
      discordRequests.push({ url: String(url), ...options });
      const channelResponse = String(url).endsWith("/users/@me/channels");
      return new Response(JSON.stringify(channelResponse
        ? { id: "23456789012345678" }
        : { id: "34567890123456789" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const passwordHash = scryptSync("CorrectHorseBattery9!", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("gka", `scrypt$${salt.toString("base64")}$${passwordHash.toString("base64")}`, "Глава", "ГКА", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = await createClient(baseUrl);
  const trainee = await createClient(baseUrl);

  try {
    const login = await admin("/api/auth/login", "POST", { username: "gka", password: "CorrectHorseBattery9!" });
    assert.equal(login.status, 200);

    const registration = await trainee("/api/auth/register", "POST", {
      accountType: "staff",
      username: "trainee",
      displayName: "Стажер",
      password: "CandidatePassword!23"
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.data.user.status, "pending");
    assert.equal(registration.data.user.role, "Стажер КА");
    assert.equal(registration.data.webhookWarning, "");
    const staffApplicationWebhook = webhookRequests.find((request) => {
      if (!(request.body instanceof FormData)) return false;
      return JSON.parse(request.body.get("payload_json")).embeds[0].title === "Новая заявка на вступление";
    });
    assert.ok(staffApplicationWebhook);
    const staffApplicationEmbed = JSON.parse(staffApplicationWebhook.body.get("payload_json")).embeds[0];
    assert.equal(staffApplicationEmbed.thumbnail.url, "attachment://collegium-seal.png");
    assert.equal(staffApplicationWebhook.body.get("files[0]").name, "collegium-seal.png");
    const pendingSession = await trainee("/api/auth/me");
    assert.equal(pendingSession.status, 200);
    assert.equal(pendingSession.data.user.status, "pending");
    assert.equal((await trainee("/api/applications")).status, 403);
    const secondApplicant = await createClient(baseUrl);
    const secondRegistration = await secondApplicant("/api/auth/register", "POST", {
      accountType: "staff", username: "second", displayName: "Второй", password: "CandidatePassword!23"
    });
    assert.equal(secondRegistration.status, 201);
    assert.equal(secondRegistration.data.user.status, "pending");

    const pendingMembers = await admin("/api/members");
    assert.ok(pendingMembers.data.members.some((member) =>
      member.id === registration.data.user.id && member.status === "pending"));

    const memberId = registration.data.user.id;
    assert.equal((await admin(`/api/members/${memberId}`, "PATCH", { status: "active" })).status, 200);
    const application = await trainee("/api/applications", "POST", {
      type: "exam", details: "Прошу допустить к проверке знаний.",
      promotionData: { lectureAttended: true }
    });
    assert.equal(application.status, 201);
    const questions = await trainee("/api/exams/current");
    assert.equal(questions.status, 200);
    assert.equal(questions.data.questions.length, 5);
    assert.equal((await admin(`/api/applications/${application.data.id}/review`, "PATCH", { status: "approved" })).status, 409);

    const result = await trainee("/api/exams", "POST", { answers: [1, 1, 1, 2, 1] });
    assert.deepEqual({ score: result.data.score, passed: result.data.passed }, { score: 5, passed: true });
    assert.equal((await admin(`/api/applications/${application.data.id}/review`, "PATCH", {
      status: "approved", criteria: { lectureVerified: true }
    })).status, 200);
    assert.equal((await trainee("/api/auth/me")).data.user.role, "Юрист");

    const assignment = await admin("/api/attestations", "POST", {
      userId: memberId,
      track: "Юрист",
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    assert.equal(assignment.status, 201);
    assert.equal((await trainee(`/api/exams/current?attestationId=${assignment.data.id}`)).status, 200);
    assert.equal((await trainee(`/api/exams/current?attestationId=${assignment.data.id + 1}`)).status, 404);
    assert.equal((await trainee("/api/laws/pk")).status, 200);
    assert.equal((await admin(`/api/members/${memberId}`, "PATCH", { role: "Адвокат" })).status, 200);

    const citizen = await createClient(baseUrl);
    const citizenRegistration = await citizen("/api/auth/register", "POST", {
      accountType: "citizen", username: "citizen", displayName: "Гражданин Тестовый",
      email: "citizen@example.com", password: "CitizenPassword!23", role: "ГКА"
    });
    assert.equal(citizenRegistration.status, 201);
    assert.equal(citizenRegistration.data.user.status, "active");
    assert.equal(citizenRegistration.data.user.role, "Гражданин");
    assert.equal((await citizen("/api/reprimands")).status, 403);
    assert.equal((await citizen("/api/applications", "POST", {
      type: "citizen_help", details: "Нужна консультация адвоката по делу, свяжитесь по электронной почте."
    })).status, 201);
    const citizenCase = (await trainee("/api/applications")).data.applications.find((item) => item.type === "citizen_help");
    assert.ok(citizenCase);
    assert.equal(citizenCase.contact_email, undefined);
    assert.equal((await trainee(`/api/applications/${citizenCase.id}/assign`, "PATCH", {})).status, 200);
    const acceptedCase = (await citizen("/api/applications")).data.applications.find((item) => item.id === citizenCase.id);
    assert.equal(acceptedCase.assigned_name, "Стажер");
    assert.equal(acceptedCase.assigned_to, memberId);
    assert.equal(acceptedCase.contact_email, undefined);
    assert.equal((await citizen(`/api/applications/${citizenCase.id}/close`, "PATCH", {})).status, 403);
    assert.equal((await admin(`/api/applications/${citizenCase.id}/close`, "PATCH", {})).status, 403);
    assert.equal((await trainee(`/api/applications/${citizenCase.id}/messages`, "POST", {
      message: "Здравствуйте, расскажите подробнее о ситуации."
    })).status, 201);
    assert.equal((await citizen(`/api/applications/${citizenCase.id}/contact`, "POST", {
      type: "contact"
    })).status, 409);
    db.prepare("UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?")
      .run("12345678901234567", "yyte", citizenRegistration.data.user.id);
    assert.equal((await citizen(`/api/applications/${citizenCase.id}/contact`, "POST", {
      type: "contact"
    })).status, 201);
    const messages = (await trainee(`/api/applications/${citizenCase.id}/messages`)).data.messages;
    assert.ok(messages.some((item) => item.message.includes("yyte@sa.com (Discord: yyte)")));
    assert.ok(messages.every((item) => !item.message.includes("citizen@example.com")));
    assert.equal((await admin(`/api/applications/${citizenCase.id}/messages`, "POST", {
      message: "Руководитель не назначен участником чата."
    })).status, 404);
    assert.equal((await trainee(`/api/applications/${citizenCase.id}/close`, "PATCH", {})).status, 200);
    assert.ok((await citizen("/api/applications")).data.applications.find((item) => item.id === citizenCase.id).completed_at);
    assert.equal((await citizen(`/api/applications/${citizenCase.id}/rating`, "POST", {
      rating: 5, comment: "Помог разобраться."
    })).status, 201);
    assert.equal((await citizen(`/api/applications/${citizenCase.id}/rating`, "POST", {
      rating: 4, comment: ""
    })).status, 409);
    assert.equal((await citizen("/api/exams/current")).status, 403);
    assert.equal((await citizen("/api/laws")).status, 403);
    assert.equal((await citizen("/api/documents")).status, 403);
    assert.equal((await citizen("/api/lawsuits")).status, 403);
    const employment = await citizen("/api/applications", "POST", {
      type: "employment",
      details: "Хочу вступить в Коллегию адвокатов.",
      discordUsername: "yyte",
      gtaName: "Alex Morgan",
      passportId: "54321"
    });
    assert.equal(employment.status, 201);
    assert.ok((await admin("/api/applications")).data.applications.some((item) =>
      item.id === employment.data.id && item.type === "employment"));
    assert.equal((await citizen(`/api/applications/${employment.data.id}/review`, "PATCH", {
      status: "approved"
    })).status, 403);
    assert.equal((await admin(`/api/applications/${employment.data.id}/review`, "PATCH", {
      status: "approved"
    })).status, 200);
    const employed = await citizen("/api/auth/me");
    assert.equal(employed.data.user.role, "Стажер КА");
    assert.equal(employed.data.user.status, "active");

    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const reprimand = await admin("/api/reprimands", "POST", {
      userId: memberId,
      reason: "Неявка на назначенный вызов без предупреждения.",
      photo: { name: "evidence.png", type: "image/png", data: png }
    });
    assert.equal(reprimand.status, 201);
    assert.equal((await trainee("/api/reprimands")).data.reprimands[0].reason,
      "Неявка на назначенный вызов без предупреждения.");
    assert.equal((await citizen("/api/reprimands")).data.reprimands.length, 0);
    assert.equal((await trainee.raw(`/api/reprimands/${reprimand.data.id}/photo`)).status, 200);
    assert.equal((await citizen(`/api/reprimands/${reprimand.data.id}/photo`)).status, 404);
    db.prepare("UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?")
      .run("45678901234567890", "lawyer", memberId);
    db.prepare("INSERT INTO notification_preferences (user_id,discord_dm_enabled) VALUES (?,1)")
      .run(memberId);
    const linkedReprimand = await admin("/api/reprimands", "POST", {
      userId: memberId,
      reason: "Нарушение порядка рассмотрения дела.",
      photo: { name: "second.png", type: "image/png", data: png }
    });
    assert.equal(linkedReprimand.status, 201);
    assert.equal(linkedReprimand.data.dmWarning, "");
    const dmUpload = discordRequests.find((request) => request.body instanceof FormData);
    assert.ok(dmUpload);
    const dmEmbed = JSON.parse(dmUpload.body.get("payload_json"));
    assert.equal(dmEmbed.embeds[0].image.url, "attachment://second.png");
    assert.match(dmUpload.url, /\/channels\/23456789012345678\/messages$/);
    const reprimandWebhook = webhookRequests.find((request) => request.body instanceof FormData &&
      JSON.parse(request.body.get("payload_json")).embeds[0].image?.url === "attachment://evidence.png");
    assert.ok(reprimandWebhook);
    const webhookEmbed = JSON.parse(reprimandWebhook.body.get("payload_json"));
    assert.equal(webhookEmbed.embeds[0].image.url, "attachment://evidence.png");
    assert.equal(webhookEmbed.embeds[0].thumbnail.url, "attachment://collegium-seal.png");
    assert.equal(reprimandWebhook.body.get("files[0]").name, "collegium-seal.png");
    assert.equal(reprimandWebhook.body.get("files[1]").type, "image/png");

    assert.equal((await admin(`/api/members/${memberId}`, "PATCH", { displayName: " " })).status, 400);
    const renamedMember = await admin(`/api/members/${memberId}`, "PATCH", {
      displayName: "Стажер НовоеИмя"
    });
    assert.equal(renamedMember.status, 200);
    assert.equal(renamedMember.data.user.displayName, "Стажер НовоеИмя");
    const renameWebhook = webhookRequests.find((request) => request.body instanceof FormData &&
      JSON.parse(request.body.get("payload_json")).embeds[0].description.includes("имя: Стажер → Стажер НовоеИмя"));
    assert.ok(renameWebhook);

    const savedDocument = await trainee("/api/documents", "POST", {
      template: "complaint", title: "Жалоба CP0001", bbcode: "[TABLE]Достаточно длинный текст BBCode заявления.[/TABLE]"
    });
    assert.equal(savedDocument.status, 201);
    assert.equal((await trainee(`/api/documents/${savedDocument.data.id}`)).data.document.title, "Жалоба CP0001");
    const otherSalt = randomBytes(16);
    const otherHash = scryptSync("AnotherPassword!23", otherSalt, 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    });
    db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
      .run("other", `scrypt$${otherSalt.toString("base64")}$${otherHash.toString("base64")}`, "Коллега", "Юрист", "active");
    const other = await createClient(baseUrl);
    assert.equal((await other("/api/auth/login", "POST", {
      username: "other", password: "AnotherPassword!23"
    })).status, 200);
    assert.equal((await other(`/api/documents/${savedDocument.data.id}`)).status, 404);
    assert.equal((await trainee("/api/sequences/next", "POST", { type: "complaint" })).data.number, "CP0001");
    assert.equal((await trainee("/api/sequences/next", "POST", { type: "rehabilitation" })).data.number, "001");
    const sealResponse = await trainee.raw("/assets/collegium-seal.png");
    assert.equal(sealResponse.status, 200);
    assert.equal(sealResponse.contentType, "image/png");
    const mainSealResponse = await trainee.raw("/assets/collegium-main-seal.png");
    assert.equal(mainSealResponse.status, 200);
    assert.equal(mainSealResponse.contentType, "image/png");
    assert.ok(mainSealResponse.bytes.length > 100_000);
  } finally {
    db.close();
  }
});

test("self-service promotion requires study, test and interview readiness after trainee stage", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("CareerFlowPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("career-head", passwordHash, "Глава", "ГКА", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("career-trainee", passwordHash, "Стажёр", "Стажер КА", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("career-lawyer", passwordHash, "Юрист", "Юрист", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const head = await createClient(baseUrl);
  const trainee = await createClient(baseUrl);
  const lawyer = await createClient(baseUrl);

  try {
    for (const [client, username] of [
      [head, "career-head"], [trainee, "career-trainee"], [lawyer, "career-lawyer"]
    ]) {
      assert.equal((await client("/api/auth/login", "POST", {
        username, password: "CareerFlowPassword!23"
      })).status, 200);
    }

    const traineeStart = await trainee("/api/exams/start", "POST", { studyConfirmed: true });
    assert.equal(traineeStart.status, 201);
    assert.equal((await trainee("/api/exams/current")).data.questions.length, 5);
    const traineeResult = await trainee("/api/exams", "POST", { answers: [1, 1, 1, 1, 1] });
    assert.equal(traineeResult.data.passed, true);
    assert.equal(traineeResult.data.interviewRequired, true);
    assert.equal((await trainee("/api/auth/me")).data.user.role, "Стажер КА");

    assert.equal((await head("/api/promotion-requirements", "PATCH", {
      lawyerCallsRequired: 2
    })).status, 200);
    const lawyerStart = await lawyer("/api/exams/start", "POST", { studyConfirmed: true });
    assert.equal(lawyerStart.status, 201);
    const interviewRoute = `/api/applications/${lawyerStart.data.applicationId}/interview`;
    assert.equal((await lawyer(interviewRoute, "PATCH", { status: "ready" })).status, 409);
    const lawyerResult = await lawyer("/api/exams", "POST", { answers: [1, 0, 0, 1, 0] });
    assert.equal(lawyerResult.data.passed, true);
    assert.equal(lawyerResult.data.interviewRequired, true);
    assert.equal((await lawyer("/api/auth/me")).data.user.role, "Юрист");
    assert.equal((await lawyer(`/api/applications/${lawyerStart.data.applicationId}/promotion-data`, "PATCH", {
      completedCalls: 2, trialLawsuitReference: "Пробный иск № 12"
    })).status, 200);
    assert.equal((await lawyer(interviewRoute, "PATCH", { status: "ready" })).status, 200);
    assert.equal((await head(`/api/applications/${lawyerStart.data.applicationId}/review`, "PATCH", {
      status: "approved",
      criteria: { callsVerified: true, trialLawsuitVerified: true, interviewPassed: true }
    })).status, 200);
    assert.equal((await lawyer("/api/auth/me")).data.user.role, "Адвокат");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("AK UK PK seals create staged promotion requests and reset after decisions", async () => {
  const examPayloads = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    webhookExams: "https://discord.com/api/webhooks/123456789012345678/test-token",
    webhookLawyerTest: "https://discord.com/api/webhooks/123456789012345678/test-token",
    webhookFetch: async (_url, options) => {
      const body = options.body;
      examPayloads.push(body instanceof FormData
        ? JSON.parse(body.get("payload_json"))
        : JSON.parse(body));
      return new Response(null, { status: 204 });
    }
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("CareerLawBundlePassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("bundle-head", passwordHash, "Глава", "ГКА", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("bundle-trainee", passwordHash, "Стажёр", "Стажер КА", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const head = await createClient(baseUrl);
  const candidate = await createClient(baseUrl);

  try {
    for (const [client, username] of [[head, "bundle-head"], [candidate, "bundle-trainee"]]) {
      assert.equal((await client("/api/auth/login", "POST", {
        username, password: "CareerLawBundlePassword!23"
      })).status, 200);
    }
    assert.deepEqual((await candidate("/api/exams/law-progress")).data.passedSubjects, []);
    const wrongAttempt = await candidate("/api/exams", "POST", {
      subject: "ak", answers: [0, 0, 0, 0, 0]
    });
    assert.equal(wrongAttempt.data.passed, false);
    const wrongAnswersEmbed = examPayloads.find((payload) =>
      payload.embeds[0].title === "Результат проверки знаний: 2/5").embeds[0];
    assert.equal(wrongAnswersEmbed.fields.filter((field) => field.name.startsWith("Вопрос ")).length, 3);
    assert.deepEqual((await candidate("/api/exams/law-progress")).data.passedSubjects, []);

    const completeTests = async () => {
      for (const [subject, answers] of [
        ["ak", [1, 0, 1, 0, 1]],
        ["uk", [1, 2, 0, 0, 1]],
        ["pk", [1, 0, 0, 1, 0]]
      ]) {
        const current = await candidate(`/api/exams/current?subject=${subject}`);
        assert.equal(current.status, 200);
        const result = await candidate("/api/exams", "POST", { subject, answers });
        assert.equal(result.data.passed, true);
      }
    };

    await completeTests();
    assert.equal((await candidate("/api/exams/law-progress")).data.passedSubjects.length, 3);
    const firstRequest = (await candidate("/api/applications")).data.applications
      .find((item) => Array.isArray(item.promotion_data?.lawTests));
    assert.ok(firstRequest);
    assert.equal(firstRequest.requested_role, "Юрист");
    assert.equal((await candidate(`/api/exams/current?subject=ak`)).status, 409);
    assert.equal((await head(`/api/applications/${firstRequest.id}/review`, "PATCH", {
      status: "rejected", note: "Нужно исправить отчёт.", criteria: {}
    })).status, 200);
    assert.deepEqual((await candidate("/api/exams/law-progress")).data.passedSubjects, []);

    await completeTests();
    const traineeRequest = (await candidate("/api/applications")).data.applications
      .find((item) => Array.isArray(item.promotion_data?.lawTests) && item.status === "pending");
    assert.ok(traineeRequest);
    assert.equal((await head(`/api/applications/${traineeRequest.id}/review`, "PATCH", {
      status: "approved", criteria: { headApproved: true }
    })).status, 200);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Юрист");
    assert.deepEqual((await candidate("/api/exams/law-progress")).data.passedSubjects, []);

    assert.equal((await head("/api/promotion-requirements", "PATCH", {
      lawyerCallsRequired: 2
    })).status, 200);
    await completeTests();
    const lawyerRequest = (await candidate("/api/applications")).data.applications
      .find((item) => Array.isArray(item.promotion_data?.lawTests) && item.status === "pending");
    assert.ok(lawyerRequest);
    assert.equal(lawyerRequest.requested_role, "Адвокат");
    assert.equal((await candidate(`/api/applications/${lawyerRequest.id}/interview`, "PATCH", {
      status: "ready"
    })).status, 409);
    assert.equal((await candidate(`/api/applications/${lawyerRequest.id}/promotion-data`, "PATCH", {
      completedCalls: 2, trialLawsuitReference: "Пробный иск № 12"
    })).status, 200);
    assert.equal((await candidate(`/api/applications/${lawyerRequest.id}/interview`, "PATCH", {
      status: "ready"
    })).status, 200);
    assert.equal((await head(`/api/applications/${lawyerRequest.id}/review`, "PATCH", {
      status: "approved",
      criteria: { callsVerified: true, trialLawsuitVerified: true, interviewPassed: true }
    })).status, 200);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Адвокат");
    assert.deepEqual((await candidate("/api/exams/law-progress")).data.passedSubjects, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("promotion stages enforce attendance, call counts, exam review and GKA approval", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("PromotionStagesPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("stage-head", passwordHash, "Глава", "ГКА", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("stage-deputy", passwordHash, "Заместитель", "ЗГКА", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("candidate", passwordHash, "Кандидат", "Стажер КА", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("outsider", passwordHash, "Посторонний", "Юрист", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const head = await createClient(baseUrl);
  const deputy = await createClient(baseUrl);
  const candidate = await createClient(baseUrl);
  const outsider = await createClient(baseUrl);

  try {
    for (const [client, username] of [
      [head, "stage-head"], [deputy, "stage-deputy"], [candidate, "candidate"], [outsider, "outsider"]
    ]) {
      assert.equal((await client("/api/auth/login", "POST", {
        username, password: "PromotionStagesPassword!23"
      })).status, 200);
    }
    assert.equal((await candidate("/api/promotion-requirements", "PATCH", { lawyerCallsRequired: 2 })).status, 403);
    assert.equal((await deputy("/api/promotion-requirements", "PATCH", { lawyerCallsRequired: 2 })).status, 200);

    const traineeRequest = await candidate("/api/applications", "POST", {
      type: "exam", details: "Прослушал лекцию и прошу назначить проверку знаний.",
      promotionData: { lectureAttended: true }
    });
    assert.equal(traineeRequest.status, 201);
    assert.equal((await candidate("/api/exams", "POST", { answers: [1, 1, 1, 1, 1] })).data.passed, true);
    assert.equal((await head(`/api/applications/${traineeRequest.data.id}/review`, "PATCH", {
      status: "approved"
    })).status, 400);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Стажер КА");
    assert.equal((await head(`/api/applications/${traineeRequest.data.id}/review`, "PATCH", {
      status: "approved", criteria: { lectureVerified: true }
    })).status, 200);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Юрист");

    const underCount = await candidate("/api/applications", "POST", {
      type: "exam", details: "Прошу допустить к экзамену.",
      promotionData: { completedCalls: 1, trialLawsuitReference: "Иск 12" }
    });
    assert.equal(underCount.status, 400);
    const lawyerExam = await candidate("/api/applications", "POST", {
      type: "exam", details: "Отработал вызовы и подготовил пробный иск.",
      promotionData: { completedCalls: 2, trialLawsuitReference: "Иск 12" }
    });
    assert.equal(lawyerExam.status, 201);
    assert.equal((await candidate("/api/exams", "POST", { answers: [1, 0, 0, 1, 0] })).data.passed, true);
    assert.equal((await head(`/api/applications/${lawyerExam.data.id}/review`, "PATCH", {
      status: "approved", criteria: { callsVerified: true }
    })).status, 400);
    assert.equal((await head(`/api/applications/${lawyerExam.data.id}/review`, "PATCH", {
      status: "approved", criteria: { callsVerified: true, trialLawsuitVerified: true }
    })).status, 200);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Адвокат");

    const attorneyExam = await candidate("/api/applications", "POST", {
      type: "exam", details: "Прошу проверить знание законодательства."
    });
    assert.equal(attorneyExam.status, 201);
    assert.equal((await candidate("/api/exams", "POST", { answers: [1, 0, 1, 1, 0] })).data.passed, true);
    assert.equal((await head(`/api/applications/${attorneyExam.data.id}/review`, "PATCH", {
      status: "approved"
    })).status, 200);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Адвокат");

    const invalidAttachment = await candidate("/api/applications", "POST", {
      type: "promotion", details: "Проверка отклонения файла с неверной сигнатурой.",
      promotionData: { completedCalls: 25, callsWithLawyer: 5, acceptedLawsuitReference: "Иск принят № 7" },
      attachments: [{ name: "fake.png", type: "image/png", data: "JVBERi0=" }]
    });
    assert.equal(invalidAttachment.status, 400);
    const promotion = await candidate("/api/applications", "POST", {
      type: "promotion", details: "Отчёт на повышение до старшего адвоката.",
      promotionData: { completedCalls: 25, callsWithLawyer: 5, acceptedLawsuitReference: "Иск принят № 7" },
      attachments: [{ name: "proof.png", type: "image/png", data: "iVBORw0KGgo=" }]
    });
    assert.equal(promotion.status, 201);
    const criteria = {
      callsVerified: true,
      juniorCallsVerified: true,
      acceptedLawsuitVerified: true,
      interviewPassed: true,
      vacancyAvailable: true,
      headApproved: true
    };
    assert.equal((await deputy(`/api/applications/${promotion.data.id}/review`, "PATCH", {
      status: "approved", criteria
    })).status, 403);
    assert.equal((await head(`/api/applications/${promotion.data.id}/review`, "PATCH", {
      status: "approved", criteria: { callsVerified: true }
    })).status, 400);
    assert.equal((await head(`/api/applications/${promotion.data.id}/review`, "PATCH", {
      status: "approved", criteria
    })).status, 200);
    assert.equal((await candidate("/api/auth/me")).data.user.role, "Ст.Адвокат");
    const savedPromotion = (await candidate("/api/applications")).data.applications
      .find((item) => item.id === promotion.data.id);
    const attachmentPath = `/api/applications/${promotion.data.id}/attachments/${savedPromotion.attachments[0].id}`;
    assert.equal((await fetch(new URL(attachmentPath, baseUrl), {
      headers: { cookie: outsider.cookie() }
    })).status, 404);
    assert.equal((await fetch(new URL(attachmentPath, baseUrl), {
      headers: { cookie: head.cookie() }
    })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("staff role capability matrix and invite permissions", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("RoleMatrixPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const matrix = [
    ["Стажер КА", "training", null, "practice"],
    ["Юрист", "practice", "promotion"],
    ["Адвокат", "practice", "admin", "exam"],
    ["Ст.Адвокат", null, "promotion"],
    ["ЗГКА", null, "admin"],
    ["ГКА", null, "admin"]
  ];
  for (let index = 0; index < matrix.length; index += 1) {
    db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
      .run(`role${index}`, passwordHash, `Роль ${index}`, matrix[index][0], "active");
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (let index = 0; index < matrix.length; index += 1) {
      const [role, allowedType, forbiddenType, extraAllowedType] = matrix[index];
      const account = await createClient(baseUrl);
      assert.equal((await account("/api/auth/login", "POST", {
        username: `role${index}`, password: "RoleMatrixPassword!23"
      })).status, 200);
      if (allowedType) {
        assert.equal((await account("/api/applications", "POST", {
          type: allowedType, details: "Проверка допустимого действия для роли."
        })).status, 201, `${role} should be able to submit ${allowedType}`);
      }
      if (forbiddenType) {
        assert.equal((await account("/api/applications", "POST", {
          type: forbiddenType, details: "Проверка недоступного действия."
        })).status, 403, `${role} should not be able to submit ${forbiddenType}`);
      }
      if (extraAllowedType) {
        assert.equal((await account("/api/applications", "POST", {
          type: extraAllowedType, details: "Проверка экзамена для текущей ступени."
        })).status, 201, `${role} should be able to submit ${extraAllowedType}`);
      }
      assert.equal((await account("/api/invites", "POST", {})).status, role === "ГКА" ? 201 : 403);
      assert.equal((await account("/api/members")).status, ["ГКА", "ЗГКА"].includes(role) ? 200 : 403);
    }
    const gka = await createClient(baseUrl);
    assert.equal((await gka("/api/auth/login", "POST", {
      username: "role5", password: "RoleMatrixPassword!23"
    })).status, 200);
    assert.equal((await gka("/api/promotion-requirements", "PATCH", { lawyerCallsRequired: 7 })).status, 200);
    assert.equal((await gka("/api/promotion-requirements")).data.lawyerCallsRequired, 7);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("one-time password recovery and court case lifecycle", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const key = scryptSync("InitialPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("head", passwordHash, "Глава", "ГКА", "active");
  const memberId = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("member", passwordHash, "Участник", "Адвокат", "active").lastInsertRowid);
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("citizen", passwordHash, "Истец", "Гражданин", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = await createClient(baseUrl);
  const member = await createClient(baseUrl);
  const citizen = await createClient(baseUrl);

  try {
    assert.equal((await admin("/api/auth/login", "POST", {
      username: "head", password: "InitialPassword!23"
    })).status, 200);
    assert.equal((await citizen("/api/auth/login", "POST", {
      username: "citizen", password: "InitialPassword!23"
    })).status, 200);
    assert.equal((await member("/api/auth/login", "POST", {
      username: "member", password: "InitialPassword!23"
    })).status, 200);
    const reset = await admin(`/api/members/${memberId}/reset-password`, "POST", {});
    assert.equal(reset.status, 201);
    assert.ok(reset.data.code);

    const recovery = await createClient(baseUrl);
    assert.equal((await recovery("/api/auth/reset-password", "POST", {
      username: "member", code: reset.data.code, password: "UpdatedPassword!23"
    })).status, 200);
    assert.equal((await recovery("/api/auth/reset-password", "POST", {
      username: "member", code: reset.data.code, password: "AnotherPassword!23"
    })).status, 400);
    const oldLogin = await createClient(baseUrl);
    assert.equal((await oldLogin("/api/auth/login", "POST", {
      username: "member", password: "InitialPassword!23"
    })).status, 401);
    const newLogin = await createClient(baseUrl);
    assert.equal((await newLogin("/api/auth/login", "POST", {
      username: "member", password: "UpdatedPassword!23"
    })).status, 200);

    const submitted = await newLogin("/api/lawsuits", "POST", {
      template: "lawsuit-supreme",
      title: "Исковое заявление · тестовое дело",
      bbcode: "[TABLE]Полный текст заявления и материалы для суда.[/TABLE]"
    });
    assert.equal(submitted.status, 201);
    assert.equal((await newLogin("/api/documents")).data.myCount, 0);
    assert.equal((await citizen("/api/documents")).status, 403);
    const charter = await citizen("/api/laws/charter");
    assert.equal(charter.status, 403);
    assert.equal((await citizen("/api/lawsuits")).status, 403);
    const forumLink = await newLogin(`/api/documents/${submitted.data.documentId}/forum`, "POST", {
      forumUrl: "https://forum.example.test/topic/123"
    });
    assert.equal(forumLink.status, 200);
    assert.equal((await newLogin("/api/documents")).data.documents[0].forum_status, "pending");
    assert.equal((await admin(`/api/documents/${submitted.data.documentId}/forum`, "PATCH", {
      status: "approved"
    })).status, 200);
    const memberDocuments = await newLogin("/api/documents");
    const managerDocuments = await admin("/api/documents");
    assert.equal(memberDocuments.data.myCount, 1);
    assert.equal(memberDocuments.data.approvedCount, 1);
    assert.equal(managerDocuments.data.approvedCount, 1);
    assert.equal((await newLogin("/api/lawsuits")).data.lawsuits[0].status, "submitted");
    assert.equal((await admin(`/api/lawsuits/${submitted.data.id}`, "PATCH", {
      status: "decided", decision: ""
    })).status, 400);
    assert.equal((await admin(`/api/lawsuits/${submitted.data.id}`, "PATCH", {
      status: "decided", decision: "Иск удовлетворен."
    })).status, 409);
    assert.equal((await admin(`/api/lawsuits/${submitted.data.id}`, "PATCH", {
      status: "in_review", decision: "Материалы приняты к рассмотрению."
    })).status, 200);
    assert.equal((await admin(`/api/lawsuits/${submitted.data.id}`, "PATCH", {
      status: "hearing", decision: "Слушание назначено."
    })).status, 200);
    assert.equal((await admin(`/api/lawsuits/${submitted.data.id}`, "PATCH", {
      status: "decided", decision: "Иск удовлетворен."
    })).status, 200);
    assert.equal((await newLogin("/api/lawsuits")).data.lawsuits[0].status, "decided");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("Discord is optional for staff portal access and remains available to link", async () => {
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    discordClientId: "test-client",
    discordClientSecret: "test-secret",
    discordRedirectUri: "http://127.0.0.1:3000/api/discord/callback"
  });
  const db = server.portalDb;
  const password = "DiscordRequirementPassword!23";
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,'active')"
  ).run(username, passwordHash, username, role).lastInsertRowid);
  const staffId = addUser("unlinked-staff", "ГКА");
  addUser("unlinked-citizen", "Гражданин");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const staff = await createClient(baseUrl);
  const citizen = await createClient(baseUrl);

  try {
    assert.equal((await staff("/api/auth/login", "POST", {
      username: "unlinked-staff", password
    })).status, 200);
    assert.equal((await citizen("/api/auth/login", "POST", {
      username: "unlinked-citizen", password
    })).status, 200);

    const status = await staff("/api/discord/status");
    assert.equal(status.status, 200);
    assert.equal(status.data.linkRequired, false);
    assert.equal(status.data.linked, false);
    assert.equal((await staff("/api/profile")).status, 200);
    assert.equal((await staff("/api/applications")).status, 200);
    assert.equal((await staff("/api/rp-practice/completions")).status, 200);
    const link = await staff("/api/discord/link", "POST", {});
    assert.equal(link.status, 200);
    assert.ok(new URL(link.data.authorizeUrl).searchParams.get("state"));
    assert.equal((await staff("/api/auth/logout", "POST", {})).status, 200);
    assert.equal((await staff("/api/auth/me")).data.user, null);
    assert.equal((await staff("/api/auth/login", "POST", {
      username: "unlinked-staff", password
    })).status, 200);

    assert.equal((await citizen("/api/profile")).status, 200);
    assert.equal((await citizen("/api/discord/status")).data.linkRequired, false);
    assert.equal((await staff("/api/profile")).status, 200);

    db.prepare("UPDATE users SET discord_id = ?, discord_username = ? WHERE id = ?")
      .run("123456789012345678", "linked-staff", staffId);
    assert.equal((await staff("/api/profile")).status, 200);
    assert.equal((await staff("/api/discord/status")).data.linkRequired, false);
    assert.equal((await staff("/api/discord/status")).data.linked, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("Discord avatar is saved when an account is linked", async () => {
  const welcomeEmbeds = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    discordClientId: "test-client",
    discordClientSecret: "test-secret",
    discordRedirectUri: "http://127.0.0.1:3000/api/discord/callback",
    discordBotToken: "mock-bot-token",
    discordFetch: async (url, options = {}) => {
      if (url.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "mock-access-token" }), { status: 200 });
      }
      if (url.endsWith("/users/@me")) {
        return new Response(JSON.stringify({
          id: "123456789012345678", username: "test-discord", avatar: "avatar-hash"
        }), { status: 200 });
      }
      if (url.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify({ id: "mock-dm-channel" }), { status: 200 });
      }
      if (url.endsWith("/channels/mock-dm-channel/messages")) {
        welcomeEmbeds.push(...JSON.parse(options.body).embeds);
        return new Response(JSON.stringify({ id: "mock-dm-message" }), { status: 200 });
      }
      throw new Error("Unexpected Discord API request.");
    }
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("AvatarTestPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("avataruser", `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`, "Профиль", "ГКА", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const account = await createClient(baseUrl);

  try {
    assert.equal((await account("/api/auth/login", "POST", {
      username: "avataruser", password: "AvatarTestPassword!23"
    })).status, 200);
    const link = await account("/api/discord/link", "POST", {});
    assert.equal(link.status, 200);
    assert.equal(new URL(link.data.authorizeUrl).searchParams.get("redirect_uri"),
      "http://127.0.0.1:3000/api/discord/callback");
    const state = new URL(link.data.authorizeUrl).searchParams.get("state");
    const callback = await fetch(new URL(`/api/discord/callback?state=${state}&code=mock-code`, baseUrl), {
      headers: { cookie: account.cookie() },
      redirect: "manual"
    });
    assert.equal(callback.status, 303);
    const profile = await account("/api/auth/me");
    assert.equal(profile.data.user.discordAvatarUrl,
      "https://cdn.discordapp.com/avatars/123456789012345678/avatar-hash.png?size=128");
    assert.equal(welcomeEmbeds.length, 1);
    assert.equal(welcomeEmbeds[0].title, "Добро пожаловать в Коллегию!");
    assert.match(welcomeEmbeds[0].description, /Привет, Профиль!/);
    assert.equal(welcomeEmbeds[0].thumbnail.url, profile.data.user.discordAvatarUrl);
    assert.equal((await account("/api/profile")).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("desktop server uses its configured public URL for Discord OAuth", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portal-desktop-oauth-"));
  const portal = await startPortal({
    dbPath: path.join(directory, "portal.sqlite"),
    host: "127.0.0.1",
    port: 0,
    startBot: false,
    cookieSecure: false,
    discordClientId: "desktop-client",
    discordClientSecret: "desktop-secret",
    discordRedirectUri: "https://portal.example.test/api/discord/callback"
  });
  const salt = randomBytes(16);
  const hash = scryptSync("DesktopOAuthPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  portal.server.portalDb.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("desktop-oauth", `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`, "Глава", "ГКА", "active");
  const baseUrl = `http://127.0.0.1:${portal.port}`;
  const account = await createClient(baseUrl);
  try {
    assert.equal((await account("/api/auth/login", "POST", {
      username: "desktop-oauth", password: "DesktopOAuthPassword!23"
    })).status, 200);
    const link = await account("/api/discord/link", "POST", {});
    assert.equal(link.status, 200);
    assert.equal(new URL(link.data.authorizeUrl).searchParams.get("redirect_uri"),
      "https://portal.example.test/api/discord/callback");
  } finally {
    await portal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("staff tasks and calendar enforce roles, persist workflow, and protect attachments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portal-workspace-"));
  const dbPath = path.join(directory, "portal.sqlite");
  let server = createPortalServer({ dbPath, cookieSecure: false });
  let db = server.portalDb;
  const password = "WorkspaceTestPassword!23";
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)"
  ).run(username, passwordHash, displayName, role, "active").lastInsertRowid);
  const managerId = addUser("workspace-gka", "Руководитель", "ГКА");
  const assigneeId = addUser("workspace-lawyer", "Исполнитель", "Адвокат");
  const otherStaffId = addUser("workspace-peer", "Коллега", "Юрист");
  addUser("workspace-citizen", "Гражданин", "Гражданин");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const manager = await createClient(baseUrl);
  const assignee = await createClient(baseUrl);
  const peer = await createClient(baseUrl);
  const citizen = await createClient(baseUrl);
  const closeServer = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  };

  try {
    for (const [client, username] of [
      [manager, "workspace-gka"], [assignee, "workspace-lawyer"],
      [peer, "workspace-peer"], [citizen, "workspace-citizen"]
    ]) {
      assert.equal((await client("/api/auth/login", "POST", { username, password })).status, 200);
    }

    assert.equal((await citizen("/api/tasks")).status, 403);
    assert.equal((await citizen("/api/calendar")).status, 403);
    assert.equal((await assignee("/api/tasks", "POST", {})).status, 403);
    assert.equal((await manager("/api/tasks", "POST", null)).status, 400);

    const pdf = Buffer.from("%PDF-1.4\nworkspace attachment\n");
    const created = await manager("/api/tasks", "POST", {
      title: "Подготовить правовое заключение",
      description: "Изучить материалы дела и подготовить письменное заключение.",
      priority: "high",
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      assigneeIds: [assigneeId],
      attachments: [{ name: "materials.pdf", type: "application/pdf", data: pdf.toString("base64") }]
    });
    assert.equal(created.status, 201);
    const taskId = created.data.task.id;
    assert.equal(created.data.task.assignees[0].id, assigneeId);
    assert.equal(created.data.task.attachments.length, 1);
    assert.equal((await peer("/api/tasks")).data.tasks.length, 0);
    assert.equal((await assignee("/api/tasks")).data.tasks.length, 1);
    assert.equal((await peer(`/api/tasks/${taskId}`)).status, 404);
    assert.equal((await peer(`/api/tasks/${taskId}`, "PATCH", { status: "accepted" })).status, 404);
    assert.equal((await peer.raw(`/api/tasks/${taskId}/attachments/${created.data.task.attachments[0].id}`)).status, 404);
    assert.equal((await manager("/api/tasks", "POST", {
      title: "Назначение гражданину", description: "Это не должно быть доступно.",
      assigneeIds: [Number(db.prepare("SELECT id FROM users WHERE username = 'workspace-citizen'").get().id)]
    })).status, 400);
    const attachment = await manager.raw(`/api/tasks/${taskId}/attachments/${created.data.task.attachments[0].id}`);
    assert.equal(attachment.status, 200);
    assert.deepEqual(attachment.bytes, pdf);

    assert.equal((await assignee(`/api/tasks/${taskId}`, "PATCH", { status: "accepted" })).status, 200);
    assert.equal((await assignee(`/api/tasks/${taskId}`, "PATCH", { status: "in_progress" })).status, 200);
    assert.equal((await assignee(`/api/tasks/${taskId}`, "PATCH", {
      status: "review", comment: "Заключение готово к проверке."
    })).status, 200);
    assert.equal((await manager(`/api/tasks/${taskId}`, "PATCH", { status: "completed" })).status, 400);
    assert.equal((await manager(`/api/tasks/${taskId}`, "PATCH", {
      status: "revision", comment: "Уточните применимые нормы."
    })).status, 200);
    assert.equal((await assignee(`/api/tasks/${taskId}`, "PATCH", { status: "in_progress" })).status, 200);
    assert.equal((await assignee(`/api/tasks/${taskId}`, "PATCH", { status: "review" })).status, 200);
    assert.equal((await manager(`/api/tasks/${taskId}`, "PATCH", {
      status: "completed", comment: "Заключение принято."
    })).data.task.status, "completed");
    const taskDetails = await assignee(`/api/tasks/${taskId}`);
    assert.ok(taskDetails.data.history.some((item) => item.action === "status" && item.to_status === "completed"));

    const event = await manager("/api/calendar", "POST", {
      eventType: "court",
      title: "Слушание по иску",
      description: "Федеральный суд · зал 2",
      startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      responsibleId: assigneeId,
      participantIds: [assigneeId],
      isAllStaff: false
    });
    assert.equal(event.status, 201);
    assert.equal((await assignee("/api/calendar")).data.events.length, 1);
    assert.equal((await peer("/api/calendar")).data.events.length, 0);
    assert.equal((await assignee(`/api/calendar/${event.data.event.id}`, "PATCH", { status: "cancelled" })).status, 403);
    assert.equal((await manager("/api/calendar", "POST", {
      eventType: "court", title: "Неверный тип", startsAt: new Date().toISOString(),
      responsibleId: assigneeId, isAllStaff: "true"
    })).status, 400);
    assert.equal((await manager(`/api/calendar/${event.data.event.id}`, "PATCH", { status: "completed" })).data.event.status, "completed");

    await closeServer();
    server = createPortalServer({ dbPath, cookieSecure: false });
    db = server.portalDb;
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId).status, "completed");
    assert.equal(db.prepare("SELECT status FROM calendar_events WHERE id = ?").get(event.data.event.id).status, "completed");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = ?").get(taskId).count, 1);
    db.close();
  } finally {
    if (server.listening) await closeServer();
    await rm(directory, { recursive: true, force: true });
  }
});

test("all generated forum document templates have valid balanced BBCode", async () => {
  const source = await readFile(new URL("./web/js/app.js", import.meta.url), "utf8");
  const start = source.indexOf("function lawsuitFieldValue(key)");
  const end = source.indexOf("function renderAppeals(applications)", start);
  assert.ok(start >= 0 && end > start, "document generator source should be present");
  const generatorSource = source.slice(start, end);
  const templates = [
    "lawsuit-supreme", "lawsuit-federal", "motion-supreme", "motion-federal",
    "rehabilitation", "appeal", "cassation", "constitutional"
  ];
  const allowedTags = new Set([
    "B", "CENTER", "COLOR", "FONT", "IMG", "JUSTIFY", "LIST", "RIGHT",
    "SIZE", "TABLE", "TD", "TR", "*"
  ]);
  const generate = new Function("$", `${generatorSource}; return buildLawsuitBbcode();`);

  for (const template of templates) {
    const values = new Proxy({}, { get: (_target, key) => `Значение ${String(key)}` });
    const select = (selector) => selector === "#lawsuit-template"
      ? { value: template }
      : { value: values[selector.match(/data-lawsuit-field="([^"]+)"/)?.[1]] || "Значение теста" };
    const bbcode = generate(select);
    const stack = [];

    for (const match of bbcode.matchAll(/\[(\/)?([A-Za-z*]+)(?:\s+[^\]]*|=[^\]]*)?\]/g)) {
      const closing = Boolean(match[1]);
      const tag = match[2].toUpperCase();
      assert.ok(allowedTags.has(tag), `${template} emitted unsupported BBCode tag [${tag}]`);
      if (tag === "*") continue;
      if (closing) {
        assert.equal(stack.pop(), tag, `${template} has a mismatched [/${tag}]`);
      } else {
        stack.push(tag);
      }
    }
    assert.deepEqual(stack, [], `${template} has unclosed BBCode tags`);
  }
});

test("calendar reminders are sent privately once and persisted", async () => {
  const requests = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    discordBotToken: "test-bot-token",
    discordFetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify({ id: "23456789012345678" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "34567890123456789" }), { status: 200 });
    }
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const passwordHash = scryptSync("CalendarReminderPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const memberId = Number(db.prepare(`INSERT INTO users
    (username,password_hash,display_name,role,status,discord_id)
    VALUES (?,?,?,'Адвокат','active','12345678901234567')`)
    .run("calendar-reminder-lawyer",
      `scrypt$${salt.toString("base64")}$${passwordHash.toString("base64")}`,
      "Адвокат").lastInsertRowid);
  const now = Date.now();
  const event = db.prepare(`INSERT INTO calendar_events
    (event_type,title,starts_at,responsible_id,created_by)
    VALUES ('court','Заседание через полчаса',?,?,?)`)
    .run(new Date(now + 30 * 60 * 1000).toISOString(), memberId, memberId);

  try {
    assert.deepEqual(await server.sendDueCalendarReminders(now), { sent: 1, configured: true });
    assert.equal(requests.length, 2);
    assert.match(JSON.parse(requests[1].options.body).content, /Заседание через полчаса/);
    assert.equal(db.prepare(`SELECT sent_at FROM calendar_reminder_deliveries
      WHERE event_id = ? AND user_id = ? AND lead_minutes = 60`)
      .get(Number(event.lastInsertRowid), memberId).sent_at !== null, true);
    assert.deepEqual(await server.sendDueCalendarReminders(now), { sent: 0, configured: true });
    assert.equal(requests.length, 2);
  } finally {
    db.close();
  }
});

test("Discord permission failures explain how to fix role synchronization", async () => {
  const discordMethods = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    discordBotToken: "mock-bot-token",
    discordGuildId: "123456789012345678",
    discordRoleIds: { "Ст.Адвокат": "234567890123456789" },
    discordFetch: async (_url, options) => {
      discordMethods.push(options.method);
      return options.method === "GET"
        ? new Response(JSON.stringify({ roles: [] }), { status: 200 })
        : new Response(JSON.stringify({ code: 50013, message: "Missing Permissions" }), { status: 403 });
    }
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("DiscordPermissionTest!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("admin", passwordHash, "Глава", "ГКА", "active");
  const memberId = Number(db.prepare(`INSERT INTO users
    (username,password_hash,display_name,role,status,discord_id,discord_username)
    VALUES (?,?,?,?,?,?,?)`).run("linked", passwordHash, "Участник", "Юрист", "active",
      "345678901234567890", "linked-user").lastInsertRowid);
  db.prepare("INSERT INTO notification_preferences (user_id,discord_dm_enabled) VALUES (?,0)").run(memberId);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = await createClient(baseUrl);

  try {
    assert.equal((await admin("/api/auth/login", "POST", {
      username: "admin", password: "DiscordPermissionTest!23"
    })).status, 200);
    const result = await admin(`/api/members/${memberId}`, "PATCH", { role: "Ст.Адвокат" });
    assert.equal(result.status, 200);
    assert.match(result.data.discordWarning, /Missing Permissions/);
    assert.match(result.data.discordWarning, /выдать роль/);
    assert.doesNotMatch(result.data.discordWarning, /изменить ник/);
    assert.match(result.data.nicknameWarning, /Missing Permissions/);
    assert.match(result.data.nicknameWarning, /Управлять ролями\/никнеймами/);
    assert.match(result.data.nicknameWarning, /изменить ник/);
    assert.deepEqual(discordMethods, ["GET", "PATCH", "PUT"]);
    const linked = await createClient(baseUrl);
    assert.equal((await linked("/api/auth/login", "POST", {
      username: "linked", password: "DiscordPermissionTest!23"
    })).status, 200);
    const retry = await linked("/api/discord/sync", "POST", {});
    assert.equal(retry.status, 200);
    assert.equal(retry.data.ok, false);
    assert.match(retry.data.syncError, /выдать роль/);
    assert.match(retry.data.nicknameWarning, /изменить ник/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("manual Discord sync clears an old permission warning after a successful sync", async () => {
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    discordBotToken: "mock-bot-token",
    discordGuildId: "123456789012345678",
    discordRoleIds: { "Юрист": "234567890123456789" },
    discordFetch: async (url, options) => options.method === "GET"
      ? new Response(JSON.stringify({ roles: ["234567890123456789"] }), { status: 200 })
      : new Response(null, { status: 204 })
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("ManualSyncPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  db.prepare(`INSERT INTO users (username,password_hash,display_name,role,status,discord_id,discord_username,discord_sync_error)
    VALUES (?,?,?,?,?,?,?,?)`).run("linked", passwordHash, "Юрист", "Юрист", "active",
    "345678901234567890", "linked-user", "Old permission error");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const linked = await createClient(baseUrl);

  try {
    assert.equal((await linked("/api/auth/login", "POST", {
      username: "linked", password: "ManualSyncPassword!23"
    })).status, 200);
    const result = await linked("/api/discord/sync", "POST", {});
    assert.deepEqual(result.data, { ok: true, syncError: "", nicknameWarning: "" });
    assert.equal((await linked("/api/discord/status")).data.syncError, "");
    assert.equal((await linked("/api/discord/status")).data.nicknameWarning, "");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("startup migrates old nickname failures out of the role error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mirror-ka-discord-migration-"));
  const dbPath = path.join(directory, "portal.sqlite");
  const oldWarning = "Не удалось синхронизировать Discord: не удалось изменить ник: Discord отказал в доступе (Missing Permissions). Проверь право «Управлять ролями/никнеймами» и положение роли бота. · не удалось выдать роль «Ст.Адвокат»: Discord отказал в доступе (Missing Permissions).";
  const firstServer = createPortalServer({ dbPath, cookieSecure: false });
  firstServer.portalDb.prepare(`INSERT INTO users
    (username,password_hash,display_name,role,status,discord_id,discord_sync_error) VALUES (?,?,?,?,?,?,?)`)
    .run("legacy", "unused", "Старый аккаунт", "Ст.Адвокат", "active", "345678901234567890", oldWarning);
  firstServer.portalDb.close();

  const migratedServer = createPortalServer({ dbPath, cookieSecure: false });
  try {
    const migrated = migratedServer.portalDb.prepare("SELECT discord_sync_error, discord_nickname_error FROM users WHERE username = 'legacy'").get();
    assert.doesNotMatch(migrated.discord_sync_error, /изменить ник/);
    assert.match(migrated.discord_sync_error, /выдать роль/);
    assert.match(migrated.discord_nickname_error, /изменить ник/);
  } finally {
    migratedServer.portalDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("citizens can choose and rate an attorney only after the assigned case closes", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("AttorneyWorkflowPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,email) VALUES (?,?,?,?, 'active',?)"
  ).run(username, passwordHash, displayName, role, `${username}@example.com`).lastInsertRowid);
  addUser("head", "Глава", "ГКА");
  const requestedLawyerId = addUser("attorney1", "Адвокат Первый", "Адвокат");
  const otherLawyerId = addUser("attorney2", "Адвокат Второй", "Ст.Адвокат");
  const citizenId = addUser("client", "Гражданин Тестовый", "Гражданин");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const account = await createClient(baseUrl);
    assert.equal((await account("/api/auth/login", "POST", {
      username, password: "AttorneyWorkflowPassword!23"
    })).status, 200);
    return account;
  };
  const citizen = await login("client");
  const requestedLawyer = await login("attorney1");
  const otherLawyer = await login("attorney2");
  const manager = await login("head");

  try {
    const directory = await citizen("/api/attorneys");
    assert.equal(directory.status, 200);
    assert.deepEqual(directory.data.attorneys.map((item) => item.id).sort(), [requestedLawyerId, otherLawyerId].sort());
    assert.equal("email" in directory.data.attorneys[0], false);

    const request = await citizen("/api/applications", "POST", {
      type: "citizen_help",
      details: "Нужна консультация по делу.",
      lawyerId: requestedLawyerId
    });
    assert.equal(request.status, 201);
    const outsiderClaim = await otherLawyer(`/api/applications/${request.data.id}/assign`, "PATCH", {});
    assert.equal(outsiderClaim.status, 403);
    assert.equal((await requestedLawyer(`/api/applications/${request.data.id}/assign`, "PATCH", {})).status, 200);
    assert.equal((await citizen(`/api/applications/${request.data.id}/rating`, "POST", { rating: 5 })).status, 409);
    assert.equal((await requestedLawyer(`/api/applications/${request.data.id}/close`, "PATCH", {})).status, 200);
    assert.equal((await citizen(`/api/applications/${request.data.id}/rating`, "POST", { rating: 6 })).status, 400);
    assert.equal((await citizen(`/api/applications/${request.data.id}/rating`, "POST", {
      rating: 5, comment: "Помог быстро и понятно."
    })).status, 201);
    assert.equal((await citizen(`/api/applications/${request.data.id}/rating`, "POST", { rating: 4 })).status, 409);
    assert.equal((await requestedLawyer(`/api/applications/${request.data.id}/rating`, "POST", { rating: 5 })).status, 403);
    for (const period of ["week", "month", "all"]) {
      const ranking = await citizen(`/api/attorneys?period=${period}`);
      const rated = ranking.data.attorneys.find((item) => item.id === requestedLawyerId);
      assert.equal(ranking.data.period, period);
      assert.equal(rated.review_count, 1);
      assert.equal(rated.average_rating, 5);
      assert.equal(rated.score, 7);
    }
    assert.equal((await citizen("/api/attorneys?period=year")).status, 400);
    assert.equal((await requestedLawyer("/api/rating-settings")).status, 403);
    assert.equal((await manager("/api/rating-settings")).data.weights.reviews, 1);
    assert.equal((await manager("/api/rating-settings", "PATCH", { weights: {
      documentsApproved: 0, casesClosed: 0, lawsuitsFiled: 0, tasksCompleted: 0, reviews: 2
    } })).status, 200);
    const updatedRanking = await citizen("/api/attorneys?period=all");
    assert.equal(updatedRanking.data.attorneys.find((item) => item.id === requestedLawyerId).score, 10);
    assert.equal((await manager("/api/rating-settings")).data.history.length, 1);

    const profile = await citizen(`/api/profiles/${requestedLawyerId}`);
    assert.equal(profile.status, 200);
    assert.equal(profile.data.profile.average_rating, 5);
    assert.equal(profile.data.profile.review_count, 1);
    assert.equal(profile.data.profile.closed_case_count, 1);
    assert.equal(profile.data.reviews[0].reviewer_name, "Гражданин");
    assert.equal("email" in profile.data.profile, false);
    assert.equal("username" in profile.data.profile, false);
    assert.equal((await requestedLawyer(`/api/profiles/${citizenId}`)).status, 404);
    const ownCitizenProfile = await citizen(`/api/profiles/${citizenId}`);
    assert.equal(ownCitizenProfile.status, 200);
    assert.equal("email" in ownCitizenProfile.data.profile, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("senior attorneys and managers can see and accept practice and citizen requests", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("PracticeAccessPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')"
  ).run(username, passwordHash, displayName, role).lastInsertRowid);
  const lawyerId = addUser("practice-lawyer", "Юрист Тестовый", "Юрист");
  const citizenId = addUser("practice-citizen", "Гражданин Тестовый", "Гражданин");
  const reviewers = ["Ст.Адвокат", "ЗГКА", "ГКА"].map((role, index) => ({
    role,
    username: `practice-reviewer-${index}`,
    id: addUser(`practice-reviewer-${index}`, `Проверяющий ${index}`, role)
  }));
  const requests = reviewers.map((reviewer) => ({
    practiceId: Number(db.prepare(`INSERT INTO applications (user_id,type,details)
      VALUES (?, 'practice', 'Запрос на совместную практику.')`).run(lawyerId).lastInsertRowid),
    citizenCaseId: Number(db.prepare(`INSERT INTO applications (user_id,type,details)
      VALUES (?, 'citizen_help', 'Запрос гражданина на помощь.')`).run(citizenId).lastInsertRowid),
    ...reviewer
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const account = await createClient(baseUrl);
    assert.equal((await account("/api/auth/login", "POST", {
      username, password: "PracticeAccessPassword!23"
    })).status, 200);
    return account;
  };

  try {
    for (const reviewer of requests) {
      const account = await login(reviewer.username);
      const visible = await account("/api/applications");
      assert.ok(visible.data.applications.some((item) => item.id === reviewer.practiceId));
      assert.equal((await account(`/api/applications/${reviewer.practiceId}/review`, "PATCH", {
        status: "approved"
      })).status, 200);
      assert.equal((await account(`/api/applications/${reviewer.citizenCaseId}/assign`, "PATCH", {})).status, 200);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("citizen case and lawsuit workflows enforce access and retain history", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("CaseWorkflowPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')"
  ).run(username, passwordHash, displayName, role).lastInsertRowid);
  const managerId = addUser("case-manager", "Руководитель", "ГКА");
  const lawyerId = addUser("case-lawyer", "Адвокат", "Адвокат");
  const citizenId = addUser("case-citizen", "Гражданин", "Гражданин");
  const outsiderId = addUser("case-outsider", "Другой адвокат", "Ст.Адвокат");
  const applicationId = Number(db.prepare(`INSERT INTO applications (user_id,type,details)
    VALUES (?, 'citizen_help', 'Тестовое обращение гражданина.')`).run(citizenId).lastInsertRowid);
  const documentId = Number(db.prepare(`INSERT INTO documents
    (user_id,template,title,bbcode,forum_status) VALUES (?,?,?,?, 'approved')`)
    .run(lawyerId, "lawsuit-supreme", "Тестовый иск", "[b]Содержимое судебного документа[/b]").lastInsertRowid);
  const lawsuitId = Number(db.prepare(`INSERT INTO lawsuits (user_id,document_id,title,court)
    VALUES (?,?,?,?)`).run(lawyerId, documentId, "Тестовый иск", "Верховный суд").lastInsertRowid);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const account = await createClient(baseUrl);
    assert.equal((await account("/api/auth/login", "POST", {
      username, password: "CaseWorkflowPassword!23"
    })).status, 200);
    return account;
  };
  const manager = await login("case-manager");
  const lawyer = await login("case-lawyer");
  const citizen = await login("case-citizen");
  const outsider = await login("case-outsider");

  try {
    assert.equal((await citizen(`/api/applications/${applicationId}/history`)).status, 200);
    assert.equal((await outsider(`/api/applications/${applicationId}/history`)).status, 404);
    assert.equal((await lawyer(`/api/applications/${applicationId}/workflow`, "PATCH", {
      priority: "high", dueAt: new Date(Date.now() + 86400000).toISOString()
    })).status, 403);
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    assert.equal((await manager(`/api/applications/${applicationId}/workflow`, "PATCH", {
      priority: "urgent", dueAt
    })).status, 200);
    assert.equal((await manager(`/api/applications/${applicationId}/assign`, "PATCH", {
      userId: lawyerId
    })).status, 200);
    assert.equal((await lawyer(`/api/applications/${applicationId}/history`)).status, 200);
    const appHistory = await manager(`/api/applications/${applicationId}/history`);
    assert.ok(appHistory.data.history.some((entry) => entry.event_type === "workflow_updated"));
    assert.ok(appHistory.data.history.some((entry) => entry.event_type === "reassigned"));
    assert.equal((await manager(`/api/applications/${applicationId}/assign`, "PATCH", {
      userId: null
    })).status, 200);
    assert.equal((await manager(`/api/applications/${applicationId}/assign`, "PATCH", {
      userId: outsiderId
    })).status, 200);
    assert.equal((await lawyer(`/api/applications/${applicationId}/close`, "PATCH", {})).status, 403);
    assert.equal((await citizen(`/api/lawsuits/${lawsuitId}/history`)).status, 404);
    assert.equal((await lawyer(`/api/lawsuits/${lawsuitId}/history`)).status, 200);
    assert.equal((await lawyer(`/api/lawsuits/${lawsuitId}/workflow`, "PATCH", {
      priority: "high", dueAt
    })).status, 403);
    assert.equal((await manager(`/api/lawsuits/${lawsuitId}/workflow`, "PATCH", {
      priority: "high", dueAt
    })).status, 200);
    const lawsuitHistory = await manager(`/api/lawsuits/${lawsuitId}/history`);
    assert.ok(lawsuitHistory.data.history.some((entry) => entry.event_type === "workflow_updated"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("all law tests are available to staff and supplied law text omits copied image artifacts", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("CodeExamPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });

  test("staff photo-zone image routes are served outside the API router", async () => {
    const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
    const db = server.portalDb;
    const salt = randomBytes(16);
    const hash = scryptSync("PhotoZoneTestPassword!23", salt, 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    });
    db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')")
      .run("photo-manager", `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`, "Фото Менеджер", "ГКА");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = await createClient(`http://127.0.0.1:${server.address().port}`);

    try {
      assert.equal((await client("/api/auth/login", "POST", {
        username: "photo-manager", password: "PhotoZoneTestPassword!23"
      })).status, 200);
      const listing = await client("/api/photozot");
      assert.equal(listing.status, 200);
      assert.ok(listing.data.photos.length > 0);
      const groups = new Set(listing.data.photos.map((photo) => photo.group_key));
      for (const group of ["lspd", "ft", "fib", "lssd", "ng", "ems", "gov", "lsia", "court"]) {
        assert.ok(groups.has(group), `Не найдена категория фото ${group}.`);
      }
      assert.equal(listing.data.photos.find((photo) => photo.group_key === "lspd").group_label, "LSPD");
      assert.equal(listing.data.photos.find((photo) => photo.group_key === "ft").group_label, "Федеральная тюрьма");
      const image = await client.raw(listing.data.photos[0].url);
      assert.equal(image.status, 200);
      assert.match(image.contentType, /^image\//);
      assert.ok(image.bytes.length > 1000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("lawyer", passwordHash, "Юрист", "Юрист", "active");
  db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("citizen", passwordHash, "Гражданин", "Гражданин", "active");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const lawyer = await createClient(baseUrl);
  const citizen = await createClient(baseUrl);

  try {
    assert.equal((await lawyer("/api/auth/login", "POST", {
      username: "lawyer", password: "CodeExamPassword!23"
    })).status, 200);
    assert.deepEqual((await lawyer("/api/rp-practice/completions")).data.completedCaseIds, []);
    const wrongPracticeAnswer = await lawyer("/api/rp-practice/answer", "POST", {
      caseId: "rp_easy_01", answerIndex: 0
    });
    assert.equal(wrongPracticeAnswer.status, 200);
    assert.equal(wrongPracticeAnswer.data.correct, false);
    assert.deepEqual((await lawyer("/api/rp-practice/completions")).data.completedCaseIds, []);
    const correctPracticeAnswer = await lawyer("/api/rp-practice/answer", "POST", {
      caseId: "rp_easy_01", answerIndex: 1
    });
    assert.equal(correctPracticeAnswer.data.correct, true);
    assert.equal(correctPracticeAnswer.data.completed, true);
    assert.deepEqual((await lawyer("/api/rp-practice/completions")).data.completedCaseIds, ["rp_easy_01"]);
    assert.equal((await lawyer("/api/rp-practice/answer", "POST", {
      caseId: "unknown-case", answerIndex: 0
    })).status, 404);
    for (const subject of ["ak", "pk", "uk", "zot", "advocacy", "road", "labor", "ethics", "documents", "justice"]) {
      const exam = await lawyer(`/api/exams/current?subject=${subject}`);
      assert.equal(exam.status, 200);
      assert.equal(exam.data.subject, subject);
      assert.equal(exam.data.questions.length, 5);
    }
    for (const subject of ["rp_easy", "rp_medium", "rp_hard"]) {
      assert.equal((await lawyer(`/api/exams/current?subject=${subject}`)).status, 400);
    }
    const passedAk = await lawyer("/api/exams", "POST", {
      subject: "ak", answers: [1, 0, 1, 0, 1]
    });
    assert.deepEqual({ score: passedAk.data.score, total: passedAk.data.total, passed: passedAk.data.passed },
      { score: 5, total: 5, passed: true });
    for (const [subject, answers] of [
      ["zot", [1, 1, 0, 1, 1]],
      ["advocacy", [1, 0, 1, 1, 1]],
      ["road", [0, 1, 1, 1, 0]],
      ["labor", [0, 0, 1, 1, 0]],
      ["ethics", [0, 1, 1, 1, 0]],
      ["documents", [0, 0, 0, 0, 0]],
      ["justice", [0, 0, 0, 0, 0]]
    ]) {
      const result = await lawyer("/api/exams", "POST", { subject, answers });
      assert.deepEqual({ score: result.data.score, total: result.data.total, passed: result.data.passed },
        { score: 5, total: 5, passed: true });
    }
    const examHistory = await lawyer("/api/exams/history");
    assert.equal(examHistory.status, 200);
    assert.equal(examHistory.data.exams.length, 8);
    const completedAk = examHistory.data.exams.find((exam) => exam.track === "law:ak");
    assert.equal(completedAk.title, "Административный кодекс");
    assert.equal(completedAk.total, 5);
    assert.equal(completedAk.passed, true);
    assert.equal(completedAk.questions.length, 5);
    assert.equal(completedAk.questions[0].correct, true);
    assert.equal(completedAk.questions[0].selectedAnswer, completedAk.questions[0].correctAnswer);
    assert.equal((await lawyer("/api/exams/current?subject=invalid")).status, 400);
    const code = await lawyer("/api/laws/ak");
    assert.equal(code.status, 200);
    assert.doesNotMatch(code.data.text, /divider\.png|\u200B/);
    assert.match(code.data.text, /Административный Кодекс/);
    for (const [key, heading] of [
      ["zot", /Закон о закрытых и охраняемых территориях/],
      ["advocacy", /ЗАКОН ОБ АДВОКАТУРЕ/i],
      ["road", /Дорожный Кодекс/i],
      ["labor", /Трудовой Кодекс/i],
      ["ethics", /Этический Кодекс/i],
      ["documents", /Закон о документообороте/i],
      ["justice", /ЗАКОН О ДЕПАРТАМЕНТЕ ЮСТИЦИИ/i]
    ]) {
      const law = await lawyer(`/api/laws/${key}`);
      assert.equal(law.status, 200);
      assert.match(law.data.text, heading);
      assert.doesNotMatch(law.data.text, /divider\.png|\u200B/);
      if (["road", "labor", "ethics", "documents", "justice"].includes(key)) {
        assert.match(law.data.sourceNote, /предоставленный пользователем/);
      }
    }
    const lawList = await lawyer("/api/laws");
    assert.ok(Object.keys(lawList.data.laws).length >= 10);
    const charter = await lawyer("/api/laws/charter");
    assert.equal(charter.status, 200);
    assert.doesNotMatch(charter.data.text, /^#{1,6}\s|\*\*/m);
    assert.equal((await citizen("/api/auth/login", "POST", {
      username: "citizen", password: "CodeExamPassword!23"
    })).status, 200);
    assert.equal((await citizen("/api/exams/current?subject=ak")).status, 403);
    assert.equal((await citizen("/api/exams/history")).status, 403);
    assert.equal((await citizen("/api/rp-practice/completions")).status, 403);
    assert.equal((await citizen("/api/rp-practice/answer", "POST", {
      caseId: "rp_easy_01", answerIndex: 1
    })).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("analytics aggregates real portal records and is limited to management", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("AnalyticsTestPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,'active')"
  ).run(username, passwordHash, username, role).lastInsertRowid);
  const managerId = addUser("analytics-head", "ГКА");
  const lawyerId = addUser("analytics-lawyer", "Адвокат");
  const citizenId = addUser("analytics-citizen", "Гражданин");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(`INSERT INTO member_employment_history
    (user_id,actor_id,event_type,from_role,to_role,from_status,to_status,details,created_at)
    VALUES (?,?,'dismissed','Адвокат','Адвокат','active','suspended','Приостановлен',?)`)
    .run(lawyerId, managerId, now);
  db.prepare(`INSERT INTO documents (user_id,template,title,bbcode,forum_status,created_at)
    VALUES (?,?,?,?,'approved',?)`).run(lawyerId, "lawsuit-supreme", "Подтверждённый документ", "[b]Доказательства[/b]", now);
  db.prepare(`INSERT INTO lawsuits (user_id,document_id,title,court,status,created_at)
    VALUES (?,1,?,'Верховный суд','decided',?)`).run(lawyerId, "Дело с решением", now);
  db.prepare(`INSERT INTO applications
    (user_id,type,details,status,assigned_to,completed_at,created_at)
    VALUES (?,'citizen_help','Закрытое обращение','approved',?,?,?)`)
    .run(citizenId, lawyerId, now, now);
  db.prepare(`INSERT INTO lawyer_reviews (application_id,lawyer_id,reviewer_id,rating,comment,created_at)
    VALUES (1,?,?,5,'Положительная оценка',?)`).run(lawyerId, citizenId, now);
  db.prepare(`INSERT INTO user_awards (user_id,granted_by,kind,title,created_at)
    VALUES (?,?,'thanks','Благодарность',?)`).run(lawyerId, managerId, now);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const account = await createClient(baseUrl);
    assert.equal((await account("/api/auth/login", "POST", {
      username, password: "AnalyticsTestPassword!23"
    })).status, 200);
    return account;
  };
  const manager = await login("analytics-head");
  const lawyer = await login("analytics-lawyer");

  try {
    assert.equal((await lawyer("/api/analytics?period=30")).status, 403);
    for (const period of ["7", "30", "90", "all"]) {
      const response = await manager(`/api/analytics?period=${period}`);
      assert.equal(response.status, 200);
      assert.equal(response.data.period, period);
      assert.equal(response.data.composition.active, 2);
      assert.equal(response.data.lawsuits.total, 1);
      assert.equal(response.data.lawsuits.byStatus.decided, 1);
      assert.equal(response.data.documents.byStatus.approved, 1);
      assert.equal(response.data.requests.closed, 1);
      assert.equal(response.data.requests.averageRating, 5);
      assert.equal(response.data.humanResources.awards, 1);
      assert.equal(response.data.humanResources.dismissals, 1);
      assert.ok(response.data.trend.some((item) => item.dismissals === 1));
      assert.ok(Array.isArray(response.data.trend));
    }
    assert.equal((await manager("/api/analytics?period=365")).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("monthly reports are role-protected and sync only portal aggregates to Google Sheets", async () => {
  const syncRequests = [];
  const webhookBodies = [];
  const syncToken = "private-report-token-".padEnd(40, "x");
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    webhookLogs: "https://discord.com/api/webhooks/123456789012345678/test-token",
    webhookFetch: async (_url, options) => {
      webhookBodies.push({
        payload: JSON.parse(options.body.get("payload_json")),
        body: options.body
      });
      return new Response(null, { status: 204 });
    },
    googleSheetsUrl: "https://script.google.com/macros/s/test/exec",
    googleSheetsToken: syncToken,
    googleSheetsFetch: async (url, options) => {
      syncRequests.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const db = server.portalDb;
  const password = "MonthlyReportPassword!23";
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role, status = "active") => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)"
  ).run(username, passwordHash, displayName, role, status).lastInsertRowid);
  const gkaId = addUser("report-gka", "Глава", "ГКА");
  const deputyId = addUser("report-deputy", "Заместитель", "ЗГКА");
  const lawyerId = addUser("report-lawyer", "Юрист", "Юрист");
  addUser("report-citizen", "Гражданин", "Гражданин");
  const suspendedId = addUser("report-suspended", "Неактивный", "Юрист", "suspended");
  const documentId = Number(db.prepare(`INSERT INTO documents
    (user_id,template,title,bbcode,forum_status,forum_reviewed_at,created_at)
    VALUES (?,'lawsuit-supreme','Отчётный иск','Текст','approved','2026-10-12 12:00:00','2026-10-02 12:00:00')`)
    .run(lawyerId).lastInsertRowid);
  db.prepare("INSERT INTO lawsuits (user_id,document_id,title,court,created_at) VALUES (?,?,?,?,?)")
    .run(lawyerId, documentId, "Отчётный иск", "Верховный суд", "2026-10-02 12:00:00");
  db.prepare(`INSERT INTO applications (user_id,type,details,assigned_to,completed_at,created_at)
    VALUES (?, 'citizen_help', 'Отчётное обращение', ?, '2026-10-18 12:00:00', '2026-10-05 12:00:00')`)
    .run(gkaId, lawyerId);
  db.prepare(`INSERT INTO exam_results (user_id,track,score,passed,answers_json,created_at)
    VALUES (?, 'law:uk', 5, 1, '[]', '2026-10-20 12:00:00')`).run(lawyerId);
  db.prepare(`INSERT INTO attestations (user_id,track,due_at,status,score,created_by,completed_at)
    VALUES (?, 'Юрист', '2026-10-25 12:00:00', 'passed', 5, ?, '2026-10-21 12:00:00')`)
    .run(lawyerId, gkaId);
  db.prepare(`INSERT INTO reprimands (user_id,issued_by,reason,photo_name,photo_type,photo,created_at)
    VALUES (?, ?, 'Проверка', 'evidence.png', 'image/png', ?, '2026-10-22 12:00:00')`)
    .run(lawyerId, gkaId, Buffer.from("image"));
  const addActivityReport = db.prepare(`INSERT INTO activity_reports
    (user_id,report_type,occurred_at,reference,details,status,reviewed_by)
    VALUES (?,?,?,?,?,?,?)`);
  addActivityReport.run(lawyerId, "call", "2026-10-10", "CALL-101", "Подтверждённый вызов", "approved", gkaId);
  addActivityReport.run(lawyerId, "bail", "2026-10-10", "BAIL-100", "Подтверждённый залог", "approved", gkaId);
  addActivityReport.run(lawyerId, "lawsuit", "2026-10-11", "CASE-202", "Подтверждённый иск", "approved", gkaId);
  addActivityReport.run(lawyerId, "prosecutor_complaint", "2026-10-12", "PC-303", "Подтверждённая жалоба", "approved", gkaId);
  addActivityReport.run(lawyerId, "call", "2026-10-13", "CALL-PENDING", "Ожидает решения", "pending", null);
  addActivityReport.run(lawyerId, "call", "2026-10-14", "CALL-REJECTED", "Отклонённый вызов", "rejected", gkaId);
  addActivityReport.run(lawyerId, "call", "2026-09-30", "CALL-OLD", "Вызов прошлого месяца", "approved", gkaId);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const gka = await createClient(baseUrl);
  const deputy = await createClient(baseUrl);
  const citizen = await createClient(baseUrl);
  const lawyer = await createClient(baseUrl);
  try {
    for (const [client, username] of [
      [gka, "report-gka"], [deputy, "report-deputy"], [citizen, "report-citizen"],
      [lawyer, "report-lawyer"]
    ]) {
      assert.equal((await client("/api/auth/login", "POST", { username, password })).status, 200);
    }
    const report = await gka("/api/reports?period=2026-10");
    assert.equal(report.status, 200);
    assert.equal(report.data.googleSheetsConfigured, true);
    assert.equal(report.data.rows.length, 3);
    assert.equal(report.data.employees.length, 3);
    assert.equal(report.data.rows.some((row) => row.userId === suspendedId), false);
    const lawyerReport = report.data.rows.find((row) => row.userId === lawyerId);
    assert.deepEqual({
      documentsCreated: lawyerReport.documentsCreated,
      documentsApproved: lawyerReport.documentsApproved,
      lawsuitsFiled: lawyerReport.lawsuitsFiled,
      callsReported: lawyerReport.callsReported,
      bailReports: lawyerReport.bailReports,
      casesTaken: lawyerReport.casesTaken,
      casesClosed: lawyerReport.casesClosed,
      examsPassed: lawyerReport.examsPassed,
      attestationsPassed: lawyerReport.attestationsPassed,
      reprimands: lawyerReport.reprimands
    }, {
      documentsCreated: 1, documentsApproved: 1, lawsuitsFiled: 1, casesTaken: 1,
      callsReported: 1, bailReports: 1, casesClosed: 1, examsPassed: 1, attestationsPassed: 1, reprimands: 1
    });
    assert.equal(report.data.totals.callsReported, 1);
    assert.equal(report.data.totals.bailReports, 1);
    assert.equal("lawsuitReports" in lawyerReport, false);
    assert.equal("prosecutorComplaints" in lawyerReport, false);
    assert.equal("lawsuitReports" in report.data.totals, false);
    assert.equal("prosecutorComplaints" in report.data.totals, false);

    const manualLawsuitReport = await lawyer("/api/activity-reports", "POST", {
      reportType: "lawsuit",
      occurredAt: "2026-10-25",
      reference: "CASE-MANUAL",
      details: "Иск не должен отправляться вручную"
    });
    assert.equal(manualLawsuitReport.status, 400);
    const invalidPhoto = await lawyer("/api/activity-reports", "POST", {
      reportType: "call",
      occurredAt: "2026-10-25",
      reference: "CALL-BAD-PHOTO",
      details: "Отчёт с неверным форматом фото",
      photo: {
        name: "call-evidence.png",
        type: "image/png",
        data: "data:image/png;base64,JVBERi0xLjQ="
      }
    });
    assert.equal(invalidPhoto.status, 400);
    const missingPhoto = await lawyer("/api/activity-reports", "POST", {
      reportType: "call",
      occurredAt: "2026-10-25",
      reference: "CALL-NO-PHOTO",
      details: "Отчёт без фото"
    });
    assert.equal(missingPhoto.status, 400);
    const submission = await lawyer("/api/activity-reports", "POST", {
      reportType: "call",
      occurredAt: "2026-10-25",
      reference: "CALL-NEW",
      details: "Новый вызов для проверки одобрения",
      photo: {
        name: "call-evidence.png",
        type: "image/png",
        data: "data:image/png;base64,iVBORw0KGgo="
      }
    });
    assert.equal(submission.status, 201);
    assert.equal(submission.data.status, "pending");
    assert.equal(submission.data.warning, "");
    assert.equal(webhookBodies.length, 1);
    assert.match(webhookBodies[0].payload.embeds[0].description, /Новый вызов для проверки одобрения/);
    assert.equal(webhookBodies[0].payload.embeds[0].image.url, "attachment://call-evidence.png");
    assert.ok(webhookBodies[0].body.get("files[0]"));
    const bailWithoutPhoto = await lawyer("/api/activity-reports", "POST", {
      reportType: "bail",
      occurredAt: "2026-10-25",
      reference: "BAIL-NEW",
      details: "Залог оформлен и внесён в журнал"
    });
    assert.equal(bailWithoutPhoto.status, 201);
    assert.equal(webhookBodies.length, 2);
    assert.equal(webhookBodies[1].payload.embeds[0].thumbnail.url, "attachment://collegium-seal.png");
    assert.equal(webhookBodies[1].body.get("files[0]").name, "collegium-seal.png");
    assert.equal(webhookBodies[1].body.get("files[1]"), null);
    const bailWithPhoto = await lawyer("/api/activity-reports", "POST", {
      reportType: "bail",
      occurredAt: "2026-10-25",
      reference: "BAIL-WITH-PHOTO",
      details: "К залогу не нужен скриншот",
      photo: { name: "not-needed.png", type: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" }
    });
    assert.equal(bailWithPhoto.status, 400);
    const pending = await gka("/api/activity-reports");
    assert.equal(pending.data.canReview, true);
    const pendingReport = pending.data.reports.find((item) => item.id === submission.data.id);
    assert.equal(pendingReport.status, "pending");
    assert.equal(pendingReport.attachment_name, "call-evidence.png");
    const pendingBailReport = pending.data.reports.find((item) => item.id === bailWithoutPhoto.data.id);
    assert.equal(pendingBailReport.report_type, "bail");
    assert.equal(pendingBailReport.attachment_name, null);
    const storedPhoto = await lawyer.raw(`/api/activity-reports/${submission.data.id}/photo`);
    assert.equal(storedPhoto.status, 200);
    assert.equal(storedPhoto.contentType, "image/png");
    assert.deepEqual(storedPhoto.bytes, Buffer.from("iVBORw0KGgo=", "base64"));
    assert.equal((await deputy.raw(`/api/activity-reports/${submission.data.id}/photo`)).status, 403);
    assert.equal((await citizen.raw(`/api/activity-reports/${submission.data.id}/photo`)).status, 403);
    assert.equal((await deputy(`/api/activity-reports/${submission.data.id}`, "PATCH", {
      status: "approved"
    })).status, 403);
    assert.equal((await gka(`/api/activity-reports/${submission.data.id}`, "PATCH", {
      status: "approved"
    })).status, 200);
    assert.equal((await gka(`/api/activity-reports/${submission.data.id}`, "PATCH", {
      status: "approved"
    })).status, 409);
    assert.equal((await gka(`/api/activity-reports/${bailWithoutPhoto.data.id}`, "PATCH", {
      status: "approved"
    })).status, 200);

    const notificationFeed = await lawyer("/api/notifications");
    const reviewNotification = notificationFeed.data.notifications.find((item) =>
      item.notification_type === "activity_report_review");
    assert.ok(reviewNotification);
    assert.equal((await lawyer(`/api/notifications/${reviewNotification.id}/read`, "PATCH", {})).status, 200);
    assert.ok((await lawyer("/api/notifications")).data.notifications
      .find((item) => item.id === reviewNotification.id).read_at);
    const updatedReport = await gka("/api/reports?period=2026-10");
    const updatedLawyerReport = updatedReport.data.rows.find((row) => row.userId === lawyerId);
    assert.equal(updatedLawyerReport.callsReported, 2);
    assert.equal(updatedLawyerReport.bailReports, 2);

    assert.equal((await gka("/api/reports?period=2026-13")).status, 400);
    assert.equal((await deputy("/api/reports?period=2026-10")).status, 200);
    assert.equal((await deputy("/api/reports/sync", "POST", { period: "2026-10" })).status, 403);
    assert.equal((await citizen("/api/reports?period=2026-10")).status, 403);

    const synced = await gka("/api/reports/sync", "POST", { period: "2026-10" });
    assert.equal(synced.status, 200);
    assert.equal(syncRequests.length, 1);
    assert.equal(syncRequests[0].url, "https://script.google.com/macros/s/test/exec");
    assert.equal(syncRequests[0].body.token, syncToken);
    assert.equal(syncRequests[0].body.report.rows.find((row) => row.userId === lawyerId).casesClosed, 1);
    assert.equal(JSON.stringify(syncRequests[0].body.report).includes("email"), false);

    const largePhotoBytes = Buffer.alloc(2 * 1024 * 1024 + 128);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(largePhotoBytes);
    const largePhotoReport = await lawyer("/api/activity-reports", "POST", {
      reportType: "call",
      occurredAt: "2026-10-25",
      reference: "CALL-LARGE-PHOTO",
      details: "Фото отчёта больше прежнего лимита 2 МБ.",
      photo: {
        name: "large-evidence.png",
        type: "image/png",
        data: `data:image/png;base64,${largePhotoBytes.toString("base64")}`
      }
    });
    assert.equal(largePhotoReport.status, 201);
    const largePhoto = await lawyer.raw(`/api/activity-reports/${largePhotoReport.data.id}/photo`);
    assert.equal(largePhoto.status, 200);
    assert.equal(largePhoto.bytes.length, largePhotoBytes.length);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("Discord preference persists, audit test notifications are owner-only, and unlink permits relinking", async () => {
  const discordRequests = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    discordClientId: "test-client",
    discordClientSecret: "test-secret",
    discordRedirectUri: "http://127.0.0.1:3000/api/discord/callback",
    discordBotToken: "test-bot-token",
    discordGuildId: "123456789012345678",
    discordRoleIds: {},
    discordFetch: async (url, options) => {
      const requestUrl = String(url);
      discordRequests.push({ url: requestUrl, method: options?.method || "GET" });
      if (requestUrl.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 });
      }
      if (requestUrl.includes("/guilds/123456789012345678/members/")) {
        return new Response(JSON.stringify({ roles: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "message-id" }), { status: 200 });
    }
  });
  const db = server.portalDb;
  const password = "DiscordPreferencePassword!23";
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, role, discordId = null) => Number(db.prepare(`INSERT INTO users
    (username,password_hash,display_name,role,status,discord_id)
    VALUES (?,?,?,?,'active',?)`).run(username, passwordHash, username, role, discordId).lastInsertRowid);
  const ownerId = addUser("yyte", "ЗГКА", "345678901234567890");
  addUser("other-gka", "ГКА");

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const owner = await createClient(baseUrl);
  const otherGka = await createClient(baseUrl);
  try {
    assert.equal((await owner("/api/auth/login", "POST", {
      username: "yyte", password
    })).status, 200);
    assert.equal((await otherGka("/api/auth/login", "POST", {
      username: "other-gka", password
    })).status, 200);

    assert.equal((await owner("/api/notifications")).data.discordDmEnabled, true);
    assert.equal((await otherGka("/api/notifications/test", "POST", { type: "role" })).status, 403);
    const firstTest = await owner("/api/notifications/test", "POST", { type: "role" });
    assert.equal(firstTest.status, 201);
    assert.equal(firstTest.data.discordSent, true);
    assert.equal(discordRequests.filter((request) =>
      request.url.endsWith("/users/@me/channels") || /\/channels\/\d+\/messages$/.test(request.url)).length, 2);

    assert.equal((await owner("/api/notifications/preferences", "PATCH", {
      discordDmEnabled: false
    })).status, 200);
    assert.equal((await owner("/api/notifications")).data.discordDmEnabled, false);
    const optedOutTest = await owner("/api/notifications/test", "POST", { type: "status" });
    assert.equal(optedOutTest.status, 201);
    assert.equal(optedOutTest.data.discordSent, false);
    assert.equal(discordRequests.filter((request) =>
      request.url.endsWith("/users/@me/channels") || /\/channels\/\d+\/messages$/.test(request.url)).length, 2);

    assert.equal((await owner("/api/notifications/preferences", "PATCH", {
      discordDmEnabled: true
    })).status, 200);
    assert.equal((await owner("/api/notifications")).data.discordDmEnabled, true);
    const unlinked = await owner("/api/discord/unlink", "POST", {});
    assert.equal(unlinked.status, 200);
    assert.equal(db.prepare("SELECT discord_id FROM users WHERE id = ?").get(ownerId).discord_id, null);
    assert.equal((await owner("/api/discord/status")).data.linked, false);
    assert.equal((await owner("/api/discord/link", "POST", {})).status, 200);
    assert.equal((await owner("/api/profile")).status, 200);
    assert.equal((await owner("/api/applications")).status, 200);

    const ownerNotifications = await owner("/api/notifications");
    assert.equal(ownerNotifications.data.notifications.filter((item) =>
      item.notification_type === "audit_test").length, 2);
    assert.equal((await otherGka("/api/notifications")).data.notifications.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("startup migrates activity report types without losing existing photo attachments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portal-report-migration-"));
  const dbPath = path.join(directory, "portal.sqlite");
  const initial = createPortalServer({ dbPath, cookieSecure: false });
  const initialDb = initial.portalDb;
  const userId = Number(initialDb.prepare(`INSERT INTO users
    (username,password_hash,display_name,role,status)
    VALUES ('migration-lawyer','test-hash','Тестовый адвокат','Адвокат','active')`).run().lastInsertRowid);
  initialDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE activity_report_attachments;
    DROP TABLE activity_reports;
    CREATE TABLE activity_reports (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL CHECK (report_type IN ('call','lawsuit','prosecutor_complaint')),
      occurred_at TEXT NOT NULL,
      reference TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      decision TEXT NOT NULL DEFAULT '',
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE activity_report_attachments (
      report_id INTEGER PRIMARY KEY REFERENCES activity_reports(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
      content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const reportId = Number(initialDb.prepare(`INSERT INTO activity_reports
    (user_id,report_type,occurred_at,reference,details) VALUES (?,'call','2026-10-10','CALL-OLD','Старый отчёт')`)
    .run(userId).lastInsertRowid);
  initialDb.prepare(`INSERT INTO activity_report_attachments
    (report_id,file_name,content_type,content) VALUES (?,'old.png','image/png',?)`)
    .run(reportId, Buffer.from("preserved-image"));
  initialDb.close();

  const migrated = createPortalServer({ dbPath, cookieSecure: false });
  try {
    const schema = migrated.portalDb.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'activity_reports'`).get().sql;
    assert.match(schema, /'bail'/);
    const report = migrated.portalDb.prepare("SELECT report_type, reference FROM activity_reports WHERE id = ?").get(reportId);
    assert.equal(report.report_type, "call");
    assert.equal(report.reference, "CALL-OLD");
    const attachment = migrated.portalDb.prepare("SELECT file_name, content FROM activity_report_attachments WHERE report_id = ?").get(reportId);
    assert.equal(attachment.file_name, "old.png");
    assert.deepEqual(Buffer.from(attachment.content), Buffer.from("preserved-image"));
    assert.deepEqual(migrated.portalDb.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    migrated.portalDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("staff dismissal permanently removes account data and bulk cleanup preserves the current GKA", async () => {
  const discordRequests = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    discordBotToken: "test-discord-bot",
    discordGuildId: "123456789012345678",
    discordRoleIds: {},
    discordFetch: async (url, options) => {
      discordRequests.push({ url, options });
      if (url.endsWith("/users/@me/channels")) {
        return new Response(JSON.stringify({ id: "234567890123456789" }), { status: 200 });
      }
      if (url.endsWith("/guilds/123456789012345678/members/345678901234567890")) {
        return new Response(JSON.stringify({ roles: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "message-id" }), { status: 200 });
    }
  });
  const db = server.portalDb;
  const password = "PermanentRemovalPassword!23";
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, displayName, role, discordId = null) => Number(db.prepare(`INSERT INTO users
    (username,password_hash,display_name,role,status,discord_id)
    VALUES (?,?,?,?,'active',?)`).run(username, passwordHash, displayName, role, discordId).lastInsertRowid);
  const gkaId = addUser("removal-gka", "Глава", "ГКА");
  addUser("removal-deputy", "Заместитель", "ЗГКА");
  const lawyerId = addUser("removal-lawyer", "Адвокат", "Адвокат", "345678901234567890");
  addUser("removal-citizen", "Гражданин", "Гражданин");
  const reportId = Number(db.prepare(`INSERT INTO activity_reports
    (user_id,report_type,occurred_at,reference,details) VALUES (?,'call','2026-10-10','CALL-REMOVE','Отчёт под удаление')`)
    .run(lawyerId).lastInsertRowid);
  db.prepare(`INSERT INTO activity_report_attachments
    (report_id,file_name,content_type,content) VALUES (?,'remove.png','image/png',?)`)
    .run(reportId, Buffer.from("remove-me"));
  db.prepare(`INSERT INTO member_employment_history
    (user_id,actor_id,event_type,from_role,to_role,from_status,to_status,details)
    VALUES (?,?,'dismissed','Адвокат','Адвокат','active','suspended','Старые сведения')`)
    .run(lawyerId, gkaId);
  db.prepare(`INSERT INTO activity_reports
    (user_id,report_type,occurred_at,reference,details,reviewed_by)
    VALUES (?,'call','2026-10-11','CALL-REVIEWER','Ссылка на увольняемого',?)`)
    .run(gkaId, lawyerId);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const gka = await createClient(baseUrl);
  const deputy = await createClient(baseUrl);
  const lawyer = await createClient(baseUrl);
  try {
    for (const [client, username] of [
      [gka, "removal-gka"], [deputy, "removal-deputy"], [lawyer, "removal-lawyer"]
    ]) {
      assert.equal((await client("/api/auth/login", "POST", { username, password })).status, 200);
    }
    assert.equal((await deputy("/api/members/purge-all", "POST", {
      reason: "Обновление состава", confirmation: "УДАЛИТЬ ВСЕ"
    })).status, 403);
    assert.equal((await gka(`/api/members/${gkaId}/dismiss`, "POST", {
      reason: "Не удалять текущий аккаунт"
    })).status, 409);

    const dismissed = await gka(`/api/members/${lawyerId}/dismiss`, "POST", {
      reason: "Прекращение полномочий по решению руководства"
    });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.data.dmWarning, "");
    assert.equal(dismissed.data.discordWarning, "");
    const dmRequest = discordRequests.find((request) => request.url.endsWith("/channels/234567890123456789/messages"));
    assert.ok(dmRequest);
    assert.match(JSON.parse(dmRequest.options.body).embeds[0].description, /Прекращение полномочий/);
    assert.equal(db.prepare("SELECT 1 FROM users WHERE id = ?").get(lawyerId), undefined);
    assert.equal(db.prepare("SELECT 1 FROM activity_reports WHERE id = ?").get(reportId), undefined);
    assert.equal(db.prepare("SELECT 1 FROM activity_report_attachments WHERE report_id = ?").get(reportId), undefined);
    assert.equal(db.prepare("SELECT reviewed_by FROM activity_reports WHERE user_id = ?").get(gkaId).reviewed_by, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    const purged = await gka("/api/members/purge-all", "POST", {
      reason: "Полная очистка состава",
      confirmation: "УДАЛИТЬ ВСЕ"
    });
    assert.equal(purged.status, 200);
    assert.equal(purged.data.deletedCount, 2);
    assert.equal(db.prepare("SELECT id FROM users").get().id, gkaId);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
    assert.equal(purged.data.warnings.length, 2);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("GKA weekly reset archives only selected completed data and can restore it", async () => {
  const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
  const db = server.portalDb;
  const password = "WeeklyArchiveTestPassword!23";
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
  const addUser = (username, role) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)"
  ).run(username, passwordHash, username, role, "active").lastInsertRowid);
  const gkaId = addUser("weekly-gka", "ГКА");
  const deputyId = addUser("weekly-deputy", "ЗГКА");
  const lawyerId = addUser("weekly-lawyer", "Юрист");
  const finalizedApplicationId = Number(db.prepare(`INSERT INTO applications
    (user_id,type,details,status,created_at) VALUES (?,'promotion','Завершённая заявка','approved','2000-01-01 10:00:00')`)
    .run(lawyerId).lastInsertRowid);
  const citizenApplicationId = Number(db.prepare(`INSERT INTO applications
    (user_id,type,details,status,created_at) VALUES (?,'citizen_help','Обращение гражданина','approved','2000-01-01 10:00:00')`)
    .run(lawyerId).lastInsertRowid);
  db.prepare(`INSERT INTO applications (user_id,type,details,status,created_at)
    VALUES (?,'promotion','Незавершённая заявка','pending','2000-01-01 10:00:00')`).run(lawyerId);
  const completedEventId = Number(db.prepare(`INSERT INTO calendar_events
    (event_type,title,starts_at,status,responsible_id,created_by,created_at)
    VALUES ('meeting','Завершённое','2000-01-01 10:00:00','completed',?,?, '2000-01-01 10:00:00')`)
    .run(lawyerId, gkaId).lastInsertRowid);
  db.prepare(`INSERT INTO calendar_events
    (event_type,title,starts_at,status,responsible_id,created_by,created_at)
    VALUES ('meeting','Будущее','2099-01-01 10:00:00','scheduled',?,?, '2000-01-01 10:00:00')`)
    .run(lawyerId, gkaId);
  db.prepare(`INSERT INTO absence_requests
    (user_id,start_date,end_date,reason,status,created_at)
    VALUES (?, '2000-01-01','2000-01-02','Рассмотрено','approved','2000-01-01 10:00:00')`).run(lawyerId);
  db.prepare(`INSERT INTO absence_requests
    (user_id,start_date,end_date,reason,status,created_at)
    VALUES (?, '2000-01-01','2000-01-02','Ожидает','pending','2000-01-01 10:00:00')`).run(lawyerId);
  db.prepare(`INSERT INTO absence_requests
    (user_id,start_date,end_date,reason,status,created_at)
    VALUES (?, '2099-01-01','2099-01-02','Предстоящее отсутствие','approved','2000-01-01 10:00:00')`).run(lawyerId);
  const reprimandId = Number(db.prepare(`INSERT INTO reprimands
    (user_id,issued_by,reason,photo_name,photo_type,photo,created_at)
    VALUES (?,?,'Проверка','photo.png','image/png',?,'2000-01-01 10:00:00')`)
    .run(lawyerId, gkaId, Buffer.from("photo")).lastInsertRowid);
  db.prepare(`INSERT INTO lawyer_reviews (application_id,lawyer_id,reviewer_id,rating,comment)
    VALUES (?,?,?,5,'Сохранить отзыв')`).run(citizenApplicationId, lawyerId, gkaId);
  const achievementId = db.prepare("SELECT id FROM achievements ORDER BY id LIMIT 1").get().id;
  db.prepare("INSERT INTO user_achievements (user_id,achievement_id,awarded_by) VALUES (?,?,?)")
    .run(lawyerId, achievementId, gkaId);
  db.prepare(`INSERT INTO user_awards (user_id,granted_by,kind,title)
    VALUES (?,?,'special','Сохранить награду')`).run(lawyerId, gkaId);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const gka = await createClient(baseUrl);
  const deputy = await createClient(baseUrl);
  try {
    assert.equal((await gka("/api/auth/login", "POST", { username: "weekly-gka", password })).status, 200);
    assert.equal((await deputy("/api/auth/login", "POST", { username: "weekly-deputy", password })).status, 200);
    assert.equal((await deputy("/api/weekly-reset/preview")).status, 403);
    assert.equal((await deputy("/api/weekly-reset", "POST", { confirmed: true })).status, 403);
    assert.equal((await gka("/api/weekly-reset", "POST", {})).status, 400);

    const preview = await gka("/api/weekly-reset/preview");
    assert.deepEqual(preview.data.counts, { calendar: 1, applications: 1, absences: 1, reprimands: 1 });
    const protectedCounts = Object.fromEntries([
      "users", "achievements", "user_achievements", "user_awards", "lawyer_reviews"
    ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));

    const archived = await gka("/api/weekly-reset", "POST", { confirmed: true });
    assert.equal(archived.status, 201);
    const runId = archived.data.run.id;
    assert.deepEqual(archived.data.run.counts, preview.data.counts);
    assert.equal(db.prepare("SELECT archived_at FROM applications WHERE id = ?").get(finalizedApplicationId).archived_at !== null, true);
    assert.equal(db.prepare("SELECT archived_at FROM applications WHERE id = ?").get(citizenApplicationId).archived_at, null);
    assert.equal(db.prepare("SELECT archived_at FROM calendar_events WHERE id = ?").get(completedEventId).archived_at !== null, true);
    assert.equal(db.prepare("SELECT archived_at FROM reprimands WHERE id = ?").get(reprimandId).archived_at !== null, true);
    assert.deepEqual(Object.fromEntries(Object.keys(protectedCounts).map((table) => [
      table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
    ])), protectedCounts);

    assert.equal((await gka("/api/applications")).data.applications.some((item) => item.id === finalizedApplicationId), false);
    assert.equal((await gka("/api/applications?archived=1")).data.applications.some((item) => item.id === finalizedApplicationId), true);
    assert.equal((await gka("/api/absences")).data.absences.length, 2);
    assert.equal((await gka("/api/absences?archived=1")).data.absences.length, 3);
    assert.equal((await gka("/api/reprimands")).data.reprimands.length, 0);
    assert.equal((await gka("/api/reprimands?archived=1")).data.reprimands.length, 1);
    assert.equal((await gka("/api/calendar")).data.events.some((item) => item.id === completedEventId), false);
    assert.equal((await gka("/api/calendar?archived=1")).data.events.some((item) => item.id === completedEventId), true);
    assert.equal((await deputy("/api/calendar?archived=1")).status, 403);
    const history = await gka("/api/weekly-reset/history");
    assert.equal(history.data.runs[0].id, runId);
    assert.deepEqual(history.data.runs[0].counts, preview.data.counts);

    const secondRun = await gka("/api/weekly-reset", "POST", { confirmed: true });
    assert.deepEqual(secondRun.data.run.counts, { calendar: 0, applications: 0, absences: 0, reprimands: 0 });
    const restored = await gka(`/api/weekly-reset/${runId}/restore`, "POST", {});
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data.run.counts, preview.data.counts);
    assert.equal(db.prepare("SELECT archived_at FROM applications WHERE id = ?").get(finalizedApplicationId).archived_at, null);
    assert.equal(db.prepare("SELECT archived_at FROM calendar_events WHERE id = ?").get(completedEventId).archived_at, null);
    assert.equal(db.prepare("SELECT archived_at FROM reprimands WHERE id = ?").get(reprimandId).archived_at, null);
    assert.equal((await gka(`/api/weekly-reset/${runId}/restore`, "POST", {})).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("promotion applications send structured Discord embeds without notifying everyone", async () => {
  const webhookBodies = [];
  const server = createPortalServer({
    dbPath: ":memory:",
    cookieSecure: false,
    webhookApplications: "https://discord.com/api/webhooks/123456789012345678/test-token",
    webhookFetch: async (_url, options) => {
      webhookBodies.push(options.body instanceof FormData
        ? JSON.parse(options.body.get("payload_json"))
        : JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
  });

  test("staff reserve, absence requests, confidential characteristics, and Academy enforce roles", async () => {
    const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
    const db = server.portalDb;
    const password = "StaffFeaturesPassword!23";
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    });
    const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
    const addUser = (username, displayName, role) => Number(db.prepare(
      "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')"
    ).run(username, passwordHash, displayName, role).lastInsertRowid);
    addUser("features-gka", "Руководитель", "ГКА");
    const memberId = addUser("features-member", "Адвокат", "Адвокат");
    addUser("features-citizen", "Гражданин", "Гражданин");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const manager = await createClient(baseUrl);
    const member = await createClient(baseUrl);
    const citizen = await createClient(baseUrl);

    try {
      for (const [client, username] of [
        [manager, "features-gka"], [member, "features-member"], [citizen, "features-citizen"]
      ]) {
        assert.equal((await client("/api/auth/login", "POST", { username, password })).status, 200);
      }

      assert.equal((await manager("/api/reserve", "POST", {
        userId: memberId, status: "ready", note: "Готов к повышению."
      })).status, 200);
      assert.equal((await member("/api/reserve")).data.reserve[0].status, "ready");
      assert.equal((await member("/api/reserve", "POST", {
        userId: memberId, status: "ready"
      })).status, 403);
      assert.equal((await citizen("/api/reserve")).status, 403);

      const startDate = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);
      const endDate = new Date(Date.now() + 86400000 * 12).toISOString().slice(0, 10);
      const absence = await member("/api/absences", "POST", {
        startDate, endDate, reason: "Запланированный отпуск."
      });
      assert.equal(absence.status, 201);
      assert.equal((await member("/api/absences")).data.absences.length, 1);
      assert.equal((await manager("/api/absences")).data.absences.length, 1);
      assert.equal((await citizen("/api/absences", "POST", {
        startDate, endDate, reason: "Отпуск гражданина."
      })).status, 403);
      assert.equal((await manager(`/api/absences/${absence.data.id}`, "PATCH", {
        status: "approved", reviewNote: "Согласовано."
      })).status, 200);
      assert.equal((await member("/api/absences")).data.absences[0].status, "approved");
      assert.equal((await member("/api/absences", "POST", {
        startDate, endDate, reason: "Повторная заявка."
      })).status, 409);

      const characteristic = await manager("/api/characteristics", "POST", {
        userId: memberId, criterion: "professionalism", score: 5, note: "Положительная оценка."
      });
      assert.equal(characteristic.status, 201);
      assert.equal((await manager("/api/characteristics")).data.characteristics[0].score, 5);
      assert.equal((await member("/api/characteristics")).status, 403);
      assert.equal((await member("/api/characteristics", "POST", {
        userId: memberId, criterion: "professionalism", score: 5
      })).status, 403);
      const personalFile = await member("/api/profile");
      assert.equal(personalFile.data.absences[0].status, "approved");
      assert.equal(personalFile.data.reserve[0].status, "ready");
      assert.equal("characteristics" in personalFile.data, false);

      assert.equal((await manager("/api/academy", "POST", {
        category: "unknown", kind: "lecture", title: "Bad category", body: "Invalid category."
      })).status, 400);
      const material = await manager("/api/academy", "POST", {
        category: "court", kind: "lecture", title: "Судебная практика",
        body: "Порядок подготовки к заседанию."
      });
      assert.equal(material.status, 201);
      assert.equal((await member("/api/academy")).data.materials[0].title, "Судебная практика");
      assert.equal((await citizen("/api/academy")).status, 403);
      assert.equal((await member(`/api/academy/${material.data.id}`, "PATCH", {
        category: "court", kind: "lecture", title: "Изменение", body: "Недоступно участнику."
      })).status, 403);
      assert.equal((await manager(`/api/academy/${material.data.id}`, "PATCH", {
        category: "court", kind: "manual", title: "Обновлённая практика", body: "Проверенный материал."
      })).status, 200);
      assert.equal((await member("/api/academy")).data.materials[0].title, "Обновлённая практика");
      assert.equal((await manager(`/api/academy/${material.data.id}`, "DELETE")).status, 200);
      assert.equal((await member("/api/academy")).data.materials.length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  });

  test("member profiles persist forum links, confirmed achievements, and manager-issued awards", async () => {
    const server = createPortalServer({ dbPath: ":memory:", cookieSecure: false });
    const db = server.portalDb;
    const password = "MemberProfilePassword!23";
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, {
      N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    });
    const passwordHash = `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
    const addUser = (username, displayName, role) => Number(db.prepare(
      "INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')"
    ).run(username, passwordHash, displayName, role).lastInsertRowid);
    addUser("profile-gka", "Глава", "ГКА");
    const memberId = addUser("profile-lawyer", "Адвокат Тестовый", "Адвокат");
    const memberSince = new Date().toISOString().slice(0, 10);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const manager = await createClient(baseUrl);
    const member = await createClient(baseUrl);

    try {
      assert.equal((await manager("/api/auth/login", "POST", { username: "profile-gka", password })).status, 200);
      assert.equal((await member("/api/auth/login", "POST", { username: "profile-lawyer", password })).status, 200);
      assert.equal((await member("/api/profile")).status, 200);
      assert.equal((await member("/api/profile", "PATCH", {
        forumProfileUrl: "https://example.test/members/not-the-official-forum/"
      })).status, 400);
      const linked = await member("/api/profile", "PATCH", {
        forumProfileUrl: "https://forum.gta5rp.com/members/profile-lawyer.123/"
      });
      assert.equal(linked.status, 200);
      assert.equal(linked.data.verified, false);

      assert.equal((await manager(`/api/members/${memberId}`, "PATCH", {
        memberSince, forumProfileVerified: true
      })).status, 200);
      assert.equal((await manager(`/api/members/${memberId}`, "PATCH", {
        status: "suspended"
      })).status, 200);
      assert.equal((await manager(`/api/members/${memberId}`, "PATCH", {
        status: "active"
      })).status, 200);
      const memberRow = (await manager("/api/members")).data.members.find((item) => item.id === memberId);
      assert.equal(memberRow.member_since, memberSince);
      assert.ok(memberRow.forum_profile_verified_at);

      const automatic = await manager("/api/achievements", "POST", {
        title: "Тестовое достижение", description: "Одобрите документ.", icon: "✓",
        metric: "approved_documents", threshold: 1
      });
      assert.equal(automatic.status, 201);
      db.prepare(`INSERT INTO documents (user_id,template,title,bbcode,forum_status)
        VALUES (?, 'complaint', 'Одобренный документ', 'Текст документа', 'approved')`).run(memberId);
      const manual = await manager("/api/achievements", "POST", {
        title: "Ручная награда", description: "Выдаётся ГКА.", icon: "★", metric: "manual", threshold: 1
      });
      assert.equal(manual.status, 201);
      assert.equal((await manager(`/api/achievements/${manual.data.id}/award`, "POST", { userId: memberId })).status, 201);
      assert.equal((await manager(`/api/achievements/${manual.data.id}/award`, "POST", { userId: memberId })).status, 409);
      assert.equal((await member(`/api/achievements/${manual.data.id}/award`, "POST", { userId: memberId })).status, 403);
      assert.equal((await member("/api/awards", "POST", {
        userId: memberId, kind: "thanks", title: "Самовыданная награда"
      })).status, 403);
      assert.equal((await manager("/api/awards", "POST", {
        userId: memberId, kind: "certificate", title: "Почётная грамота", description: "За работу."
      })).status, 201);

      const profile = await member("/api/profile");
      assert.equal(profile.data.profile.forum_profile_url, "https://forum.gta5rp.com/members/profile-lawyer.123/");
      assert.ok(profile.data.profile.forum_profile_verified_at);
      assert.equal(profile.data.profile.member_since, memberSince);
      assert.deepEqual(profile.data.employmentHistory.map((item) => item.event_type), ["reinstated", "dismissed"]);
      assert.ok(profile.data.employmentHistory.every((item) => item.actor_name === "Глава"));
      assert.equal(profile.data.achievements.length, 2);
      assert.ok(profile.data.achievements.some((item) => item.title === "Тестовое достижение"));
      assert.ok(profile.data.achievements.some((item) => item.title === "Ручная награда"));
      assert.equal(profile.data.awards[0].title, "Почётная грамота");
      assert.equal((await member("/api/achievements")).data.achievements.length >= 2, true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }
  });
  const db = server.portalDb;
  const salt = randomBytes(16);
  const hash = scryptSync("PromotionReportPassword!23", salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  const attorneyId = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?,?)")
    .run("attorney", `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`, "Адвокат Тестовый", "Адвокат", "active").lastInsertRowid);
  db.prepare(`INSERT INTO applications (user_id, type, details, status, review_data_json)
    VALUES (?, 'exam', 'Проверка знаний одобрена.', 'approved', ?)`)
    .run(attorneyId, JSON.stringify({ stage: "Адвокат" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const attorney = await createClient(baseUrl);

  try {
    assert.equal((await attorney("/api/auth/login", "POST", {
      username: "attorney", password: "PromotionReportPassword!23"
    })).status, 200);
    const report = await attorney("/api/applications", "POST", {
      type: "promotion",
      details: "Отчёт: отработал 25 вызовов, включая 5 совместно с юристом.",
      promotionData: {
        completedCalls: 25,
        callsWithLawyer: 5,
        acceptedLawsuitReference: "Иск № 123 принят"
      },
      attachments: [{ name: "proof.png", type: "image/png", data: "iVBORw0KGgo=" }]
    });
    assert.equal(report.status, 201);
    assert.equal(webhookBodies.length, 1);
    assert.equal(webhookBodies[0].allowed_mentions.parse.length, 0);
    const embed = webhookBodies[0].embeds[0];
    assert.match(embed.title, /Ст\.Адвокат/);
    assert.ok(embed.fields.some((field) => field.name === "Текущая роль" && field.value === "Адвокат"));
    assert.ok(embed.fields.some((field) => field.name === "Отчёт" && field.value.includes("25 вызовов")));
    assert.ok(embed.fields.some((field) => field.name === "Вызовы" && field.value.includes("5 с юристом")));
    const saved = (await attorney("/api/applications")).data.applications.find((item) => item.id === report.data.id);
    assert.equal(saved.attachments.length, 1);
    assert.equal(saved.attachments[0].file_name, "proof.png");
    const attachmentResponse = await fetch(new URL(
      `/api/applications/${report.data.id}/attachments/${saved.attachments[0].id}`, baseUrl
    ), { headers: { cookie: attorney.cookie() } });
    assert.equal(attachmentResponse.status, 200);
    assert.deepEqual(Buffer.from(await attachmentResponse.arrayBuffer()), Buffer.from("iVBORw0KGgo=", "base64"));
    const practice = await attorney("/api/applications", "POST", {
      type: "practice", details: "Прошу согласовать совместную практику по делу."
    });
    assert.equal(practice.status, 201);
    assert.equal(practice.data.webhookWarning, "");
    assert.equal(webhookBodies.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
