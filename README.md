# lanhu-design-secure

一个面向 Codex、Claude Code 等 Agent Skills 客户端的蓝湖设计读取与增量同步 Skill。它能列出设计图、下载原图、提取同版本 HTML/CSS 规格与 Design Tokens，并导出 Web、iOS、Android 切图。

本项目基于 [`oyjt/lanhu-design` v1.3.0](https://github.com/oyjt/lanhu-design/tree/v1.3.0)（commit `51a3c3aadae636637047c91d872f2d13ee96d8b5`）加固，保留原项目 MIT 许可证和署名。本项目是社区项目，不是蓝湖官方产品。

## 与上游的主要区别

| 能力 | 本项目 |
|---|---|
| Cookie 隔离 | 只向精确白名单蓝湖 API 端点发送，资源/CDN 请求永不携带 Cookie |
| 网络防护 | CDN 主机白名单、HTTPS、逐跳重定向校验、私网/回环/保留地址阻断、超时与响应体限制 |
| 文件校验 | 图片类型校验、SHA-256、原子写入、默认拒绝静默覆盖 |
| 版本一致性 | 截图、Sketch JSON、DDS Schema、切图元数据绑定同一个版本 ID |
| 增量同步 | 版本化目录和 `lanhu-manifest.json`，按版本与文件哈希跳过未变化设计 |
| 凭据落盘 | manifest、规格和切图元数据不保存 Cookie 或远程签名下载 URL |

## 安装

发布后可固定版本安装：

```bash
npx skills add Em22ma/lanhu-design-secure#v1.0.0
```

也可以克隆仓库后直接使用 `skills/lanhu-design-secure/`。

要求：Node.js 20+、网络访问权限，以及对目标蓝湖项目具有只读权限的账号会话 Cookie。无运行时 npm 依赖。

## Cookie 安全

蓝湖没有公开 OAuth/API，此 Skill 必须使用浏览器会话 Cookie。建议为自动化单独创建低权限、只读的蓝湖成员账号。

不要把 Cookie 写进项目、`.env`、shell 启动文件、Agent 全局配置或聊天内容。推荐存入系统密钥链，并只注入当前命令。例如 macOS：

```bash
LANHU_COOKIE="$(security find-generic-password -a "$USER" -s lanhu-design-cookie -w)" \
  node skills/lanhu-design-secure/scripts/get_designs.mjs "<lanhu-project-url>"
```

脚本不会加载 `.env`，也不会输出 Cookie。HTTP 401/403 表示需要在本机更新会话。

默认资源白名单支持 `lanhuapp.com` 子域名和阿里云 OSS `aliyuncs.com`。如果真实项目使用其他 CDN，先在本机确认域名，再通过 `LANHU_ASSET_HOSTS=精确主机名` 临时追加；不要填写宽泛的第三方域名后缀。

## 推荐：项目级增量同步

```bash
LANHU_COOKIE="$(security find-generic-password -a "$USER" -s lanhu-design-cookie -w)" \
  node skills/lanhu-design-secure/scripts/sync_project.mjs \
  "https://lanhuapp.com/web/#/item/project/stage?tid=TEAM&pid=PROJECT" \
  --output /absolute/path/to/project/.lanhu \
  --designs all \
  --scale 2x
```

第一次运行会下载设计原图、规格和切图，并生成 `lanhu-manifest.json`。后续运行先解析最新版本并校验本地 SHA-256；版本和文件都未变化时直接跳过。不同版本保存在独立目录，旧版本不会被自动删除。

建议把 `.lanhu/` 加入业务项目的 `.gitignore`，除非团队明确希望提交生成的设计档案。

## 单项命令

```bash
# 列出设计图
node skills/lanhu-design-secure/scripts/get_designs.mjs "<url>"

# 下载设计原图
node skills/lanhu-design-secure/scripts/download_design_images.mjs \
  "<url>" --designs "1,2" --output ./designs

# 获取同版本规格并下载 HTML 引用图片
node skills/lanhu-design-secure/scripts/get_design_specs.mjs \
  "<url>" --design "首页" --output ./specs --download-images

# 获取切图元数据
node skills/lanhu-design-secure/scripts/get_design_slices.mjs \
  "<url>" --design "首页" > slices.json

# 下载真实 Web 2x 切图
node skills/lanhu-design-secure/scripts/download_slices.mjs \
  slices.json --output ./src/assets --scale 2x
```

历史设计可对单个设计传入 `--version-id <id>`。不同内容默认不会覆盖；只有明确需要修复或替换时才使用 `--force`。

## 开发与验证

```bash
npm run validate
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  skills/lanhu-design-secure
```

测试覆盖 Cookie 目的域隔离、重定向、私网地址、体积/图片校验、原子写、覆盖保护、版本固定、远程 URL 清除，以及增量同步跳过逻辑。

## 安全问题

请不要在公开 Issue 中粘贴蓝湖 Cookie、完整请求头、带签名的资源 URL 或私有设计内容。详见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)。上游版权归 oyjt 所有；修改部分按同一许可证发布。
