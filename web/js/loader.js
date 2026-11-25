const appUrl = "/api/frontend/app-part?v=20261125-5";
const loadingStatus = document.getElementById("session-loading");

async function fetchAppPart(index) {
  const response = await fetch(`${appUrl}&part=${index}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Загрузка части приложения завершилась с HTTP ${response.status}.`);
  const partCount = Number(response.headers.get("x-asset-part-count"));
  const totalLength = Number(response.headers.get("x-asset-total-length"));
  if (!Number.isSafeInteger(partCount) || partCount < 1 ||
      !Number.isSafeInteger(totalLength) || totalLength < 1) {
    throw new Error("Сервер вернул некорректные данные частей приложения.");
  }
  return {
    partCount,
    totalLength,
    bytes: new Uint8Array(await response.arrayBuffer())
  };
}

async function loadApplication() {
  try {
    const firstPart = await fetchAppPart(0);
    const remainingParts = await Promise.all(
      Array.from({ length: firstPart.partCount - 1 }, (_, index) => fetchAppPart(index + 1))
    );
    const parts = [firstPart, ...remainingParts];
    if (parts.some((part) =>
      part.partCount !== firstPart.partCount || part.totalLength !== firstPart.totalLength
    )) {
      throw new Error("Части приложения получены из разных версий.");
    }

    const byteLength = parts.reduce((total, part) => total + part.bytes.length, 0);
    if (byteLength !== firstPart.totalLength) {
      throw new Error("Приложение загрузилось не полностью.");
    }

    const source = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
      source.set(part.bytes, offset);
      offset += part.bytes.length;
    }

    const moduleSource = new TextDecoder().decode(source)
      .replace(/(from\s+["'])\/web\/js\//g, `$1${location.origin}/api/frontend/module/`);
    const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "text/javascript" }));
    try {
      await import(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  } catch (error) {
    console.error("Не удалось загрузить приложение портала:", error);
    if (loadingStatus) {
      loadingStatus.textContent = "Не удалось загрузить портал. Проверьте соединение и обновите страницу.";
    }
  }
}

void loadApplication();
