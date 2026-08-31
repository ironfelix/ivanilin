# Серверная часть пульта

`pult-api.py` — база задач и мост с `TODO.md` Майка. Живёт на сервере как
`/srv/pult/api.py`, запускается юнитом `pult-api.service` на 127.0.0.1:8901.
Здесь копия для истории правок: на сервере файл правится и перезапускается,
выкладки из репозитория для него нет.

```bash
# обновить на сервере
scp -i ~/.ssh/hermes_fix server/pult-api.py root@146.103.116.66:/srv/pult/api.py
ssh -i ~/.ssh/hermes_fix root@146.103.116.66 systemctl restart pult-api
```

Смежное на сервере:

| Что | Где |
| --- | --- |
| База | `/var/lib/pult/pult.db` |
| Бэкапы | `/var/backups/pult`, крон 4:17, 14 копий |
| Токен пульта | `/root/.hermes/pult-token.txt` |
| Проверка токенов | `/etc/nginx/conf.d/mike-bridge-auth.conf` (отзыв — удалить строку) |
| Мост файлов Майка | `/root/.hermes/bin/mike-bridge-sync.sh`, крон раз в минуту |
