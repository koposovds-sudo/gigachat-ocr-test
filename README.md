# Тест Yandex Vision OCR

Мини-сайт для проверки распознавания документов через существующую Yandex Cloud Function `dkp-gigachat-proxy`.

## Что проверяет

- загрузку одного файла PDF, JPG, JPEG или PNG;
- ограничение размера файла до 10 МБ;
- отправку файла в Base64 в Cloud Function;
- получение и отображение текста из Yandex Vision OCR.

Сайт отправляет запрос на:

```text
https://functions.yandexcloud.net/d4e6gg7qd3tlqotvn86c
```

## Публикация через GitHub Pages

1. Откройте репозиторий на GitHub.
2. Перейдите в **Settings** → **Pages**.
3. В блоке **Build and deployment** выберите Source: **Deploy from a branch**, Branch: **main**, Folder: **/(root)**.
4. Нажмите **Save**.
5. Адрес сайта будет: `https://koposovds-sudo.github.io/gigachat-ocr-test/`.

## Важно

- В коде сайта нет API-ключей и секретов.
- Не добавляйте в репозиторий ключи GigaChat, Vision OCR или файлы `.env`.
- Если запрос блокируется браузером, проверьте, что в `ALLOWED_ORIGIN` Cloud Function указан `https://koposovds-sudo.github.io`.
