# 部署指南

本文提供**服务器本地磁盘版**和 **COS 存储版**两条路线，共用 Node.js 24、SQLite、Ubuntu / Caddy / systemd。历史目录名仍为 `deployment/tencent/`，不要求服务器一定在腾讯云，也不要求一定购买对象存储。

文中的 `portfolio.example.com`、`YOUR_BUCKET`、`YOUR_REGION` 和 `YOUR_SERVER_IP` 均为占位符，执行前请替换。

## 准备环境

- 构建机：Node.js 24.x 与 npm，可以是 Windows 或 Linux。
- 生产机：Ubuntu Linux x64，能访问 Node.js 官方下载站与 Caddy 软件源。当前打包脚本生成 Linux x64 / glibc 依赖，`sharp` 要求 glibc 2.28 及 SSE4.2。不要把该包直接安装到 ARM64。
- 本地存储版：足够的服务器磁盘空间，可以使用系统盘或已挂载的数据盘，无需 COS 账号、桶或密钥。
- 仅 COS 版：一个私有读写桶及服务端最小权限凭据。使用 LHCOS 时，先在轻量对象存储控制台创建桶，并确认服务器地域、桶地域与资源包匹配；不要使用主账号全权限密钥。
- 域名方案需要 DNS 指向服务器，公网 80 / 443 端口可达；中国大陆服务器的域名访问还需满足当地实际接入要求。

不需要为了本路线执行根目录 `npm ci`。在仓库根目录使用 `npm --prefix deployment/tencent ...`，或者进入该目录后执行本文命令。

## 选择存储方式

| 项目 | 方案 A：本地存储版 | 方案 B：COS 存储版 |
| --- | --- | --- |
| `STORAGE_BACKEND` | `local` | `cos` |
| 模板 | `.env.local.example` | `.env.cos.example` |
| 原图、头像与封面 | `DATA_DIRECTORY/objects/` | 所配置的私有桶 |
| SQLite、便签与缩略图缓存 | 服务器 `DATA_DIRECTORY` | 服务器 `DATA_DIRECTORY` |
| 必需外部存储服务 | 无 | 私有 COS / LHCOS 桶及最小权限凭据 |
| 需备份原件 | 服务器对象文件和配套存储元数据 | 桶内对象 |

两种模式保留相同的登录、账户隔离、容量配额、同源分块上传和原图下载接口。`.env.example` 默认采用本地存储。为兼容旧部署，**没有设置 `STORAGE_BACKEND` 时仍按 `cos` 运行**；新部署应明确设置，不会在存储服务出错时自动回退到另一个后端。

### 方案 A：本地存储版

生产配置只需：

```dotenv
STORAGE_BACKEND=local
PUBLIC_ORIGIN=https://portfolio.example.com
PORT=8080
DATA_DIRECTORY=/var/lib/yangyu
```

原图保存到 `/var/lib/yangyu/objects/photos/...`，紧邻的同名 `.json` 文件保存对象元数据；二者必须一起保留。分块暂存在 `/var/lib/yangyu/multipart/<上传 UUID>/`。SQLite 和缓存也位于 `/var/lib/yangyu`。配置为 `local` 时不需要填写任何 `COS_*` 变量。这里的“本地”指**运行网站的服务器磁盘**，不表示网站访客的电脑。

可把数据盘挂载到 `/var/lib/yangyu`，再按下文安装，让数据库、对象和上传暂存都位于持久数据卷中。已有数据时先停服务、完整复制并核验，再更改挂载；不要在有数据的目录上直接挂入空卷。应用目录 `/opt/yangyu/releases/` 与数据目录分离，代码更新不会替换数据卷。

保持默认数据路径最容易与脚本配合。若改为其他路径，必须同时调整服务和备份单元的 `ReadWritePaths` / 环境变量、目录归属权限，以及 `setup-admin.sh` 中的固定数据路径；只改 `/etc/yangyu.env` 不足以完成迁移。

**不要为 `objects/`、上传暂存或整个数据目录配置 Caddy `file_server`、静态别名或公网目录索引。** 浏览器仍经网站图片、上传与下载接口访问，保留账户和作品归属检查。

### 方案 B：COS 存储版

运行时只使用环境变量指定的一个桶，不自动回退到其他桶。不要把桶设为公开读，也不要把密钥放入前端脚本。

参考仓库中的 [`cos-runtime-policy.json`](https://github.com/yangyv1016/photographer-portfolio/blob/main/deployment/tencent/cos-runtime-policy.json)（发布包根目录也包含该文件），将地域、账号标识和桶名替换为自己的值后，在腾讯云为运行凭据配置对象权限。作用范围应限制为目标桶的 `photos/*`，需要读取、查询对象、删除，以及分块上传的发起、上传、完成和取消权限。该策略是模板，不能直接沿用占位符；无需授予创建桶或管理其他桶的权限。

生产配置示例：

```dotenv
STORAGE_BACKEND=cos
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
| `STORAGE_BACKEND` | 明确选择 `local` 或 `cos`；省略时为兼容旧部署使用 `cos`。 |
| `PUBLIC_ORIGIN` | 浏览器实际访问的协议、主机和可选端口，不能带路径。除 `localhost`、`127.0.0.1`、`[::1]` 外必须 HTTPS；也用于 Host 与同源校验。 |
| `PORT` | Node 服务监听端口，默认 8080，仅监听 `127.0.0.1`。修改后同步反向代理配置。 |
| `DATA_DIRECTORY` | SQLite、备份、缩略图缓存，以及本地模式的对象和上传暂存目录；相对路径基于应用根目录。开发默认 `data`，生产配置应为 `/var/lib/yangyu`，与服务写入权限一致。 |
| `COS_BUCKET` | 仅 COS 模式：完整桶名称，包括腾讯云分配的后缀。 |
| `COS_REGION` | 仅 COS 模式：桶的实际地域标识，例如 `ap-chengdu`；应与控制台一致。 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 仅 COS 模式：服务端专用凭据，只存放于本机 `.env` 或生产 `/etc/yangyu.env`。 |

程序会读取应用根目录下的 `.env`，该目录默认是进程工作目录；`YANGYU_ROOT` 可显式指定应用根目录。生产环境由 systemd 的 `EnvironmentFile=/etc/yangyu.env` 注入配置，该文件的值会覆盖单元里的 `Environment=`；不要将本地相对路径 `DATA_DIRECTORY=data` 原样用于生产。不要把本地 `.env`、数据库或生产凭据提交到 Git。

## 本地运行

先安装和构建两种模式共用的服务：

```bash
git clone https://github.com/yangyv1016/photographer-portfolio.git
cd photographer-portfolio/deployment/tencent
npm ci
npm run build
cp .env.local.example .env
```

此处选择本地存储，不需要购买云服务。PowerShell 可使用 `Copy-Item .env.local.example .env`。保留模板中的 `STORAGE_BACKEND=local`、`PUBLIC_ORIGIN=http://127.0.0.1:8080` 和 `DATA_DIRECTORY=data` 即可；应用会自动创建数据目录。

如果要在本机运行 COS 版，把复制命令改为 `cp .env.cos.example .env`，保留 `STORAGE_BACKEND=cos`，填好自己的桶、地域与凭据。其余初始化和启动步骤相同。本机读取云端原图可能使用 COS 公网链路，应核对费用。

`app/` 为生成目录，不要直接修改。

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

访问 `http://127.0.0.1:8080/login`。开发数据默认在 `deployment/tencent/data/`；本地存储模式下原件也在这个目录中，COS 模式下原件在桶内。首次安装为空作品库。重新执行初始化命令会重置第一个管理员的登录凭据并注销其所有会话，已有照片和资料保留。

## 构建可上传的生产包

在构建机的 `deployment/tencent/` 中执行：

```bash
npm ci
npm run build
npm test
npm run release
```

发布目录位于 `releases/yangyu-<UTC 时间戳>/`，包含编译后服务、静态资源、Linux x64 生产依赖、两种存储环境模板及 Ubuntu 脚本；不包含实际 `.env`、数据库、用户照片或 Git 历史。两种模式使用同一个包，在目标服务器选择配置。请通过 `npm run release` 调用打包脚本，它依赖 npm 提供的执行环境。

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
```

按所选模式，**只执行下面两个复制命令中的一个**。本地存储版：

```bash
sudo install -m 600 -o root -g root .env.local.example /etc/yangyu.env
```

COS 存储版：

```bash
sudo install -m 600 -o root -g root .env.cos.example /etc/yangyu.env
```

然后编辑配置：

```bash
sudo nano /etc/yangyu.env
```

`bootstrap.sh` 安装脚本固定版本的 Node.js 24 并核对官方 SHA-256，缺少 Caddy 时安装官方软件源版本。已有 Caddy 不会被重新安装。Node 运行时位于 `/opt/yangyu-runtime/node`。

填好 `/etc/yangyu.env`：本地版保留 `STORAGE_BACKEND=local`；COS 版保留 `cos` 并填好桶配置。两者正式域名均使用 `PUBLIC_ORIGIN=https://portfolio.example.com`，并将复制的 `DATA_DIRECTORY=data` 改为 **`DATA_DIRECTORY=/var/lib/yangyu`**；也可删掉这一行，继承服务单元的相同默认值。该目录与服务写入权限、初始化和备份脚本一致。然后安装服务并交互创建管理员：

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
| `/var/lib/yangyu/objects/` | 仅本地模式：原图、头像、封面及配套存储元数据，需一起持久保存 |
| `/var/lib/yangyu/multipart/` | 仅本地模式：未完成上传的元数据与分块，恢复续传时需要保留 |
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

定时快照**只备份 SQLite**，不包含本地 `objects/`、`multipart/`，也不包含 COS 桶内原件，不会自动上传到异机。两种版本都要另行保存环境配置和照片原件。缩略图缓存可以重建，不能代替原图备份。

### 本地存储版：完整数据备份

需要一致恢复点时，暂停网站与定时备份，把整个 `DATA_DIRECTORY` 打包；这样数据库、对象文件、对象旁的 `.json` 元数据和未完成上传可以一起恢复。先确认备份位置有足够空间。以下 Bash 命令采用标准路径，备份放在当前登录用户的私有目录，网站会短暂停止：

```bash
(
  set -eu
  backup_dir="$HOME/portfolio-backups"
  backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  install -d -m 700 "$backup_dir"
  sudo systemctl stop yangyu-backup.timer yangyu-backup.service yangyu.service
  trap 'sudo systemctl start yangyu.service yangyu-backup.timer' EXIT
  sudo tar --acls --xattrs -czf "$backup_dir/data-$backup_stamp.tar.gz" -C /var/lib yangyu
  sudo install -m 600 -o "$(id -u)" -g "$(id -g)" /etc/yangyu.env "$backup_dir/config-$backup_stamp.env"
  sudo chown "$(id -u):$(id -g)" "$backup_dir/data-$backup_stamp.tar.gz"
  chmod 600 "$backup_dir/data-$backup_stamp.tar.gz"
  cd "$backup_dir"
  sha256sum "data-$backup_stamp.tar.gz" "config-$backup_stamp.env" > "checksums-$backup_stamp.txt"
)
```

退出这个命令块时会重新启动服务与备份定时器；如果维护前它们本来应保持停止，请相应调整最后的启动操作。成功后，把实际文件名替换到下面的 `BACKUP_TIMESTAMP`，通过 SSH 复制到自己准备的异机私有目录：

```bash
scp "$HOME/portfolio-backups/data-BACKUP_TIMESTAMP.tar.gz" \
    "$HOME/portfolio-backups/config-BACKUP_TIMESTAMP.env" \
    "$HOME/portfolio-backups/checksums-BACKUP_TIMESTAMP.txt" \
    YOUR_BACKUP_USER@YOUR_BACKUP_HOST:PRIVATE_BACKUP_DIRECTORY/
```

这些文件包含照片、账户数据库和运行配置，应在受限且加密的备份位置保存。`scp` 提供传输加密，备份端的存储加密与保留策略需自行配置；不要放入公开仓库或网站静态目录。

### 本地存储版：普通目录恢复

先用上一节完整备份保存当前状态，并把所选备份下载到 `$HOME/portfolio-backups/`。确认校验和后恢复到**新的空目录**，原数据目录保留为 `yangyu.before-restore-*`，不直接覆盖：

```bash
(
  set -eu
  backup_dir="$HOME/portfolio-backups"
  backup_stamp=BACKUP_TIMESTAMP
  cd "$backup_dir"
  sha256sum -c "checksums-$backup_stamp.txt"
  if mountpoint -q /var/lib/yangyu; then
    echo '数据目录是挂载点，请使用下文的数据卷恢复流程。' >&2
    exit 1
  fi
  restore_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  restore_stage="/var/lib/yangyu-restore-$restore_stamp"
  test ! -e "/var/lib/yangyu.before-restore-$restore_stamp"
  sudo mkdir -m 700 "$restore_stage"
  sudo tar --acls --xattrs -xzf "$backup_dir/data-$backup_stamp.tar.gz" -C "$restore_stage"
  sudo test -f "$restore_stage/yangyu/platform.sqlite"
  sudo chown -R yangyu:yangyu "$restore_stage/yangyu"
  sudo systemctl stop yangyu-backup.timer yangyu-backup.service yangyu.service
  sudo mv /var/lib/yangyu "/var/lib/yangyu.before-restore-$restore_stamp"
  sudo mv "$restore_stage/yangyu" /var/lib/yangyu
  sudo install -m 600 -o root -g root "$backup_dir/config-$backup_stamp.env" /etc/yangyu.env
  sudo nano /etc/yangyu.env
  sudo systemctl start yangyu.service yangyu-backup.timer
)
```

启动前在编辑器中检查域名、`DATA_DIRECTORY=/var/lib/yangyu` 和 `STORAGE_BACKEND=local` 是否适合目标服务器；启动后验证登录、各账户照片、头像、便签、上传与原图下载。不要在确认成功前清理保留的旧数据。

**数据卷恢复**：`/var/lib/yangyu` 是挂载点时，不要移动该挂载点或格式化原卷。将备份解压到新卷的空目录，保持归档中的 `yangyu/` 内容作为数据根目录，核对原图及 `.json` 元数据后停止服务，再把准备好的新数据根挂载到 `/var/lib/yangyu`。保留原卷供回退，并设置 `yangyu:yangyu` 归属、恢复对应 `/etc/yangyu.env`，再启动服务。具体挂载和开机挂载配置取决于服务器的磁盘与文件系统。

### COS 存储版：数据库与桶恢复

数据库快照与桶对象都需要保存。COS 原图备份通过所用桶的版本、备份或对象复制方案独立完成，验证恢复副本的大小及内容校验和；数据库快照恢复本身不会把照片复制回桶。

恢复步骤：

1. 停止 `yangyu` 服务，暂时停止备份定时器，并将当前整个数据目录与配置保存为独立备份。
2. 选择同一次备份运行产生的快照。`backups/platform/` 对应 `platform.sqlite`；`backups/photographer-1/` 对应根目录 `gallery.sqlite`；其他 `backups/photographer-<storage_id>/` 对应 `photographers/<storage_id>/gallery.sqlite`。
3. 将快照复制回相应路径；服务已停止后，清理这些**被恢复数据库**遗留的同名 `-wal`、`-shm` 文件。不要改 UUID，不要根据用户名重命名目录。
4. 确认所有文件归属 `yangyu:yangyu`，恢复相应 COS 对象，再启动服务与备份定时器。
5. 验证各账户、照片、便签及原图下载，确认后恢复对外使用。

每个数据库的在线快照各自一致，但跨库快照并非同一瞬间的全局事务。需要严格一致的全站恢复点时，备份窗口暂停注册、资料修改和照片写入，再触发备份。不要用开发环境的 `.wrangler/state` 替换正式 SQLite。

## 切换存储方式

更改 `STORAGE_BACKEND` **不会迁移既有照片**，也不会回退读取原后端。当前没有一键存储迁移工具。已有部署不要直接改模式后启动：

1. 备份数据库、运行配置和全部原件，保存旧后端供回退。
2. 在原模式下完成或取消所有未完成上传，再暂停新的写入。
3. 在隔离环境准备目标后端，完整迁移数据库引用的照片、头像、主页封面和目录背景，保持每个 `photos/...` 对象 key 与账户存储 UUID 不变。本地模式还必须准备对象旁的 `.json` 元数据；仅把 COS 文件下载到目录里不是完整迁移。
4. 对目标对象逐个核对数量、大小及内容校验和，并验证本地存储元数据。分别检查多个账户的浏览、预览、下载、资料图片、配额和上传。
5. 通过验证后才修改生产配置、切换并重新检查；失败时恢复原配置和对应数据。两端都确认完整前，不删除原件。

没有经过验证的迁移步骤或适配元数据的工具时，继续使用原存储后端，在新环境部署另一模式。

## 流量路径与费用核查

| 操作 | 本地存储版 | COS 存储版 |
| --- | --- | --- |
| 上传 | 浏览器 → 网站服务 → 服务器分块暂存与对象文件 | 浏览器 → 网站服务 → 配置的私有桶 |
| 相册与拼图预览 | 缓存未命中时服务读取磁盘原件生成 WebP | 缓存未命中时服务读取 COS 原件生成 WebP |
| 详情原图 | 网站同源接口流式读取本地原件 | 网站同源接口流式读取 COS 原件 |
| 后台原图下载 / 拼图生成 | 登录后的当前账户接口读取本地原件 | 登录后的当前账户接口读取 COS 原件 |

本地模式不使用 COS 服务，其预算是服务器磁盘容量、备份存储和服务器出站流量。系统盘与数据盘的计价取决于所用主机方案；本地版不代表磁盘和带宽免费。

两种模式的缩略图都在服务器生成。COS 模式不调用 COS 图片处理服务，也不额外写入预览对象；原图经服务器流式转发，不整批保存到本机。程序未指定独立的“内网端点”开关，使用 SDK 根据桶与地域构造的地址，**同源代理本身不保证 COS 公网费用为零**。

正式开放前，用真实的上传、浏览、下载分别测试，核对服务器解析与网络路由、桶地域、轻量服务器与 LHCOS 的适用条件，以及腾讯云用量和账单中的公网下行、内网流量、请求次数和资源包抵扣。外地服务器、跨地域访问、资源包到期或超额都会改变费用；服务器向访客输出图片的流量也按服务器方案计算。本机预览读取云端原图可能走公网。

需要 CDN / EdgeOne 时，单独核对其费用和回源路径。不得强制缓存 `/api/*`、`/dashboard*`、`/admin*`、登录和注册响应；遵守 `private, no-store`，避免缓存其他账户的私有响应。

## 常见问题

- **想使用本地版却提示缺少 COS 配置**：确认 `.env` 或 `/etc/yangyu.env` 中有 `STORAGE_BACKEND=local`。省略该字段会为兼容旧部署选择 COS；不要只删除 COS 密钥。COS 版则需要填写完整桶配置，修改后重启服务。
- **本地原图丢失或重启后为空**：检查数据卷是否已挂载、`DATA_DIRECTORY` 是否指向原数据目录，并确认对象文件及相邻 `.json` 元数据一起恢复。不要把空数据卷当成原数据继续写入。
- **本地上传失败**：检查数据目录归属、systemd 的 `ReadWritePaths` 及磁盘剩余空间。账户配额限制图片容量，不会预留物理磁盘空间。
- **Invalid host / 登录提交失败**：`PUBLIC_ORIGIN` 必须与浏览器最终地址一致，包括协议与端口；反向代理应保留正确 Host。
- **缩略图失败、原图可用**：检查 `sharp` 是否为目标平台的原生依赖及服务器资源；当前标准包是 Linux x64，不是构建机平台的直接 `node_modules` 副本。超大或损坏图片可能无法生成预览。
- **上传显示容量不足或容量核对中**：检查账户配额、未完成任务、COS 读取权限与日志；减少配额不会自动删除作品。
- **旧数据目录缺失**：检查 `DATA_DIRECTORY` 与 `storage_id`，从备份恢复；不要创建空库覆盖缺失账户的数据。
- **准备多进程或多副本**：当前上传预留量保存在进程内，需先改造共享协调和数据库方案；直接启动多个副本不是支持的扩容方式。
