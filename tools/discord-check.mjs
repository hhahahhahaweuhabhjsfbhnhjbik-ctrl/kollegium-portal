#!/usr/bin/env node
/**
 * Проверка настройки Discord для портала Коллегии адвокатов.
 *
 * Читает .env, проверяет форматы значений и (с флагом --network) реально
 * обращается к Discord API: подтверждает бота, сервер, роли и webhook-каналы.
 * Секреты никогда не печатаются — только маски и понятные подсказки.
 *
 * Запуск:
 *   node tools/discord-check.mjs
 *   node tools/discord-check.mjs --network
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const withNetwork = process.argv.includes("--network");

const lines = [];
const ok = (label, detail = "") => lines.push({ level: "ok", label, detail });
const bad = (label, detail = "") => lines.push({ level: "error", label, detail });
const warn = (label, detail = "") => lines.push({ level: "warn", label, detail });

/** Простой разбор .env без внешних зависимостей. */
async function readEnv() {
  const env = {};
  let raw = "";
  try {
    raw = await readFile(path.join(root, ".env"), "utf8");
  } catch {
    bad(".env", "файл не найден — создайте его из раздела «Публикация в интернете» README.");
    return env;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return env;
}

const env = await readEnv();
const value = (key) => env[key] || "";

/* ─────────────────────────── Форматы значений ──────────────────────────── */
const snowflake = /^\d{17,20}$/;

if (snowflake.test(value("DISCORD_CLIENT_ID"))) ok("DISCORD_CLIENT_ID", "формат корректный");
else bad("DISCORD_CLIENT_ID", "ожидается числовой ID приложения (17–20 цифр).");

if (value("DISCORD_CLIENT_SECRET").length >= 30) ok("DISCORD_CLIENT_SECRET", "задан");
else bad("DISCORD_CLIENT_SECRET", "слишком короткий или пустой — скопируйте из Discord Developer Portal → OAuth2.");

const redirect = value("DISCORD_REDIRECT_URI");
if (!redirect) {
  bad("DISCORD_REDIRECT_URI", "не задан.");
} else {
  try {
    const url = new URL(redirect);
    if (url.pathname !== "/api/discord/callback") {
      bad("DISCORD_REDIRECT_URI", "путь должен быть ровно /api/discord/callback.");
    } else if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      bad("DISCORD_REDIRECT_URI", "для внешнего доступа нужен HTTPS-адрес.");
    } else {
      ok("DISCORD_REDIRECT_URI", `хост ${url.host} — добавьте этот адрес в OAuth2 → Redirects.`);
      if (/trycloudflare\.com$/.test(url.hostname)) {
        warn("DISCORD_REDIRECT_URI", "временный туннель Quick Tunnel меняет адрес при каждом запуске — обновляйте Redirects.");
      }
    }
  } catch {
    bad("DISCORD_REDIRECT_URI", "не является корректным URL.");
  }
}

const botToken = value("DISCORD_BOT_TOKEN");
if (/^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(botToken)) ok("DISCORD_BOT_TOKEN", "формат корректный");
else if (!botToken) bad("DISCORD_BOT_TOKEN", "не задан — бот и личные уведомления работать не будут.");
else bad("DISCORD_BOT_TOKEN", "формат не похож на токен бота.");

if (snowflake.test(value("DISCORD_GUILD_ID"))) ok("DISCORD_GUILD_ID", "формат корректный");
else bad("DISCORD_GUILD_ID", "ожидается ID сервера (17–20 цифр).");

const roleKeys = [
  "DISCORD_ROLE_CITIZEN", "DISCORD_ROLE_TRAINEE", "DISCORD_ROLE_LAWYER",
  "DISCORD_ROLE_ATTORNEY", "DISCORD_ROLE_SENIOR_ATTORNEY",
  "DISCORD_ROLE_DEPUTY_HEAD", "DISCORD_ROLE_HEAD"
];
const roleValues = roleKeys.map((key) => value(key));
const configuredRoles = roleValues.filter((item) => snowflake.test(item)).length;
if (configuredRoles === roleKeys.length) ok("Роли Коллегии", `заданы все ${roleKeys.length}`);
else if (configuredRoles === 0) warn("Роли Коллегии", "не заданы — бот создаст их при первом запуске.");
else bad("Роли Коллегии", `заданы ${configuredRoles} из ${roleKeys.length}; остальные бот создаст сам.`);

const webhookKeys = [
  "DISCORD_WEBHOOK_APPLICATIONS",
  "DISCORD_WEBHOOK_EXAMS",
  "DISCORD_WEBHOOK_LOGS",
  "DISCORD_WEBHOOK_WEEKLY_REPORTS"
];
for (const key of webhookKeys) {
  const url = value(key);
  if (!url) {
    warn(key, "не задан — уведомления этого канала отключены.");
    continue;
  }
  try {
    const parsed = new URL(url);
    const valid = parsed.protocol === "https:" &&
      /^\/api\/webhooks\/\d+\/[\w-]+$/.test(parsed.pathname) &&
      ["discord.com", "discordapp.com"].includes(parsed.hostname);
    if (valid) ok(key, "формат корректный");
    else bad(key, "ожидается HTTPS-адрес вида https://discord.com/api/webhooks/<id>/<token>.");
  } catch {
    bad(key, "не является корректным URL.");
  }
}

/* ─────────────────────────── Проверка через сеть ───────────────────────── */
if (withNetwork) {
  const timeout = 8000;
  const api = "https://discord.com/api/v10";

  if (botToken) {
    try {
      const response = await fetch(`${api}/users/@me`, {
        headers: { authorization: `Bot ${botToken}` },
        signal: AbortSignal.timeout(timeout)
      });
      if (response.ok) {
        const bot = await response.json();
        ok("Бот в сети", `вошёл как ${bot.username}#${bot.discriminator || "0"}`);
        const guild = await fetch(`${api}/guilds/${value("DISCORD_GUILD_ID")}?with_counts=true`, {
          headers: { authorization: `Bot ${botToken}` },
          signal: AbortSignal.timeout(timeout)
        });
        if (guild.ok) {
          const info = await guild.json();
          ok("Сервер доступен", `${info.name} · участников: ${info.approximate_member_count ?? "—"}`);
          const roles = await fetch(`${api}/guilds/${value("DISCORD_GUILD_ID")}/roles`, {
            headers: { authorization: `Bot ${botToken}` },
            signal: AbortSignal.timeout(timeout)
          });
          if (roles.ok) {
            const list = await roles.json();
            const names = new Set(list.map((role) => role.name));
            const required = ["Гражданин", "Стажер КА", "Юрист", "Адвокат", "Ст.Адвокат", "ЗГКА", "ГКА"];
            const missing = required.filter((name) => !names.has(name));
            if (missing.length === 0) ok("Роли на сервере", "все 7 ролей Коллегии существуют");
            else warn("Роли на сервере", `бот создаст отсутствующие: ${missing.join(", ")}`);
          }
        } else {
          bad("Сервер недоступен", `Discord ответил HTTP ${guild.status} — проверьте DISCORD_GUILD_ID и приглашение бота.`);
        }
      } else {
        bad("Токен бота отклонён", `Discord ответил HTTP ${response.status}. Перевыпустите токен в Developer Portal.`);
      }
    } catch (error) {
      bad("Сеть недоступна", `не удалось связаться с Discord: ${error.message}`);
    }
  }

  for (const key of webhookKeys) {
    const url = value(key);
    if (!url) continue;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (response.ok) {
        const hook = await response.json();
        ok(key, `канал «${hook.channel_id ? `#${hook.channel_id}` : hook.name || "webhook"}» доступен`);
      } else {
        bad(key, `Discord ответил HTTP ${response.status} — webhook удалён или неверный токен.`);
      }
    } catch (error) {
      bad(key, `недоступен: ${error.message}`);
    }
  }
}

/* ───────────────────────────────── Итог ────────────────────────────────── */
const icons = { ok: "✔", warn: "!", error: "✖" };
for (const line of lines) {
  console.log(`${icons[line.level]} ${line.label}${line.detail ? ` — ${line.detail}` : ""}`);
}
const errors = lines.filter((line) => line.level === "error").length;
console.log(`\nИтого: ${lines.filter((line) => line.level === "ok").length} в порядке, ` +
  `${lines.filter((line) => line.level === "warn").length} предупреждений, ${errors} ошибок.`);
if (!withNetwork) {
  console.log("Подсказка: запустите с флагом --network, чтобы проверить токен, сервер и webhook-каналы.");
}
process.exit(errors ? 1 : 0);
