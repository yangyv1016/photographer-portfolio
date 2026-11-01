# 摄影师作品展示

面向摄影师的作品集与管理工作台，支持多摄影师、独立主页、照片墙、完整相册、Markdown 便签和拼图导出。摄影师通过邀请码注册，各自管理作品与存储配额。

推荐的自部署方案是 **Node.js 24 + SQLite + 腾讯云 COS 私有桶 + Ubuntu / Caddy / systemd**。腾讯云轻量对象存储（Lighthouse COS，LHCOS）可作为照片存储，应用提供同源上传、浏览和下载接口。部署入口位于 `deployment/tencent/`，不需要先安装根目录的框架依赖。

## 功能

- 摄影师目录、封面、头像、签名、自定义地区与个人简介。
- 可独立修改的登录 ID 和主页访问 ID；作品库使用固定存储标识，不随改名搬动目录。
- 分系列上传、封面、照片墙开关、批量操作及登录后下载自己的原图。
- 只读三列相册；工作台内单独排序，支持拖动、键盘和位置按钮。
- 缩略图渐进加载、详情原图、手机双指与桌面滚轮缩放。
- 近全屏 Markdown 便签编辑器，正文在主页弹窗中阅读。
- 按指定张数分组编排拼图，缩略图预览、原图生成，一次 ZIP 导出全部结果。
- 管理员邀请码、账户启停、回收站、容量配额与数据库定时备份。

## 从这里开始

| 目标 | 文档 |
| --- | --- |
| 本地启动、生产安装、COS 配置与 HTTPS | [部署指南](docs/DEPLOYMENT.md) |
| 管理照片、调整相册、写便签与导出拼图 | [使用指南](docs/USAGE.md) |
| 代码结构、构建、测试与发布包 | [开发指南](docs/DEVELOPMENT.md) |

### 本地快速开始

需要 Node.js **24.x**、npm 和一个可用的 COS 私有桶。下面是 Bash 命令；Windows PowerShell 将 `cp` 换成 `Copy-Item` 即可。

```bash
git clone https://github.com/yangyv1016/photographer-portfolio.git
cd photographer-portfolio/deployment/tencent
npm ci
npm run build
cp .env.example .env
```

编辑 `.env`，把 `PUBLIC_ORIGIN` 设为 `http://127.0.0.1:8080`，填入自己的桶名、地域和最小权限凭据。应用自动读取当前工作目录的 `.env`。首次启动前，按[创建管理员](docs/DEPLOYMENT.md#创建本地管理员)配置账户，再执行：

```bash
npm start
```

打开 `http://127.0.0.1:8080/login`。外部访问必须使用 HTTPS，生产部署请继续阅读完整指南。

## 部署边界

应用以单个 Node.js 进程运行，SQLite 元数据留在服务器，照片原件保存在配置的私有桶，本地只缓存可重建的缩略图。当前标准发布包面向 **Ubuntu Linux x64 / glibc**；ARM64 需要单独适配发布依赖。`bootstrap.sh` 能安装 ARM64 Node，并不表示标准发布包支持 ARM64。

浏览器通过网站域名上传和读取照片，但是否产生 COS 公网流量费仍取决于服务器与桶之间的实际网络、地域及云产品计费规则；服务器对访客的下行流量也需要计入预算。[部署指南](docs/DEPLOYMENT.md#流量路径与费用核查)说明了核查方法。

仓库保留了原 Sites / Vinext / Cloudflare 适配代码。根目录的 `npm run build` 属于该构建链路，不会生成这里的独立 Node.js 服务。新部署请使用 `deployment/tencent/` 的命令。

## 许可与第三方内容

当前未添加项目统一代码许可证；第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。样例照片及第三方组件各自遵循原许可；公开代码不改变用户上传作品的权利归属。
