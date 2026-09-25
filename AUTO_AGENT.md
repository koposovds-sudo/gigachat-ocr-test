# Auto Business Agent — план внедрения

Ветка содержит серверный MVP автомобильного агента на базе существующей Yandex Cloud Function.

## Реализованные действия

- `lookup_vehicle`, `lookup_vehicle_full` — существующая логика поиска ТС по госномеру через Tronk.
- `recognize_passport_page`, `extract_passport` — распознавание паспорта через Yandex Vision.
- `autoteka_business_report` — официальный Автотека API: OAuth 2.0 client credentials и синхронный отчёт по VIN/номеру кузова или ГРЗ.
- `check_counterparty` — единая проверка ФССП и реестра залогов через подключаемых официальных/лицензированных провайдеров.
- `create_contract` — формирование печатного ДКП, опциональное сохранение в Google Drive как Google Doc; пользователь сохраняет документ в PDF через печать.
- `estimate_body_repair` — предварительная оценка кузовного ремонта по фото с Yandex Vision/YandexGPT и опциональными ценами «Академического».
- `agent_capabilities` — список функций агента.

## Переменные окружения

### Уже использовались

- `ALLOWED_ORIGIN`
- `TRONK_API_KEY`
- `YC_FOLDER_ID`
- `VISION_API_KEY`
- `LLM_API_KEY` (можно не задавать, если используется `VISION_API_KEY`)
- `LLM_MODEL` (по умолчанию `yandexgpt/latest`)

### Автотека

- `AUTOTEKA_CLIENT_ID`
- `AUTOTEKA_CLIENT_SECRET`
- `AUTOTEKA_API_BASE` (по умолчанию `https://pro.autoteka.ru`)
- `AUTOTEKA_TOKEN_URL` (по умолчанию `https://pro.autoteka.ru/token`)

Важно: синхронные методы Автотеки должны быть включены менеджером Автотеки и списывают проверку из пакета аккаунта.

### ФССП и залоги

- `FSSP_API_URL`, `FSSP_API_TOKEN`
- `PLEDGE_API_URL`, `PLEDGE_API_TOKEN`

URL должны указывать на ваши разрешённые интеграционные шлюзы. Автоматизация CAPTCHA/обход ограничений публичных сайтов не используется.

### Google Drive

- `GOOGLE_SERVICE_ACCOUNT_JSON` — JSON сервисного аккаунта одной строкой.
- `GOOGLE_DRIVE_FOLDER_ID` — папка, которой выдали доступ сервисному аккаунту.

### «Академический»

- `ACADEMIC_PARTS_URL`
- `ACADEMIC_PARTS_TOKEN`

Ожидается корпоративный endpoint с ценами деталей/нормо-часа. Пока URL не задан, оценка явно помечает цены как ориентировочные.

## Примеры запросов

```json
{"action":"autoteka_business_report","vin":"XTA210990Y2766111"}
```

```json
{"action":"check_counterparty","lastName":"Иванов","firstName":"Иван","middleName":"Иванович","birthDate":"01.01.1980","vin":"XTA210990Y2766111"}
```

```json
{"action":"create_contract","city":"Санкт-Петербург","price":1500000,"seller":{},"buyer":{},"vehicle":{},"saveToDrive":true}
```

```json
{"action":"estimate_body_repair","vehicle":{"brand":"LADA","model":"Vesta"},"photos":[{"name":"damage.jpg","mimeType":"image/jpeg","content":"BASE64"}]}
```

## Ограничения MVP

- Результаты OCR необходимо сверять с оригиналами документов.
- ДКП перед подписанием требует проверки реквизитов и при нестандартной сделке — юристом.
- Оценка ремонта по фото предварительная и не заменяет дефектовку на СТО.
- ФССП по одному ФИО и дате рождения может возвращать однофамильцев; нужен регион и ручная верификация.
