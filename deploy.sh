#!/bin/bash
# Выкладка ivanilin.ru.
#
# Главное, что стоит знать: домен ivanilin.ru НЕ обслуживается GitHub Pages,
# хотя репозиторий на них похож и в CNAME лежит ironfelix.github.io.
# Живой сайт отдаёт nginx на 146.103.116.66 из каталога /var/www/ivanilin.ru,
# и это не git-репозиторий. Поэтому push в main сам по себе ничего не меняет:
# страницу видно только после этого скрипта.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@146.103.116.66}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/hermes_fix}"
ROOT="/var/www/ivanilin.ru"

cd "$(dirname "$0")"

# Берём файлы из коммита, а не из рабочего дерева. На macOS каталоги pult/ и
# Pult/ схлопываются в один (файловая система не различает регистр), и копия
# рабочего дерева увезла бы на сервер не тот index.html.
REV="$(git rev-parse --short HEAD)"
echo "Выкладываю $REV → $HOST:$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive HEAD pult Pult > "$TMP/site.tar"

scp -i "$KEY" -q "$TMP/site.tar" "$HOST:/tmp/site.tar"
ssh -i "$KEY" "$HOST" "
    set -e
    rm -rf $ROOT/pult $ROOT/Pult
    tar -xf /tmp/site.tar -C $ROOT
    chown -R www-data:www-data $ROOT/pult $ROOT/Pult
    find $ROOT/pult $ROOT/Pult -type d -exec chmod 755 {} \;
    find $ROOT/pult $ROOT/Pult -type f -exec chmod 644 {} \;
    rm -f /tmp/site.tar
"

# Проверяем результат, а не факт копирования: сервер может отдать 200 и при
# этом показывать старое, если сломался путь или права.
echo "Проверка:"
for u in /pult/ /pult/assets/app.js /pult/manifest.webmanifest; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "https://ivanilin.ru$u?cb=$RANDOM")"
    printf '  %-28s %s\n' "$u" "$code"
    [ "$code" = "200" ] || { echo "ОШИБКА: $u отдаёт $code"; exit 1; }
done
title="$(curl -sS "https://ivanilin.ru/pult/?cb=$RANDOM" | grep -o '<title>[^<]*</title>')"
echo "  $title"
echo "Готово: https://ivanilin.ru/pult/"
