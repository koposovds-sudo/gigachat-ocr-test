'use strict';

const https = require('https');

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || 'https://koposovds-sudo.github.io';

const TRONK_API_KEY = process.env.TRONK_API_KEY || '';
const YC_FOLDER_ID  = process.env.YC_FOLDER_ID  || '';
const VISION_API_KEY = process.env.VISION_API_KEY || '';

/*
 * Языковая модель для интеллектуального разбора распознанного текста.
 * Ключ можно задать отдельно (LLM_API_KEY) или использовать тот же, что у Vision.
 * Сервисному аккаунту ключа нужна роль ai.languageModels.user.
 */
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.VISION_API_KEY || '';
const LLM_MODEL   = process.env.LLM_MODEL   || 'yandexgpt/latest';
const LLM_ENABLED = String(process.env.LLM_ENABLED ?? 'true').toLowerCase() !== 'false';

const REQUEST_TIMEOUT_MS = 15000;
const OCR_TIMEOUT_MS     = 30000;
const LLM_TIMEOUT_MS     = 30000;
const MAX_BASE64_LENGTH  = 14 * 1024 * 1024;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(payload),
  };
}

/*
 * Поддерживает два формата входных данных:
 * 1) тестер Yandex Cloud: action лежит прямо в event;
 * 2) HTTP-вызов сайта: JSON лежит строкой в event.body.
 */
function parseEventBody(event) {
  if (!event) return {};
  if (event.action) return event;

  if (event.body === undefined || event.body === null || event.body === '') {
    return {};
  }

  if (typeof event.body === 'object') return event.body;

  try {
    return JSON.parse(event.body);
  } catch {
    const error = new Error('Тело запроса должно быть корректным JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function normalizePlate(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^АВЕКМНОРСТУХABEKMHOPCTYX0-9]/g, '');
}

function formatPlate(value) {
  const plate = normalizePlate(value);
  const match = plate.match(
    /^([АВЕКМНОРСТУХABEKMHOPCTYX])(\d{3})([АВЕКМНОРСТУХABEKMHOPCTYX]{2})(\d{2,3})$/
  );
  if (!match) return plate || null;
  return `${match[1]}${match[2]}${match[3]} ${match[4]}`;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function pick(object, ...keys) {
  const source = asObject(object);
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function unwrapTronkResponse(data) {
  const source = asObject(data);
  for (const key of ['result', 'data', 'response', 'vehicle']) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      return source[key];
    }
  }
  return source;
}

/* Текст ошибки внешнего сервиса — для диагностики в ответе функции. */
function describeProviderError(error) {
  const provider = error?.providerResponse;
  if (!provider) return null;
  if (typeof provider === 'string') return provider.slice(0, 500);
  const message = provider.message || provider.error_message || provider.raw || null;
  if (message) return String(message).slice(0, 500);
  try {
    return JSON.stringify(provider).slice(0, 500);
  } catch {
    return null;
  }
}

function sanitizeError(error) {
  return {
    name:       error?.name       || 'Error',
    message:    error?.message    || 'Unknown error',
    statusCode: error?.statusCode || 500,
  };
}

/* ─────────────────── HTTP helpers ─────────────────── */

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;

    const finish = (cb, val) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      cb(val);
    };

    const request = https.get(
      url,
      { headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'dkp-gigachat-proxy/1.0' } },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data',  (chunk) => { raw += chunk; });
        response.on('error', (err)   => { finish(reject, err); });
        response.on('end', () => {
          let data;
          try { data = raw ? JSON.parse(raw) : {}; }
          catch { data = { raw }; }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(`Внешний сервис вернул HTTP ${response.statusCode}.`);
            error.statusCode = 502;
            error.providerResponse = data;
            finish(reject, error);
            return;
          }
          finish(resolve, data);
        });
      }
    );

    timer = setTimeout(() => {
      const error = new Error(`Превышено время ожидания внешнего сервиса (${REQUEST_TIMEOUT_MS / 1000} с).`);
      error.statusCode = 504;
      request.destroy(error);
      finish(reject, error);
    }, REQUEST_TIMEOUT_MS);

    request.on('error', (err) => { finish(reject, err); });
  });
}

function httpPostJson(url, body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const payload   = JSON.stringify(body || {});
    const parsedUrl = new URL(url);

    let finished = false;
    let timer;

    const finish = (cb, val) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      cb(val);
    };

    const request = https.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || 443,
        path:     `${parsedUrl.pathname}${parsedUrl.search}`,
        method:   'POST',
        headers: {
          Accept:           'application/json, text/plain, */*',
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent':     'dkp-gigachat-proxy/1.0',
          ...headers,
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data',  (chunk) => { raw += chunk; });
        response.on('error', (err)   => { finish(reject, err); });
        response.on('end', () => {
          let data;
          try { data = raw ? JSON.parse(raw) : {}; }
          catch { data = { raw }; }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(response.statusCode === 429
              ? 'Сервис распознавания ограничил частоту запросов (HTTP 429). Подождите несколько секунд и повторите.'
              : `Внешний сервис вернул HTTP ${response.statusCode}.`);
            error.statusCode = 502;
            error.providerStatus = response.statusCode;
            error.providerResponse = data;
            finish(reject, error);
            return;
          }
          finish(resolve, data);
        });
      }
    );

    timer = setTimeout(() => {
      const error = new Error(`Превышено время ожидания OCR (${timeoutMs / 1000} с).`);
      error.statusCode = 504;
      request.destroy(error);
      finish(reject, error);
    }, timeoutMs);

    request.on('error', (err) => { finish(reject, err); });
    request.write(payload);
    request.end();
  });
}

/* ─────────────────── Tronk helpers ─────────────────── */

async function tronkGet(endpoint, params) {
  if (!TRONK_API_KEY) {
    const error = new Error('Не задана переменная окружения TRONK_API_KEY.');
    error.statusCode = 500;
    throw error;
  }

  const url = new URL(`https://data.tronk.info/${endpoint}`);
  url.searchParams.set('key', TRONK_API_KEY);

  for (const [name, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(name, String(value));
    }
  }

  return httpGetJson(url);
}

function checkPlate(plateInput) {
  const plate = normalizePlate(plateInput);
  if (!plate) {
    const error = new Error('Укажите госномер автомобиля.');
    error.statusCode = 400;
    throw error;
  }
  return plate;
}

/*
 * Фактический формат reportnewcheck:
 * полезная запись находится в raw.result.
 * Исторические совпадения из resultlist намеренно не используются.
 */
function makePreviewVehicle(reportRaw) {
  const outer  = asObject(reportRaw);
  const report = asObject(outer.result);

  return {
    vin: pick(report, 'Vin', 'vin', 'VIN', 'vin_number', 'vinNumber') ||
         pick(outer,  'vin', 'Vin', 'VIN'),

    brand: pick(report, 'Marka', 'marka', 'Brand', 'brand', 'Make', 'make', 'mark', 'manufacturer'),
    model: pick(report, 'Model', 'model', 'model_name'),
    year:  pick(report, 'Year',  'year',  'production_year', 'manufacture_year'),
    color: pick(report, 'Color', 'color', 'Colour', 'colour'),

    engineVolume: pick(report, 'Volume', 'volume', 'EngineVolume', 'engineVolume', 'engine_volume'),
    powerHp:      pick(report, 'HorsePower', 'horsePower', 'PowerHp', 'powerHp', 'power_hp', 'power', 'horsepower'),

    imageUrl: pick(report, 'Image', 'image', 'ImageUrl', 'imageUrl', 'image_url', 'photo'),
  };
}

function makeFullVehicle(reportRaw, registryRaw) {
  const preview  = makePreviewVehicle(reportRaw);
  const registry = unwrapTronkResponse(registryRaw);

  return {
    vin: pick(registry, 'vin', 'Vin', 'VIN', 'vin_number', 'vinNumber') || preview.vin,

    brand: preview.brand || pick(registry, 'brand', 'Brand', 'make', 'Make', 'mark', 'Marka', 'manufacturer'),
    model: preview.model || pick(registry, 'model', 'Model', 'model_name'),
    year:  preview.year  || pick(registry, 'year',  'Year',  'production_year', 'manufacture_year'),
    color: preview.color || pick(registry, 'color', 'Color', 'colour', 'Colour'),

    engineVolume: preview.engineVolume || pick(registry, 'engineVolume', 'EngineVolume', 'engine_volume', 'volume', 'Volume'),
    powerHp:      preview.powerHp      || pick(registry, 'powerHp', 'PowerHp', 'power_hp', 'power', 'HorsePower', 'horsepower'),

    imageUrl: preview.imageUrl,

    bodyNumber:       pick(registry, 'body_number',      'BodyNumber',       'bodyNumber',       'body',    'number_body'),
    chassisNumber:    pick(registry, 'chassis_number',   'ChassisNumber',    'chassisNumber',    'chassis', 'number_chassis'),
    sts:              pick(registry, 'sts',               'STS',              'sts_number',       'StsNumber',   'stsNumber',   'certificate'),
    category:         pick(registry, 'category',          'Category',         'vehicle_category'),
    recordStatus:     pick(registry, 'record_status',    'RecordStatus',     'recordStatus',     'registration_status', 'status', 'Status'),
    registrationDate: pick(registry, 'registration_date','RegistrationDate', 'registrationDate', 'reg_date'),
  };
}

/* ─────────────────── Vehicle actions ─────────────────── */

async function lookupVehicle(plateInput) {
  const plate     = checkPlate(plateInput);
  const reportRaw = await tronkGet('reportnewcheck.ashx', { gosnumber: plate });
  return { ok: true, mode: 'vehicle_lookup', plate: formatPlate(plate), vehicle: makePreviewVehicle(reportRaw), source: 'Tronk: предварительная проверка' };
}

async function lookupVehiclePreview(plateInput) {
  const plate = checkPlate(plateInput);
  const raw   = await tronkGet('reportnewcheck.ashx', { gosnumber: plate });
  return { ok: true, mode: 'vehicle_lookup_preview', plate: formatPlate(plate), vehicle: makePreviewVehicle(raw), raw };
}

async function lookupVehicleRegistry(plateInput) {
  const plate = checkPlate(plateInput);
  const raw   = await tronkGet('convertb2b.ashx', { gosnumber: plate });
  return {
    ok:        true,
    mode:      'vehicle_lookup_registry',
    plate:     formatPlate(plate),
    available: raw.error !== true,
    message:   raw.error === true ? (raw.error_msg || 'Регистрационные данные не найдены.') : null,
    raw,
  };
}

/*
 * Полный поиск:
 * - reportnewcheck обязателен и возвращает карточку ТС;
 * - convertb2b — дополнительный источник;
 * - convertgate — резервный запрос, если нет VIN из convertb2b.
 */
async function lookupVehicleFull(plateInput) {
  const plate      = checkPlate(plateInput);
  const previewRaw = await tronkGet('reportnewcheck.ashx', { gosnumber: plate });

  let registryRaw     = {};
  let registryMessage = null;

  try {
    const convertRaw = await tronkGet('convertb2b.ashx', { gosnumber: plate });
    if (convertRaw.error === true) {
      registryMessage = convertRaw.error_msg || 'Регистрационные данные не найдены.';
    } else {
      registryRaw = convertRaw;
    }
  } catch (error) {
    registryMessage = error.message || 'Не удалось получить регистрационные данные.';
  }

  let registry = unwrapTronkResponse(registryRaw);

  if (!pick(registry, 'vin', 'Vin', 'VIN', 'vin_number', 'vinNumber')) {
    try {
      const fallbackRaw = await tronkGet('convertgate.ashx', { gosnumber: plate });
      if (fallbackRaw.error === true) {
        registryMessage = registryMessage || fallbackRaw.error_msg || 'Регистрационные данные не найдены.';
      } else {
        const fallback = unwrapTronkResponse(fallbackRaw);
        if (Object.keys(fallback).length > 0) {
          registryRaw     = { ...asObject(registryRaw), ...fallback };
          registry        = unwrapTronkResponse(registryRaw);
          registryMessage = null;
        }
      }
    } catch (error) {
      registryMessage = registryMessage || error.message || 'Не удалось получить регистрационные данные.';
    }
  }

  return {
    ok:      true,
    mode:    'vehicle_lookup_full',
    plate:   formatPlate(plate),
    vehicle: makeFullVehicle(previewRaw, registryRaw),
    registry: { available: !registryMessage, message: registryMessage },
    source:  'Tronk: предварительная проверка + регистрационные данные',
  };
}

/* ═══════════════════════════════════════════════════════
 * OCR паспортов — Yandex Vision OCR v1
 * Переменные окружения: VISION_API_KEY, YC_FOLDER_ID
 *
 * Формат запроса к /ocr/v1/recognizeText (по документации Yandex Cloud):
 * {
 *   "mimeType": "JPEG",
 *   "languageCodes": ["*"],
 *   "model": "page",
 *   "content": "<base64>"
 * }
 * Все поля — в корне тела запроса, textDetectionConfig не используется.
 * ═══════════════════════════════════════════════════════ */

function ensureVisionConfig() {
  if (!VISION_API_KEY || !YC_FOLDER_ID) {
    const error = new Error('Не настроены VISION_API_KEY или YC_FOLDER_ID.');
    error.statusCode = 500;
    throw error;
  }
}

function cleanBase64(value) {
  return String(value || '')
    .trim()
    .replace(/^data:[^;]+;base64,/, '')
    .replace(/\s+/g, '');
}

function validatePassportFile(file, fieldName) {
  const source  = asObject(file);
  const content  = cleanBase64(source.content);
  const mimeType = String(source.mimeType || '').trim().toLowerCase();

  if (!content) {
    const error = new Error(`Не передан файл: ${fieldName}.`);
    error.statusCode = 400;
    throw error;
  }

  if (content.length > MAX_BASE64_LENGTH) {
    const error = new Error(`Файл ${fieldName} слишком большой.`);
    error.statusCode = 413;
    throw error;
  }

  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
  if (mimeType && !allowed.includes(mimeType)) {
    const error = new Error(`Неподдерживаемый mimeType для ${fieldName}.`);
    error.statusCode = 400;
    throw error;
  }

  return { mimeType: mimeType || 'image/jpeg', content };
}

function normalizeSpaces(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeRusText(value) {
  return normalizeSpaces(value).replace(/Ё/g, 'Е').replace(/ё/g, 'е');
}

function upperRus(value) {
  return normalizeRusText(value).toUpperCase();
}

function titleCaseRus(value) {
  return normalizeRusText(value)
    .toLowerCase()
    .replace(/(^|[\s.-])([а-яa-z])/giu, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
}

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function formatDateRu(value) {
  const raw        = String(value || '').trim();
  const normalized = raw.replace(/[^\d.]/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
  const match      = normalized.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

/*
 * MRZ — две латинские строки внизу разворота (PNRUSKOPOSOV<<DENIS<<...).
 * Из неё нельзя брать ФИО для ДКП — там транслитерация, а не русские буквы.
 */
function isMrzLine(line) {
  const value = String(line || '');
  if (value.includes('<')) return true;
  const latin    = (value.match(/[A-Z]/g) || []).length;
  const cyrillic = (value.match(/[А-Я]/g) || []).length;
  return latin > 6 && latin > cyrillic * 2;
}

function stripMrz(text) {
  return normalizeRusText(text)
    .split('\n')
    .filter((line) => !isMrzLine(line))
    .join('\n');
}

function hasCyrillic(value) {
  return /[А-я]/.test(String(value || ''));
}

function extractTextLinesFromVision(data) {
  const lines = [];

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string' && node.text.trim()) lines.push(node.text.trim());
    Object.values(node).forEach(walk);
  }

  walk(data);
  return Array.from(new Set(lines));
}

/* Vision OCR принимает только JPEG, PNG и PDF. */
function toVisionMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.includes('pdf')) return 'PDF';
  if (value.includes('png')) return 'PNG';
  return 'JPEG';
}

/*
 * Сущности шаблонных моделей Vision OCR: textAnnotation.entities = [{ name, text }].
 */
function extractEntitiesFromVision(data) {
  const list = asObject(data).textAnnotation?.entities;
  if (!Array.isArray(list)) return {};

  const result = {};
  for (const item of list) {
    const name = String(asObject(item).name || '').trim();
    const text = String(asObject(item).text || '').trim();
    if (name && text && !result[name]) result[name] = text;
  }
  return result;
}

/*
 * model = 'passport' — шаблонная модель основного разворота паспорта,
 * model = 'page'     — обычный текст (страница регистрации с адресным штампом).
 */
/* Vision ограничивает частоту запросов: на 429 и 5xx ждём и пробуем ещё раз. */
const OCR_RETRY_DELAYS_MS = [900, 2200, 4500];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableOcrError(error) {
  const status = error && error.providerStatus;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function recognizePassportPageRaw(file, model = 'page') {
  ensureVisionConfig();

  let data;
  for (let attempt = 0; ; attempt += 1) {
    try {
      data = await httpPostJson(
        'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText',
        {
          mimeType:      toVisionMimeType(file.mimeType),
          languageCodes: ['*'],
          model,
          content:       file.content,
        },
        {
          Authorization:            `Api-Key ${VISION_API_KEY}`,
          'x-folder-id':            YC_FOLDER_ID,
          'x-data-logging-enabled': 'false',
        },
        OCR_TIMEOUT_MS
      );
      break;
    } catch (error) {
      if (attempt >= OCR_RETRY_DELAYS_MS.length || !isRetriableOcrError(error)) throw error;
      await delay(OCR_RETRY_DELAYS_MS[attempt]);
    }
  }

  const textLines = extractTextLinesFromVision(data);
  const fullText  = String(asObject(data).textAnnotation?.fullText || '').trim();

  return {
    text:     normalizeSpaces(fullText || textLines.join('\n')),
    lines:    textLines,
    entities: extractEntitiesFromVision(data),
    model,
  };
}

/* ═══════════════════════════════════════════════════════
 * Интеллектуальный разбор: языковая модель ищет конкретные поля
 * в распознанном тексте и возвращает строгий JSON по схеме.
 * ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
 * MRZ — машиночитаемая зона. Единственный источник в паспорте,
 * где серия, номер, даты и код подразделения защищены контрольными
 * цифрами, поэтому для этих полей она надёжнее любого распознавания
 * рукописного бланка.
 * Схема РФ: строка 2 = [3 цифры серии][6 цифр номера][КЦ]RUS[ГГММДД рождения][КЦ][пол]
 *           затем доп. данные = [4-я цифра серии][ГГММДД выдачи][6 цифр кода].
 * ═══════════════════════════════════════════════════════ */

const MRZ_DIGIT_FIX = { O: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const MRZ_DIGITS = '[0-9OQILSBZG]';

function mrzToDigits(value) {
  return String(value || '')
    .toUpperCase()
    .split('')
    .map((ch) => MRZ_DIGIT_FIX[ch] || ch)
    .join('')
    .replace(/[^0-9]/g, '');
}

function mrzCheckDigit(value) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const digit = ch === '<' ? 0 : Number(ch);
    if (!Number.isFinite(digit)) return null;
    sum += digit * weights[i % 3];
  }
  return sum % 10;
}

/* Двузначный год: будущее невозможно ни для рождения, ни для выдачи. */
function mrzYear(yy) {
  const current = new Date().getFullYear() % 100;
  const century = Number(yy) > current ? 1900 : 2000;
  return century + Number(yy);
}

function mrzDate(sixDigits) {
  if (!/^\d{6}$/.test(sixDigits)) return '';
  const year  = mrzYear(sixDigits.slice(0, 2));
  const month = sixDigits.slice(2, 4);
  const day   = sixDigits.slice(4, 6);
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return '';
  return `${day}.${month}.${year}`;
}

function findMrzLines(text) {
  const lines = String(text || '')
    .split(/\n+/)
    .map((line) => line.toUpperCase().replace(/\s+/g, ''))
    .filter((line) => line.length >= 20);

  let line1 = '';
  let line2 = '';

  for (const line of lines) {
    if (!line2 && /RU[S5]/.test(line) && (line.match(/[0-9OQILSBZG]/g) || []).length >= 20) line2 = line;
    else if (!line1 && /^P[NH]|<</.test(line) && /[A-Z]{4}/.test(line)) line1 = line;
  }

  return { line1, line2 };
}

function parseMrzNames(line1) {
  if (!line1) return { surname: '', given: [] };

  // Убираем префикс PN и код страны, дальше фамилия << имена, разделённые <.
  const body = line1.replace(/^P[NH]?/, '').replace(/^RU[S5]/, '').replace(/[^A-Z<]/g, '');
  const [surnamePart, givenPart = ''] = body.split(/<<+/);

  return {
    surname: String(surnamePart || '').replace(/</g, ''),
    given:   givenPart.split('<').map((part) => part.trim()).filter((part) => part.length >= 2),
  };
}

function parseMrz(text) {
  const { line1, line2 } = findMrzLines(text);
  if (!line2) return null;

  const pattern = new RegExp(
    `(${MRZ_DIGITS}{9})(${MRZ_DIGITS})RU[S5](${MRZ_DIGITS}{6})(${MRZ_DIGITS})([MF])<*(${MRZ_DIGITS}{13})?`
  );
  const match = line2.match(pattern);
  if (!match) return null;

  const docNumber   = mrzToDigits(match[1]);
  const docCheck    = mrzToDigits(match[2]);
  const birthDigits = mrzToDigits(match[3]);
  const birthCheck  = mrzToDigits(match[4]);
  const sex         = match[5];
  const optional    = mrzToDigits(match[6] || '');

  if (docNumber.length !== 9 || birthDigits.length !== 6) return null;

  const seriesTail     = optional.slice(0, 1);
  const issueDigits    = optional.slice(1, 7);
  const departmentCode = optional.slice(7, 13);

  const names = parseMrzNames(line1);

  return {
    passportSeries: seriesTail ? docNumber.slice(0, 3) + seriesTail : '',
    passportNumber: docNumber.slice(3, 9),
    birthDate:      mrzDate(birthDigits),
    issueDate:      mrzDate(issueDigits),
    departmentCode: /^\d{6}$/.test(departmentCode)
      ? `${departmentCode.slice(0, 3)}-${departmentCode.slice(3, 6)}`
      : '',
    sex:            sex === 'M' ? 'МУЖ' : 'ЖЕН',
    surnameLat:     names.surname,
    givenLat:       names.given,
    checks: {
      documentNumber: mrzCheckDigit(docNumber) === Number(docCheck),
      birthDate:      mrzCheckDigit(birthDigits) === Number(birthCheck),
    },
  };
}

/* ── Сопоставление русских слов из бланка с латиницей MRZ ── */

const TRANSLIT_RU = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z', И: 'I',
  Й: 'I', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T',
  У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS', Ч: 'CH', Ш: 'SH', Щ: 'SHCH', Ъ: 'IE', Ы: 'Y',
  Ь: '', Э: 'E', Ю: 'IU', Я: 'IA',
};

function translitRus(value) {
  return upperRus(value)
    .split('')
    .map((ch) => (ch in TRANSLIT_RU ? TRANSLIT_RU[ch] : /[A-Z]/.test(ch) ? ch : ''))
    .join('');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

function nameSimilarity(cyrillic, latin) {
  const left  = translitRus(cyrillic);
  const right = String(latin || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!left || !right) return 0;

  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

const NAME_STOPWORDS = new Set([
  'РОССИЙСКАЯ', 'ФЕДЕРАЦИЯ', 'ПАСПОРТ', 'ВЫДАН', 'ДАТА', 'ВЫДАЧИ', 'КОД',
  'ПОДРАЗДЕЛЕНИЯ', 'ЛИЧНАЯ', 'ПОДПИСЬ', 'ЛИЧНЫЙ', 'ФАМИЛИЯ', 'ИМЯ', 'ОТЧЕСТВО',
  'ПОЛ', 'МУЖ', 'ЖЕН', 'МЕСТО', 'РОЖДЕНИЯ', 'ОБЛАСТЬ', 'ОБЛ', 'РЕСПУБЛИКА',
  'КРАЙ', 'РАЙОН', 'ГОРОД', 'ГОР', 'СЕЛО', 'ПОСЕЛОК', 'РОССИИ', 'МВД', 'ГУ',
  'УФМС', 'ОУФМС', 'ОВД', 'ГОВД', 'РОВД', 'УВД', 'ГУВД',
]);

/*
 * Шаблонная модель иногда сдвигает поля (в «Фамилию» попадает «МУЖ»),
 * поэтому ФИО собираем по совпадению с латиницей MRZ — она однозначно
 * задаёт порядок: фамилия, имя, отчество.
 */
function namesFromMrz(mainText, mrz) {
  const empty = { lastName: '', firstName: '', middleName: '' };
  if (!mrz || (!mrz.surnameLat && !mrz.givenLat.length)) return empty;

  const tokens = Array.from(new Set(
    upperRus(stripMrz(mainText))
      .split(/[^А-ЯЁ-]+/)
      .map((token) => token.replace(/^-+|-+$/g, ''))
      .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token))
  ));

  const targets = [mrz.surnameLat, mrz.givenLat[0] || '', mrz.givenLat[1] || ''];
  const keys    = ['lastName', 'firstName', 'middleName'];
  const result  = { ...empty };
  const used    = new Set();

  targets.forEach((target, index) => {
    if (!target) return;

    let best = { token: '', score: 0 };
    for (const token of tokens) {
      if (used.has(token)) continue;
      const score = nameSimilarity(token, target);
      if (score > best.score) best = { token, score };
    }

    // Порог отсекает случайные совпадения, но терпит типичные ошибки OCR.
    if (best.score >= 0.7) {
      used.add(best.token);
      result[keys[index]] = titleCaseRus(best.token);
    }
  });

  return result;
}

function personFromMrz(mainText, mrz) {
  if (!mrz) return null;

  const names = namesFromMrz(mainText, mrz);

  return {
    ...names,
    birthDate:           mrz.birthDate,
    birthPlace:          '',
    passportSeries:      mrz.passportSeries,
    passportNumber:      mrz.passportNumber,
    issuedBy:            '',
    departmentCode:      mrz.departmentCode,
    issueDate:           mrz.issueDate,
    registrationAddress: '',
  };
}

const PASSPORT_FIELDS = [
  'lastName', 'firstName', 'middleName', 'birthDate', 'birthPlace',
  'passportSeries', 'passportNumber', 'issuedBy', 'departmentCode',
  'issueDate', 'registrationAddress',
];

const PASSPORT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    lastName:            { type: 'string', description: 'Фамилия владельца русскими буквами, без MRZ' },
    firstName:           { type: 'string', description: 'Имя русскими буквами' },
    middleName:          { type: 'string', description: 'Отчество русскими буквами' },
    birthDate:           { type: 'string', description: 'Дата рождения в формате ДД.ММ.ГГГГ' },
    birthPlace:          { type: 'string', description: 'Место рождения как в паспорте' },
    passportSeries:      { type: 'string', description: 'Серия — ровно 4 цифры' },
    passportNumber:      { type: 'string', description: 'Номер — ровно 6 цифр' },
    issuedBy:            { type: 'string', description: 'Кем выдан: только название органа (ОВД/ГОВД/УФМС/МВД), без пола, гражданства и дат' },
    departmentCode:      { type: 'string', description: 'Код подразделения в формате 000-000' },
    issueDate:           { type: 'string', description: 'Дата выдачи в формате ДД.ММ.ГГГГ' },
    registrationAddress: { type: 'string', description: 'Адрес регистрации одной строкой: город, улица/проспект, дом, квартира, без повторов' },
  },
  required: PASSPORT_FIELDS,
};

const LLM_SYSTEM_PROMPT = [
  'Ты разбираешь результат OCR паспорта Гражданина РФ и заполняешь карточку для договора купли-продажи.',
  'Строгие правила:',
  '1. Бери только то, что есть в тексте. Ничего не выдумывай и не достраивай.',
  '2. Если поле не найдено или есть сомнения — верни пустую строку.',
  '3. Строки MRZ (латиница с символами <) в текст не включай: проверенные значения из MRZ даны отдельным блоком «Проверенные данные MRZ» — считай их истиной и не противоречь им.',
  '4. ФИО — только русскими буквами, в именительном падеже, каждое слово с большой буквы.',
  '5. Даты — в формате ДД.ММ.ГГГГ. Дата рождения раньше даты выдачи.',
  '6. Серия — 4 цифры, номер — 6 цифр. В бланке они напечатаны вертикально справа как 10 цифр.',
  '7. В поле issuedBy не включай подписи полей («Дата выдачи», «Код подразделения»), пол (МУЖ/ЖЕН), гражданство (RUS), даты и цифры кода.',
  '8. Адрес регистрации бери только из блока «Страница регистрации», собери в одну строку без повторов слов.',
  '9. Исправляй явные ошибки OCR в типовых словах (проскакт → проспект, улица, город, область, район, дом, квартира), но не меняй цифры и имена собственные.',
  '10. Если в блоке «Проверенные данные MRZ» есть фамилия, имя, отчество латиницей — подбери русское написание, совпадающее с этой латиницей.',
  '11. Ответ — только JSON по схеме, без пояснений.',
].join('\n');

function buildLlmUserMessage(mainText, registrationText, entities, mrz) {
  const entityLines = Object.entries(asObject(entities))
    .map(([name, text]) => `${name}: ${text}`)
    .join('\n');

  const mrzLines = mrz ? [
    `Серия: ${mrz.passportSeries || '(нет)'}`,
    `Номер: ${mrz.passportNumber || '(нет)'}`,
    `Дата рождения: ${mrz.birthDate || '(нет)'}`,
    `Дата выдачи: ${mrz.issueDate || '(нет)'}`,
    `Код подразделения: ${mrz.departmentCode || '(нет)'}`,
    `Пол: ${mrz.sex || '(нет)'}`,
    `ФИО латиницей: ${[mrz.surnameLat, ...(mrz.givenLat || [])].filter(Boolean).join(' ') || '(нет)'}`,
  ].join('\n') : '(MRZ не прочитана)';

  return [
    'Проверенные данные MRZ (контрольные цифры совпали):',
    mrzLines,
    '',
    'Основной разворот (OCR):',
    stripMrz(mainText).slice(0, 4000) || '(пусто)',
    '',
    'Поля, найденные шаблонной моделью Vision (могут быть неточными):',
    entityLines || '(нет)',
    '',
    'Страница регистрации (OCR):',
    stripMrz(registrationText).slice(0, 3000) || '(не передана)',
  ].join('\n');
}

function parseLlmJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;

  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/* Модель может вернуть лишние символы — приводим каждое поле к нашему формату. */
function normalizeLlmPerson(data) {
  const source = asObject(data);
  const series = onlyDigits(source.passportSeries);
  const number = onlyDigits(source.passportNumber);

  const rusName = (value) => (hasCyrillic(value) ? titleCaseRus(value) : '');

  return {
    lastName:            rusName(source.lastName),
    firstName:           rusName(source.firstName),
    middleName:          rusName(source.middleName),
    birthDate:           formatDateRu(source.birthDate),
    birthPlace:          titleCaseRus(source.birthPlace || ''),
    passportSeries:      series.length === 4 ? series : '',
    passportNumber:      number.length === 6 ? number : '',
    issuedBy:            cleanIssuedBy(source.issuedBy || ''),
    departmentCode:      extractDepartmentCode(source.departmentCode || ''),
    issueDate:           formatDateRu(source.issueDate),
    registrationAddress: cleanAddress(source.registrationAddress || ''),
  };
}

async function llmExtractPassport(mainText, registrationText, entities, mrz) {
  if (!LLM_ENABLED)               return { person: null, error: 'Интеллектуальный разбор отключен (LLM_ENABLED=false).' };
  if (!LLM_API_KEY || !YC_FOLDER_ID) return { person: null, error: 'Не настроены LLM_API_KEY/VISION_API_KEY или YC_FOLDER_ID.' };

  const body = {
    modelUri: `gpt://${YC_FOLDER_ID}/${LLM_MODEL}`,
    completionOptions: { stream: false, temperature: 0, maxTokens: '2000' },
    jsonSchema: { schema: PASSPORT_JSON_SCHEMA },
    messages: [
      { role: 'system', text: LLM_SYSTEM_PROMPT },
      { role: 'user',   text: buildLlmUserMessage(mainText, registrationText, entities, mrz) },
    ],
  };

  try {
    let data;
    for (let attempt = 0; ; attempt += 1) {
      try {
        data = await httpPostJson(
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
          body,
          {
            Authorization:            `Api-Key ${LLM_API_KEY}`,
            'x-folder-id':            YC_FOLDER_ID,
            'x-data-logging-enabled': 'false',
          },
          LLM_TIMEOUT_MS
        );
        break;
      } catch (error) {
        if (attempt >= OCR_RETRY_DELAYS_MS.length || !isRetriableOcrError(error)) throw error;
        await delay(OCR_RETRY_DELAYS_MS[attempt]);
      }
    }

    const alternatives = asObject(asObject(data).result).alternatives;
    const text = Array.isArray(alternatives)
      ? String(asObject(asObject(alternatives[0]).message).text || '')
      : '';

    const parsed = parseLlmJson(text);
    if (!parsed) return { person: null, error: 'Модель вернула ответ не в формате JSON.' };

    return { person: normalizeLlmPerson(parsed), error: null };
  } catch (error) {
    return { person: null, error: error.message || 'Ошибка вызова языковой модели.', providerError: describeProviderError(error) };
  }
}

/* ── Сборка карточки из сущностей модели passport ── */

function splitPassportNumber(value) {
  const digits = onlyDigits(value);
  if (digits.length === 10) {
    return { passportSeries: digits.slice(0, 4), passportNumber: digits.slice(4) };
  }
  return { passportSeries: '', passportNumber: '' };
}

function personFromEntities(entities) {
  const source        = asObject(entities);
  const seriesAndNumber = splitPassportNumber(source.number);

  // Латиницу из MRZ в ФИО не пускаем — в ДКП нужны русские буквы.
  const rusOnly = (value) => (hasCyrillic(value) ? titleCaseRus(value) : '');

  return {
    lastName:            rusOnly(source.surname),
    firstName:           rusOnly(source.name),
    middleName:          rusOnly(source.middle_name),
    birthDate:           formatDateRu(source.birth_date  || ''),
    birthPlace:          titleCaseRus(source.birth_place || ''),
    passportSeries:      seriesAndNumber.passportSeries,
    passportNumber:      seriesAndNumber.passportNumber,
    issuedBy:            cleanIssuedBy(source.issued_by  || ''),
    departmentCode:      extractDepartmentCode(source.subdivision || ''),
    issueDate:           formatDateRu(source.issue_date  || ''),
    registrationAddress: '',
  };
}

function countFilled(person) {
  return Object.values(person).filter((v) => String(v || '').trim()).length;
}

/* ── Паспортные парсеры ── */

function extractPassportSeriesAndNumber(text) {
  const upper = upperRus(text);

  let match = upper.match(/(\d{2})\s*(\d{2})\s*(\d{6})/);
  if (match) {
    const s = `${match[1]}${match[2]}`;
    const n = match[3];
    return { passportSeries: s.length === 4 ? s : '', passportNumber: n.length === 6 ? n : '' };
  }

  match = upper.match(/(\d{4})\s*(\d{6})/);
  if (match) {
    const s = onlyDigits(match[1]);
    const n = onlyDigits(match[2]);
    return { passportSeries: s.length === 4 ? s : '', passportNumber: n.length === 6 ? n : '' };
  }

  match = upper.match(/СЕРИЯ[:\s]*([0-9]{4}).{0,20}?НОМЕР[:\s]*([0-9]{6})/);
  if (match) {
    return { passportSeries: match[1], passportNumber: match[2] };
  }

  return { passportSeries: '', passportNumber: '' };
}

/*
 * Слева к названию органа часто прилипают соседние поля бланка:
 * гражданство (RUS), пол (МУЖ/ЖЕН), подписи полей.
 */
/* titleCaseRus портит аббревиатуры органов — возвращаем их в верхний регистр. */
const ORG_ABBREVIATIONS = ['ОУФМС', 'УФМС', 'ГУМВД', 'ГУВД', 'ГОВД', 'РОВД', 'УМВД', 'МВД', 'ОВД', 'УВД', 'ФМС', 'ГУ', 'МО', 'ТП'];

function restoreAbbreviations(value) {
  let result = String(value || '');
  for (const abbr of ORG_ABBREVIATIONS) {
    const pattern = new RegExp(`(^|[\\s,.(-])${abbr}(?=$|[\\s,.)-])`, 'gi');
    result = result.replace(pattern, (m, prefix) => `${prefix}${abbr}`);
  }
  return result;
}

/* Предлоги и союзы внутри названия органа пишутся со строчной буквы. */
function lowerServiceWords(value) {
  return String(value || '').replace(
    /(\S)\s(По|И|В|На|От|При|Для)(?=\s|$|\.)/g,
    (match, prev, word) => `${prev} ${word.toLowerCase()}`
  );
}

function cleanIssuedBy(value) {
  let result = normalizeRusText(value)
    .replace(/[<>|]/g, ' ')
    .replace(/\b(RUS|ROS|MUZH|ZHEN)\b/gi, ' ')
    .replace(/\b(МУЖ|ЖЕН|Муж|Жен)\.?/g, ' ')
    .replace(/ГРАЖДАНСТВО|Гражданство|ДАТА ВЫДАЧИ|Дата выдачи|КОД ПОДРАЗДЕЛЕНИЯ|Код подразделения/g, ' ')
    .replace(/\d{2}\.\d{2}\.\d{4}/g, ' ')
    .replace(/\b\d{3}[- ]?\d{3}\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Если в строке есть название органа — начинаем с него или с предшествующего определения.
  const orgMatch = result.match(
    /([А-Яа-яёЁ-]+ским\s+)?(ГУ\s+МВД|ГУМВД|УМВД|МВД|ОУФМС|УФМС|ФМС|ГОВД|РОВД|ГУВД|УВД|ОВД|ТП|Отделом|Отделением|Отдел|Отделение)[\s\S]*/i
  );
  if (orgMatch) result = orgMatch[0].trim();

  result = lowerServiceWords(restoreAbbreviations(titleCaseRus(result)));
  const labels = ['дата выдачи', 'кем выдан', 'паспорт выдан', 'код подразделения'];
  if (labels.includes(result.toLowerCase()) || result.length < 8) return '';

  return result;
}

/*
 * OCR часто дублирует фрагменты адреса (строка целиком и каждое слово отдельно),
 * поэтому выбрасываем фрагменты, уже входящие в более полные.
 */
function cleanAddress(value) {
  const parts = normalizeRusText(value)
    .split(/[,\n]/)
    .map((part) => part.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean);

  const kept = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    const duplicate = kept.some((other) => {
      const otherLower = other.toLowerCase();
      return otherLower === lower || otherLower.includes(lower);
    });
    if (duplicate) continue;

    // Если новый фрагмент шире уже добавленного — заменяем его.
    const narrowIndex = kept.findIndex((other) => lower.includes(other.toLowerCase()));
    if (narrowIndex >= 0) { kept[narrowIndex] = part; continue; }

    kept.push(part);
  }

  const result = titleCaseRus(kept.join(', '));
  return result.length > 10 ? result : '';
}

function extractDepartmentCode(text) {
  const upper = upperRus(text);
  const match = upper.match(/\b(\d{3})[- ]?(\d{3})\b/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function extractDates(text) {
  const upper = upperRus(stripMrz(text));
  return (upper.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || []).map(formatDateRu).filter(Boolean);
}

function dateToTime(value) {
  const match = String(value || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return NaN;
  return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

/*
 * Даты в паспорте часто распознаются в произвольном порядке,
 * поэтому разделяем их по смыслу: дата рождения — самая ранняя,
 * дата выдачи — самая поздняя из не будущих.
 */
function splitPassportDates(text) {
  const now   = Date.now();
  const dates = Array.from(new Set(extractDates(text)))
    .map((value) => ({ value, time: dateToTime(value) }))
    .filter((item) => Number.isFinite(item.time) && item.time <= now)
    .sort((a, b) => a.time - b.time);

  if (!dates.length) return { birthDate: '', issueDate: '' };
  if (dates.length === 1) return { birthDate: dates[0].value, issueDate: '' };

  return { birthDate: dates[0].value, issueDate: dates[dates.length - 1].value };
}

function cleanNameLine(line) {
  return upperRus(line).replace(/[^А-ЯA-Z -]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isLikelyFullNameLine(line) {
  const cleaned = cleanNameLine(line);
  const parts   = cleaned.split(' ').filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => /^[А-ЯA-Z-]{2,}$/.test(part));
}

/* Служебные слова бланка — никогда не часть ФИО. */
const NAME_STOP_WORDS = [
  'ПАСПОРТ', 'РОССИЙСКОЙ', 'ФЕДЕРАЦИИ', 'ДАТА', 'ВЫДАЧИ', 'ВЫДАН',
  'РОЖДЕНИЯ', 'МЕСТО', 'КОД', 'ПОДРАЗДЕЛЕНИЯ', 'ФАМИЛИЯ', 'ИМЯ',
  'ОТЧЕСТВО', 'ПОЛ', 'ЛИЧНАЯ', 'ПОДПИСЬ', 'МВД', 'УФМС', 'ГУМВД', 'ОТДЕЛ',
  'ОТДЕЛЕНИЕ', 'РОССИИ', 'ОРГАН', 'ГОР', 'ГОРОД', 'ОБЛ', 'РАЙОН',
];

function isNameCandidateLine(line) {
  if (/\d/.test(line)) return false;                  // в ФИО не бывает цифр
  const upper = upperRus(line);
  if (!hasCyrillic(upper)) return false;              // латиница — это MRZ

  const words = cleanNameLine(upper).split(' ').filter(Boolean);
  if (!words.length || words.length > 4) return false;
  if (!words.every((word) => /^[А-Я-]{2,}$/.test(word))) return false;

  return words.every((word) => !NAME_STOP_WORDS.includes(word));
}

function extractFullName(mainText) {
  const lines = stripMrz(mainText)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(isNameCandidateLine)
    .map((line) => cleanNameLine(upperRus(line)));

  if (!lines.length) return { lastName: '', firstName: '', middleName: '' };

  // В паспорте ФИО идёт тремя отдельными строками по одному слову.
  const singles = lines.filter((line) => line.split(' ').filter(Boolean).length === 1);
  if (singles.length >= 2) {
    return {
      lastName:   titleCaseRus(singles[0] || ''),
      firstName:  titleCaseRus(singles[1] || ''),
      middleName: titleCaseRus(singles[2] || ''),
    };
  }

  const parts = [...lines].sort((a, b) => b.length - a.length)[0].split(' ').filter(Boolean);

  return {
    lastName:   titleCaseRus(parts[0] || ''),
    firstName:  titleCaseRus(parts[1] || ''),
    middleName: titleCaseRus(parts[2] || ''),
  };
}

function extractBirthDate(text) {
  return splitPassportDates(text).birthDate;
}

function extractIssueDate(text) {
  const upper     = upperRus(text);
  const lineMatch = upper.match(/ДАТА ВЫДАЧИ[:\s]*([0-9]{2}\.[0-9]{2}\.[0-9]{4})/);
  if (lineMatch) return formatDateRu(lineMatch[1]);
  return splitPassportDates(text).issueDate;
}

function extractBirthPlace(text) {
  const normalized = normalizeRusText(text);
  const match      = normalized.match(/МЕСТО РОЖДЕНИЯ[:\s]*([\s\S]{0,200})/i);
  if (!match) return '';
  const fragment = match[1]
    .split(/\n/)
    .slice(0, 2)
    .join(' ')
    .replace(/ДАТА ВЫДАЧИ.*$/i, '')
    .replace(/\d{4}.*$/, '')          // отрезаем серию/номер, если они попали в строку
    .trim();
  return titleCaseRus(fragment);
}

/*
 * Vision отдаёт и целые строки, и те же слова по отдельности, поэтому
 * «Кем выдан» собираем построчно от подписи «Паспорт выдан» до даты выдачи,
 * выбрасывая однословные повторы уже собранного.
 */
function extractIssuedByFromLines(text) {
  const lines = stripMrz(text)
    .split(/\n+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);

  const start = lines.findIndex((line) => /ПАСПОРТ\s*ВЫДАН/.test(upperRus(line)));
  if (start < 0) return '';

  const collected = [];
  for (let i = start + 1; i < lines.length && collected.length < 6; i += 1) {
    const line  = lines[i];
    const upper = upperRus(line);

    if (/ДАТА\s*ВЫДАЧИ|КОД\s*ПОДРАЗДЕЛ|ЛИЧНЫЙ|ЛИЧНАЯ|ПОДПИСЬ|ФАМИЛИЯ/.test(upper)) break;
    if (/^\d/.test(upper)) break;
    if (!hasCyrillic(line)) continue;

    const words = upper.split(/\s+/).filter(Boolean);
    if (words.length === 1 && collected.some((part) => upperRus(part).includes(words[0]))) continue;

    collected.push(line);
  }

  return cleanIssuedBy(collected.join(' '));
}

function extractIssuedBy(text) {
  const byLines = extractIssuedByFromLines(text);
  if (byLines) return byLines;

  const normalized = stripMrz(text);
  const upper      = upperRus(normalized);
  const idx        = upper.indexOf('КОД ПОДРАЗДЕЛЕНИЯ');

  let head = idx >= 0 ? normalized.slice(0, idx) : normalized;

  const issueStart = head.search(/[\r\n].{0,40}ДАТА ВЫДАЧИ/i);
  if (issueStart >= 0) head = head.slice(issueStart);

  const filtered = head
    .split('\n')
    .map((l) => normalizeSpaces(l))
    .filter((line) => {
      const u = upperRus(line);
      return (
        !u.includes('ПАСПОРТ') &&
        !u.includes('РОССИЙСКОЙ ФЕДЕРАЦИИ') &&
        !u.includes('ДАТА ВЫДАЧИ') &&
        !/^[0-9.\- ]+$/.test(u)
      );
    });

  return cleanIssuedBy(filtered.join(' ').replace(/\s{2,}/g, ' ').trim());
}

function extractRegistrationAddress(text) {
  const normalized = stripMrz(text);
  if (normalized.length < 15) return '';
  const upper      = upperRus(normalized);
  const anchors    = ['МЕСТО ЖИТЕЛЬСТВА', 'МЕСТО ПРЕБЫВАНИЯ', 'АДРЕС', 'ЗАРЕГИСТРИРОВАН', 'ЗАРЕГИСТРИРОВАНА'];

  for (const anchor of anchors) {
    const idx = upper.indexOf(anchor);
    if (idx >= 0) {
      const fragment = normalized
        .slice(idx + anchor.length)
        .trim()
        .split('\n')
        .slice(0, 4)
        .join(', ')
        .replace(/\s*,\s*/g, ', ')
        .replace(/,+/g, ',')
        .replace(/^,|,$/g, '')
        .trim();
      // Адрес без цифр (дома/квартиры) — почти всегда мусор из подписей полей.
      if (fragment.length > 15 && /\d/.test(fragment)) return cleanAddress(fragment);
    }
  }

  // Без явного анкора лучше оставить поле пустым, чем вставить случайный текст.
  const candidate = normalized
    .split('\n')
    .map((l) => normalizeSpaces(l))
    .filter((l) => l.length > 10 && /[А-я]/.test(l) && /\d/.test(l))
    .slice(0, 4)
    .join(', ');

  return candidate.length > 15 ? cleanAddress(candidate) : '';
}

function buildMissingFields(person) {
  return Object.entries(person)
    .filter(([, v]) => !String(v || '').trim())
    .map(([k]) => k);
}

function buildWarnings(person, mainText, registrationText) {
  const warnings = [];
  if (!registrationText)                                warnings.push('Не передана страница регистрации.');
  if (!person.passportSeries || !person.passportNumber) warnings.push('Серия или номер паспорта распознаны неуверенно.');
  if (!person.departmentCode)                           warnings.push('Код подразделения не распознан.');
  if (!person.registrationAddress)                      warnings.push('Адрес регистрации не распознан.');
  if (!person.lastName || !person.firstName)            warnings.push('ФИО распознано не полностью.');
  if (!mainText || mainText.length < 30)                warnings.push('Основной разворот распознан с низким количеством текста.');
  return warnings;
}

function extractPassportFromTexts(mainText, registrationText) {
  const fullName         = extractFullName(mainText);
  const seriesAndNumber  = extractPassportSeriesAndNumber(mainText);

  const person = {
    lastName:            fullName.lastName,
    firstName:           fullName.firstName,
    middleName:          fullName.middleName,
    birthDate:           extractBirthDate(mainText),
    birthPlace:          extractBirthPlace(mainText),
    passportSeries:      seriesAndNumber.passportSeries,
    passportNumber:      seriesAndNumber.passportNumber,
    issuedBy:            extractIssuedBy(mainText),
    departmentCode:      extractDepartmentCode(mainText),
    issueDate:           extractIssueDate(mainText),
    registrationAddress: extractRegistrationAddress(registrationText),
  };

  return {
    person,
    missingFields: buildMissingFields(person),
    warnings:      buildWarnings(person, mainText, registrationText),
  };
}

function checkPersonType(value) {
  const personType = String(value || '').trim().toLowerCase();
  if (!['seller', 'buyer'].includes(personType)) {
    const error = new Error('Поле personType должно быть seller или buyer.');
    error.statusCode = 400;
    throw error;
  }
  return personType;
}

/* ─────────────────── OCR actions ─────────────────── */

async function recognizePassportPage(input) {
  const page   = validatePassportFile(input?.file || input, 'passport page');
  const model  = String(asObject(input).model || 'page').trim() || 'page';
  const result = await recognizePassportPageRaw(page, model);
  return {
    ok:        true,
    mode:      'passport_page_recognition',
    model:     result.model,
    text:      result.text,
    lineCount: result.lines.length,
    entities:  result.entities,
  };
}

/*
 * Приоритет источников по полю:
 * - цифры и даты надёжнее берутся шаблонной моделью Vision;
 * - смысловые поля (кем выдан, место рождения, адрес) — языковой моделью;
 * - регулярки остаются последним резервом.
 */
const FIELD_PRIORITY = {
  // MRZ защищена контрольными цифрами — для цифр, дат и ФИО она первая.
  lastName:            ['mrz', 'entities', 'llm', 'text'],
  firstName:           ['mrz', 'entities', 'llm', 'text'],
  middleName:          ['mrz', 'entities', 'llm', 'text'],
  birthDate:           ['mrz', 'entities', 'llm', 'text'],
  passportSeries:      ['mrz', 'entities', 'llm', 'text'],
  passportNumber:      ['mrz', 'entities', 'llm', 'text'],
  departmentCode:      ['mrz', 'entities', 'llm', 'text'],
  issueDate:           ['mrz', 'entities', 'llm', 'text'],
  // Этих полей в MRZ нет — их ищет языковая модель.
  birthPlace:          ['llm', 'entities', 'text'],
  issuedBy:            ['llm', 'entities', 'text'],
  registrationAddress: ['llm', 'text', 'entities'],
};

/*
 * Защита от домыслов: шаблонная модель Vision и языковая модель иногда
 * возвращают значения, которых в тексте нет вовсе (видели «ТП № 11 ОУФМС»
 * и дату 29.03.2011 там, где в бланке «ГУ МВД» и 29.03.2021).
 * Поэтому каждое смысловое значение сверяем с сырым текстом OCR.
 */
function ocrHaystack(...texts) {
  return upperRus(texts.filter(Boolean).join(' '))
    .replace(/[^А-ЯЁA-Z0-9]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function supportsDate(haystack, value) {
  const digits = onlyDigits(value);
  if (digits.length !== 8) return true;
  const haystackDigits = onlyDigits(haystack);
  // Год может быть распознан частично, поэтому достаточно совпадения дня, месяца и года.
  return haystackDigits.includes(digits) || haystack.includes(value);
}

function supportsText(haystack, value) {
  const words = upperRus(value)
    .replace(/[^А-ЯЁA-Z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 4);

  if (!words.length) return true;

  const present = words.filter((word) => haystack.includes(word)).length;
  return present / words.length >= 0.6;
}

const SUPPORT_CHECKS = {
  lastName:            supportsText,
  firstName:           supportsText,
  middleName:          supportsText,
  birthPlace:          supportsText,
  issuedBy:            supportsText,
  registrationAddress: supportsText,
  birthDate:           supportsDate,
  issueDate:           supportsDate,
};

function dropUnsupportedFields(person, haystack) {
  const kept     = {};
  const rejected = {};

  for (const [field, value] of Object.entries(asObject(person))) {
    const check = SUPPORT_CHECKS[field];
    if (!value || !check || check(haystack, value)) {
      kept[field] = value;
    } else {
      kept[field] = '';
      rejected[field] = value;
    }
  }

  return { person: kept, rejected };
}

function mergePassportSources(candidates) {
  const person      = {};
  const fieldSource = {};

  for (const field of PASSPORT_FIELDS) {
    for (const origin of FIELD_PRIORITY[field] || ['entities', 'llm', 'text']) {
      const value = String(asObject(candidates[origin])[field] || '').trim();
      if (value) {
        person[field]      = value;
        fieldSource[field] = origin;
        break;
      }
    }
    if (!person[field]) {
      person[field]      = '';
      fieldSource[field] = null;
    }
  }

  return { person, fieldSource };
}

async function extractPassport(input) {
  const personType = checkPersonType(input.personType);
  const mainPage   = validatePassportFile(input.mainPage, 'mainPage');

  let registrationPage = null;
  if (input.registrationPage) {
    registrationPage = validatePassportFile(input.registrationPage, 'registrationPage');
  }

  /*
   * Основной разворот читаем двумя моделями сразу:
   * - 'page' даёт полный текст вместе с MRZ (шаблонная модель MRZ не отдаёт);
   * - 'passport' даёт структурированные поля, но её текст бывает недостоверным.
   */
  // Запросы идут последовательно: параллельные вызовы упираются в лимит частоты Vision (HTTP 429).
  const plainResult = await recognizePassportPageRaw(mainPage, 'page');

  // Шаблонная модель необязательна: если она недоступна, работаем по тексту и MRZ.
  let templateResult = { text: '', lines: [], entities: {} };
  let templateError  = null;
  try {
    templateResult = await recognizePassportPageRaw(mainPage, 'passport');
  } catch (error) {
    templateError = describeProviderError(error) || error.message;
  }

  const registrationResult = registrationPage
    ? await recognizePassportPageRaw(registrationPage, 'page')
    : { text: '', lines: [], entities: {} };

  // Дальше «основной текст» — это вывод обычной модели: он полнее и содержит MRZ.
  const mainResult = { ...plainResult, entities: templateResult.entities };

  // MRZ может попасть и на страницу регистрации (там дублируются серия и номер).
  const mrz          = parseMrz(mainResult.text) || parseMrz(registrationResult.text);
  const fromMrz      = personFromMrz(mainResult.text, mrz);
  const fromEntities = personFromEntities(mainResult.entities);
  const fromText     = extractPassportFromTexts(mainResult.text, registrationResult.text).person;

  // Интеллектуальный разбор: языковая модель ищет нужные поля в распознанном тексте.
  const llmResult = await llmExtractPassport(
    mainResult.text,
    registrationResult.text,
    mainResult.entities,
    mrz
  );

  // Сверяем всё, кроме MRZ, с сырым текстом OCR — он единственный источник истины.
  const haystack        = ocrHaystack(plainResult.text, registrationResult.text);
  const checkedEntities = dropUnsupportedFields(fromEntities, haystack);
  const checkedLlm      = dropUnsupportedFields(llmResult.person || {}, haystack);

  const merged = mergePassportSources({
    mrz:      fromMrz || {},
    entities: checkedEntities.person,
    llm:      checkedLlm.person,
    text:     fromText,
  });

  const person       = merged.person;
  const usedEntities = countFilled(fromEntities) > 0;
  const usedLlm      = countFilled(checkedLlm.person) > 0;

  const warnings = buildWarnings(person, mainResult.text, registrationResult.text);
  if (!usedEntities) {
    warnings.push('Шаблонная модель паспорта не вернула поля — использован разбор текста. Проверьте качество фото.');
  }
  if (!usedLlm) {
    warnings.push(`Интеллектуальный разбор не применён: ${llmResult.error || 'модель не вернула поля'}.`);
  }
  if (templateError) {
    warnings.push(`Шаблонная модель Vision недоступна (${templateError}) — поля собраны по тексту и MRZ.`);
  }
  if (!mrz) {
    warnings.push('Не прочитана машиночитаемая зона (две строки латиницей внизу разворота) — серия, номер и даты взяты из бланка и могут быть неточными. Переснимите разворот так, чтобы эти строки полностью попали в кадр.');
  } else if (!mrz.checks.documentNumber || !mrz.checks.birthDate) {
    warnings.push('Машиночитаемая зона прочитана с ошибкой контрольной цифры — проверьте серию, номер и дату рождения по оригиналу.');
  }

  return {
    ok:            true,
    mode:          'passport_extract',
    personType,
    person,
    missingFields: buildMissingFields(person),
    warnings,
    source:        mrz ? 'mrz_plus_llm' : (usedLlm ? 'llm_assisted' : (usedEntities ? 'vision_passport_model' : 'text_fallback')),
    mrz: mrz ? { read: true, checks: mrz.checks, sex: mrz.sex } : { read: false },
    fieldSource:   merged.fieldSource,
    llm: {
      used:          usedLlm,
      model:         LLM_MODEL,
      error:         llmResult.error || null,
      providerError: llmResult.providerError || null,
    },
    recognizedPages: {
      mainPage:         Boolean(mainResult.text) || usedEntities,
      registrationPage: Boolean(registrationResult.text),
    },
    // Диагностика: видна только владельцу страницы, помогает понять, что прочитал OCR.
    debug: input.debug === true ? {
      mrzRaw:                mrz || null,
      rejected:              { entities: checkedEntities.rejected, llm: checkedLlm.rejected },
      templateTextPreview:   String(templateResult.text || '').slice(0, 800),
      mrzPerson:             fromMrz || null,
      entities:              mainResult.entities,
      mainTextPreview:       String(mainResult.text || '').slice(0, 1500),
      registrationPreview:   String(registrationResult.text || '').slice(0, 1000),
      llmPerson:             llmResult.person || null,
      entitiesPerson:        fromEntities,
      textPerson:            fromText,
    } : undefined,
  };
}

/* ═══════════════════════════════════════════════════════
 * Точка входа Cloud Function.
 * В настройках Yandex Cloud: index.handler
 * ═══════════════════════════════════════════════════════ */
module.exports.handler = async function handler(event) {
  try {
    const method = String(
      event?.httpMethod ||
      event?.requestContext?.http?.method ||
      'POST'
    ).toUpperCase();

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    if (method !== 'POST') {
      return jsonResponse(405, { ok: false, error: 'Используйте HTTP-метод POST.' });
    }

    const body   = parseEventBody(event);
    const action = String(body.action || '').trim();

    if (action === 'lookup_vehicle')          return jsonResponse(200, await lookupVehicle(body.plate));
    if (action === 'lookup_vehicle_preview')  return jsonResponse(200, await lookupVehiclePreview(body.plate));
    if (action === 'lookup_vehicle_registry') return jsonResponse(200, await lookupVehicleRegistry(body.plate));
    if (action === 'lookup_vehicle_full')     return jsonResponse(200, await lookupVehicleFull(body.plate));
    if (action === 'recognize_passport_page') return jsonResponse(200, await recognizePassportPage(body));
    if (action === 'extract_passport')        return jsonResponse(200, await extractPassport(body));

    return jsonResponse(400, {
      ok: false,
      error: 'Неподдерживаемое действие.',
      supportedActions: [
        'lookup_vehicle',
        'lookup_vehicle_preview',
        'lookup_vehicle_registry',
        'lookup_vehicle_full',
        'recognize_passport_page',
        'extract_passport',
      ],
    });
  } catch (error) {
    console.error(sanitizeError(error));
    return jsonResponse(error.statusCode || 500, {
      ok:    false,
      error: error.message || 'Внутренняя ошибка функции.',
      providerError: describeProviderError(error),
    });
  }
};
