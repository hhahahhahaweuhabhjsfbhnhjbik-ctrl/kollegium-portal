/* ============================================================================
   dom.js — минимальные помощники для работы с DOM.

   Держим их отдельно от app.js, чтобы любой модуль интерфейса мог
   переиспользовать поиск элементов и безопасный вывод текста.
   ========================================================================== */

/** Первый элемент по селектору. */
export const $ = (selector, root = document) => root.querySelector(selector);

/** Все элементы по селектору в виде массива. */
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const escapeMap = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Экранирование текста перед вставкой в HTML-шаблон. */
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => escapeMap[char]);

/**
 * Создание элемента с атрибутами и содержимым.
 * Дополняет шаблонные строки там, где важно не собирать HTML вручную.
 */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
