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

## 启用爱发电自动发货

买家付款后在本站 `/claim` 提交爱发电订单号，网站核验订单，再把兑换码私信发给原购买账号。Webhook 入口仅用于连通测试，提交订单号才会触发发货。

1. 在爱发电开发者后台取得创作者 `user_id` 和 API Token。若方案链接中带 `plan_id`，可从链接复制。也可用已有实付订单的 `query-order` 返回值取得 `plan_id`。用 `query-plan` 核对方案类型、周期或商品价格，扩容商品的规格 ID 取 `data.plan.skus[].sku_id`。[开发者后台](https://ifdian.net/dashboard/dev) · [API 签名和查单](https://guide.afdian.com/creator/developer) · [query-plan 和 send-msg 文档](https://ifdian.net/p/9c65d9cc617011ed81c352540025c377)

2. Ubuntu 生产部署编辑 `/etc/yangyu.env`，本地运行编辑 `deployment/tencent/.env`。填好以下六项基础配置。API Token 和发货密钥只保存在服务端的私密配置中，勿提交到 Git。

   ```dotenv
   AFDIAN_USER_ID=你的创作者user_id
   AFDIAN_API_TOKEN=你的API_Token
   AFDIAN_DELIVERY_KEY=64位十六进制随机密钥
   AFDIAN_MONTHLY_PLAN_ID=月卡方案plan_id
   AFDIAN_QUARTERLY_PLAN_ID=季卡方案plan_id
   AFDIAN_YEARLY_PLAN_ID=年卡方案plan_id
   ```

   首次配置用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成密钥。更新时保留原密钥，并将它与数据库分别安全备份，以便重试发送已生成的码。

   月卡、季卡、年卡分别对应爱发电 **1／3／12 个月**的独立订阅，每期实付 **¥8／¥20／¥88**，本站每期增加 **30／90／365 天**。

3. 启用扩容发货时，在同一个配置文件追加 `AFDIAN_STORAGE_ADDONS`。每个商品规格填一项，`priceCents` 是每件价格（分），`addOnBytes` 是每件增加的字节数。下例表示每件 ¥25、增加 5 GiB，使用前替换两个 ID。

   ```dotenv
   AFDIAN_STORAGE_ADDONS='[{"planId":"商品方案ID","skuId":"规格ID","priceCents":2500,"addOnBytes":5368709120}]'
   ```

4. Ubuntu 运行 `sudo systemctl restart yangyu`，本地停止进程并重新运行 `npm start`。打开你的网站 `/claim` 确认表单可用，也可访问 `/api/integrations/afdian/delivery/status`。`configured: true` 表示基础配置齐全，扩容配置及私信能否送达需用真实付款订单验证。

5. 把 `https://你的域名/claim` 放到爱发电的商品或方案说明、普通自动回复。改用领取链接的方案请关闭随机库存码，避免重复发货。买家取到订阅码后可到 `/register` 注册，已有账号在「订阅与容量」兑换。扩容码在登录后到「订阅与容量」兑换，订阅有效时使用扩容额度。

[发货校验、失败重试和 Webhook 测试说明](docs/SUBSCRIPTIONS.md#固定链接自助发货)

## 许可证

项目代码采用 MIT 许可证。复制或分发代码时，请保留版权和许可声明。[MIT 许可证](LICENSE)

样例照片和第三方组件各自适用原许可。[第三方内容说明](THIRD_PARTY_NOTICES.md)
