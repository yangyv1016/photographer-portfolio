# 开发指南

## 代码布局

| 位置 | 职责 |
| --- | --- |
| `deployment/tencent/` | 独立 Node.js 服务、COS、SQLite、多账户与 Ubuntu 部署 |
| `app/route.ts`、`app/album.ts`、`app/admin-html.ts` | 共享作品页、相册和管理页面 |
| `app/api/admin/` | 共享作品管理业务接口 |
| `app/admin-photo-export.js` | 拼图编排、预览与导出流程 |
| `public/` | 共享样式、照片墙、相册、缩放、便签及 ZIP 前端代码 |
| `db/`、`drizzle/` | 共享数据库约定与作品库迁移 |
| `deployment/tencent/test/` | Node 内置测试运行器的适配与功能测试 |
| 根目录框架、Sites / Cloudflare 配置 | 保留的原构建路线，非本文自部署入口 |

腾讯云构建通过 esbuild 复用共享页面和管理路由，把 Cloudflare 存储、数据库及鉴权入口替换为本目录实现。不要只修改生成目录 `deployment/tencent/app/`；重新构建会覆盖它。

## 安装、构建与测试

使用 Node.js 24.x。在仓库根目录：

```bash
npm ci --prefix deployment/tencent
npm run build --prefix deployment/tencent
npm test --prefix deployment/tencent
```

或者进入 `deployment/tencent/` 执行 `npm ci`、`npm run build`、`npm test`。本路线依赖在该目录独立声明与锁定，不要求安装根目录的 React / Vinext 工具链。

测试覆盖账户隔离、邀请码、资料、上传代理、下载、相册权限与排序、便签 Markdown、缩略图、缩放、拼图布局及 ZIP 等。测试会构造临时 SQLite 数据与测试凭据；自动化通过不等于已经在真实桶、云网络或移动设备上验证，需要对涉及这些边界的改动补做实际检查。

服务启动后不会自动监听源文件；修改后重新执行 `npm run build` 并重启。调试环境配置与初始化方式见[部署指南](DEPLOYMENT.md#本地运行)。

## 数据与部署约定

- `platform.sqlite` 维护账户索引、会话及邀请码。账户的登录 ID 和主页 ID 可变，`storage_id` 固定；不要根据显示名称、登录 ID 或主页 ID 计算存储目录。
- 第一个管理员保留兼容目录 `data/gallery.sqlite`；其他账户使用 `data/photographers/<storage_id>/gallery.sqlite`。
- 照片对象在配置的 COS 私有桶中。公开读取、上传、后台下载与导出走网站同源接口，写操作需要登录与同源验证。
- `.env`、SQLite、备份、缩略图缓存和发布目录均属于运行产物，不应提交。新增配置先更新 `.env.example`，使用占位值。
- 当前支持单进程。修改容量、上传或取消逻辑时，需要同时考虑进程内预留量和数据库中的未完成任务。
- 不要给 `/api/*` 或后台强制设置公开缓存，也不要在日志输出密钥、Cookie 或 COS 签名链接。

## 发布包

```bash
npm run build --prefix deployment/tencent
npm test --prefix deployment/tencent
npm run release --prefix deployment/tencent
```

`deployment/tencent/releases/yangyu-<UTC 时间戳>/` 是可上传的独立目录。打包脚本重新安装 Linux x64 / glibc 生产依赖，不直接使用 Windows 构建机上的原生模块。更换架构需要同时修改打包目标、验证 sharp 原生依赖和 Ubuntu 安装流程；仅修改 bootstrap 的 Node 架构不够。

发布前检查依赖与第三方许可、运行测试，并用隔离数据目录检查首次初始化与旧库迁移。部署与回滚见[部署指南](DEPLOYMENT.md#更新与回滚)。

## 保留的 Sites 适配

根目录 `npm run dev`、`npm run build` 与 `npm start` 对应原 Sites / Vinext / Cloudflare 构建链路，需要其专用环境、数据库 / 存储绑定和鉴权上下文。`.openai/hosting.json` 中的 `YOUR_SITES_PROJECT_ID` 是占位符，使用前需重新绑定自己的 Sites 项目。该路线保留用于原宿主兼容，不能用根目录命令替代 Ubuntu Node 服务的构建、用户系统和 COS 配置。新功能若修改共享代码，也应评估是否影响保留的适配入口。
