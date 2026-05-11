<!-- markdownlint-disable MD033 MD041 -->

<h1 align="center">ssh-chat-mcp</h1>

<p align="center">
  <b>Zero-config SSH/SFTP MCP server.</b><br>
  All connection data is passed from chat — never from config files, env variables, or disk.
</p>

<p align="center">
  <a href="https://aiplatforms.ru/"><img alt="By AI Platforms" src="https://img.shields.io/badge/by-AI%20Platforms-0a66c2"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <a href="https://nodejs.org/"><img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen"></a>
  <a href="https://modelcontextprotocol.io/"><img alt="MCP" src="https://img.shields.io/badge/MCP-1.x-purple"></a>
</p>

---

<p align="center">
  <a href="#english">English</a> · <a href="#russian">Русский</a>
</p>

---

<a id="english"></a>

## English

`ssh-chat-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that
lets an LLM client open temporary SSH/SFTP sessions to remote hosts, run commands
(including `sudo -iu`), and upload/download files — **without** the MCP server
holding any pre-baked credentials, hosts, paths, or environment secrets.

You start the server with no arguments. Then, in chat, you give the model a host
plus credentials, it calls `connect`, does its work, calls `disconnect`, and the
credentials are wiped from RAM.

> Built by **[AI Platforms](https://aiplatforms.ru/)** — on-premises LLM and computer-vision systems for enterprises that need their AI to stay inside their own server room.

### Why zero-config

Most SSH automation wants you to put `~/.ssh/config`, `inventory.yml`,
`HOST=…`, `SSH_PRIVATE_KEY=…` or similar on disk. That's fine for one stable
production target and a CI worker. It's wrong when:

- You want an LLM client to *occasionally* SSH into a box you set up yesterday,
  deploy a thing, and walk away.
- You don't want a hostname / username / key visible to anything that reads
  your MCP config — including extensions, IDE integrations, or other MCP
  servers.
- You don't want the LLM client to remember anything about your infrastructure
  once the chat ends.

`ssh-chat-mcp` keeps the MCP layer pure and pushes every connection detail into
the conversation, where you (the user) can see it explicitly and where it dies
with the connection.

### Install

```bash
git clone https://github.com/aiplatforms-ru/ssh-chat-mcp.git
cd ssh-chat-mcp
npm install
npm run build
```

This produces `build/index.js`, an ESM Node script with a `#!/usr/bin/env node`
shebang. Requires **Node.js 20 or newer** (22 recommended).

Verify the server starts silently — it must not print anything to stdout
(stdout is reserved for MCP JSON-RPC traffic):

```bash
node build/index.js
```

Press `Ctrl+C` to stop. No output is expected.

### Quick start

In your MCP client (Claude Code / Codex / Kilo / LM Studio / Cursor / etc.),
register the server (see [Integrations](#integrations) below), then say:

> Use the `ssh-chat` MCP. Call `connect` with connectionName=`t1`,
> host=`203.0.113.10`, username=`deploy`, password=`<your password>`. Then run
> `exec` with command `whoami && hostname`. Then `disconnect`.

That's the whole workflow: connect → do stuff → disconnect.

---

### Tools

All inputs are validated with [zod](https://github.com/colinhacks/zod). All
outputs and error messages pass through a redaction layer that removes:

- Field values for keys named `password`, `passphrase`, `privateKey`,
  `sudoPassword`, `token`, `apiKey`, `Authorization`, `secret`.
- `password=`, `*_PASSWORD=`, `token=`, `secret=`, `Authorization: Bearer …`
  patterns in text.
- PEM-encoded private key blocks.

| Tool | What it does |
|------|--------------|
| `connect` | Open an SSH session. Requires `connectionName`, `host`, `username`, plus `password` or `privateKey` (PEM). Optional `port` (default 22), `passphrase`, `readyTimeoutMs`, `keepaliveIntervalMs`. Credentials live only in RAM. |
| `disconnect` | Close the SSH+SFTP session and wipe credentials from memory. |
| `list_connections` | Return non-sensitive metadata for all active connections. |
| `exec` | Run a shell command. With `cwd`, wraps as `cd <quoted cwd> && <command>`. Returns `stdout, stderr, exitCode, signal, timedOut`. |
| `exec_as` | Run as another Linux user via `sudo -S -p '' -iu <runAs> -- bash -lc <command>`. `runAs` is strictly validated (`^[a-z_][a-z0-9_-]{0,31}$`). `sudoPassword` is piped via stdin and never logged. |
| `upload_file` | SFTP upload one file. Optional `mode`, `mkdirParents`. |
| `upload_directory` | Recursive SFTP upload. Caller-supplied `exclude` list. Symlinks not followed by default. |
| `download_file` | SFTP download to local disk. |
| `read_remote_file` | Read remote file as UTF-8 text, up to `maxBytes`. Content is redacted. |
| `write_remote_file` | Write text to a remote file via SFTP. Useful for staging systemd/nginx configs into `/tmp` and then `sudo mv`-ing them in place. |

---

<a id="integrations"></a>

### Integrations

Replace `C:\\path\\to\\ssh-chat-mcp\\build\\index.js` with **your own
absolute path** to `build/index.js` in all snippets below.

#### Claude Code (CLI)

```bash
claude mcp add ssh-chat --scope user -- cmd /c node C:\path\to\ssh-chat-mcp\build\index.js
```

macOS / Linux:

```bash
claude mcp add ssh-chat --scope user -- node /absolute/path/to/ssh-chat-mcp/build/index.js
```

Verify with `/mcp` inside Claude Code.

#### Claude Desktop

Edit:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "node",
      "args": ["C:\\path\\to\\ssh-chat-mcp\\build\\index.js"]
    }
  }
}
```

Fully restart the Claude Desktop app (quit from tray, not just close the window).

#### OpenAI Codex CLI

Edit `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.ssh-chat]
command = 'node'
args = ['C:\\path\\to\\ssh-chat-mcp\\build\\index.js']
startup_timeout_sec = 10
tool_timeout_sec = 120
enabled = true
```

#### Kilo Code

Edit `~/.config/kilo/kilo.jsonc`:

```jsonc
{
  "mcp": {
    "ssh-chat": {
      "type": "local",
      "command": [
        "node",
        "C:\\path\\to\\ssh-chat-mcp\\build\\index.js"
      ],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

#### LM Studio

Edit `%USERPROFILE%\.lmstudio\mcp.json` (Windows) or the equivalent on your OS:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "cmd",
      "args": ["/c", "node", "C:\\path\\to\\ssh-chat-mcp\\build\\index.js"]
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-chat-mcp/build/index.js"]
    }
  }
}
```

#### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "node",
      "args": ["C:\\path\\to\\ssh-chat-mcp\\build\\index.js"]
    }
  }
}
```

#### Continue.dev / Hermes / VS Code MCP extensions

Most MCP-capable extensions follow the same shape:

```json
{
  "name": "ssh-chat",
  "command": "node",
  "args": ["/absolute/path/to/ssh-chat-mcp/build/index.js"],
  "transport": "stdio"
}
```

Consult your client's docs for where this JSON lives.

#### Any stdio-capable MCP client

If your client supports stdio servers at all, point it at:

- **command:** `node`
- **args:** `["/abs/path/to/ssh-chat-mcp/build/index.js"]`
- **env / cwd:** not needed
- **transport:** stdio

There is intentionally nothing else to configure.

---

### Example chat workflow

> Use the `ssh-chat` MCP. Connect to `203.0.113.10:22` as `deploy` with the
> password I just gave you. Upload `D:\Projects\myapp` to `/tmp/myapp`,
> excluding `.git` and `node_modules`. As `appuser`, create a venv and install
> `requirements.txt`. Write a systemd unit to `/tmp/myapp.service` and
> `sudo mv` it to `/etc/systemd/system/`. Reload systemd, enable and start
> `myapp.service`. Write an nginx site to `/tmp/myapp.nginx` and install it to
> `/etc/nginx/sites-available/`, symlink it into `sites-enabled/`, run
> `nginx -t`, reload nginx. Then `disconnect`.

Typical tool sequence:

1. `connect` — credentials enter memory.
2. `upload_directory` — SFTP the project to `/tmp/myapp`.
3. `exec` — `cd /tmp/myapp && ...` for unprivileged setup.
4. `exec_as` — `runAs: "appuser"` for app-user steps (venv, pip).
5. `write_remote_file` — stage `/tmp/myapp.service`.
6. `exec` — `sudo mv /tmp/myapp.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now myapp`.
7. `exec` — `sudo nginx -t && sudo systemctl reload nginx`.
8. `disconnect` — credentials wiped.

---

### Security

See [SECURITY.md](SECURITY.md) for the full threat model. Short version:

- ✅ Credentials never touch disk.
- ✅ Tool output and error messages pass through redaction.
- ✅ `sudo` password is piped via stdin, never on a command line.
- ✅ POSIX shell quoting on every `cwd`/`command` interpolation.
- ✅ Strict Linux-username validation on `runAs`.
- ⚠️ Host-key checking is **off** by design (zero-config means no on-disk known_hosts). The calling user is responsible for trusting the host.
- ⚠️ There is **no destructive-command blacklist**. Your MCP client's tool approval flow is the only checkpoint.
- ⚠️ Passing a password or private key into chat means it's visible in your chat client's transcript and may be logged by your model provider. Prefer local/private clients (LM Studio, Claude Code locally), and rotate credentials after the session if you have any doubt.

---

### Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Project layout:

```
src/
  index.ts                  MCP stdio server + tool registration
  types.ts                  shared types
  ssh/
    connectionManager.ts    in-memory Map<name, descriptor>
    exec.ts                 exec, exec_as (sudo -iu)
    sftp.ts                 upload/download/read/write
  security/
    redact.ts               redact strings, values, errors
    shellQuote.ts           POSIX quoting, Linux-username validation
test/
  redact.test.ts
  shellQuote.test.ts
  errors.test.ts
```

---

<a id="russian"></a>

## Русский

`ssh-chat-mcp` — это [MCP](https://modelcontextprotocol.io)-сервер, который
позволяет LLM-клиенту открывать временные SSH/SFTP-сессии к удалённым хостам,
выполнять команды (включая `sudo -iu`), загружать и скачивать файлы — **без
каких-либо предзаписанных в конфиге кредов, хостов, путей и переменных окружения**.

Сервер запускается без аргументов. Дальше в чате модель получает от тебя host
и креды, вызывает `connect`, делает работу, вызывает `disconnect` — и креды
стираются из памяти.

> Сделано в **[AI Platforms](https://aiplatforms.ru/)** — внедрение приватных LLM и систем компьютерного зрения для предприятий, которым нужно, чтобы ИИ оставался в их собственной серверной.

### Зачем zero-config

Большинство SSH-автоматизаций просит положить на диск `~/.ssh/config`,
`inventory.yml`, переменные `HOST=…`, `SSH_PRIVATE_KEY=…`. Это нормально для
одной стабильной прод-машины и CI-раннера. Это неправильно, когда:

- Ты хочешь, чтобы LLM-клиент *иногда* зашёл по SSH на машину, которую ты
  поднял вчера, что-то задеплоил и забыл.
- Ты не хочешь, чтобы hostname / username / ключ были видны всему, что читает
  твой MCP-конфиг — расширениям IDE, интеграциям, другим MCP-серверам.
- Ты не хочешь, чтобы LLM-клиент вообще что-либо помнил про твою
  инфраструктуру после окончания чата.

`ssh-chat-mcp` держит MCP-слой чистым и пушит все детали подключения в
переписку, где они видны тебе явно и умирают вместе с соединением.

### Установка

```bash
git clone https://github.com/aiplatforms-ru/ssh-chat-mcp.git
cd ssh-chat-mcp
npm install
npm run build
```

На выходе — `build/index.js`, ESM-скрипт с shebang `#!/usr/bin/env node`.
Требуется **Node.js 20+** (рекомендуется 22).

Проверь, что сервер запускается молча — он не должен ничего писать в stdout
(stdout зарезервирован под MCP JSON-RPC):

```bash
node build/index.js
```

`Ctrl+C` для остановки. Вывода быть не должно.

### Быстрый старт

В твоём MCP-клиенте (Claude Code / Codex / Kilo / LM Studio / Cursor / …)
зарегистрируй сервер (см. [Интеграции](#интеграции-ru)) и скажи в чате:

> Используй MCP `ssh-chat`. Вызови `connect` с connectionName=`t1`,
> host=`203.0.113.10`, username=`deploy`, password=`<твой пароль>`. Потом
> запусти `exec` с command=`whoami && hostname`. Потом `disconnect`.

Весь цикл: connect → работа → disconnect.

---

### Инструменты

Все входы валидируются через [zod](https://github.com/colinhacks/zod). Все
выходы и ошибки проходят через redaction-слой, который убирает:

- Значения полей с именами `password`, `passphrase`, `privateKey`,
  `sudoPassword`, `token`, `apiKey`, `Authorization`, `secret`.
- Паттерны `password=`, `*_PASSWORD=`, `token=`, `secret=`,
  `Authorization: Bearer …` в тексте.
- PEM-блоки приватных ключей.

| Инструмент | Что делает |
|-----------|-----------|
| `connect` | Открывает SSH. Обязательно: `connectionName`, `host`, `username` + `password` или `privateKey` (PEM). Опционально: `port` (по умолчанию 22), `passphrase`, `readyTimeoutMs`, `keepaliveIntervalMs`. Креды только в RAM. |
| `disconnect` | Закрывает SSH+SFTP, стирает креды из памяти. |
| `list_connections` | Возвращает нечувствительные метаданные активных соединений. |
| `exec` | Выполняет shell-команду. Если задан `cwd`, оборачивает в `cd <quoted cwd> && <command>`. Возвращает `stdout, stderr, exitCode, signal, timedOut`. |
| `exec_as` | Запуск как другой Linux-пользователь через `sudo -S -p '' -iu <runAs> -- bash -lc <command>`. `runAs` строго валидируется (`^[a-z_][a-z0-9_-]{0,31}$`). `sudoPassword` идёт через stdin и никогда не логируется. |
| `upload_file` | SFTP-загрузка одного файла. Опционально `mode`, `mkdirParents`. |
| `upload_directory` | Рекурсивная SFTP-загрузка. `exclude` задаёт вызывающий. Симлинки по умолчанию не следуются. |
| `download_file` | SFTP-скачивание на локальный диск. |
| `read_remote_file` | Чтение удалённого файла как UTF-8, до `maxBytes`. Контент редактируется. |
| `write_remote_file` | Запись текста на удалённый файл через SFTP. Полезно для staging systemd/nginx-конфигов в `/tmp` с последующим `sudo mv`. |

---

<a id="интеграции-ru"></a>

### Интеграции

Замени `C:\\path\\to\\ssh-chat-mcp\\build\\index.js` на **свой
абсолютный путь** к `build/index.js` во всех сниппетах ниже.

#### Claude Code (CLI)

```bash
claude mcp add ssh-chat --scope user -- cmd /c node C:\path\to\ssh-chat-mcp\build\index.js
```

macOS / Linux:

```bash
claude mcp add ssh-chat --scope user -- node /absolute/path/to/ssh-chat-mcp/build/index.js
```

Проверка: `/mcp` внутри Claude Code.

#### Claude Desktop

Файл:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "node",
      "args": ["C:\\path\\to\\ssh-chat-mcp\\build\\index.js"]
    }
  }
}
```

Полностью перезапусти Claude Desktop (Quit из трея, не просто закрытие окна).

#### OpenAI Codex CLI

Файл `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.ssh-chat]
command = 'node'
args = ['C:\\path\\to\\ssh-chat-mcp\\build\\index.js']
startup_timeout_sec = 10
tool_timeout_sec = 120
enabled = true
```

#### Kilo Code

Файл `~/.config/kilo/kilo.jsonc`:

```jsonc
{
  "mcp": {
    "ssh-chat": {
      "type": "local",
      "command": [
        "node",
        "C:\\path\\to\\ssh-chat-mcp\\build\\index.js"
      ],
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

#### LM Studio

Файл `%USERPROFILE%\.lmstudio\mcp.json` (Windows) или аналог на твоей ОС:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "cmd",
      "args": ["/c", "node", "C:\\path\\to\\ssh-chat-mcp\\build\\index.js"]
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "node",
      "args": ["/absolute/path/to/ssh-chat-mcp/build/index.js"]
    }
  }
}
```

#### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "node",
      "args": ["C:\\path\\to\\ssh-chat-mcp\\build\\index.js"]
    }
  }
}
```

#### Continue.dev / Hermes / VS Code MCP-расширения

Большинство MCP-совместимых расширений принимает форму:

```json
{
  "name": "ssh-chat",
  "command": "node",
  "args": ["/absolute/path/to/ssh-chat-mcp/build/index.js"],
  "transport": "stdio"
}
```

Конкретное место хранения JSON смотри в документации клиента.

#### Любой stdio-совместимый MCP-клиент

Если клиент вообще поддерживает stdio-серверы, укажи:

- **command:** `node`
- **args:** `["/abs/path/to/ssh-chat-mcp/build/index.js"]`
- **env / cwd:** не нужно
- **transport:** stdio

Больше настраивать сознательно нечего.

---

### Пример сценария в чате

> Используй MCP `ssh-chat`. Подключись к `203.0.113.10:22` как `deploy` с
> паролем, который я только что дал. Залей `D:\Projects\myapp` в `/tmp/myapp`,
> исключая `.git` и `node_modules`. Как `appuser` создай venv и поставь
> `requirements.txt`. Запиши systemd-юнит в `/tmp/myapp.service` и через
> `sudo mv` перенеси в `/etc/systemd/system/`. Перечитай systemd, включи и
> запусти `myapp.service`. Запиши nginx-сайт в `/tmp/myapp.nginx`, перенеси в
> `/etc/nginx/sites-available/`, symlink в `sites-enabled/`, проверь
> `nginx -t`, перезагрузи nginx. Потом `disconnect`.

Типичная последовательность инструментов:

1. `connect` — креды попадают в память.
2. `upload_directory` — заливаем проект в `/tmp/myapp`.
3. `exec` — `cd /tmp/myapp && ...` для непривилегированных шагов.
4. `exec_as` — `runAs: "appuser"` для шагов от имени приложения.
5. `write_remote_file` — staging `/tmp/myapp.service`.
6. `exec` — `sudo mv /tmp/myapp.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now myapp`.
7. `exec` — `sudo nginx -t && sudo systemctl reload nginx`.
8. `disconnect` — креды стёрты.

---

### Безопасность

Полная модель угроз — в [SECURITY.md](SECURITY.md). Кратко:

- ✅ Креды не пишутся на диск.
- ✅ Вывод и ошибки проходят redaction.
- ✅ Пароль sudo идёт через stdin, никогда не в командной строке.
- ✅ POSIX shell quoting на каждом `cwd`/`command`.
- ✅ Строгая валидация `runAs` как Linux-юзера.
- ⚠️ Проверка host-key выключена по дизайну (zero-config означает отсутствие on-disk known_hosts). Доверие к хосту — на стороне пользователя.
- ⚠️ Чёрного списка деструктивных команд **нет**. Единственная точка контроля — апрув инструментов в твоём MCP-клиенте.
- ⚠️ Передача пароля или ключа в чат означает, что они видны в транскрипте клиента и могут логироваться провайдером модели. Используй локальные/приватные клиенты (LM Studio, Claude Code локально). При сомнениях — ротация кредов после сессии.

---

### Разработка

```bash
npm install
npm run typecheck
npm test
npm run build
```

Структура проекта:

```
src/
  index.ts                  MCP stdio-сервер + регистрация инструментов
  types.ts                  общие типы
  ssh/
    connectionManager.ts    Map<name, descriptor> в памяти
    exec.ts                 exec, exec_as (sudo -iu)
    sftp.ts                 upload/download/read/write
  security/
    redact.ts               redaction строк/значений/ошибок
    shellQuote.ts           POSIX-квотинг, валидация Linux-юзера
test/
  redact.test.ts
  shellQuote.test.ts
  errors.test.ts
```

---

## About AI Platforms / О компании AI Platforms

**[AI Platforms](https://aiplatforms.ru/)** — Russian systems integrator specialising in
on-premises AI: private LLM/RAG stacks (DeepSeek, Qwen, Kimi, GLM), computer-vision
for quality control and safety, AI chatbots and autonomous agents, 3D digital avatars,
and GPU infrastructure. We deploy AI systems that stay inside our clients' server rooms —
not in someone else's cloud.

**AI Platforms** — российский системный интегратор приватного ИИ: связки LLM/RAG
(DeepSeek, Qwen, Kimi, GLM) на собственном железе клиента, компьютерное зрение для
контроля качества и безопасности, ИИ-чат-боты и автономные агенты, 3D digital-аватары,
GPU-инфраструктура. ИИ-системы остаются в серверной клиента, а не в чужом облаке.

- 🌐 Web: <https://aiplatforms.ru/>
- ✉️ E-mail: akvis-s@mail.ru
- ☎️ Tel: +7 (812) 987-70-07
- 📍 196006, St. Petersburg, Mitrofan'evskoe Shosse 29A, office 213

---

## License

[MIT](LICENSE) © AI Platforms / ООО «Аквис-Сервис».
