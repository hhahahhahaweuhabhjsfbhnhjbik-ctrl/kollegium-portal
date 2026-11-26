const assetVersion = new URL(import.meta.url).searchParams.get("v") || "20261126-7";
const appUrl = `/api/frontend/app-part?v=${encodeURIComponent(assetVersion)}`;
const stylesheetAssets = ["base.css", "theme.css", "awards.css"];
const loadingStatus = document.getElementById("session-loading");

async function fetchAssetPart(url, assetName) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Загрузка части ${assetName} завершилась с HTTP ${response.status}.`);
  const partCount = Number(response.headers.get("x-asset-part-count"));
  const totalLength = Number(response.headers.get("x-asset-total-length"));
  if (!Number.isSafeInteger(partCount) || partCount < 1 ||
      !Number.isSafeInteger(totalLength) || totalLength < 1) {
    throw new Error(`Сервер вернул некорректные данные частей ${assetName}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 12 * 1024) {
    throw new Error(`Часть ${assetName} превышает допустимый размер.`);
  }
  return {
    partCount,
    totalLength,
    bytes
  };
}

async function fetchChunkedAsset(urlForPart, assetName) {
  const firstPart = await fetchAssetPart(urlForPart(0), assetName);
  const remainingParts = await Promise.all(
    Array.from({ length: firstPart.partCount - 1 }, (_, index) =>
      fetchAssetPart(urlForPart(index + 1), assetName))
  );
  const parts = [firstPart, ...remainingParts];
  if (parts.some((part) =>
    part.partCount !== firstPart.partCount || part.totalLength !== firstPart.totalLength
  )) {
    throw new Error(`Части ${assetName} получены из разных версий.`);
  }

  const byteLength = parts.reduce((total, part) => total + part.bytes.length, 0);
  if (byteLength !== firstPart.totalLength) {
    throw new Error(`${assetName} загрузился не полностью.`);
  }

  const source = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    source.set(part.bytes, offset);
    offset += part.bytes.length;
  }
  return new TextDecoder().decode(source);
}

function stylesheetPartUrl(fileName, index) {
  const url = new URL(`/web/css/${fileName}`, location.origin);
  url.searchParams.set("part", String(index));
  url.searchParams.set("v", assetVersion);
  return url.toString();
}

async function loadStylesheets() {
  const stylesheets = await Promise.all(stylesheetAssets.map(async (fileName) => ({
    fileName,
    source: await fetchChunkedAsset(
      (index) => stylesheetPartUrl(fileName, index),
      fileName
    )
  })));
  for (const { fileName, source } of stylesheets) {
    const style = document.createElement("style");
    style.dataset.frontendAsset = fileName;
    style.textContent = source;
    document.head.append(style);
  }
}

async function loadApplication() {
  try {
    const [moduleSource] = await Promise.all([
      fetchChunkedAsset((index) => `${appUrl}&part=${index}`, "приложения"),
      loadStylesheets()
    ]);
    const rewrittenModuleSource = moduleSource
      .replace(/(from\s+["'])\/web\/js\//g, `$1${location.origin}/api/frontend/module/`);
    const moduleUrl = URL.createObjectURL(new Blob([rewrittenModuleSource], { type: "text/javascript" }));
    try {
      await import(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  } catch (error) {
    console.error("Не удалось загрузить приложение портала:", error);
    if (loadingStatus) {
      loadingStatus.textContent = "Не удалось загрузить оформление или портал. Проверьте соединение и обновите страницу.";
    }
  }
}

void loadApplication();
