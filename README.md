# 123pan-mobile-app

> ⚠️ **顶部提示 / 重要说明**
> 本项目为 123云盘第三方安卓客户端，基于 [sillycats/123pan-mobile-app](https://github.com/sillycats/123pan-mobile-app) 进行二次开发。
> 仅供学习研究使用，请勿用于任何违反法律法规的用途。

## 免责声明

1. 本项目是 **非官方** 的第三方客户端，与 123云盘官方无关。
2. 本项目仅供学习、研究和技术交流使用。
3. 使用者应自行承担使用本项目的所有风险和责任。
4. 本项目开发者不对使用本软件造成的任何直接或间接损失承担责任。
5. 请遵守当地法律法规，在下载后 24 小时内删除本软件及源代码。
## 参考项目

- [qq5855144/123pan-mobile-app](https://github.com/qq5855144/123pan-mobile-app) — 原始项目

- [sillycats/123pan-mobile-app](https://github.com/sillycats/123pan-mobile-app) — 基于原始项目的二次开发（本项目的直接上游）

- **本项目的上游关系**：qq5855144/123pan-mobile-app → sillycats/123pan-mobile-app → 本项目

## 项目说明

123云盘移动端复刻应用，基于 **Android WebView 壳 + 内嵌 Web 前端** 架构。

### 技术路线

- **双端架构**：WebView 加载内置 `assets/` 前端（`index.html`/`style.css`/`app.js`），通过原生桥（`MainActivity#NativeBridge`）调用系统能力
- **认证**：原生层发起 HTTP 请求并附加 `authorization` 头；原生层发起 HTTP 请求并附加 authorization 头以保证认证
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
