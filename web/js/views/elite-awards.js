/* ============================================================================
   elite-awards.js — отрисовка витрины «Элита коллегии: высшие награды».

   Данные приходят из web/data/elite-awards.json. Награды статусные: они не
   выдаются автоматически, поэтому витрина показывает весь каталог и отмечает
   те награды, которые сотрудник уже получил от руководства.
   ========================================================================== */
import { escapeHtml } from "../core/dom.js";

/** Нормализация названия для сопоставления награды с записью в личном деле. */
const normalize = (value) => String(value || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

/**
 * Отметки о полученных наградах.
 * @param {Array} awards — награды сотрудника из профиля (title).
 * @returns {Set<string>} нормализованные названия.
 */
export function earnedAwardTitles(awards = []) {
  return new Set(awards.map((award) => normalize(award.title)));
}

/** Считает, сколько наград витрины уже вручено. */
export function countEarned(catalog, earned) {
  if (!catalog?.awards) return 0;
  return catalog.awards.filter((award) => earned.has(normalize(award.title))).length;
}

function medalion(award) {
  const glyph = `<svg class="svg-icon" aria-hidden="true"><use href="#i-${escapeHtml(award.icon)}"></use></svg>`;
  return `<span class="elite-medallion" aria-hidden="true">
      <svg class="elite-laurel" viewBox="0 0 100 100"><use href="#i-laurel"></use></svg>
      <span class="elite-glyph">${glyph}</span>
    </span>`;
}

/** Разметка одной карточки награды. */
export function awardCard(award, earned) {
  const isEarned = earned.has(normalize(award.title));
  const classes = [
    "elite-card",
    award.legendary ? "is-legendary" : "",
    isEarned ? "is-earned" : ""
  ].filter(Boolean).join(" ");
  const tierClass = `is-${escapeHtml(award.tier)}`;
  return `<article class="${classes}">
    ${medalion(award)}
    <h4 class="elite-title">${escapeHtml(award.title)}</h4>
    <p class="elite-desc">${escapeHtml(award.description)}</p>
    <span class="elite-tier ${tierClass}">(${escapeHtml(award.tierLabel)})</span>
  </article>`;
}

/**
 * Полная витрина: заголовок, счётчик полученных и сетка наград.
 * @param {object|null} catalog — содержимое elite-awards.json.
 * @param {Array} awards — награды сотрудника.
 */
export function renderEliteAwards(catalog, awards = []) {
  if (!catalog?.awards?.length) return "";
  const earned = earnedAwardTitles(awards);
  const total = catalog.awards.length;
  const received = countEarned(catalog, earned);
  return `<section class="elite-panel" aria-labelledby="elite-awards-title">
      <div class="elite-head">
        <div>
          <h3 class="elite-heading" id="elite-awards-title">${escapeHtml(catalog.title)}</h3>
          <p class="elite-subheading">${escapeHtml(catalog.subtitle)}</p>
        </div>
        <div class="elite-score" title="Получено наград из каталога">
          <strong>${received}</strong><span>из ${total}</span>
        </div>
      </div>
      <div class="elite-grid">
        ${catalog.awards.map((award) => awardCard(award, earned)).join("")}
      </div>
      <p class="elite-note">${escapeHtml(catalog.note)}</p>
    </section>`;
}
