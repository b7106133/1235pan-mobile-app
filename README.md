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
暂不开放
- 账号密码/短信验证码/二维码扫码/官方 SSO 登录

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

---

## 原生层实现（Java）

### ⬇️ 自研流式下载引擎
- `MainActivity.DlTask` 自研下载任务表（`ConcurrentHashMap`），支持 **暂停 / 继续 / 重试 / 断点续传**
- 通过 `HttpURLConnection` 原生 HTTP 请求下载，突破 WebView 限制
- 下载完成后自动注册到 `MediaStore`（`ContentResolver`），可在系统相册/文件管理器直接打开
- 任务 ID 区间 `900000000+`，与上传任务区分

### 💾 下载持久化（App 被杀后恢复断点续传）
- 每次下载任务状态变更时调用 **`dlPersist()`**：将「下载中/已暂停」的任务序列化为 JSON 数组，写入 `SharedPreferences`
- 每个任务存储：`id`、`url`、`filename`、`expected`（期望大小）、`done`（已写字节）、`total`（总大小）、`uri`（MediaStore URI，断点续传复用）
- App 启动时调用 **`dlRestore()`**：从 SharedPreferences 读取 JSON，恢复 `DlTask` 对象，状态设为 **已暂停（status=2）**
- 用户点击「继续」即从 `Range: bytes=<done>-` 断点续传，失败自动回退从头重下
- 恢复后自动抬高 `nextTaskId` 游标，防止新任务 ID 冲突
- 无数据库依赖，仅 JSON + `SharedPreferences`，轻量可靠
- `DownloadManager` 备选下载通道

### ⬆️ 自研分片上传引擎
- `UploadManager` 单例管理队列，支持**多个上传任务并发（线程池限 2）**
- **大文件分片上传**：≥5MB 走 `multipart` 分片（服务端 `SliceSize` 默认 5MB）
- **失败自动回退**：分片初始化失败时 ≤64MB 的文件自动回退整包直传
- 支持 `ContentResolver` 读取 `content://` URI（文件选择器选中的只读 URI）
- 上传任务 ID 区间 `800000000+`，支持取消任务

### 🔌 NativeBridge JS 桥
- `NativeBridge` 通过 `@JavascriptInterface` 暴露给 WebView，打通 SPA 与原生能力
- 原生：HttpURLConnection → base64/JSON 回传 → JS 回调
- 支持 `uploadFileTask` / `uploadFiles` 两种上传桥
- 预览 URL 代理：`getPreviewUrl` 包装直链，携带认证头 + Range 支持
- SSO token 自动捕获：`tryCaptureSsoTokenFromMain` 拦截官方登录页回调

### 🧵 并发架构
- **文件去重线程池**：`FixedThreadPool(12)`，全盘查重时并发请求每个子目录
- **上传线程池**：`FixedThreadPool(2)`，限制并发防拖死网络
- **下载任务**：独立线程执行，`streamTaskFiles` / `streamTaskUris` 记录完成路径

### 🔄 跨盘模块（CrossPan）
- `CrossPan.java` + `crosspan.js` 双端配合，与 123 主流程解耦
- Cookie 管理：用户粘贴 + 服务端下发的链路 Cookie（`__sdid` / `__pugs`）
- 夸克/UC CDN 直链下载（独立线程，不占用主链路）
- 见上文「夸克下载说明」了解更多

### 📁 目录选择器（SAF）
- 自定义下载目录：通过 `Intent.ACTION_OPEN_DOCUMENT_TREE` 让用户任意选择目录
- 支持 Download 根、Download 子目录、甚至非 Download 目录（如 Movies/DCIM）
- 路径解析精确保留用户选择，存储到 `SharedPreferences`

---

## 与原版对比：本项目的增量实现

基于 [qq5855144/123pan-mobile-app v1.0.120](https://github.com/qq5855144/123pan-mobile-app) 分析，以下是本项目新增或彻底重写的功能：

### 🆕 全新 Java 模块（原版没有的类）

| 新增文件 | 功能 |
|---------|------|
| `CrossPan.java` + `crosspan.js` | 夸克/UC 跨盘模块：Cookie管理、CDN独立下载线程 |
| `DownloadService.java` | Android 前台保活 Service，后台下载不被系统杀死 |
| `UploadManager.java` | 独立上传管理器：队列管理、`UpSrc` 抽象（本地文件 / content:// URI 共用管线） |
| `UploadActivity.java` | 上传 Activity，原生端多文件/目录选择 |
| `appicons.js` | 全套 SVG 彩色文件图标素材（几十种文件类型） |

### ⬇️ 下载引擎强化（原版有基础版，我做的增量）

| 功能 | 原版 | 本项目 |
|------|:----:|:------:|
| 下载持久化 `dlPersist/dlRestore` | ❌ 无 | ✅ JSON→SharedPreferences，App 重启后恢复断点续传 |
| `Range` 断点续传 | ❌ 从头下 | ✅ `Range: bytes=<done>-`，失败自动回退 |
| 前台保活 `DownloadService` | ❌ 无 | ✅ 后台保活，系统不会杀下载进程 |
| 多级直链解析 `resolveRealDownloadUrl` | ❌ 无 | ✅ 递归解析 CDN 中转跳转 |
| 下载日志 `logDl/dlTrace` | ❌ 无 | ✅ 调试追踪 |
| 下载校验 `expectedSize` 字节完整性 | ❌ 无 | ✅ 写盘字节 < 期望时标记失败 |
| 下载完成 MediaStore 注册 | ❌ 无 | ✅ 文件管理器直接看到 |
| 流式下载 vs DownloadManager | DownloadManager 备选 | ✅ 双通道并存 |

### ⬆️ 上传引擎强化

| 功能 | 原版 | 本项目 |
|------|:----:|:------:|
| `UploadManager` 独立队列 | ❌ 内联在 MainActivity | ✅ 独立单例，生命周期管理 |
| `UpSrc` 抽象（content:// URI 直传） | ❌ 先复制到缓存 | ✅ ParcelFileDescriptor 直接读，不落盘 |
| 文件夹上传 SAF 递归遍历 | ❌ 无 | ✅ DocumentsContract API 递归扫描子目录 |
| 上传任务可取消 | ❌ 无 | ✅ UpTask.cancelled |
| 上传进度回调节流 | ❌ 无 | ✅ lastProgAt 控制频率 |

### 🔐 多账号
暂不开放

| 功能 | 原版 | 本项目 |
|------|:----:|:------:|

### 📱 设备信息

| 功能 | 原版 | 本项目 |
|------|:----:|:------:|
| deviceType | ❌ 硬编码 `"X12"` | ✅ 系统读取 `Build.MODEL` |
| osVersion | ❌ 硬编码 `"13"` | ✅ `Build.VERSION.RELEASE` |
| devicename | ❌ 硬编码 `"Xiaomi"` | ✅ `sysProp("ro.product.marketname")` 读取真实市场名 |

### 🖼️ 前端页面（原版没有的页面/模块）

| 页面/模块 | 说明 |
|-----------|------|
| 消息中心 | 站内通知管理，全部已读/刷新 |
| 会员中心 | 签到领容量、开通/续费 |
| 设备管理 | 查看在线设备列表 |
| 登录记录 | 历史登录记录 |
| 回收站 | 恢复/彻底删除/清空 |
| 接收分享 | 解析链接+提取码浏览并转存 |
| 离线下载 | 磁力/直链提交到云端离线下载 |
| 夸克下载说明 | 深链方式/Cookie方式使用指引 |
| 全盘文件搜索 | 搜索栏实时搜索 |

### 🌙 界面优化

| 功能 | 原版 | 本项目 |
|------|:----:|:------:|
| 白夜模式状态栏/导航栏同步 | ❌ 无 | ✅ `onConfigurationChanged` + JS `applyTheme` |
| 通知权限请求 (Android 13+) | ❌ 无 | ✅ 运行时权限 |
| SVG 图标库 | ❌ 少量内联 SVG | ✅ `appicons.js` 全套彩色素材 |
| app.js | 242KB | ✅ 521KB 大幅扩展 |
| index.html | 30KB | ✅ 136KB 大量新页面/弹窗 |
| style.css | 48KB | ✅ 96KB 完整主题 |
