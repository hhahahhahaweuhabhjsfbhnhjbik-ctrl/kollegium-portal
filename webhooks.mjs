/**
 * webhooks.mjs — доставка уведомлений портала «Коллегия адвокатов» в Discord.
 *
 * Модуль самодостаточен: использует только встроенные модули Node.js (>= 24).
 * Он не импортирует server.mjs и не создаёт побочных эффектов при импорте.
 *
 * Возможности:
 *  - строгая проверка Discord webhook URL (как в прежней реализации);
 *  - красивые embed-сообщения (палитра, эмодзи, нормализация полей, вложения);
 *  - диспетчер с очередью на каждый URL, повторами и экспоненциальной задержкой;
 *  - безопасная диагностика без утечки токена webhook;
 *  - обратная совместимость: sendWebhook(...) с прежней сигнатурой.
 *
 * Пользовательские строки — на русском, идентификаторы — на английском.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Константы оформления
// ---------------------------------------------------------------------------

/** Каталог модуля — нужен для пути к печати по умолчанию. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Печать коллегии, которая всегда уходит вместе с уведомлением. */
export const DEFAULT_SEAL_PATH = path.join(MODULE_DIR, "assets", "collegium-seal.png");

const SEAL_FILENAME = "collegium-seal.png";
const SEAL_ATTACHMENT_URL = `attachment://${SEAL_FILENAME}`;

const AUTHOR_NAME = "Коллегия адвокатов · Mirror GTA 5 RP";
const FOOTER_TEXT = "Mirror GTA 5 RP · Коллегия адвокатов";

const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 3000;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const FIELD_LIMIT = 25;

/** Каналы, которые знает диспетчер. */
export const WEBHOOK_CHANNELS = Object.freeze(["applications", "help", "exams", "logs", "health"]);

/** Человеческие подписи каналов (безопасны для логов и диагностики). */
const CHANNEL_LABELS = Object.freeze({
  applications: "канал заявок",
  help: "канал помощи граждан",
  exams: "канал экзаменов",
  logs: "канал логов",
  health: "канал статуса"
});

/**
 * Палитра embed-сообщений. Значения — корректные для Discord целые числа
 * в диапазоне 0x000000..0xFFFFFF.
 */
export const DISCORD_EMBED_COLORS = Object.freeze({
  success: 0x57F287,
  warning: 0xF1C40F,
  danger: 0xE74C3C,
  info: 0x788F88,
  gold: 0xF1C40F
});

// ---------------------------------------------------------------------------
// Текстовые утилиты
// ---------------------------------------------------------------------------

/** Управляющие символы, которые ломают разметку Discord. */
const CONTROL_CHARS = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff]/g;

/**
 * Приводит произвольное значение к строке и вычищает то, что ломает
 * Discord markdown: \u0000, управляющие символы, \r\n → \n.
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(CONTROL_CHARS, "");
}

/**
 * Обрезает строку до лимита Discord.
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function clampText(value, limit) {
  const text = cleanText(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

/** Безопасное сообщение об ошибке (никогда не бросает). */
function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name || "ошибка";
  try {
    return String(error ?? "ошибка");
  } catch {
    return "ошибка";
  }
}

/** Маскирует URL в произвольном тексте, чтобы токен не попал в логи/status. */
function redactSecrets(value) {
  return String(value ?? "").replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const parsed = new URL(raw);
      const parts = parsed.pathname.split("/").filter(Boolean);
      // Discord webhook: оставляем только id канала и звёздочки вместо токена.
      if (DISCORD_HOSTS.has(parsed.hostname) && parts[0] === "api" &&
          parts[1] === "webhooks" && parts[2]) {
        return `https://${parsed.hostname}/api/webhooks/${parts[2]}/****`;
      }
      return `https://${parsed.hostname}/****`;
    } catch {
      return "https://****";
    }
  });
}

// ---------------------------------------------------------------------------
// Проверка URL
// ---------------------------------------------------------------------------

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const WEBHOOK_PATH_PATTERN = /^\/api\/webhooks\/\d+\/[^/]+/;

const URL_PARSE_WARNING = "Webhook не отправлен: URL в настройке сервера некорректен.";
const URL_SCHEME_WARNING = "Webhook не отправлен: разрешён только HTTPS Discord webhook URL.";

/**
 * Приводит входное значение к строке URL.
 * @param {unknown} value
 * @returns {string}
 */
function normaliseIncomingUrl(value) {
  if (typeof value === "string") return value.trim();
  if (value instanceof URL) return value.href;
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url.trim();
  }
  return "";
}

/**
 * Проверяет URL и возвращает русское предупреждение либо пустую строку.
 * @param {string} rawUrl уже нормализованный URL
 * @returns {string}
 */
function validateDiscordWebhookUrl(rawUrl) {
  if (!rawUrl) return "";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return URL_PARSE_WARNING;
  }
  if (parsed.protocol !== "https:" ||
      !DISCORD_HOSTS.has(parsed.hostname) ||
      !WEBHOOK_PATH_PATTERN.test(parsed.pathname)) {
    return URL_SCHEME_WARNING;
  }
  return "";
}

/**
 * true, если это корректный HTTPS Discord webhook URL.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isDiscordWebhookUrl(url) {
  const normalised = normaliseIncomingUrl(url);
  if (!normalised) return false;
  return validateDiscordWebhookUrl(normalised) === "";
}

/**
 * Безопасная подпись канала для диагностики. Никогда не содержит токен.
 * @param {unknown} url
 * @param {string} [kind] канал: applications | exams | logs
 * @returns {string}
 */
export function describeWebhook(url, kind = "") {
  const label = CHANNEL_LABELS[kind] ?? "";
  const normalised = normaliseIncomingUrl(url);
  if (!normalised) return label || "webhook не настроен";
  let parsed;
  try {
    parsed = new URL(normalised);
  } catch {
    return label || "webhook не настроен";
  }
  if (parsed.protocol !== "https:" ||
      !DISCORD_HOSTS.has(parsed.hostname) ||
      !WEBHOOK_PATH_PATTERN.test(parsed.pathname)) {
    return label || "webhook не настроен";
  }
  // /api/webhooks/<id>/<token> → id виден, токен скрыт.
  const id = parsed.pathname.split("/")[3] ?? "";
  const masked = `…/${id}/****`;
  return label ? `${label} · ${masked}` : `канал Discord · ${masked}`;
}

// ---------------------------------------------------------------------------
// Цвета и содержимое embed
// ---------------------------------------------------------------------------

/** Прежние «красные» поводы — сохранены без изменений, только расширены. */
const DANGER_KEYWORDS =
  /выговор|отклонил|ошибка|не пройден|не сдал|не принят|нарушен|отказ|заблокирован|исключ|провал/i;

/** Прежние «зелёные» поводы — сохранены без изменений, только расширены. */
const SUCCESS_KEYWORDS =
  /готов|одобр|сдал|закрыт|назначен|принят|подтвержд|выдан|создан|вруч[её]н|привязан/i;

/**
 * Подбирает цвет embed. По умолчанию работает прежняя семантика:
 *  - выговор/отклонил/ошибка/не пройден → красный 15158332;
 *  - готов/одобр/сдал/закрыт/назначен → зелёный 5763719;
 *  - иначе → 15844367.
 * Если заголовок нейтральный, можно передать семантический kind из палитры.
 * @param {string} title
 * @param {string} [kind] success | warning | danger | info | gold
 * @returns {number}
 */
export function pickColor(title, kind = "") {
  const text = cleanText(title);
  if (DANGER_KEYWORDS.test(text)) return DISCORD_EMBED_COLORS.danger;
  if (SUCCESS_KEYWORDS.test(text)) return DISCORD_EMBED_COLORS.success;
  const key = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  if (key && Object.hasOwn(DISCORD_EMBED_COLORS, key)) {
    return DISCORD_EMBED_COLORS[key];
  }
  return DISCORD_EMBED_COLORS.warning;
}

/**
 * Разрешает цвет: явный integer/hex-строка имеет приоритет, иначе — pickColor.
 * @param {unknown} color
 * @param {string} title
 * @param {string} kind
 * @returns {number}
 */
function resolveColor(color, title, kind) {
  if (Number.isInteger(color) && color >= 0 && color <= 0xffffff) return color;
  if (typeof color === "string" && /^#?[0-9a-f]{6}$/i.test(color.trim())) {
    return Number.parseInt(color.trim().replace(/^#/, ""), 16);
  }
  return pickColor(title, kind);
}

/**
 * Заголовок с необязательным эмодзи-префиксом, не длиннее 256 символов.
 * Пустой заголовок заменяется на «Уведомление», чтобы Discord не отклонил embed.
 * @param {unknown} title
 * @param {unknown} emoji
 * @returns {string}
 */
function composeTitle(title, emoji) {
  const text = cleanText(title).trim();
  const prefix = cleanText(emoji).trim();
  const composed = prefix ? `${prefix} ${text}`.trim() : text;
  return clampText(composed || "Уведомление", TITLE_LIMIT);
}

/**
 * Нормализует поля embed:
 *  - отбрасывает пустые/некорректные элементы и поля без имени или значения;
 *  - массив значения склеивает через \n;
 *  - ограничивает имя 256 и значение 1024 символами;
 *  - inline по умолчанию false;
 *  - не более 25 полей.
 * @param {unknown} fields
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function normaliseFields(fields) {
  if (!Array.isArray(fields)) return [];
  const result = [];
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const name = clampText(field.name, FIELD_NAME_LIMIT).trim();
    let rawValue = field.value;
    if (Array.isArray(rawValue)) {
      rawValue = rawValue
        .map((item) => cleanText(item).trim())
        .filter((item) => item.length > 0)
        .join("\n");
    }
    const value = clampText(rawValue, FIELD_VALUE_LIMIT).trim();
    if (!name || !value) continue; // пустые поля Discord всё равно не покажет
    result.push({
      name,
      value,
      inline: field.inline === undefined ? false : Boolean(field.inline)
    });
    if (result.length >= FIELD_LIMIT) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Вложения
// ---------------------------------------------------------------------------

/**
 * Приводит печать к байтам. Blob синхронно прочитать нельзя — им занимается
 * загрузчик диспетчера; здесь поддерживаются Buffer/Uint8Array/ArrayBuffer.
 * @param {unknown} seal
 * @returns {Uint8Array|null}
 */
function toBytes(seal) {
  if (!seal) return null;
  if (seal instanceof Uint8Array) return seal.length ? seal : null;
  if (seal instanceof ArrayBuffer) {
    return seal.byteLength ? new Uint8Array(seal) : null;
  }
  if (typeof seal === "object" && "content" in seal) {
    return toBytes(/** @type {{content: unknown}} */ (seal).content);
  }
  return null;
}

/**
 * Безопасное имя файла-вложения: без слэшей, переводов строк и кавычек.
 * @param {unknown} name
 * @returns {string}
 */
function normaliseFileName(name) {
  const cleaned = cleanText(name).trim();
  const safe = cleaned
    .replace(/[\\/\r\n"]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return safe || "attachment.bin";
}

/**
 * Нормализует пользовательское вложение { name, content, contentType }.
 * @param {unknown} file
 * @returns {{name: string, content: Uint8Array|Blob|string, contentType: string}|null}
 */
function normaliseFile(file) {
  if (!file || typeof file !== "object") return null;
  const content = /** @type {{content?: unknown}} */ (file).content;
  if (content === null || content === undefined) return null;
  let payload;
  if (typeof content === "string") payload = content;
  else if (content instanceof Uint8Array) payload = content;
  else if (content instanceof ArrayBuffer) payload = new Uint8Array(content);
  else if (typeof Blob !== "undefined" && content instanceof Blob) payload = content;
  else return null;

  const contentTypeRaw = /** @type {{contentType?: unknown}} */ (file).contentType;
  const contentType = typeof contentTypeRaw === "string" &&
    /^[\w.+-]+\/[\w.+-]+/.test(contentTypeRaw.trim())
    ? contentTypeRaw.trim()
    : "application/octet-stream";

  return {
    name: normaliseFileName(/** @type {{name?: unknown}} */ (file).name),
    content: payload,
    contentType
  };
}

/**
 * Проверяет, что URL картинки — обычный https-адрес (не attachment://).
 * @param {unknown} value
 * @returns {boolean}
 */
function isHttpsImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Сборка payload
// ---------------------------------------------------------------------------

/**
 * Собирает готовый embed и FormData. Функция синхронная и не читает файлы:
 * байты печати передаются аргументом `seal`.
 *
 * @param {{
 *   title?: unknown,
 *   description?: unknown,
 *   fields?: unknown,
 *   file?: unknown,
 *   kind?: string,
 *   color?: unknown,
 *   emoji?: unknown,
 *   imageUrl?: unknown,
 *   seal?: Buffer|Uint8Array|ArrayBuffer|null,
 *   timestamp?: string|number|Date
 * }} input
 * @returns {{payload: object, form: FormData}}
 */
export function buildWebhookPayload({
  title = "",
  description = "",
  fields = [],
  file = null,
  kind = "",
  color = null,
  emoji = "",
  imageUrl = "",
  seal = null,
  timestamp = new Date().toISOString()
} = {}) {
  const sealBytes = toBytes(seal);
  const attachment = normaliseFile(file);

  const embed = {
    title: composeTitle(title, emoji),
    description: clampText(description, DESCRIPTION_LIMIT).trim(),
    color: resolveColor(color, title, kind),
    timestamp: timestamp instanceof Date
      ? timestamp.toISOString()
      : typeof timestamp === "number"
        ? new Date(timestamp).toISOString()
        : clampText(timestamp, 64),
    author: { name: AUTHOR_NAME },
    footer: { text: FOOTER_TEXT },
    fields: normaliseFields(fields)
  };

  // Печать — миниатюра в правом верхнем углу (как в прежней реализации).
  if (sealBytes) embed.thumbnail = { url: SEAL_ATTACHMENT_URL };

  // Вложение важнее обычной картинки; иначе допускаем https-ссылку.
  if (attachment) {
    embed.image = { url: `attachment://${attachment.name}` };
  } else if (isHttpsImageUrl(imageUrl)) {
    embed.image = { url: String(imageUrl).trim() };
  }

  const payload = { embeds: [embed], allowed_mentions: { parse: [] } };

  const form = new FormData();
  // payload_json идёт первым — Discord ожидает его раньше файлов.
  form.set("payload_json", JSON.stringify(payload));

  let fileIndex = 0;
  if (sealBytes) {
    form.set(
      `files[${fileIndex}]`,
      new Blob([sealBytes], { type: "image/png" }),
      SEAL_FILENAME
    );
    fileIndex += 1;
  }
  if (attachment) {
    form.set(
      `files[${fileIndex}]`,
      new Blob([attachment.content], { type: attachment.contentType }),
      attachment.name
    );
  }

  return { payload, form };
}

// ---------------------------------------------------------------------------
// Диспетчер доставки
// ---------------------------------------------------------------------------

const GENERIC_FAILURE =
  "Заявка сохранена, но Discord webhook не ответил. Проверьте конфигурацию сервера.";
const STOPPED_FAILURE = "Доставка webhook остановлена.";
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Возвращает true для 2xx-ответа (учитывает и Response, и простые фейки).
 * @param {any} response
 * @returns {boolean}
 */
function isOkResponse(response) {
  if (!response) return false;
  if (response.ok === true) return true;
  const status = Number(response.status);
  return Number.isFinite(status) && status >= 200 && status < 300;
}

/**
 * Освобождает тело ответа, которое не будет прочитано (иначе соединение
 * undici может остаться занятым). Никогда не бросает.
 * @param {any} response
 */
async function discardResponseBody(response) {
  try {
    if (response?.body && typeof response.body.cancel === "function") {
      await response.body.cancel();
    }
  } catch {
    // тело уже закрыто или недоступно — это не ошибка доставки
  }
}

/**
 * Читает Retry-After (секунды или HTTP-дата) и retry_after из JSON-тела.
 * Тело читается один раз и тем самым освобождается. Никогда не бросает.
 * @param {any} response
 * @param {() => number} now
 * @returns {Promise<number|null>}
 */
async function readRetryAfter(response, now) {
  let headerMs = null;
  try {
    const header = response?.headers?.get?.("retry-after");
    if (typeof header === "string" && header.trim()) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        headerMs = Math.round(seconds * 1000);
      } else {
        const date = Date.parse(header);
        if (Number.isFinite(date)) headerMs = Math.max(0, date - now());
      }
    }
  } catch {
    // заголовки могут отсутствовать у самодельных фейков
  }

  let bodyMs = null;
  try {
    let data = null;
    if (typeof response?.text === "function") {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
    } else if (typeof response?.json === "function") {
      data = await response.json();
    }
    const seconds = Number(data?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) {
      bodyMs = Math.round(seconds * 1000);
    }
  } catch {
    // тело не JSON или уже прочитано — это не повод падать
  }

  if (headerMs === null && bodyMs === null) return null;
  const delay = Math.max(headerMs ?? 0, bodyMs ?? 0);
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}

/**
 * Создаёт диспетчер уведомлений.
 *
 * @param {{
 *   webhooks?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   sealPath?: string|null,
 *   readFileImpl?: (path: string) => Promise<Buffer|Uint8Array>|Buffer|Uint8Array,
 *   logger?: { error?: Function, warn?: Function },
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   random?: () => number,
 *   version?: string,
 *   maxDelayMs?: number
 * }} [options]
 */
export function createWebhookDispatcher({
  webhooks = {},
  fetchImpl = globalThis.fetch,
  sealPath = DEFAULT_SEAL_PATH,
  readFileImpl = readFile,
  logger = console,
  maxAttempts = 4,
  baseDelayMs = 400,
  timeoutMs = 8000,
  sleep = null,
  now = () => Date.now(),
  random = Math.random,
  version = "1.0.0",
  maxDelayMs = 15_000
} = {}) {
  const attemptsLimit = Math.max(1, Math.trunc(Number(maxAttempts)) || 1);
  const baseDelay = Math.max(0, Number(baseDelayMs) || 0);
  const delayCap = Math.max(baseDelay, Number(maxDelayMs) || baseDelay);
  const timeout = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 0;
  const customSleep = typeof sleep === "function" ? sleep : null;
  const randomFn = typeof random === "function" ? random : Math.random;
  const clock = typeof now === "function" ? now : () => Date.now();
  const loggerError = typeof logger?.error === "function" ? logger.error.bind(logger) : () => {};
  const loggerWarn = typeof logger?.warn === "function" ? logger.warn.bind(logger) : () => {};

  // Настройки каналов.
  const urls = Object.create(null);
  for (const channel of WEBHOOK_CHANNELS) {
    urls[channel] = normaliseIncomingUrl(webhooks?.[channel]);
  }

  // Статистика по каналам.
  const stats = Object.create(null);
  for (const channel of WEBHOOK_CHANNELS) {
    stats[channel] = {
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      sent: 0,
      failed: 0,
      retries: 0
    };
  }

  /** Очереди: ключ URL → { tail, jobs }. Одна очередь = один URL. */
  const queues = new Map();
  const timers = new Map(); // setTimeout id → resolve (чтобы stop() мог разбудить)
  let pending = 0; // все незавершённые задачи
  let active = 0;  // задачи, которые прямо сейчас выполняются
  let stopped = false;
  let sealPromise = null;

  /** Загружает печать один раз; при ошибке уведомления идут без миниатюры. */
  function loadSeal() {
    if (!sealPath) return Promise.resolve(null);
    if (!sealPromise) {
      sealPromise = (async () => {
        try {
          const raw = await readFileImpl(sealPath);
          if (raw && typeof Blob !== "undefined" && raw instanceof Blob) {
            const bytes = new Uint8Array(await raw.arrayBuffer());
            return bytes.length ? bytes : null;
          }
          return toBytes(raw);
        } catch {
          // Печать не обязательна: лучше отправить уведомление без неё.
          try {
            loggerWarn(
              "Discord webhook: печать коллегии недоступна, уведомление уйдёт без миниатюры."
            );
          } catch {
            // логгер не должен ломать доставку
          }
          return null;
        }
      })();
    }
    return sealPromise;
  }

  /** Реальная пауза с возможностью прервать её через stop(). */
  function defaultSleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.set(timer, resolve);
    });
  }

  /** Пауза между попытками (инъекция sleep для быстрых тестов). */
  function wait(ms) {
    if (stopped) return Promise.resolve();
    if (customSleep) return Promise.resolve(customSleep(ms));
    return defaultSleep(ms);
  }

  /** Экспоненциальная задержка с джиттером. */
  function backoffDelay(attempt) {
    const exponential = baseDelay * 2 ** Math.max(0, attempt - 1);
    const capped = Math.min(exponential, delayCap);
    const jitter = Math.min(baseDelay, capped) * Math.max(0, randomFn());
    return Math.max(0, Math.round(capped + jitter));
  }

  function recordRetry(channel) {
    if (channel && stats[channel]) stats[channel].retries += 1;
  }

  function recordSuccess(channel) {
    if (!channel || !stats[channel]) return;
    stats[channel].sent += 1;
    stats[channel].lastSuccessAt = clock();
  }

  function recordFailure(channel, warning) {
    if (!channel || !stats[channel]) return;
    stats[channel].failed += 1;
    stats[channel].lastError = redactSecrets(warning);
    stats[channel].lastErrorAt = clock();
  }

  function logFailure(channel, message) {
    const label = CHANNEL_LABELS[channel] ?? "webhook";
    try {
      loggerError(
        "Discord webhook delivery failed:",
        `${label}: ${redactSecrets(message)}`
      );
    } catch {
      // логгер не должен ломать доставку
    }
  }

  function logRetry(channel, status, delay) {
    const label = CHANNEL_LABELS[channel] ?? "webhook";
    try {
      loggerWarn(
        "Discord webhook retry:",
        `${label} · HTTP ${status ?? "network"} · повтор через ${delay} мс`
      );
    } catch {
      // логгер не должен ломать доставку
    }
  }

  /** Один сигнал таймаута на попытку; пустой, если таймаут отключён. */
  function attemptSignal() {
    return timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  }

  /**
   * Ставит задачу в очередь конкретного URL. Задачи одного URL выполняются
   * строго последовательно, разные URL — параллельно.
   * @param {string} key
   * @param {() => Promise<any>} task
   * @param {string} channel
   * @returns {Promise<any>}
   */
  function enqueue(key, task, channel = "") {
    let entry = queues.get(key);
    if (!entry) {
      entry = { tail: Promise.resolve(), jobs: 0 };
      queues.set(key, entry);
    }
    entry.jobs += 1;
    pending += 1;

    const start = entry.tail.then(async () => {
      active += 1;
      try {
        return await task();
      } catch (error) {
        // Защита от любых непредвиденных ошибок: deliver() не должен reject.
        const warning = `${GENERIC_FAILURE} Попыток: 1.`;
        recordFailure(channel, warning);
        logFailure(channel, errorMessage(error));
        return { ok: false, warning, attempts: 1 };
      } finally {
        active -= 1;
      }
    });
    entry.tail = start.then(() => {}, () => {});

    return start.finally(() => {
      entry.jobs -= 1;
      pending -= 1;
      if (entry.jobs <= 0 && queues.get(key) === entry) queues.delete(key);
    });
  }

  /**
   * Выполняет доставку с повторами. Никогда не бросает.
   * @param {string} url
   * @param {string} channel
   * @param {object} event
   * @returns {Promise<{ok: boolean, warning: string, attempts: number, status?: number}>}
   */
  async function performDelivery(url, channel, event) {
    const parsed = new URL(url);

    let form;
    try {
      const seal = await loadSeal();
      const built = buildWebhookPayload({
        title: event?.title,
        description: event?.description,
        fields: event?.fields,
        file: event?.file,
        kind: event?.kind,
        color: event?.color,
        emoji: event?.emoji,
        imageUrl: event?.imageUrl,
        seal,
        timestamp: new Date(clock()).toISOString()
      });
      form = built.form;
    } catch (error) {
      const warning = `${GENERIC_FAILURE} Попыток: 0.`;
      recordFailure(channel, warning);
      logFailure(channel, errorMessage(error));
      return { ok: false, warning, attempts: 0 };
    }

    let attempts = 0;
    for (;;) {
      if (stopped) {
        return { ok: false, warning: STOPPED_FAILURE, attempts };
      }
      attempts += 1;

      try {
        const response = await fetchImpl(parsed, {
          method: "POST",
          body: form,
          signal: attemptSignal()
        });

        if (isOkResponse(response)) {
          recordSuccess(channel);
          return {
            ok: true,
            warning: "",
            attempts,
            status: Number(response?.status) || 0
          };
        }

        const status = Number(response?.status) || 0;
        const retryable = status === 429 || (status >= 500 && status <= 599);

        if (!retryable || attempts >= attemptsLimit) {
          await discardResponseBody(response);
          const warning = `Webhook Discord ответил HTTP ${status}. Попыток: ${attempts}.`;
          recordFailure(channel, warning);
          logFailure(channel, warning);
          return { ok: false, warning, attempts, status };
        }

        // 429/503: уважаем retry_after/Retry-After, иначе обычный backoff.
        const retryAfterMs = await readRetryAfter(response, clock);
        const delay = retryAfterMs ?? backoffDelay(attempts);
        recordRetry(channel);
        logRetry(channel, status, delay);
        await wait(delay);
      } catch (error) {
        // Сюда попадают сетевые ошибки, таймауты и abort.
        if (attempts >= attemptsLimit) {
          const warning = `${GENERIC_FAILURE} Попыток: ${attempts}.`;
          recordFailure(channel, warning);
          logFailure(channel, errorMessage(error));
          return { ok: false, warning, attempts };
        }
        const delay = backoffDelay(attempts);
        recordRetry(channel);
        logRetry(channel, null, delay);
        await wait(delay);
      }
    }
  }

  /**
   * Доставка в явный URL.
   * @param {unknown} rawUrl
   * @param {object} event
   * @param {string} [channel] для статистики (applications|exams|logs)
   */
  async function deliverToUrl(rawUrl, event = {}, channel = "") {
    const url = normaliseIncomingUrl(rawUrl);
    if (!url) return { ok: false, warning: "", attempts: 0, configured: false };

    const validation = validateDiscordWebhookUrl(url);
    if (validation) return { ok: false, warning: validation, attempts: 0 };

    if (stopped) return { ok: false, warning: STOPPED_FAILURE, attempts: 0 };

    const key = url; // нормализованный href — ключ очереди
    return enqueue(key, () => performDelivery(url, channel, event), channel);
  }

  /**
   * Доставка в канал.
   * @param {"applications"|"exams"|"logs"} kind
   * @param {object} event
   */
  async function deliver(kind, event = {}) {
    if (!WEBHOOK_CHANNELS.includes(kind)) {
      throw new Error(
        `Неизвестный канал уведомлений: "${String(kind)}". ` +
        `Допустимые: ${WEBHOOK_CHANNELS.join(", ")}.`
      );
    }
    const url = urls[kind];
    if (!url) return { ok: false, warning: "", attempts: 0, configured: false };
    return deliverToUrl(url, event, kind);
  }

  /**
   * Отправляет тестовое сообщение в канал (для управленческого endpoint).
   * @param {"applications"|"exams"|"logs"} kind
   */
  async function test(kind) {
    if (!WEBHOOK_CHANNELS.includes(kind)) {
      throw new Error(
        `Неизвестный канал уведомлений: "${String(kind)}". ` +
        `Допустимые: ${WEBHOOK_CHANNELS.join(", ")}.`
      );
    }
    return deliver(kind, {
      title: "Проверка канала",
      description:
        "Проверка связи портала с Discord. Если вы видите это сообщение — канал настроен верно.",
      emoji: "🧪",
      kind: "info",
      fields: [
        { name: "Канал", value: CHANNEL_LABELS[kind], inline: true },
        { name: "Время сервера", value: new Date(clock()).toISOString(), inline: true },
        { name: "Версия портала", value: String(version), inline: true }
      ]
    });
  }

  /** Синхронный снимок состояния. Никогда не содержит URL/токен. */
  function status() {
    const snapshot = {
      pending,
      queued: Math.max(0, pending - active)
    };
    for (const channel of WEBHOOK_CHANNELS) {
      const item = stats[channel];
      snapshot[channel] = {
        configured: Boolean(urls[channel]),
        lastSuccessAt: item.lastSuccessAt,
        lastError: item.lastError,
        lastErrorAt: item.lastErrorAt,
        sent: item.sent,
        failed: item.failed,
        retries: item.retries
      };
    }
    return snapshot;
  }

  /** Ждёт, пока все очереди опустеют. */
  async function drain() {
    let guard = 0;
    while (queues.size > 0 && guard < 10_000) {
      guard += 1;
      const tails = [...queues.values()].map((entry) => entry.tail);
      await Promise.allSettled(tails);
      if (pending <= 0) break;
    }
  }

  /** Останавливает повторные попытки и таймеры (для shutdown). */
  function stop() {
    stopped = true;
    for (const [timer, resolve] of timers) {
      clearTimeout(timer);
      resolve();
    }
    timers.clear();
  }

  return {
    deliver,
    deliverToUrl,
    test,
    status,
    drain,
    stop
  };
}

// ---------------------------------------------------------------------------
// Обратная совместимость
// ---------------------------------------------------------------------------

/**
 * Прежняя сигнатура sendWebhook. Возвращает "" при успехе или русское
 * предупреждение при любой ошибке; никогда не бросает.
 *
 * @param {string} url
 * @param {string} title
 * @param {string} description
 * @param {Array<{name: string, value: unknown, inline?: boolean}>} [fields]
 * @param {typeof fetch} [fetchImpl]
 * @param {{name: string, content: Buffer|Uint8Array, contentType: string}|null} [file]
 * @param {{
 *   sealPath?: string,
 *   readFileImpl?: Function,
 *   logger?: object,
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   random?: () => number
 * }} [options]
 * @returns {Promise<string>}
 */
export async function sendWebhook(
  url,
  title,
  description,
  fields = [],
  fetchImpl = globalThis.fetch,
  file = null,
  options = {}
) {
  options = options ?? {};
  if (!url) return "";

  const normalised = normaliseIncomingUrl(url);
  // Строка из одних пробелов — такой же некорректный URL, как и «мусор».
  if (!normalised) return URL_PARSE_WARNING;

  const validation = validateDiscordWebhookUrl(normalised);
  if (validation) return validation;

  const dispatcher = createWebhookDispatcher({
    fetchImpl,
    sealPath: options.sealPath ?? DEFAULT_SEAL_PATH,
    readFileImpl: options.readFileImpl ?? readFile,
    logger: options.logger ?? console,
    // Одна попытка — точное прежнее поведение и ровно один fetch.
    maxAttempts: options.maxAttempts ?? 1,
    baseDelayMs: options.baseDelayMs ?? 400,
    timeoutMs: options.timeoutMs ?? 5000,
    sleep: options.sleep,
    now: options.now,
    random: options.random,
    version: options.version
  });

  try {
    const result = await dispatcher.deliverToUrl(normalised, {
      title,
      description,
      fields,
      file
    });
    if (result.ok) return "";
    // HTTP-ошибку возвращаем в прежнем формате, транспортную — общим текстом.
    if (result.status) return `Webhook Discord ответил HTTP ${result.status}.`;
    return GENERIC_FAILURE;
  } catch (error) {
    // Теоретически недостижимо: диспетчер не бросает. Страховка для интеграции.
    try {
      (options.logger ?? console).error(
        "Discord webhook delivery failed:",
        redactSecrets(errorMessage(error))
      );
    } catch {
      // логгер не должен ломать доставку
    }
    return GENERIC_FAILURE;
  } finally {
    dispatcher.stop();
  }
}
