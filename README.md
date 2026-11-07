# 摄影师作品展示

摄影师用邀请码注册，以站内用户名和密码登录工作台。每个账号独立管理自己的主页、相册、照片和 Markdown 便签。访客可以直接浏览公开作品。

## 部署

使用 Node.js 24 和 SQLite，可选择服务器本地磁盘或腾讯云私有 COS 存储原图。

| 存储方式 | 原图位置 | 配置模板 |
| --- | --- | --- |
| 本地磁盘 | 服务器的 `DATA_DIRECTORY/objects/` | [本地模板](deployment/tencent/.env.local.example) |
| COS 或轻量对象存储 | 所配置的私有桶 | [COS 模板](deployment/tencent/.env.cos.example) |

安装依赖并构建本地磁盘版。

```bash
git clone https://github.com/yangyv1016/photographer-portfolio.git
cd photographer-portfolio/deployment/tencent
npm ci
npm run build
cp .env.local.example .env
```

PowerShell 可用 `Copy-Item .env.local.example .env`。选择 COS 时，改用 COS 模板并填写桶名、地域和服务端凭据。

初始化管理员后运行 `npm start`，打开 [本地登录页](http://127.0.0.1:8080/login)。[初始化管理员](docs/DEPLOYMENT.md#创建本地管理员)

正式部署使用 Ubuntu、Caddy 和 systemd。域名、HTTPS、备份和更新步骤见 [部署指南](docs/DEPLOYMENT.md)。

## 使用

- 管理员在「兑换码」生成注册、续期或扩容码，在「账户管理」设置套餐、到期时间和基础容量。
- 摄影师在「作品管理」上传和整理照片，可下载自己的原图，也可以把多张拼图一次导出为 ZIP。
- 在「个人资料」编辑主页与展示设置，在「便签本」写 Markdown，在「订阅与容量」兑换订阅或扩容码。

[使用指南](docs/USAGE.md) · [订阅与扩容](docs/SUBSCRIPTIONS.md) · [开发指南](docs/DEVELOPMENT.md)

## 许可证

项目代码采用 MIT 许可证。复制或分发代码时，请保留版权和许可声明。[MIT 许可证](LICENSE)

样例照片和第三方组件各自适用原许可。[第三方内容说明](THIRD_PARTY_NOTICES.md)
