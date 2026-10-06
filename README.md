# 123pan-mobile-app

> ⚠️ **顶部提示 / 重要说明**
> 本项目为 123云盘第三方安卓客户端，基于 [qq5855144/123pan-mobile-app](https://github.com/qq5855144/123pan-mobile-app) 修改而来。
> 仅供学习研究使用，请勿用于任何违反法律法规的用途。

## 免责声明

1. 本项目是 **非官方** 的第三方客户端，与 123云盘官方无关。
2. 本项目仅供学习、研究和技术交流使用。
3. 使用者应自行承担使用本项目的所有风险和责任。
4. 本项目开发者不对使用本软件造成的任何直接或间接损失承担责任。
5. 请遵守当地法律法规，在下载后 24 小时内删除本软件及源代码。

## 参考项目

- [qq5855144/123pan-mobile-app](https://github.com/qq5855144/123pan-mobile-app) — 原始项目
- [sillycats/123pan-mobile-app](https://github.com/sillycats/123pan-mobile-app) — 参考实现

## 项目说明

123云盘移动端复刻应用，基于 **Android WebView 壳 + 内嵌 Web 前端** 架构。

### 技术路线

- **双端架构**：WebView 加载内置 `assets/` 前端（`index.html`/`style.css`/`app.js`），通过原生桥（`MainActivity#NativeBridge`）调用系统能力
- **认证**：原生层发起 HTTP 请求并附加 `authorization` 头；多账号凭证持久化，切换账号免重新登录
- **签名一致性**：开发/CI 共用同一正式 keystore，保证可覆盖安装

### 自动构建与发布

GitHub Actions 在每次 push/tag 时自动完成构建并用正式 keystore 签名。

### GitHub Secrets

| Secret | 说明 |
|--------|------|
| KEYSTORE_B64 | 正式 keystore 的 base64 内容 |
| KEYSTORE_PASS | keystore 密码（默认 123456） |
| KEYSTORE_ALIAS | keystore 别名（默认 pan） |

### 本地构建

```bash
export ANDROID_HOME=...   # 需 JDK17 + platform-34 + build-tools-34.0.0
ANDROID_KEYSTORE=/path/to/pan.keystore ANDROID_KEYSTORE_PASS=123456 \
ANDROID_KEYSTORE_ALIAS=pan ./scripts/build.sh
```

---

## 功能特性

### 📂 文件管理
- 文件浏览：面包屑导航、目录树、文件列表
- 全盘搜索（文件/文件夹实时搜索）
- 排序（按名称/大小/类型/修改时间）
- 多选整理模式：复制、剪切、删除、下载、移动
- 新建文件夹、重命名
- 文件去重（全盘并发查重）
- 回收站：恢复 / 彻底删除 / 清空所有

### 🔗 分享功能
- 创建分享：可设置有效期和提取码模式（无码/随机/自定义/直连）
- 我的分享管理、接收分享、分享链接复制

### ⬇️ 下载与传输
- 流式下载：支持暂停/继续/重试/断点续传
- 下载队列管理，实时进度显示
- 自定义下载目录（SAF 任意目录选择器）
- 批量下载

### ⬆️ 上传
- 文件上传（单文件/多文件/文件夹递归上传）
- 大文件分片上传（>=5MB 分片，失败自动回退）
- 上传队列管理：支持取消

### 🔐 多账号认证
- 账号密码/短信验证码/二维码扫码/官方 SSO 登录
- 多账号凭证持久化，切换免重新登录
- 多账号滑动快速切换

### 🖼️ 预览
- 图片/视频/音频预览（几十种格式）
- 文档预览：PDF、Word（docx）、Excel（xlsx/xls/csv）
- 文本/代码文件预览（原生桥代理，带认证头 + Range 支持）

### 📡 离线下载
- 磁力链接（magnet）、HTTP(S) 直链离线下载到云端

### 🔄 跨盘模块（夸克/UC）
- Cookie 管理，夸克/UC CDN 直链下载（独立线程）

### 👤 个人中心
- 账号管理、存储空间、会员中心（签到/续费）
- 消息中心、设备管理、登录记录
- 退出登录 / 注销账号

### 🌙 界面
- 白夜模式自适应、底部三栏导航
- 全盘文件搜索、SVG 彩色图标素材

### 🔄 夸克下载说明

夸克网盘支持两种下载方式：

**方式一：从网页端深链打开（推荐）**
1. 在夸克网页版点击「打开App」按钮
2. 在弹出的登录页面填写任意字符通过 Cookie 验证（深链自带分享 token，无需真实 Cookie）
3. 即可直接下载，无需从网页抓取 Cookie

**方式二：复制链接到 App 下载**
- 需要在夸克网页版（浏览器中登录后）获取**完整 Cookie**
- 包含必要的会话参数（如 `__sdid`、`__pugs` 等链路 Cookie）
- 否则服务端会返回 412 错误
