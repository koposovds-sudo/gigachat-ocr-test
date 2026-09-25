'use strict';

const https = require('https');
const crypto = require('crypto');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://koposovds-sudo.github.io';
const TRONK_API_KEY = process.env.TRONK_API_KEY || '';
const YC_FOLDER_ID = process.env.YC_FOLDER_ID || '';
const VISION_API_KEY = process.env.VISION_API_KEY || '';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.VISION_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'yandexgpt/latest';

const AUTOTEKA_CLIENT_ID = process.env.AUTOTEKA_CLIENT_ID || '';
const AUTOTEKA_CLIENT_SECRET = process.env.AUTOTEKA_CLIENT_SECRET || '';
const AUTOTEKA_API_BASE = process.env.AUTOTEKA_API_BASE || 'https://pro.autoteka.ru';
const AUTOTEKA_TOKEN_URL = process.env.AUTOTEKA_TOKEN_URL || 'https://pro.autoteka.ru/token';
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
const ACADEMIC_PARTS_URL = process.env.ACADEMIC_PARTS_URL || '';
const ACADEMIC_PARTS_TOKEN = process.env.ACADEMIC_PARTS_TOKEN || '';
const FSSP_API_URL = process.env.FSSP_API_URL || '';
const FSSP_API_TOKEN = process.env.FSSP_API_TOKEN || '';
const PLEDGE_API_URL = process.env.PLEDGE_API_URL || '';
const PLEDGE_API_TOKEN = process.env.PLEDGE_API_TOKEN || '';

const REQUEST_TIMEOUT_MS = 45000;
const MAX_BASE64_LENGTH = 14 * 1024 * 1024;
let autotekaTokenCache = { token: '', expiresAt: 0 };
let googleTokenCache = { token: '', expiresAt: 0 };

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  };
}
function jsonResponse(statusCode, payload) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(payload) };
}
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function pick(object, ...keys) {
  const source = asObject(object);
  for (const key of keys) if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  return null;
}
function parseEventBody(event) {
  if (!event) return {};
  if (event.action) return event;
  if (!event.body) return {};
  if (typeof event.body === 'object') return event.body;
  try { return JSON.parse(event.body); } catch { const e = new Error('Тело запроса должно быть корректным JSON.'); e.statusCode = 400; throw e; }
}
function describeProviderError(error) {
  const value = error && error.providerResponse;
  if (!value) return null;
  try { return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 1000); } catch { return null; }
}
function normalizePlate(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '').replace(/[^АВЕКМНОРСТУХABEKMHOPCTYX0-9]/g, '');
}
function formatPlate(value) {
  const plate = normalizePlate(value);
  const m = plate.match(/^([АВЕКМНОРСТУХABEKMHOPCTYX])(\d{3})([АВЕКМНОРСТУХABEKMHOPCTYX]{2})(\d{2,3})$/);
  return m ? `${m[1]}${m[2]}${m[3]} ${m[4]}` : plate || null;
}
function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) { const e = new Error(`Укажите ${label}.`); e.statusCode = 400; throw e; }
  return text;
}
function validateBirthDate(value) {
  const text = requireText(value, 'дату рождения');
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(text)) { const e = new Error('Дата рождения должна быть в формате ДД.ММ.ГГГГ.'); e.statusCode = 400; throw e; }
  return text;
}
function cleanBase64(value) {
  return String(value || '').trim().replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
}
function validateFile(file, label) {
  const source = asObject(file);
  const content = cleanBase64(source.content);
  if (!content) { const e = new Error(`Не передан файл: ${label}.`); e.statusCode = 400; throw e; }
  if (content.length > MAX_BASE64_LENGTH) { const e = new Error(`Файл ${label} слишком большой.`); e.statusCode = 413; throw e; }
  return { content, mimeType: String(source.mimeType || 'image/jpeg').toLowerCase(), name: String(source.name || label) };
}

function httpRequestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = options.body || null;
    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'auto-business-agent/1.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`Внешний сервис вернул HTTP ${res.statusCode}.`);
          e.statusCode = res.statusCode >= 500 ? 502 : res.statusCode;
          e.providerResponse = data;
          reject(e);
          return;
        }
        resolve({ data, headers: res.headers });
      });
    });
    req.setTimeout(options.timeoutMs || REQUEST_TIMEOUT_MS, () => { const e = new Error('Превышено время ожидания внешнего сервиса.'); e.statusCode = 504; req.destroy(e); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function tronkGet(endpoint, params) {
  if (!TRONK_API_KEY) { const e = new Error('Не настроен TRONK_API_KEY.'); e.statusCode = 503; throw e; }
  const url = new URL(`https://data.tronk.info/${endpoint}`);
  url.searchParams.set('key', TRONK_API_KEY);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) url.searchParams.set(k, String(v)); });
  return (await httpRequestJson(url.toString())).data;
}
function unwrap(data) {
  const source = asObject(data);
  for (const key of ['result', 'data', 'response', 'vehicle']) if (source[key] && typeof source[key] === 'object') return source[key];
  return source;
}
function vehicleFromSources(previewRaw, registryRaw) {
  const outer = asObject(previewRaw); const preview = asObject(outer.result); const registry = unwrap(registryRaw);
  return {
    vin: pick(registry, 'vin', 'Vin', 'VIN') || pick(preview, 'Vin', 'vin', 'VIN'),
    brand: pick(preview, 'Marka', 'Brand', 'brand') || pick(registry, 'brand', 'Brand', 'Marka'),
    model: pick(preview, 'Model', 'model') || pick(registry, 'model', 'Model'),
    year: pick(preview, 'Year', 'year') || pick(registry, 'year', 'Year'),
    color: pick(preview, 'Color', 'color') || pick(registry, 'color', 'Color'),
    engineVolume: pick(preview, 'Volume', 'EngineVolume') || pick(registry, 'engineVolume', 'Volume'),
    powerHp: pick(preview, 'HorsePower', 'powerHp') || pick(registry, 'powerHp', 'HorsePower'),
    imageUrl: pick(preview, 'Image', 'imageUrl'),
    bodyNumber: pick(registry, 'body_number', 'BodyNumber', 'bodyNumber'),
    chassisNumber: pick(registry, 'chassis_number', 'ChassisNumber', 'chassisNumber'),
    sts: pick(registry, 'sts', 'STS', 'sts_number'),
    category: pick(registry, 'category', 'Category'),
    recordStatus: pick(registry, 'record_status', 'RecordStatus', 'status'),
    registrationDate: pick(registry, 'registration_date', 'RegistrationDate'),
  };
}
async function lookupVehicle(plateInput, full = false) {
  const plate = normalizePlate(plateInput);
  if (!plate) { const e = new Error('Укажите госномер автомобиля.'); e.statusCode = 400; throw e; }
  const previewRaw = await tronkGet('reportnewcheck.ashx', { gosnumber: plate });
  let registryRaw = {}; let registryMessage = null;
  if (full) {
    try { registryRaw = await tronkGet('convertb2b.ashx', { gosnumber: plate }); }
    catch (e) { registryMessage = e.message; }
  }
  return { ok: true, mode: full ? 'vehicle_lookup_full' : 'vehicle_lookup', plate: formatPlate(plate), vehicle: vehicleFromSources(previewRaw, registryRaw), registry: { available: !registryMessage, message: registryMessage }, source: 'Tronk' };
}

function visionMime(mime) { return mime.includes('pdf') ? 'PDF' : mime.includes('png') ? 'PNG' : 'JPEG'; }
async function visionRecognize(file, model = 'page') {
  if (!VISION_API_KEY || !YC_FOLDER_ID) { const e = new Error('Не настроены VISION_API_KEY или YC_FOLDER_ID.'); e.statusCode = 503; throw e; }
  const response = await httpRequestJson('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText', {
    method: 'POST',
    headers: { Authorization: `Api-Key ${VISION_API_KEY}`, 'x-folder-id': YC_FOLDER_ID, 'x-data-logging-enabled': 'false', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: visionMime(file.mimeType), languageCodes: ['*'], model, content: file.content }),
  });
  const annotation = asObject(response.data.textAnnotation);
  const entities = {};
  (annotation.entities || []).forEach((item) => { if (item.name && item.text && !entities[item.name]) entities[item.name] = item.text; });
  return { text: String(annotation.fullText || ''), entities };
}
function findValue(text, regexp) { const m = String(text || '').match(regexp); return m ? String(m[1] || '').trim() : ''; }
function digits(value) { return String(value || '').replace(/\D/g, ''); }
function passportFromText(text, entities, registrationText) {
  const e = asObject(entities); const number = digits(e.number || findValue(text, /(\d{4})\s*(\d{6})/));
  const dates = String(text || '').match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || [];
  const names = [e.surname, e.name, e.middle_name].map((x) => String(x || '').trim());
  return {
    lastName: names[0], firstName: names[1], middleName: names[2],
    birthDate: e.birth_date || dates[0] || '', birthPlace: e.birth_place || '',
    passportSeries: number.length >= 10 ? number.slice(0, 4) : '', passportNumber: number.length >= 10 ? number.slice(4, 10) : '',
    issuedBy: e.issued_by || '', departmentCode: e.subdivision || findValue(text, /(\d{3}[- ]\d{3})/), issueDate: e.issue_date || dates[dates.length - 1] || '',
    registrationAddress: findValue(registrationText, /(?:АДРЕС|МЕСТО ЖИТЕЛЬСТВА|ЗАРЕГИСТРИРОВАН[А]?)[\s:]*([^\n]+(?:\n[^\n]+){0,3})/i),
  };
}
async function recognizePassportPage(input) {
  const file = validateFile(input.file || input, 'passport page'); const model = String(input.model || 'page'); const result = await visionRecognize(file, model);
  return { ok: true, mode: 'passport_page_recognition', model, text: result.text, entities: result.entities };
}
async function extractPassport(input) {
  const personType = String(input.personType || '').toLowerCase();
  if (!['seller', 'buyer'].includes(personType)) { const e = new Error('Поле personType должно быть seller или buyer.'); e.statusCode = 400; throw e; }
  const mainPage = validateFile(input.mainPage, 'mainPage');
  const page = await visionRecognize(mainPage, 'passport');
  let registrationText = '';
  if (input.registrationPage) registrationText = (await visionRecognize(validateFile(input.registrationPage, 'registrationPage'), 'page')).text;
  const person = passportFromText(page.text, page.entities, registrationText);
  const missingFields = Object.entries(person).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
  return { ok: true, mode: 'passport_extract', personType, person, missingFields, warnings: missingFields.length ? ['Проверьте незаполненные поля по оригиналу паспорта.'] : [], source: 'yandex_vision' };
}

async function getAutotekaToken() {
  if (!AUTOTEKA_CLIENT_ID || !AUTOTEKA_CLIENT_SECRET) { const e = new Error('Не настроены AUTOTEKA_CLIENT_ID и AUTOTEKA_CLIENT_SECRET.'); e.statusCode = 503; throw e; }
  if (autotekaTokenCache.token && autotekaTokenCache.expiresAt > Date.now() + 30000) return autotekaTokenCache.token;
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: AUTOTEKA_CLIENT_ID, client_secret: AUTOTEKA_CLIENT_SECRET }).toString();
  const response = await httpRequestJson(AUTOTEKA_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, timeoutMs: 15000 });
  const token = response.data.access_token || response.data.accessToken;
  if (!token) { const e = new Error('Автотека не вернула access_token.'); e.statusCode = 502; throw e; }
  autotekaTokenCache = { token, expiresAt: Date.now() + Math.max(60, Number(response.data.expires_in || 3600)) * 1000 };
  return token;
}
async function autotekaPost(path, body) {
  const token = await getAutotekaToken();
  return (await httpRequestJson(`${AUTOTEKA_API_BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 45000 })).data;
}
function summarizeAutoteka(raw) {
  const source = asObject(raw.report || raw.result || raw.data || raw); const vehicle = asObject(source.vehicle || source.tech_data || source.vehicleInfo);
  return { reportId: pick(source, 'reportId', 'report_id', 'id'), status: pick(source, 'status', 'state'), vin: pick(source, 'vin', 'VIN') || pick(vehicle, 'vin', 'VIN'), plate: pick(source, 'regNumber', 'registrationNumber'), make: pick(vehicle, 'make', 'mark', 'brand'), model: pick(vehicle, 'model'), year: pick(vehicle, 'year', 'productionYear') };
}
async function autotekaBusinessReport(input) {
  const vin = String(input.vin || input.bodyNumber || '').trim().toUpperCase(); const plate = normalizePlate(input.plate);
  if (!vin && !plate) { const e = new Error('Укажите VIN, номер кузова или государственный номер.'); e.statusCode = 400; throw e; }
  const raw = plate ? await autotekaPost('/autoteka/v1/sync/create-by-regnumber', { regNumber: plate }) : await autotekaPost('/autoteka/v1/sync/create-by-vin', { vin });
  return { ok: true, mode: 'autoteka_business_report', report: summarizeAutoteka(raw), raw, billable: true, note: 'Синхронный отчёт Автотеки списывает проверку из пакета аккаунта.' };
}

async function providerPost(url, token, body, providerName) {
  if (!url) { const e = new Error(`Не настроен URL провайдера: ${providerName}.`); e.statusCode = 501; throw e; }
  return (await httpRequestJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).data;
}
async function checkCounterparty(input) {
  const payload = { lastName: requireText(input.lastName, 'фамилию'), firstName: requireText(input.firstName, 'имя'), middleName: String(input.middleName || ''), birthDate: validateBirthDate(input.birthDate), region: String(input.region || '') };
  const [fssp, pledge] = await Promise.allSettled([providerPost(FSSP_API_URL, FSSP_API_TOKEN, payload, 'ФССП'), providerPost(PLEDGE_API_URL, PLEDGE_API_TOKEN, { ...payload, vin: String(input.vin || '') }, 'Реестр залогов')]);
  const render = (r) => r.status === 'fulfilled' ? { ok: true, data: r.value } : { ok: false, error: r.reason.message, providerError: describeProviderError(r.reason) };
  return { ok: true, mode: 'counterparty_check', query: payload, checks: { fssp: render(fssp), pledges: render(pledge) }, disclaimer: 'Результат требует проверки по официальным документам и идентификаторам должника/предмета залога.' };
}

function rubles(value) { return Number(value || 0).toLocaleString('ru-RU'); }
function safe(value) { return String(value || '').replace(/[<>]/g, ''); }
function buildContractHtml(data) {
  const seller = asObject(data.seller); const buyer = asObject(data.buyer); const car = asObject(data.vehicle);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.45;margin:36px;color:#111}h1{text-align:center;font-size:18pt}h2{font-size:13pt;margin-top:24px}.row{margin:8px 0}.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}</style></head><body><h1>ДОГОВОР КУПЛИ-ПРОДАЖИ ТРАНСПОРТНОГО СРЕДСТВА</h1><div class="row">г. ${safe(data.city || 'Санкт-Петербург')} «${safe(data.date || new Date().toLocaleDateString('ru-RU'))}»</div><p>${safe([seller.lastName,seller.firstName,seller.middleName].filter(Boolean).join(' '))}, паспорт ${safe(seller.passportSeries)} ${safe(seller.passportNumber)}, именуемый «Продавец», и ${safe([buyer.lastName,buyer.firstName,buyer.middleName].filter(Boolean).join(' '))}, паспорт ${safe(buyer.passportSeries)} ${safe(buyer.passportNumber)}, именуемый «Покупатель», заключили договор:</p><h2>1. Предмет договора</h2><p>Продавец передает автомобиль: ${safe(car.brand)} ${safe(car.model)}, год ${safe(car.year)}, VIN ${safe(car.vin)}, госномер ${safe(car.plate)}, цвет ${safe(car.color)}.</p><h2>2. Цена и расчёты</h2><p>Цена автомобиля: ${rubles(data.price)} руб. Порядок оплаты: ${safe(data.paymentTerms || 'полный расчёт при подписании')}.</p><h2>3. Заявления сторон</h2><p>Продавец подтверждает право собственности и сообщает сведения об ограничениях, залогах и спорах. Покупатель осмотрел автомобиль и документы. Стороны обязуются проверить реквизиты и подписать каждый экземпляр.</p><div class="sign"><div><b>Продавец</b><br><br>___________ / ${safe(seller.lastName)}</div><div><b>Покупатель</b><br><br>___________ / ${safe(buyer.lastName)}</div></div></body></html>`;
}

function base64url(value) { return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function getGoogleToken() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) { const e = new Error('Не настроен GOOGLE_SERVICE_ACCOUNT_JSON.'); e.statusCode = 501; throw e; }
  if (googleTokenCache.token && googleTokenCache.expiresAt > Date.now() + 30000) return googleTokenCache.token;
  const account = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON); const now = Math.floor(Date.now()/1000);
  const unsigned = `${base64url(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${base64url(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/drive.file',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const form = new URLSearchParams({ grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  const response = await httpRequestJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});
  googleTokenCache={token:response.data.access_token,expiresAt:Date.now()+Number(response.data.expires_in||3600)*1000}; return googleTokenCache.token;
}
async function uploadHtmlToDrive(name, html) {
  const token = await getGoogleToken(); const boundary=`agent_${Date.now()}`;
  const metadata={name,mimeType:'application/vnd.google-apps.document',...(GOOGLE_DRIVE_FOLDER_ID?{parents:[GOOGLE_DRIVE_FOLDER_ID]}:{})};
  const body=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
  const response=await httpRequestJson('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/related; boundary=${boundary}`},body});
  return response.data;
}
async function createContract(input) {
  const html=buildContractHtml(input); let drive=null;
  if (input.saveToDrive===true) drive=await uploadHtmlToDrive(`ДКП ${safe(asObject(input.vehicle).vin||'автомобиль')}`,html);
  return {ok:true,mode:'contract_create',format:'html_print_to_pdf',fileName:`dkp-${Date.now()}.html`,contentBase64:Buffer.from(html).toString('base64'),drive,warning:'Перед подписанием проверьте паспортные данные, VIN, цену и условия. Для PDF откройте HTML и выберите «Печать → Сохранить как PDF».'};
}

async function llmJson(system, user, schema, maxTokens='3000') {
  if (!LLM_API_KEY || !YC_FOLDER_ID) { const e=new Error('Не настроены LLM_API_KEY/VISION_API_KEY или YC_FOLDER_ID.'); e.statusCode=503; throw e; }
  const response=await httpRequestJson('https://llm.api.cloud.yandex.net/foundationModels/v1/completion',{method:'POST',headers:{Authorization:`Api-Key ${LLM_API_KEY}`,'x-folder-id':YC_FOLDER_ID,'x-data-logging-enabled':'false','Content-Type':'application/json'},body:JSON.stringify({modelUri:`gpt://${YC_FOLDER_ID}/${LLM_MODEL}`,completionOptions:{stream:false,temperature:0,maxTokens},jsonSchema:{schema},messages:[{role:'system',text:system},{role:'user',text:user}]})});
  const text=String(response.data.result?.alternatives?.[0]?.message?.text||''); const start=text.indexOf('{'),end=text.lastIndexOf('}'); return JSON.parse(start>=0&&end>start?text.slice(start,end+1):text);
}
async function estimateBodyRepair(input) {
  const photos=(input.photos||[]).slice(0,6).map((f,i)=>validateFile(f,`photo_${i+1}`)); if(!photos.length){const e=new Error('Передайте хотя бы одну фотографию повреждения.');e.statusCode=400;throw e;}
  const descriptions=[]; for(const photo of photos){descriptions.push((await visionRecognize(photo,'page')).text);}
  const partsCatalog=ACADEMIC_PARTS_URL?await providerPost(ACADEMIC_PARTS_URL,ACADEMIC_PARTS_TOKEN,{vehicle:input.vehicle,descriptions},'Академический'):null;
  const schema={type:'object',properties:{summary:{type:'string'},damageItems:{type:'array',items:{type:'object',properties:{part:{type:'string'},damage:{type:'string'},operation:{type:'string'},laborHours:{type:'number'},confidence:{type:'number'}},required:['part','damage','operation','laborHours','confidence']}},partsEstimate:{type:'number'},laborEstimate:{type:'number'},paintEstimate:{type:'number'},totalLow:{type:'number'},totalHigh:{type:'number'},warnings:{type:'array',items:{type:'string'}}},required:['summary','damageItems','partsEstimate','laborEstimate','paintEstimate','totalLow','totalHigh','warnings']};
  const prompt=JSON.stringify({vehicle:input.vehicle,ocrPhotoNotes:descriptions,visibleDamageNotes:input.notes||'',partsCatalog});
  const estimate=await llmJson('Ты эксперт кузовного ремонта. Оцени только видимые повреждения, не выдумывай скрытые дефекты. Дай диапазон; если данных мало, увеличь диапазон и добавь предупреждение. Стоимость деталей бери только из переданного каталога, иначе укажи, что цена ориентировочная.',prompt,schema);
  return {ok:true,mode:'body_repair_estimate',estimate,currency:'RUB',photosProcessed:photos.length,partsSource:partsCatalog?'Академический':'не подключён',disclaimer:'Предварительная оценка по фото не заменяет дефектовку на СТО; скрытые повреждения и геометрия кузова требуют очного осмотра.'};
}

module.exports.handler = async function handler(event) {
  try {
    const method=String(event?.httpMethod||event?.requestContext?.http?.method||'POST').toUpperCase();
    if(method==='OPTIONS')return{statusCode:204,headers:corsHeaders(),body:''};
    if(method!=='POST')return jsonResponse(405,{ok:false,error:'Используйте HTTP-метод POST.'});
    const body=parseEventBody(event); const action=String(body.action||'').trim();
    if(action==='lookup_vehicle'||action==='lookup_vehicle_preview')return jsonResponse(200,await lookupVehicle(body.plate,false));
    if(action==='lookup_vehicle_full'||action==='lookup_vehicle_registry')return jsonResponse(200,await lookupVehicle(body.plate,true));
    if(action==='recognize_passport_page')return jsonResponse(200,await recognizePassportPage(body));
    if(action==='extract_passport')return jsonResponse(200,await extractPassport(body));
    if(action==='autoteka_business_report'||action==='autoru_business_report')return jsonResponse(200,await autotekaBusinessReport(body));
    if(action==='check_counterparty')return jsonResponse(200,await checkCounterparty(body));
    if(action==='create_contract')return jsonResponse(200,await createContract(body));
    if(action==='estimate_body_repair')return jsonResponse(200,await estimateBodyRepair(body));
    if(action==='agent_capabilities')return jsonResponse(200,{ok:true,actions:['lookup_vehicle','lookup_vehicle_full','recognize_passport_page','extract_passport','autoteka_business_report','check_counterparty','create_contract','estimate_body_repair']});
    return jsonResponse(400,{ok:false,error:'Неподдерживаемое действие.'});
  } catch(error) {
    console.error({name:error.name,message:error.message,statusCode:error.statusCode||500});
    return jsonResponse(error.statusCode||500,{ok:false,error:error.message||'Внутренняя ошибка функции.',providerError:describeProviderError(error)});
  }
};
