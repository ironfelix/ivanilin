#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
База пульта на сервере и мост с TODO.md Майка.

Зачем. Раньше пульт держал всё в localStorage браузера. Это значило: телефон и
ноутбук — две несвязанные копии, перенос руками через файл, а чистка данных
сайта стирала конспекты звонков. Теперь источник правды — SQLite на сервере,
браузер оставляет у себя только кеш, чтобы работать офлайн.

Синхронизация построена на счётчике ревизий, а не на времени: у телефона и
ноутбука часы разные, и «свежее по времени» врало бы. Каждая правка поднимает
общий rev; клиент просит «всё, что новее моего rev» и присылает своё.
Одновременную правку одной строки разводим по updated_at — это последний
рубеж, до которого доходит редко.

Мост с TODO.md. Файл Майка — живой документ со своей структурой: приоритеты,
эмодзи-заголовки, пояснения под строками. Переписывать его целиком нельзя,
иначе агент лишится своей разметки. Поэтому правки от пульта ложатся в те же
строки (галочка и текст), а новые задачи дописываются в раздел «Из пульта».
Свои же записи мост узнаёт по хешу и не принимает их обратно как чужие —
иначе получилось бы эхо.

Конспекты. Файлы konspekty/*.md и записи пульта — один пул: правка файла
едет в базу, правка записи — обратно в файл. Направление выбирает хеш.
Запись, заведённая в пульте, получает свой файл, чтобы Майк её тоже видел.

    systemd: pult-api.service, слушает 127.0.0.1:8901
    nginx:   location /pult/api/ → сюда (за тем же Bearer-токеном)
    база:    /var/lib/pult/pult.db
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB_PATH = os.environ.get("PULT_DB", "/var/lib/pult/pult.db")
TODO_PATH = os.environ.get("PULT_TODO", "/root/.hermes/TODO.md")
KONSPEKTY_DIR = os.environ.get("PULT_KONSPEKTY", "/root/.hermes/konspekty")
PORT = int(os.environ.get("PULT_PORT", "8901"))

# Раздел, куда дописываются задачи, заведённые в пульте.
PULT_SECTION = "## Из пульта"

# Коллекции, которые синхронизируются построчно. Поля перечислены явно:
# так схема базы и формат обмена не расходятся молча.
COLLECTIONS = {
    "tasks": ["title", "note", "list", "context", "projectId", "person",
              "due", "minutes", "topGoal", "createdAt", "updatedAt", "doneAt", "prevList"],
    "projects": ["title", "outcome", "goalId", "status", "createdAt", "reviewedAt"],
    "goals": ["title", "horizon", "isTop", "createdAt"],
    # mdFile ездит в обе стороны только как метка происхождения: клиент
    # возвращает её без изменений, файлами распоряжается сам сервис
    "notes": ["title", "person", "projectId", "date", "body", "createdAt", "updatedAt", "mdFile"],
}

_lock = threading.RLock()


def col(name):
    """camelCase из JSON → snake_case в SQL."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    return db


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = connect()
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
        for name, fields in COLLECTIONS.items():
            cols = ", ".join(f"{col(f)} TEXT" for f in fields)
            db.execute(
                f"CREATE TABLE IF NOT EXISTS {name} ("
                f"id TEXT PRIMARY KEY, {cols}, "
                f"rev INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)"
            )
            db.execute(f"CREATE INDEX IF NOT EXISTS {name}_rev ON {name}(rev)")
        # одиночные объекты (topGoal, review, settings) — целиком в JSON
        db.execute("CREATE TABLE IF NOT EXISTS kv ("
                   "k TEXT PRIMARY KEY, v TEXT, rev INTEGER NOT NULL)")
        db.execute("INSERT OR IGNORE INTO meta VALUES ('rev', '0')")
    db.close()


def bump_rev(db):
    db.execute("UPDATE meta SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k='rev'")
    return int(db.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0])


def get_rev(db):
    return int(db.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0])


def meta_get(db, k, default=""):
    row = db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row[0] if row else default


def meta_set(db, k, v):
    db.execute("INSERT INTO meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


# ---------- обмен с клиентом ----------

def row_to_json(row, fields):
    out = {"id": row["id"]}
    for f in fields:
        v = row[col(f)]
        if f in ("minutes",):
            out[f] = int(v) if v not in (None, "") else None
        elif f in ("topGoal", "isTop"):
            out[f] = v == "1"
        else:
            out[f] = v
    if row["deleted"]:
        out["deleted"] = True
    return out


def to_sql(f, v):
    if isinstance(v, bool):
        return "1" if v else ""
    if v is None:
        return None
    return str(v)


def pull(since):
    with _lock:
        db = connect()
        try:
            out = {"rev": get_rev(db)}
            for name, fields in COLLECTIONS.items():
                rows = db.execute(f"SELECT * FROM {name} WHERE rev > ?", (since,)).fetchall()
                out[name] = [row_to_json(r, fields) for r in rows]
            out["kv"] = {r["k"]: json.loads(r["v"])
                         for r in db.execute("SELECT * FROM kv WHERE rev > ?", (since,))}
            return out
        finally:
            db.close()


def push(payload):
    """Принимает правки клиента. Строку перезаписываем, только если версия
    клиента новее той, что лежит — иначе догоняющий планшет затёр бы свежее."""
    with _lock:
        db = connect()
        try:
            with db:
                rev = bump_rev(db)
                for name, fields in COLLECTIONS.items():
                    for item in payload.get(name, []):
                        if not item.get("id"):
                            continue
                        cur = db.execute(f"SELECT * FROM {name} WHERE id=?", (item["id"],)).fetchone()
                        if cur is not None and "updatedAt" in fields:
                            if (item.get("updatedAt") or "") < (cur[col("updatedAt")] or ""):
                                continue
                        vals = [to_sql(f, item.get(f)) for f in fields]
                        cols = ", ".join(["id"] + [col(f) for f in fields] + ["rev", "deleted"])
                        marks = ", ".join("?" * (len(fields) + 3))
                        upd = ", ".join(f"{col(f)}=excluded.{col(f)}" for f in fields)
                        db.execute(
                            f"INSERT INTO {name} ({cols}) VALUES ({marks}) "
                            f"ON CONFLICT(id) DO UPDATE SET {upd}, rev=excluded.rev, deleted=excluded.deleted",
                            [item["id"]] + vals + [rev, 1 if item.get("deleted") else 0])
                for k, v in (payload.get("kv") or {}).items():
                    db.execute("INSERT INTO kv VALUES (?,?,?) "
                               "ON CONFLICT(k) DO UPDATE SET v=excluded.v, rev=excluded.rev",
                               (k, json.dumps(v, ensure_ascii=False), rev))
            return {"rev": get_rev(db)}
        finally:
            db.close()


# ---------- мост с TODO.md ----------

TASK_RE = re.compile(r"^(\s*[-*+]\s+)\[([ xX])\]\s*(.+?)\s*$")
HEAD_RE = re.compile(r"^##\s+(.+?)\s*$")

# заголовки Майка → списки пульта; всё незнакомое считаем next
HEADINGS = {
    "next actions": "next", "действия": "next", "задачи": "next", "todo": "next",
    "инбокс": "inbox", "входящие": "inbox",
    "ожидание": "waiting", "ждём": "waiting",
    "agenda": "agenda", "повестка": "agenda",
    "когда-нибудь": "someday", "потом": "someday",
    "сделано": "done", "выполнено": "done",
}


def norm(t):
    """Ключ сопоставления строки файла и задачи: без разметки и регистра."""
    t = re.sub(r"~~(.+?)~~", r"\1", t)           # зачёркнутое
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", t)       # жирное
    t = re.sub(r"<!--.*?-->", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip().lower()


def section_list(title):
    t = title.strip().lower()
    for k, v in HEADINGS.items():
        if k in t:
            return v
    return "next"


def read_todo():
    try:
        with open(TODO_PATH, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def file_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_todo(text):
    """Строки-задачи файла: ключ, текст, галочка, список, номер строки."""
    out = []
    lst = "next"
    for i, line in enumerate(text.split("\n")):
        h = HEAD_RE.match(line)
        if h:
            lst = section_list(h.group(1))
            continue
        m = TASK_RE.match(line)
        if not m:
            continue
        title = m.group(3).strip()
        key = norm(title)
        if key:
            out.append({"line": i, "key": key, "title": title,
                        "done": m.group(2).lower() == "x", "list": lst})
    return out


def import_todo(db, text):
    """Файл → база. Новые строки Майка становятся задачами, снятая им
    галочка закрывает задачу в пульте."""
    rev = None
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    existing = {}
    for r in db.execute("SELECT id, title, list, md_key FROM tasks WHERE deleted=0"):
        k = r["md_key"] or norm(r["title"] or "")
        existing.setdefault(k, r)

    for item in parse_todo(text):
        cur = existing.get(item["key"])
        want_list = "done" if item["done"] else (item["list"] if item["list"] != "done" else "next")
        if cur is None:
            if rev is None:
                rev = bump_rev(db)
            tid = "md" + hashlib.sha1(item["key"].encode()).hexdigest()[:12]
            db.execute(
                "INSERT OR IGNORE INTO tasks (id, title, note, list, context, project_id, person,"
                " due, minutes, top_goal, created_at, updated_at, done_at, prev_list, md_key, rev, deleted)"
                " VALUES (?,?,'',?,NULL,NULL,'',NULL,NULL,'',?,?,?,NULL,?,?,0)",
                (tid, item["title"], want_list, now, now,
                 now if item["done"] else None, item["key"], rev))
        elif cur["list"] != want_list and (cur["list"] == "done") != item["done"]:
            # изменилась именно галочка — переносим статус, текст не трогаем
            if rev is None:
                rev = bump_rev(db)
            db.execute(
                "UPDATE tasks SET list=?, done_at=?, updated_at=?, rev=? WHERE id=?",
                (want_list, now if item["done"] else None, now, rev, cur["id"]))
    return rev is not None


def export_todo(db, text):
    """База → файл. Правим строки на месте и дописываем новое в свой раздел,
    чтобы структура файла Майка осталась нетронутой."""
    lines = text.split("\n")
    parsed = parse_todo(text)
    by_key = {p["key"]: p for p in parsed}
    changed = False

    tasks = db.execute("SELECT * FROM tasks WHERE deleted=0").fetchall()
    seen = set()
    for t in tasks:
        key = t["md_key"] or norm(t["title"] or "")
        seen.add(key)
        p = by_key.get(key)
        if not p:
            continue
        want_done = t["list"] == "done"
        if want_done != p["done"]:
            m = TASK_RE.match(lines[p["line"]])
            lines[p["line"]] = f"{m.group(1)}[{'x' if want_done else ' '}] {m.group(3)}"
            changed = True

    # новые задачи из пульта — в отдельный раздел в конце
    fresh = [t for t in tasks
             if not t["md_key"] and norm(t["title"] or "") not in by_key
             and t["list"] not in ("done", "someday")]
    if fresh:
        if PULT_SECTION not in text:
            lines += ["", PULT_SECTION, ""]
        at = lines.index(PULT_SECTION) + 1
        while at < len(lines) and (lines[at].strip() == "" or TASK_RE.match(lines[at])):
            at += 1
        for t in fresh:
            lines.insert(at, f"- [{'x' if t['list'] == 'done' else ' '}] {t['title']}")
            at += 1
            db.execute("UPDATE tasks SET md_key=? WHERE id=?", (norm(t["title"] or ""), t["id"]))
        changed = True

    return ("\n".join(lines), changed)


def sync_todo():
    """Один круг моста. Вызывается по таймеру и после каждого push."""
    with _lock:
        db = connect()
        try:
            with db:
                text = read_todo()
                h = file_hash(text)
                # файл изменился не нами — принимаем правки Майка
                if h != meta_get(db, "todo_hash"):
                    import_todo(db, text)
                new_text, changed = export_todo(db, text)
                if changed:
                    tmp = TODO_PATH + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.write(new_text)
                    os.replace(tmp, TODO_PATH)
                    text = new_text
                meta_set(db, "todo_hash", file_hash(text))
        except Exception as e:                       # мост не должен ронять API
            print("sync_todo:", e, flush=True)
        finally:
            db.close()


# ---------- мост с konspekty/ ----------

# Конспекты Майка — обычные .md файлы. Держим их и записи пульта одним
# пулом: файл ↔ строка в notes. Направление правки выбираем по хешу:
# изменился файл — принимаем его, изменилась запись — пишем в файл.

DATE_RE = re.compile(r"(20\d\d)-(\d\d)-(\d\d)")


def slugify(title, fallback):
    s = re.sub(r"[^\w\s-]", "", (title or "").lower(), flags=re.U)
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return (s[:60] or fallback)


def note_id_for(fname):
    return "md" + hashlib.sha1(fname.encode()).hexdigest()[:12]


def md_title(text, fallback):
    for line in text.split("\n"):
        m = re.match(r"#\s+(.+)", line.strip())
        if m:
            return m.group(1).strip()
    return fallback


def sync_notes():
    """Один круг моста конспектов."""
    with _lock:
        db = connect()
        try:
            with db:
                _sync_notes_inner(db)
        except Exception as e:
            print("sync_notes:", e, flush=True)
        finally:
            db.close()


def _sync_notes_inner(db):
    os.makedirs(KONSPEKTY_DIR, exist_ok=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    rev = [None]

    def need_rev():
        if rev[0] is None:
            rev[0] = bump_rev(db)
        return rev[0]

    rows = {r["md_file"]: r for r in db.execute(
        "SELECT * FROM notes WHERE deleted=0 AND md_file IS NOT NULL")}

    # 1) файлы → база
    files = sorted(f for f in os.listdir(KONSPEKTY_DIR) if f.endswith(".md"))
    for fname in files:
        path = os.path.join(KONSPEKTY_DIR, fname)
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        h = file_hash(text)
        cur = rows.get(fname)
        if cur is None:
            d = DATE_RE.search(fname)
            db.execute(
                "INSERT OR IGNORE INTO notes (id, title, person, project_id, date, body,"
                " created_at, updated_at, md_file, md_hash, rev, deleted)"
                " VALUES (?,?,'',NULL,?,?,?,?,?,?,?,0)",
                (note_id_for(fname), md_title(text, fname[:-3]),
                 "-".join(d.groups()) if d else time.strftime("%Y-%m-%d"),
                 text, now, now, fname, h, need_rev()))
        elif cur["md_hash"] != h:
            # файл изменили снаружи — версия из файла главнее
            db.execute(
                "UPDATE notes SET body=?, title=?, md_hash=?, updated_at=?, rev=? WHERE id=?",
                (text, md_title(text, cur["title"] or fname[:-3]), h, now, need_rev(), cur["id"]))

    # 2) база → файлы
    for r in db.execute("SELECT * FROM notes WHERE deleted=0"):
        body = r["body"] or ""
        fname = r["md_file"]
        if fname:
            if file_hash(body) == (r["md_hash"] or ""):
                continue                       # запись не менялась — писать нечего
            path = os.path.join(KONSPEKTY_DIR, fname)
        else:
            # новая запись пульта: заводим файл, чтобы конспекты жили одним пулом
            if not body.strip() and not (r["title"] or "").strip():
                continue
            date = (r["date"] or time.strftime("%Y-%m-%d"))[:10]
            fname = f"{date}-{slugify(r['title'], r['id'])}.md"
            path = os.path.join(KONSPEKTY_DIR, fname)
            n = 2
            while os.path.exists(path):
                fname = f"{date}-{slugify(r['title'], r['id'])}-{n}.md"
                path = os.path.join(KONSPEKTY_DIR, fname)
                n += 1
            if not body.lstrip().startswith("#") and (r["title"] or "").strip():
                body = f"# {r['title']}\n\n{body}"
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp, path)
        # body возвращаем в базу: для новой записи мы дописали заголовок, и без
        # этого следующий круг увидел бы расхождение и переписал файл обратно
        db.execute("UPDATE notes SET md_file=?, md_hash=?, body=?, rev=? WHERE id=?",
                   (fname, file_hash(body), body, need_rev(), r["id"]))

    # 3) файл удалили у Майка — прячем запись, чтобы список не врал
    for fname, r in rows.items():
        if fname not in files and not os.path.exists(os.path.join(KONSPEKTY_DIR, fname)):
            db.execute("UPDATE notes SET deleted=1, rev=? WHERE id=?", (need_rev(), r["id"]))


def watcher():
    while True:
        time.sleep(20)
        sync_todo()
        sync_notes()


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # авторизацию проверяет nginx: сервис слушает только 127.0.0.1
        if self.path.startswith("/api/pull"):
            q = self.path.split("?", 1)[1] if "?" in self.path else ""
            since = 0
            for part in q.split("&"):
                if part.startswith("since="):
                    try:
                        since = int(part[6:])
                    except ValueError:
                        pass
            return self._send(200, pull(since))
        if self.path.startswith("/api/health"):
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/api/push"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._send(400, {"error": f"плохой JSON: {e}"})
        try:
            res = push(payload)
        except Exception as e:
            print("push:", e, flush=True)
            return self._send(500, {"error": str(e)})
        threading.Thread(target=lambda: (sync_todo(), sync_notes()), daemon=True).start()
        self._send(200, res)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    init_db()
    # md_key появился позже схемы — добавляем, если базу заводили раньше
    db = connect()
    if "md_key" not in [r[1] for r in db.execute("PRAGMA table_info(tasks)")]:
        with db:
            db.execute("ALTER TABLE tasks ADD COLUMN md_key TEXT")
    have = [r[1] for r in db.execute("PRAGMA table_info(notes)")]
    with db:
        for c in ("md_file", "md_hash"):
            if c not in have:
                db.execute(f"ALTER TABLE notes ADD COLUMN {c} TEXT")
    db.close()
    sync_todo()
    sync_notes()
    threading.Thread(target=watcher, daemon=True).start()
    print(f"pult-api на 127.0.0.1:{PORT}, база {DB_PATH}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
