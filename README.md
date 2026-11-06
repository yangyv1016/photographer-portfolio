# 摄影师作品展示

面向摄影师的作品集与管理工作台，支持多摄影师、独立主页、照片墙、完整相册、Markdown 便签和拼图导出。摄影师通过邀请码注册，各自管理作品与存储配额。

自部署使用 **Node.js 24 + SQLite + Ubuntu / Caddy / systemd**，照片存储可以二选一：

| 版本 | 原图位置 | 适用场景 | 配置模板 |
| --- | --- | --- | --- |
| 本地存储版 | 服务器磁盘的 `DATA_DIRECTORY/objects/` | 单机部署、已有系统盘或数据盘、不需要对象存储 | [`.env.local.example`](deployment/tencent/.env.local.example) |
| COS 存储版 | 腾讯云私有 COS / 轻量对象存储桶 | 已有对象存储、希望原图与应用磁盘分开管理 | [`.env.cos.example`](deployment/tencent/.env.cos.example) |

两种版本共用同一份代码和工作台，通过 `STORAGE_BACKEND=local` 或 `cos` 选择。本地版不需要 COS 账号、桶或密钥。部署入口仍在历史目录 `deployment/tencent/`；这个目录名不表示必须使用腾讯云，也不需要先安装根目录框架依赖。

## 功能

- 摄影师目录、封面、头像、签名、自定义地区与个人简介。
- 可独立修改的登录 ID 和主页访问 ID；作品库使用固定存储标识，不随改名搬动目录。
- 分系列上传、封面、照片墙开关、批量操作及登录后下载自己的原图。
- 只读三列相册；工作台按系列排序，支持拖动、键盘和位置按钮，同步照片墙与系列封面。
- 缩略图渐进加载、详情原图、手机双指与桌面滚轮缩放。
- 近全屏 Markdown 便签编辑器，支持置顶与组内排序，正文在主页弹窗中阅读。
- 按指定张数分组编排拼图，缩略图预览、原图生成，一次 ZIP 导出全部结果。
- 月卡、季卡、年卡兑换码注册与续期，套餐容量、到期门禁和工作台提醒。
- 管理员兑换码、账户启停、回收站、容量配额与数据库定时备份。

## 从这里开始

| 目标 | 文档 |
| --- | --- |
| 选择本地或 COS、启动、生产安装与 HTTPS | [部署指南](docs/DEPLOYMENT.md) |
| 管理照片、调整相册、写便签与导出拼图 | [使用指南](docs/USAGE.md) |
| 代码结构、构建、测试与发布包 | [开发指南](docs/DEVELOPMENT.md) |
| 套餐、兑换续期、容量和到期行为 | [订阅说明](docs/SUBSCRIPTIONS.md) |

### 本地存储快速开始

需要 Node.js **24.x** 和 npm。下面是 Bash 命令；PowerShell 将 `cp` 换成 `Copy-Item`。

```bash
git clone https://github.com/yangyv1016/photographer-portfolio.git
cd photographer-portfolio/deployment/tencent
npm ci
npm run build
cp .env.local.example .env
```

本地模板已设置 `STORAGE_BACKEND=local`、`PUBLIC_ORIGIN=http://127.0.0.1:8080`。应用自动读取当前工作目录的 `.env`，数据保存在 `deployment/tencent/data/`。按[创建本地管理员](docs/DEPLOYMENT.md#创建本地管理员)初始化账户后执行：

```bash
npm start
```

打开 `http://127.0.0.1:8080/login` 即可管理和上传作品。外部访问必须配置 HTTPS。

### COS 存储快速开始

使用相同的安装与构建命令，配置文件改为：

```bash
cp .env.cos.example .env
```

填写自己的桶名、地域和最小权限凭据，再按同样方式初始化管理员并启动。桶保持私有读写；[完整 COS 配置步骤](docs/DEPLOYMENT.md#方案-bcos-存储版)见部署指南。已有部署未设置 `STORAGE_BACKEND` 时仍按 COS 模式运行，以兼容原配置；新部署请明确写出所选模式。

## 部署边界

应用以单个 Node.js 进程运行。两种模式都将 SQLite 和可重建的缩略图缓存保存在服务器；原图、头像和封面则写入所选本地磁盘或私有桶。浏览器始终通过网站受控接口上传、浏览和下载，不直接暴露磁盘目录或桶凭据。

当前标准发布包面向 **Ubuntu Linux x64 / glibc**。ARM64 需要调整发布依赖并另行验证；`bootstrap.sh` 能安装 ARM64 Node，不代表标准包支持 ARM64。

本地模式使用服务器磁盘和服务器出站流量；COS 模式还需核对对象存储用量、请求和网络费用。两种模式都需要备份原图；数据库定时快照不包含这些原件。[备份与恢复](docs/DEPLOYMENT.md#备份与恢复)说明了各自做法。

仓库保留了原 Sites / Vinext / Cloudflare 适配代码。根目录的 `npm run build` 属于该构建链路，不会生成这里的独立 Node.js 服务。新部署请使用 `deployment/tencent/` 的命令。

## 许可与第三方内容

项目代码采用 [MIT 许可证](LICENSE)。样例照片及第三方组件各自遵循原许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；MIT 许可证不重新授权这些第三方内容，也不改变用户上传作品的权利归属。
