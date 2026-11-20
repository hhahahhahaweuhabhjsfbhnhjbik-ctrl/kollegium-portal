#!/usr/bin/env node
/**
 * Статический аудит интерфейса портала.
 *
 * Проверяет целостность связки HTML / CSS / JS:
 *   1. Каждый `$("#id")` и `document.getElementById("id")` в JS имеет элемент в HTML.
 *   2. Каждый `use href="#i-..."` имеет соответствующий <symbol>.
 *   3. Каждый `data-go` / `data-tab` ведёт на существующую страницу.
 *   4. Каждый класс, который JS добавляет в разметку, описан в CSS.
 *   5. Каждый файл, подключённый из HTML, существует.
 *   6. В HTML нет инлайновой логики (<script> с кодом) и инлайновых стилей-простыней.
 *
 * Запуск: node tools/audit-ui.mjs
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readMaybe(relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch {
    return null;
  }
}

async function listFiles(relativeDir, extension) {
  const out = [];
  let entries;
  try {
    entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(rel, extension));
    else if (entry.name.endsWith(extension)) out.push(rel);
  }
  return out;
}

const problems = [];
const warnings = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

const html = await readMaybe("advokate.html");
if (!html) {
  console.error("advokate.html не найден.");
  process.exit(1);
}

/* ---------- 1. HTML не должен содержать логику ---------- */
const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
if (styleBlocks.length) {
  const size = styleBlocks.reduce((sum, match) => sum + match[1].length, 0);
  fail(`В HTML найдено ${styleBlocks.length} инлайновых <style> (${size} байт). Стили должны жить в web/css/*.css.`);
}

for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const inlineBody = match[2].trim();
  // JSON-блоки данных и импорт-карты не считаются логикой.
  if (match[1].includes("type=\"application/json\"") || match[1].includes("type='application/json'")) continue;
  if (inlineBody && !match[1].includes("src=")) {
    fail(`В HTML найден инлайновый <script> с кодом (${inlineBody.length} байт). Логика должна жить в web/js/*.js.`);
  }
}

/* ---------- 2. Подключённые ресурсы существуют ---------- */
const linkedResources = [
  ...[...html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/gi)].map((m) => m[1]),
  ...[...html.matchAll(/<script\b[^>]*src="([^"]+)"/gi)].map((m) => m[1])
].filter((href) => href.startsWith("/") && !href.startsWith("//"));
for (const href of linkedResources) {
  const relative = href.replace(/^\//, "").split("?")[0];
  if (relative.startsWith("api/")) continue;
  try {
    await stat(path.join(root, relative));
  } catch {
    fail(`HTML ссылается на отсутствующий файл: ${href}`);
  }
}

/* ---------- 3. Собираем JS и CSS ---------- */
const jsFiles = await listFiles("web/js", ".js");
const cssFiles = await listFiles("web/css", ".css");
if (!jsFiles.length) fail("В web/js нет ни одного модуля — логика всё ещё внутри HTML?");
if (!cssFiles.length) fail("В web/css нет ни одного файла стилей.");

const js = (await Promise.all(jsFiles.map((file) => readMaybe(file)))).join("\n");
const css = (await Promise.all(cssFiles.map((file) => readMaybe(file)))).join("\n");

/**
 * Удаляет из исходника выражения `${...}` вместе с вложенными скобками.
 * Нужно, чтобы при разборе шаблонных строк не принимать имена переменных
 * внутри интерполяции за имена CSS-классов.
 */
function stripTemplateExpressions(source) {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "$" && source[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      i = j - 1;
      continue;
    }
    out += source[i];
  }
  return out;
}

const jsStatic = stripTemplateExpressions(js);

/* ---------- 4. ID, на которые ссылается JS, существуют в HTML ---------- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// Часть элементов создаётся самим интерфейсом — их id объявлены в шаблонах JS.
for (const match of jsStatic.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) htmlIds.add(match[1]);
const referencedIds = new Set();
for (const match of js.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) referencedIds.add(match[1]);
for (const match of js.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)) referencedIds.add(match[1]);
for (const match of js.matchAll(/\$\$\("#([A-Za-z0-9_-]+)"/g)) referencedIds.add(match[1]);
const missingIds = [...referencedIds].filter((id) => !htmlIds.has(id)).sort();
for (const id of missingIds) fail(`JS обращается к #${id}, но в HTML такого элемента нет.`);

/* ---------- 5. SVG-символы ---------- */
const symbols = new Set([...html.matchAll(/<symbol[^>]*id="([^"]+)"/g)].map((m) => m[1]));
const usedSymbols = new Set([...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]));
for (const match of jsStatic.matchAll(/<use href="#([^"]+)"/g)) usedSymbols.add(match[1]);
for (const symbol of usedSymbols) {
  if (symbol.includes("$") || symbol.endsWith("-")) continue;
  if (!symbols.has(symbol)) fail(`Иконка #${symbol} используется, но <symbol> для неё не объявлен.`);
}

/* ---------- 6. Страницы и навигация ---------- */
const pageIds = new Set([...html.matchAll(/class="page[^"]*"\s+id="page-([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
for (const match of html.matchAll(/data-tab="([A-Za-z0-9_-]+)"/g)) {
  if (!pageIds.has(match[1])) fail(`Кнопка навигации ведёт на несуществующую страницу: ${match[1]}`);
}
for (const match of js.matchAll(/data-go="([A-Za-z0-9_-]+)"/g)) {
  if (!pageIds.has(match[1]) && match[1] !== "home") fail(`JS рендерит data-go="${match[1]}", но такой страницы нет.`);
}
for (const match of html.matchAll(/data-go="([A-Za-z0-9_-]+)"/g)) {
  if (!pageIds.has(match[1])) fail(`HTML рендерит data-go="${match[1]}", но такой страницы нет.`);
}

/* ---------- 7. Классы из JS описаны в CSS ---------- */
const htmlClasses = new Set();
for (const match of html.matchAll(/\bclass="([^"]*)"/g)) {
  for (const token of match[1].split(/\s+/)) if (token && !token.includes("$")) htmlClasses.add(token);
}
const jsClasses = new Set();
// Классы внутри строк-шаблонов JS: class="..." (интерполяции уже удалены).
for (const match of jsStatic.matchAll(/class="([^"]*)"/g)) {
  for (const token of match[1].split(/\s+/)) {
    const clean = token.trim();
    if (clean && /^[a-z][a-z0-9-]*$/i.test(clean)) jsClasses.add(clean);
  }
}
// Классы, которые JS добавляет через classList.add / toggle / remove.
// Учитывается только первый аргумент — он и есть имя класса.
for (const match of jsStatic.matchAll(/classList\.(?:add|toggle|remove)\(\s*"([A-Za-z0-9_ -]+)"/g)) {
  for (const token of match[1].split(/\s+/)) if (token) jsClasses.add(token);
}

const cssClasses = new Set([...css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const utilityIgnores = new Set(["hidden", "active"]);
// Имена с дефисом на конце — это динамические префиксы (`priority-${value}`),
// а не готовые классы: проверять их наличие в CSS бессмысленно.
const isDynamicPrefix = (name) => name.endsWith("-");
const missingJsClasses = [...jsClasses]
  .filter((name) => !isDynamicPrefix(name) && !cssClasses.has(name) && !utilityIgnores.has(name))
  .sort();
const missingHtmlClasses = [...htmlClasses]
  .filter((name) => !isDynamicPrefix(name) && !cssClasses.has(name) && !utilityIgnores.has(name))
  .sort();

for (const name of missingJsClasses) fail(`Класс .${name} создаётся в JS, но не описан в CSS.`);
for (const name of missingHtmlClasses) warn(`Класс .${name} есть в HTML, но не описан в CSS (возможно, это состояние).`);

/* ---------- 8. Данные вынесены в JSON ---------- */
const dataFiles = await listFiles("web/data", ".json");
const jsonIssues = [];
for (const file of dataFiles) {
  const raw = await readMaybe(file);
  try {
    JSON.parse(raw);
  } catch (error) {
    jsonIssues.push(`${file}: ${error.message}`);
  }
}
for (const issue of jsonIssues) fail(`Некорректный JSON: ${issue}`);

/* ---------- 9. Секреты не должны утекать во фронтенд ---------- */
const secretPatterns = [
  /(?:DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|DISCORD_WEBHOOK_[A-Z]+)\s*[:=]\s*["'][^"']+/,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/,
  /MT[A-Za-z0-9]{20,}\.[\w-]{5,}\.[\w-]{20,}/
];
for (const [label, content] of [["advokate.html", html], ...jsFiles.map((f) => [f, null])]) {
  const body = content ?? await readMaybe(label);
  if (!body) continue;
  for (const pattern of secretPatterns) {
    if (pattern.test(body)) fail(`Похоже на утечку секрета в ${label} (шаблон ${pattern}).`);
  }
}

/* ---------- 10. Итог ---------- */
const report = {
  ok: problems.length === 0,
  files: { js: jsFiles.length, css: cssFiles.length, json: dataFiles.length },
  counts: {
    htmlIds: htmlIds.size,
    referencedIds: referencedIds.size,
    pages: pageIds.size,
    symbols: symbols.size,
    htmlClasses: htmlClasses.size,
    jsClasses: jsClasses.size,
    cssClasses: cssClasses.size
  },
  problems,
  warnings
};
console.log(JSON.stringify(report, null, 2));
process.exit(problems.length ? 1 : 0);
