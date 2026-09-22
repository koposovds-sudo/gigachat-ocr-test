'use strict';

const https = require('https');

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN || 'https://koposovds-sudo.github.io';

const TRONK_API_KEY = process.env.TRONK_API_KEY || '';
const YC_FOLDER_ID  = process.env.YC_FOLDER_ID  || '';
const VISION_API_KEY = process.env.VISION_API_KEY || '';

const REQUEST_TIMEOUT_MS = 15000;
const OCR_TIMEOUT_MS     = 30000;
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
            const error = new Error(`Внешний OCR-сервис вернул HTTP ${response.statusCode}.`);
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
    .replace(/(^|[\s-])([а-яa-z])/giu, (m, p1, p2) => `${p1}${p2.toUpperCase()}`);
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
async function recognizePassportPageRaw(file, model = 'page') {
  ensureVisionConfig();

  const data = await httpPostJson(
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

  const textLines = extractTextLinesFromVision(data);
  const fullText  = String(asObject(data).textAnnotation?.fullText || '').trim();

  return {
    text:     normalizeSpaces(fullText || textLines.join('\n')),
    lines:    textLines,
    entities: extractEntitiesFromVision(data),
    model,
  };
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
    issuedBy:            titleCaseRus(source.issued_by   || ''),
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
  if (!isLikelyFullNameLine(upper)) return false;

  const words = cleanNameLine(upper).split(' ').filter(Boolean);
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

function extractIssuedBy(text) {
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

  const result = titleCaseRus(filtered.join(' ').replace(/\s{2,}/g, ' ').trim());

  // Отбрасываем случай, когда вместо органа захватилась подпись поля.
  const labels = ['дата выдачи', 'кем выдан', 'паспорт выдан', 'код подразделения'];
  if (labels.includes(result.toLowerCase()) || result.length < 8) return '';

  return result;
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
      if (fragment.length > 15 && /\d/.test(fragment)) return titleCaseRus(fragment);
    }
  }

  // Без явного анкора лучше оставить поле пустым, чем вставить случайный текст.
  const candidate = normalized
    .split('\n')
    .map((l) => normalizeSpaces(l))
    .filter((l) => l.length > 10 && /[А-я]/.test(l) && /\d/.test(l))
    .slice(0, 4)
    .join(', ');

  return candidate.length > 15 ? titleCaseRus(candidate) : '';
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

async function extractPassport(input) {
  const personType = checkPersonType(input.personType);
  const mainPage   = validatePassportFile(input.mainPage, 'mainPage');

  let registrationPage = null;
  if (input.registrationPage) {
    registrationPage = validatePassportFile(input.registrationPage, 'registrationPage');
  }

  // Основной разворот — шаблонная модель passport: поля приходят уже структурированными.
  const mainResult = await recognizePassportPageRaw(mainPage, 'passport');

  // Страница регистрации — шаблонной модели нет, читаем обычным текстом.
  const registrationResult = registrationPage
    ? await recognizePassportPageRaw(registrationPage, 'page')
    : { text: '', lines: [], entities: {} };

  const fromEntities = personFromEntities(mainResult.entities);
  const fromText     = extractPassportFromTexts(mainResult.text, registrationResult.text);

  // Шаблонная модель в приоритете; регулярки — только как резерв по пустым полям.
  const usedEntities = countFilled(fromEntities) > 0;

  const person = {};
  for (const key of Object.keys(fromText.person)) {
    person[key] = String(fromEntities[key] || '').trim() || fromText.person[key] || '';
  }
  person.registrationAddress = extractRegistrationAddress(registrationResult.text);

  const warnings = buildWarnings(person, mainResult.text, registrationResult.text);
  if (!usedEntities) {
    warnings.push('Шаблонная модель паспорта не вернула поля — использован резервный разбор текста. Проверьте качество фото.');
  }

  return {
    ok:            true,
    mode:          'passport_extract',
    personType,
    person,
    missingFields: buildMissingFields(person),
    warnings,
    source:        usedEntities ? 'vision_passport_model' : 'text_fallback',
    recognizedPages: {
      mainPage:         Boolean(mainResult.text) || usedEntities,
      registrationPage: Boolean(registrationResult.text),
    },
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
