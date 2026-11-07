# 第三方素材与软件声明

本文件记录仓库自带素材和已随源码分发的软件声明。示例照片保留各自许可，不随项目代码统一重新授权。你上传的照片仍由其权利人决定使用许可。

## 示例照片

照片位于 `public/assets/`，作者、来源和许可也保存在 `db/sample-photos.ts`，在示例作品的来源信息中展示。

| 文件 | 作者 | 来源 | 许可 |
| --- | --- | --- | --- |
| `scene-01.jpg` | Lê Anh | [原图页面](https://unsplash.com/photos/a-couple-of-girls-holding-umbrellas-7KRFJkOl7Ms) | [Unsplash License](https://unsplash.com/license) |
| `scene-02.jpg` | Muhammad Faiz Zulkeflee | [原图页面](https://unsplash.com/photos/selective-focus-photography-of-cosplayer-qNCOVaOmzSo) | [Unsplash License](https://unsplash.com/license) |
| `scene-03.jpg` | Punto Fotográfico | [原图页面](https://unsplash.com/photos/a-man-in-a-costume-kneeling-down-next-to-a-blue-ball-6iSyC0E8XOQ) | [Unsplash License](https://unsplash.com/license) |
| `scene-04.jpg` | Guilhem Vellut | [Wikimedia Commons 原图页面](https://commons.wikimedia.org/wiki/File:Cosplay_@_Comiket_84_-_Summer_2013_@_Tokyo_Big_Sight_(9493104980).jpg) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)，页面展示时有裁切 |
| `editorial-01.jpg` | Hưng Nguyễn | [原图页面](https://unsplash.com/photos/woman-in-red-and-black-long-sleeve-dress-wearing-gray-hat-Of9qr_xjlUo) | [Unsplash License](https://unsplash.com/license) |
| `editorial-02.jpg` | Punto Fotográfico | [原图页面](https://unsplash.com/photos/a-man-in-a-costume-holding-two-swords-Ewt3Y-ItCw4) | [Unsplash License](https://unsplash.com/license) |
| `editorial-03.jpg` | Muhammad Faiz Zulkeflee | [原图页面](https://unsplash.com/photos/cosplayers-posing-on-a-brick-wall-lwmhYIFKJFQ) | [Unsplash License](https://unsplash.com/license) |
| `editorial-04.jpg` | Hưng Nguyễn | [原图页面](https://unsplash.com/photos/a-woman-with-long-blue-hair-is-posing-for-a-picture-pVW2XF7q3Lg) | [Unsplash License](https://unsplash.com/license) |

这些是演示素材，不代表仓库作者拍摄，也不授权对照片中的人物、角色或商标作额外使用。正式部署可换成自己有权发布的作品。

## 随源码分发的软件

- `public/github-mark.svg` 来自 GitHub Primer Octicons，MIT 许可和版权声明保存在 SVG 文件中。[原始图标](https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg)
- `build/sites-vite-plugin.ts`：原 MIT 许可及 OpenAI 版权声明保存在同目录的 `sites-vite-plugin.LICENSE`。
- `vendor/shadcn-tailwind-4.13.0.css`：原 MIT 许可及 shadcn 版权声明保存在同目录的 `shadcn-tailwind-4.13.0.LICENSE.md`。
- Node.js 自部署版会从锁定的 npm 依赖构建 Markdown bundle，并生成完整的 `app/public/vendor/note-markdown-vendor.LICENSE.txt`。
- 工作台便签导出使用本地打包的 `html-to-image`（MIT），完整许可随 `app/public/vendor/note-image-export.LICENSE.txt` 分发。
- 其他 npm 依赖遵循各包随附的许可，安装后可在 `node_modules` 内查看。发布包保留生产依赖原有的许可文件。

以上第三方声明应随相关素材或软件一并保留。
