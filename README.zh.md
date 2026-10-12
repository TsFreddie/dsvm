# dsvm

[`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 的版本管理与后台服务工具。

- 安装、切换 dsh 版本或 dist-tag（`latest`、`next`、`alpha` 等）。
- `dsvm web` 以前台方式运行 Web UI，并把进程直接交给当前版本的 `dsh web`。
- `dsvm plugin` 管理插件，并把进程直接交给当前版本的 `dsh plugin`。
- 把 Web UI 安装为开机/登录服务（Linux 用 systemd user unit，macOS 用 launchd
  LaunchAgent，Windows 用任务计划程序），服务最终通过 `dsvm` 启动，因此切换版本
  后不需要重新编辑 unit。
- `dsvm` / `dsvm open` 直接打开正在运行实例的带 token URL。
- `dsvm desktop` 在自带 NW.js 桌面应用里打开 Web UI。

## 依赖

- Node.js >= 20 与 npm（用于安装 dsh 版本）。
- `dsvm service` 需要 Linux 的 systemd user session、macOS 的 launchd，或 Windows
  的 PowerShell + 任务计划程序。

## 安装 dsvm

```sh
npm install -g /path/to/dsvm
# 或者在仓库目录里：
npm install && npm link
```

dsvm 的状态都放在 `~/.dsvm`（可用 `DSVM_HOME` 覆盖）：

```
~/.dsvm/
├── config.json                      # 当前版本 + dist-tag 记录
├── cache/packument.json             # npm 元数据缓存（离线兜底）
├── versions/<version>/              # 每个版本一份独立的 @deepseek-ai/dsh 安装
└── service/
    ├── service.json                 # 已安装的服务定义元数据
    └── url.json                     # 正在运行实例的 URL
```

## 快速开始

```sh
dsvm install            # 安装 latest 并切换过去
dsvm service install    # 注册服务定义（默认端口 7766）
dsvm service enable     # 立即启动，并设置登录自启
dsvm open               # 用浏览器打开正在运行的实例
```

## 命令

### 版本管理

| 命令 | 说明 |
| --- | --- |
| `dsvm install [version\|tag]` | 安装版本或 dist-tag，默认 `latest`。如果传入 tag，还会更新 tag 记录；当当前使用的是该 tag 时会自动切换。 |
| `dsvm use <version\|tag>` | 切换当前版本。未安装时自动安装。使用 tag 表示跟随移动指针，使用具体版本则是 pinned。 |
| `dsvm update [tag]` | 从 registry 重新解析 tag 并安装最新版本。不带参数时更新当前正在使用的 tag；如果当前是 pinned version，会提示指定 tag 或先切换到 tag。 |
| `dsvm list [--json]` | 列出已安装版本、指向它们的 dist-tag、安装时间，以及当前版本。`--json` 额外返回每个版本的 `installedAt` 与 `tags`。 |
| `dsvm uninstall <version\|tag>` | 卸载某个版本；当前正在使用的版本不能卸载。 |
| `dsvm current [--json]` | 显示当前选择（`1.2.3 (alpha)` 或 `1.2.3 (pinned)`）。 |

tag 解析优先访问 npm registry，不可达时退回 `config.json` 里最后一次的记录；
`dsvm update` 始终要求访问 registry，避免把过期缓存当成 "已是最新"。

dist-tag 之间是彼此独立的指针。如果 `latest` 与 `next` 当前指向同一个版本，
`dsvm install next` 只会记录 `next` 的映射（版本已在磁盘上），`dsvm update next`
也只移动 `next` 指针——`latest` 指向的版本和当前激活的选择都不受影响。

```console
$ dsvm list

installed in /home/me/.dsvm/versions

  0.1.7-rc.1
  0.2.0-rc.2     latest  installed 2026-10-12 05:30:00
* 0.2.1-alpha.2  alpha   installed 2026-10-12 05:35:00

current: 0.2.1-alpha.2 (alpha)
```

### 运行 Web UI

```sh
dsvm web [dsh web 参数...]
```

用当前版本运行 `dsh web`，行为等同于直接执行 `dsh web`。非服务模式下 dsvm 会用
`execve` 把进程替换为 dsh，终端与信号处理完全交给 dsh；`--port 8080`、`--host`、
`--no-open` 等参数原样透传。

当进程由已安装的服务启动时（`DSVM_SERVICE=1`），`dsvm web` 会额外监听 stdout 里
的 `dsh web: <url>` 一行并写入 `~/.dsvm/service/url.json`。URL 里带有 per-process
的启动 token，每次启动都不同，`dsvm service url` 正是从这里取到当前 URL 的；实例
退出时该文件会被清理。

### 管理插件

```sh
dsvm plugin [dsh plugin 参数...]
```

用当前版本运行 `dsh plugin`。dsvm 会用 `execve` 把进程替换为 dsh，终端与信号
处理完全交给 dsh；未指定 `--profile` 时默认 `--profile web`：

```sh
dsvm plugin add <package>                 # 给 web profile 安装一个插件
                                          # （等同于 dsh plugin --profile web add <package>）
dsvm plugin --profile tui add <package>   # 给 tui profile 安装一个插件
dsvm plugin --help                        # 查看当前版本 `dsh plugin` 的帮助
```

### 服务管理

```
dsvm service install [--port <port>] [--host <host>] [--dir <dir>] [--force]
dsvm service enable | disable | start | stop | restart | status [--json] | url | uninstall
```

- `install` 只注册服务定义，不启动。默认端口 `7766`；`--dir` 指定工作目录（也就是
  dsh 默认的 workspace root，默认是 `$HOME`）。
- `enable` 立即启动并设置登录自启；`disable` 停止并取消自启。`start` / `stop` /
  `restart` 只控制当前这一次运行。
- `url` 只输出正在运行实例的 URL，方便脚本使用：`xdg-open "$(dsvm service url)"`。
- `uninstall` 停止服务、删除定义和安装元数据。

各平台的对应关系：

| dsvm service | Linux | macOS | Windows |
| --- | --- | --- | --- |
| 定义 | `~/.config/systemd/user/dsvm.service` | `~/Library/LaunchAgents/com.dsvm.service.plist` | 计划任务 `dsvm` + `~/.dsvm/service/dsvm-run.cmd` |
| enable | `systemctl --user enable --now` | `launchctl bootstrap` | `Enable-ScheduledTask` + `Start-ScheduledTask` |
| disable | `systemctl --user disable --now` | `launchctl bootout` + `disable` | `Stop-ScheduledTask` + `Disable-ScheduledTask` |
| restart | `systemctl --user restart` | `launchctl kickstart -k` | stop + `Start-ScheduledTask` |
| 日志 | `journalctl --user -u dsvm.service` | `~/.dsvm/service/logs/service.err.log` | 任务历史 / status |

三种定义最终都执行同一条命令：

```
<node> <dsvm 安装目录>/bin/dsvm.js web --port 7766 --no-open
```

并注入 `DSVM_SERVICE=1` 与安装时的 `DSVM_HOME`。因此切换 dsh 版本只需要
`dsvm service restart`，unit 本身永远不写死 dsh 版本。服务正在运行时执行
`dsvm use` / `dsvm update` 会给出重启提示。

`install` 会记录 dsvm 启动脚本、node、dsvm home 和安装时 PATH 的绝对路径；如果
dsvm 移动了位置，需要重新执行 `dsvm service install --force`。

### 桌面端（NW.js）

```
dsvm desktop             # 缺 nw.js 缓存则自动下载 SDK 并启动应用
dsvm desktop install     # 缓存 SDK 并创建用户快捷方式
dsvm desktop uninstall   # 删除快捷方式并清理 SDK 缓存
dsvm desktop update      # 有新版 SDK 时更新
```

`dsvm desktop` 把 `dsvm service url` 的地址内嵌到自带的 NW.js 应用里（永远用
SDK variant，缓存在 `~/.dsvm/desktop/nwjs/`），所以要先装好并启动 service。
应用显示连接中界面，用嵌入 frame（而非顶层跳转，这样跳转状态和重试逻辑不会丢）
装载 dsh；窗口可见时自动重试、切回可见瞬间立刻重试一次，不可见时不重试。托盘常驻
启用，右键菜单有最小化到托盘、轻量后台模式（持续不可见 60 秒后自动回到连接中页
释放前端资源）、关闭时最小化三个开关（默认全关）以及退出。Linux 默认自动启用
Wayland（`--ozone-platform-hint=auto`）并支持 Wayland 输入法
（`--enable-wayland-ime --wayland-text-input-version=3`）。窗口和托盘图标直接复用
官方 dsh 鲸鱼标（`desktop/icon.svg/png`）。快捷方式直接启动缓存的 nw 二进制，不走
dsvm（避免 Linux 图标归属问题）：Linux 写
`~/.local/share/applications/dsvm-desktop.desktop`，Windows 建开始菜单 + 桌面图标，
macOS 在 `~/Applications` 放最小 `.app`（默认 dock 图标，icns 为最佳努力）。

### 打开

```sh
dsvm                  # 等同于 dsvm open：直接用浏览器打开
dsvm open             # 打开浏览器，不输出 URL
dsvm open --print     # 输出 URL 并打开
dsvm service url      # 只输出 URL（脚本用途）
```

`dsvm open` 通过 `dsvm service url` 获取 URL，再调用平台打开方式（Linux 依次尝试
`xdg-open` / `gio` / `$BROWSER`，macOS 用 `open`，Windows 用
`rundll32 url.dll,FileProtocolHandler`）。需要同时在终端看到 URL 时加 `--print`；
只需要 URL 时用 `dsvm service url`。服务未运行时会提示如何启动。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `DSVM_HOME` | 状态目录，默认 `~/.dsvm`。 |
| `DSVM_REGISTRY` | npm registry（元数据与安装），同时兼容 `npm_config_registry`。 |
| `DSVM_SERVICE` | 服务定义注入的内部标记，使 `dsvm web` 记录自己的 URL。 |
| `NO_COLOR` | 关闭 ANSI 颜色。 |

## 开发

```sh
npm install       # 安装 TypeScript 并构建
npm run build     # tsc -> build/
npm test          # 构建 + node:test（单元测试与基于 fake 的集成测试）
```

源码是 `src/` 下的 TypeScript；`bin/dsvm.js` 是稳定的启动 shim，负责加载
`build/src/cli.js`。集成测试使用假的 `dsh`、`systemctl`、`xdg-open`，不会真正
改动系统服务或打开浏览器。
