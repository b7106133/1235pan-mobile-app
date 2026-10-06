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
