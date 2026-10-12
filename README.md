# dsvm

Version manager and background-service runner for [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh).

- Install and switch dsh versions or dist-tags (`latest`, `next`, `alpha`, ...).
- Run the web UI in the foreground with `dsvm web`, which hands the process over
  to the active version of `dsh web`.
- Manage plugins with `dsvm plugin`, which hands the process over to the
  active version of `dsh plugin`.
- Install the web UI as a login service (systemd user unit on Linux, launchd
  LaunchAgent on macOS, Task Scheduler task on Windows) that always starts
  through `dsvm`, so switching versions never requires editing the unit.
- Open the running instance's authenticated URL with `dsvm` / `dsvm open`.
- Run the web UI in a bundled NW.js desktop app with `dsvm desktop`.

## Requirements

- Node.js >= 20 and npm (used to install dsh versions).
- Linux with a systemd user session, macOS with launchd, or Windows with
  PowerShell and Task Scheduler for `dsvm service`.

## Install dsvm

```sh
npm install -g /path/to/dsvm
# or, inside the checkout:
npm install && npm link
```

Everything dsvm manages lives in `~/.dsvm` (override with `DSVM_HOME`):

```
~/.dsvm/
├── config.json                      # active version + dist-tag memory
├── cache/packument.json             # npm metadata cache (offline fallback)
├── versions/<version>/              # one npm install of @deepseek-ai/dsh each
└── service/
    ├── service.json                 # installed service definition metadata
    └── url.json                     # URL of the running service instance
```

## Quick start

```sh
dsvm install            # install the latest dist-tag and use it
dsvm service install    # register the service definition (default port 7766)
dsvm service enable     # start now and at login
dsvm open               # open the running instance in the browser
```

## Commands

### Versions

| Command | Description |
| --- | --- |
| `dsvm install [version\|tag]` | Install a version or dist-tag. Defaults to `latest`. Also installs the newest release behind a tag, updates the tag memory, and switches to it when that tag is the active selection. |
| `dsvm use <version\|tag>` | Make a version or tag active. Installs it first when necessary. A tag stays a moving pointer; a version is pinned. |
| `dsvm update [tag]` | Re-resolve a dist-tag from the registry and install its newest release. Without an argument the tag currently in use is updated; if the active version is pinned, dsvm asks you to pass a tag or switch to one first. |
| `dsvm list [--json]` | List installed versions with the dist-tags pointing at them, install time, and the active one. `--json` also returns per-version `installedAt` and `tags`. |
| `dsvm uninstall <version\|tag>` | Remove an installed version. The active version cannot be removed. |
| `dsvm current [--json]` | Print the active selection (`1.2.3 (alpha)` or `1.2.3 (pinned)`). |

Dist-tag resolution uses the npm registry and falls back to the last known
mapping in `config.json` when the registry is unreachable. `dsvm update` always
requires the registry so it can never silently report a stale "up to date".

Dist-tags are independent pointers. When `latest` and `next` currently resolve
to the same version, `dsvm install next` only records the `next` mapping (the
version is already on disk) and `dsvm update next` moves only the `next`
pointer: the version `latest` points at, and whatever is currently active, are
left untouched.

```console
$ dsvm list

installed in /home/me/.dsvm/versions

  0.1.7-rc.1
  0.2.0-rc.2     latest  installed 2026-10-12 05:30:00
* 0.2.1-alpha.2  alpha   installed 2026-10-12 05:35:00

current: 0.2.1-alpha.2 (alpha)
```

### Running the web UI

```sh
dsvm web [dsh web args...]
```

Runs `dsh web` with the active version, exactly like calling `dsh web` yourself.
Outside service mode dsvm replaces itself with the dsh process (`execve`), so
all terminal and signal behaviour belongs to `dsh`; arguments such as
`--port 8080`, `--host`, or `--no-open` are passed through unchanged.

When the process is started by the installed service (`DSVM_SERVICE=1`),
`dsvm web` additionally watches stdout for the `dsh web: <url>` line and records
it in `~/.dsvm/service/url.json`. The URL contains a per-process launch token,
so it changes on every start; that file is how `dsvm service url` finds the
current one. The file is removed when the instance exits.

### Managing plugins

```sh
dsvm plugin [dsh plugin args...]
```

Runs `dsh plugin` with the active version. dsvm replaces itself with the dsh
process (`execve`), so all terminal and signal behaviour belongs to `dsh`.
When no `--profile` is given, `--profile web` is assumed:

```sh
dsvm plugin add <package>                 # install a plugin into the web profile
                                          # (same as: dsh plugin --profile web add <package>)
dsvm plugin --profile tui add <package>   # install a plugin into the tui profile
dsvm plugin --help                        # the `dsh plugin` help of the active version
```

### Service

```
dsvm service install [--port <port>] [--host <host>] [--dir <dir>] [--force]
dsvm service enable | disable | start | stop | restart | status [--json] | url | uninstall
```

- `install` registers the service definition but does not start it. The default
  port is `7766`; `--dir` sets the working directory (and therefore dsh's
  default workspace root, default `$HOME`).
- `enable` starts the service now and at login; `disable` stops it and disables
  start at login. `start`/`stop`/`restart` only control the current run.
- `url` prints only the URL of the running instance, so it can be used in
  scripts: `xdg-open "$(dsvm service url)"`.
- `uninstall` stops the service, removes the definition, and forgets the
  installed metadata.

What "the service" means per platform:

| dsvm service | Linux | macOS | Windows |
| --- | --- | --- | --- |
| definition | `~/.config/systemd/user/dsvm.service` | `~/Library/LaunchAgents/com.dsvm.service.plist` | Scheduled task `dsvm` + `~/.dsvm/service/dsvm-run.cmd` |
| enable | `systemctl --user enable --now` | `launchctl bootstrap` | `Enable-ScheduledTask` + `Start-ScheduledTask` |
| disable | `systemctl --user disable --now` | `launchctl bootout` + `disable` | `Stop-ScheduledTask` + `Disable-ScheduledTask` |
| restart | `systemctl --user restart` | `launchctl kickstart -k` | stop + `Start-ScheduledTask` |
| logs | `journalctl --user -u dsvm.service` | `~/.dsvm/service/logs/service.err.log` | task history / status |

`dsvm use` and `dsvm update` print a reminder when
the service is running.

`install` records the absolute paths of the dsvm launcher, node, the dsvm home,
and the PATH from the installing shell. Moving or reinstalling dsvm in another
location means running `dsvm service install --force` again.

### Desktop (NW.js)

```
dsvm desktop             # cache the nw.js SDK if needed and launch the app
dsvm desktop install     # cache the SDK and create a user shortcut
dsvm desktop uninstall   # remove the shortcut and delete the SDK cache
dsvm desktop update      # install the newest SDK when one is available
```

`dsvm desktop` embeds the URL reported by `dsvm service url` in a bundled
NW.js app (shown as "DeepSeek Harness (dsvm)", always the SDK variant,
cached under `~/.dsvm/desktop/nwjs/`),
so the service must be installed and running first. The app shows a
connecting screen, loads the dsh UI in an embedded `<webview>` (never a top-level
navigation, so connection state and retries survive), and retries
automatically while its window is visible — retrying once immediately when
the window becomes visible, never while hidden. A persistent tray icon
stays enabled with toggles for minimize-to-tray, lightweight background
mode (unloads the page back to the connecting screen after 5 s hidden),
and minimize-on-close, plus quit. On Linux the app defaults to Wayland
(`--ozone-platform-hint=auto`) with Wayland IME support
(`--enable-wayland-ime --wayland-text-input-version=3`). Window and tray
icons reuse the official dsh whale mark (`desktop/icon.svg/png`).
Shortcuts launch the cached nw.js binary directly, never through dsvm, via a
stable path (`~/.dsvm/desktop/nwjs/current/`) that survives updates:
Linux writes `~/.local/share/applications/dsvm-desktop.desktop`, Windows
creates Start Menu + Desktop links, macOS drops a minimal `.app` bundle in
`~/Applications` (default dock icon; custom icns is best-effort).

### Opening

```sh
dsvm                  # same as dsvm open: open in the browser
dsvm open             # open in the browser, without printing the URL
dsvm open --print     # print the URL and open it
dsvm service url      # print the URL only, for scripts
```

`dsvm open` resolves the URL through `dsvm service url` and launches the
platform opener (`xdg-open`/`gio`/`$BROWSER` on Linux, `open` on macOS,
`rundll32 url.dll,FileProtocolHandler` on Windows). Use `--print` when you also
want the URL on stdout; use `dsvm service url` when you only need the URL. If
the service is not running, dsvm tells you how to start it.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DSVM_HOME` | State directory. Default: `~/.dsvm`. |
| `DSVM_REGISTRY` | npm registry for metadata and installs. Also honours `npm_config_registry`. |
| `DSVM_SERVICE` | Internal marker set by the service definition; makes `dsvm web` record its URL. |
| `NO_COLOR` | Disable ANSI colours. |

## Development

```sh
npm install       # installs TypeScript and builds
npm run build     # tsc -> build/
npm test          # build + node:test (unit and integration with fakes)
```

The source is TypeScript under `src/`; `bin/dsvm.js` is a stable launcher shim
that loads `build/src/cli.js`. Integration tests fake `dsh`, `systemctl`, and
`xdg-open`, so no real service or browser is touched.
