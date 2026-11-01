# Node.js 自部署版本

此目录提供 Node.js 24 + SQLite + 私有 COS 的运行时，复用根目录的页面与交互代码。主部署方案使用 Ubuntu、Caddy 和 systemd。

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

部署前必须替换 `.env.example`、`cos-runtime-policy.json`、`ubuntu/Caddyfile` 或 `ubuntu/Caddyfile.ip` 中的示例值。域名 `portfolio.example.com`、IP `203.0.113.10`、`YOUR_BUCKET` 及策略中的尖括号字段均为占位符。真实凭据存放在仓库外的 `/etc/yangyu.env`，不要提交到 Git。
