# 部署指南

本文使用 `portfolio.example.com`、`YOUR_BUCKET`、`YOUR_REGION` 和 `YOUR_SERVER_IP` 作为占位符，执行前请替换。推荐路线为 Ubuntu x64 轻量应用服务器、同地域的轻量对象存储私有桶、Caddy HTTPS 和单进程 systemd 服务。

## 准备环境

- 构建机：Node.js 24.x 与 npm，可以是 Windows 或 Linux。
- 生产机：Ubuntu Linux x64，能访问 Node.js 官方下载站与 Caddy 软件源。当前打包脚本生成 Linux x64 / glibc 依赖，`sharp` 要求 glibc 2.28 及 SSE4.2。不要把该包直接安装到 ARM64。
- 一个私有读写 COS 桶。使用 LHCOS 时，先在轻量对象存储控制台创建桶，并确认服务器地域、桶地域与所购资源包匹配。
- 服务端专用、最小权限的 COS 子账号密钥。不要使用主账号全权限密钥。
- 域名方案需要 DNS 指向服务器，公网 80 / 443 端口可达；中国大陆服务器的域名访问还需满足当地实际接入要求。

不需要为了本路线执行根目录 `npm ci`。在仓库根目录使用 `npm --prefix deployment/tencent ...`，或者进入该目录后执行本文命令。

## COS 与环境配置

运行时只使用环境变量指定的一个桶，不自动回退到其他桶。不要把桶设为公开读，也不要把密钥放入前端脚本。

参考仓库中的 [`cos-runtime-policy.json`](https://github.com/yangyv1016/photographer-portfolio/blob/main/deployment/tencent/cos-runtime-policy.json)（发布包根目录也包含该文件），将地域、账号标识和桶名替换为自己的值后，在腾讯云为运行凭据配置对象权限。作用范围应限制为目标桶的 `photos/*`，需要读取、查询对象、删除，以及分块上传的发起、上传、完成和取消权限。该策略是模板，不能直接沿用占位符；无需授予创建桶或管理其他桶的权限。

生产配置示例：

```dotenv
PUBLIC_ORIGIN=https://portfolio.example.com
PORT=8080
DATA_DIRECTORY=/var/lib/yangyu
COS_BUCKET=YOUR_BUCKET
COS_REGION=YOUR_REGION
COS_SECRET_ID=YOUR_SECRET_ID
COS_SECRET_KEY=YOUR_SECRET_KEY
```

| 字段 | 含义 |
| --- | --- |
| `PUBLIC_ORIGIN` | 浏览器实际访问的协议、主机和可选端口，不能带路径。除 `localhost`、`127.0.0.1`、`[::1]` 外必须 HTTPS；也用于 Host 与同源校验。 |
| `PORT` | Node 服务监听端口，默认 8080，仅监听 `127.0.0.1`。修改后同步反向代理配置。 |
| `DATA_DIRECTORY` | SQLite、备份和缩略图缓存目录；相对路径基于应用根目录。本地默认 `data`，生产配置应为 `/var/lib/yangyu`，与服务写入权限一致。 |
| `COS_BUCKET` | 完整桶名称，包括腾讯云分配的后缀。 |
| `COS_REGION` | 桶的实际地域标识，例如 `ap-chengdu`；应与控制台一致。 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 服务端专用凭据，只存放于本地 `.env` 或生产 `/etc/yangyu.env`。 |

程序会读取应用根目录下的 `.env`，该目录默认是进程工作目录；`YANGYU_ROOT` 可显式指定应用根目录。生产环境由 systemd 的 `EnvironmentFile=/etc/yangyu.env` 注入配置，该文件的值会覆盖单元里的 `Environment=`；不要将本地相对路径 `DATA_DIRECTORY=data` 原样用于生产。不要把本地 `.env`、数据库或生产凭据提交到 Git。

## 本地运行

```bash
git clone https://github.com/yangyv1016/photographer-portfolio.git
cd photographer-portfolio/deployment/tencent
npm ci
npm run build
cp .env.example .env
```

PowerShell 可使用 `Copy-Item .env.example .env`。编辑 `.env`，本地使用 `PUBLIC_ORIGIN=http://127.0.0.1:8080`，其余 COS 配置必须填写。`app/` 为生成目录，不要直接修改。

### 创建本地管理员

初始化程序从标准输入接收 `username`、`password` JSON，没有交互式 `npm run setup-admin` 命令。下面用 Python 的隐藏密码输入避免把密码写进命令历史，密码至少 12 个字符。先确认当前目录仍为 `deployment/tencent/`。

```bash
python3 -c 'import getpass,json,sys; print("Administrator username: ",end="",file=sys.stderr,flush=True); username=input(); password=getpass.getpass("Password (12+ characters): "); confirmation=getpass.getpass("Confirm password: "); sys.exit("Passwords differ.") if password != confirmation else None; print(json.dumps({"username":username,"password":password}))' | node app/setup-admin.mjs
```

Windows 上的 PowerShell 7 使用同一命令并将 `python3` 换成可用的 `python`。该辅助步骤需要 Python；Node 应用运行本身不依赖 Python。不要将真实密码替换成命令行中的明文。

管理员配置成功后运行：

```bash
npm start
```

访问 `http://127.0.0.1:8080/login`。本地默认数据在 `deployment/tencent/data/`，首次安装为空作品库。重新执行初始化命令会重置第一个管理员的登录凭据并注销其所有会话，已有照片和资料保留。

## 构建可上传的生产包

在构建机的 `deployment/tencent/` 中执行：

```bash
npm ci
npm run build
npm test
npm run release
```

发布目录位于 `releases/yangyu-<UTC 时间戳>/`，包含编译后服务、静态资源、Linux x64 生产依赖、环境模板及 Ubuntu 脚本；不包含本地 `.env`、数据库、用户照片或 Git 历史。请通过 `npm run release` 调用打包脚本，它依赖 npm 提供的执行环境。

以下为 Bash 的压缩上传示例，替换发布目录名、SSH 用户和服务器地址：

```bash
tar -czf portfolio-release.tar.gz -C releases/yangyu-RELEASE_TIMESTAMP .
scp portfolio-release.tar.gz YOUR_SSH_USER@YOUR_SERVER_IP:/tmp/
```

Windows 自带的 `tar.exe` 也可压缩该目录。不要压缩整个仓库或包含 `.env` 的工作目录。

## Ubuntu 首次安装

以下命令在服务器执行。每次选一个新的空目录解压，避免混入其他版本文件：

```bash
mkdir -p ~/portfolio-release
tar -xzf /tmp/portfolio-release.tar.gz -C ~/portfolio-release
cd ~/portfolio-release
sudo bash ubuntu/bootstrap.sh
sudo install -m 600 -o root -g root .env.example /etc/yangyu.env
sudo nano /etc/yangyu.env
```

`bootstrap.sh` 安装脚本固定版本的 Node.js 24 并核对官方 SHA-256，缺少 Caddy 时安装官方软件源版本。已有 Caddy 不会被重新安装。Node 运行时位于 `/opt/yangyu-runtime/node`。

填好 `/etc/yangyu.env`，正式域名使用 `PUBLIC_ORIGIN=https://portfolio.example.com`，并将复制的 `DATA_DIRECTORY=data` 改为 **`DATA_DIRECTORY=/var/lib/yangyu`**；也可删掉这一行，继承服务单元的相同默认值。该目录与服务写入权限、初始化和备份脚本一致。然后安装服务并交互创建管理员：

```bash
sudo bash ubuntu/install.sh
sudo bash ubuntu/setup-admin.sh
sudo systemctl status yangyu --no-pager
```

`install.sh` 创建专用服务用户 `yangyu`、独立版本目录、服务及备份定时器，启动仅限本机访问的应用。`setup-admin.sh` 会隐藏密码输入并要求再次确认；在启用公网代理前完成它。脚本中的 `yangyu` 是内部服务与目录标识，不要求你的网站使用这个名称。

### 启用域名 HTTPS

编辑解压目录里的 `ubuntu/Caddyfile`，将站点名改成实际域名，反向代理保持 `127.0.0.1:8080`（或你的 `PORT`）。确认 DNS 与 80 / 443 端口后：

```bash
sudo bash ubuntu/publish.sh
```

该脚本先校验、备份已有 `/etc/caddy/Caddyfile`，然后**替换整个活动配置**。如果服务器已有其他站点，请手动将本项目的站点块合并到现有 Caddyfile，再执行 `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` 与 `sudo systemctl reload caddy`，保留其他站点。

打开 `https://portfolio.example.com/login`，配置个人资料并上传一张测试照片，检查缩略图、详情原图和后台下载。修改域名时同时更新 `/etc/yangyu.env` 的 `PUBLIC_ORIGIN` 与 Caddy 站点名，然后重启应用并重新登录。

### 使用公网 IP 的可选方案

`ubuntu/Caddyfile.ip` 提供 ACME 短期 IP 证书配置。将其中的示例 IP `203.0.113.10` 全部替换为真实公网 IP，包括 `default_sni`，并在 `/etc/yangyu.env` 设置 `PUBLIC_ORIGIN=https://YOUR_SERVER_IP`，然后运行 `sudo bash ubuntu/publish.sh --ip`。

此方式依赖所装 Caddy 与证书机构对该 ACME 配置的支持，以及 IP 的公网可达性；私网 IP 和示例地址不能据此取得公开信任证书。优先使用域名方案，遇到签发失败检查 Caddy 日志。脚本同样会替换整个 Caddyfile。

## 目录、日志与检查

| 服务器路径 | 内容 |
| --- | --- |
| `/opt/yangyu/current` | 当前代码版本的符号链接 |
| `/opt/yangyu/releases/` | 历次部署代码与依赖 |
| `/opt/yangyu/previous-release` | 安装时记录的上一个代码目录 |
| `/etc/yangyu.env` | root 所有、权限 600 的服务配置 |
| `/var/lib/yangyu/platform.sqlite` | 账户、会话、邀请码、存储标识 |
| `/var/lib/yangyu/gallery.sqlite` | 第一个管理员的作品、系列、便签 |
| `/var/lib/yangyu/photographers/<storage_id>/gallery.sqlite` | 其他摄影师的独立作品库 |
| `/var/lib/yangyu/backups/` | 每个数据库最近 14 份快照 |
| `/var/lib/yangyu/previews/` | 可重建的 WebP 缩略图缓存 |

```bash
sudo journalctl -u yangyu -n 100 --no-pager
sudo journalctl -u caddy -n 100 --no-pager
sudo systemctl list-timers yangyu-backup.timer
```

Node 会验证 Host。直接通过本机端口诊断生产配置时，应带实际站点 Host，例如 `curl -I -H 'Host: portfolio.example.com' http://127.0.0.1:8080/`。应用不应直接暴露 8080 端口。

## 更新与回滚

1. 保存 `/etc/yangyu.env` 的私密备份，并运行 `sudo systemctl start yangyu-backup.service`；确认备份成功。
2. 在构建机重新构建、测试和打包；上传并解压到新的空目录。
3. 在新包目录运行 `sudo bash ubuntu/install.sh`。它保留 `/var/lib/yangyu` 和 `/etc/yangyu.env`，记录上个版本，然后切换代码与重启。
4. 检查服务日志、公开页、登录、上传、预览、下载。域名及代理规则未变化时，无需再次运行 `publish.sh`。

回滚前先检查该版本是否进行了旧代码不兼容的数据库迁移；代码回滚不会撤销数据库迁移。兼容时，可检查并切换安装脚本记录的上一个目录：

```bash
sudo cat /opt/yangyu/previous-release
```

确认输出是存在的、预期的 `/opt/yangyu/releases/...` 目录，再用这个**完整目录**替换下面占位符：

```bash
sudo ln -sfn /opt/yangyu/releases/PREVIOUS_RELEASE /opt/yangyu/current
sudo systemctl restart yangyu
```

如果需要恢复数据库，请按下一节操作。不要通过删除数据目录来“重装”，也不要在验证前清理旧版本和备份。

## 备份与恢复

定时器每天北京时间 03:30 触发，随机延迟最多 5 分钟，停机错过的任务在恢复后补跑。备份使用 SQLite 在线备份接口，分别保留平台库和每个作品库的最近 14 份快照。可随时手工触发：

```bash
sudo systemctl start yangyu-backup.service
sudo journalctl -u yangyu-backup.service -n 30 --no-pager
```

数据库备份**不包含 COS 照片**，也不会自动把备份传到其他机器。应另外备份桶对象、环境配置，并把数据库快照加密保存到异机。恢复演练需要同时确认数据库引用的对象仍然存在。

恢复步骤：

1. 停止 `yangyu` 服务，暂时停止备份定时器，并将当前整个数据目录与配置保存为独立备份。
2. 选择同一次备份运行产生的快照。`backups/platform/` 对应 `platform.sqlite`；`backups/photographer-1/` 对应根目录 `gallery.sqlite`；其他 `backups/photographer-<storage_id>/` 对应 `photographers/<storage_id>/gallery.sqlite`。
3. 将快照复制回相应路径；服务已停止后，清理这些**被恢复数据库**遗留的同名 `-wal`、`-shm` 文件。不要改 UUID，不要根据用户名重命名目录。
4. 确认所有文件归属 `yangyu:yangyu`，恢复相应 COS 对象，再启动服务与备份定时器。
5. 验证各账户、照片、便签及原图下载，确认后恢复对外使用。

每个数据库的在线快照各自一致，但跨库快照并非同一瞬间的全局事务。需要严格一致的全站恢复点时，备份窗口暂停注册、资料修改和照片写入，再触发备份。不要用开发环境的 `.wrangler/state` 替换正式 SQLite。

## 流量路径与费用核查

| 操作 | 路径 |
| --- | --- |
| 上传 | 浏览器 → 网站服务 → 配置的 COS 桶，分块传输 |
| 相册与拼图预览 | 浏览器 → 网站缩略图接口 → 本地缓存；缓存未命中时服务读取 COS 并生成 WebP |
| 详情原图 | 浏览器 → 网站同源图片接口 → 服务读取 COS |
| 后台原图下载 / 拼图生成 | 已登录浏览器 → 当前账户受控接口 → 服务读取 COS |

缩略图在服务器生成，不调用 COS 图片处理服务，也不额外写入桶。原图通过服务器流式转发，不整批落盘。程序未指定独立的“内网端点”开关；使用 SDK 根据桶与地域构造的地址，**同源代理本身不保证 COS 公网费用为零**。

正式开放前，用真实的上传、浏览、下载分别测试，核对服务器解析与网络路由、桶地域、轻量服务器与 LHCOS 的适用条件，以及腾讯云用量和账单中的公网下行、内网流量、请求次数和资源包抵扣。外地服务器、跨地域访问、资源包到期或超额都会改变费用；服务器向访客输出图片的流量也按服务器方案计算。本机预览读取云端原图可能走公网。

需要 CDN / EdgeOne 时，单独核对其费用和回源路径。不得强制缓存 `/api/*`、`/dashboard*`、`/admin*`、登录和注册响应；遵守 `private, no-store`，避免缓存其他账户的私有响应。

## 常见问题

- **启动提示缺少 COS 配置**：确认进程工作目录及 `.env` 路径，或检查 `/etc/yangyu.env` 后重启服务；不要把密钥粘贴到公开 issue。
- **Invalid host / 登录提交失败**：`PUBLIC_ORIGIN` 必须与浏览器最终地址一致，包括协议与端口；反向代理应保留正确 Host。
- **缩略图失败、原图可用**：检查 `sharp` 是否为目标平台的原生依赖及服务器资源；当前标准包是 Linux x64，不是构建机平台的直接 `node_modules` 副本。超大或损坏图片可能无法生成预览。
- **上传显示容量不足或容量核对中**：检查账户配额、未完成任务、COS 读取权限与日志；减少配额不会自动删除作品。
- **旧数据目录缺失**：检查 `DATA_DIRECTORY` 与 `storage_id`，从备份恢复；不要创建空库覆盖缺失账户的数据。
- **准备多进程或多副本**：当前上传预留量保存在进程内，需先改造共享协调和数据库方案；直接启动多个副本不是支持的扩容方式。
