# Node.js 自部署版本

此目录提供 Node.js 24 + SQLite 的独立运行时，照片存储可选择服务器本地磁盘或私有 COS / LHCOS，复用根目录的页面与交互代码。主部署方案使用 Ubuntu、Caddy 和 systemd；`tencent` 是历史目录名，本地存储不要求购买 COS 或使用腾讯云服务器。

| 版本 | 选择 | 配置模板 |
| --- | --- | --- |
| 本地存储 | `STORAGE_BACKEND=local`，数据位于 `DATA_DIRECTORY` | `.env.local.example` |
| COS 存储 | `STORAGE_BACKEND=cos`，原件位于所配置的私有桶 | `.env.cos.example` |

`.env.example` 默认是本地版。为兼容已有配置，不写 `STORAGE_BACKEND` 时仍为 COS；新部署请明确选择。两种模式使用同一个发布包，不会自动迁移已有原件。

- [项目介绍与本地启动](https://github.com/yangyv1016/photographer-portfolio/blob/main/README.md)
- [完整部署、更新、备份与恢复](https://github.com/yangyv1016/photographer-portfolio/blob/main/docs/DEPLOYMENT.md)
- [管理员与摄影师使用说明](https://github.com/yangyv1016/photographer-portfolio/blob/main/docs/USAGE.md)
- [开发与项目结构](https://github.com/yangyv1016/photographer-portfolio/blob/main/docs/DEVELOPMENT.md)

在仓库根目录执行：

```sh
npm ci --prefix deployment/tencent
npm run build --prefix deployment/tencent
npm test --prefix deployment/tencent
npm run release --prefix deployment/tencent
```

`app/` 和 `releases/` 是构建产物，请勿直接修改或提交。发布包默认用于 Linux x64 glibc；其他架构需调整打包参数并重新验证原生依赖。

部署时先从对应模板创建配置；生产 `DATA_DIRECTORY` 使用 `/var/lib/yangyu`，与服务权限、管理员初始化和备份脚本一致。本地版无需填写 COS 变量，原图及对象旁的 `.json` 元数据必须一起备份。COS 版还需替换 `cos-runtime-policy.json` 中的占位值并授予最小权限。

启用 HTTPS 前替换 `ubuntu/Caddyfile` 或 `ubuntu/Caddyfile.ip` 的域名或 IP。`portfolio.example.com`、`203.0.113.10`、`YOUR_BUCKET` 及策略中的尖括号字段均为占位符。实际配置位于仓库外的 `/etc/yangyu.env`，不要提交到 Git；不要把本地 `objects/` 或数据目录配置为公网静态文件目录。
