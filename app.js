"use strict";

/* =========================================================
   Sandwichería POS — aplicación local, offline y sin backend
   - IndexedDB como almacenamiento principal
   - Migración no destructiva desde localStorage v1/v2
   - Ventas separadas por fecha local
========================================================= */

const APP_VERSION = "5.0.0";
const STORE_SCHEMA_VERSION = 3;
const BACKUP_VERSION = 1;
const BACKUP_FORMAT = "sandwicheria-pos-backup";

const DB_NAME = "sandwicheria_pos";
const DB_VERSION = 1;
const DB_STORES = Object.freeze({
  products: "products",
  days: "days",
  meta: "meta",
});

const STORAGE_KEY = "sandwicheria_store_v2";
const OLD_STORAGE_KEYS = ["sandwicheria_store_v1"];
const IDB_MIGRATED_KEY = "sandwicheria_idb_migrated_v1";
const UPDATE_CHANNEL = "sandwicheria-pos-updates";

const MAX_QTY = 999;
const MAX_PRICE = 999_999_999;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const PAYMENT_METHODS = Object.freeze([
  { value: "efectivo", label: "Efectivo" },
  { value: "transferencia", label: "Transferencia" },
  { value: "debito", label: "Débito" },
  { value: "credito", label: "Crédito" },
  { value: "otro", label: "Otro" },
]);

const LEGACY_PAYMENT = Object.freeze({ value: "sin_registrar", label: "Sin registrar" });
const VALID_PAYMENT_VALUES = new Set(PAYMENT_METHODS.map((method) => method.value));

const DEFAULT_PRODUCTS = Object.freeze([
  { id: "default_lomito_completo", category: "Lomitos", name: "Lomito completo", prices: { unidad: 4500 } },
  { id: "default_lomito_simple", category: "Lomitos", name: "Lomito simple", prices: { unidad: 3800 } },
  { id: "default_hamburguesa_clasica", category: "Hamburguesas", name: "Hamburguesa clásica", prices: { unidad: 3200 } },
  { id: "default_hamburguesa_completa", category: "Hamburguesas", name: "Hamburguesa completa", prices: { unidad: 3900 } },
  { id: "default_coca_500", category: "Bebidas", name: "Coca Cola 500 ml", prices: { unidad: 1500 } },
  { id: "default_agua_500", category: "Bebidas", name: "Agua 500 ml", prices: { unidad: 900 } },
]);

let database = null;
let storageMode = null;
let store = null;
let cart = [];
let editingProductId = null;
let currentScreen = "hoy";
let isSavingSale = false;
let toastTimer = null;
let confirmResolver = null;
let confirmPhrase = "";
let pendingServiceWorker = null;
let storageIssue = "";
let updateChannel = null;

const moneyFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  currencyDisplay: "symbol",
  maximumFractionDigits: 0,
});

const el = {};

function collectDomReferences() {
  const ids = [
    "appStatus", "appStatusText", "appStatusAction", "appHeader", "mainNav", "connectionDot", "dateText",
    "loadingState", "loadingMessage", "btnStartupRestore", "screen-hoy", "screen-historial", "screen-products", "screen-venta",
    "totalDia", "kpiVentas", "kpiItems", "kpiPromedio", "paymentSummaryHoy", "listaVentas",
    "emptyVentas", "latestSalesCount", "btnNuevaVenta", "btnExportCSV", "btnCierre",
    "historyDate", "historyPrev", "historyNext", "historyTotal", "historyPrettyDate",
    "historySales", "historyItems", "historyAverage", "paymentSummaryHistory", "historySalesList",
    "historyEmpty", "historySalesCount", "btnHistoryCSV",
    "productsCount", "productForm", "productFormTitle", "categoriesList", "prodCategory", "prodName",
    "prodPriceUnidad", "prodPriceDocena", "productFormError", "btnCancelProductEdit", "btnSaveProduct",
    "listaProductos", "hintProductosVacio", "btnExportBackup", "btnImportBackup", "fileImportBackup",
    "btnExportProductos", "btnImportProductos", "fileImportProductos", "appVersion",
    "btnCancelarVenta", "saleItemCount", "totalTicket", "stickyTotal", "selCategoria", "selProducto",
    "inpCantidad", "selPrecio", "saleFormError", "btnAgregarItem", "listaItems", "hintVacio",
    "paymentOptions", "saleNote", "btnGuardarVenta",
    "confirmDialog", "confirmTitle", "confirmMessage", "confirmPhraseField", "confirmPhraseLabel",
    "confirmPhraseInput", "confirmCancel", "confirmAccept",
    "infoDialog", "infoEyebrow", "infoTitle", "infoBody", "infoClose", "infoAction", "toast",
  ];

  for (const id of ids) {
    el[id.replaceAll("-", "_")] = document.getElementById(id);
  }

  el.screens = {
    hoy: el.screen_hoy,
    historial: el.screen_historial,
    productos: el.screen_products,
    venta: el.screen_venta,
  };
}

/* -------------------------
   Helpers generales
------------------------- */

function cloneData(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function uid(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function isValidPrice(value, allowZero = false) {
  const number = Number(value);
  return Number.isFinite(number) && number <= MAX_PRICE && (allowZero ? number >= 0 : number > 0);
}

function money(value) {
  const number = Number(value);
  return moneyFormatter.format(Number.isFinite(number) ? number : 0);
}

function isoFromDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoToday() {
  return isoFromDate(new Date());
}

function isISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return isoFromDate(date) === value;
}

function dateFromISO(value) {
  if (!isISODate(value)) return new Date();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function shiftISODate(value, days) {
  const date = dateFromISO(value);
  date.setDate(date.getDate() + days);
  return isoFromDate(date);
}

function formatTopDate(date = new Date()) {
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  })
    .format(date)
    .replace(".", "");
}

function formatLongDate(value) {
  const date = typeof value === "string" ? dateFromISO(value) : value;
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function makeElement(tagName, className = "", text = "") {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function setFormError(node, message = "") {
  node.textContent = message;
  node.hidden = !message;
}

function showToast(message, type = "success") {
  window.clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle("isError", type === "error");
  el.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, type === "error" ? 5200 : 3200);
}

/* -------------------------
   Validación y normalización
------------------------- */

function normalizeProduct(product, index = 0, strict = false) {
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new Error(`Producto inválido en la posición ${index + 1}.`);
  }

  const id = cleanText(product.id, 120) || (strict ? "" : uid("p"));
  const category = cleanText(product.category, 50);
  const name = cleanText(product.name, 80);
  const unidad = Number(product.prices?.unidad);
  const hasDocena = product.prices?.docena !== undefined && product.prices?.docena !== null && product.prices?.docena !== "";
  const docena = hasDocena ? Number(product.prices.docena) : 0;

  if (!id) throw new Error(`Falta el identificador del producto ${index + 1}.`);
  if (!category) throw new Error(`Falta la categoría del producto ${index + 1}.`);
  if (!name) throw new Error(`Falta el nombre del producto ${index + 1}.`);
  if (!isValidPrice(unidad)) throw new Error(`Precio por unidad inválido en “${name}”.`);
  if (hasDocena && !isValidPrice(docena)) throw new Error(`Precio por docena inválido en “${name}”.`);

  return {
    id,
    category,
    name,
    prices: {
      unidad,
      ...(hasDocena && docena > 0 ? { docena } : {}),
    },
  };
}

function normalizeProducts(products, strict = false) {
  if (!Array.isArray(products)) throw new Error("El archivo no contiene una lista de productos.");
  const normalized = products.map((product, index) => normalizeProduct(product, index, strict));
  const ids = new Set();
  const names = new Set();

  for (const product of normalized) {
    if (ids.has(product.id)) throw new Error(`Hay un identificador de producto repetido: ${product.id}.`);
    ids.add(product.id);

    const nameKey = `${product.category}::${product.name}`.toLocaleLowerCase("es-AR");
    if (names.has(nameKey)) {
      throw new Error(`El producto “${product.name}” está repetido en ${product.category}.`);
    }
    names.add(nameKey);
  }

  return normalized;
}

function normalizeSaleItem(item, saleIndex, itemIndex, strict = false) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Ítem inválido en la venta ${saleIndex + 1}.`);
  }

  const name = cleanText(item.name, 80);
  const category = cleanText(item.category, 50);
  const qty = Number(item.qty);
  const unitPrice = Number(item.unitPrice);
  const computedLineTotal = qty * unitPrice;
  const lineTotal = item.lineTotal === undefined ? computedLineTotal : Number(item.lineTotal);
  const priceType = item.priceType === "docena" ? "docena" : "unidad";
  const id = cleanText(item.id, 120) || (strict ? "" : uid("it"));
  const productId = cleanText(item.productId, 120);

  if (!id) throw new Error(`Falta el identificador de un ítem en la venta ${saleIndex + 1}.`);
  if (!name) throw new Error(`Falta el nombre de un ítem en la venta ${saleIndex + 1}.`);
  if (!category) throw new Error(`Falta la categoría de “${name}”.`);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100_000) {
    throw new Error(`Cantidad inválida en “${name}”.`);
  }
  if (!isValidPrice(unitPrice)) throw new Error(`Precio inválido en “${name}”.`);
  if (!isValidPrice(lineTotal)) throw new Error(`Subtotal inválido en “${name}”.`);
  if (Math.abs(lineTotal - computedLineTotal) > 0.01) {
    throw new Error(`El subtotal de “${name}” no coincide con cantidad × precio.`);
  }

  return {
    id,
    productId,
    name,
    category,
    priceType,
    unitPrice,
    qty,
    lineTotal,
  };
}

function normalizeSale(sale, date, saleIndex, strict = false) {
  if (!sale || typeof sale !== "object" || Array.isArray(sale)) {
    throw new Error(`Venta inválida en ${date}.`);
  }

  const id = cleanText(sale.id, 120) || (strict ? "" : uid("s"));
  const ts = Number(sale.ts);
  const items = Array.isArray(sale.items)
    ? sale.items.map((item, itemIndex) => normalizeSaleItem(item, saleIndex, itemIndex, strict))
    : [];
  const computedTotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const total = sale.total === undefined ? computedTotal : Number(sale.total);
  const paymentMethod = VALID_PAYMENT_VALUES.has(sale.paymentMethod) ? sale.paymentMethod : undefined;
  const note = cleanText(sale.note, 180);

  if (!id) throw new Error(`Falta el identificador de una venta en ${date}.`);
  if (!Number.isFinite(ts) || ts <= 0) throw new Error(`Fecha u hora inválida en una venta de ${date}.`);
  if (items.length === 0) throw new Error(`Una venta de ${date} no contiene productos.`);
  if (!isValidPrice(total)) throw new Error(`Total inválido en una venta de ${date}.`);
  if (Math.abs(total - computedTotal) > 0.01) {
    throw new Error(`El total de una venta de ${date} no coincide con sus productos.`);
  }

  return {
    id,
    ts,
    items,
    total,
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeDays(days, strict = false) {
  if (days === undefined || days === null) return {};
  if (typeof days !== "object" || Array.isArray(days)) {
    throw new Error("El historial de ventas tiene un formato inválido.");
  }

  const normalized = {};
  for (const [dateKey, day] of Object.entries(days)) {
    if (!isISODate(dateKey)) throw new Error(`Fecha inválida en el historial: ${dateKey}.`);
    if (!day || typeof day !== "object" || !Array.isArray(day.sales)) {
      throw new Error(`Datos inválidos para el día ${dateKey}.`);
    }
    if (strict && day.date && day.date !== dateKey) {
      throw new Error(`La fecha interna de ${dateKey} no coincide.`);
    }

    normalized[dateKey] = {
      date: dateKey,
      sales: day.sales.map((sale, saleIndex) => normalizeSale(sale, dateKey, saleIndex, strict)),
    };
  }
  return normalized;
}

function normalizeSettings(settings) {
  const defaultPaymentMethod = VALID_PAYMENT_VALUES.has(settings?.defaultPaymentMethod)
    ? settings.defaultPaymentMethod
    : "efectivo";
  return { defaultPaymentMethod };
}

function normalizeStore(raw, { strict = false, useDefaults = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("La estructura principal de datos es inválida.");
  }

  const productsSource = Array.isArray(raw.products)
    ? raw.products
    : (useDefaults ? cloneData(DEFAULT_PRODUCTS) : null);
  if (!productsSource) throw new Error("Falta la lista de productos.");

  const days = normalizeDays(raw.days, strict);
  const today = isoToday();
  const currentDay = isISODate(raw.currentDay) ? raw.currentDay : today;

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    currentDay,
    days,
    products: normalizeProducts(productsSource, strict),
    settings: normalizeSettings(raw.settings),
  };
}

function createInitialStore() {
  const today = isoToday();
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    currentDay: today,
    days: {
      [today]: { date: today, sales: [] },
    },
    products: cloneData(DEFAULT_PRODUCTS),
    settings: { defaultPaymentMethod: "efectivo" },
  };
}

/* -------------------------
   IndexedDB + migración
------------------------- */

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("Falló IndexedDB.")), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("La operación fue cancelada.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("Falló la operación de almacenamiento.")), { once: true });
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORES.products)) {
        db.createObjectStore(DB_STORES.products, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(DB_STORES.days)) {
        db.createObjectStore(DB_STORES.days, { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains(DB_STORES.meta)) {
        db.createObjectStore(DB_STORES.meta, { keyPath: "key" });
      }
    });

    request.addEventListener("success", () => {
      const db = request.result;
      db.addEventListener("versionchange", () => db.close());
      resolve(db);
    }, { once: true });

    request.addEventListener("blocked", () => {
      reject(new Error("Hay otra versión de la aplicación abierta. Cerrala y volvé a intentar."));
    }, { once: true });

    request.addEventListener("error", () => {
      reject(request.error || new Error("No se pudo abrir IndexedDB."));
    }, { once: true });
  });
}

async function readAllFromDatabase() {
  const transaction = database.transaction(Object.values(DB_STORES), "readonly");
  const productsRequest = transaction.objectStore(DB_STORES.products).getAll();
  const daysRequest = transaction.objectStore(DB_STORES.days).getAll();
  const metaRequest = transaction.objectStore(DB_STORES.meta).getAll();

  const [products, dayRows, metaRows] = await Promise.all([
    requestResult(productsRequest),
    requestResult(daysRequest),
    requestResult(metaRequest),
    transactionComplete(transaction),
  ]);

  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  const days = Object.fromEntries(dayRows.map((day) => [day.date, day]));
  const hasData = products.length > 0 || dayRows.length > 0 || metaRows.length > 0;

  return {
    hasData,
    store: normalizeStore({
      schemaVersion: meta.schemaVersion,
      currentDay: meta.currentDay,
      settings: meta.settings,
      products,
      days,
    }, { strict: false, useDefaults: false }),
  };
}

async function readDayFromDatabase(date) {
  const transaction = database.transaction(DB_STORES.days, "readonly");
  const request = transaction.objectStore(DB_STORES.days).get(date);
  const [day] = await Promise.all([requestResult(request), transactionComplete(transaction)]);
  return day ? normalizeDays({ [date]: day })[date] : { date, sales: [] };
}

async function writeCompleteStoreToDatabase(nextStore, migrationSource = "") {
  const transaction = database.transaction(Object.values(DB_STORES), "readwrite");
  const productsStore = transaction.objectStore(DB_STORES.products);
  const daysStore = transaction.objectStore(DB_STORES.days);
  const metaStore = transaction.objectStore(DB_STORES.meta);

  productsStore.clear();
  daysStore.clear();
  metaStore.clear();

  for (const product of nextStore.products) productsStore.put(cloneData(product));
  for (const day of Object.values(nextStore.days)) daysStore.put(cloneData(day));

  metaStore.put({ key: "schemaVersion", value: STORE_SCHEMA_VERSION });
  metaStore.put({ key: "currentDay", value: nextStore.currentDay });
  metaStore.put({ key: "settings", value: cloneData(nextStore.settings) });
  metaStore.put({ key: "updatedAt", value: new Date().toISOString() });
  if (migrationSource) {
    metaStore.put({
      key: "migration",
      value: { source: migrationSource, migratedAt: new Date().toISOString() },
    });
  }

  await transactionComplete(transaction);
}

async function writeProductsToDatabase(products) {
  const transaction = database.transaction([DB_STORES.products, DB_STORES.meta], "readwrite");
  const productsStore = transaction.objectStore(DB_STORES.products);
  const metaStore = transaction.objectStore(DB_STORES.meta);
  productsStore.clear();
  for (const product of products) productsStore.put(cloneData(product));
  metaStore.put({ key: "updatedAt", value: new Date().toISOString() });
  await transactionComplete(transaction);
}

async function writeDayAndSettingsToDatabase(day, settings, currentDay) {
  const transaction = database.transaction([DB_STORES.days, DB_STORES.meta], "readwrite");
  transaction.objectStore(DB_STORES.days).put(cloneData(day));
  const metaStore = transaction.objectStore(DB_STORES.meta);
  metaStore.put({ key: "currentDay", value: currentDay });
  metaStore.put({ key: "settings", value: cloneData(settings) });
  metaStore.put({ key: "schemaVersion", value: STORE_SCHEMA_VERSION });
  metaStore.put({ key: "updatedAt", value: new Date().toISOString() });
  await transactionComplete(transaction);
}

function readLegacyStore() {
  const keys = [STORAGE_KEY, ...OLD_STORAGE_KEYS];
  for (const key of keys) {
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch (error) {
      throw new Error("El navegador no permite acceder al almacenamiento local.");
    }
    if (raw === null) continue;

    try {
      return {
        key,
        store: normalizeStore(JSON.parse(raw), { strict: false, useDefaults: true }),
      };
    } catch (error) {
      throw new Error(
        `Los datos existentes en “${key}” no se pudieron leer. No se modificó ni borró ese contenido. ${error.message}`
      );
    }
  }
  return null;
}

function readFallbackStore() {
  const legacy = readLegacyStore();
  return legacy?.store || null;
}

function writeFallbackStore(nextStore) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextStore));
}

async function initializeStorage() {
  if ("indexedDB" in window) {
    try {
      database = await openDatabase();
      storageMode = "indexeddb";
      const current = await readAllFromDatabase();

      if (current.hasData) {
        store = current.store;
      } else {
        const legacy = readLegacyStore();
        store = legacy?.store || createInitialStore();
        await writeCompleteStoreToDatabase(store, legacy ? legacy.key : "new-install");
      }

      try {
        localStorage.setItem(IDB_MIGRATED_KEY, new Date().toISOString());
      } catch {
        // La marca es auxiliar: nunca condiciona la escritura principal.
      }
      return;
    } catch (error) {
      const wasMigrated = (() => {
        try {
          return Boolean(localStorage.getItem(IDB_MIGRATED_KEY));
        } catch {
          return false;
        }
      })();

      if (wasMigrated) {
        throw new Error(
          `No se pudo abrir el historial principal y se evitó crear una copia divergente. ${error.message}`
        );
      }
      database = null;
    }
  }

  storageMode = "localstorage";
  const legacy = readLegacyStore();
  store = legacy?.store || createInitialStore();
  writeFallbackStore(store);
}

async function persistProducts(products) {
  if (storageMode === "indexeddb") {
    await writeProductsToDatabase(products);
  } else {
    const nextStore = { ...store, products };
    writeFallbackStore(nextStore);
  }
}

async function persistDayAndSettings(day, settings, currentDay) {
  if (storageMode === "indexeddb") {
    await writeDayAndSettingsToDatabase(day, settings, currentDay);
  } else {
    const freshest = readFallbackStore() || store;
    const nextStore = {
      ...freshest,
      currentDay,
      settings,
      days: { ...freshest.days, [day.date]: day },
    };
    writeFallbackStore(nextStore);
  }
}

async function persistCompleteStore(nextStore) {
  if (storageMode === "indexeddb") {
    await writeCompleteStoreToDatabase(nextStore);
  } else {
    writeFallbackStore(nextStore);
  }
}

async function reloadStoreFromPersistence() {
  if (storageMode === "indexeddb") {
    const loaded = await readAllFromDatabase();
    if (loaded.hasData) store = loaded.store;
  } else {
    const loaded = readFallbackStore();
    if (loaded) store = loaded;
  }
}

async function withStorageLock(callback) {
  if (navigator.locks?.request) {
    return navigator.locks.request("sandwicheria-pos-write", callback);
  }
  return callback();
}

function broadcastUpdate(type) {
  updateChannel?.postMessage({ type, at: Date.now() });
}

function initializeCrossTabUpdates() {
  if ("BroadcastChannel" in window) {
    updateChannel = new BroadcastChannel(UPDATE_CHANNEL);
    updateChannel.addEventListener("message", async () => {
      if (isSavingSale) return;
      try {
        await reloadStoreFromPersistence();
        await ensureCurrentDay();
        refreshAllUI();
      } catch {
        showToast("No se pudieron actualizar cambios de otra ventana.", "error");
      }
    });
  }

  window.addEventListener("storage", async (event) => {
    if (storageMode !== "localstorage" || event.key !== STORAGE_KEY || isSavingSale) return;
    try {
      await reloadStoreFromPersistence();
      await ensureCurrentDay();
      refreshAllUI();
    } catch {
      showToast("No se pudieron actualizar cambios de otra ventana.", "error");
    }
  });
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persisted || !navigator.storage?.persist) return;
  try {
    if (!(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Mejora opcional: una negativa no afecta la venta guardada.
  }
}

/* -------------------------
   Fecha y estado diario
------------------------- */

function getDayData(date = store.currentDay) {
  return store.days[date] || { date, sales: [] };
}

async function ensureCurrentDay() {
  const today = isoToday();
  const needsWrite = store.currentDay !== today || !store.days[today];
  store.currentDay = today;
  if (!store.days[today]) store.days[today] = { date: today, sales: [] };

  if (needsWrite) {
    await persistDayAndSettings(store.days[today], store.settings, today);
    broadcastUpdate("day");
  }

  el.dateText.textContent = formatTopDate(new Date());
  if (el.historyDate) el.historyDate.max = today;
}

async function handleClockOrVisibilityChange() {
  if (document.visibilityState === "hidden") return;
  const previousDay = store?.currentDay;
  try {
    await ensureCurrentDay();
    if (previousDay !== store.currentDay) {
      if (currentScreen === "hoy") renderHoy();
      if (currentScreen === "historial" && el.historyDate.value === previousDay) {
        el.historyDate.value = store.currentDay;
        renderHistory();
      }
      showToast("Cambió la fecha. Las ventas anteriores quedaron guardadas.");
    }
  } catch (error) {
    reportStorageError(error);
  }
}

/* -------------------------
   Estadísticas y pagos
------------------------- */

function paymentValueForSale(sale) {
  return VALID_PAYMENT_VALUES.has(sale.paymentMethod) ? sale.paymentMethod : LEGACY_PAYMENT.value;
}

function paymentLabel(value) {
  return PAYMENT_METHODS.find((method) => method.value === value)?.label || LEGACY_PAYMENT.label;
}

function computeDayStats(day) {
  const sales = Array.isArray(day?.sales) ? day.sales : [];
  const paymentTotals = Object.fromEntries(PAYMENT_METHODS.map((method) => [method.value, 0]));
  paymentTotals[LEGACY_PAYMENT.value] = 0;

  let total = 0;
  let itemsQty = 0;
  for (const sale of sales) {
    const saleTotal = Number(sale.total) || 0;
    total += saleTotal;
    paymentTotals[paymentValueForSale(sale)] += saleTotal;
    for (const item of sale.items || []) itemsQty += Number(item.qty) || 0;
  }

  const salesCount = sales.length;
  return {
    total,
    salesCount,
    itemsQty,
    average: salesCount ? total / salesCount : 0,
    paymentTotals,
  };
}

function renderPaymentSummary(container, paymentTotals) {
  container.replaceChildren();
  const methods = [...PAYMENT_METHODS];
  if ((paymentTotals[LEGACY_PAYMENT.value] || 0) > 0) methods.push(LEGACY_PAYMENT);

  for (const method of methods) {
    const wrapper = makeElement("div");
    const term = makeElement("dt", "", method.label);
    const value = makeElement("dd", "", money(paymentTotals[method.value] || 0));
    wrapper.append(term, value);
    container.appendChild(wrapper);
  }
}

/* -------------------------
   Navegación y render general
------------------------- */

async function navigateTo(screenName) {
  if (!el.screens[screenName]) return;
  if (screenName === "hoy" || screenName === "historial") await ensureCurrentDay();

  currentScreen = screenName;
  document.body.classList.toggle("saleMode", screenName === "venta");
  el.appHeader.hidden = screenName === "venta";
  el.mainNav.hidden = screenName === "venta";

  for (const [name, screen] of Object.entries(el.screens)) screen.hidden = name !== screenName;
  for (const button of el.mainNav.querySelectorAll("[data-screen]")) {
    const isActive = button.dataset.screen === screenName;
    button.classList.toggle("isActive", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  }

  if (screenName === "hoy") renderHoy();
  if (screenName === "historial") renderHistory();
  if (screenName === "productos") {
    resetProductForm();
    renderProductsUI();
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

function refreshAllUI() {
  refreshProductDependentUI();
  if (currentScreen === "hoy") renderHoy();
  if (currentScreen === "historial") renderHistory();
  if (currentScreen === "productos") renderProductsUI();
}

function renderHoy() {
  const day = getDayData(store.currentDay);
  const stats = computeDayStats(day);
  el.dateText.textContent = formatTopDate(new Date());
  el.totalDia.textContent = money(stats.total);
  el.kpiVentas.textContent = String(stats.salesCount);
  el.kpiItems.textContent = String(stats.itemsQty);
  el.kpiPromedio.textContent = money(stats.average);
  renderPaymentSummary(el.paymentSummaryHoy, stats.paymentTotals);
  renderSalesList({
    container: el.listaVentas,
    sales: day.sales,
    date: day.date,
    emptyNode: el.emptyVentas,
    countNode: el.latestSalesCount,
    limit: 10,
  });
  el.btnExportCSV.disabled = stats.salesCount === 0;
  el.btnCierre.disabled = stats.salesCount === 0;
}

function renderHistory() {
  const date = isISODate(el.historyDate.value) ? el.historyDate.value : store.currentDay;
  el.historyDate.value = date;
  const day = getDayData(date);
  const stats = computeDayStats(day);

  el.historyTotal.textContent = money(stats.total);
  el.historyPrettyDate.textContent = formatLongDate(date);
  el.historySales.textContent = String(stats.salesCount);
  el.historyItems.textContent = String(stats.itemsQty);
  el.historyAverage.textContent = money(stats.average);
  renderPaymentSummary(el.paymentSummaryHistory, stats.paymentTotals);
  renderSalesList({
    container: el.historySalesList,
    sales: day.sales,
    date,
    emptyNode: el.historyEmpty,
    countNode: el.historySalesCount,
  });

  el.historyNext.disabled = date >= isoToday();
  el.btnHistoryCSV.disabled = stats.salesCount === 0;
}

function renderSalesList({ container, sales, date, emptyNode, countNode, limit = Infinity }) {
  const sorted = [...(sales || [])].sort((a, b) => Number(b.ts) - Number(a.ts));
  const visible = sorted.slice(0, limit);
  container.replaceChildren();
  emptyNode.hidden = sorted.length > 0;
  countNode.textContent = plural(sorted.length, "venta", "ventas");

  for (const sale of visible) {
    const itemCount = (sale.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    const row = makeElement("button", "saleRow");
    row.type = "button";
    row.setAttribute("aria-label", `Ver venta de ${money(sale.total)} a las ${formatTime(sale.ts)}`);

    const main = makeElement("span", "saleRowMain");
    main.append(
      makeElement("strong", "", `${formatTime(sale.ts)} · ${plural(itemCount, "producto", "productos")}`),
      makeElement("span", "paymentBadge", paymentLabel(paymentValueForSale(sale)))
    );

    const amount = makeElement("span", "saleRowAmount");
    amount.append(
      makeElement("strong", "", money(sale.total)),
      makeElement("span", "saleRowMeta", "Ver detalle")
    );

    row.append(main, amount);
    row.addEventListener("click", () => openSaleDetail(sale, date));
    const item = makeElement("li");
    item.appendChild(row);
    container.appendChild(item);
  }
}

/* -------------------------
   Venta
------------------------- */

function getProducts() {
  return store.products;
}

function getCategories() {
  return [...new Set(getProducts().map((product) => product.category))]
    .sort((a, b) => a.localeCompare(b, "es"));
}

function productsByCategory(category) {
  return getProducts()
    .filter((product) => product.category === category)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function refreshProductDependentUI() {
  const categories = getCategories();
  const previousCategory = el.selCategoria.value;
  el.categoriesList.replaceChildren();
  el.selCategoria.replaceChildren(new Option("Elegí…", ""));

  for (const category of categories) {
    const listOption = document.createElement("option");
    listOption.value = category;
    el.categoriesList.appendChild(listOption);
    el.selCategoria.appendChild(new Option(category, category));
  }

  if (categories.includes(previousCategory)) el.selCategoria.value = previousCategory;
  renderProductsList();
}

function resetSaleForm() {
  cart = [];
  el.selCategoria.value = "";
  el.selProducto.replaceChildren(new Option("Elegí…", ""));
  el.selProducto.disabled = true;
  el.inpCantidad.value = "1";
  el.selPrecio.value = "unidad";
  setDocenaEnabled(false);
  el.saleNote.value = "";
  setFormError(el.saleFormError);
  const defaultPayment = VALID_PAYMENT_VALUES.has(store.settings.defaultPaymentMethod)
    ? store.settings.defaultPaymentMethod
    : "efectivo";
  const paymentInput = document.querySelector(`input[name="paymentMethod"][value="${defaultPayment}"]`);
  if (paymentInput) paymentInput.checked = true;
  renderCart();
}

function onCategoryChange() {
  const products = productsByCategory(el.selCategoria.value);
  el.selProducto.replaceChildren(new Option("Elegí…", ""));
  for (const product of products) el.selProducto.appendChild(new Option(product.name, product.id));
  el.selProducto.disabled = products.length === 0;
  el.btnAgregarItem.disabled = true;
  setDocenaEnabled(false);
  setFormError(el.saleFormError);
}

function getSelectedProduct() {
  return getProducts().find((product) => product.id === el.selProducto.value) || null;
}

function setDocenaEnabled(enabled) {
  const option = [...el.selPrecio.options].find((candidate) => candidate.value === "docena");
  if (option) option.disabled = !enabled;
  if (!enabled && el.selPrecio.value === "docena") el.selPrecio.value = "unidad";
}

function onProductChange() {
  const product = getSelectedProduct();
  const hasDocena = Boolean(product && isValidPrice(product.prices.docena));
  setDocenaEnabled(hasDocena);
  el.btnAgregarItem.disabled = !product;
  setFormError(el.saleFormError);
}

function readSaleQuantity() {
  const quantity = Number(el.inpCantidad.value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
    throw new Error(`La cantidad debe ser un número entero entre 1 y ${MAX_QTY}.`);
  }
  return quantity;
}

function addItemToCart() {
  setFormError(el.saleFormError);
  const product = getSelectedProduct();
  if (!product) {
    setFormError(el.saleFormError, "Elegí un producto.");
    return;
  }

  try {
    const qty = readSaleQuantity();
    const priceType = el.selPrecio.value === "docena" ? "docena" : "unidad";
    const unitPrice = Number(product.prices[priceType]);
    if (!isValidPrice(unitPrice)) throw new Error("Ese producto no tiene un precio válido para la opción elegida.");

    const existing = cart.find((item) => item.productId === product.id && item.priceType === priceType);
    if (existing) {
      if (existing.qty + qty > MAX_QTY) throw new Error(`La cantidad total no puede superar ${MAX_QTY}.`);
      existing.qty += qty;
      existing.lineTotal = existing.qty * existing.unitPrice;
    } else {
      cart.push({
        id: uid("it"),
        productId: product.id,
        name: product.name,
        category: product.category,
        priceType,
        unitPrice,
        qty,
        lineTotal: qty * unitPrice,
      });
    }

    el.inpCantidad.value = "1";
    renderCart();
  } catch (error) {
    setFormError(el.saleFormError, error.message);
  }
}

function cartTotal() {
  return cart.reduce((sum, item) => sum + item.lineTotal, 0);
}

function cartQuantity() {
  return cart.reduce((sum, item) => sum + item.qty, 0);
}

function renderCart() {
  el.listaItems.replaceChildren();
  el.hintVacio.hidden = cart.length > 0;

  for (const item of cart) {
    const row = makeElement("li");
    const info = makeElement("div", "cartItemInfo");
    info.append(
      makeElement("span", "cartItemName", item.name),
      makeElement(
        "span",
        "cartItemMeta",
        `${item.qty} × ${money(item.unitPrice)} · ${item.priceType === "docena" ? "Docena" : "Unidad"}`
      )
    );

    const controls = makeElement("div", "cartControls");
    const subtotal = makeElement("strong", "cartLineTotal", money(item.lineTotal));
    const minus = makeElement("button", "miniBtn", "−");
    minus.type = "button";
    minus.setAttribute("aria-label", `Restar uno de ${item.name}`);
    minus.disabled = item.qty <= 1;
    minus.addEventListener("click", () => {
      item.qty -= 1;
      item.lineTotal = item.qty * item.unitPrice;
      renderCart();
    });

    const plus = makeElement("button", "miniBtn", "+");
    plus.type = "button";
    plus.setAttribute("aria-label", `Sumar uno de ${item.name}`);
    plus.disabled = item.qty >= MAX_QTY;
    plus.addEventListener("click", () => {
      item.qty += 1;
      item.lineTotal = item.qty * item.unitPrice;
      renderCart();
    });

    const remove = makeElement("button", "miniBtn danger", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Eliminar ${item.name} del ticket`);
    remove.addEventListener("click", () => {
      cart = cart.filter((candidate) => candidate.id !== item.id);
      renderCart();
    });

    controls.append(subtotal, minus, plus, remove);
    row.append(info, controls);
    el.listaItems.appendChild(row);
  }

  const total = cartTotal();
  el.totalTicket.textContent = money(total);
  el.stickyTotal.textContent = money(total);
  el.saleItemCount.textContent = String(cartQuantity());
  el.btnGuardarVenta.disabled = cart.length === 0 || isSavingSale;
}

async function startNewSale() {
  await ensureCurrentDay();
  resetSaleForm();
  await navigateTo("venta");
}

async function cancelSale() {
  if (cart.length > 0) {
    const accepted = await askConfirmation({
      title: "Descartar ticket",
      message: "Los productos de este ticket todavía no fueron guardados. Las ventas anteriores no se modificarán.",
      confirmText: "Descartar",
      danger: true,
    });
    if (!accepted) return;
  }
  cart = [];
  await navigateTo("hoy");
}

function selectedPaymentMethod() {
  const selected = document.querySelector('input[name="paymentMethod"]:checked');
  return VALID_PAYMENT_VALUES.has(selected?.value) ? selected.value : null;
}

async function saveSale() {
  if (isSavingSale || cart.length === 0) return;
  const paymentMethod = selectedPaymentMethod();
  if (!paymentMethod) {
    showToast("Elegí un método de pago.", "error");
    return;
  }

  isSavingSale = true;
  el.btnGuardarVenta.disabled = true;
  el.btnGuardarVenta.textContent = "Guardando…";

  try {
    await withStorageLock(async () => {
      const saleDate = isoToday();
      const freshestDay = storageMode === "indexeddb"
        ? await readDayFromDatabase(saleDate)
        : (readFallbackStore()?.days?.[saleDate] || getDayData(saleDate));
      const note = cleanText(el.saleNote.value, 180);
      const sale = {
        id: uid("s"),
        ts: Date.now(),
        items: cart.map((item) => cloneData(item)),
        total: cartTotal(),
        paymentMethod,
        ...(note ? { note } : {}),
      };

      const nextDay = {
        date: saleDate,
        sales: [...(freshestDay.sales || []), sale],
      };
      const nextSettings = { ...store.settings, defaultPaymentMethod: paymentMethod };

      await persistDayAndSettings(nextDay, nextSettings, saleDate);
      store.currentDay = saleDate;
      store.days[saleDate] = nextDay;
      store.settings = nextSettings;
    });

    cart = [];
    broadcastUpdate("sale");
    requestPersistentStorage();
    await navigateTo("hoy");
    showToast("Venta guardada.");
  } catch (error) {
    reportStorageError(error);
    showToast("La venta no se guardó. El ticket sigue abierto.", "error");
  } finally {
    isSavingSale = false;
    el.btnGuardarVenta.textContent = "Guardar venta";
    renderCart();
  }
}

/* -------------------------
   Productos
------------------------- */

function resetProductForm() {
  editingProductId = null;
  el.productForm.reset();
  el.productFormTitle.textContent = "Nuevo producto";
  el.btnSaveProduct.textContent = "Guardar producto";
  el.btnCancelProductEdit.hidden = true;
  setFormError(el.productFormError);
}

function readProductForm() {
  const category = cleanText(el.prodCategory.value, 50);
  const name = cleanText(el.prodName.value, 80);
  const unidadRaw = el.prodPriceUnidad.value.trim();
  const docenaRaw = el.prodPriceDocena.value.trim();
  const unidad = Number(unidadRaw);
  const docena = docenaRaw ? Number(docenaRaw) : 0;

  if (!category) throw new Error("Ingresá una categoría.");
  if (!name) throw new Error("Ingresá un nombre.");
  if (!unidadRaw || !isValidPrice(unidad)) throw new Error("Ingresá un precio por unidad válido.");
  if (docenaRaw && !isValidPrice(docena)) throw new Error("El precio por docena no es válido.");

  const duplicate = getProducts().find((product) =>
    product.id !== editingProductId &&
    product.category.localeCompare(category, "es", { sensitivity: "base" }) === 0 &&
    product.name.localeCompare(name, "es", { sensitivity: "base" }) === 0
  );
  if (duplicate) throw new Error("Ya existe un producto con ese nombre en la misma categoría.");

  return {
    category,
    name,
    prices: { unidad, ...(docenaRaw ? { docena } : {}) },
  };
}

async function saveProductFromForm(event) {
  event.preventDefault();
  setFormError(el.productFormError);
  el.btnSaveProduct.disabled = true;

  try {
    const wasEditing = Boolean(editingProductId);
    const payload = readProductForm();
    const nextProducts = cloneData(getProducts());
    if (editingProductId) {
      const index = nextProducts.findIndex((product) => product.id === editingProductId);
      if (index < 0) throw new Error("El producto ya no existe.");
      nextProducts[index] = { ...nextProducts[index], ...payload };
    } else {
      nextProducts.push({ id: uid("p"), ...payload });
    }

    const normalized = normalizeProducts(nextProducts, true);
    await persistProducts(normalized);
    store.products = normalized;
    broadcastUpdate("products");
    resetProductForm();
    refreshProductDependentUI();
    showToast(wasEditing ? "Producto actualizado." : "Producto guardado.");
  } catch (error) {
    setFormError(el.productFormError, error.message);
  } finally {
    el.btnSaveProduct.disabled = false;
  }
}

function startEditProduct(productId) {
  const product = getProducts().find((candidate) => candidate.id === productId);
  if (!product) return;
  editingProductId = product.id;
  el.prodCategory.value = product.category;
  el.prodName.value = product.name;
  el.prodPriceUnidad.value = String(product.prices.unidad);
  el.prodPriceDocena.value = product.prices.docena ? String(product.prices.docena) : "";
  el.productFormTitle.textContent = "Editar producto";
  el.btnSaveProduct.textContent = "Guardar cambios";
  el.btnCancelProductEdit.hidden = false;
  setFormError(el.productFormError);
  el.productForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteProduct(productId) {
  const product = getProducts().find((candidate) => candidate.id === productId);
  if (!product) return;
  const accepted = await askConfirmation({
    title: "Eliminar producto",
    message:
      `Se quitará “${product.name}” del catálogo. Las ventas históricas conservarán su nombre y precio originales.`,
    confirmText: "Eliminar",
    danger: true,
  });
  if (!accepted) return;

  try {
    const nextProducts = getProducts().filter((candidate) => candidate.id !== productId);
    await persistProducts(nextProducts);
    store.products = nextProducts;
    if (editingProductId === productId) resetProductForm();
    broadcastUpdate("products");
    refreshProductDependentUI();
    showToast("Producto eliminado del catálogo.");
  } catch (error) {
    reportStorageError(error);
    showToast("No se pudo eliminar el producto.", "error");
  }
}

function renderProductsUI() {
  renderProductsList();
  el.productsCount.textContent = String(getProducts().length);
}

function renderProductsList() {
  const products = [...getProducts()].sort((a, b) => {
    const categoryOrder = a.category.localeCompare(b.category, "es");
    return categoryOrder || a.name.localeCompare(b.name, "es");
  });
  el.listaProductos.replaceChildren();
  el.hintProductosVacio.hidden = products.length > 0;
  el.productsCount.textContent = String(products.length);

  for (const product of products) {
    const item = makeElement("li");
    const info = makeElement("div", "productInfo");
    const prices = `Unidad: ${money(product.prices.unidad)}${product.prices.docena ? ` · Docena: ${money(product.prices.docena)}` : ""}`;
    info.append(
      makeElement("span", "productName", product.name),
      makeElement("span", "productMeta", `${product.category} · ${prices}`)
    );

    const controls = makeElement("div", "rightControls");
    const edit = makeElement("button", "miniBtn", "Editar");
    edit.type = "button";
    edit.setAttribute("aria-label", `Editar ${product.name}`);
    edit.addEventListener("click", () => startEditProduct(product.id));
    const remove = makeElement("button", "miniBtn danger", "Borrar");
    remove.type = "button";
    remove.setAttribute("aria-label", `Borrar ${product.name}`);
    remove.addEventListener("click", () => deleteProduct(product.id));
    controls.append(edit, remove);
    item.append(info, controls);
    el.listaProductos.appendChild(item);
  }
}

/* -------------------------
   Backups e importaciones
------------------------- */

function filenameDateTime() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function downloadFile(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildFullBackup() {
  return {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    appSchemaVersion: STORE_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      currentDay: store.currentDay,
      products: cloneData(store.products),
      days: cloneData(store.days),
      settings: cloneData(store.settings),
    },
  };
}

function exportFullBackup(prefix = "backup-sandwicheria") {
  const backup = buildFullBackup();
  downloadFile(
    `${prefix}-${filenameDateTime()}.json`,
    JSON.stringify(backup, null, 2),
    "application/json;charset=utf-8"
  );
}

function exportProductsJSON() {
  const data = {
    format: "sandwicheria-products",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    products: cloneData(store.products),
  };
  downloadFile(
    `productos-${filenameDateTime()}.json`,
    JSON.stringify(data, null, 2),
    "application/json;charset=utf-8"
  );
}

async function readJSONFile(file) {
  if (!file) throw new Error("No se seleccionó ningún archivo.");
  if (file.size > MAX_IMPORT_BYTES) throw new Error("El archivo es demasiado grande.");
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("El archivo no contiene JSON válido.");
  }
}

function validateFullBackup(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("El backup no tiene una estructura válida.");
  }
  if (parsed.format !== BACKUP_FORMAT) throw new Error("El archivo no es un backup completo de esta aplicación.");
  if (parsed.backupVersion !== BACKUP_VERSION) {
    throw new Error(`Versión de backup no compatible: ${parsed.backupVersion ?? "desconocida"}.`);
  }
  if (!parsed.exportedAt || Number.isNaN(new Date(parsed.exportedAt).getTime())) {
    throw new Error("El backup no tiene una fecha de exportación válida.");
  }

  const normalized = normalizeStore(parsed.data, { strict: true, useDefaults: false });
  normalized.currentDay = isoToday();
  if (!normalized.days[normalized.currentDay]) {
    normalized.days[normalized.currentDay] = { date: normalized.currentDay, sales: [] };
  }
  return normalized;
}

async function restoreFullBackup(file) {
  const parsed = await readJSONFile(file);
  const nextStore = validateFullBackup(parsed);
  const dates = Object.keys(nextStore.days).sort();
  const salesCount = Object.values(nextStore.days).reduce((sum, day) => sum + day.sales.length, 0);
  const range = dates.length
    ? `Fechas incluidas: ${dates[0]} a ${dates.at(-1)}.`
    : "No incluye días con ventas.";

  const hasCurrentStore = Boolean(store);
  const accepted = await askConfirmation({
    title: "Restaurar backup completo",
    message:
      `Este archivo contiene ${plural(nextStore.products.length, "producto", "productos")} y ${plural(salesCount, "venta", "ventas")}. ${range}\n\n` +
      (hasCurrentStore
        ? "Reemplazará los datos actuales. Antes se descargará automáticamente una copia de seguridad de lo que tenés ahora."
        : "Se usará para recuperar una instalación cuyos datos actuales no pudieron abrirse."),
    confirmText: "Restaurar",
    danger: true,
    requirePhrase: "RESTAURAR",
  });
  if (!accepted) return;

  if (hasCurrentStore) exportFullBackup("backup-antes-de-restaurar");
  await persistCompleteStore(nextStore);
  store = nextStore;
  storageIssue = "";
  el.loadingState.hidden = true;
  el.btnStartupRestore.hidden = true;
  refreshStatusBanner();
  broadcastUpdate("restore");
  refreshAllUI();
  await navigateTo("hoy");
  showToast("Backup restaurado correctamente.");
}

async function importProductsJSON(file) {
  const parsed = await readJSONFile(file);
  const source = Array.isArray(parsed) ? parsed : parsed?.products;
  const nextProducts = normalizeProducts(source, true);
  const accepted = await askConfirmation({
    title: "Importar productos",
    message:
      `Se reemplazará el catálogo actual de ${plural(store.products.length, "producto", "productos")} por ${plural(nextProducts.length, "producto", "productos")}. Las ventas no se modificarán.`,
    confirmText: "Importar",
  });
  if (!accepted) return;

  await persistProducts(nextProducts);
  store.products = nextProducts;
  resetProductForm();
  broadcastUpdate("products");
  refreshProductDependentUI();
  showToast("Productos importados correctamente.");
}

/* -------------------------
   CSV
------------------------- */

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCSV(date) {
  const day = getDayData(date);
  if (!day.sales.length) {
    showToast("No hay ventas para exportar en esa fecha.", "error");
    return;
  }

  const headers = [
    "fecha", "hora", "venta_id", "metodo_pago", "nota", "categoria", "producto",
    "tipo_precio", "cantidad", "precio_unitario", "subtotal", "total_venta",
  ];
  const rows = [headers.map(csvCell).join(";")];

  for (const sale of day.sales) {
    for (const item of sale.items) {
      rows.push([
        day.date,
        formatTime(sale.ts),
        sale.id,
        paymentLabel(paymentValueForSale(sale)),
        sale.note || "",
        item.category,
        item.name,
        item.priceType,
        item.qty,
        item.unitPrice,
        item.lineTotal,
        sale.total,
      ].map(csvCell).join(";"));
    }
  }

  downloadFile(
    `ventas-${date}.csv`,
    `\uFEFF${rows.join("\r\n")}`,
    "text/csv;charset=utf-8"
  );
  showToast("CSV preparado.");
}

/* -------------------------
   Diálogos y detalles
------------------------- */

function finishConfirmation(result) {
  const resolver = confirmResolver;
  confirmResolver = null;
  if (el.confirmDialog.open) el.confirmDialog.close();
  resolver?.(result);
}

function askConfirmation({
  title,
  message,
  confirmText = "Confirmar",
  danger = false,
  requirePhrase = "",
}) {
  if (typeof el.confirmDialog.showModal !== "function") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  if (confirmResolver) finishConfirmation(false);
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmAccept.textContent = confirmText;
  el.confirmAccept.classList.toggle("danger", danger);
  confirmPhrase = requirePhrase;
  el.confirmPhraseField.hidden = !requirePhrase;
  el.confirmPhraseInput.value = "";
  el.confirmPhraseLabel.textContent = requirePhrase ? `Escribí ${requirePhrase} para continuar` : "";
  el.confirmAccept.disabled = Boolean(requirePhrase);
  el.confirmDialog.showModal();
  if (requirePhrase) el.confirmPhraseInput.focus();

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function openInfoDialog({ eyebrow = "Detalle", title, render, actionLabel = "", onAction = null }) {
  el.infoEyebrow.textContent = eyebrow;
  el.infoTitle.textContent = title;
  el.infoBody.replaceChildren();
  render(el.infoBody);
  el.infoAction.hidden = !actionLabel;
  el.infoAction.textContent = actionLabel;
  el.infoAction.onclick = onAction;

  if (typeof el.infoDialog.showModal === "function") {
    el.infoDialog.showModal();
  } else {
    el.infoDialog.setAttribute("open", "");
  }
}

function appendStatsGrid(container, stats) {
  const grid = makeElement("section", "statsGrid dialogStats");
  const entries = [
    ["Ventas", stats.salesCount],
    ["Productos", stats.itemsQty],
    ["Promedio", money(stats.average)],
  ];
  for (const [label, value] of entries) {
    const card = makeElement("article", "statCard");
    card.append(makeElement("p", "statLabel", label), makeElement("p", "statValue", String(value)));
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

function appendPaymentDetails(container, paymentTotals) {
  const heading = makeElement("div", "sectionHeading");
  heading.appendChild(makeElement("h2", "", "Métodos de pago"));
  const summary = makeElement("dl", "paymentSummary");
  renderPaymentSummary(summary, paymentTotals);
  container.append(heading, summary);
}

function openSaleDetail(sale, date) {
  openInfoDialog({
    eyebrow: formatLongDate(date),
    title: `Venta · ${formatTime(sale.ts)}`,
    render(container) {
      const hero = makeElement("div", "detailHero");
      hero.append(
        makeElement("span", "", paymentLabel(paymentValueForSale(sale))),
        makeElement("strong", "", money(sale.total))
      );
      const list = makeElement("ul", "detailList");
      for (const item of sale.items || []) {
        const row = makeElement("li");
        const description = makeElement("span");
        description.append(
          makeElement("strong", "", `${item.qty} × ${item.name}`),
          document.createTextNode(` · ${item.priceType === "docena" ? "Docena" : "Unidad"}`)
        );
        row.append(description, makeElement("span", "", money(item.lineTotal)));
        list.appendChild(row);
      }
      container.append(hero, list);
      if (sale.note) {
        container.appendChild(makeElement("p", "detailNote", `Nota: ${sale.note}`));
      }
    },
  });
}

function openCloseSummary(date) {
  const day = getDayData(date);
  const stats = computeDayStats(day);
  openInfoDialog({
    eyebrow: "Cierre de caja",
    title: formatLongDate(date),
    render(container) {
      const hero = makeElement("div", "detailHero");
      hero.append(
        makeElement("span", "", "Facturación total"),
        makeElement("strong", "", money(stats.total))
      );
      container.appendChild(hero);
      appendStatsGrid(container, stats);
      appendPaymentDetails(container, stats.paymentTotals);
    },
    actionLabel: "Descargar CSV del día",
    onAction: () => exportCSV(date),
  });
}

/* -------------------------
   Estado online, errores y PWA
------------------------- */

function refreshStatusBanner() {
  const offline = !navigator.onLine;
  el.connectionDot.classList.toggle("isOffline", offline);

  if (storageIssue) {
    el.appStatus.hidden = false;
    el.appStatus.classList.add("isError");
    el.appStatusText.textContent = storageIssue;
    el.appStatusAction.hidden = false;
    el.appStatusAction.textContent = "Backup";
    el.appStatusAction.onclick = () => {
      if (store) exportFullBackup("backup-emergencia");
    };
    return;
  }

  el.appStatus.classList.remove("isError");
  if (pendingServiceWorker) {
    el.appStatus.hidden = false;
    el.appStatusText.textContent = "Hay una versión nueva lista.";
    el.appStatusAction.hidden = false;
    el.appStatusAction.textContent = "Actualizar";
    el.appStatusAction.onclick = activatePendingUpdate;
    return;
  }

  if (offline) {
    el.appStatus.hidden = false;
    el.appStatusText.textContent = "Sin conexión. Podés seguir trabajando normalmente.";
    el.appStatusAction.hidden = true;
    return;
  }

  el.appStatus.hidden = true;
  el.appStatusAction.hidden = true;
}

function reportStorageError(error) {
  console.error(error);
  storageIssue = "No se pudo guardar. Descargá un backup y no cierres la aplicación hasta resolverlo.";
  refreshStatusBanner();
}

async function activatePendingUpdate() {
  if (!pendingServiceWorker) return;
  if (cart.length) {
    const accepted = await askConfirmation({
      title: "Actualizar aplicación",
      message: "El ticket actual todavía no está guardado. Si actualizás ahora, se descartará.",
      confirmText: "Actualizar",
      danger: true,
    });
    if (!accepted) return;
  }
  pendingServiceWorker.postMessage({ type: "SKIP_WAITING" });
}

function markServiceWorkerWaiting(worker) {
  pendingServiceWorker = worker;
  refreshStatusBanner();
}

async function initializeServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  try {
    const registration = await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
      updateViaCache: "none",
    });
    if (registration.waiting) markServiceWorkerWaiting(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          markServiceWorkerWaiting(worker);
        }
      });
    });
    registration.update().catch(() => {});
    window.setInterval(() => registration.update().catch(() => {}), 60 * 60 * 1000);
  } catch (error) {
    console.warn("No se pudo registrar el Service Worker.", error);
  }
}

/* -------------------------
   Eventos e inicio
------------------------- */

function bindEvents() {
  for (const button of el.mainNav.querySelectorAll("[data-screen]")) {
    button.addEventListener("click", () => navigateTo(button.dataset.screen));
  }

  el.btnNuevaVenta.addEventListener("click", startNewSale);
  el.btnExportCSV.addEventListener("click", () => exportCSV(store.currentDay));
  el.btnCierre.addEventListener("click", () => openCloseSummary(store.currentDay));

  el.historyDate.addEventListener("change", () => {
    if (!isISODate(el.historyDate.value) || el.historyDate.value > isoToday()) {
      el.historyDate.value = store.currentDay;
    }
    renderHistory();
  });
  el.historyPrev.addEventListener("click", () => {
    el.historyDate.value = shiftISODate(el.historyDate.value || store.currentDay, -1);
    renderHistory();
  });
  el.historyNext.addEventListener("click", () => {
    const next = shiftISODate(el.historyDate.value || store.currentDay, 1);
    el.historyDate.value = next > isoToday() ? isoToday() : next;
    renderHistory();
  });
  el.btnHistoryCSV.addEventListener("click", () => exportCSV(el.historyDate.value));

  el.btnCancelarVenta.addEventListener("click", cancelSale);
  el.selCategoria.addEventListener("change", onCategoryChange);
  el.selProducto.addEventListener("change", onProductChange);
  el.btnAgregarItem.addEventListener("click", addItemToCart);
  el.inpCantidad.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !el.btnAgregarItem.disabled) {
      event.preventDefault();
      addItemToCart();
    }
  });
  el.btnGuardarVenta.addEventListener("click", saveSale);

  el.productForm.addEventListener("submit", saveProductFromForm);
  el.btnCancelProductEdit.addEventListener("click", resetProductForm);
  el.btnExportBackup.addEventListener("click", () => exportFullBackup());
  el.btnImportBackup.addEventListener("click", () => el.fileImportBackup.click());
  el.btnStartupRestore.addEventListener("click", () => el.fileImportBackup.click());
  el.fileImportBackup.addEventListener("change", async () => {
    const file = el.fileImportBackup.files?.[0];
    el.fileImportBackup.value = "";
    if (!file) return;
    try {
      await restoreFullBackup(file);
    } catch (error) {
      showToast(`No se restauró nada: ${error.message}`, "error");
    }
  });

  el.btnExportProductos.addEventListener("click", exportProductsJSON);
  el.btnImportProductos.addEventListener("click", () => el.fileImportProductos.click());
  el.fileImportProductos.addEventListener("change", async () => {
    const file = el.fileImportProductos.files?.[0];
    el.fileImportProductos.value = "";
    if (!file) return;
    try {
      await importProductsJSON(file);
    } catch (error) {
      showToast(`No se importó nada: ${error.message}`, "error");
    }
  });

  el.confirmCancel.addEventListener("click", () => finishConfirmation(false));
  el.confirmAccept.addEventListener("click", () => finishConfirmation(true));
  el.confirmPhraseInput.addEventListener("input", () => {
    el.confirmAccept.disabled = el.confirmPhraseInput.value.trim().toLocaleUpperCase("es-AR") !== confirmPhrase;
  });
  el.confirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishConfirmation(false);
  });
  el.confirmDialog.addEventListener("close", () => {
    if (confirmResolver) finishConfirmation(false);
  });

  el.infoClose.addEventListener("click", () => el.infoDialog.close());
  el.infoDialog.addEventListener("click", (event) => {
    if (event.target === el.infoDialog) el.infoDialog.close();
  });

  window.addEventListener("online", refreshStatusBanner);
  window.addEventListener("offline", refreshStatusBanner);
  window.addEventListener("focus", handleClockOrVisibilityChange);
  document.addEventListener("visibilitychange", handleClockOrVisibilityChange);
  window.setInterval(handleClockOrVisibilityChange, 60 * 1000);
}

async function init() {
  collectDomReferences();
  bindEvents();
  el.appVersion.textContent = APP_VERSION;
  refreshStatusBanner();
  initializeServiceWorker();

  try {
    await initializeStorage();
    await ensureCurrentDay();
    initializeCrossTabUpdates();
    el.historyDate.value = store.currentDay;
    refreshProductDependentUI();
    el.loadingState.hidden = true;
    await navigateTo("hoy");
  } catch (error) {
    console.error(error);
    storageIssue = "No se pudieron abrir los datos existentes. No se modificó ni borró ninguna venta.";
    refreshStatusBanner();
    el.loadingMessage.textContent =
      `La aplicación se detuvo para proteger tus datos. ${error.message} Restaurá un backup o revisá el almacenamiento del navegador antes de continuar.`;
    el.btnStartupRestore.hidden = !storageMode;
  }
}

document.addEventListener("DOMContentLoaded", init);
