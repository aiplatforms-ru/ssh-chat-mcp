<!-- markdownlint-disable MD033 MD041 -->

<h1 align="center">ssh-chat-mcp</h1>

<p align="center">
  <b>Zero-config SSH/SFTP MCP server.</b><br>
  All connection data is passed from chat — never from config files, env variables, or disk.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ssh-chat-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/ssh-chat-mcp?color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/ssh-chat-mcp"><img alt="npm downloads" src="https://img.shields.io/npm/dm/ssh-chat-mcp?color=cb3837&logo=npm"></a>
  <a href="https://github.com/aiplatforms-ru/ssh-chat-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/aiplatforms-ru/ssh-chat-mcp/actions/workflows/ci.yml/badge.svg"></a>
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

Requires **Node.js 20 or newer** (22 recommended).

**Option A — npx (recommended, zero install).** Point your MCP client at
`npx -y ssh-chat-mcp`. The first run downloads the package; later runs are
instant from cache. Nothing to clone or build. See [Integrations](#integrations).

```bash
# verify it runs (starts silently; Ctrl+C to stop)
npx -y ssh-chat-mcp
```

**Option B — global install.**

```bash
npm install -g ssh-chat-mcp
ssh-chat-mcp        # starts the stdio server
```

**Option C — from source (for development).**

```bash
git clone https://github.com/aiplatforms-ru/ssh-chat-mcp.git
cd ssh-chat-mcp
npm install
npm run build
node build/index.js
```

In all cases the server starts silently and must not print anything to stdout
(stdout is reserved for MCP JSON-RPC traffic). Press `Ctrl+C` twice quickly to
stop. A single `Ctrl+C` only cancels in-flight commands/jobs so MCP clients can
interrupt a tool call without killing the whole stdio transport. No output is
expected during normal operation.

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
| `diagnose` | Local MCP/SSH diagnostics. With no args it proves the MCP server is alive and lists connections/jobs. With `connectionName`, it runs a short SSH probe and returns `ok`, `ssh_unresponsive`, `ssh_error`, `connection_missing`, etc. |
| `exec` | Run a shell command. With `cwd`, wraps as `cd <quoted cwd> && <command>`. Returns `stdout, stderr, exitCode, signal, timedOut`. |
| `exec_start` | Start a long-running command and return immediately with `jobId`. Use for `git clone`, `pip install`, `apt install`, builds, and reboot waits that may outlive the MCP client's tool timeout. |
| `exec_as` | Run as another Linux user via `sudo -S -p '' -iu <runAs> -- bash -lc <command>`. `runAs` is strictly validated (`^[a-z_][a-z0-9_-]{0,31}$`). `sudoPassword` is piped via stdin and never logged. |
| `exec_as_start` | Long-running version of `exec_as`; returns `jobId` immediately and stores rolling stdout/stderr buffers in memory. |
| `exec_status` | Read a command job status plus stdout/stderr slices. Pass returned `nextOffset` values back as `stdoutOffset`/`stderrOffset` for incremental log reads. |
| `exec_jobs` | List known command jobs without logs. |
| `exec_cancel` | Best-effort cancellation for a job. If the remote PID is known, sends the signal to the remote process group and closes the SSH channel. |
| `exec_remove` | Remove a completed/cancelled/failed job and drop its buffered logs. |
| `upload_file` | SFTP upload one file. Optional `mode`, `mkdirParents`. |
| `upload_directory` | Recursive SFTP upload. Caller-supplied `exclude` list. Symlinks not followed by default. |
| `download_file` | SFTP download to local disk. |
| `read_remote_file` | Read remote file as UTF-8 text, up to `maxBytes`. Content is redacted. |
| `write_remote_file` | Write text to a remote file via SFTP. Useful for staging systemd/nginx configs into `/tmp` and then `sudo mv`-ing them in place. |

---

### Long-running commands

For commands that can exceed your MCP client's tool timeout, prefer:

1. `exec_start` or `exec_as_start` with the long command.
2. `exec_status` every so often, using `stdout.nextOffset` and
   `stderr.nextOffset` from the previous response.
3. `exec_cancel` if the job must be stopped.
4. `exec_remove` after completion if you want to drop the in-memory log buffers.

This keeps the MCP transport responsive: the first call only opens the SSH
channel and returns a `jobId`; stdout/stderr are held in rolling in-memory
buffers and read later by job id. If a job times out or is cancelled, the server
tries to signal the remote process group before closing the SSH channel.

---

<a id="integrations"></a>

### Integrations

All snippets below use the **npx** form (`npx -y ssh-chat-mcp`) — no install,
no paths. If you installed from source instead, replace
`{ "command": "npx", "args": ["-y", "ssh-chat-mcp"] }` with
`{ "command": "node", "args": ["/abs/path/to/ssh-chat-mcp/build/index.js"] }`.
On Windows, npx-based clients sometimes need the launcher wrapped as
`"command": "cmd", "args": ["/c", "npx", "-y", "ssh-chat-mcp"]`.

#### Claude Code (CLI)

```bash
claude mcp add ssh-chat --scope user -- npx -y ssh-chat-mcp
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
      "command": "npx",
      "args": ["-y", "ssh-chat-mcp"]
    }
  }
}
```

Fully restart the Claude Desktop app (quit from tray, not just close the window).

#### OpenAI Codex CLI

Edit `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.ssh-chat]
command = 'npx'
args = ['-y', 'ssh-chat-mcp']
startup_timeout_sec = 30
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
      "command": ["npx", "-y", "ssh-chat-mcp"],
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
      "args": ["/c", "npx", "-y", "ssh-chat-mcp"]
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "npx",
      "args": ["-y", "ssh-chat-mcp"]
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
      "command": "npx",
      "args": ["-y", "ssh-chat-mcp"]
    }
  }
}
```

#### Continue.dev / Hermes / VS Code MCP extensions

Most MCP-capable extensions follow the same shape:

```json
{
  "name": "ssh-chat",
  "command": "npx",
  "args": ["-y", "ssh-chat-mcp"],
  "transport": "stdio"
}
```

Consult your client's docs for where this JSON lives.

#### Any stdio-capable MCP client

If your client supports stdio servers at all, point it at:

- **command:** `npx`
- **args:** `["-y", "ssh-chat-mcp"]`
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

Требуется **Node.js 20+** (рекомендуется 22).

**Вариант A — npx (рекомендуется, без установки).** Укажи MCP-клиенту
`npx -y ssh-chat-mcp`. Первый запуск скачает пакет, дальше — мгновенно из кэша.
Ничего клонировать и собирать не нужно. См. [Интеграции](#интеграции-ru).

```bash
# проверка запуска (стартует молча; Ctrl+C для остановки)
npx -y ssh-chat-mcp
```

**Вариант B — глобальная установка.**

```bash
npm install -g ssh-chat-mcp
ssh-chat-mcp        # запускает stdio-сервер
```

**Вариант C — из исходников (для разработки).**

```bash
git clone https://github.com/aiplatforms-ru/ssh-chat-mcp.git
cd ssh-chat-mcp
npm install
npm run build
node build/index.js
```

Во всех случаях сервер запускается молча и не должен ничего писать в stdout
(stdout зарезервирован под MCP JSON-RPC). Для остановки нажми `Ctrl+C` два раза
быстро. Один `Ctrl+C` только отменяет активные команды/jobs, чтобы MCP-клиенты
могли прервать tool call без убийства всего stdio-транспорта. В штатной работе
вывода быть не должно.

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
| `diagnose` | Локальная диагностика MCP/SSH. Без аргументов доказывает, что MCP-сервер жив, и показывает соединения/jobs. С `connectionName` делает короткий SSH probe и возвращает `ok`, `ssh_unresponsive`, `ssh_error`, `connection_missing` и т.п. |
| `exec` | Выполняет shell-команду. Если задан `cwd`, оборачивает в `cd <quoted cwd> && <command>`. Возвращает `stdout, stderr, exitCode, signal, timedOut`. |
| `exec_start` | Запускает долгую команду и сразу возвращает `jobId`. Для `git clone`, `pip install`, `apt install`, сборок, ожидания reboot и всего, что может пережить timeout MCP-клиента. |
| `exec_as` | Запуск как другой Linux-пользователь через `sudo -S -p '' -iu <runAs> -- bash -lc <command>`. `runAs` строго валидируется (`^[a-z_][a-z0-9_-]{0,31}$`). `sudoPassword` идёт через stdin и никогда не логируется. |
| `exec_as_start` | Долгая версия `exec_as`: сразу возвращает `jobId` и хранит rolling stdout/stderr buffers в памяти. |
| `exec_status` | Читает статус job и срезы stdout/stderr. Передавай возвращённые `nextOffset` как `stdoutOffset`/`stderrOffset` для инкрементального чтения логов. |
| `exec_jobs` | Показывает известные jobs без логов. |
| `exec_cancel` | Best-effort отмена job. Если известен remote PID, сигнал отправляется remote process group, затем закрывается SSH channel. |
| `exec_remove` | Удаляет завершённую/отменённую/упавшую job и очищает буферы логов. |
| `upload_file` | SFTP-загрузка одного файла. Опционально `mode`, `mkdirParents`. |
| `upload_directory` | Рекурсивная SFTP-загрузка. `exclude` задаёт вызывающий. Симлинки по умолчанию не следуются. |
| `download_file` | SFTP-скачивание на локальный диск. |
| `read_remote_file` | Чтение удалённого файла как UTF-8, до `maxBytes`. Контент редактируется. |
| `write_remote_file` | Запись текста на удалённый файл через SFTP. Полезно для staging systemd/nginx-конфигов в `/tmp` с последующим `sudo mv`. |

---

### Долгие команды

Для команд, которые могут выйти за timeout MCP-клиента, используй:

1. `exec_start` или `exec_as_start` с долгой командой.
2. `exec_status` время от времени, передавая `stdout.nextOffset` и
   `stderr.nextOffset` из прошлого ответа.
3. `exec_cancel`, если job нужно остановить.
4. `exec_remove` после завершения, если нужно очистить in-memory буферы логов.

Так MCP transport остаётся отзывчивым: первый вызов только открывает SSH channel
и возвращает `jobId`; stdout/stderr хранятся в rolling in-memory буферах и
читаются потом по job id. Если job получает timeout или отмену, сервер пытается
послать сигнал remote process group до закрытия SSH channel.

---

<a id="интеграции-ru"></a>

### Интеграции

Все сниппеты ниже используют форму **npx** (`npx -y ssh-chat-mcp`) — без
установки и путей. Если ставил из исходников, замени
`{ "command": "npx", "args": ["-y", "ssh-chat-mcp"] }` на
`{ "command": "node", "args": ["/abs/path/to/ssh-chat-mcp/build/index.js"] }`.
На Windows некоторым клиентам npx нужно обернуть как
`"command": "cmd", "args": ["/c", "npx", "-y", "ssh-chat-mcp"]`.

#### Claude Code (CLI)

```bash
claude mcp add ssh-chat --scope user -- npx -y ssh-chat-mcp
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
      "command": "npx",
      "args": ["-y", "ssh-chat-mcp"]
    }
  }
}
```

Полностью перезапусти Claude Desktop (Quit из трея, не просто закрытие окна).

#### OpenAI Codex CLI

Файл `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.ssh-chat]
command = 'npx'
args = ['-y', 'ssh-chat-mcp']
startup_timeout_sec = 30
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
      "command": ["npx", "-y", "ssh-chat-mcp"],
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
      "args": ["/c", "npx", "-y", "ssh-chat-mcp"]
    }
  }
}
```

macOS / Linux:

```json
{
  "mcpServers": {
    "ssh-chat": {
      "command": "npx",
      "args": ["-y", "ssh-chat-mcp"]
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
      "command": "npx",
      "args": ["-y", "ssh-chat-mcp"]
    }
  }
}
```

#### Continue.dev / Hermes / VS Code MCP-расширения

Большинство MCP-совместимых расширений принимает форму:

```json
{
  "name": "ssh-chat",
  "command": "npx",
  "args": ["-y", "ssh-chat-mcp"],
  "transport": "stdio"
}
```

Конкретное место хранения JSON смотри в документации клиента.

#### Любой stdio-совместимый MCP-клиент

Если клиент вообще поддерживает stdio-серверы, укажи:

- **command:** `npx`
- **args:** `["-y", "ssh-chat-mcp"]`
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
