# lanhu-design-secure

一个面向 Codex、Claude Code 等 Agent Skills 客户端的蓝湖设计读取与增量同步 Skill。它能列出设计图、下载原图、提取同版本 HTML/CSS 规格与 Design Tokens，并导出 Web、iOS、Android 切图。

本项目基于 [`oyjt/lanhu-design` v1.3.0](https://github.com/oyjt/lanhu-design/tree/v1.3.0)（commit `51a3c3aadae636637047c91d872f2d13ee96d8b5`）加固，保留原项目 MIT 许可证和署名。本项目是社区项目，不是蓝湖官方产品。

## 与上游的主要区别

| 能力 | 本项目 |
|---|---|
| Cookie 隔离 | 只向精确白名单蓝湖 API 端点发送，资源/CDN 请求永不携带 Cookie |
| 网络防护 | CDN 主机白名单、HTTPS、逐跳重定向校验、DNS 公网校验与固定连接、私网/回环/保留地址阻断、超时与响应体限制 |
| 文件校验 | PNG/JPEG/GIF/WebP 完整解码与像素上限、默认拒绝 SVG、SHA-256、原子写入、拒绝静默覆盖 |
| 版本一致性 | 截图、Sketch JSON、DDS Schema、切图元数据绑定同一个版本 ID |
| 增量同步 | 版本化目录和 `lanhu-manifest.json`，按版本与文件哈希跳过未变化设计 |
| 无感认证 | 本机后台浏览器代理持续托管会话；首次/真正过期时登录，无需复制 Cookie |
| 凭据隔离 | 不导出 Cookie，不生成明文凭据文件；manifest 与规格不保存签名 URL |

## 安装

发布后可固定版本安装：

```bash
npx skills add Em22ma/lanhu-design-secure#v1.2.0
```

也可以克隆仓库后直接使用 `skills/lanhu-design-secure/`。

要求：Node.js 20.9+、Chrome（或受支持的 Edge channel）、网络访问权限，以及对目标蓝湖项目具有只读权限的账号。

## 首次登录：不复制 Cookie

先安装锁定版本的轻量浏览器控制库；它使用本机现有 Chrome，不下载另一个浏览器：

```bash
node skills/lanhu-design-secure/scripts/install_browser_runtime.mjs
```

随后直接运行任意蓝湖命令。第一次或会话真正失效时，会自动打开专用蓝湖窗口：你只需像平时一样登录，命令会自动继续。登录后窗口自动最小化，由本机后台代理继续托管会话，因此后续命令不会因为自身退出而丢失登录。无需打开开发者工具、复制 Cookie、设置环境变量或更新终端。

也可先单独验证登录：

```bash
node skills/lanhu-design-secure/scripts/lanhu_login.mjs "<lanhu-project-url>"
```

会话保存在 `~/.lanhu-design-secure/browser-profile` 的独立浏览器目录中；脚本不读取/导出 Cookie，也不会生成 `cookie.json`。后台代理只监听该私有目录中的本机 Socket（权限 `0600`），且只接受固定的只读蓝湖 API。不要把该目录指向日常 Chrome 用户目录。建议为自动化单独创建低权限、只读的蓝湖成员账号。

查看或停止后台会话（`starting` 表示正在启动，`busy` 表示正在等待登录或处理请求，`stopping` 表示正在安全关闭）：

```bash
node skills/lanhu-design-secure/scripts/lanhu_session.mjs status
node skills/lanhu-design-secure/scripts/lanhu_session.mjs stop
```

停止代理、退出系统或蓝湖会话真正过期后，下次命令会重新打开登录窗口。

`LANHU_AUTH_MODE=cookie` 仅保留给已经安全注入凭据的 CI/旧环境，日常使用不需要。

默认资源白名单支持 `lanhuapp.com` 子域名和阿里云 OSS `aliyuncs.com`。如果真实项目使用其他 CDN，先在本机确认域名，再通过 `LANHU_ASSET_HOSTS=精确主机名` 临时追加；不要填写宽泛的第三方域名后缀。

## 推荐：项目级增量同步

```bash
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

测试覆盖后台会话跨命令复用、登录/启动/请求/排队期间的安全停止、管理状态准确性、Socket 权限、Cookie 目的域隔离、重定向、DNS 卡死/取消/固定公网地址、IPv4/IPv6 特殊用途地址、全链路绝对超时、流式响应上限、位图完整解码与像素上限、OSS 通用 MIME 安全识别、SVG 拒绝、原子写、覆盖保护、版本固定、远程 URL 清除，以及增量同步跳过逻辑。

## 安全问题

请不要在公开 Issue 中粘贴蓝湖 Cookie、完整请求头、带签名的资源 URL 或私有设计内容。详见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)。上游版权归 oyjt 所有；修改部分按同一许可证发布。
