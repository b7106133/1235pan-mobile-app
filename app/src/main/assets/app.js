/* 123云盘移动端 SPA 逻辑
 * 通过 NativeBridge 调用原生网络层（复刻 123pan-open API）
 * 底部导航：文件 / 传输 / 我的
 * 底部工具栏：默认隐藏，长按底部"文件"tab显示，点击上传/新建后隐藏
 * 文件夹：点击进入，长按弹出菜单
 * 文件：点击弹出菜单
 * 底部"文件"tab双击回到主目录（无提示）
 * 全局禁用长按选择文字
 * 搜索栏和面包屑固定，仅文件列表滚动
 * 多账号滑动切换
 * 传输页支持下载/上传切换
 * 支持多选（整理）模式
 * 图片/视频/音频点击直接预览
 * 文本文件点击图标预览（只读，不可编辑）
 */
 
(function () {
  'use strict';

  var bridge = window.NativeBridge;

  // ================= 1.7.3 适配层（编译适配 123pan-mobile 1.7.3） =================
  // 本地上传任务（字符串 id）与原生上传任务（数字 id）映射
  var _uploadNativeMap = {};   // nativeTaskId -> localTaskId
  var _uploadNativeRev = {};   // localTaskId -> nativeTaskId
  // 统一上传入口：优先 1.7.3 的 uploadFileTask（队列+进度+结果回调），回退旧 uploadFiles
  function nativeUploadStart(localTaskId, path, dirId) {
    if (!bridge || !path) return false;
    try {
      if (bridge.uploadFileTask) {
        var nid = Number(bridge.uploadFileTask(String(path), Number(dirId) || 0));
        if (nid && nid > 0) {
          _uploadNativeMap[nid] = localTaskId;
          _uploadNativeRev[localTaskId] = nid;
          return true;
        }
        return false;
      }
      if (bridge.uploadFiles) {
        bridge.uploadFiles(String(path), Number(dirId) || 0, '_cb_upload_' + localTaskId);
        return true;
      }
    } catch (e) {}
    return false;
  }
  // ===============================================================================

  // —— 预览统一出口：把下载直链包装成原生本地代理 URL（带认证头 + 支持 Range；失败回退原链接）——
  function previewSrc(url) {
    try {
      var s = String(url == null ? '' : url);
      if (s && bridge && bridge.getPreviewUrl && s.indexOf('http') === 0) {
        var p = bridge.getPreviewUrl(s);
        if (p) return p;
      }
    } catch (e) {}
    return url;
  }
  var state = {
    token: '',
    user: '',
    view: 'files',
    currentDir: 0,
    breadcrumb: [],
    currentItem: null,
    shareItem: null,
    confirmOk: null,
    qrTimer: null,
    qrUniID: '',
    qrTimeout: null,
    qrPaused: false,
    qrExpired: false,
    transfers: loadTransfers(),
    progTimer: null,
    searching: false,
    searchKeyword: '',
    searchTotal: 0,
    selectMode: false,
    selectedMap: {},
    pickerState: null,
    lastList: [],          // 最近一次渲染的列表（供全选）
    dirInView: '0',        // 当前列表对应的目录（滚动位置记忆用）
    keepScroll: false,     // 复制/移动等原地操作：重新加载后不回到顶部
    uploadTargetDir: null  // 本次上传的目标目录：整批完成后只刷新该目录
  };

  var API = {
    list: 'https://api.123pan.cn/b/api/file/list/new',
    rename: 'https://api.123pan.cn/a/api/file/rename',
    trash: 'https://api.123pan.cn/a/api/file/trash',
    trashDeleteAll: 'https://api.123pan.cn/a/api/file/trash_delete_all',
    trashDelete: 'https://api.123pan.cn/a/api/file/delete',
    download: 'https://api.123pan.cn/a/api/file/download_info',
    batchDownload: 'https://api.123pan.cn/a/api/file/batch_download_info',
    mkdir: 'https://api.123pan.cn/b/api/file/upload_request',
    userInfo: 'https://api.123pan.cn/b/api/user/info',
    shareCreate: 'https://api.123pan.cn/a/api/share/create',
    move: 'https://api.123pan.cn/b/api/file/mod_pid',
    signIn: 'https://login.123pan.com/b/api/user/sign_in',
    qrGenerate: 'https://login.123pan.com/api/user/qr-code/generate',
    qrResult: 'https://login.123pan.com/api/user/qr-code/result',
    uploadComplete: 'https://api.123pan.cn/a/api/file/upload_complete',
    // 验证码（短信）登录接口：官方 obtainVCode=/api/user/get_vcode；sign_in type:3 = 验证码登录
    getVcode: 'https://user.123pan.cn/api/user/get_vcode',
    vcodeSignIn: 'https://login.123pan.com/b/api/user/sign_in'
  };

  var RECYCLE_EVENT = {
    restore: 'recycleRestore',
    clear: 'recycleClear',
    deleteP: 'recycleDelete'
  };

  var transferTab = 'download';

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtSize(b) {
    if (b == null) return '';
    b = Number(b);
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function numOf(obj) {
    for (var i = 1; i < arguments.length; i++) {
      var v = obj && obj[arguments[i]];
      if (v != null) {
        var n = Number(v);
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return 0;
  }
  function iconFor(item) {
    if (item && (item.Type === 1 || item.Type === '1')) return 'foler';
    return iconForName(item && (item.FileName || item.fileName));
  }
  // ---------- 预览支持的扩展名（集中定义，全应用共用） ----------
  function extSet(arr) { var o = {}; for (var i = 0; i < arr.length; i++) o[arr[i]] = 1; return o; }
  var EXT_IMAGE = extSet([
    'jpg','jpeg','jpe','jfif','pjpeg','png','apng','gif','bmp','webp','heic','heif','avif','svg','ico',
    'tif','tiff','raw','psd','dng','cr2','nef','arw','orf','rw2','xbm','xpm','jxl','wbmp'
  ]);
  var EXT_VIDEO = extSet([
    'mp4','m4v','mkv','avi','mov','qt','wmv','flv','f4v','webm','rm','rmvb','asf','3gp','3gpp','3g2',
    'mpg','mpeg','mpe','mp2v','mpv','m2v','m1v','mts','m2ts','ts','vob','ogv','divx','xvid','amv',
    'mxf','dv','wtv','yuv','m3u8','iso','tsv'
  ]);
  var EXT_AUDIO = extSet([
    'mp3','mp2','mpga','wav','flac','aac','ogg','oga','opus','m4a','m4b','m4p','ape','wma','amr','awb',
    'mid','midi','aiff','aif','aifc','ac3','eac3','dts','mka','ra','ram','au','snd','caf','weba','wv',
    'tta','spx','gsm','3ga','m3u'
  ]);
  var EXT_TEXT = extSet([
    'txt','log','md','markdown','ini','conf','config','cfg','csv','tsv','yaml','yml','toml','sql',
    'json','jsonc','json5','xml','html','htm','xhtml','css','scss','less','sass','styl',
    'js','mjs','cjs','jsx','ts','tsx','vue','svelte','astro','py','pyw','java','kt','kts','scala',
    'groovy','gradle','c','h','cc','cpp','cxx','hpp','hxx','cs','go','rs','swift','m','mm','rb','pl','pm',
    'php','lua','r','dart','sh','bash','zsh','fish','bat','cmd','ps1','vbs','asm','s','diff','patch',
    'properties','env','makefile','cmake','srt','vtt','ass','ssa','sub','tex','rst','adoc','org',
    'graphql','gql','proto','thrift','nfo','lst','text','po','pot','reg'
  ]);
  function extOf(fname) { return String(fname || '').split('.').pop().toLowerCase(); }
  function isImgExt(f) { return !!EXT_IMAGE[extOf(f)]; }
  function isVidExt(f) { return !!EXT_VIDEO[extOf(f)]; }
  function isAudExt(f) { return !!EXT_AUDIO[extOf(f)]; }
  function isTxtExt(f) { return !!EXT_TEXT[extOf(f)]; }
  // 文档类预览（PDF / Word / Excel）
  var EXT_DOC = extSet(['docx']);
  var EXT_XLS = extSet(['xlsx', 'xls', 'csv']);
  var EXT_PDF = extSet(['pdf']);
  function isDocExt(f) { return !!EXT_DOC[extOf(f)]; }
  function isXlsExt(f) { return !!EXT_XLS[extOf(f)]; }
  function isPdfExt(f) { return !!EXT_PDF[extOf(f)]; }

  function iconForName(fname) {
    var ext = (fname || '').split('.').pop().toLowerCase();
    // 返回 appicons.js 的图标键名（官方彩色素材）；素材缺失时由 applySvg 统一回退
    if (EXT_IMAGE[ext]) return 'image_file';
    if (EXT_VIDEO[ext]) return 'video_file';
    if (EXT_AUDIO[ext]) return 'audio_file';
    if (ext === 'apk') return 'apk_file';
    if (ext === 'ipa') return 'ipa_file';
    if (ext === 'zip') return 'zip_file';
    if (ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz' || ext === 'tgz' || ext === 'bz2' || ext === 'xz' || ext === 'cab') return 'compressed_package';
    if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'excel_file';
    if (ext === 'doc' || ext === 'docx' || ext === 'rtf' || ext === 'odt') return 'word_file';
    if (ext === 'ppt' || ext === 'pptx' || ext === 'odp') return 'ppt_file';
    if (ext === 'pdf') return 'pdf_file';
    if (ext === 'key') return 'keynote_file';
    if (ext === 'numbers') return 'numbers_file';
    if (ext === 'pages') return 'pages_file';
    if (ext === 'psd') return 'psd_file';
    if (ext === 'ai') return 'ai_file';
    if (ext === 'ae') return 'ae_file';
    if (ext === 'eps') return 'eps_file';
    if (ext === 'ttf' || ext === 'otf' || ext === 'ttc' || ext === 'woff' || ext === 'woff2') return 'font_file';
    if (ext === 'exe' || ext === 'msi' || ext === 'dmg' || ext === 'pkg' || ext === 'deb' || ext === 'rpm') return 'exe_file';
    if (ext === 'swf' || ext === 'fla') return 'flash_file';
    if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html_file';
    if (ext === 'txt' || ext === 'log' || ext === 'md' || ext === 'ini' || ext === 'conf' || ext === 'cfg' || ext === 'srt' || ext === 'vtt') return 'txt_file';
    if (ext === 'js' || ext === 'mjs' || ext === 'json' || ext === 'css' || ext === 'java' || ext === 'py' || ext === 'xml' || ext === 'sh' || ext === 'go' || ext === 'rs' || ext === 'c' || ext === 'cpp' || ext === 'h' || ext === 'hpp' || ext === 'yaml' || ext === 'yml' || ext === 'toml' || ext === 'sql' || ext === 'r' || ext === 'swift' || ext === 'kt' || ext === 'rb' || ext === 'pl' || ext === 'lua' || ext === 'ts' || ext === 'tsx' || ext === 'jsx' || ext === 'vue' || ext === 'svelte' || ext === 'scss' || ext === 'less' || ext === 'sass') return 'txt_file';
    return 'unknown_file';
  }

  // 获取文件扩展名
  function getFileExtension(filename) {
    if (!filename) return '';
    var parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  var ICON_SVG = {
    upload: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 3v12M7 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'folder-plus': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2zM12 11v6M9 14h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    'arrow-down': '<path d="M12 3v12M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    download: '<path d="M12 3v12M6 11l6 6 6-6M4 21h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    rename: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6zM10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    hdd: '<path d="M3 13v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3M3 13l2.5-7A2 2 0 0 1 7.4 5h9.2a2 2 0 0 1 1.9 1.4L21 13M3 13h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    info: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v6h6M8 13h8M8 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="M21 15l-5-5L5 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    video: '<rect x="2" y="6" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 10l6-4v12l-6-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    audio: '<path d="M9 18V5l12-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="2"/>',
    archive: '<path d="M21 8l-9-5-9 5 9 5 9-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 8v8l9 5 9-5V8M12 13v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M3 15h18M9 3v18" fill="none" stroke="currentColor" stroke-width="2"/>',
    text: '<path d="M4 6V4h16v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    apk: '<circle cx="5.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><path d="M6.5 7h11a4 4 0 0 1 4 4v4.5a3 3 0 0 1-3 3H5.5a3 3 0 0 1-3-3V11a4 4 0 0 1 4-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M7.7 6V3.8M16.3 6V3.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    search: '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    'x-circle': '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    'folder-move': '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 13h6M11 10l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M17 21v-8H7v8M7 3v5h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v6h6M10 12h4M10 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    broom: '<path d="M20 4l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13 11l-9 9 8-3.5L17 11z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="M8 15l2.5 2.5M10.5 12.5l2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    dedupe: '<rect x="8" y="3" width="13" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 21H5a2 2 0 0 1-2-2V8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 9.5l2 2 3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    sort: '<path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    vip: '<path d="M3 8.5l4.6 3.2L12 4.5l4.4 7.2L21 8.5l-1.6 10.5H4.6L3 8.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 15.5h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    theme: '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.6 6.6 0 0 0 10.8 10.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    dlink: '<path d="M9 15l6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.5 7.5l1.8-1.8a3.8 3.8 0 0 1 5.4 5.4l-1.8 1.8M13.5 16.5l-1.8 1.8a3.8 3.8 0 0 1-5.4-5.4l1.8-1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  };

  // ---------- 文件类型 / VIP 官方图标（素材见 assets/appicons.js；命中 APP_ICONS 时优先） ----------
  var _appIconUrlCache = {};
  function appIconUrl(key) {
    if (_appIconUrlCache[key] === undefined) {
      var _svg = (window.APP_ICONS && window.APP_ICONS[key]) || '';
      _appIconUrlCache[key] = _svg ? ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(_svg)) : '';
    }
    return _appIconUrlCache[key];
  }
  function applyAppIcon(el, key) {
    var url = appIconUrl(key);
    if (!url) return false;
    el.innerHTML = '<img class="app-ic" alt="" src="' + url + '">';
    return true;
  }
  // VIP / SVIP 标志：会员显示彩色标志（年费=SVIP），普通用户置灰
  function vipLogoKey() {
    return ((state.profile && state.profile.vipKind) === 'svip') ? '年费svip' : '普通vip';
  }
  function vipLogoImgHtml(gray) {
    var url = appIconUrl(vipLogoKey());
    if (!url) return '';
    return '<img class="app-ic vip-ic' + (gray ? ' vip-gray' : '') + '" alt="" src="' + url + '">';
  }
  // 预览浮层是否使用夜间配色（打开预览时取一次）
  function pvDark() { try { return isSystemDark(); } catch (e) { return false; } }
  function applySvg(el, name) {
    // 新素材（文件/文件夹类型图标、VIP 标志）：命中 APP_ICONS 时优先使用
    if (window.APP_ICONS && window.APP_ICONS[name] && applyAppIcon(el, name)) return;
    var inner = ICON_SVG[name];
    if (!inner) {
      // 未收录的文件类型 → 统一回退官方 unknown 图标；再不行回退内置 doc 线条图标
      if (window.APP_ICONS && window.APP_ICONS['unknown_file'] && applyAppIcon(el, 'unknown_file')) return;
      inner = ICON_SVG['doc'] || '';
    }
    el.innerHTML = inner ? ('<svg viewBox="0 0 24 24" aria-hidden="true">' + inner + '</svg>') : '';
  }

  function injectIcons(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach(function (el) {
      var name = el.getAttribute('data-icon');
      applySvg(el, name);
    });
  }

  function makeIcon(name, cls) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.setAttribute('data-icon', name);
    applySvg(s, name);
    return s;
  }

  // ---------- 上传任务管理 ----------
  // 上传列表：内存缓存 + 节流写盘（文件夹几百个文件时，逐条写 localStorage 会卡死主线程）
  var _upList = null;
  var _upSaveT = null;
  function loadUploadTransfers() {
    if (_upList) return _upList;
    try { _upList = curAccountEntry().entry.uploads || []; } catch (e) { _upList = []; }
    return _upList;
  }
  function saveUploadTransfers(list) {
    _upList = list || [];
    if (_upSaveT) return;
    _upSaveT = setTimeout(function () {
      _upSaveT = null;
      try {
        var ce = curAccountEntry();
        ce.entry.uploads = _upList || [];
        saveAccounts(ce.list);
      } catch (e) {}
    }, 1000);
  }

  function addUploadTask(task) {
    var list = loadUploadTransfers();
    
    var existIndex = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === task.id) {
        existIndex = i;
        break;
      }
    }
    
    if (existIndex === -1) {
      for (var j = 0; j < list.length; j++) {
        if (list[j].name === task.name && (list[j].status === 'uploading' || list[j].status === 'waiting')) {
          console.log('已存在上传任务:', task.name);
          return null;
        }
      }
    }
    
    var newTask = {
      id: task.id || Date.now(),
      name: task.name || '',
      size: task.size || 0,
      status: task.status || 'uploading',
      done: task.done || 0,
      total: task.total || task.size || 0,
      acct: acctKeySuffix(),
      groupId: task.groupId || '',
      groupName: task.groupName || '',
      groupTotal: task.groupTotal || 0,
      time: Date.now(),
      speed: 0,
      lastDone: 0,
      lastTime: Date.now()
    };
    if (existIndex >= 0) {
      list[existIndex] = newTask;
    } else {
      list.unshift(newTask);
    }
    saveUploadTransfers(list);
    markUploadRowDirty(newTask.id);
    renderTransfersThrottled();
    return newTask;
  }

  function updateUploadProgress(id, done, total, status) {
    var list = loadUploadTransfers();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id || list[i].name === id) {
        var now = Date.now();
        if (list[i].lastDone > 0 && done > list[i].lastDone) {
          var deltaTime = (now - (list[i].lastTime || now)) / 1000;
          var deltaBytes = done - list[i].lastDone;
          if (deltaTime > 0 && deltaBytes > 0) {
            list[i].speed = deltaBytes / deltaTime;
          }
        }
        list[i].done = done;
        if (total) list[i].total = total;
        list[i].lastDone = done;
        list[i].lastTime = now;
        if (status) list[i].status = status;
        if (list[i].total > 0 && list[i].done >= list[i].total) {
          list[i].status = 'completed';
          list[i].speed = 0;
        }
        markUploadRowDirty(list[i].id);
        saveUploadTransfers(list);
        renderTransfersThrottled();
        return;
      }
    }
  }

  function completeUploadTask(name, size) {
    var list = loadUploadTransfers();
    var found = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) {
        list[i].status = 'completed';
        list[i].done = size || list[i].total || list[i].size;
        list[i].total = size || list[i].total || list[i].size;
        list[i].speed = 0;
        list[i].lastDone = list[i].done;
        markUploadRowDirty(list[i].id);
        found = true;
        break;
      }
    }
    if (!found) {
      addUploadTask({
        id: Date.now(),
        name: name,
        size: size || 0,
        status: 'completed',
        done: size || 0,
        total: size || 0
      });
    } else {
      saveUploadTransfers(list);
    }
    renderTransfersThrottled();
  }

  // ---------- 多账号管理（移植自 123.apk「我的页 - 账号管理」） ----------
  // 折叠区只显示【当前账号 + 展开按钮】；点开为覆盖式底部弹层，只列其他账号 + 末尾「添加账号」。
  var ACCT_KEY = 'pan_accounts';
  var ACCT_CUR = 'pan_current_user';
  var pendingAddAccount = false;   // 「添加账号」后走 9.8 自带登录页，登录成功后自动入列表

  function loadAccounts() {
    try {
      var arr = JSON.parse(localStorage.getItem(ACCT_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveAccounts(list) {
    try { localStorage.setItem(ACCT_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function curAccountEntry() {
    var list = loadAccounts();
    var u = state.user || (list.length && list[0] && list[0].user) || '';
    for (var i = 0; i < list.length; i++) {
      if (list[i].user === u) {
        if (!Array.isArray(list[i].downloads)) list[i].downloads = [];
        if (!Array.isArray(list[i].uploads)) list[i].uploads = [];
        return { entry: list[i], list: list };
      }
    }
    var entry = { user: u, token: state.token || '', pass: '', downloads: [], uploads: [] };
    list.unshift(entry);
    saveAccounts(list);
    return { entry: entry, list: list };
  }
  // 在所有账号里定位某下载/上传任务的归属（切账号后不被其它账号的轮询/回调带偏）
  function findDownloadOwnerById(tid) {
    try {
      var list = loadAccounts();
      for (var i = 0; i < list.length; i++) {
        var dl = list[i].downloads || [];
        for (var j = 0; j < dl.length; j++) {
          if (String(dl[j].id) === String(tid)) return { list: list, entry: list[i], user: list[i].user };
        }
      }
    } catch (e) {}
    return null;
  }
  function findUploadOwnerById(tid) {
    try {
      var list = loadAccounts();
      for (var i = 0; i < list.length; i++) {
        var ul = list[i].uploads || [];
        for (var j = 0; j < ul.length; j++) {
          if (String(ul[j].id) === String(tid)) return { list: list, entry: list[i], user: list[i].user };
        }
      }
    } catch (e) {}
    return null;
  }
  function currentAccountUser() {
    try { return localStorage.getItem(ACCT_CUR) || ''; } catch (e) { return ''; }
  }
  function setCurrentAccountUser(u) {
    try { localStorage.setItem(ACCT_CUR, u || ''); } catch (e) {}
  }
  // 登录成功后加入账号列表（去重），并设为当前账号
  function addAccount(user, token, pass) {
    if (!user) return;
    var list = loadAccounts();
    var exists = false;
    list.forEach(function (a) {
      if (a.user === user) { a.token = token; a.pass = pass || a.pass; exists = true; }
    });
    if (!exists) list.unshift({ user: user, token: token, pass: pass || '', downloads: [], uploads: [] });
    saveAccounts(list);
    setCurrentAccountUser(user);
  }
  // 账号切换专用：清空上一个账号的残留数据（资料/预览缓存/会话文本等）+ 预热新账号资料
  function resetForAccountSwitch() {
    try { _upList = null; } catch (e) {}
    state.profile = {};
    state.profileAt = 0;
    state.txtSaved = {};
    state.dirSnap = {};
    state.lastList = [];
    state.selectedMap = {};
    state.keepScroll = false;
    state.searching = false;
    state.searchKeyword = '';
    state.currentDir = 0;
    state.breadcrumb = [];
    state.transfers = loadTransfers();
    try { state.uploads = loadUploadTransfers(); } catch (e) {}
    // 切换账号：立即按新账号重建下载/上传列表（清 DOM 缓存，避免需要多次切换才刷新）
    try {
      var _dl0 = $('download-list');
      if (_dl0) { _dl0._initialized = false; _dl0._sig = ''; _dl0._rowIds = null; _dl0._dirty = null; }
      var _ul0 = $('upload-list');
      if (_ul0) { _ul0._initialized = false; _ul0._sig = ''; _ul0._rowIds = null; _ul0._dirty = null; }
    } catch (e) {}
    state.pfinfo = null;
    try { OFFLINE_DONE_STATE.list = []; OFFLINE_DONE_STATE.loaded = false; } catch (e) {}
    try { cacheClear(); } catch (e) {}   // 清直链 + 图片内容缓存（避免显示上一个账号的图片/链接）
    try { clearAvatarCache(); } catch (e) {}   // 切换账号：移除头像缓存，进入后重新拉取
    try { renderAccountList(); } catch (e) {}
    try { fetchUserProfile(function () { try { renderAccountList(); } catch (e) {} }); } catch (e) {}
  }
  // 切换账号：直接用本地已保存的 token 切换，无需重新登录
  function switchAccount(user) {
    if (user === state.user) { toast('已是当前账号'); return; }
    var list = loadAccounts();
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].user === user) { target = list[i]; break; }
    }
    if (!target || !target.token) {
      toast('该账号缺少本地凭证，请重新登录');
      try { localStorage.setItem(ACCT_CUR, ''); } catch (e) {}
      pendingAddAccount = true;
      switchToLogin();
      return;
    }
    state.token = target.token;
    state.user = target.user;
    setCurrentAccountUser(user);
    try { if (bridge && bridge.saveSession) bridge.saveSession(target.token, user, target.pass || ''); } catch (e) {}
    resetForAccountSwitch();
    toast('已切换到「' + user + '」');
    enterMain();
    var fileList = $('file-list');
    if (fileList) fileList.dataset.loaded = '';
    loadList();
    refreshAfterSwitch();
  }
  function refreshAfterSwitch() {
    try { state.uploads = loadUploadTransfers(); } catch (e) {}
    try { renderTransfers(); } catch (e) {}
    try { if (transferTab === 'offline') { OFFLINE_DONE_STATE.loaded = false; loadOfflineDone(true); } } catch (e) {}
    try { refreshNoticeBadge(); } catch (e) {}
    try { updateMineVipRow(); } catch (e) {}
  }
  // 删除账号
  function removeAccount(user) {
    var list = loadAccounts().filter(function (a) { return a.user !== user; });
    saveAccounts(list);
    var cur = currentAccountUser();
    if (cur === user) {
      setCurrentAccountUser('');
      if (list.length > 0) {
        var next = list[0];
        state.token = next.token;
        state.user = next.user;
        setCurrentAccountUser(next.user);
        try { if (bridge && bridge.saveSession) bridge.saveSession(next.token, next.user, next.pass || ''); } catch (e) {}
        resetForAccountSwitch();
        toast('已删除账号「' + user + '」，已切到「' + next.user + '」');
        enterMain();
        loadList();
        refreshAfterSwitch();
        if (state.view === 'mine') loadMine();
        return;
      }
      // 没有其它账号：清会话回登录页
      if (bridge && bridge.logout) { try { bridge.logout(); } catch (e) {} }
      else if (bridge && bridge.clearSession) { try { bridge.clearSession(); } catch (e) {} }
      state.token = '';
      state.user = '';
      pendingAddAccount = false;
      toast('账号已删除');
      switchToLogin();
      return;
    }
    toast('账号已删除');
    if (state.view === 'mine') loadMine();
  }
  // ---- 账号头像本地缓存（避免每次进 App 都重新拉取；仅切换账号时清除） ----
  var AVATAR_CACHE_KEY = 'pan_avatar_cache';
  function loadAvatarCache(user) {
    try {
      var m = JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || '{}');
      return (user && m[user]) || '';
    } catch (e) { return ''; }
  }
  function saveAvatarCache(user, head) {
    if (!user || !head) return;
    try {
      var m = JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || '{}');
      if (m[user] === head) return;
      m[user] = head;
      localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(m));
    } catch (e) {}
  }
  function clearAvatarCache() {
    try { localStorage.removeItem(AVATAR_CACHE_KEY); } catch (e) {}
  }
  // 保存某账号的展示资料（供「未切换账号」列表使用）
  function saveAccountProfile(user, head, isVip, vipKind) {
    if (!user) return;
    try {
      var list = loadAccounts();
      var hit = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].user === user) {
          if (head && list[i].head !== head) { list[i].head = head; hit = true; }
          var vk = isVip ? (vipKind || 'vip') : '';
          if (list[i].isVip !== !!isVip || list[i].vipKind !== vk) { list[i].isVip = !!isVip; list[i].vipKind = vk; hit = true; }
          break;
        }
      }
      if (hit) saveAccounts(list);
    } catch (e) {}
  }
  function acctAvatarHtml(acct, letter) {
    var head = (acct && acct.head) ? String(acct.head) : '';
    if (head && !/^https?:\/\//i.test(head) && !/^data:/i.test(head)) {
      head = (head.charAt(0) === '/') ? ('https://www.123pan.com' + head) : ('https://' + head);
    }
    var l = esc(letter || '');
    return head
      ? ('<img class=\"acct-av-img\" alt=\"\" src=\"' + esc(head) + '\" onerror=\"this.style.display=\'none\';this.parentNode.classList.add(\'av-fallback\')\"><span class=\"acct-av-letter\">' + l + '</span>')
      : ('<span class=\"acct-av-letter\">' + l + '</span>');
  }
  function acctVipHtml(acct) {
    var isVip = !!(acct && acct.isVip);
    var kind = (acct && acct.vipKind === 'svip') ? '\u5e74\u8d39svip' : '\u666e\u901avip';
    var url = (typeof appIconUrl === 'function') ? appIconUrl(kind) : '';
    if (!url) return '';
    return '&nbsp;&nbsp;<img class=\"app-ic vip-ic' + (isVip ? '' : ' vip-gray') + '\" alt=\"\" src=\"' + url + '\">';
  }
  function toggleAcctExpand(force) {
    var el = document.getElementById('acct-expand');
    if (!el) return;
    var open = !el.classList.contains('hidden');
    var want = (typeof force === 'boolean') ? force : !open;
    el.classList.toggle('hidden', !want);
    var box = $('account-list');
    if (box) box.classList.toggle('expanded', want);
    // 同步「账号管理」大卡片：展开时底部圆角变直角，与面板拼成一体
    try {
      var card = box && box.closest ? box.closest('.account-card') : null;
      if (card) card.classList.toggle('expanded', want);
    } catch (e) {}
  }
  // 移除账号（点击移除 / 左滑过阈值）：清缓存 + 刷新 App
  function doRemoveAccount(user) {
    if (!user) return;
    try {
      var m = JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || '{}');
      delete m[user];
      localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(m));
    } catch (e) {}
    try { cacheClear(); } catch (e) {}
    removeAccount(user);
    setTimeout(function () { try { location.reload(); } catch (e) {} }, 350);
  }
  // 未切换账号：左滑跟手 + 滑出「移除」（滑过阈值直接移除）
  function bindAcctSwipe(box) {
    var rows = box.querySelectorAll('.acct-row');
    var OPEN = 84;
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var inner = row.querySelector('.acct-row-inner');
        if (!inner) return;
        var sx = 0, sy = 0, dx = 0, active = false, decided = false, horiz = false, opened = false;
        var wmax = 0;
        row.addEventListener('touchstart', function (e) {
          var t = e.touches && e.touches[0]; if (!t) return;
          sx = t.clientX; sy = t.clientY; dx = 0; active = true; decided = false; horiz = false;
        }, { passive: true });
        row.addEventListener('touchmove', function (e) {
          if (!active) return;
          var t = e.touches && e.touches[0]; if (!t) return;
          var mx = t.clientX - sx, my = t.clientY - sy;
          if (!decided) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
            decided = true;
            horiz = Math.abs(mx) > Math.abs(my) * 1.1;
            if (!horiz) { active = false; return; }
          }
          if (!horiz) return;
          wmax = row.clientWidth || 300;
          dx = mx - (opened ? OPEN : 0);
          if (dx > 0) dx = 0;
          if (dx < -wmax) dx = -wmax;   // 最多滑 100%
          inner.style.transition = 'none';
          inner.style.transform = 'translateX(' + dx + 'px)';
          if (e.cancelable) e.preventDefault();
        }, { passive: false });
        function settle(open) {
          opened = open;
          inner.style.transition = 'transform 0.2s ease';
          inner.style.transform = 'translateX(' + (open ? -OPEN : 0) + 'px)';
        }
        function end() {
          if (!active) return;
          active = false;
          var w = row.clientWidth || 300;
          if (dx <= -w * 0.7) { doRemoveAccount(row.getAttribute('data-user')); return; }  // 超过 70% 直接移除
          if (dx < -w * 0.22) settle(true); else settle(false);
        }
        row.addEventListener('touchend', end, { passive: true });
        row.addEventListener('touchcancel', function () { active = false; settle(opened); }, { passive: true });
      })(rows[i]);
    }
  }
  // 渲染「我的」页账号管理折叠区
  function renderAccountList() {
    var box = $('account-list');
    if (!box) return;
    var list = loadAccounts();
    // 兼容：列表为空但当前已登录（老数据/首次启动），把当前账号纳入列表
    if (list.length === 0 && state.token && state.user) {
      list = [{ user: state.user, token: state.token, pass: '' }];
      saveAccounts(list);
      setCurrentAccountUser(state.user);
    }
    var cur = currentAccountUser();
    if (list.length === 0) {
      box.innerHTML = ''
        + '<div class="acct-summary">'
        + '<div class="acct-avatar sm"><span class="mi-icon" data-icon="user"></span></div>'
        + '<div class="acct-info"><div class="acct-user">未登录账号</div>'
        + '<div class="acct-addline" data-add="1">添加账号</div></div>'
        + '<span class="acct-toggle"><span class="mi-icon" data-icon="plus"></span></span>'
        + '</div>';
      injectIcons(box);
      bindAccountList(box);
      return;
    }
    var curName = cur || state.user || list[0].user;
    var curAcct = null;
    for (var i = 0; i < list.length; i++) { if (list[i].user === curName) { curAcct = list[i]; break; } }
    if (!curAcct) curAcct = list[0];
    var cLetter = (curAcct.user.charAt(0) || '用').toUpperCase();
    // 头像：优先内存；其次本地缓存（避免每次进 App 都重新拉取）；切换账号时已清空
    var _prof = state.profile || {};
    var _head = _prof.headImage || '';
    if (_head) { try { saveAvatarCache(curAcct.user, _head); } catch (e) {} }
    else { _head = loadAvatarCache(curAcct.user) || ''; }
    if (_head && !/^https?:\/\//i.test(_head) && !/^data:/i.test(_head)) {
      _head = (_head.charAt(0) === '/') ? ('https://www.123pan.com' + _head) : ('https://' + _head);
    }
    var _avHtml = _head
      ? ('<img class="acct-av-img" alt="" src="' + esc(_head) + '" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'av-fallback\')"><span class="acct-av-letter">' + esc(cLetter) + '</span>')
      : ('<span class="acct-av-letter">' + esc(cLetter) + '</span>');
    // 把当前资料写入账号记录（供切换列表展示 VIP / 头像）
    try { saveAccountProfile(curAcct.user, _head, !!(state.profile && state.profile.isVip), (state.profile && state.profile.vipKind) || ''); } catch (e) {}
    var _others = list.filter(function (a) { return a.user !== curAcct.user; });
    box.innerHTML = ''
      + '<div class="acct-summary" data-summary="1">'
      + '<div class="acct-avatar sm" data-profile="1">' + _avHtml + '</div>'
      + '<div class="acct-info">'
      + '<div class="acct-user">' + esc(curAcct.user) + accountBadgeHtml() + '</div>'
      + '<div class="acct-meta"><span class="mi-icon" data-icon="check"></span>当前账号</div>'
      + '</div>'
      + '<span class="acct-toggle" data-toggle="1"><span class="mi-icon" data-icon="chevron-down"></span></span>'
      + '</div>'
      + '<div class="acct-expand hidden" id="acct-expand">'
      + (function () {
          var h = '';
          _others.forEach(function (a) {
            var letter = (a.user.charAt(0) || '\u7528').toUpperCase();
            h += '<div class="acct-row" data-user="' + esc(a.user) + '">'
              +   '<div class="acct-row-inner">'
              +     '<div class="acct-avatar sm">' + acctAvatarHtml(a, letter) + '</div>'
              +     '<div class="acct-info"><div class="acct-user">' + esc(a.user) + acctVipHtml(a) + '</div>'
              +     '<div class="acct-meta">点击切换</div></div>'
              +     '<span class="acct-goto"><span class="mi-icon" data-icon="chevron-right"></span></span>'
              +   '</div>'
              +   '<button class="acct-remove" data-del="' + esc(a.user) + '">移除</button>'
              + '</div>';
          });
          return h;
        })()
      + '<div class="acct-expand-actions">'
      +   '<button class="acct-exp-btn" data-add="1">添加账号</button>'
      +   '<button class="acct-exp-btn cancel" data-collapse="1">取消</button>'
      + '</div>'
      + '</div>';
    if (cur === '' && list.length > 0) setCurrentAccountUser(list[0].user);
    injectIcons(box);
    bindAccountList(box);
  }
  // 折叠区事件委托：当前账号行 / 展开按钮 / 未切换账号 / 添加 / 移除 / 取消
  function bindAccountList(box) {
    box.onclick = function (e) {
      e.stopPropagation();
      var t = e.target && e.target.closest ? e.target.closest('[data-profile],[data-toggle],[data-add],[data-del],[data-collapse],[data-user]') : null;
      if (!t) return;
      if (t.hasAttribute('data-profile')) { openProfile(); return; }
      if (t.hasAttribute('data-toggle')) { toggleAcctExpand(); return; }
      if (t.hasAttribute('data-collapse')) { toggleAcctExpand(false); return; }
      if (t.hasAttribute('data-add')) { toggleAcctExpand(false); openAddAccount(); return; }
      if (t.hasAttribute('data-del')) { doRemoveAccount(t.getAttribute('data-del')); return; }
      if (t.hasAttribute('data-user')) {
        toggleAcctExpand(false);
        switchAccount(t.getAttribute('data-user'));
        if (state.view === 'mine') loadMine();
        return;
      }
    };
    try { bindAcctSwipe(box); } catch (e) {}
  }
  // 账号列表弹层：只列其他账号 + 末尾「添加账号」（不重复当前账号）
  function openAccountSheet() {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    var list = loadAccounts();
    var cur = currentAccountUser();
    var others = list.filter(function (a) { return a.user !== cur; });
    var box = $('account-sheet-list');
    if (!box) return;
    var html = '';
    if (others.length === 0) {
      html += '<div class="acct-empty">暂无其他账号</div>';
    } else {
      others.forEach(function (a) {
        var name = a.user || '';
        var letter = (name.charAt(0) || '用').toUpperCase();
        html += '<div class="acct-item" data-user="' + esc(name) + '">'
          + '<div class="acct-avatar xs">' + esc(letter) + '</div>'
          + '<div class="acct-info">'
          + '<div class="acct-user">' + esc(name) + '</div>'
          + '<span class="acct-meta">点击切换</span>'
          + '</div>'
          + '<span class="acct-goto"><span class="mi-icon" data-icon="chevron-right"></span></span>'
          + '</div>';
      });
    }
    html += '<div class="acct-item add" data-add="1">'
      + '<span class="acct-plus"><span class="mi-icon" data-icon="plus"></span></span>'
      + '<div class="acct-info"><div class="acct-user">添加账号</div></div>'
      + '</div>';
    box.innerHTML = html;
    injectIcons(box);
    box.onclick = function (e) {
      e.stopPropagation();
      var t = e.target && e.target.closest ? e.target.closest('[data-add],[data-user]') : null;
      if (!t) return;
      if (t.hasAttribute('data-add')) { hide($('account-sheet')); openAddAccount(); return; }
      if (t.hasAttribute('data-user')) {
        var u = t.getAttribute('data-user');
        hide($('account-sheet'));
        openAccountAction(u);
      }
    };
    show($('account-sheet'));
  }
  // 账号操作菜单：切换 / 删除
  function openAccountAction(user) {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    var title = $('account-action-title');
    var body = $('account-actions-body');
    if (!body) return;
    var cur = currentAccountUser();
    var isCur = user === cur || (!cur && user === state.user);
    if (title) title.textContent = user;
    body.innerHTML = ''
      + '<div class="account-action-item" data-act="switch">'
      + (isCur ? '<span>切换到此账号</span><span class="aa-tag">当前</span>'
               : '<span>切换到该账号</span><span class="aa-tag">›</span>')
      + '</div>'
      + '<div class="account-action-item danger" data-act="del">删除该账号</div>';
    body.querySelectorAll('.account-action-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var act = item.getAttribute('data-act');
        hide($('account-action'));
        if (act === 'switch') { switchAccount(user); if (state.view === 'mine') loadMine(); }
        else if (act === 'del') {
          showConfirm('确认删除账号「' + user + '」？', function () { removeAccount(user); });
        }
      });
    });
    show($('account-action'));
  }
  // 添加账号：走 9.8 自带登录页（账号密码登录），登录成功后自动入列表
  function openAddAccount() {
    closeAllOverlays();   // 进登录页前先关掉所有弹窗
    hide($('account-sheet'));
    pendingAddAccount = true;
    switchToLogin();
    var msg = $('login-msg');
    if (msg) msg.textContent = '请登录要添加的账号';
  }
  // 退出当前账号
  function doLogout() {
    if (bridge && bridge.logout) { try { bridge.logout(); } catch (e) {} }
    else if (bridge && bridge.clearSession) { try { bridge.clearSession(); } catch (e) {} }
    setCurrentAccountUser('');
    state.token = '';
    state.user = '';
    pendingAddAccount = false;
    toast('已退出登录');
    switchToLogin();
  }

  // ---------- 原生桥调用 ----------
  function toast(msg) {
    if (bridge && bridge.toast) bridge.toast(String(msg));
  }
  function api(method, url, body, withAuth, cb) {
    var cbName = '_cb' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    window[cbName] = function (json) {
      var data;
      try { data = (typeof json === 'string') ? JSON.parse(json) : json; } catch (e) { data = { ok: false, error: '解析失败: ' + (e && e.message ? e.message : '') }; }
      delete window[cbName];
      cb(data);
    };
    bridge.apiRequest(cbName, method, url, body || '', !!withAuth);
  }
  function loadToken() { return bridge && bridge.loadToken ? bridge.loadToken() : ''; }

  // ---------- 夜间模式：由原生判定，JS 只负责换主题 ----------
  // 为什么不用 prefers-color-scheme：本应用主题是 Theme.Material.Light，
  // 部分 ROM 下 WebView 拿不到夜间值（现象：系统 Toast 变黑了，网页还是浅色）。
  // 原生 NativeBridge.isDarkMode() 读的是 Configuration.uiMode，一定准确。
  // 主题模式偏好：system（跟随系统）/ light（白天）/ dark（夜间），写在 localStorage
  var THEME_KEY = 'pan_theme';
  function themePref() {
    // 已按需求移除「主题模式」设置项：始终跟随系统自动切换（白天/夜间），
    // 状态栏颜色与图标反色由原生按 resources.arsc 的日/夜间定义自动处理（白天黑图标、夜间白图标）。
    return 'system';
  }
  function themePrefLabel(p) {
    p = p || themePref();
    return p === 'dark' ? '夜间模式' : (p === 'light' ? '白天模式' : '跟随系统');
  }
  // 系统真实夜间状态（不考虑用户手动指定）
  function rawSystemDark() {
    try {
      if (bridge && bridge.isDarkMode) return !!bridge.isDarkMode();
      if (bridge && bridge.isSystemDark) return !!bridge.isSystemDark();   // 1.7.3 名称
    } catch (e) {}
    // 原生接口不可用时的兜底
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) {}
    return false;
  }
  // 实际生效的夜间状态：手动指定优先，否则跟随系统
  function isSystemDark() {
    var p = themePref();
    if (p === 'dark') return true;
    if (p === 'light') return false;
    return rawSystemDark();
  }
  function applyTheme() {
    var dark = isSystemDark();
    var el = document.documentElement;
    el.setAttribute('data-theme', dark ? 'dark' : 'light');
    el.classList.toggle('dark', dark);   // 兼容用 class 选择器的写法
    // 原生状态栏 / 导航栏跟随（原生没实现则静默跳过）
    if (bridge) {
      if (bridge.setLightStatusBar) { try { bridge.setLightStatusBar(!dark); } catch (e) {} }
      if (bridge.setDarkMode) { try { bridge.setDarkMode(dark); } catch (e) {} }
      // 1.7.3 适配：状态栏 / 导航栏颜色直接取 JS 顶栏（#topbar）当前背景色
      var topBg = '';
      try {
        var tb = document.getElementById('topbar');
        if (tb && window.getComputedStyle) topBg = window.getComputedStyle(tb).backgroundColor || '';
      } catch (e) {}
      if (topBg && bridge.setStatusBarColor) {
        try { bridge.setStatusBarColor(String(topBg)); } catch (e) {}
      } else if (bridge.applyThemeColors) {
        try { bridge.applyThemeColors(dark); } catch (e) {}   // 旧原生兜底
      }
    }
  }
  window.__applyTheme = applyTheme;
  applyTheme();
  // 兼容 media query 变化（能收到的 ROM 就顺便用）
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    else if (mq.addListener) mq.addListener(applyTheme);
  } catch (e) {}
  // 轮询兜底：部分 ROM 切夜间时原生不会回调 onConfigurationChanged 到 JS，
  // 这里低频比对，变化才重设主题（避免无谓开销）。
  // 深链轮询已合并到同一个节拍（原来是第二个 1.5s setInterval，已移除）。
  setInterval(function () {
    try {
      if (document.hidden) return;
      var dark = isSystemDark();
      var cur = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark !== cur) applyTheme();
      checkDeepLinkFromNative();
      if (pendingShareUrl) openPendingShareUrl();
    } catch (e) {}
  }, 1500);

  // ---------- 页面切换 ----------
  function switchView(v) {
    try { clearJumpHighlight(); } catch (e) {}
    state.view = v;
    // 切页面（传输/我的）：去重弹窗立刻关闭并终止扫描，不拦住底部标签栏
    if (dedupeScanning || dedupePaused || ($('dedupe-modal') && !$('dedupe-modal').classList.contains('hidden'))) {
      dedupeCancel = true;
      dedupePaused = false;
      hide($('dedupe-modal'));
      dedupeSetPausedUI(false);
    }
    ['files', 'transfers', 'mine'].forEach(function (k) {
      var sec = $('view-' + k);
      var tab = null;
      document.querySelectorAll('#tabbar .tab').forEach(function (t) {
        if (t.getAttribute('data-view') === k) tab = t;
      });
      if (sec) sec.classList.toggle('hidden', k !== v);
      if (tab) tab.classList.toggle('active', k === v);
    });
    try {
      var _bar2 = $('tabbar'); var _ind2 = _bar2 && _bar2.querySelector('.tab-indicator');
      if (_ind2) {
        var _tabs2 = _bar2.querySelectorAll('.tab'); var _idx = -1;
        for (var _ti = 0; _ti < _tabs2.length; _ti++) if (_tabs2[_ti].getAttribute('data-view') === v) { _idx = _ti; break; }
        if (_idx >= 0) {
          var _tp2 = 100 / _tabs2.length; var _ip2 = _tp2 * 0.8;
          _ind2.style.transition = '';
          _ind2.style.width = _ip2 + '%';
          _ind2.style.left = (_idx * _tp2 + (_tp2 - _ip2) / 2) + '%';
        }
      }
    } catch (e) {}
    if (v !== 'transfers') {
      var _ou2 = $('offline-url'); if (_ou2 && _ou2.value) _ou2.value = '';
      var _or3 = $('offline-result'); if (_or3) _or3.textContent = '';
    }
    
    // 从搜索状态切到「传输 / 我的」：重置搜索框并关闭搜索（与切页同时完成）
    if (v !== 'files' && state.searching) {
      exitSearch();
    }

    // 切到其它页面（传输/我的）→ 完整退出多选：收多选栏 + 清空选中 + 列表重绘（去掉勾选圆点）
    if (v !== 'files' && state.selectMode) {
      exitSelectMode();
      renderList(state.lastList || []);
    }
    
    // 注意：这里不做任何滚动位置归零。
    // 之前无条件归零会导致「点底栏文件 tab 就跳到顶部」，已移除。

    if (v === 'mine') loadMine();
    if (v === 'recycle') loadRecycle();
    if (v === 'transfers') { renderTransfersFirst(); startProgressPolling(); }
    else { stopProgressPolling(); }
    if (v === 'files' && !$('file-list').dataset.loaded) loadList();
    updateToolbarVisibility(v);

    // 传输页：顶部标题改为「传输列表」居中显示；其它页恢复「123云盘」
    var topTitleEl = $('top-title');
    if (topTitleEl) {
      topTitleEl.textContent = (v === 'transfers') ? '传输列表' : (v === 'mine' ? '我的' : '123云盘');
    }
    var topbarEl = $('topbar');
    if (topbarEl) {
      // 传输页与我的页：标题居中、黑色、字号略大于普通行
      topbarEl.classList.toggle('center-title', v === 'transfers' || v === 'mine');
      topbarEl.classList.toggle('search-mode', v === 'files');   // 文件页：顶栏变搜索框
    }
  }

  // ---------- 底部"文件"tab双击回到主目录 ----------
  var fileTabClickCount = 0;
  var fileTabClickTimer = null;

  function initFileTabDoubleClick() {
    var fileTab = document.querySelector('#tabbar .tab[data-view="files"]');
    if (!fileTab) return;
    
    fileTab.addEventListener('click', function(e) {
      if (state.view !== 'files') {
        switchView('files');
        fileTabClickCount = 0;
        return;
      }
      
      fileTabClickCount++;
      
      if (fileTabClickCount === 1) {
        fileTabClickTimer = setTimeout(function() {
          fileTabClickCount = 0;
          fileTabClickTimer = null;
        }, 400);
      } else if (fileTabClickCount >= 2) {
        clearTimeout(fileTabClickTimer);
        fileTabClickTimer = null;
        fileTabClickCount = 0;
        
        if (state.currentDir === 0 && state.breadcrumb.length === 0) {
          return;
        }
        
        state.currentDir = 0;
        state.breadcrumb = [];
        loadList();
        
        var scrollArea = $('scroll-area');
        if (scrollArea) {
          scrollArea.scrollTop = 0;
        }
      }
    });
  }

  // ---------- 长按底部"文件"tab显示工具栏 ----------
  function initToolbarLongPress() {
    var fileTab = document.querySelector('#tabbar .tab[data-view="files"]');
    if (!fileTab) return;
    
    var longPressTimer = null;
    var isLongPress = false;
    
    fileTab.addEventListener('touchstart', function(e) {
      isLongPress = false;
      longPressTimer = setTimeout(function() {
        isLongPress = true;
        if (state.view === 'files' && !state.searching) {
          showToolbar();
          if (bridge && bridge.vibrate) bridge.vibrate(20);
        }
      }, 500);
    });
    
    fileTab.addEventListener('touchend', function(e) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (isLongPress) {
        e.preventDefault();
        isLongPress = false;
      }
    });
    
    fileTab.addEventListener('touchmove', function(e) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      isLongPress = false;
    });
    
    fileTab.addEventListener('mousedown', function(e) {
      isLongPress = false;
      longPressTimer = setTimeout(function() {
        isLongPress = true;
        if (state.view === 'files' && !state.searching) {
          showToolbar();
        }
      }, 500);
    });
    
    fileTab.addEventListener('mouseup', function(e) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (isLongPress) {
        e.preventDefault();
        isLongPress = false;
      }
    });
    
    fileTab.addEventListener('mouseleave', function(e) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      isLongPress = false;
    });
  }

  // ---------- 下载任务 ----------
  function acctKeySuffix() {
    try { return (String(state.token || state.user || 'x')).replace(/[^A-Za-z0-9]/g, '').slice(0, 12); } catch (e) { return 'x'; }
  }
  function loadTransfers() {
    try { return curAccountEntry().entry.downloads; } catch (e) { return []; }
  }
  function saveTransfers() {
    try {
      var ce = curAccountEntry();
      ce.entry.downloads = state.transfers || [];
      saveAccounts(ce.list);
    } catch (e) {}
  }

  // 是否跨盘（夸克/UC）下载任务：标记优先，名字前缀兜底
  function isCrossTransfer(t) {
    if (!t) return false;
    if (t.cross) return true;
    var n = String(t.name || '');
    return n.indexOf('【夸克】') === 0 || n.indexOf('【UC】') === 0;
  }
  function addTransfer(t) {
    if (!state.transfers) state.transfers = [];
    state.transfers.unshift({ 
      id: t.id || -1, 
      name: t.name || '', 
      size: t.size, 
      status: t.status || 'downloading', 
      done: 0, 
      total: t.total || 0, 
      stream: !!t.stream, 
      cross: !!t.cross, 
      time: Date.now(),
      acct: acctKeySuffix(),
      paused: false,
      speed: 0,
      lastDone: 0,
      lastTime: Date.now()
    });
    saveTransfers();
  }
  function statusLabel(st, done, total) {
    st = Number(st);
    if (st === 8) return '已完成';
    if (st === 16) return '失败';
    var tot = Number(total);
    if (tot > 0) {
      var p = Math.floor((Number(done) || 0) / tot * 100);
      if (p > 100) p = 100;
      return '下载中 ' + p + '%';
    }
    return '下载中';
  }
  function startProgressPolling() {
    if (state.progTimer) return;
    pollDownloadProgress();
    state.progTimer = setInterval(function() {
      if (state.view !== 'transfers') {
        pollDownloadProgressSilent();
        return;
      }
      pollDownloadProgress();
    }, 1000);
  }
  function stopProgressPolling() {
    if (state.progTimer) { clearInterval(state.progTimer); state.progTimer = null; }
  }
  
  // 跨盘下载任务：App 重启后 Java 线程已消失，把仍标 'downloading' 的跨盘任务标记为中断
  function syncCrossTasks() {
    try {
      if (!(bridge && bridge.crossTasks)) return;
      if (!state.transfers || !state.transfers.length) return;
      var act = [];
      try { act = JSON.parse(bridge.crossTasks() || '[]'); } catch (e) { act = []; }
      var isAct = {};
      (act || []).forEach(function (x) { isAct[Number(x)] = true; });
      var changed = false;
      state.transfers.forEach(function (t) {
        if (!isCrossTransfer(t)) return;
        if (t.status !== 'downloading') return;
        if (!isAct[Number(t.id)]) { t.status = 'failed'; t.error = '下载已中断'; t.speed = 0; t.paused = false; changed = true; }
      });
      if (changed) { saveTransfers(); renderTransfersThrottled(); }
    } catch (e) {}
  }
  function pollDownloadProgressSilent() {
    syncCrossTasks();
    if (!(bridge && bridge.queryDownloads)) return;
    try {
      var list = JSON.parse(bridge.queryDownloads() || '[]');
      var slist = [];
      if (bridge.streamingTasks) {
        try { slist = JSON.parse(bridge.streamingTasks() || '[]'); } catch (e) {}
      }
      if ((!Array.isArray(list) || !list.length) && (!Array.isArray(slist) || !slist.length)) return;
      if (!state.transfers) return;
      var nameToStatus = {};
      (list).forEach(function (dl) { nameToStatus[dl.name] = dl; });
      var changed = false;
      var now = Date.now();
      state.transfers.forEach(function (t) {
        if (t.paused) return;
        
        var hit = null;
        if (t.stream && slist.length) {
          slist.forEach(function (x) { if (Number(x.id) === Number(t.id)) hit = x; });
        }
        if (!hit && t.id >= 0 && list.length) {
          list.forEach(function (x) { if (Number(x.id) === Number(t.id)) hit = x; });
        }
        if (!hit && t.name) hit = nameToStatus[t.name] || null;
        if (!hit) {
          // 本地仍显示下载中，但原生任务已不存在（App 被系统杀死 / 服务停止）→ 标记中断
          if (t.status === 'downloading' && (t.stream || isCrossTransfer(t))) {
            t._miss = (Number(t._miss) || 0) + 1;
            if (t._miss >= 4) { t.status = 'failed'; t.error = '下载已中断'; t.paused = false; changed = true; }
          }
        } else { t._miss = 0; }
        if (hit) {
          if (t.status === 'completed') return;
          var st = Number(hit.status);
          var done = Number(hit.done) || 0;
          var total = Number(hit.total) || 0;
          var expect = Number(t.total) || Number(t.size) || 0;
          
          if (t.lastDone !== undefined && t.lastDone > 0) {
            var deltaTime = (now - (t.lastTime || now)) / 1000;
            var deltaBytes = done - t.lastDone;
            if (deltaTime > 0 && deltaBytes > 0) {
              t.speed = deltaBytes / deltaTime;
            }
          }
          t.lastDone = done;
          t.lastTime = now;
          
          t.done = done;
          t.total = total;
          if (st === 8) {
            if (t.stream) {
              var ref = (total > 0 ? total : expect);
              if (ref > 0 && done >= ref) { 
                t.status = 'completed';
                t.speed = 0;
              }
              else { t.status = 'downloading'; }
            } else {
              if (total > 0 && done >= total) { 
                t.status = 'completed';
                t.speed = 0;
              }
              else { t.status = 'downloading'; }
            }
          }
          else if (st === 16) { 
            t.status = 'failed';
            t.speed = 0;
          }
          else if (st === 2) {            // Java 侧暂停（含 App 重启后恢复的任务）
            t.status = 'downloading';
            t.paused = true;
            t.speed = 0;
          }
          else { t.status = 'downloading'; }
          changed = true;
        }
      });
      // 反向补录：原生仍在（刚启动恢复/本地记录丢失）但本地没有的任务 → 补进列表
      if (Array.isArray(slist) && slist.length) {
        var _have = {};
        state.transfers.forEach(function (t) { _have[Number(t.id)] = true; });
        slist.forEach(function (x) {
          var id = Number(x.id);
          if (!id || _have[id]) return;
          var stx = Number(x.status);
          if (stx === 8 || stx === 16) return;         // 已结束的不补
          var _own0 = findDownloadOwnerById(id);
          if (_own0 && _own0.user !== state.user) {
            for (var _op0 = 0; _op0 < (_own0.entry.downloads || []).length; _op0++) {
              if (String(_own0.entry.downloads[_op0].id) === String(id)) {
                _own0.entry.downloads[_op0].done = Number(x.done) || 0;
                if (Number(x.total) > 0) _own0.entry.downloads[_op0].total = Number(x.total);
                _own0.entry.downloads[_op0].paused = (stx === 2);
                break;
              }
            }
            saveAccounts(_own0.list);
            return;
          }
          // 同名旧记录（id 变了）→ 直接沿用原生 id，避免重复显示
          var _nm0 = String(x.name || '');
          for (var q0 = 0; q0 < state.transfers.length; q0++) {
            var _tt0 = state.transfers[q0];
            if (_nm0 && String(_tt0.name || '') === _nm0) {
              _tt0.id = id; _tt0.stream = true; _tt0.paused = (stx === 2);
              if (Number(_tt0.total) <= 0) _tt0.total = Number(x.total) || 0;
              changed = true;
              return;
            }
          }
          var tot = Number(x.total) || 0, dn = Number(x.done) || 0;
          state.transfers.unshift({
            id: id, name: String(x.name || ''), size: tot, total: tot, done: dn,
            status: 'downloading', stream: true, cross: false,
            time: Date.now(), acct: acctKeySuffix(),
            paused: (stx === 2), speed: 0, lastDone: dn, lastTime: Date.now()
          });
          changed = true;
        });
      }
      if (changed) {
        saveTransfers();
      }
    } catch (e) { /* 忽略 */ }
  }
  
  function pollDownloadProgress() {
    syncCrossTasks();
    if (!(bridge && bridge.queryDownloads)) return;
    try {
      var list = JSON.parse(bridge.queryDownloads() || '[]');
      var slist = [];
      if (bridge.streamingTasks) {
        try { slist = JSON.parse(bridge.streamingTasks() || '[]'); } catch (e) {}
      }
      if ((!Array.isArray(list) || !list.length) && (!Array.isArray(slist) || !slist.length)) return;
      if (!state.transfers) return;
      var nameToStatus = {};
      (list).forEach(function (dl) { nameToStatus[dl.name] = dl; });
      var changed = false;
      var now = Date.now();
      state.transfers.forEach(function (t) {
        if (t.paused) return;
        
        var hit = null;
        if (t.stream && slist.length) {
          slist.forEach(function (x) { if (Number(x.id) === Number(t.id)) hit = x; });
        }
        if (!hit && t.id >= 0 && list.length) {
          list.forEach(function (x) { if (Number(x.id) === Number(t.id)) hit = x; });
        }
        if (!hit && t.name) hit = nameToStatus[t.name] || null;
        if (!hit) {
          // 本地仍显示下载中，但原生任务已不存在（App 被系统杀死 / 服务停止）→ 标记中断
          if (t.status === 'downloading' && (t.stream || isCrossTransfer(t))) {
            t._miss = (Number(t._miss) || 0) + 1;
            if (t._miss >= 4) { t.status = 'failed'; t.error = '下载已中断'; t.paused = false; changed = true; }
          }
        } else { t._miss = 0; }
        if (hit) {
          if (t.status === 'completed') return;
          var st = Number(hit.status);
          var done = Number(hit.done) || 0;
          var total = Number(hit.total) || 0;
          var expect = Number(t.total) || Number(t.size) || 0;
          
          if (t.lastDone !== undefined && t.lastDone > 0) {
            var deltaTime = (now - (t.lastTime || now)) / 1000;
            var deltaBytes = done - t.lastDone;
            if (deltaTime > 0 && deltaBytes > 0) {
              t.speed = deltaBytes / deltaTime;
            }
          }
          t.lastDone = done;
          t.lastTime = now;
          
          t.done = done;
          t.total = total;
          if (st === 8) {
            if (t.stream) {
              var ref = (total > 0 ? total : expect);
              if (ref > 0 && done >= ref) { 
                t.status = 'completed';
                t.speed = 0;
              }
              else { t.status = 'downloading'; }
            } else {
              if (total > 0 && done >= total) { 
                t.status = 'completed';
                t.speed = 0;
              }
              else { t.status = 'downloading'; }
            }
          }
          else if (st === 16) { 
            t.status = 'failed';
            t.speed = 0;
          }
          else if (st === 2) {            // Java 侧暂停（含 App 重启后恢复的任务）
            t.status = 'downloading';
            t.paused = true;
            t.speed = 0;
          }
          else { t.status = 'downloading'; }
          changed = true;
        }
      });
      // 反向补录：原生仍在但本地没有的任务 → 补进列表（App 被杀后重开也能看到）
      if (Array.isArray(slist) && slist.length) {
        var _have2 = {};
        state.transfers.forEach(function (t) { _have2[Number(t.id)] = true; });
        slist.forEach(function (x) {
          var id = Number(x.id);
          if (!id || _have2[id]) return;
          var stx = Number(x.status);
          if (stx === 8 || stx === 16) return;
          var _own1 = findDownloadOwnerById(id);
          if (_own1 && _own1.user !== state.user) {
            for (var _op1 = 0; _op1 < (_own1.entry.downloads || []).length; _op1++) {
              if (String(_own1.entry.downloads[_op1].id) === String(id)) {
                _own1.entry.downloads[_op1].done = Number(x.done) || 0;
                if (Number(x.total) > 0) _own1.entry.downloads[_op1].total = Number(x.total);
                _own1.entry.downloads[_op1].paused = (stx === 2);
                break;
              }
            }
            saveAccounts(_own1.list);
            return;
          }
          // 同名旧记录（id 变了）→ 沿用原生 id，避免重复显示
          var _nm1 = String(x.name || '');
          for (var q1 = 0; q1 < state.transfers.length; q1++) {
            var _tt1 = state.transfers[q1];
            if (_nm1 && String(_tt1.name || '') === _nm1) {
              _tt1.id = id; _tt1.stream = true; _tt1.paused = (stx === 2);
              if (Number(_tt1.total) <= 0) _tt1.total = Number(x.total) || 0;
              changed = true;
              return;
            }
          }
          var tot = Number(x.total) || 0, dn = Number(x.done) || 0;
          state.transfers.unshift({
            id: id, name: String(x.name || ''), size: tot, total: tot, done: dn,
            status: 'downloading', stream: true, cross: false,
            time: Date.now(), acct: acctKeySuffix(),
            paused: (stx === 2), speed: 0, lastDone: dn, lastTime: Date.now()
          });
          changed = true;
        });
      }
      if (changed) {
        saveTransfers();
        if (state.view === 'transfers') {
          renderTransfers();
        }
      }
    } catch (e) { /* 忽略 */ }
  }
  
  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return '';
    if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
    if (bytesPerSec < 1048576) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
    if (bytesPerSec < 1073741824) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
    return (bytesPerSec / 1073741824).toFixed(2) + ' GB/s';
  }

  // 刷新传输列表。
  // 注意：这里不能重建列表（不能先塞“加载中”再重画），因为进度轮询每秒调一次，
  // 之前那种写法会每秒把列表擦掉重建一次 → 视觉上持续抽动。
  // 现在只做原地更新，卡片结构与监听器全部复用。
  function renderTransfers() {
    renderTransferList($('download-list'), 'download');
    renderTransferList($('upload-list'), 'upload');
    updateTransferTabs();
  }

  // 首次进入传输页才显示“加载中”，避免后续刷新时闪屏
  function renderTransfersFirst() {
    var d = $('download-list'), u = $('upload-list');
    if (d && !d._initialized) {
      d.innerHTML = '<div class="transfer-loading"><div class="loading-dot">加载中...</div></div>';
    }
    if (u && !u._initialized) {
      u.innerHTML = '<div class="transfer-loading"><div class="loading-dot">加载中...</div></div>';
    }
    renderTransfers();
  }

  // 传输卡片按钮图标（内联 SVG base64，与删除图标同风格）
  var ICON_PAUSE_B64 = 'PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3QgeD0iNS41IiB5PSI0IiB3aWR0aD0iNCIgaGVpZ2h0PSIxNiIgcng9IjIiIGZpbGw9IiMxODFDMzIiLz4KPHJlY3QgeD0iMTQuNSIgeT0iNCIgd2lkdGg9IjQiIGhlaWdodD0iMTYiIHJ4PSIyIiBmaWxsPSIjMTgxQzMyIi8+Cjwvc3ZnPgo=';
  var ICON_RESUME_B64 = 'PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTYuOTUyNzcgMTguMTMxNkM2Ljk1Mjc3IDE5LjMyOTYgOC4wMDkwNSAxOS44OTQ5IDguMDA5MDUgMTkuODk0OUM5LjA2NTM0IDIwLjQ2MDIgMTAuMDYyMiAxOS43OTU3IDEwLjA2MjIgMTkuNzk1N0wxOS4yNTk0IDEzLjY2NDJDMjAuMTUgMTMuMDcwNSAyMC4xNSAxMi4wMDAxIDIwLjE1IDEyLjAwMDFDMjAuMTUgMTAuOTI5NyAxOS4yNTk0IDEwLjMzNiAxOS4yNTk0IDEwLjMzNkwxMC4wNjIyIDQuMjA0NTNDOS4wNjUzNCAzLjUzOTk3IDguMDA5MDUgNC4xMDUyOCA4LjAwOTA1IDQuMTA1MjhDNi45NTI3NyA0LjY3MDU4IDYuOTUyNzcgNS44Njg2MyA2Ljk1Mjc3IDUuODY4NjNWMTguMTMxNloiIGZpbGw9IiMxODFDMzIiLz4KPC9zdmc+Cg==';
  // 暂停/继续 单个传输（跨盘与 123 自动分流）
  function togglePauseTransfer(t) {
    if (!t) return;
    t.paused = !t.paused;
    if (t.paused) {
      if (isCrossTransfer(t) && bridge && bridge.crossPause) bridge.crossPause(t.id);
      else if (bridge && bridge.pauseDownload) bridge.pauseDownload(t.id);
    } else {
      if (isCrossTransfer(t) && bridge && bridge.crossResume) bridge.crossResume(t.id);
      else if (bridge && bridge.resumeDownload) bridge.resumeDownload(t.id);
      t.lastDone = t.done;
      t.lastTime = Date.now();
    }
  }
  // 全部暂停（进行中）
  function pauseAllDownloads() {
    var list = state.transfers || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.status === 'downloading' && !t.paused) { togglePauseTransfer(t); n++; }
    }
    saveTransfers(); renderTransfers();
    toast(n > 0 ? ('已暂停 ' + n + ' 项') : '没有进行中的任务');
  }
  // 取消下载（进行中）：取消并移除
  function cancelAllDownloads() {
    var list = state.transfers || [];
    var kept = [], n = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.status === 'downloading') {
        try {
          if (isCrossTransfer(t) && bridge && bridge.crossCancel) bridge.crossCancel(t.id);
          else if (bridge && bridge.cancelDownload) bridge.cancelDownload(t.id);
          else if (Number(t.id) >= 900000000 && bridge.deleteDownloadTask) bridge.deleteDownloadTask(t.id);
          else if (bridge && bridge.pauseDownload) bridge.pauseDownload(t.id);
        } catch (e) {}
        n++;
      } else kept.push(t);
    }
    state.transfers = kept;
    saveTransfers(); renderTransfers();
    toast(n > 0 ? ('已取消 ' + n + ' 项下载') : '没有进行中的任务');
  }
  // 全部继续（已暂停的进行中任务）
  function resumeAllDownloads() {
    var list = state.transfers || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.status === 'downloading' && t.paused) { togglePauseTransfer(t); n++; }
    }
    saveTransfers(); renderTransfers();
    toast(n > 0 ? ('已继续 ' + n + ' 项') : '没有已暂停的任务');
  }
  // 清空已完成（含失败/略过）
  function clearDoneDownloads() {
    var list = state.transfers || [];
    var kept = [], n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].status !== 'downloading') n++; else kept.push(list[i]);
    }
    if (!n) { toast('没有已完成记录'); return; }
    state.transfers = kept;
    saveTransfers(); renderTransfers();
    toast('已清空 ' + n + ' 条记录');
  }
  // 分组标题：进行中（有暂停项 → 全部继续；否则 → 全部暂停；二选一）
  function progHeadHtml(progN, pausedN) {
    var btn = (pausedN > 0)
      ? '<button class="tg-btn" data-tg="resume-all">全部继续</button>'
      : '<button class="tg-btn" data-tg="pause-all">全部暂停</button>';
    return '<span class="tg-title">进行中 <span class="tg-count">' + progN + '</span></span>'
      + '<span class="tg-actions">' + btn + '</span>';
  }
  // 分组标题：已完成（清空）
  function doneHeadHtml(doneN) {
    return '<span class="tg-title">已完成 <span class="tg-badge">' + doneN + '</span></span>'
      + '<span class="tg-actions"><button class="tg-btn" data-tg="clear-done">清除全部</button></span>';
  }

  // ---------- 上传列表差量渲染（1412 任务实测：整表重绘会拖死 WebView） ----------
  // 结构变化：只在“头部新增”时增量插卡（unshift 入队正好是头部）；删除/换序仍整表重建。
  // 内容变化：由进度/状态回调按 id 标记“脏”，每帧只刷新脏卡片。
  // ================= 文件夹上传：整组聚合 =================
  function uploadGroupMap(list) {
    var groups = {}, order = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || !t.groupId) { order.push(t); continue; }
      var g = groups[t.groupId];
      if (!g) {
        g = { groupId: t.groupId, name: t.groupName || '文件夹', tasks: [],
              done: 0, total: 0, uploading: 0, paused: 0, waiting: 0, failed: 0, doneN: 0, speed: 0 };
        groups[t.groupId] = g; order.push(g);
      }
      g.tasks.push(t);
      g.done += Number(t.done) || 0;
      g.total += Number(t.total || t.size) || 0;
      g.speed += Number(t.speed) || 0;
      if (t.status === 'uploading') g.uploading++;
      else if (t.status === 'paused') g.paused++;
      else if (t.status === 'waiting') g.waiting++;
      else if (t.status === 'failed') g.failed++;
      else if (t.status === 'completed') g.doneN++;
    }
    return { groups: groups, order: order };
  }
  function _groupStatus(g) {
    if (!g) return 'waiting';
    if (g.paused > 0) return 'paused';
    if (g.uploading > 0 || g.waiting > 0) return 'uploading';
    if (g.tasks && g.tasks.length === g.doneN) return 'completed';
    if (g.failed > 0) return 'failed';
    return 'waiting';
  }
  function _groupView(g) {
    var st = _groupStatus(g);
    var nm = (g.name || '文件夹') + ' · ' + g.tasks.length + ' 个文件';
    return { id: g.groupId, name: nm, size: g.total, total: g.total, done: g.done,
             status: (st === 'completed' ? 'completed' : st), speed: g.speed, _group: g };
  }
  function _tasksOfGroup(g) {
    var out = [], list = loadUploadTransfers();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].groupId) === String(g.groupId)) out.push(list[i]);
    }
    return out;
  }
  function uploadGroupPause(g) {
    var tasks = _tasksOfGroup(g), n = 0;
    var usedBatch = false;
    // 优先走原生批量暂停（权威，不依赖逐个 id 映射）
    try {
      if (bridge && bridge.pauseUploadGroup && g && g.groupId) {
        bridge.pauseUploadGroup(String(g.groupId));
        usedBatch = true;
      }
    } catch (e) { usedBatch = false; }
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'uploading' || t.status === 'waiting') {
        if (!usedBatch) {
          var ulid = Number(String(t.id).replace(/^up/, '')) || 0;
          try { if (bridge && bridge.pauseUploadLocal) bridge.pauseUploadLocal(ulid); } catch (e) {}
        }
        t.status = 'paused';
        markUploadRowDirty(t.id);
        n++;
      }
    }
    saveUploadTransfers(loadUploadTransfers());
    toast(n > 0 ? ('已暂停该文件夹 ' + n + ' 个文件') : '该文件夹已全部暂停');
    renderTransfers();
  }
  function uploadGroupResume(g) {
    var tasks = _tasksOfGroup(g), n = 0;
    var usedBatch = false;
    try {
      if (bridge && bridge.resumeUploadGroup && g && g.groupId) {
        bridge.resumeUploadGroup(String(g.groupId));
        usedBatch = true;
      }
    } catch (e) { usedBatch = false; }
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (t.status === 'paused') {
        if (!usedBatch) {
          var ulid = Number(String(t.id).replace(/^up/, '')) || 0;
          try { if (bridge && bridge.resumeUploadLocal) bridge.resumeUploadLocal(ulid); } catch (e) {}
        }
        t.status = 'uploading';
        markUploadRowDirty(t.id);
        n++;
      }
    }
    saveUploadTransfers(loadUploadTransfers());
    toast(n > 0 ? ('已继续该文件夹 ' + n + ' 个文件') : '没有可继续的文件');
    renderTransfers();
  }
  function uploadGroupDelete(g) {
    try { if (bridge && bridge.cancelUploadGroup && g && g.groupId) bridge.cancelUploadGroup(String(g.groupId)); } catch (e) {}
    var list = loadUploadTransfers(), kept = [], n = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (String(t.groupId) === String(g.groupId)) {
        var nid = _uploadNativeRev[t.id];
        if (nid && bridge && bridge.cancelUploadTask && t.status !== 'completed') {
          try { bridge.cancelUploadTask(nid); } catch (e) {}
          delete _uploadNativeMap[nid]; delete _uploadNativeRev[t.id];
        }
        n++;
      } else kept.push(t);
    }
    saveUploadTransfers(kept);
    var c = $('upload-list'); if (c) c._initialized = false;
    renderTransfers();
    toast('已删除该文件夹 ' + n + ' 条记录');
  }
  function uploadGroupByUid(uid) {
    // 必须复用 uploadGroupMap 的聚合结果：手工构造会缺 paused/uploading 等统计字段，
    // 导致 _groupStatus() 永远判不出 'paused' → 点卡片无法从“已暂停”切回“继续”。
    try {
      var map = uploadGroupMap(loadUploadTransfers());
      var g = map.groups[String(uid)];
      if (g) return g;
    } catch (e) {}
    // 兜底：至少把状态字段补齐
    var list = loadUploadTransfers();
    var g2 = { groupId: uid, name: '', tasks: [], done: 0, total: 0,
               uploading: 0, paused: 0, waiting: 0, failed: 0, doneN: 0, speed: 0 };
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (String(t.groupId) !== String(uid)) continue;
      g2.tasks.push(t);
      g2.done += Number(t.done) || 0;
      g2.total += Number(t.total || t.size) || 0;
      g2.speed += Number(t.speed) || 0;
      if (!g2.name) g2.name = t.groupName || '文件夹';
      if (t.status === 'uploading') g2.uploading++;
      else if (t.status === 'paused') g2.paused++;
      else if (t.status === 'waiting') g2.waiting++;
      else if (t.status === 'failed') g2.failed++;
      else if (t.status === 'completed') g2.doneN++;
    }
    return g2.tasks.length ? g2 : null;
  }

  function markUploadRowDirty(id) {
    try {
      var c = $('upload-list');
      if (!c) return;
      if (!c._dirty) c._dirty = {};
      c._dirty[String(id)] = 1;
      // 文件夹任务：其卡片实际用 groupId 作 data-uid，必须一并标记，否则聚合卡不刷新
      try {
        var list = loadUploadTransfers();
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(id) && list[i].groupId) {
            c._dirty[String(list[i].groupId)] = 1;
            break;
          }
        }
      } catch (e2) {}
    } catch (e) {}
  }
  function isUploadRowDirty(container, id) {
    return !!(container._dirty && container._dirty[String(id)]);
  }
  function findUploadById(id) {
    var list = loadUploadTransfers();
    for (var i = 0; i < list.length; i++) { if (String(list[i].id) === String(id)) return list[i]; }
    return null;
  }
  function makeTransferCardEl(type, ri, uid) {
    var card = document.createElement('div');
    card.className = 'transfer-card';
    card.setAttribute('data-i', ri);
    card.setAttribute('data-type', type);
    if (uid !== null && uid !== undefined) card.setAttribute('data-uid', uid);
    card.innerHTML = '<div class="transfer-card-icon"></div>'
      + '<div class="transfer-card-body">'
        + '<div class="transfer-card-name"></div>'
        + '<div class="transfer-card-meta"></div>'
        + '<div class="transfer-progress"><div class="transfer-progress-bar"></div></div>'
      + '</div>'
      + '<div class="transfer-card-actions"></div>';
    return card;
  }
  // 上传完成后的文件列表刷新：
  //  - 整批上传没结束前不刷新（避免每完成一个文件就重建主页列表 → 抖动）
  //  - 刷新时保留滚动位置（不回到顶部、不闪“加载中”）
  var _flRefreshT = null;
  function hasActiveUploadTasks() {
    try {
      var list = loadUploadTransfers() || [];
      for (var i = 0; i < list.length; i++) {
        var s = list[i].status;
        if (s === 'uploading' || s === 'waiting' || s === 'paused') return true;
      }
    } catch (e) {}
    return false;
  }
  function scheduleFileListRefresh() {
    if (_flRefreshT) return;
    _flRefreshT = setTimeout(function () {
      _flRefreshT = null;
      try {
        if (hasActiveUploadTasks()) { scheduleFileListRefresh(); return; }   // 还有文件在传 → 等整批结束
        if (state.view !== 'files') return;                                   // 不在文件页 → 不刷新
        // 只刷新“上传的目标文件夹”：当前就在该目录才刷新，其它目录一律不动（避免抖动）
        var _tgt = (state.uploadTargetDir == null) ? null : Number(state.uploadTargetDir);
        if (_tgt === null) return;                                            // 没有上传目标记录 → 不刷新
        if (Number(state.currentDir) !== _tgt) return;                        // 用户已切到别的目录 → 不刷新
        state.uploadTargetDir = null;                                         // 一次性消费
        var fl = $('file-list');
        if (!fl) return;
        state.keepScroll = true;      // 保留滚动位置，不回到顶部
        fl.dataset.loaded = '';
        loadList();
      } catch (e) {}
    }, 2500);
  }
  function renderTransferList(container, type) {
  if (!container) return;
  
  var list = (type === 'download')
    ? (state.transfers || loadTransfers())
    : loadUploadTransfers();
  list = list || [];

  // 账号过滤：只影响“显示”，绝不改写/丢弃原始数据
  // （否则 App 重启瞬间账号未就绪时，过滤结果会被写回并保存 → 任务被清空）
  var _suf = '';
  try { _suf = acctKeySuffix(); } catch (e) { _suf = 'x'; }
  var _filterOn = !!(_suf && _suf !== 'x');
  function _shown(t) { return !_filterOn || !t.acct || t.acct === _suf; }

  if (type === 'download') state.transfers = list;   // 始终保留全量

  // 视图组装：进行中在前 / 已完成在后；data-i 存 list 中的真实索引
  var view = [];
  if (type === 'download') {
    for (var _a = 0; _a < list.length; _a++) { if (_shown(list[_a]) && list[_a].status === 'downloading') view.push({ t: list[_a], i: _a, g: 0 }); }
    for (var _b = 0; _b < list.length; _b++) { if (_shown(list[_b]) && list[_b].status !== 'downloading') view.push({ t: list[_b], i: _b, g: 1 }); }
  } else {
    var _gmap = uploadGroupMap(list);
    var _gOrder = _gmap.order;
    for (var _ga = 0; _ga < _gOrder.length; _ga++) {
      var _eo = _gOrder[_ga];
      if (_eo && _eo.groupId) {
        var _fake = _groupView(_eo);
        _fake._group = _eo;
        if (_shown(_fake)) view.push({ t: _fake, i: list.indexOf(_eo.tasks[0]), g: 0, group: _eo });
      } else if (_shown(_eo)) {
        view.push({ t: _eo, i: list.indexOf(_eo), g: 0 });
      }
    }
  }

  if (!view.length) {
    container.innerHTML = '<div class="transfer-empty-inner"><div class="panel-icon" data-icon="' + (type === 'download' ? 'download' : 'upload') + '"></div><p>暂无' + (type === 'download' ? '下载' : '上传') + '任务</p></div>';
    injectIcons(container);
    container._initialized = false;
    container._sig = '';
    container._rowIds = null;
    container._dirty = null;
    return;
  }

  var progN = 0, doneN = 0, activeN = 0, pausedN = 0;
  for (var _q = 0; _q < view.length; _q++) {
    if (view[_q].g !== 0) { doneN++; continue; }
    progN++;
    if (view[_q].t.paused) pausedN++; else activeN++;
  }
  var sig = (type === 'download' ? 'D#' : 'U#')
    + view.map(function (v) { return v.g + ':' + v.i; }).join(',');

  var _isUpList = (type === 'upload');
  var _rebuildNeeded = (!container._initialized || container._sig !== sig);
  var _upNewIds = null;
  var _upViewIds = null;
  if (_rebuildNeeded && _isUpList) {
    _upViewIds = [];
    for (var _u0 = 0; _u0 < view.length; _u0++) _upViewIds.push(String(view[_u0].t.id));
    var _prevIds = container._rowIds || [];
    // 仅“头部新增、顺序不变”走增量；其余（删除/换序/首次）整表重建
    if (container._initialized && container._sigKind === 'up' && _prevIds.length
        && _upViewIds.length > _prevIds.length) {
      var _sufOk = true;
      for (var _u1 = 0; _u1 < _prevIds.length; _u1++) {
        if (_upViewIds[_upViewIds.length - _prevIds.length + _u1] !== _prevIds[_u1]) { _sufOk = false; break; }
      }
      if (_sufOk) {
        _upNewIds = _upViewIds.slice(0, _upViewIds.length - _prevIds.length);
        _rebuildNeeded = false;
        container._sig = sig;
      }
    }
  }
  var _didRebuild = false;
  if (_rebuildNeeded) {
    _didRebuild = true;
    container._initialized = true;
    container._sig = sig;
    container._sigKind = type;
    container._rowIds = null;
    container.innerHTML = '';

    var lastG = -1;
    for (var i = 0; i < view.length; i++) {
      var _v = view[i];
      if (type === 'download' && _v.g !== lastG) {
        lastG = _v.g;
        var head = document.createElement('div');
        head.className = 'transfer-group-head';
        if (_v.g === 0) {
          head.className = 'transfer-group-head tg-head-prog';
          head.innerHTML = progHeadHtml(progN, pausedN);
        } else {
          head.className = 'transfer-group-head tg-head-done';
          head.innerHTML = doneHeadHtml(doneN);
        }
        container.appendChild(head);
      }
      var card = makeTransferCardEl(type, _v.i, type === 'upload' ? _v.t.id : null);
      container.appendChild(card);
    }
    if (_isUpList) container._rowIds = _upViewIds || [];

    if (!container._listenersAttached) {
      container._listenersAttached = true;

      container.addEventListener('click', function (e) {
        var tg = e.target.closest ? e.target.closest('[data-tg]') : null;
        if (!tg) return;
        e.stopPropagation();
        var act = tg.getAttribute('data-tg');
        if (act === 'pause-all') pauseAllDownloads();
        else if (act === 'cancel-all') cancelAllDownloads();
        else if (act === 'resume-all') resumeAllDownloads();
        else if (act === 'clear-done') clearDoneDownloads();
      });
      
      container.addEventListener('click', function(e) {
        var card = e.target.closest('.transfer-card');
        if (!card) return;
        if (e.target.closest && e.target.closest('button')) return;
        
        var idx = Number(card.getAttribute('data-i'));
        var cardType = card.getAttribute('data-type');
        if (cardType === 'upload') {
          // 上传：点卡片主体 = 暂停/继续（文件夹卡 = 整个文件夹）
          var _gidC = card.getAttribute('data-group');
          if (_gidC) {
            var _gC = uploadGroupByUid(_gidC);
            if (_gC) {
              var _stC = _groupStatus(_gC);
              if (_stC === 'paused') uploadGroupResume(_gC); else uploadGroupPause(_gC);
            }
            return;
          }
          var _uidC = card.getAttribute('data-uid');
          var _utC = _uidC ? findUploadById(_uidC) : loadUploadTransfers()[idx];
          if (!_utC) return;
          if (_utC.status === 'uploading' || _utC.status === 'waiting') {
            var _lidC = Number(String(_utC.id).replace(/^up/, '')) || 0;
            try { if (bridge && bridge.pauseUploadLocal) bridge.pauseUploadLocal(_lidC); } catch (e) {}
            _utC.status = 'paused';
          } else if (_utC.status === 'paused') {
            var _lidR = Number(String(_utC.id).replace(/^up/, '')) || 0;
            try { if (bridge && bridge.resumeUploadLocal) bridge.resumeUploadLocal(_lidR); } catch (e) {}
            _utC.status = 'uploading';
          } else return;
          markUploadRowDirty(_utC.id);
          saveUploadTransfers(loadUploadTransfers());
          renderTransfers();
          return;
        }
        if (cardType === 'download') {
          var t = state.transfers[idx];
          if (!t) return;
          if (t.status === 'downloading') {
            togglePauseTransfer(t);
            saveTransfers();
            renderTransfers();
          } else if (t.status === 'completed') {
            // 已完成：先出点击视觉（:active），稍后再打开
            setTimeout(function () {
              if (bridge && bridge.openFile) {
                try { bridge.openFile(t.name || ''); } catch (e) { toast('无法打开文件：' + (t.name || '')); }
              }
            }, 160);
          }
        }
      });
      
      container.addEventListener('click', function(e) {
        var btn = e.target.closest('.transfer-action');
        if (!btn) return;
        e.stopPropagation();
        
        var idx = Number(btn.getAttribute('data-i'));
        var cardType = btn.getAttribute('data-type');
        if (cardType === 'download') {
          var t = state.transfers[idx];
          if (!t || t.status !== 'downloading') return;
          t.paused = !t.paused;
          if (t.paused) {
            if (isCrossTransfer(t) && bridge && bridge.crossPause) bridge.crossPause(t.id);
            else if (bridge && bridge.pauseDownload) bridge.pauseDownload(t.id);
          } else {
            if (isCrossTransfer(t) && bridge && bridge.crossResume) bridge.crossResume(t.id);
            else if (bridge && bridge.resumeDownload) bridge.resumeDownload(t.id);
            t.lastDone = t.done;
            t.lastTime = Date.now();
          }
          saveTransfers();
          renderTransfers();
        }
        else if (cardType === 'upload') {
          var _uidAct = btn.getAttribute('data-uid');
          if (_uidAct && String(_uidAct).indexOf('uf_') === 0) {
            var _gA = uploadGroupByUid(_uidAct);
            if (!_gA) return;
            if (_groupStatus(_gA) === 'paused') uploadGroupResume(_gA); else uploadGroupPause(_gA);
            return;
          }
          var ut = _uidAct ? findUploadById(_uidAct) : loadUploadTransfers()[idx];
          if (!ut) return;
          var ulid = Number(String(ut.id).replace(/^up/, '')) || 0;
          if (ut.status === 'paused') {
            try { if (bridge && bridge.resumeUploadLocal) bridge.resumeUploadLocal(ulid); } catch (e) {}
            ut.status = 'uploading';
          } else {
            try { if (bridge && bridge.pauseUploadLocal) bridge.pauseUploadLocal(ulid); } catch (e) {}
            ut.status = 'paused';
          }
          markUploadRowDirty(ut.id);
          saveUploadTransfers(loadUploadTransfers());
          renderTransfers();
        }
      });
      
      container.addEventListener('click', function(e) {
        var btn = e.target.closest('.transfer-open');
        if (!btn) return;
        e.stopPropagation();
        
        var idx = Number(btn.getAttribute('data-i'));
        var cardType = btn.getAttribute('data-type');
        var fileName = btn.getAttribute('data-name') || '';
        var listData = cardType === 'download' ? (state.transfers || loadTransfers()) : loadUploadTransfers();
        var t = listData[idx];
        if (!t) return;
        if (t.status !== 'completed') { toast('文件未完成'); return; }
        
        if (bridge && bridge.openFile) {
          try {
            bridge.openFile(fileName);
          } catch (e) {
            toast('无法打开文件：' + fileName);
          }
        } else {
          toast('请使用文件管理器打开：' + fileName);
        }
      });
      
      container.addEventListener('click', function(e) {
        var btn = e.target.closest('.transfer-del');
        if (!btn) return;
        e.stopPropagation();
        
        var idx = Number(btn.getAttribute('data-i'));
        var cardType = btn.getAttribute('data-type');
        if (cardType === 'download') {
          var t = state.transfers && state.transfers[idx];
          if (!t) return;
          if (t.status === 'downloading' && bridge) {
            try {
              if (isCrossTransfer(t) && bridge.crossCancel) bridge.crossCancel(t.id);
              else if (bridge.cancelDownload) bridge.cancelDownload(t.id);
              else if (Number(t.id) >= 900000000 && bridge.deleteDownloadTask) bridge.deleteDownloadTask(t.id);
              else if (bridge.pauseDownload) bridge.pauseDownload(t.id);
            } catch (e) {}
          }
          state.transfers.splice(idx, 1);
          saveTransfers();
          container._initialized = false;
          renderTransfers();
        } else {
          var _uidDelG = btn.getAttribute('data-uid');
          if (_uidDelG && String(_uidDelG).indexOf('uf_') === 0) {
            var _gD = uploadGroupByUid(_uidDelG);
            if (_gD) uploadGroupDelete(_gD);
            return;
          }
          var listData = loadUploadTransfers();
          var _uidDel = btn.getAttribute('data-uid');
          var _ut = _uidDel ? findUploadById(_uidDel) : listData[idx];
          if (!_ut) return;
          idx = listData.indexOf(_ut);
          var _nid = _uploadNativeRev[_ut.id];
          if (_nid && bridge && bridge.cancelUploadTask && _ut.status !== 'completed') {
            try { bridge.cancelUploadTask(_nid); } catch (e) {}
            delete _uploadNativeMap[_nid];
            delete _uploadNativeRev[_ut.id];
          }
          listData.splice(idx, 1);
          saveUploadTransfers(listData);
          container._initialized = false;
          renderTransfers();
        }
        toast('已删除记录');
      });
    }
  }
  
  // 上传列表：头部增量插卡（不重建整表）
  if (_upNewIds && _upNewIds.length) {
    var _firstOld = container.querySelector('.transfer-card');
    var _frag = document.createDocumentFragment();
    var _newSet = {};
    for (var _n0 = 0; _n0 < _upNewIds.length; _n0++) _newSet[_upNewIds[_n0]] = 1;
    var _addedIds = [];
    for (var _v0 = 0; _v0 < view.length; _v0++) {
      var _vi = view[_v0];
      if (!_newSet[String(_vi.t.id)]) continue;
      var _nc = makeTransferCardEl('upload', _vi.i, _vi.t.id);
      updateTransferCardBody(_nc, _vi.t, 'upload', _vi.i);
      _frag.appendChild(_nc);
      _addedIds.push(String(_vi.t.id));
    }
    if (_firstOld) container.insertBefore(_frag, _firstOld); else container.appendChild(_frag);
    container._rowIds = _addedIds.concat(container._rowIds || []);
  }

  var existingCards = container.querySelectorAll('.transfer-card');
  for (var i = 0; i < existingCards.length && i < view.length; i++) {
    var _cv = view[i];
    if (_isUpList && !_didRebuild && !isUploadRowDirty(container, _cv.t.id)) continue;
    updateTransferCardBody(existingCards[i], _cv.t, type, _cv.i);
  }
  if (_isUpList) container._dirty = null;

  // 单张卡片内容刷新（原整表循环体抽出；上传列表只对“脏”卡片调用 → 1412 条也不卡）
  function updateTransferCardBody(card, t, type, ri) {
    var _grpRef = t._group || null;
    if (_grpRef) t = _groupView(_grpRef);
    var icName = iconForName(t.name || '');
    var sz = fmtSize(t.size || t.total || 0);
    var isDownloading = type === 'download' && t.status === 'downloading' && !t.paused;
    var isUploading = type === 'upload' && t.status === 'uploading';
    var isActive = type === 'download' ? isDownloading : isUploading;
    
    var iconEl = card.querySelector('.transfer-card-icon');
    if (iconEl) {
      iconEl.className = 'transfer-card-icon fi-' + icName;
      iconEl.setAttribute('data-icon', icName);
      applySvg(iconEl, icName);
    }
    
    var nameEl = card.querySelector('.transfer-card-name');
    if (nameEl) nameEl.textContent = t.name || '';
    
    var label = '';
    var statusClass = '';
    if (t.status === 'completed') {
      label = '已完成';
      statusClass = 'status-completed';
    } else if (t.status === 'skipped') {
      label = '已略过（文件已存在）';
      statusClass = 'status-skipped';
    } else if (t.status === 'failed') {
      label = t.error ? '失败: ' + t.error : '失败';
      statusClass = 'status-failed';
    } else if (t.status === 'downloading') {
      var percent = t.total > 0 ? Math.floor((t.done || 0) / (t.total || 1) * 100) : 0;
      if (percent > 100) percent = 100;
      label = t.paused ? '已暂停 ' + percent + '%' : '下载中 ' + percent + '%';
      statusClass = t.paused ? 'status-paused' : 'status-active';
    } else if (t.status === 'paused') {
      label = '已暂停';
      statusClass = 'status-paused';
    } else if (t.status === 'uploading') {
      var percent2 = t.total > 0 ? Math.floor((t.done || 0) / t.total * 100) : 0;
      if (percent2 > 100) percent2 = 100;
      label = '上传中 ' + percent2 + '%';
      statusClass = 'status-active';
    } else if (t.status === 'waiting') {
      label = '排队中';
      statusClass = 'status-active';
    } else {
      label = String(t.status || '处理中');
      statusClass = 'status-active';
    }
    
    var speedText = '';
    if (isActive && t.speed && t.speed > 0) {
      speedText = ' · ' + formatSpeed(t.speed);
    }
    
    var metaEl = card.querySelector('.transfer-card-meta');
    if (metaEl) {
      var subInfo = '';
      if (type === 'upload') {
        if (_grpRef) {
          var _doneC = 0;
          for (var _gi = 0; _gi < _grpRef.tasks.length; _gi++) if (_grpRef.tasks[_gi].status === 'completed') _doneC++;
          var _pctG = _grpRef.total > 0 ? Math.floor((_grpRef.done || 0) / _grpRef.total * 100) : 0;
          if (_pctG > 100) _pctG = 100;
          var _gLabel;
          if (_groupStatus(_grpRef) === 'paused') _gLabel = '已暂停 ' + _pctG + '%';
          else if (_grpRef.doneN === _grpRef.tasks.length) _gLabel = '已完成';
          else _gLabel = '上传中 ' + _pctG + '%';
          subInfo = '<span class="' + statusClass + '">' + _gLabel + '</span>'
                  + ' · ' + _doneC + '/' + _grpRef.tasks.length + ' 文件'
                  + ' · ' + fmtSize(_grpRef.total || 0)
                  + (speedText || '');
        } else {
          subInfo = '<span class="' + statusClass + '">' + label + '</span>' + speedText;
        }
      } else {
        // 下载：已下载/总大小 · (已暂停 | 速度金色 | 状态)
        var _tot = fmtSize(t.total || t.size || 0);
        var szText = (t.status === 'completed') ? _tot : (fmtSize(t.done || 0) + '/' + _tot);
        var tail = '';
        if (t.status === 'completed') {
          subInfo = _tot;   // 已完成：只显示总大小
        } else {
          if (t.status === 'downloading') {
            if (t.paused) tail = '<span class="status-paused">已暂停</span>';
            else if (t.speed && t.speed > 0) tail = '<span class="speed-gold">' + formatSpeed(t.speed) + '</span>';
            else tail = '<span class="status-active">下载中</span>';
          } else {
            tail = '<span class="' + statusClass + '">' + label + '</span>';
          }
          subInfo = szText + ' · ' + tail;
        }
      }
      metaEl.innerHTML = subInfo;
    }
    
    var progressWrap = card.querySelector('.transfer-progress');
    if (progressWrap) {
      if (t.status === 'completed' || t.status === 'skipped' || t.status === 'failed') {
        // 已完成 / 已略过 / 失败：整条进度条（含底槽）完全移除；失败仅保留红色错误文字
        progressWrap.style.display = 'none';
      } else {
        progressWrap.style.display = '';
        var progressBar = card.querySelector('.transfer-progress-bar');
        if (progressBar) {
          var pct = t.total > 0 ? Math.floor((t.done || 0) / t.total * 100) : 0;
          if (pct > 100) pct = 100;
          progressBar.className = 'transfer-progress-bar';
          progressBar.style.width = pct + '%';
        }
      }
    }
    
    var actionsEl = card.querySelector('.transfer-card-actions');
    if (actionsEl) {
      var doneOk = (t.status === 'completed');
      var actionHtml = '';
      
      if (type === 'upload' && (t.status === 'uploading' || t.status === 'waiting' || t.status === 'paused')) {
        actionHtml += '<button class="transfer-action" data-i="' + ri + '" data-uid="' + (t.id == null ? '' : t.id) + '" data-type="' + type + '" data-action="toggle" title="' + (t.status === 'paused' ? '继续' : '暂停') + '"><img class="t-act-ic" alt="" src="data:image/svg+xml;base64,' + (t.status === 'paused' ? ICON_RESUME_B64 : ICON_PAUSE_B64) + '"></button>';
      }
      if (type === 'download' && t.status === 'downloading') {
        actionHtml += '<button class="transfer-action" data-i="' + ri + '" data-uid="' + (t.id == null ? '' : t.id) + '" data-type="' + type + '" data-action="toggle" title="' + (t.paused ? '继续' : '暂停') + '"><img class="t-act-ic" alt="" src="data:image/svg+xml;base64,' + (t.paused ? ICON_RESUME_B64 : ICON_PAUSE_B64) + '"></button>';
      }
      
      
      actionHtml += '<button class="transfer-del" data-i="' + ri + '" data-uid="' + (t.id == null ? '' : t.id) + '" data-type="' + type + '" title="删除记录"><img class="t-del-ic" alt="" src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHZpZXdCb3g9IjAgMCAxNCAxNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgaWQ9IiYjMjI5OyYjMTU1OyYjMTU4OyYjMjMwOyYjMTQ4OyYjMTgyOyYjMjMxOyYjMTcxOyYjMTUzOy0mIzIzMzsmIzE4NzsmIzE1MjsmIzIzMjsmIzE3NDsmIzE2NDsiPgo8cGF0aCBpZD0iJiMyMzE7JiMxNTk7JiMxNjk7JiMyMjk7JiMxODk7JiMxNjI7IiBkPSJNMTEuMDgzNCAxMC4yMDg1QzExLjA4MzQgMTEuMTc1IDEwLjI5OTkgMTEuOTU4NSA5LjMzMzQxIDExLjk1ODVINC42NjY3NUMzLjcwMDI1IDExLjk1ODUgMi45MTY3NSAxMS4xNzUgMi45MTY3NSAxMC4yMDg1VjQuOTU4NUMyLjkxNjc1IDQuNDc1MjUgMy4zMDg1IDQuMDgzNSAzLjc5MTc1IDQuMDgzNUgxMC4yMDg0QzEwLjY5MTcgNC4wODM1IDExLjA4MzQgNC40NzUyNSAxMS4wODM0IDQuOTU4NVYxMC4yMDg1WiIgc3Ryb2tlPSIjM0MzRjUyIiBzdHJva2Utd2lkdGg9IjEuMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CjxwYXRoIGlkPSImIzIzMjsmIzE4MzsmIzE3NTsmIzIyOTsmIzE5MDsmIzEzMjsgNCIgZD0iTTEuNzUgNC4wODM1SDEyLjI1IiBzdHJva2U9IiMzQzNGNTIiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPHBhdGggaWQ9IiYjMjMxOyYjMTU5OyYjMTY5OyYjMjI5OyYjMTg5OyYjMTYyO18yIiBkPSJNNC42NjY3NSAzLjQ5OTg0TDQuOTU2NzMgMi43NzQ4OEM1LjEzMzkgMi4zMzE5NSA1LjU2MjkgMi4wNDE1IDYuMDM5OTUgMi4wNDE1SDcuOTYwMjFDOC40MzcyNiAyLjA0MTUgOC44NjYyNiAyLjMzMTk1IDkuMDQzNDMgMi43NzQ4OEw5LjMzMzQxIDMuNDk5ODQiIHN0cm9rZT0iIzNDM0Y1MiIgc3Ryb2tlLXdpZHRoPSIxLjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L2c+Cjwvc3ZnPgo="></button>';
      // 差量更新：内容没变就不重设 innerHTML。
      // 否则进度轮询每秒都会重建按钮 → 闪动，而且手指正按着时会被打断。
      if (actionsEl._last !== actionHtml) {
        actionsEl._last = actionHtml;
        actionsEl.innerHTML = actionHtml;
      }
    }
    
    card.setAttribute('data-i', ri);
    card.setAttribute('data-type', type);
    if (type === 'upload') {
      card.setAttribute('data-uid', t.id == null ? '' : t.id);
      if (_grpRef) card.setAttribute('data-group', _grpRef.groupId);
    }
  }
  // 分组标题原地刷新（不重建列表 → 不抖动）
  var _hp = container.querySelector('.tg-head-prog');
  if (_hp) { var _h = progHeadHtml(progN, pausedN); if (_hp._last !== _h) { _hp._last = _h; _hp.innerHTML = _h; } }
  var _hd = container.querySelector('.tg-head-done');
  if (_hd) { var _h2 = doneHeadHtml(doneN); if (_hd._last !== _h2) { _hd._last = _h2; _hd.innerHTML = _h2; } }
}
  // 三个子页签的顺序（与 DOM 一致），用于指示器与滑动换算
  var TT_ORDER = ['download', 'upload', 'offline'];
  var ttIndex = 0;
  // 摆放圆角背景块；frac 为小数时用于跟手拖动
  function ttPlace(animate, frac) {
    var ind = $('tt-indicator');
    if (!ind) return;
    var f = (typeof frac === 'number') ? frac : ttIndex;
    ind.style.transition = animate ? '' : 'none';
    ind.style.transform = 'translateX(' + (f * 100) + '%)';
  }
  function updateTransferTabs() {
    var tabs = document.querySelectorAll('.transfer-tab');
    var downloadContainer = $('download-list');
    var uploadContainer = $('upload-list');
    var offlinePanel = $('offline-panel');
    tabs.forEach(function (tab) {
      var tabName = tab.getAttribute('data-tab');
      tab.classList.toggle('active', tabName === transferTab);
    });
    if (downloadContainer) downloadContainer.classList.toggle('hidden', transferTab !== 'download');
    if (uploadContainer) uploadContainer.classList.toggle('hidden', transferTab !== 'upload');
    if (offlinePanel) offlinePanel.classList.toggle('hidden', transferTab !== 'offline');
    var i = TT_ORDER.indexOf(transferTab);
    if (i >= 0) ttIndex = i;
    ttPlace(true);
  }

  // 传输页：左右滑动切换子页签，圆角背景块跟手滑动
  function bindTransferSwipe() {
    var view = $('view-transfers');
    var bar = $('transfer-tabs');
    if (!view || !bar) return;
    var sx = 0, sy = 0, dx = 0, dragging = false, decided = false, horiz = false;

    view.addEventListener('touchstart', function (e) {
      dragging = false;
      var el = e.target;
      if (el && el.closest && el.closest('textarea,input,button')) return;  // 别抢输入/按钮
      var t = e.touches && e.touches[0];
      if (!t) return;
      sx = t.clientX; sy = t.clientY; dx = 0;
      dragging = true; decided = false; horiz = false;
    }, { passive: true });

    view.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      var ddx = t.clientX - sx, ddy = t.clientY - sy;
      if (!decided) {
        if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
        decided = true;
        horiz = Math.abs(ddx) > Math.abs(ddy) * 1.2;   // 横向意图才接管
      }
      if (!horiz) return;
      dx = ddx;
      var tabW = (bar.clientWidth || 1) / TT_ORDER.length;
      var frac = ttIndex - dx / tabW;
      frac = Math.max(0, Math.min(TT_ORDER.length - 1, frac));
      ttPlace(false, frac);
    }, { passive: true });

    function endSwipe() {
      if (!dragging) return;
      dragging = false;
      if (!horiz) return;
      var tabW = (bar.clientWidth || 1) / TT_ORDER.length;
      var moved = Math.round(-dx / tabW);
      var target = Math.max(0, Math.min(TT_ORDER.length - 1, ttIndex + moved));
      switchTransferTab(TT_ORDER[target]);   // 内部会重摆指示器（带动画）
    }
    view.addEventListener('touchend', endSwipe, { passive: true });
    view.addEventListener('touchcancel', function () { dragging = false; ttPlace(true); }, { passive: true });
  }

  function switchTransferTab(tab) {
    transferTab = tab;
    updateTransferTabs();
    if (tab === 'offline') { try { loadOfflineDone(); } catch (e) {} }
    else {
      var ou = $('offline-url'); if (ou && ou.value) ou.value = '';
      var or2 = $('offline-result'); if (or2) or2.textContent = '';
    }
  }

  function mapStatusText(s) {
    if (s === 'completed') return '已完成';
    if (s === 'failed') return '失败';
    if (s === 'uploading') return '上传中';
    return String(s || '下载中');
  }

  // ---------- 登录 ----------
  function doLogin() {
    var u = $('login-user').value.trim();
    var p = $('login-pass').value;
    if (!u || !p) { $('login-msg').textContent = '请输入账号和密码'; return; }
    var btn = $('login-btn');
    btn.disabled = true;
    $('login-msg').textContent = '登录中...';
    api('POST', API.signIn,
      JSON.stringify({ type: 1, passport: u, password: p }),
      false,
      function (d) {
        btn.disabled = false;
        var tok = d && d.data ? (d.data.token || d.data.authorization || '') : '';
        if (tok) {
          if (tok.indexOf('Bearer ') === 0) tok = tok.slice(7);
          state.token = tok;
          state.user = u;
          addAccount(u, tok, p);
          if (bridge && bridge.saveSession) {
            bridge.saveSession(tok, u, p);
          }
          var wasAdd = pendingAddAccount;
          pendingAddAccount = false;
          toast(wasAdd ? '账号已添加' : '登录成功');
          enterMain();
        } else {
          $('login-msg').textContent = (d && d.message) ? d.message
            : ('登录失败[' + (d && d.code != null ? d.code : '') + ']，请检查账号密码');
        }
      });
  }

  // ---------- 登录方式切换：账号登录 / 验证码登录 ----------
  function switchLoginTab(tab) {
    var tabs = document.querySelectorAll('#login-tabs .login-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-login-tab') === tab);
    }
    var pw = $('login-pwd-panel');
    var sm = $('login-sms-panel');
    if (pw) pw.classList.toggle('hidden', tab === 'sms');
    if (sm) sm.classList.toggle('hidden', tab !== 'sms');
  }

  // 获取短信验证码 / 验证码登录
  // 官方 get_vcode 语义：{ passport, operation:4, validate:<易盾滑块凭证> }，手机号发码常被服务端风控拦截；
  // 策略：按官方接口语义直连试发（不再提供官方登录页兜底）。
  var _smsCountdown = null;
  var _captchaInst = null;
  var _captchaPhone = '';
  var _smsBtnRef = null;
  var _extSmsCtx = null;   // 设置页发码上下文（复用阿里云无感验证）
  var _captchaReady = false;
  var _smsSending = false;
  var _smsCountTrigger = 0;
  function goOfficialSmsLogin() {
    // 已移除官方登录页兜底：不再调用原生官方登录，也不再提示（保留函数名兼容旧引用）
  }
    // 初始化阿里云无痕验证码（SceneId:nqiwjmw1，同一实例复用）
  function ensureCaptchaReady(cb) {
    if (_captchaInst) { cb(); return; }
    if (!window.initAliyunCaptcha) {
      if (_smsBtnRef) _smsBtnRef.disabled = false;
      $('login-msg-sms').textContent = '安全组件加载中，请稍后再试';
      return;
    }
    $('login-msg-sms').textContent = '正在初始化安全验证…';
    try {
      window.initAliyunCaptcha({
        SceneId: 'nqiwjmw1',
        mode: 'popup',
        element: '#cap-el',
        button: '#cap-btn',
        captchaVerifyCallback: function (p) {
          if (_smsSending) return { captchaResult: false, bizResult: false };
          var _ctx = _extSmsCtx || { phone: _captchaPhone, btn: _smsBtnRef, setMsg: function (t) { $('login-msg-sms').textContent = t; }, op: 2, login: true };
          function sm(t) { try { _ctx.setMsg(t); } catch (e) {} }
          if (!p || p.length < 100) {
            _smsSending = false;
            sm('安全验证未通过，请重试');
            if (_ctx.btn) _ctx.btn.disabled = false;
            return { captchaResult: false };
          }
          sm('验证码发送中…');
          _smsSending = true;
          extVcodeSendWithCaptcha(_ctx, p);
          return { captchaResult: true, bizResult: true };
        },
        onBizResultCallback: function () {},
        getInstance: function (i) {
          if (_captchaReady) return;
          _captchaInst = i;
          _captchaReady = true;
          _smsCountTrigger++;
          cb();
        },
        onError: function (e) {
          $('login-msg-sms').textContent = '安全验证不可用，请稍后重试';
          if (_smsBtnRef) _smsBtnRef.disabled = false;
        },
        slideStyle: { width: 360, height: 40 },
        language: 'cn'
      });
    } catch (e) {
      $('login-msg-sms').textContent = '安全组件初始化失败';
      if (_smsBtnRef) _smsBtnRef.disabled = false;
    }
  }
function doGetSmsCode() {
    _extSmsCtx = null;   // 登录发码：确保不被设置页上下文干扰
    var phone = $('sms-phone').value.trim();
    if (!/^1\d{10}$/.test(phone)) { $('login-msg-sms').textContent = '请输入正确的11位手机号'; return; }
    var btn = $('sms-send-btn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    _captchaPhone = phone;
    _smsBtnRef = btn;
    $('login-msg-sms').textContent = '安全验证中…';
    ensureCaptchaReady(function () {
      if (_captchaInst) {
        try { _captchaInst.startTracelessVerification(); } catch (e) {
          $('login-msg-sms').textContent = '验证触发失败，请重试';
          if (btn) btn.disabled = false;
        }
      }
    });
  }
  function startSmsCountdown(btn, sec) {
    if (_smsCountdown) clearInterval(_smsCountdown);
    if (btn) btn.disabled = true;
    var left = sec;
    function tick() {
      if (left <= 0) {
        clearInterval(_smsCountdown);
        _smsCountdown = null;
        if (btn) { btn.disabled = false; btn.textContent = '获取验证码'; }
        return;
      }
      if (btn) btn.textContent = left + 's后重发';
      left--;
    }
    tick();
    _smsCountdown = setInterval(tick, 1000);
  }
  // ==== 设置页发码：复用阿里云无感验证 ====
  function extVcodeXhr(url, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('content-type', 'application/json;charset=UTF-8');
    xhr.setRequestHeader('platform', 'h5');
    try {
      var tok = state && state.token ? String(state.token) : '';
      if (tok) { if (tok.indexOf('Bearer ') === 0) tok = tok.slice(7); xhr.setRequestHeader('authorization', 'Bearer ' + tok); }
    } catch (e) {}
    xhr.onload = function () {
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) { d = { code: -1, message: '返回异常' }; }
      cb(d);
    };
    xhr.onerror = function () { cb({ code: -1, message: '网络错误' }); };
    try { xhr.send(JSON.stringify(body)); } catch (e) { cb({ code: -1, message: '发送异常' }); }
  }
  function extVcodeSendWithCaptcha(ctx, p) {
    var ops = (ctx.ops && ctx.ops.length) ? ctx.ops : [ctx.op == null ? 2 : ctx.op];
    var urlsV2 = [ 'https://api.123278.com/b/api/user/get_vCodeV2' ];
    var u2 = 0, o2 = 0, lastMsg = '';
    function onOk() {
      _smsSending = false;
      try { ctx.setMsg('验证码已发送，请注意查收'); } catch (e) {}
      if (ctx.login) { startSmsCountdown(_smsBtnRef, 60); }
      else if (ctx.btn) { startSmsCountdown(ctx.btn, 60); }
      _extSmsCtx = null;
    }
    function onFail(msgOverride) {
      _smsSending = false;
      try { ctx.setMsg('发码失败：' + (msgOverride ? String(msgOverride).slice(0, 60) : (lastMsg || '请稍后重试'))); } catch (e) {}
      if (ctx.btn) ctx.btn.disabled = false;
      if (ctx.login && _smsBtnRef) _smsBtnRef.disabled = false;
      _extSmsCtx = null;
    }
    (function nextV2() {
      if (u2 >= urlsV2.length) { onFail(''); return; }
      if (o2 >= ops.length) { u2++; o2 = 0; nextV2(); return; }
      var opV = ops[o2++];
      var body = { operation: opV, passport: ctx.phone, platformAttr: 'web', captcha: p, sceneId: 'nqiwjmw1' };
      extVcodeXhr(urlsV2[u2], body, function (d) {
        try { extDbgPush({ u: 'XHR POST ' + String(urlsV2[u2]).slice(0, 150), ok: !!(d && (d.code === 0 || d.code === 200)), raw: d ? JSON.stringify(d).slice(0, 900) : '', req: JSON.stringify(body) }); } catch (e) {}
        if (d && (d.code === 0 || d.code === 200)) {
          var _dd = d && (d.data || d.Data);
          state.vcodeInfo = { timestamp: (_dd && _dd.timestamp) != null ? _dd.timestamp : Math.floor(Date.now() / 1000), serial_no: (_dd && _dd.serial_no) || '' };
          onOk();
          return;
        }
        var m = d && (d.message || d.Message || d.error || d.Error);
        if (m) lastMsg = String(m);
        nextV2();
      });
    })();
  }

  // 设置页统一入口：安全验证中… → 验证码发送中… → 已发送/失败（带 60s 倒计时）
  function extRequestSmsCode(phone, btn, setMsg, op) {
    phone = String(phone || '').trim();
    setMsg = setMsg || function () {};
    if (!/^1\d{10}$/.test(phone)) { setMsg('请输入正确的11位手机号'); return; }
    if (btn && btn.disabled) return;
    if (!window.initAliyunCaptcha) {
      // SDK 未加载：直连兜底
      if (btn) btn.disabled = true;
      extApiTry(buildVcodeCands(phone, ((Array.isArray(op) && op.length) ? op : [op == null ? 2 : op]).concat([null, 4])), function (d, err) {
        if (!d) { setMsg('发码失败：' + (err ? String(err).slice(0, 60) : '接口不可用')); if (btn) btn.disabled = false; return; }
        setMsg('验证码已发送，请注意查收');
        if (btn) startSmsCountdown(btn, 60);
      });
      return;
    }
    var _opsArr = (Array.isArray(op) && op.length) ? op : [op == null ? 2 : op];
    _extSmsCtx = { phone: phone, btn: btn || null, setMsg: setMsg, op: _opsArr[0], ops: _opsArr, login: false };
    setMsg('安全验证中…');
    if (btn) btn.disabled = true;
    var ctxRef = _extSmsCtx;
    setTimeout(function () {
      if (_extSmsCtx !== ctxRef) return;   // 已完成/已切换
      _smsSending = false;
      try { setMsg('验证已取消，请重试'); } catch (e) {}
      if (btn) btn.disabled = false;
      _extSmsCtx = null;
    }, 30000);
    ensureCaptchaReady(function () {
      if (_captchaInst) {
        try { _captchaInst.startTracelessVerification(); }
        catch (e) {
          setMsg('验证触发失败，请重试');
          if (btn) btn.disabled = false;
          _extSmsCtx = null;
        }
      }
    });
  }
  // 验证码登录：直连（type:3），不再提供官方页入口
  function doSmsLogin() {
    var phone = $('sms-phone').value.trim();
    var code = $('sms-code').value.trim();
    if (!/^1\d{10}$/.test(phone)) { $('login-msg-sms').textContent = '请输入正确的11位手机号'; return; }
    if (!/^\d{4,6}$/.test(code)) { $('login-msg-sms').textContent = '请输入验证码'; return; }
    var btn = $('sms-login-btn');
    if (!btn) return;
    btn.disabled = true;
    $('login-msg-sms').textContent = '登录中...';
    api('POST', API.vcodeSignIn,
      JSON.stringify({ type: 3, passport: phone, vcode: code }),
      false,
      function (d) {
        btn.disabled = false;
        var tok = d && d.data ? (d.data.token || d.data.authorization || '') : '';
        if (tok) {
          if (tok.indexOf('Bearer ') === 0) tok = tok.slice(7);
          state.token = tok;
          state.user = phone;
          addAccount(phone, tok, '');
          if (bridge && bridge.saveSession) { bridge.saveSession(tok, phone, ''); }
          var wasAdd = pendingAddAccount;
          pendingAddAccount = false;
          toast(wasAdd ? '账号已添加' : '登录成功');
          if (_smsCountdown) { clearInterval(_smsCountdown); _smsCountdown = null; }
          var sb = $('sms-send-btn');
          if (sb) { sb.disabled = false; sb.textContent = '获取验证码'; }
          enterMain();
        } else {
          var _d2;
          try { _d2 = JSON.stringify(d); } catch (e) { _d2 = String(d); }
          if (_d2 && _d2.length > 200) _d2 = _d2.slice(0, 200) + '…';
          $('login-msg-sms').textContent = '登录失败[' + ((d && d.message) ? d.message : ('code=' + (d && d.code != null ? d.code : '?'))) + '] 返回:' + _d2;
        }
      });
  }

  function enterMain() {
    hide($('page-login'));
    show($('page-main'));
    switchView('files');
    // 进入主界面后：先拉深链并处理，再退回剪贴板识别
    setTimeout(function () {
      try {
        checkDeepLinkFromNative();
        if (pendingShareUrl) { openPendingShareUrl(); return; }
        scheduleClipboardCheck();
      } catch (e) {}
    }, 350);
  }

  window.__onAppPause = function () {};
  // App 回前台：重新判定夜间模式 + 先拉深链并处理，再退回剪贴板识别
  window.__onAppResume = function () {
    try {
      applyTheme();   // 用户可能刚从系统设置里切了深色模式
      // 从后台回到前台：视为“用户又去点了一次”，允许同一链接重新打开
      _handledDeepLinkUrl = '';
      checkDeepLinkFromNative();
      if (pendingShareUrl) { openPendingShareUrl(); return; }
      scheduleClipboardCheck();
    } catch (e) {}
  };

  window.__restoreSession = function (token, user) {
    if (token) {
      state.token = token;
      state.user = user || '';
      if (state.user) {
        try {
          var _list = loadAccounts();
          var _hit = false;
          for (var _i = 0; _i < _list.length; _i++) {
            if (_list[_i].user === state.user) {
              _list[_i].token = token;
              _hit = true;
              break;
            }
          }
          if (!_hit) _list.unshift({ user: state.user, token: token, pass: '', downloads: [], uploads: [] });
          saveAccounts(_list);
          setCurrentAccountUser(state.user);
          try { renderAccountList(); } catch (e) {}
        } catch (e) {}
      }
      enterMain();
    }
  };

  // ---------- 网页链接调用（深链）：把外部点开的 123云盘 分享链接送进「接收分享」 ----------
  var pendingShareUrl = '';
  var _lastDeepLinkUrl = '';      // 深链短时去重用
  var _lastDeepLinkAt = 0;
  // 原生在 WebView 加载完成后注入：window.__openShareUrl('<url>')
  window.__openShareUrl = function (url) {
    if (!url) return;
    var s = String(url);
    // 短时去重：onPageFinished 可能多次触发，同一链接 3 秒内只处理一次（隔久后重扑仍可打开）
    var now = Date.now();
    if (s === _lastDeepLinkUrl && (now - _lastDeepLinkAt) < 3000) return;
    _lastDeepLinkUrl = s;
    _lastDeepLinkAt = now;
    pendingShareUrl = s;
    // 原生注入与 __restoreSession 同批，延后处理，等登录态恢复 / 主界面就绪
    setTimeout(function () { try { openPendingShareUrl(); } catch (e) {} }, 400);
  };
  // 兼容命名（原生侧若按 __onDeepLink 注入也可用）
  window.__onDeepLink = function (url) { window.__openShareUrl(url); };
  // 友盟 U-Link（网页「APP查看」按钮）深链解析。
  // 网页实际唤起地址（由 c.umsns.com/deeplink/init 下发，type=scheme）：
  //   pan://umeng.com/share/list?_ukid=xxx&sharePwd=by1p&_sdk_=umeng
  //       &_linkid_=usr1ke01qbgngpn9&action=share_list&shareKey=fyr3jv-iIym&_bizType_=ushare
  // 关键参数：shareKey（分享码整串）、sharePwd（提取码）、action
  function parseUmengDeepLink(raw) {
    var s = String(raw || '').trim();
    if (!/^pan:/i.test(s)) return null;
    var q = s.split('?')[1] || '';
    if (!q) return null;
    q = q.replace(/&amp;/g, '&');
    var o = {};
    q.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i >= 0 ? kv.slice(0, i) : kv;
      var v = i >= 0 ? kv.slice(i + 1) : '';
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
      if (k) o[k] = v;
    });
    var key = o.shareKey || o.share_key || '';
    if (!key) return null;
    return { key: key, pwd: o.sharePwd || o.share_pwd || o.pwd || '', action: o.action || '' };
  }
  // 统一解析：优先 U-Link pan:// 深链，其次按普通分享链接/分享码解析
  // ==================== 跨盘模块适配层（实现细节在 crosspan.js，与此处解耦） ====================
  function crossInit() {
    if (!window.CrossPan) return false;
    window.CrossPan.init({
      api: function (m, u, b, a, cb) { api(m, u, b, a, cb); },
      bridge: (typeof bridge !== 'undefined' ? bridge : null),
      $: function (id) { return $(id); },
      esc: function (v) { return esc(v); },
      fmtSize: function (n) { return fmtSize(n); },
      toast: function (m) { toast(m); },
      openCover: function (id) { extOpenCover(id); },
      closeCover: function (id) { extCloseCover(id); },
      prompt: function (t, v, cb) { openExtPrompt(t, v, cb); },
      // 复用 123 的文件图标：返回图标名 + 直接产出图标节点
      iconName: function (name, isDir) {
        try {
          if (isDir) return 'foler';
          return iconFor({ FileName: String(name || '') });
        } catch (e) { return isDir ? 'foler' : 'unknown_file'; }
      },
      iconNode: function (name, isDir) {
        try { return makeIcon(isDir ? 'foler' : iconFor({ FileName: String(name || '') }), 'file-icon'); }
        catch (e) { return null; }
      },
      dbg: function (u, raw, req) { try { extDbgPush({ u: u, ok: true, raw: String(raw || '').slice(0, 700), req: String(req || '').slice(0, 300) }); } catch (e) {} },
      transfers: {
        add: function (t) { try { addTransfer(t); } catch (e) {} },
        save: function () { try { saveTransfers(); } catch (e) {} },
        render: function () { try { renderTransfers(); } catch (e) {} },
        list: function () { return state.transfers || []; },
        isView: function () { return state.view === 'transfers'; }
      }
    });
    window.CrossPan.bindUI();
    // 原生跨盘下载进度/结果回传
    window.__onCrossProgress = function (tid, pct, done, total) { try { window.CrossPan.onProgress(tid, pct, done, total); } catch (e) {} };
    window.__onCrossResult = function (tid, ok, msg) { try { window.CrossPan.onResult(tid, ok, msg); } catch (e) {} };
    return true;
  }
  function crossDetect(str) { return (window.CrossPan && window.CrossPan.detect) ? window.CrossPan.detect(str) : ''; }
  function crossOpenFromUrl(raw) { return (window.CrossPan && window.CrossPan.handleUrl) ? window.CrossPan.handleUrl(raw) : false; }
  function crossOpen() { if (window.CrossPan) window.CrossPan.open(); }
  function crossDownloadSel() { if (window.CrossPan) window.CrossPan.download(); }
  function crossCookiePrompt() { if (window.CrossPan) window.CrossPan.login(); }

  function parseDeepLink(raw) {
    return parseUmengDeepLink(raw) || parseShareKey(raw);
  }
  function openPendingShareUrl() {
    if (!pendingShareUrl) return;
    // 未登录（还在登录页）时先暂存：enterMain() / 轮询 会再次调用，不会丢链接
    var mainPage = $('page-main');
    if (!mainPage || mainPage.classList.contains('hidden')) return;
    var raw = pendingShareUrl;
    pendingShareUrl = '';
    // 记下“已处理过的链接”：原生 consume 若不生效，也不会在返回上一页时又弹一次
    _handledDeepLinkUrl = raw;
    // 消费由 JS 在“已确认处理完”之后触发；无法解析也消费，避免轮询空转
    consumeDeepLink();
    if (crossDetect(String(raw))) { try { crossOpenFromUrl(raw); } catch (e) {} return; }
    var parsed = parseDeepLink(raw);
    if (!parsed || !parsed.key) { toast('分享链接无法解析：' + String(raw).slice(0, 60)); return; }
    var linkEl = $('receive-link');
    if (linkEl) linkEl.value = raw;
    var pwdEl = $('receive-pwd');
    if (pwdEl) pwdEl.value = parsed.pwd || '';
    openReceiveShare();
    shareState.key = parsed.key;
    shareState.pwd = parsed.pwd || '';
    shareState.stack = [];
    shareState.sel = {};
    toast('已打开分享链接');
    loadShareDir('0', 1);
  }

  // ---------- 剪贴板识别：复制分享链接后打开/回到 App，弹确认条询问 ----------
  // 去重策略：命中后把「内容 + 时间」写进 localStorage；
  // 同一条在 CLIP_REMEMBER_MS 内不再弹（重启 App 也有效），超时后又能重新识别。
  var CLIP_SEEN_KEY = 'pan_clip_seen';
  var CLIP_REMEMBER_MS = 5 * 60 * 1000;   // 5 分钟
  var _clipPendingText = '';
  function clipMark(text) {
    try { localStorage.setItem(CLIP_SEEN_KEY, JSON.stringify({ t: String(text).slice(0, 300), at: Date.now() })); } catch (e) {}
  }
  function clipSeen(text) {
    try {
      var o = JSON.parse(localStorage.getItem(CLIP_SEEN_KEY) || '{}');
      return !!(o && o.t === String(text).slice(0, 300) && (Date.now() - (o.at || 0)) < CLIP_REMEMBER_MS);
    } catch (e) { return false; }
  }
  // 是否为 123云盘分享域名（精确匹配，避免任何 https 都被当成分享）
  function is123ShareHost(s) {
    var m = String(s).match(/^(?:https?):\/\/([^\/?#]+)/i);
    if (!m) return false;
    var host = m[1].toLowerCase().split(':')[0];
    if (!host) return false;
    return /(^|\.)share\.123pan\.(cn|com)$/.test(host)
        || /(^|\.)mshare\.123pan\.(cn|com)$/.test(host)
        || host === 'www.123pan.com' || host === 'www.123pan.cn'
        || host === '123pan.com' || host === '123pan.cn'
        || host === 'yun.123pan.cn' || host === 'yun.123pan.com';
  }
  // 判断剪贴板文本是否为「123云盘分享链接/分享码」——严判，普通文本一律不弹
  function looksLikeShareText(text) {
    if (!text) return false;
    var s = String(text).trim();
    if (!s || s.length > 3000) return false;        // 长文本不弹（跨盘 scheme 载荷可达 600+ 字符）
    // 多行散文本（超过 3 段）也不考虑
    if (/[\r\n]/.test(s) && s.split(/\s+/).filter(function (x) { return x; }).length > 3) return false;
    // 1) 友盟 U-Link 深链
    if (/^pan:\/\//i.test(s)) return true;
    // 2) URL：只认 123 分享域名（其他网址一律不弹）
    if (/^https?:\/\//i.test(s)) return is123ShareHost(s) || !!crossDetect(s);
    // 2b) 跨盘 App 专属 scheme（qkcloudlink:// uclink:// ...）
    if (/^(?:quark|qkcloudlink|uclink2?|ucweb|ucpro|ucdrive|cloud189):\/\//i.test(s)) return !!crossDetect(s);
    // 3) 整段就是一个分享码（123云盘的码一定是 「x-xxxx」形式），去掉“分享码/提取码：”前缀后严判：
    var t = s.replace(/^\s*(?:分享码|提取码|密码|链接)\s*[:：]?\s*/i, '').replace(/\s+$/, '');
    if (/^[A-Za-z0-9]{4,64}-[A-Za-z0-9]{1,32}$/.test(t)) return true;
    // 4) 分享码 + 提取码（例：“UzfMvd 提取码：Xknuh”）
    if (/^[A-Za-z0-9]{4,64}\s+(?:提取码|密码|pwd)\s*[:：]?\s*[A-Za-z0-9]{1,16}$/i.test(t)) return true;
    // 其余（含“段落里出现 123 / 123云盘 / 提取码 等字样”）一律不弹
    return false;
  }
  function tryAutoOpenFromClipboard() {
    try {
      if (!bridge || !bridge.getClipboardText) return;      // 原生无此方法则跳过
      var mainPage = $('page-main');
      if (!mainPage || mainPage.classList.contains('hidden')) return;   // 未登录不打扰
      var raw = bridge.getClipboardText();
      if (!raw) return;
      var cm = $('clip-modal');
      if (cm && !cm.classList.contains('hidden')) return;   // 已在询问中，不重复打扰
      var text = String(raw).trim();
      if (!looksLikeShareText(text)) return;
      if (clipSeen(text)) return;                           // 同一条已处理过，不再弹
      // 跨盘链接（夸克/UC）：直接交给跨盘模块，不走 123 接收分享
      try {
        if (window.CrossPan && window.CrossPan.detect(text)) {
          clipMark(text);
          window.CrossPan.handleUrl(text);
          return;
        }
      } catch (e) {}
      var rp = $('page-receive');
      if (rp && !rp.classList.contains('hidden')) return;   // 已在接收分享页则不打扰
      var parsed = parseDeepLink(text);
      if (!parsed || !parsed.key) return;
      clipMark(text);   // 一出现就记账：无论点确认还是取消，都不会再重复弹
      showClipConfirm(text);
    } catch (e) { /* 静默失败，不影响正常使用 */ }
  }
  // 弹剪贴板链接确认条
  function showClipConfirm(text) {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    _clipPendingText = text;
    var el = $('clip-text');
    if (el) el.textContent = text;
    show($('clip-modal'));
  }
  function hideClipConfirm() {
    hide($('clip-modal'));
    _clipPendingText = '';
  }
  // 确认：进入接收分享页，后续浏览/下载/转存流程照旧
  function confirmClipText() {
    var text = _clipPendingText;
    hideClipConfirm();
    if (!text) return;
    try {
      if (window.CrossPan && window.CrossPan.detect(text)) { window.CrossPan.handleUrl(text); return; }
    } catch (e) {}
    var parsed = parseDeepLink(text);
    if (!parsed || !parsed.key) { toast('分享链接无法解析'); return; }
    var linkEl = $('receive-link');
    if (linkEl) linkEl.value = text;
    var pwdEl = $('receive-pwd');
    if (pwdEl) pwdEl.value = parsed.pwd || '';
    openReceiveShare();
    shareState.key = parsed.key;
    shareState.pwd = parsed.pwd || '';
    shareState.stack = [];
    shareState.sel = {};
    loadShareDir('0', 1);
  }
  // 剪贴板识别调度：进主界面 / 回前台各读一次，1.6s 后再补一次。
  // 补试原因：Android 10+ 只有应用获得前台焦点后才能读剪贴板，首帧可能读不到。
  function scheduleClipboardCheck() {
    tryAutoOpenFromClipboard();
    setTimeout(function () { try { tryAutoOpenFromClipboard(); } catch (e) {} }, 1600);
  }

  // ---------- 网页链接调用（拉取式）：主动向原生取启动 Intent 里的 pan:// 深链 ----------
  // 为什么用拉取而不用原生注入：注入需要在 WebViewClient 里改已有方法，风险大；
  // 拉取只需原生新增一个只读方法，JS 侧调用失败也有 try/catch 兜底。
  // 从原生“读取”（不消费）启动 Intent 里的深链，暂存到 pendingShareUrl。
  // 关键：这里只读不清，未登录 / 解析失败都不会丢链接；消费由 openPendingShareUrl() 负责。
  var _handledDeepLinkUrl = '';   // 已处理过的深链，避免轮询/返回上一页时重复弹
  function checkDeepLinkFromNative() {
    try {
      if (!bridge || (!bridge.getStartUrl && !bridge.getPendingDeepUrl)) return;
      var raw = '';
      try { raw = bridge.getStartUrl() || ''; } catch (e) { raw = ''; }
      if (!raw) { try { raw = (bridge.getPendingDeepUrl ? bridge.getPendingDeepUrl() : '') || ''; } catch (e) { raw = ''; } }
      if (!raw) return;
      var s = String(raw).trim();
      if (!s) return;
      if (s === pendingShareUrl) return;          // 同一链接已在等待处理
      if (s === _handledDeepLinkUrl) return;      // 已处理过：不再重复弹
      pendingShareUrl = s;
      // 读到就立刻处理（不必等下一次轮询）：跨盘 scheme 也能即时打开
      var mainPage = $('page-main');
      if (mainPage && !mainPage.classList.contains('hidden')) {
        try { openPendingShareUrl(); } catch (e) {}
      }
    } catch (e) { /* 静默失败，不影响正常使用 */ }
  }
  // 消费深链：清空原生 Intent.data，之后 getStartUrl() 返回空串
  function consumeDeepLink() {
    try { if (bridge && bridge.mcpConsumeDeepLink) bridge.mcpConsumeDeepLink(); } catch (e) {}
  }
  // （深链轮询兜底已合并进上方主题轮询的同一个 1.5s 节拍）

  // ---------- 文件列表 ----------
  function renderBreadcrumb() {
    var box = $('breadcrumb');
    if (!box) return;
    box.innerHTML = '';
    var root = document.createElement('span');
    root.className = 'crumb' + (state.currentDir === 0 ? ' active' : '');
    root.textContent = '全部文件';
    root.addEventListener('click', function () {
      if (state.currentDir !== 0) { 
        state.currentDir = 0; 
        state.breadcrumb = []; 
        loadList();
        var scrollArea = $('scroll-area');
        if (scrollArea) scrollArea.scrollTop = 0;
      }
    });
    box.appendChild(root);
    state.breadcrumb.forEach(function (c, i) {
      var sep = document.createElement('span'); 
      sep.className = 'sep'; 
      sep.textContent = '›';
      var crumb = document.createElement('span');
      crumb.className = 'crumb' + (i === state.breadcrumb.length - 1 ? ' active' : '');
      crumb.textContent = c.name;
      crumb.addEventListener('click', function () {
        if (i < state.breadcrumb.length - 1) {
          state.breadcrumb = state.breadcrumb.slice(0, i + 1);
          state.currentDir = c.id;
          loadList();
          var scrollArea = $('scroll-area');
          if (scrollArea) scrollArea.scrollTop = 0;
        } else if (state.jumpReturn) {
          // 跳转定位后的“原位搜索结果”：点末级面包屑 = 回到该目录列表
          state.jumpReturn = false;
          state.breadcrumb = state.breadcrumb.slice(0, i + 1);
          state.currentDir = c.id;
          loadList();
          var sa2 = $('scroll-area');
          if (sa2) sa2.scrollTop = 0;
        }
      });
      box.appendChild(sep);
      box.appendChild(crumb);
    });
  }

  function getCurrentPath() {
    if (state.currentDir === 0 && state.breadcrumb.length === 0) {
      return '全部文件';
    }
    var parts = ['全部文件'];
    state.breadcrumb.forEach(function(c) {
      parts.push(c.name);
    });
    return parts.join(' › ');
  }

  // 已回退到最初默认行为：不缓存目录、不记忆滚动位置，每次加载都从顶部开始。
  function loadList() {
    try { clearJumpHighlight(); } catch (e) {}
    renderBreadcrumb();
    var box = $('file-list');
    var summaryContainer = $('search-summary-container');
    if (summaryContainer) summaryContainer.innerHTML = '';
    
    var pathDisplay = $('path-display');
    if (pathDisplay) {
      pathDisplay.style.display = 'none';
    }

    // 从子目录返回：把上次离开时摘下的真实节点直接放回（不重建 → 没有滚动/跳动，监听器也都在）
    var _snapKey = String(state.currentDir);
    var _snap = state.dirSnap && state.dirSnap[_snapKey];
    if (_snap && (Date.now() - (_snap.at || 0)) < 60000 && restoreDirSnapshot(_snapKey)) {
      hideToolbar();
      setTimeout(function () { updateToolbarVisibility('files'); }, 100);
      return;
    }

    // 原地操作（复制/移动）：保留旧列表不闪、并记住滚动位置
    var saKeep = $('scroll-area');
    var keepPos = !!state.keepScroll;
    var savedTop = (saKeep && keepPos) ? saKeep.scrollTop : 0;

    box.dataset.loaded = '1';
    if (!keepPos) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    var params = 'driveId=0&limit=200&next=0&orderBy=' + curOrderBy + '&orderDirection=' + curOrderDir
      + '&parentFileId=' + state.currentDir + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      if (d && d.data && d.data.InfoList) {
        renderList(d.data.InfoList, d.data.Total);
        state.dirInView = String(state.currentDir);
      } else {
        box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="foler"></div><p>加载失败或需重新登录</p></div>';
        injectIcons(box);
      }
      // 新目录（前进）从顶部开始；复制/移动等原地操作精确恢复滚动位置
      var sa = $('scroll-area');
      if (sa && !state.searching) sa.scrollTop = keepPos ? savedTop : 0;
      state.keepScroll = false;
      setTimeout(function() { updateToolbarVisibility('files'); }, 100);
    });
  }
var _lastRenderAt = 0;   // 上次渲染时间（用于抑制重复入场动画）

function renderList(list, total) {
  var box = $('file-list');
  var summaryContainer = $('search-summary-container');
  if (summaryContainer) summaryContainer.innerHTML = '';
  var gridMode = (curViewMode === 'grid');
  box.classList.toggle('grid', gridMode);
  // 关掉 fadeIn 的三种情形（否则每张卡片的 translateY(6px)→0 重播，整列上下抖一下）：
  //   1) 上一批已经有卡片 → 属于「原地重绘」（进/退多选、全选、复制移动后刷新）
  //   2) 距上次渲染 600ms 内
  //   3) 正处在多选模式
  // 只有「真正换目录」（上一批是加载中/空）才保留入场动画。
  var _hadCards = box.querySelectorAll('.file-card').length > 0;
  var _nowAt = Date.now();
  box.classList.toggle('no-anim', _hadCards || (_nowAt - _lastRenderAt) < 600 || !!state.selectMode);
  _lastRenderAt = _nowAt;
  state.lastList = list || [];
  box.innerHTML = '';
  if (!list || !list.length) {
    box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="foler"></div><p>此目录为空</p></div>';
    injectIcons(box);
    return;
  }
  
  var isSelect = state.selectMode;
  var ckIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  
  list.forEach(function (item) {
    var isSel = !!state.selectedMap[item.FileId];
    var card = document.createElement('div');
    card.className = 'file-card' + (isSel ? ' selected' : '') + (gridMode ? ' grid-card' : '');
    card.setAttribute('data-fid', item.FileId);
    // 离线任务「跳转到位置」后的高亮
    if (state.highlightFid && String(item.FileId) === String(state.highlightFid)) card.classList.add('hl-jump');
    else if (!state.highlightFid && state.highlightName && (item.FileName || '') === state.highlightName) card.classList.add('hl-jump');
    
    if (isSelect) {
      var ck = document.createElement('div');
      ck.className = 'file-check' + (isSel ? ' checked' : '');
      if (isSel) ck.innerHTML = ckIcon;
      card.appendChild(ck);
    }
    
    // --- 修改后的代码 ---
var iconWrap = document.createElement('div');
var iconEl;

// 判断是否为图片文件（扩展名集合已统一维护）
var isImage = isImgExt(item.FileName);





if (isImage) {
    // 如果是图片，创建一个 img 标签
    iconEl = document.createElement('img');
    iconEl.className = 'file-icon';
    iconEl.alt = item.FileName || '';
    // 设置一个默认的通用图片图标，防止缩略图加载失败
iconEl.src = 'data:image/svg+xml;base64,PHN2ZyB2ZXJzaW9uPSIxLjIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDUwIDUwIiB3aWR0aD0iNTAiIGhlaWdodD0iNTAiPgoJPHN0eWxlPgoJCS5zMCB7IGZpbGw6ICNlNmY5ZWYgfSAKCQkuczEgeyBmaWxsOiBub25lO3N0cm9rZTogIzI3YWU2MDtzdHJva2UtbGluZWNhcDogcm91bmQ7c3Ryb2tlLWxpbmVqb2luOiByb3VuZDtzdHJva2Utd2lkdGg6IDIgfSAKCQkuczIgeyBmaWxsOiAjMjdhZTYwO3N0cm9rZTogIzI3YWU2MDtzdHJva2UtbGluZWNhcDogcm91bmQ7c3Ryb2tlLWxpbmVqb2luOiByb3VuZDtzdHJva2Utd2lkdGg6IDIgfSAKCTwvc3R5bGU+Cgk8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsYXNzPSJzMCIgZD0ibTAtOGg1MGM0LjQyIDAgOCAzLjU4IDggOHY1MGMwIDQuNDItMy41OCA4LTggOGgtNTBjLTQuNDIgMC04LTMuNTgtOC04di01MGMwLTQuNDIgMy41OC04IDgtOHoiLz4KCTxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xhc3M9InMxIiBkPSJtMTggMTZoMTRjMS4xIDAgMiAwLjkgMiAydjE0YzAgMS4xLTAuOSAyLTIgMmgtMTRjLTEuMSAwLTItMC45LTItMnYtMTRjMC0xLjEgMC45LTIgMi0yeiIvPgoJPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGFzcz0iczIiIGQ9Im0yMS41IDIzYy0wLjgzIDAtMS41LTAuNjctMS41LTEuNSAwLTAuODMgMC42Ny0xLjUgMS41LTEuNSAwLjgzIDAgMS41IDAuNjcgMS41IDEuNSAwIDAuODMtMC42NyAxLjUtMS41IDEuNXoiLz4KCTxwYXRoIGNsYXNzPSJzMSIgZD0ibTM0IDI4bC01LTUtMTEgMTEiLz4KPC9zdmc+';

// ...
// 找到类似这行代码

// 修改为（追加 is-image-preview）
iconWrap.className = 'file-icon-wrap fi-image is-image-preview';




    // 缩略图：优先用本地缓存的图片内容，其次用带缓存的直链
    (function (it, el) {
      var id = it.FileId || it.fileId;
      cacheGet(id, function (c) {
        if (c && c.kind === 'image' && c.data) { el.src = c.data; return; }
        getFileLinkCached(it, function (link) { if (link) el.src = previewSrc(link); });
      });
    })(item, iconEl);

} else {
    // 如果不是图片，保持原有逻辑，使用SVG图标
    iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
    iconEl = makeIcon(iconFor(item), 'file-icon');
}

iconWrap.appendChild(iconEl);

    
    var body = document.createElement('div');
    body.className = 'file-body';
    var name = document.createElement('div');
    name.className = 'file-name';
    var _nm = item.FileName || '未命名';
    if (gridMode && _nm.length > 15) {
      // 平铺模式：15 个字符后换行
      var _lines = [];
      for (var _ci = 0; _ci < _nm.length; _ci += 15) _lines.push(_nm.slice(_ci, _ci + 15));
      name.textContent = _lines.join('\n');
    } else {
      name.textContent = _nm;
    }
    
    var meta = document.createElement('div');
    meta.className = 'file-meta';
    
    var isDir = (item.Type === 1 || item.Type === '1');
    var timeText = item.UpdateAt || item.UpdateTime || item.updateAt || item.updateTime || '';
    
    if (timeText && timeText.includes('T')) {
      try {
        var d = new Date(timeText);
        if (!isNaN(d.getTime())) {
          var year = d.getFullYear();
          var month = String(d.getMonth() + 1).padStart(2, '0');
          var day = String(d.getDate()).padStart(2, '0');
          var hours = String(d.getHours()).padStart(2, '0');
          var mins = String(d.getMinutes()).padStart(2, '0');
          timeText = year + '-' + month + '-' + day + ' ' + hours + ':' + mins;
        }
      } catch (e) { /* 保持原样 */ }
    }
    
    if (isDir) {
      meta.textContent = timeText || '';
    } else {
      var sizeText = fmtSize(item.Size) || '';
      meta.textContent = sizeText + (timeText ? '  -' + timeText : '');
    }
    
    body.appendChild(name);
    body.appendChild(meta);
    
    card.appendChild(iconWrap);
    card.appendChild(body);
    
    // 判断文件类型用于预览（统一扩展名集合）
    var isImage = isImgExt(item.FileName);
    var isVideo = isVidExt(item.FileName);
    var isAudio = isAudExt(item.FileName);
    var isText = isTxtExt(item.FileName);
    var isPdf = isPdfExt(item.FileName);
    var isDoc = isDocExt(item.FileName);
    var isXls = isXlsExt(item.FileName);
    var isZip = isZipLikeExt(item.FileName);
    var isArchO = isArchOtherExt(item.FileName);
    var canPreview = isImage || isVideo || isAudio || isText || isPdf || isDoc || isXls || isZip || isArchO;
    
    if (isSelect) {
      card.addEventListener('click', function (e) {
        toggleSelect(item);
      });
    } else if (isDir) {
      card.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!$('action-sheet').classList.contains('hidden')) {
          closeSheet();
          return;
        }
        openDir(item);
      });
      var longPressTimer = null;
      card.addEventListener('touchstart', function (e) {
        longPressTimer = setTimeout(function() {
          if (bridge && bridge.vibrate) bridge.vibrate(30);
          openActionSheet(item);
        }, 500);
      });
      card.addEventListener('touchend', function (e) {
        clearTimeout(longPressTimer);
      });
      card.addEventListener('touchmove', function (e) {
        clearTimeout(longPressTimer);
      });
      card.addEventListener('mousedown', function (e) {
        longPressTimer = setTimeout(function() {
          openActionSheet(item);
        }, 500);
      });
      card.addEventListener('mouseup', function (e) {
        clearTimeout(longPressTimer);
      });
      card.addEventListener('mouseleave', function (e) {
        clearTimeout(longPressTimer);
      });
    } else {
      // 文件：长按进入多选；点击图标预览，点击其他区域弹出菜单
      var _lpTimer = null, _lpFired = false;
      card.addEventListener('touchstart', function () {
        _lpFired = false;
        _lpTimer = setTimeout(function () {
          _lpFired = true;
          if (bridge && bridge.vibrate) bridge.vibrate(30);
          enterSelectMode(item);        // 长按 → 进入多选并选中该项
        }, 500);
      }, { passive: true });
      card.addEventListener('touchend', function () { clearTimeout(_lpTimer); });
      card.addEventListener('touchmove', function () { clearTimeout(_lpTimer); });
      card.addEventListener('mousedown', function () {
        _lpFired = false;
        _lpTimer = setTimeout(function () { _lpFired = true; enterSelectMode(item); }, 500);
      });
      card.addEventListener('mouseup', function () { clearTimeout(_lpTimer); });
      card.addEventListener('mouseleave', function () { clearTimeout(_lpTimer); });
      card.addEventListener('click', function (e) {
        if (_lpFired) { _lpFired = false; return; }   // 长按已处理，吞掉随后的 click
        e.stopPropagation();
        if (!$('action-sheet').classList.contains('hidden')) {
          closeSheet();
          return;
        }
        var target = e.target;
        var isIconClick = false;
        while (target && target !== card) {
          if (target.classList && target.classList.contains('file-icon-wrap')) {
            isIconClick = true;
            break;
          }
          target = target.parentNode;
        }
        
        if (isIconClick && canPreview) {
          if (isImage) {
            previewImage(item);
          } else if (isVideo) {
            previewVideo(item);
          } else if (isAudio) {
            previewAudio(item);
          } else if (isText) {
            previewTextFile(item);
          } else if (isPdf) {
            previewPdf(item);
          } else if (isDoc) {
            previewDocx(item);
          } else if (isXls) {
            previewXlsx(item);
          } else if (isZip) {
            previewArchive(item);
          } else if (isArchO) {
            previewArchiveOther(item);
          }
        } else {
          openActionSheet(item);
        }
      });
    }
    
    box.appendChild(card);
  });
  
  if (isSelect) refreshSelectBar();
  var _hlRow = box.querySelector('.file-card.hl-jump');
  if (_hlRow) { try { _hlRow.scrollIntoView({ block: 'center' }); } catch (e) { try { _hlRow.scrollIntoView(); } catch (e2) {} } }
}
  // ---------- 排序（逻辑移植自 123.apk，交互改为锚定小卡片） ----------
  var SORT_KEY = 'pan_sort';
  var _sortPref = (function () { try { return JSON.parse(localStorage.getItem(SORT_KEY) || '{}') || {}; } catch (e) { return {}; } })();
  var curOrderBy = _sortPref.by || 'file_id';
  var curOrderDir = _sortPref.dir || 'desc';
  // 展示方式：主页与搜索页各自独立，默认都是「列表」
  var curViewMode = _sortPref.view || 'list';          // 主页：list | grid
  var curSearchViewMode = _sortPref.sview || 'list';   // 搜索页：与主页分开
  function saveSortPref() {
    try { localStorage.setItem(SORT_KEY, JSON.stringify({ by: curOrderBy, dir: curOrderDir, view: curViewMode, sview: curSearchViewMode })); } catch (e) {}
  }
  function renderSortPop() {
    document.querySelectorAll('#sort-fields .sort-opt').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-by') === curOrderBy);
    });
    document.querySelectorAll('#sort-dir .sd-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-dir') === curOrderDir);
    });
    // 高亮哪一个展示方式，取决于卡片是从主页还是搜索页打开的
    var _vm = (state.sortCtx === 'search') ? curSearchViewMode : curViewMode;
    document.querySelectorAll('#sort-view .sd-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === _vm);
    });
  }
  function openSortPop(anchor, isSearch) {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    state.sortCtx = isSearch ? 'search' : 'files';
    renderSortPop();
    var btn = anchor || $('sort-btn'), card = $('sort-card');
    if (btn && card) {
      var r = btn.getBoundingClientRect();
      card.style.top = Math.round(r.bottom + 6) + 'px';
      card.style.right = Math.round(Math.max(12, window.innerWidth - r.right)) + 'px';
    }
    show($('sort-pop'));
  }
  function hideSortPop() { hide($('sort-pop')); }
  function applySort(by, dir, view) {
    if (by) curOrderBy = by;
    if (dir) curOrderDir = dir;
    if (view) {
      // 按当前上下文写入对应页面的展示方式
      if (state.sortCtx === 'search') curSearchViewMode = view;
      else curViewMode = view;
    }
    saveSortPref();
    hideSortPop();
    if (state.searching) doSearch(state.searchKeyword);   // 搜索中则重跑搜索
    else loadList();
  }
  // 全选当前列表
  function selectAllItems() {
    if (!state.selectMode) return;
    var list = state.lastList || [];
    list.forEach(function (it) { state.selectedMap[it.FileId] = it; });
    renderList(state.lastList || []);
    refreshSelectBar();
  }
  // 搜索摘要行右侧的排序按钮
  function makeSortInlineBtn() {
    var b = document.createElement('span');
    b.className = 'sort-inline';
    b.setAttribute('data-icon', 'sort');
    applySvg(b, 'sort');
    b.addEventListener('click', function (e) { e.stopPropagation(); openSortPop(b, true); });
    return b;
  }

  // ---------- 全局搜索 ----------
  function doSearch(keyword) {
    keyword = (keyword || '').trim();
    if (!keyword) { exitSearch(); return; }
    
    state.searching = true;
    state.searchKeyword = keyword;
    
    var box = $('file-list');
    var summaryContainer = $('search-summary-container');
    if (summaryContainer) summaryContainer.innerHTML = '';
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    
    var breadcrumbContainer = $('breadcrumb-container');
    if (breadcrumbContainer) breadcrumbContainer.style.display = 'none';
    var pathDisplay = $('path-display');
    if (pathDisplay) {
      pathDisplay.style.display = 'block';
      pathDisplay.textContent = '搜索: ' + keyword;
    }
    
    // 收起键盘
    var input = $('search-input');
    if (input) {
      if (bridge && bridge.hideKeyboard) {
        bridge.hideKeyboard();
      }
      input.blur();
    }
    
    var params = 'driveId=0&limit=200&next=0&orderBy=' + curOrderBy + '&orderDirection=' + curOrderDir
      + '&parentFileId=0&trashed=false&Page=1&OnlyLookAbnormalFile=0'
      + '&SearchData=' + encodeURIComponent(keyword);
    api('GET', API.list + '?' + params, '', true, function (d) {
      if (d && d.data) {
        state.searchTotal = d.data.Total || 0;
        renderSearchResult(d.data.InfoList || [], state.searchTotal, keyword);
      } else {
        box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="search"></div><p>搜索失败或需重新登录</p></div>';
        injectIcons(box);
      }
      hideToolbar();
    });
  }
function renderSearchResult(list, total, kw) {
  var box = $('file-list');
  var summaryContainer = $('search-summary-container');
  var gridMode = (curSearchViewMode === 'grid');   // 搜索页用自己那套展示方式
  box.classList.toggle('grid', gridMode);
  
  box.innerHTML = '';
  
  if (summaryContainer) {
    summaryContainer.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'search-summary';
    var headText = document.createElement('span');
    headText.textContent = (list.length ? ('搜索「' + kw + '」共 ' + total + ' 项') : ('未找到「' + kw + '」相关文件'));
    head.appendChild(headText);
    head.appendChild(makeSortInlineBtn());   // 右侧排序按钮（含展示方式）
    summaryContainer.appendChild(head);
  }
  
  if (!list || !list.length) {
    var empty = document.createElement('div');
    empty.className = 'panel-empty';
    var ic = document.createElement('div'); 
    ic.className = 'panel-icon'; 
    ic.setAttribute('data-icon', 'search'); 
    applySvg(ic, 'search');
    empty.appendChild(ic);
    var p = document.createElement('p'); 
    p.textContent = '没有匹配的文件';
    empty.appendChild(p);
    box.appendChild(empty);
    return;
  }
  
  list.forEach(function (item) {
    var card = document.createElement('div');
    card.className = 'file-card' + (gridMode ? ' grid-card' : '');
    
    var iconWrap = document.createElement('div');
    iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
    iconWrap.appendChild(makeIcon(iconFor(item), 'file-icon'));
    
    var body = document.createElement('div'); 
    body.className = 'file-body';
    var name = document.createElement('div'); 
    name.className = 'file-name'; 
    var _snm = item.FileName || '未命名';
    if (gridMode && _snm.length > 15) {
      var _sl = [];
      for (var _si = 0; _si < _snm.length; _si += 15) _sl.push(_snm.slice(_si, _si + 15));
      name.textContent = _sl.join('\n');
    } else {
      name.textContent = _snm;
    }
    var meta = document.createElement('div'); 
    meta.className = 'file-meta';
    var loc = item.NewParentName || item.ParentName || '';
    meta.textContent = (item.Type === 1 ? '文件夹' : fmtSize(item.Size)) + (loc ? ' · ' + loc : '');
    body.appendChild(name); 
    body.appendChild(meta);
    
    card.appendChild(iconWrap); 
    card.appendChild(body);
    
    var isDir = (item.Type === 1 || item.Type === '1');
    var isImage = isImgExt(item.FileName);
    var isVideo = isVidExt(item.FileName);
    var isAudio = isAudExt(item.FileName);
    var isText = isTxtExt(item.FileName);
    var isPdf = isPdfExt(item.FileName);
    var isDoc = isDocExt(item.FileName);
    var isXls = isXlsExt(item.FileName);
    var isZip = isZipLikeExt(item.FileName);
    var isArchO = isArchOtherExt(item.FileName);
    var canPreview = isImage || isVideo || isAudio || isText || isPdf || isDoc || isXls || isZip || isArchO;
    
    // 长按弹窗：列表 / 平铺都生效（搜索页原来没有任何长按处理）
    var _lpTimer = null, _lpFired = false;
    function _lpStart() {
      _lpFired = false;
      _lpTimer = setTimeout(function () {
        _lpFired = true;
        if (bridge && bridge.vibrate) bridge.vibrate(30);
        openActionSheet(item);
      }, 500);
    }
    function _lpEnd() { clearTimeout(_lpTimer); }
    card.addEventListener('touchstart', _lpStart, { passive: true });
    card.addEventListener('touchend', _lpEnd);
    card.addEventListener('touchmove', _lpEnd);
    card.addEventListener('mousedown', _lpStart);
    card.addEventListener('mouseup', _lpEnd);
    card.addEventListener('mouseleave', _lpEnd);

    if (isDir) {
      card.addEventListener('click', function () {
        if (_lpFired) { _lpFired = false; return; }   // 长按已处理，吞掉随后的 click
        if (!$('action-sheet').classList.contains('hidden')) {
          closeSheet();
          return;
        }
        openDir(item);   // 进目录时 exitSearch 会顺带清空搜索框
      });
    } else {
      card.addEventListener('click', function (e) {
        if (_lpFired) { _lpFired = false; return; }   // 长按已处理，吞掉随后的 click
        e.stopPropagation();
        if (!$('action-sheet').classList.contains('hidden')) {
          closeSheet();
          return;
        }
        var target = e.target;
        var isIconClick = false;
        while (target && target !== card) {
          if (target.classList && target.classList.contains('file-icon-wrap')) {
            isIconClick = true;
            break;
          }
          target = target.parentNode;
        }

        // 搜索页里直接点文件：保留搜索结果（方便连续预览），不退出搜索
        if (isIconClick && canPreview) {
          if (isImage) {
            previewImage(item);
          } else if (isVideo) {
            previewVideo(item);
          } else if (isAudio) {
            previewAudio(item);
          } else if (isText) {
            previewTextFile(item);
          } else if (isPdf) {
            previewPdf(item);
          } else if (isDoc) {
            previewDocx(item);
          } else if (isXls) {
            previewXlsx(item);
          } else if (isZip) {
            previewArchive(item);
          } else if (isArchO) {
            previewArchiveOther(item);
          }
        } else {
          openActionSheet(item);
        }
      });
    }
    
    box.appendChild(card);
  });
}
  // 只重置搜索框本身：清空文字 + 隐藏清除按钮 + 收键盘（不动搜索状态与列表）
  function resetSearchBox() {
    var input = $('search-input');
    if (input) {
      input.value = '';
      if (bridge && bridge.hideKeyboard) {
        bridge.hideKeyboard();
      }
      input.blur();
    }
    var sc = $('search-clear');
    if (sc) hide(sc);
  }
  function exitSearch() {
    try { clearJumpHighlight(); } catch (e) {}
    state.searching = false;
    state.searchKeyword = '';
    resetSearchBox();
    var summaryContainer = $('search-summary-container');
    if (summaryContainer) summaryContainer.innerHTML = '';
    
    var breadcrumbContainer = $('breadcrumb-container');
    if (breadcrumbContainer) breadcrumbContainer.style.display = '';
    
    var pathDisplay = $('path-display');
    if (pathDisplay) {
      pathDisplay.style.display = 'none';
    }
    
    loadList();
    hideToolbar();
  }

  // ---------- 弹窗互斥：打开任何弹窗/二级页前，先关掉其它已打开的浮层 ----------
  function closeAllOverlays(except) {
    var ids = ['clip-modal', 'account-action', 'account-sheet', 'account-modal',
               'upload-modal', 'sort-sheet', 'sort-pop', 'share-config-modal',
               'share-modal', 'move-picker', 'newfolder-modal', 'rename-modal',
               'profile-modal', 'theme-modal', 'upload-sheet', 'detail-modal', 'dedupe-modal',
               'confirm-modal', 'action-sheet', 'dv-modal'];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === except) continue;
      var el = $(ids[i]);
      if (el && !el.classList.contains('hidden')) hide(el);
    }
    state.confirmOk = null;    // 确认弹窗被关掉 → 清掉待执行回调，防止误触
    state.pickerState = null;  // 文件夹选择器状态复位
    state.pickerMode = 'move';
  }

  // ---------- 操作浮层 ----------
  // 离开目录前，把当前列表的「真实 DOM 节点」与滚动位置暂存起来。
  // 关键：存节点而不是 innerHTML —— innerHTML 还原出来的是新元素、事件监听全丢（整页点不动）；
  // 直接把节点收起来，返回时再 append 回去，监听器、闭包、引用全都保留。
  function snapshotDir(dirId) {
    state.dirSnap = state.dirSnap || {};
    var sa0 = $('scroll-area');
    var box0 = $('file-list');
    if (!sa0 || !box0) return;
    // 关键：scrollTop 必须在「摘节点之前」读！
    // 先摘节点会让列表清空、高度塔陷，浏览器会把 scrollTop 夹成 0，存下来的就变成“顶部”了。
    var top0 = sa0.scrollTop || 0;
    var kids = [];
    while (box0.firstChild) kids.push(box0.removeChild(box0.firstChild));   // 摘下真实节点
    state.dirSnap[String(dirId)] = {
      kids: kids,
      top: top0,
      list: state.lastList || [],
      grid: box0.classList.contains('grid'),
      at: Date.now()
    };
  }

  // 把快照节点放回列表（事件监听器随节点保留，点击照常响应）
  function restoreDirSnapshot(key) {
    var snap = state.dirSnap && state.dirSnap[key];
    if (!snap || !snap.kids) return false;
    delete state.dirSnap[key];
    var box = $('file-list');
    var sa = $('scroll-area');
    box.innerHTML = '';                       // 丢掉子目录那批卡片
    box.classList.toggle('grid', !!snap.grid);
    for (var i = 0; i < snap.kids.length; i++) box.appendChild(snap.kids[i]);
    state.lastList = snap.list || [];
    box.dataset.loaded = '1';
    snap.kids = null;
    var _t0 = snap.top || 0;
    if (sa) {
      // 1) 先强制一次同步布局：刚 append 完节点时 scrollHeight 还没更新，
      //    这时直接赋 scrollTop 会被当成“超出范围”而夹成 0（就回到顶部了）
      try { void sa.scrollHeight; void box.offsetHeight; } catch (e) {}
      // 2) 瞬时赋值（scroll-behavior 已是 auto，不会有滚动动画）
      sa.scrollTop = _t0;
      // 3) 再补一帧呢保证：WebView 布局时序有差异时兜底（auto 下也是瞬时的）
      try { requestAnimationFrame(function () { if (sa) sa.scrollTop = _t0; }); } catch (e) {}
    }
    return true;
  }

  function openDir(item) {
    closeSheet();
    snapshotDir(state.currentDir);
    if (state.searching) {
      state.searching = false;
      state.searchKeyword = '';
      resetSearchBox();   // 进目录时同步把搜索框清空
      var breadcrumbContainer = $('breadcrumb-container');
      if (breadcrumbContainer) breadcrumbContainer.style.display = '';
      var pathDisplay = $('path-display');
      if (pathDisplay) pathDisplay.textContent = getCurrentPath();
    }
    state.breadcrumb.push({ id: item.FileId, name: item.FileName });
    state.currentDir = item.FileId;
    loadList();   // 进入下级目录：无快照 → 正常加载并从顶部开始
    var scrollArea = $('scroll-area');
    if (scrollArea) scrollArea.scrollTop = 0;
  }

  function openActionSheet(item) {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    state.currentItem = item;
    $('sheet-title').textContent = item.FileName || '未命名';
    var grid = $('sheet-grid');
    grid.innerHTML = '';
    
    // 统一 8 项、两排：
    //   第一排：下载 / 分享 / 重命名 / 详细信息
    //   第二排：移动 / 复制 / 删除 / 去重
    var items = [
      { label: '下载', cls: 'primary', fn: function () { closeSheet(); doDownload(item); } },
      { label: '分享', cls: '', fn: function () { closeSheet(); doShare(item); } },
      { label: '重命名', cls: '', fn: function () { closeSheet(); onAction('rename', item); } },
      { label: '详细信息', cls: '', fn: function () { closeSheet(); openDetail(item); } },
      { label: '移动', cls: '', fn: function () { closeSheet(); openPickerFor('move', [item]); } },
      { label: '复制', cls: '', fn: function () { closeSheet(); openPickerFor('copy', [item]); } },
      { label: '删除', cls: 'warn', fn: function () { closeSheet(); onAction('delete', item); } },
      { label: '去重', cls: '', fn: function () { closeSheet(); dedupeStart(item); } }
    ];
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'sheet-grid-item ' + it.cls;
      var ic = document.createElement('div'); ic.className = 'sgi-icon';
      ic.textContent = it.label;
      el.appendChild(ic);
      el.title = it.label;
      el.addEventListener('click', it.fn);
      grid.appendChild(el);
    });
    show($('action-sheet'));
  }

  function closeSheet() { hide($('action-sheet')); }

  // ---------- 自定义确认弹窗 ----------
  function showConfirm(message, onOk) {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    $('cf-message').textContent = message || '';
    state.confirmOk = onOk || null;
    show($('confirm-modal'));
  }
  function onCfOk() {
    hide($('confirm-modal'));
    var cb = state.confirmOk;
    state.confirmOk = null;
    if (cb) cb();
  }

  // ---------- 操作处理 ----------
  function onAction(act, item) {
    state.currentItem = item;
    if (act === 'rename') {
      closeSheet();
      $('rename-input').value = item.FileName || '';
      show($('rename-modal'));
    } else if (act === 'download') {
      doDownload(item);
    } else if (act === 'delete') {
      closeSheet();
      showConfirm('确认删除「' + (item.FileName || '') + '」？', function () { doDelete(item); });
    }
  }

  function doRename() {
    var item = state.currentItem;
    if (!item) return;
    var newName = $('rename-input').value.trim();
    if (!newName) { toast('名称不能为空'); return; }
    api('POST', API.rename,
      JSON.stringify({ driveId: 0, fileId: item.FileId, fileName: newName, duplicate: 1 }),
      true,
      function (d) {
        if (d && d.code === 0) { hide($('rename-modal')); toast('重命名成功'); loadList(); }
        else toast((d && d.message) || '重命名失败');
      });
  }

  function doDelete(item) {
    api('POST', API.trash,
      JSON.stringify({
        RequestSource: null,
        driveId: 0,
        event: 'intoRecycle',
        fileTrashInfoList: [{ FileId: item.FileId }],
        operatePlace: 1,
        operation: true
      }),
      true,
      function (d) {
        if (d && d.code === 0) { toast('已移入回收站'); loadList(); }
        else toast((d && d.message) || '删除失败');
      });
  }

  // ---------- 回收站 ----------
  function loadRecycle() {
    var box = $('recycle-list');
    var empty = $('recycle-empty');
    if (!box) return;
    box.dataset.loaded = '1';
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    var params = 'driveId=0&limit=500&next=0&orderBy=file_id&orderDirection=desc'
      + '&parentFileId=0&trashed=true&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      var list = d && d.data && (d.data.InfoList || d.data.Info);
      if (list && list.length) {
        if (empty) hide(empty);
        renderRecycle(list);
      } else {
        if (empty) show(empty);
        box.innerHTML = '';
      }
      hideToolbar();
    });
  }

  function renderRecycle(list) {
    var box = $('recycle-list');
    box.innerHTML = '';
    if (!list || !list.length) { box.innerHTML = '<div class="panel-empty"><div class="panel-icon" data-icon="trash"></div><p>回收站为空</p></div>'; injectIcons(box); return; }
    list.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'file-card';
      var iconWrap = document.createElement('div');
      iconWrap.className = 'file-icon-wrap fi-' + iconFor(item);
      iconWrap.appendChild(makeIcon(iconFor(item), 'file-icon'));
      var body = document.createElement('div'); body.className = 'file-body';
      var name = document.createElement('div'); name.className = 'file-name'; name.textContent = item.FileName || '未命名';
      var meta = document.createElement('div'); meta.className = 'file-meta';
      meta.textContent = item.Type === 1 ? '文件夹' : (fmtSize(item.Size) + ' · ' + (item.TrashTime || item.ModifyTime || ''));
      body.appendChild(name); body.appendChild(meta);
      card.appendChild(iconWrap); card.appendChild(body);
      card.addEventListener('click', function () { openRecycleSheet(item); });
      box.appendChild(card);
    });
  }

  function openRecycleSheet(item) {
    state.currentItem = item;
    $('sheet-title').textContent = (item.FileName || '未命名') + '（回收站）';
    var grid = $('sheet-grid');
    grid.innerHTML = '';
    var items = [
      { icon: 'restore', label: '恢复', cls: 'primary', fn: function () {
          closeSheet();
          doRecycleOp(item, RECYCLE_EVENT.restore);
        } },
      { icon: 'trash', label: '彻底删除', cls: 'warn', fn: function () {
          closeSheet();
          doRecycleOp(item, RECYCLE_EVENT.deleteP);
        } }
    ];
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'sheet-grid-item ' + it.cls;
      var ic = document.createElement('div'); ic.className = 'sgi-icon';
      ic.textContent = it.label;
      el.appendChild(ic);
      el.title = it.label;
      el.addEventListener('click', it.fn);
      grid.appendChild(el);
    });
    show($('action-sheet'));
  }

  function doRecycleOp(item, ev) {
    var isRestore = (ev === RECYCLE_EVENT.restore);
    var url = isRestore ? API.trash : API.trashDelete;
    var body = isRestore
      ? { RequestSource: null, driveId: 0, event: ev, fileTrashInfoList: [{ FileId: item.FileId }], operatePlace: 1, operation: false, safeBox: false }
      : { RequestSource: null, event: ev, fileIdList: [item.FileId], operatePlace: 1 };
    api('POST', url, JSON.stringify(body), true, function (d) {
      if (d && d.code === 0) {
        toast(isRestore ? '已恢复' : '已彻底删除');
        loadRecycle();
      } else toast((d && d.message) || '操作失败');
    });
  }

  function recycleClearAll() {
    api('POST', API.trashDeleteAll,
      JSON.stringify({ RequestSource: null, event: RECYCLE_EVENT.clear }),
      true,
      function (d) {
        if (d && (d.code === 0 || d.code === 7301)) { toast('回收站已清空'); loadRecycle(); }
        else toast((d && d.message) || '清空失败');
      });
  }

  // ---------- 下载 ----------
  function buildDownloadBody(item) {
    var sz = Number(item.Size) || Number(item.FileSize) || Number(item.size) || 0;
    return {
      driveId: 0,
      etag: item.Etag || item.etag || '',
      fileId: item.FileId || item.fileId,
      size: sz,
      fileSize: sz,
      s3keyFlag: item.S3KeyFlag || item.s3keyFlag || item.s3KeyFlag || '',
      fileName: item.FileName || item.fileName || '',
      fileNameType: (item.Type !== undefined ? item.Type : 0),
      type: 'download'
    };
  }
  function pickDownloadUrl(d) {
    var dl = d && d.data;
    if (!dl) return '';
    return (dl.DownloadUrl || dl.downloadUrl || dl.url
      || (dl[0] && (dl[0].DownloadUrl || dl[0].url)) || '');
  }
  function doDownload(item) {
    var url, body;
    if (item.Type === 1) {
      url = API.batchDownload;
      body = JSON.stringify({ fileIdList: [{ fileId: item.FileId || item.fileId }] });
    } else {
      url = API.download;
      body = JSON.stringify(buildDownloadBody(item));
    }
    toast('正在获取下载链接...');
    api('POST', url, body, true, function (d) {
      if (!d || !d.data) {
        var msg = (d && (d.message || d.error)) || '获取下载链接失败';
        if (/size/i.test(msg)) msg = '下载失败：该文件缺少大小信息，请刷新列表后重试';
        toast(msg);
        return;
      }
      var link = pickDownloadUrl(d);
      if (link) {
        var fname = item.FileName || item.fileName || (Date.now() + '');
        var fsize = Number(item.Size) || Number(item.size) || Number(item.FileSize) || 0;
        var started = false;
        var genId = -1;
        var isStream = false;
        if (bridge && bridge.downloadStream) {
          try {
            genId = Number(bridge.downloadStream(link, fname, fsize));
            started = genId >= 0;
            isStream = started;
          } catch (e) { started = false; }
        }
        if (!started) {
          toast('下载启动失败，请重试');
          return;
        }
        addTransfer({ id: genId, name: fname, size: fsize, total: fsize, status: 'downloading', stream: isStream });
        startProgressPolling();
        toast('已加入下载任务');
      } else {
        toast('暂无法获取直链，请查看返回信息');
      }
    });
  }

  // =========================================================================
  // 预览缓存（手动清除）
  //  1) 直链缓存：同一个 fileId 不再重复请求 download_info
  //  2) 内容缓存：文本 / 图片转为 dataURL 后落 IndexedDB，下次直接读
  //  只在「我的 → 清除缓存」时清空，不会自动过期。
  // =========================================================================
  var _linkMem = {};     // fileId → link（会话内）
  function linkCacheGet(id) { return (id != null && _linkMem[String(id)]) || ''; }
  function linkCacheSet(id, link) { if (id != null && link) _linkMem[String(id)] = link; }

  var _idb = null;
  function idbOpen(cb) {
    try {
      if (!window.indexedDB) { cb(null); return; }
      if (_idb) { cb(_idb); return; }
      var req = indexedDB.open('pan_preview_cache', 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = function (e) { _idb = e.target.result; cb(_idb); };
      req.onerror = function () { cb(null); };
    } catch (e) { cb(null); }
  }
  function cachePut(id, kind, data, name) {
    idbOpen(function (db) {
      if (!db || id == null) return;
      try {
        var tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({ id: String(id), kind: kind, data: data, name: name || '', at: Date.now() });
      } catch (e) {}
    });
  }
  function cacheGet(id, cb) {
    idbOpen(function (db) {
      if (!db || id == null) { cb(null); return; }
      try {
        var tx = db.transaction('files', 'readonly');
        var rq = tx.objectStore('files').get(String(id));
        rq.onsuccess = function () { cb(rq.result || null); };
        rq.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }
  function cacheClear(cb) {
    _linkMem = {};
    idbOpen(function (db) {
      if (!db) { if (cb) cb(); return; }
      try {
        var tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').clear();
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
      } catch (e) { if (cb) cb(); }
    });
  }
  // 直链获取：默认实时取新链接、不缓存（所有预览除图片外均走这里）
  function getFileLink(item, cb, failMsg) {
    api('POST', API.download, JSON.stringify(buildDownloadBody(item)), true, function (d) {
      var link = (d && d.data) ? pickDownloadUrl(d) : '';
      if (!link) { if (failMsg) toast(failMsg); cb(''); return; }
      cb(link);
    });
  }
  // 带缓存的直链获取：仅图片缩略图 / 图片预览使用
  function getFileLinkCached(item, cb, failMsg) {
    var id = item && (item.FileId || item.fileId);
    var hit = linkCacheGet(id);
    if (hit) { cb(hit); return; }
    api('POST', API.download, JSON.stringify(buildDownloadBody(item)), true, function (d) {
      var link = (d && d.data) ? pickDownloadUrl(d) : '';
      if (!link) { if (failMsg) toast(failMsg); cb(''); return; }
      linkCacheSet(id, link);
      cb(link);
    });
  }
  // 下载为 dataURL（用于图片 / 文本的本地缓存）
  function fetchAsDataUrl(link, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', previewSrc(link), true);
      xhr.responseType = 'blob';
      xhr.onload = function () {
        if (!xhr.response) { cb(''); return; }
        try {
          var fr = new FileReader();
          fr.onload = function () { cb(fr.result || ''); };
          fr.onerror = function () { cb(''); };
          fr.readAsDataURL(xhr.response);
        } catch (e) { cb(''); }
      };
      xhr.onerror = function () { cb(''); };
      xhr.send();
    } catch (e) { cb(''); }
  }

  // ================== 文档预览 / 编辑 / 保存（PDF · Word · Excel） ==================
  // 依赖 assets/lib 下三个库（与 123.apk 参照实现同源）：
  //   lib/pdf.min.js + lib/pdf.worker.min.js → PDF 渲染（只读）
  //   lib/mammoth.browser.min.js             → docx 解析成 HTML（编辑后写回 docx）
  //   lib/xlsx.full.min.js                   → xlsx 读写（编辑后写回 xlsx）
  var _pvLibs = {};
  function loadPvLib(globalName, src, cb) {
    if (window[globalName]) { cb(null); return; }
    var st = _pvLibs[src];
    if (st) { st.push(cb); return; }
    st = _pvLibs[src] = [cb];
    var el = document.createElement('script');
    el.src = src;
    function done() {
      var cbs = st.slice();
      _pvLibs[src] = [];
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](window[globalName] ? null : new Error('load failed')); } catch (e) {} }
    }
    el.onload = done;
    el.onerror = done;
    document.head.appendChild(el);
  }
  function _bU8(str) {
    var s = String(str == null ? '' : str);
    if (window.TextEncoder) { try { return new TextEncoder().encode(s); } catch (e) {} }
    var utf8 = unescape(encodeURIComponent(s));
    var a = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) a[i] = utf8.charCodeAt(i);
    return a;
  }
  // 下载二进制（arraybuffer）：比 dataURL 省一半内存，PUT 上传也用它
  function fetchAsArrayBuffer(link, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', previewSrc(link), true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        if (!xhr.response) { cb(null); return; }
        try { cb(new Uint8Array(xhr.response)); } catch (e) { cb(null); }
      };
      xhr.onerror = function () { cb(null); };
      xhr.send();
    } catch (e) { cb(null); }
  }
  function putBinary(url, bytes, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url, true);
      xhr.onload = function () { cb(xhr.status >= 200 && xhr.status < 300); };
      xhr.onerror = function () { cb(false); };
      xhr.send(bytes);
    } catch (e) { cb(false); }
  }
  // ---------- MD5（按字节数组，用于 upload_request 的 etag）----------
  function _md5Bytes(bytes) {
    function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function au(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
    function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    var n = bytes.length, words = [], i;
    for (i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
    words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
    var total = (((n + 8) >> 6) + 1) * 16;
    for (i = 0; i < total; i++) if (words[i] === undefined) words[i] = 0;
    words[total - 2] = n * 8;
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (i = 0; i < total; i += 16) {
      var oa = a, ob = b, oc = c, od = d;
      a = ff(a, b, c, d, words[i], 7, -680876936);
      d = ff(d, a, b, c, words[i + 1], 12, -389564586);
      c = ff(c, d, a, b, words[i + 2], 17, 606105819);
      b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
      a = ff(a, b, c, d, words[i + 4], 7, -176418897);
      d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
      c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
      b = ff(b, c, d, a, words[i + 7], 22, -45705983);
      a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
      d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
      c = ff(c, d, a, b, words[i + 10], 17, -42063);
      b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
      a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
      d = ff(d, a, b, c, words[i + 13], 12, -40341101);
      c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
      b = ff(b, c, d, a, words[i + 15], 22, 1236535329);
      a = gg(a, b, c, d, words[i + 1], 5, -165796510);
      d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
      c = gg(c, d, a, b, words[i + 11], 14, 643717713);
      b = gg(b, c, d, a, words[i], 20, -373897302);
      a = gg(a, b, c, d, words[i + 5], 5, -701558691);
      d = gg(d, a, b, c, words[i + 10], 9, 38016083);
      c = gg(c, d, a, b, words[i + 15], 14, -660478335);
      b = gg(b, c, d, a, words[i + 4], 20, -405537848);
      a = gg(a, b, c, d, words[i + 9], 5, 568446438);
      d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
      c = gg(c, d, a, b, words[i + 3], 14, -187363961);
      b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
      a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
      d = gg(d, a, b, c, words[i + 2], 9, -51403784);
      c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
      b = gg(b, c, d, a, words[i + 12], 20, -1926607734);
      a = hh(a, b, c, d, words[i + 5], 4, -378558);
      d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
      c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
      b = hh(b, c, d, a, words[i + 14], 23, -35309556);
      a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
      d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
      c = hh(c, d, a, b, words[i + 7], 16, -155497632);
      b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
      a = hh(a, b, c, d, words[i + 13], 4, 681279174);
      d = hh(d, a, b, c, words[i], 11, -358537222);
      c = hh(c, d, a, b, words[i + 3], 16, -722521979);
      b = hh(b, c, d, a, words[i + 6], 23, 76029189);
      a = hh(a, b, c, d, words[i + 9], 4, -640364487);
      d = hh(d, a, b, c, words[i + 12], 11, -421815835);
      c = hh(c, d, a, b, words[i + 15], 16, 530742520);
      b = hh(b, c, d, a, words[i + 2], 23, -995338651);
      a = ii(a, b, c, d, words[i], 6, -198630844);
      d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
      c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
      b = ii(b, c, d, a, words[i + 5], 21, -57434055);
      a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
      d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
      c = ii(c, d, a, b, words[i + 10], 15, -1051523);
      b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
      a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
      d = ii(d, a, b, c, words[i + 15], 10, -30611744);
      c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
      b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
      a = ii(a, b, c, d, words[i + 4], 6, -145523070);
      d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
      c = ii(c, d, a, b, words[i + 2], 15, 718787259);
      b = ii(b, c, d, a, words[i + 9], 21, -343485551);
      a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
    }
    var out = '';
    [a, b, c, d].forEach(function (x) {
      for (var j = 0; j < 4; j++) out += ('0' + ((x >> (j * 8)) & 0xFF).toString(16)).slice(-2);
    });
    return out;
  }
  // ---------- 覆盖式保存：4 步上传（与 TXT 保存同一套接口，只是 body 换成二进制）----------
  function uploadFileBytes(bytes, fname, parentId, onDone, onFail) {
    var size = bytes.length;
    var etag = _md5Bytes(bytes);
    var b1 = JSON.stringify({
      driveId: 0, fileName: fname, etag: etag, size: size,
      parentFileId: Number(parentId) || 0, type: 0, duplicate: 2
    });
    api('POST', 'https://api.123pan.cn/b/api/file/upload_request', b1, true, function (r1) {
      if (!r1 || r1.code !== 0 || !r1.data) { onFail('创建上传失败：' + ((r1 && (r1.message || r1.error)) || ('code=' + (r1 && r1.code)))); return; }
      var d = r1.data || {};
      var bucket = d.Bucket || '', node = d.StorageNode || '', key = d.Key || '', upid = d.UploadId || '';
      var fid = Number(d.FileId || d.fileId || 0);
      if (d.Reuse) { onDone(); return; }
      var b2 = JSON.stringify({ bucket: bucket, key: key, partNumberStart: 1, partNumberEnd: 2, uploadId: upid, StorageNode: node });
      api('POST', 'https://api.123pan.cn/b/api/file/s3_upload_object/auth', b2, true, function (r2) {
        if (!r2 || r2.code !== 0 || !r2.data) { onFail('上传鉴权失败：' + ((r2 && (r2.message || r2.error)) || ('code=' + (r2 && r2.code)))); return; }
        var urls = r2.data.presignedUrls || {};
        var putUrl = urls['1'] || '';
        if (!putUrl) { for (var k in urls) { if (urls[k]) { putUrl = urls[k]; break; } } }
        if (!putUrl) { onFail('未取到上传地址'); return; }
        putBinary(putUrl, bytes, function (ok) {
          if (!ok) { onFail('上传数据失败（网络或跨域限制）'); return; }
          var b3 = JSON.stringify({ fileId: fid, bucket: bucket, fileSize: size, key: key, isMultipart: false, uploadId: upid, StorageNode: node });
          api('POST', 'https://api.123pan.cn/b/api/file/upload_complete/v2', b3, true, function (r3) {
            if (r3 && r3.code === 0) onDone();
            else onFail('收尾失败：' + ((r3 && (r3.message || r3.error)) || ('code=' + (r3 && r3.code))));
          });
        });
      });
    });
  }
  // ---------- XML / ZIP / docx 生成（把编辑后的 HTML 写回 docx）----------
  function _xmlEsc(s) {
    return String(s == null ? '' : s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
  }
  function _hasVisible(t) {
    var s = String(t == null ? '' : t);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 160) return true;
    }
    return false;
  }
  var _crcTable = null;
  function _crc32(u8) {
    if (!_crcTable) {
      _crcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) crc = (_crcTable[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  // 最小 ZIP 写入（store，不压缩）：docx 本质就是个 zip
  function zipStore(files) {
    function u16(v) { return [(v & 255), (v >> 8) & 255]; }
    function u32(v) { return [(v & 255), ((v >> 8) & 255), ((v >> 16) & 255), ((v >> 24) & 255)]; }
    var parts = [], central = [], offset = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var nb = _bU8(f.name);
      var data = f.data;
      var crc = _crc32(data);
      var lh = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nb.length), u16(0));
      parts.push(new Uint8Array(lh), nb, data);
      var ch = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length),
        u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(ch), nb);
      offset += lh.length + nb.length + data.length;
    }
    var cdSize = 0;
    for (var j = 0; j < central.length; j++) cdSize += central[j].length;
    var eocd = new Uint8Array([].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0)));
    var all = parts.concat(central, [eocd]);
    var total = 0;
    for (var k = 0; k < all.length; k++) total += all[k].length;
    var out = new Uint8Array(total), p = 0;
    for (var m = 0; m < all.length; m++) { out.set(all[m], p); p += all[m].length; }
    return out;
  }
  function htmlToDocxBytes(html) {
    var holder = document.createElement('div');
    holder.innerHTML = html || '';
    var paras = [];
    function walk(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 3) {
          if (_hasVisible(n.nodeValue)) paras.push({ t: n.nodeValue, h: false });
        } else if (n.nodeType === 1) {
          var tag = String(n.tagName || '').toLowerCase();
          if (tag === 'br') { continue; }
          var isH = (tag.length === 2 && tag.charAt(0) === 'h' && tag.charAt(1) >= '1' && tag.charAt(1) <= '6');
          if (tag === 'p' || tag === 'div' || tag === 'li' || tag === 'blockquote' || isH) {
            var txt = n.textContent || '';
            if (_hasVisible(txt)) paras.push({ t: txt, h: isH });
          } else if (tag === 'table') {
            var rows = n.querySelectorAll('tr');
            for (var r = 0; r < rows.length; r++) {
              var cells = rows[r].querySelectorAll('td,th');
              var line = [];
              for (var c = 0; c < cells.length; c++) line.push(cells[c].textContent || '');
              paras.push({ t: line.join('  |  '), h: false });
            }
          } else if (tag === 'ul' || tag === 'ol' || tag === 'span' || tag === 'b' || tag === 'i' || tag === 'u' || tag === 'strong' || tag === 'em' || tag === 'a') {
            if (tag === 'ul' || tag === 'ol') { walk(n); }
            else {
              var t2 = n.textContent || '';
              if (_hasVisible(t2)) paras.push({ t: t2, h: false });
            }
          } else {
            walk(n);
          }
        }
      }
    }
    walk(holder);
    var bodyXml = '';
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      bodyXml += '<w:p>';
      if (p.h) bodyXml += '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>';
      bodyXml += '<w:r><w:t xml:space="preserve">' + _xmlEsc(p.t) + '</w:t></w:r></w:p>';
    }
    if (!paras.length) bodyXml = '<w:p/>';
    var docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + bodyXml
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
    var ctXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>';
    var relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';
    return zipStore([
      { name: '[Content_Types].xml', data: _bU8(ctXml) },
      { name: '_rels/.rels', data: _bU8(relsXml) },
      { name: 'word/document.xml', data: _bU8(docXml) }
    ]);
  }
  // ================== 压缩包预览（ZIP / APK / IPA / JAR …） ==================
  // 用 zip.js 的 no-worker 构建（纯 JS inflate，避开 file:// 下 Worker 被拦的问题）
  // apk / ipa / jar 等本地 ZIP 预览已移除（不再作为压缩包预览）
  function isZipLikeExt(f) { return false; }
  // ================== 云解压（官方协议；服务端解压，零下载流量） ==================
  // 接口与参数取自官方客户端内置网页包（web_res_123/static/js/main.*.js）：
  //   GET  {base}archive/file/list?fileId=xx            → { code, data:{ taskId } }
  //   GET  {base}archive/file/status?fileId&taskId&taskType=1|2  → { code, data:{ state, errCode, errMsg, fileInfo, list } }
  //   POST {base}archive/file/uncompress  { fileId, targetFileId, taskId, list }  → { code }
  //   state: 2=完成, 3=失败（配 errCode）
  var ARCH_API = 'https://api.123pan.cn/b/api/restful/goapi/v1/archive/file/';
  var ARCH_ERR_TEXT = { 6001: '未知错误', 6002: '解压失败', 6003: '解压密码错误', 6004: '创建文件失败', 7001: '压缩包已损坏，无法解压', 7002: '文件已被删除', 7003: '文件已被禁用' };
  function archErrText(code, fallback) { return ARCH_ERR_TEXT[Number(code)] || String(fallback || ('错误码 ' + code)); }
  // 官方支持的压缩格式（含 .tar.gz / .tar.bz2 / .tar.xz）
  function isArchOtherExt(f) {
    var n = String(f || '').trim().toLowerCase();
    if (!n) return false;
    if (n.length > 7 && n.slice(-7) === '.tar.gz') return true;
    if (n.length > 8 && n.slice(-8) === '.tar.bz2') return true;
    if (n.length > 7 && n.slice(-7) === '.tar.xz') return true;
    var ext = n.split('.').pop() || '';
    var list = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'cab', 'arj', 'lzh', 'ace', 'iso', 'tgz'];
    for (var i = 0; i < list.length; i++) { if (list[i] === ext) return true; }
    return false;
  }
  function bytesToBase64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      var sub = bytes.subarray(i, i + CH);
      s += String.fromCharCode.apply(null, sub);
    }
    return btoa(s);
  }
  function docSmallBtn(txt, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    b.style.cssText = 'flex-shrink:0;height:26px;padding:0 10px;border-radius:7px;border:1px solid rgba(15,23,42,0.20);background:transparent;font-size:12px;color:#1a1a1a;';
    b.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); fn(); });
    return b;
  }
  function previewArchive(item) {
    var title = item.FileName || '压缩包';
    var ctx = showDocViewer(title);
    ctx.archTitle = title;
    docMsg(ctx, '正在读取压缩包...');
    getFileLink(item, function (link) {
      if (!link) { docMsg(ctx, '获取文件链接失败', '#E5484D'); return; }
      // 省流量：先探测分段读取，能分段就只取中央目录；不能分段且文件大 → 让用户决定
      zipOpenSmart(link, item.Size, function (zctx) {
        if (_docCtx !== ctx) { if (zctx && zctx.reader) { try { zctx.reader.close(); } catch (e) {} } return; }
        if (!zctx) { docMsg(ctx, '解析失败（可能已加密或已损坏）', '#E5484D'); return; }
        if (zctx.needFull) {
          // 不自动下载，避免消耗大量流量
          ctx.ctrl.innerHTML = '';
          docBtn(ctx, '下载整包', false, function () { closeDocViewer(); doDownload(item); });
          docMsg(ctx, '该压缩包较大（' + fmtSize(zctx.size) + '），但服务器不支持分段读取。\n为避免消耗大量流量，未自动下载。\n可点右上「下载整包」保存后用其他应用打开。', '#888');
          return;
        }
        ctx.archReader = zctx.reader;
        ctx.archEntries = zctx.entries || [];
        ctx.archRange = !!zctx.range;
        renderArchList(ctx, ctx.archEntries, title);
      });
    }, '获取文件链接失败');
  }
  function renderArchList(ctx, entries, title) {
    ctx.ctrl.innerHTML = '';
    var files = [];
    for (var i = 0; i < entries.length; i++) { if (entries[i] && !entries[i].directory) files.push(entries[i]); }
    var info = document.createElement('span');
    info.style.cssText = 'font-size:12px;color:#666;flex-shrink:0;';
    info.textContent = '共 ' + files.length + ' 项';
    ctx.ctrl.appendChild(info);
    ctx.body.innerHTML = '';
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;';
    var list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow:auto;-webkit-overflow-scrolling:touch;';
    host.appendChild(list);
    ctx.body.appendChild(host);
    if (!files.length) {
      list.innerHTML = '<div style="padding:24px;text-align:center;color:#888;font-size:13px;">压缩包内没有文件</div>';
      return;
    }
    for (var k = 0; k < files.length; k++) {
      (function (en) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #f2f2f2;';
        var nm = document.createElement('div');
        nm.style.cssText = 'flex:1;min-width:0;font-size:13px;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nm.textContent = en.filename || '';
        var meta = document.createElement('div');
        meta.style.cssText = 'font-size:11px;color:#999;flex-shrink:0;';
        meta.textContent = fmtSize(en.uncompressedSize || 0);
        row.appendChild(nm);
        row.appendChild(meta);
        row.appendChild(docSmallBtn('预览', function () { previewArchEntry(ctx, en); }));
        row.appendChild(docSmallBtn('下载', function () { saveArchEntry(ctx, en); }));
        list.appendChild(row);
      })(files[k]);
    }
  }
  function previewArchEntry(ctx, en) {
    var name = en.filename || '';
    var ext = extOf(name);
    if (EXT_TEXT[ext]) {
      toast('正在读取...');
      en.getData(new zip.TextWriter()).then(function (txt) {
        if (_docCtx !== ctx) return;
        showArchEntry(ctx, name, 'text', txt || '');
      }, function () { toast('读取失败'); });
    } else if (EXT_IMAGE[ext]) {
      var mime = (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe') ? 'image/jpeg' : ('image/' + ext);
      toast('正在读取...');
      try {
        en.getData(new zip.BlobWriter(mime)).then(function (blob) {
          if (_docCtx !== ctx) return;
          var url = '';
          try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
          if (!url) { toast('图片读取失败'); return; }
          showArchEntry(ctx, name, 'image', url);
        }, function () { toast('读取失败'); });
      } catch (e) { toast('图片读取失败'); }
    } else {
      toast('该类型不支持预览，可点「下载」保存后打开');
    }
  }
  function showArchEntry(ctx, name, kind, data) {
    ctx.ctrl.innerHTML = '';
    docBtn(ctx, '返回列表', false, function () { renderArchList(ctx, ctx.archEntries || [], ctx.archTitle || ''); });
    ctx.body.innerHTML = '';
    if (kind === 'text') {
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0;padding:14px;font-family:monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#1a1a1a;';
      pre.textContent = data;
      ctx.body.appendChild(pre);
    } else {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'padding:12px;text-align:center;';
      var img = document.createElement('img');
      img.src = data;
      img.style.cssText = 'max-width:100%;';
      wrap.appendChild(img);
      ctx.body.appendChild(wrap);
    }
  }
  function saveArchEntry(ctx, en) {
    var name = en.filename || 'file';
    var sz = Number(en.uncompressedSize) || 0;
    if (sz > 31457280) { toast('文件过大（超过 30MB），暂不支持导出'); return; }
    toast('正在解压...');
    en.getData(new zip.Uint8ArrayWriter()).then(function (data) {
      if (!data || !data.length) { toast('解压失败'); return; }
      var b64 = '';
      try { b64 = bytesToBase64(data); } catch (e) { b64 = ''; }
      if (!b64) { toast('编码失败'); return; }
      var ok = false;
      try { ok = !!(bridge && bridge.saveBytesToDownload && bridge.saveBytesToDownload(b64, name)); } catch (e) { ok = false; }
      toast(ok ? ('已保存到 Download/123云盘（' + name.split('/').pop() + '）') : '保存失败，请重试');
    }, function () { toast('解压失败'); });
  }
  // ---- 云解压：界面（顶部标题居中 + 全选 / VIP 横幅 / 列表 / 底部按钮） ----
  var _archPending = null;   // 「解压到」时暂存上下文
  // VIP 标志：会员显示彩色 VIP/SVIP 标志，普通用户显示灰色（素材：appicons.js）
  function archVipSvg(el) {
    el.innerHTML = vipLogoImgHtml(!(state.profile && state.profile.isVip));
  }
  function previewArchiveOther(item) {
    var title = item.FileName || '压缩包';
    closeDocViewer();
    var dk = pvDark();
    var bg = dk ? '#14181E' : '#fff';
    var headBg = dk ? '#1A1F26' : '#fff';
    var headBd = dk ? '#2A323D' : '#e5e7eb';
    var rowBd = dk ? '#232A33' : '#f5f6f8';
    var tx = dk ? '#E8ECF3' : '#1a1a1a';
    var sub = dk ? '#8A97A8' : '#9aa3b2';
    var overlay = document.createElement('div');
    overlay.id = 'doc-viewer-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:' + bg + ';z-index:9999;display:flex;flex-direction:column;';

    // 顶栏：标题居中（左右各留按钮宽度），右侧「全选」，整体与屏幕保持间距
    var header = document.createElement('div');
    header.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;flex-shrink:0;background:' + headBg + ';';
    var titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = 'position:absolute;left:64px;right:64px;text-align:center;font-size:16px;font-weight:600;color:' + tx + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    header.appendChild(titleEl);
    // 标题左侧：退出按钮
    var exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.textContent = '✕';
    exitBtn.title = '退出';
    exitBtn.style.cssText = 'flex-shrink:0;height:30px;padding:0 13px;border-radius:9px;border:1px solid ' + (dk ? 'rgba(127,166,255,0.5)' : 'rgba(47,107,255,0.45)') + ';background:' + (dk ? 'rgba(79,124,255,0.16)' : 'rgba(47,107,255,0.08)') + ';font-size:13px;font-weight:600;color:' + (dk ? '#9DBBFF' : '#2f6bff') + ';';
    exitBtn.addEventListener('click', function () { closeDocViewer(); });
    header.appendChild(exitBtn);
    var selAllBtn = document.createElement('button');
    selAllBtn.type = 'button';
    selAllBtn.textContent = '全选';
    selAllBtn.style.cssText = 'flex-shrink:0;height:30px;padding:0 13px;border-radius:9px;border:1px solid ' + (dk ? 'rgba(127,166,255,0.5)' : 'rgba(47,107,255,0.45)') + ';background:' + (dk ? 'rgba(79,124,255,0.16)' : 'rgba(47,107,255,0.08)') + ';font-size:13px;font-weight:600;color:' + (dk ? '#9DBBFF' : '#2f6bff') + ';';
    header.appendChild(selAllBtn);
    overlay.appendChild(header);

    // VIP 横幅（夜间用暗金配色）
    var banner = document.createElement('div');
    banner.style.cssText = 'display:flex;align-items:center;gap:9px;margin:0 18px 10px;padding:10px 13px;border-radius:12px;background:'
      + (dk ? 'linear-gradient(90deg, rgba(231,169,59,0.16), rgba(231,169,59,0.08))' : 'linear-gradient(90deg,#FFF8E8,#FFF1D8)')
      + ';border:1px solid rgba(231,169,59,0.35);flex-shrink:0;';
    var vipIc = document.createElement('span');
    vipIc.style.cssText = 'min-width:22px;height:22px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;';
    archVipSvg(vipIc);
    // 会员状态未就绪/过期（>30 秒）→ 主动刷新一次，避免明明是 VIP 却先显示灰色
    (function () {
      var _fresh = state.profileAt && (Date.now() - state.profileAt) < 30000;
      if (_fresh) return;
      fetchUserProfile(function () {
        if (_docCtx !== ctx) return;
        archVipSvg(vipIc);
        applyVipBanner();
      });
    })();
    banner.appendChild(vipIc);
    var bTxt = document.createElement('span');
    // 文本随会员状态变化：非会员改为“暂不支持云解压”提示
    function applyVipBanner() {
      var _isVip = !!(state.profile && state.profile.isVip);
      bTxt.textContent = _isVip ? '尊敬的VIP，您正在尊享文件云解压特权' : '尊敬的用户，您还不是vip用户，暂不支持云解压特权';
    }
    applyVipBanner();
    bTxt.style.cssText = 'font-size:12.5px;color:' + (dk ? '#E8B25C' : '#A8741A') + ';line-height:1.4;';
    banner.appendChild(bTxt);
    overlay.appendChild(banner);

    // 列表区
    var listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1;overflow:auto;-webkit-overflow-scrolling:touch;';
    overlay.appendChild(listWrap);
    // 底部按钮区
    var bottom = document.createElement('div');
    bottom.style.cssText = 'flex-shrink:0;padding:10px 18px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid ' + headBd + ';background:' + headBg + ';';
    var mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.style.cssText = 'width:100%;height:44px;border-radius:12px;border:none;background:' + (dk ? '#3A66E0' : '#2f6bff') + ';color:#fff;font-size:15px;font-weight:600;';
    bottom.appendChild(mainBtn);
    overlay.appendChild(bottom);

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    var ctx = { overlay: overlay, listWrap: listWrap, mainBtn: mainBtn, selAllBtn: selAllBtn, archSel: {}, archTitle: title, archItem: item, dk: dk, rowBd: rowBd, tx: tx, sub: sub, archStack: [], archCancel: true };
    _docCtx = ctx;
    ctx.selAllBtn.addEventListener('click', function () { archToggleAll(ctx); });
    ctx.mainBtn.addEventListener('click', function () {
      if (ctx.archCancel) { closeDocViewer(); return; }
      archMainAction(ctx);
    });
    archSetCancelBtn(ctx, true);   // 解析完成前：底部显示「取消」，点击退出

    archLoadList(ctx);
  }
  // 发起/重发「压缩包列表」解析请求（只读、可安全重试）
  function archLoadList(ctx) {
    if (_docCtx !== ctx) return;
    var it = ctx.archItem || {};
    var fid = Number(it.FileId || it.fileId) || 0;
    archShowMsg(ctx, '正在云端解析压缩包...（不消耗下载流量）');
    api('GET', ARCH_API + 'list?fileId=' + fid, '', true, function (d) {
      if (_docCtx !== ctx) return;
      if (!d || d.code !== 0 || !d.data || !d.data.taskId) {
        archShowMsg(ctx, '无法解析：' + ((d && d.message) || '不支持的压缩文件类型，无法进行解压'), '#E5484D');
        archSetCancelBtn(ctx, true);
        return;
      }
      ctx.archTask = d.data.taskId;
      pollArchStatus(ctx, 1, 0);
    });
  }
  function archShowMsg(ctx, msg, color) {
    ctx.listWrap.innerHTML = '';
    var d = document.createElement('div');
    d.style.cssText = 'padding:30px 18px;text-align:center;font-size:13.5px;color:' + (color || '#8a93a3') + ';';
    d.textContent = msg || '';
    ctx.listWrap.appendChild(d);
  }
  // 底部按钮：取消模式（点击退出）或操作模式（全部解压 / 解压到）
  function archSetCancelBtn(ctx, on) {
    ctx.archCancel = !!on;
    if (ctx.mainBtn) ctx.mainBtn.textContent = on ? '取消' : '';
  }
  // taskType: 1=列表 / 2=解压；state: 2=完成 3=失败
  function pollArchStatus(ctx, taskType, tries) {
    if (_docCtx !== ctx) return;
    if (tries > 80) { archShowMsg(ctx, '云端处理超时，请稍后重试', '#E5484D'); archSetCancelBtn(ctx, true); return; }
    var it = ctx.archItem || {};
    var fid = Number(it.FileId || it.fileId) || 0;
    var q = 'status?fileId=' + fid + '&taskId=' + encodeURIComponent(ctx.archTask || '') + '&taskType=' + taskType;
    api('GET', ARCH_API + q, '', true, function (d) {
      if (_docCtx !== ctx) return;
      if (!d || d.code !== 0 || !d.data) {
        // 只读的列表任务：网络/服务端瞬时波动 → 自动重试
        if (taskType === 1 && (ctx.archListRetry || 0) < 2) {
          ctx.archListRetry = (ctx.archListRetry || 0) + 1;
          setTimeout(function () { archLoadList(ctx); }, 700);
          return;
        }
        archShowMsg(ctx, '获取失败：' + ((d && d.message) || '未知错误'), '#E5484D'); archSetCancelBtn(ctx, true); return;
      }
      var st = Number(d.data.state);
      if (st === 2) {
        if (taskType === 1) {
          ctx.archEntries = d.data.list || [];
          renderArchCloud(ctx);
        } else {
          toast('文件解压成功');
          closeDocViewer();
          if (state.view === 'files') setTimeout(function () { loadList(); }, 300);
        }
        return;
      }
      if (st === 3) {
        // 偶发“损坏/失败”多为服务端瞬时状态（列表任务只读，可安全重试）
        if (taskType === 1 && (ctx.archListRetry || 0) < 2) {
          ctx.archListRetry = (ctx.archListRetry || 0) + 1;
          archShowMsg(ctx, '正在重新解析压缩包...（第 ' + (ctx.archListRetry + 1) + ' 次尝试）');
          setTimeout(function () { archLoadList(ctx); }, 700);
          return;
        }
        archShowMsg(ctx, '处理失败：' + archErrText(d.data.errCode, d.data.errMsg), '#E5484D'); archSetCancelBtn(ctx, true); return;
      }
      setTimeout(function () { pollArchStatus(ctx, taskType, tries + 1); }, 900);
    });
  }
  // 递归展平：记录层级、祖先与唯一路径（同名文件也能区分）
  function archFlatten(list, depth, out, parents) {
    out = out || [];
    parents = parents || [];
    for (var i = 0; i < (list || []).length; i++) {
      var e = list[i] || {};
      e.__depth = depth || 0;
      e.__parents = parents;
      e.__path = parents.length ? (parents.join('/') + '/' + (e.fileName || '')) : (e.fileName || '');
      out.push(e);
      if (e.childFiles && e.childFiles.length) {
        archFlatten(e.childFiles, (depth || 0) + 1, out, parents.concat([e.fileName]));
      }
    }
    return out;
  }
  // 原样拷贝一个条目（递归去掉内部字段），保留 childFiles 等全部服务端字段
  function archCopyEntry(e) {
    var o = {};
    for (var k in e) {
      if (k === '__depth' || k === '__parents' || k === '__path') continue;
      var v = e[k];
      if (k === 'childFiles' && v && v.length) {
        var kids = [];
        for (var i = 0; i < v.length; i++) kids.push(archCopyEntry(v[i]));
        o[k] = kids;
      } else {
        o[k] = v;
      }
    }
    return o;
  }
  // 构造提交列表（未勾选 → 当前目录全部；已勾选 → 只交勾选项，跳过被已选文件夹覆盖的子孙）
  function buildArchSubmitList(ctx) {
    var sel = ctx.archSel || {};
    var keys = Object.keys(sel);
    var out = [];
    if (!keys.length) {
      var cur = archCurrentEntries(ctx);
      for (var i = 0; i < cur.length; i++) out.push(archCopyEntry(cur[i]));
      return out;
    }
    for (var n = 0; n < keys.length; n++) {
      var en = sel[keys[n]];
      if (!en) continue;
      var covered = false;
      for (var m = 0; m < keys.length; m++) {
        if (m !== n && keys[n].indexOf(keys[m] + '/') === 0) { covered = true; break; }
      }
      if (covered) continue;
      var o = archCopyEntry(en);
      if (Number(en.fileType) !== 1) delete o.childFiles;
      out.push(o);
    }
    return out;
  }
  function archSizeOf(e) {
    if (e && e.childFiles && e.childFiles.length) {
      var kids = archFlatten(e.childFiles, 0, []);
      var sum = 0;
      for (var i = 0; i < kids.length; i++) sum += Number(kids[i].fileSize || 0);
      return sum;
    }
    return Number((e && e.fileSize) || 0);
  }
  function archSelCount(ctx) {
    var n = 0;
    for (var k in (ctx.archSel || {})) n++;
    return n;
  }
  // 当前所在层级的条目列表（archStack 栈顶为当前文件夹）
  function archCurrentEntries(ctx) {
    var stack = ctx.archStack || [];
    return stack.length ? (stack[stack.length - 1].childFiles || []) : (ctx.archEntries || []);
  }
  // 为当前视图条目补上完整路径键（__path），返回扁平列表（用于勾选/提交）
  function archViewFlat(ctx) {
    var stack = ctx.archStack || [];
    var parents = [];
    for (var i = 0; i < stack.length; i++) parents.push(stack[i].fileName || '');
    return archFlatten(archCurrentEntries(ctx), 0, [], parents);
  }
  // 列表：文件夹优先排序；文件夹可进入（‹ 返回上级），文件可勾选；图标无灰底、与底块同尺寸
  function renderArchCloud(ctx) {
    var dk = !!ctx.dk;
    var stack = ctx.archStack || (ctx.archStack = []);
    var cur = archCurrentEntries(ctx);
    var dirs = [], files = [];
    for (var i = 0; i < cur.length; i++) {
      if (Number(cur[i].fileType) === 1) dirs.push(cur[i]); else files.push(cur[i]);
    }
    var view = dirs.concat(files);
    ctx.archView = view;
    ctx.archFlat = archViewFlat(ctx);
    ctx.listWrap.innerHTML = '';
    if (stack.length) {
      var back = document.createElement('div');
      back.style.cssText = 'display:flex;align-items:center;padding:12px 18px;border-bottom:1px solid ' + (ctx.rowBd || '#f5f6f8') + ';color:' + (dk ? '#9DBBFF' : '#2f6bff') + ';font-size:13.5px;font-weight:600;';
      back.textContent = '‹ 返回上级';
      back.addEventListener('click', function () { stack.pop(); renderArchCloud(ctx); });
      ctx.listWrap.appendChild(back);
    }
    if (!view.length) {
      var et = document.createElement('div');
      et.style.cssText = 'padding:30px 18px;text-align:center;font-size:13.5px;color:' + (dk ? '#8A97A8' : '#8a93a3') + ';';
      et.textContent = stack.length ? '此文件夹为空' : '压缩包内没有文件';
      ctx.listWrap.appendChild(et);
      archUpdateBottom(ctx);
      return;
    }
    for (var k = 0; k < view.length; k++) {
      (function (e) {
        var isDir = Number(e.fileType) === 1;
        var on = !!ctx.archSel[e.__path];
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:11px;padding:10px 18px;border-bottom:1px solid ' + (ctx.rowBd || '#f5f6f8') + ';';
        var ic = document.createElement('span');
        ic.style.cssText = 'width:36px;height:36px;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;';
        try { ic.appendChild(makeIcon(isDir ? 'foler' : iconForName(e.fileName || ''), 'file-icon')); } catch (ex) {}
        row.appendChild(ic);
        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        var nm = document.createElement('div');
        nm.style.cssText = 'font-size:14px;color:' + (ctx.tx || '#1a1a1a') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        nm.textContent = e.fileName || '';
        info.appendChild(nm);
        var sub = document.createElement('div');
        var sz = isDir ? '文件夹' : fmtSize(archSizeOf(e));
        var tm = fmtDateTime(e.createTime);
        sub.textContent = (tm && tm !== '-') ? (tm + ' · ' + sz) : sz;
        sub.style.cssText = 'font-size:11.5px;color:' + (ctx.sub || '#9aa3b2') + ';margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        info.appendChild(sub);
        row.appendChild(info);
        if (isDir) {
          var ar = document.createElement('span');
          ar.style.cssText = 'width:30px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;color:' + (dk ? 'rgba(255,255,255,0.45)' : '#b0b6c2') + ';';
          ar.textContent = '›';
          row.appendChild(ar);
          row.addEventListener('click', function () {
            if (!(e.childFiles && e.childFiles.length)) { toast('该文件夹为空'); return; }
            ctx.archStack.push(e);
            renderArchCloud(ctx);
          });
        } else {
          var ck = document.createElement('span');
          ck.style.cssText = 'width:21px;height:21px;border-radius:50%;flex-shrink:0;box-sizing:border-box;border:1.5px solid ' + (dk ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.25)') + ';display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;';
          if (on) { ck.style.background = dk ? '#3A66E0' : '#2f6bff'; ck.style.borderColor = dk ? '#3A66E0' : '#2f6bff'; ck.textContent = '✓'; }
          row.appendChild(ck);
          row.addEventListener('click', function () {
            if (ctx.archSel[e.__path]) { delete ctx.archSel[e.__path]; }
            else { ctx.archSel[e.__path] = e; }
            renderArchCloud(ctx);
          });
        }
        ctx.listWrap.appendChild(row);
      })(view[k]);
    }
    archUpdateBottom(ctx);
  }
  // 底部：未选中 → 「全部解压」；已选中 → 「解压到」；取消态由 archSetCancelBtn 管理
  function archUpdateBottom(ctx) {
    var view = ctx.archView || [];
    var files = [], allOn = true;
    for (var i = 0; i < view.length; i++) {
      if (Number(view[i].fileType) !== 1) {
        files.push(view[i]);
        if (!ctx.archSel[view[i].__path]) allOn = false;
      }
    }
    if (ctx.selAllBtn) ctx.selAllBtn.textContent = (files.length > 0 && allOn) ? '取消全选' : '全选';
    if (ctx.mainBtn) {
      ctx.archCancel = false;
      ctx.mainBtn.textContent = (archSelCount(ctx) > 0) ? '解压到' : '全部解压';
    }
  }
  function archToggleAll(ctx) {
    var view = ctx.archView || [];
    var files = [], allOn = true;
    for (var i = 0; i < view.length; i++) {
      if (Number(view[i].fileType) !== 1) {
        files.push(view[i]);
        if (!ctx.archSel[view[i].__path]) allOn = false;
      }
    }
    if (!files.length) { toast('当前目录没有可勾选的文件'); return; }
    for (var j = 0; j < files.length; j++) {
      if (allOn) delete ctx.archSel[files[j].__path];
      else ctx.archSel[files[j].__path] = files[j];
    }
    renderArchCloud(ctx);
  }
  function archMainAction(ctx) {
    if (archSelCount(ctx) > 0) { openArchPicker(ctx); return; }
    var list = buildArchSubmitList(ctx);
    if (!list.length) { toast('压缩包内没有可解压的文件'); return; }
    doArchUncompress(ctx, list, Number(state.currentDir) || 0);
  }
  // 「解压到」：复用文件夹选择器（临时提高层级，避免被预览层盖住）
  function openArchPicker(ctx) {
    _archPending = ctx;
    state.pickerMode = 'unzip';
    state.pickerItems = null;
    state.pickerState = { dir: 0, path: [] };
    var mp = $('move-picker');
    if (mp) { mp._prevZ = mp.style.zIndex; mp.style.zIndex = '10002'; }
    var t = $('picker-title'); if (t) t.textContent = '解压到';
    var tip = $('picker-tip'); if (tip) tip.textContent = '选择要解压到的文件夹（点「确定解压」解压到当前目录）';
    var c = $('picker-confirm'); if (c) c.textContent = '确定解压';
    show(mp);
    loadPickerDir(0, []);
  }
  function archClosePickerZ() {
    var mp = $('move-picker');
    if (mp && mp._prevZ !== undefined) { mp.style.zIndex = mp._prevZ || ''; mp._prevZ = undefined; }
  }
  // 由 confirmMove 在 pickerMode==='unzip' 时调用
  function archUncompressTo(targetId) {
    var ctx = _archPending;
    _archPending = null;
    archClosePickerZ();
    if (!ctx) return;
    var list = buildArchSubmitList(ctx);
    if (!list.length) { toast('压缩包内没有可解压的文件'); return; }
    doArchUncompress(ctx, list, Number(targetId) || 0);
  }
  // 提交解压（list 由 buildArchSubmitList 构造：原字段、无重复）
  function doArchUncompress(ctx, list, targetId) {
    var it = ctx.archItem || {};
    var fid = Number(it.FileId || it.fileId) || 0;
    var mp = $('move-picker'); if (mp) hide(mp);
    archClosePickerZ();
    var tgt = Number(targetId) || 0;
    var body = JSON.stringify({
      fileId: fid,
      targetFileId: tgt,
      taskId: ctx.archTask,
      list: list
    });
    toast('正在提交解压...');
    api('POST', ARCH_API + 'uncompress', body, true, function (d) {
      if (_docCtx !== ctx) return;
      if (!d || d.code !== 0) {
        var _c = d && d.code;
        var _m = (d && (d.message || d.error)) || archErrText(_c, '');
        archShowMsg(ctx, '解压失败' + (_c !== undefined && _c !== null ? ('（code=' + _c + '）') : '') + '：' + _m, '#E5484D');
        return;
      }
      toast('已提交云端解压，完成后会出现在' + (tgt ? '所选目录' : '当前目录'));
      closeDocViewer();
      if (state.view === 'files') setTimeout(function () { loadList(); }, 800);
    });
  }

  // ---------- 预览容器（统一顶栏；关闭用系统返回键）----------
  var _docCtx = null;
  function closeDocViewer() {
    var ov = document.getElementById('doc-viewer-overlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    document.body.style.overflow = '';
    if (_docCtx && _docCtx.pdf && _docCtx.pdf.destroy) { try { _docCtx.pdf.destroy(); } catch (e) {} }
    _docCtx = null;
  }
  function showDocViewer(title) {
    closeDocViewer();
    var dk = pvDark();
    var bg = dk ? '#14181E' : '#fff';
    var headBg = dk ? '#1A1F26' : '#fff';
    var headBd = dk ? '#2A323D' : '#e5e7eb';
    var tx = dk ? '#E8ECF3' : '#1a1a1a';
    var overlay = document.createElement('div');
    overlay.id = 'doc-viewer-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:' + bg + ';z-index:9999;display:flex;flex-direction:column;';
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid ' + headBd + ';flex-shrink:0;background:' + headBg + ';flex-wrap:wrap;';
    var titleEl = document.createElement('span');
    titleEl.textContent = title || '文档';
    titleEl.style.cssText = 'flex:1;min-width:0;font-size:15px;font-weight:600;color:' + tx + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    header.appendChild(titleEl);
    var ctrl = document.createElement('div');
    ctrl.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;justify-content:flex-end;flex-wrap:wrap;';
    header.appendChild(ctrl);
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow:auto;-webkit-overflow-scrolling:touch;position:relative;background:' + bg + ';';
    overlay.appendChild(header);
    overlay.appendChild(body);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    var ctx = { overlay: overlay, header: header, ctrl: ctrl, body: body, dk: dk };
    _docCtx = ctx;
    return ctx;
  }
  function docBtn(ctx, txt, danger, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    b.style.cssText = 'min-width:46px;height:30px;padding:0 10px;border-radius:8px;border:1px solid '
      + (danger ? 'rgba(231,76,94,0.55)' : ((ctx && ctx.dk) ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.20)'))
      + ';background:transparent;font-size:13px;font-weight:600;color:'
      + (danger ? '#E5484D' : ((ctx && ctx.dk) ? '#E8ECF3' : '#1a1a1a')) + ';';
    b.addEventListener('click', fn);
    ctx.ctrl.appendChild(b);
    return b;
  }
  function docMsg(ctx, msg, color) {
    ctx.body.innerHTML = '';
    var d = document.createElement('div');
    d.style.cssText = 'padding:28px 16px;text-align:center;font-size:14px;color:' + (color || '#888') + ';';
    d.textContent = msg || '';
    ctx.body.appendChild(d);
  }
  // 双指捉合缩放（Word / Excel 预览用；不添加按钮）：getTarget() 每次取实时缩放对象
  function bindPinchZoom(host, getTarget, minS, maxS) {
    var sc = 1, startDist = 0, startSc = 1;
    function dist2(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function applyZoom() {
      var el = getTarget ? getTarget() : null;
      if (!el) return;
      if ('zoom' in el.style) {
        el.style.zoom = (sc === 1 ? '' : String(sc));
      } else {
        el.style.transformOrigin = '0 0';
        el.style.transform = (sc === 1 ? '' : ('scale(' + sc + ')'));
      }
    }
    host.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches.length === 2) { startDist = dist2(e.touches); startSc = sc; }
    }, { passive: true });
    host.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches.length === 2 && startDist > 0) {
        var f = dist2(e.touches) / startDist;
        var lo = minS || 0.5, hi = maxS || 3;
        sc = Math.min(hi, Math.max(lo, startSc * f));
        applyZoom();
        e.preventDefault();
      }
    }, { passive: false });
    host.addEventListener('touchend', function (e) {
      if (!e.touches || e.touches.length < 2) startDist = 0;
    }, { passive: true });
    host.addEventListener('touchcancel', function () { startDist = 0; }, { passive: true });
    return { get: function () { return sc; }, apply: applyZoom };
  }

  // ---------------------------- PDF（只读预览） ----------------------------
  function previewPdf(item) {
    var title = item.FileName || '文档.pdf';
    var id = item.FileId || item.fileId;
    var ctx = showDocViewer(title);
    docMsg(ctx, '正在加载 PDF...');
    ctx.zoom = 1;
    // 本地缓存优先：预览过的 PDF 不再重复下载（省流量）
    cacheGet(id, function (c) {
      if (c && c.kind === 'pdf' && c.data && c.data.length) {
        docMsg(ctx, '正在渲染（本地缓存）...');
        renderPdfBytes(ctx, c.data);
        return;
      }
      getFileLink(item, function (link) {
        if (!link) { docMsg(ctx, '获取文件链接失败', '#E5484D'); return; }
        fetchAsArrayBuffer(link, function (bytes) {
          if (_docCtx !== ctx) return;
          if (!bytes || !bytes.length) { docMsg(ctx, 'PDF 下载失败', '#E5484D'); return; }
          if (bytes.length <= 24 * 1024 * 1024) cachePut(id, 'pdf', bytes, title);   // ≤24MB 落盘缓存
          renderPdfBytes(ctx, bytes);
        });
      }, '获取文件链接失败');
    });
  }
  // PDF 字节 → 渲染（首次下载与缓存复用共用）
  function renderPdfBytes(ctx, bytes) {
    loadPvLib('pdfjsLib', 'lib/pdf.min.js', function () {
      if (!window.pdfjsLib) { docMsg(ctx, 'PDF 组件加载失败', '#E5484D'); return; }
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; } catch (e) {}
      try {
        pdfjsLib.getDocument({ data: bytes }).promise.then(function (doc) {
          if (_docCtx !== ctx) { try { doc.destroy(); } catch (e) {} return; }
          ctx.pdf = doc;
          ctx.page = 1;
          buildPdfChrome(ctx);
          renderPdfPage(ctx, 1);
        }, function () { docMsg(ctx, 'PDF 解析失败', '#E5484D'); });
      } catch (e) { docMsg(ctx, 'PDF 解析失败', '#E5484D'); }
    });
  }
  function buildPdfChrome(ctx) {
    ctx.ctrl.innerHTML = '';
    docBtn(ctx, '上一页', false, function () { if (ctx.page > 1) renderPdfPage(ctx, ctx.page - 1); });
    var info = document.createElement('span');
    info.style.cssText = 'font-size:12px;color:' + ((ctx && ctx.dk) ? '#9BA8B8' : '#666') + ';min-width:54px;text-align:center;';
    info.textContent = '1 / ' + ctx.pdf.numPages;
    ctx.infoEl = info;
    ctx.ctrl.appendChild(info);
    docBtn(ctx, '下一页', false, function () { if (ctx.page < ctx.pdf.numPages) renderPdfPage(ctx, ctx.page + 1); });
    ctx.body.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;margin:0 auto;box-shadow:0 1px 8px rgba(0,0,0,0.18);';
    wrap.appendChild(canvas);
    ctx.body.appendChild(wrap);
    ctx.canvas = canvas;
    // 双指捉合缩放（0.5x ~ 4x）：手势中轻量预览，松手后按新比例重新高清渲染
    (function bindPdfPinch() {
      var startDist = 0, startZoom = 1, gestureZoom = 1, baseZoom = 1;
      function dist2(t) {
        var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
      }
      function preview() {
        var f = gestureZoom / (baseZoom || 1);
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = (Math.abs(f - 1) < 0.01) ? '' : ('scale(' + f + ')');
      }
      ctx.body.addEventListener('touchstart', function (e) {
        if (e.touches && e.touches.length === 2) {
          startDist = dist2(e.touches);
          baseZoom = ctx.zoom || 1;
          startZoom = baseZoom;
          gestureZoom = baseZoom;
        }
      }, { passive: true });
      ctx.body.addEventListener('touchmove', function (e) {
        if (e.touches && e.touches.length === 2 && startDist > 0) {
          gestureZoom = Math.min(4, Math.max(0.5, startZoom * (dist2(e.touches) / startDist)));
          preview();
          e.preventDefault();
        }
      }, { passive: false });
      function endPinch() {
        if (startDist <= 0) return;
        startDist = 0;
        canvas.style.transform = '';
        var nz = Math.round(gestureZoom * 100) / 100;
        if (Math.abs(nz - (ctx.zoom || 1)) > 0.01) {
          ctx.zoom = nz;
          renderPdfPage(ctx, ctx.page || 1);
        }
      }
      ctx.body.addEventListener('touchend', function (e) {
        if (!e.touches || e.touches.length < 2) endPinch();
      }, { passive: true });
      ctx.body.addEventListener('touchcancel', function () { startDist = 0; canvas.style.transform = ''; }, { passive: true });
    })();
  }
  function renderPdfPage(ctx, n) {
    if (_docCtx !== ctx || !ctx.pdf || !ctx.canvas) return;
    if (ctx.task) { try { ctx.task.cancel(); } catch (e) {} }
    ctx.pdf.getPage(n).then(function (page) {
      if (_docCtx !== ctx) return;
      ctx.page = n;
      if (ctx.infoEl) ctx.infoEl.textContent = n + ' / ' + ctx.pdf.numPages;
      var base = page.getViewport({ scale: 1 });
      var avail = (ctx.body.clientWidth || 320) - 24;
      var scale = (avail / base.width) * (ctx.zoom || 1);
      var vp = page.getViewport({ scale: scale });
      var dpr = window.devicePixelRatio || 1;
      ctx.canvas.width = Math.floor(vp.width * dpr);
      ctx.canvas.height = Math.floor(vp.height * dpr);
      ctx.canvas.style.width = Math.floor(vp.width) + 'px';
      ctx.canvas.style.height = Math.floor(vp.height) + 'px';
      var g = ctx.canvas.getContext('2d');
      // 高清输出：使用 pdf.js 官方推荐的 transform 参数（手动 setTransform 在 Chromium 会失效 → 放大发糊）
      ctx.task = page.render({ canvasContext: g, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      if (ctx.task && ctx.task.promise) ctx.task.promise.then(function () {}, function () {});
    }, function () {});
  }

  // ---------------------------- Word（docx：预览 · 编辑 · 保存） ----------------------------
  function previewDocx(item) {
    var title = item.FileName || '文档.docx';
    var ctx = showDocViewer(title);
    docMsg(ctx, '正在加载 Word 文档...');
    getFileLink(item, function (link) {
      if (!link) { docMsg(ctx, '获取文件链接失败', '#E5484D'); return; }
      fetchAsArrayBuffer(link, function (bytes) {
        if (_docCtx !== ctx) return;
        if (!bytes || !bytes.length) { docMsg(ctx, 'Word 文档下载失败', '#E5484D'); return; }
        loadPvLib('mammoth', 'lib/mammoth.browser.min.js', function () {
          if (!window.mammoth) { docMsg(ctx, 'Word 组件加载失败', '#E5484D'); return; }
          try {
            mammoth.convertToHtml({ arrayBuffer: bytes.buffer }).then(function (r) {
              if (_docCtx !== ctx) return;
              var html = (r && r.value) ? r.value : '';
              if (!html) { docMsg(ctx, '未能解析出文档内容', '#E5484D'); return; }
              renderDocxPreview(ctx, html, item, title);
            }, function () { docMsg(ctx, 'Word 解析失败', '#E5484D'); });
          } catch (e) { docMsg(ctx, 'Word 解析失败', '#E5484D'); }
        });
      });
    }, '获取文件链接失败');
  }
  function renderDocxPreview(ctx, html, item, title) {
    ctx.body.innerHTML = '';
    var box = document.createElement('div');
    box.style.cssText = 'padding:16px;font-size:15px;line-height:1.8;color:' + ((ctx && ctx.dk) ? '#E8ECF3' : '#1a1a1a') + ';word-break:break-word;outline:none;';
    box.innerHTML = html;
    ctx.body.appendChild(box);
    // 双指捉合缩放（0.5x ~ 3x，不加按钮）
    try { bindPinchZoom(ctx.body, function () { return box; }, 0.5, 3); } catch (e) {}
    var editing = false, origHtml = html;
    function apply() {
      try { box.contentEditable = editing ? 'true' : 'false'; } catch (e) {}
      box.style.background = editing ? ((ctx && ctx.dk) ? '#2A2A20' : '#fffdf3') : '';
      ctx.ctrl.innerHTML = '';
      if (!editing) {
        docBtn(ctx, '编辑', false, function () { editing = true; apply(); });
      } else {
        docBtn(ctx, '取消', true, function () { editing = false; box.innerHTML = origHtml; apply(); });
        docBtn(ctx, '保存', false, function () { saveDocx(item, title, box.innerHTML); });
      }
    }
    apply();
  }
  function saveDocx(item, title, html) {
    var bytes = null;
    try { bytes = htmlToDocxBytes(html); } catch (e) { bytes = null; }
    if (!bytes || !bytes.length) { toast('生成 docx 失败'); return; }
    toast('正在保存...');
    uploadFileBytes(bytes, title, state.currentDir, function () {
      toast('已保存并覆盖原文件');
      closeDocViewer();
      if (state.view === 'files') setTimeout(function () { loadList(); }, 300);
    }, function (m) { toast(String(m || '保存失败').slice(0, 90)); });
  }

  // ---------------------------- Excel（xlsx：预览 · 编辑 · 保存） ----------------------------
  function previewXlsx(item) {
    var title = item.FileName || '表格.xlsx';
    var ctx = showDocViewer(title);
    docMsg(ctx, '正在加载表格...');
    getFileLink(item, function (link) {
      if (!link) { docMsg(ctx, '获取文件链接失败', '#E5484D'); return; }
      fetchAsArrayBuffer(link, function (bytes) {
        if (_docCtx !== ctx) return;
        if (!bytes || !bytes.length) { docMsg(ctx, '表格下载失败', '#E5484D'); return; }
        loadPvLib('XLSX', 'lib/xlsx.full.min.js', function () {
          if (!window.XLSX) { docMsg(ctx, '表格组件加载失败', '#E5484D'); return; }
          var wb = null;
          try { wb = XLSX.read(bytes, { type: 'array' }); } catch (e) { wb = null; }
          if (!wb || !wb.SheetNames || !wb.SheetNames.length) { docMsg(ctx, '未能解析出表格内容', '#E5484D'); return; }
          renderXlsxPreview(ctx, wb, item, title);
        });
      });
    }, '获取文件链接失败');
  }
  function renderXlsxPreview(ctx, wb, item, title) {
    ctx.body.innerHTML = '';
    var editing = false, cur = 0, tableEl = null;
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;';
    var tabsEl = document.createElement('div');
    tabsEl.style.cssText = 'display:flex;gap:6px;padding:8px 10px;overflow-x:auto;border-bottom:1px solid ' + ((ctx && ctx.dk) ? '#2A323D' : '#eee') + ';flex-shrink:0;';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'flex:1;overflow:auto;-webkit-overflow-scrolling:touch;';
    host.appendChild(tabsEl);
    host.appendChild(wrap);
    ctx.body.appendChild(host);
    // 双指捉合缩放（0.5x ~ 3x，不加按钮；切表/编辑重绘后保持）
    var pz = bindPinchZoom(wrap, function () { return tableEl; }, 0.5, 3);
    function aoaOf(ws) {
      var out = [];
      try { out = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: '' }); } catch (e) { out = []; }
      return out || [];
    }
    function drawTabs() {
      tabsEl.innerHTML = '';
      for (var i = 0; i < wb.SheetNames.length; i++) {
        (function (i) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = wb.SheetNames[i];
          b.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid '
            + (i === cur ? 'rgba(64,128,255,0.7)' : ((ctx && ctx.dk) ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.18)')) + ';background:'
            + (i === cur ? 'rgba(64,128,255,0.12)' : 'transparent') + ';font-size:12px;color:' + ((ctx && ctx.dk) ? '#E8ECF3' : '#1a1a1a') + ';white-space:nowrap;';
          b.addEventListener('click', function () { if (editing) return; cur = i; drawTabs(); drawSheet(); });
          tabsEl.appendChild(b);
        })(i);
      }
    }
    function drawSheet() {
      var ws = wb.Sheets[wb.SheetNames[cur]];
      var aoa = aoaOf(ws);
      var rows = aoa.length; if (rows > 400) rows = 400;
      var maxC = 0;
      for (var i = 0; i < rows; i++) { if (aoa[i] && aoa[i].length > maxC) maxC = aoa[i].length; }
      if (maxC > 40) maxC = 40;
      if (maxC < 1) maxC = 1;
      wrap.innerHTML = '';
      var tb = document.createElement('table');
      tb.style.cssText = 'border-collapse:collapse;font-size:13px;color:' + ((ctx && ctx.dk) ? '#E8ECF3' : '#1a1a1a') + ';';
      for (var r = 0; r < rows; r++) {
        var tr = document.createElement('tr');
        for (var c = 0; c < maxC; c++) {
          var td = document.createElement('td');
          td.style.cssText = 'border:1px solid ' + ((ctx && ctx.dk) ? '#2A323D' : '#e5e7eb') + ';padding:4px 8px;white-space:nowrap;max-width:240px;overflow:hidden;vertical-align:top;';
          td.textContent = (aoa[r] && aoa[r][c] != null) ? String(aoa[r][c]) : '';
          if (editing) td.setAttribute('contenteditable', 'true');
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      wrap.appendChild(tb);
      tableEl = tb;
      try { pz.apply(); } catch (e) {}
    }
    function apply() {
      ctx.ctrl.innerHTML = '';
      if (!editing) {
        docBtn(ctx, '编辑', false, function () { editing = true; apply(); drawSheet(); });
      } else {
        docBtn(ctx, '取消', true, function () { editing = false; apply(); drawSheet(); });
        docBtn(ctx, '保存', false, function () { saveXlsx(wb, item, title, wb.SheetNames[cur], tableEl); });
      }
    }
    drawTabs();
    drawSheet();
    apply();
  }
  function saveXlsx(wb, item, title, sheetName, tableEl) {
    var bytes = null;
    try {
      if (!tableEl) { toast('表格未就绪'); return; }
      var aoa = [];
      var trs = tableEl.querySelectorAll('tr');
      for (var i = 0; i < trs.length; i++) {
        var tds = trs[i].querySelectorAll('td,th');
        var line = [];
        for (var j = 0; j < tds.length; j++) {
          var t = tds[j].textContent == null ? '' : String(tds[j].textContent);
          var num = Number(t);
          if (t !== '' && !isNaN(num) && isFinite(num)) line.push(num); else line.push(t);
        }
        aoa.push(line);
      }
      wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(aoa);
      var out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      bytes = new Uint8Array(out);
    } catch (e) { bytes = null; }
    if (!bytes || !bytes.length) { toast('生成表格失败'); return; }
    toast('正在保存...');
    uploadFileBytes(bytes, title, state.currentDir, function () {
      toast('已保存并覆盖原文件');
      closeDocViewer();
      if (state.view === 'files') setTimeout(function () { loadList(); }, 300);
    }, function (m) { toast(String(m || '保存失败').slice(0, 90)); });
  }
  // ================== 省流量：按需取字节（HTTP Range） ==================
  // 大文件预览不再整包下载：优先只取需要的片段，失败自动退回整包（保证功能不回退）
  function _b64ToU8(b64) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  // 取一段字节（HTTP Range）。成功 → Uint8Array；失败 → null
  // 优先走原生：WebView 里给 XHR 加自定义 Range 头会触发跨域预检（CDN 通常不允许），
  // 而原生 HttpURLConnection 不受此限制，且能真正“只读需要的字节 + 立即断开”。
  function rangeGet(link, start, end, cb) {
    if (bridge && bridge.rangeFetchBase64) {
      try {
        var b64 = bridge.rangeFetchBase64(link, Number(start) || 0, Number(end) || 0);
        if (b64 && b64.length) { cb(_b64ToU8(b64), true); return; }
        cb(null, false);
        return;
      } catch (e) { /* 原生不可用则回落到 XHR */ }
    }
    rangeGetXhr(link, start, end, cb);
  }
  function rangeGetXhr(link, start, end, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', previewSrc(link), true);
      xhr.responseType = 'arraybuffer';
      try { xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end); } catch (e) {}
      var finished = false;
      function finish(u8, ok) {
        if (finished) return;
        finished = true;
        cb(u8, ok);
      }
      // 关键：响应头一到就检查状态码。若不是 206（服务器忽略了 Range）→ 立刻 abort，
      // 避免把整个文件（可能是 1GB）收下来。
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2 && xhr.status !== 206) {
          try { xhr.abort(); } catch (e) {}
          finish(null, false);
        }
      };
      xhr.onload = function () {
        if (xhr.status !== 206) { finish(null, false); return; }
        var buf = xhr.response;
        if (!buf) { finish(null, false); return; }
        finish(new Uint8Array(buf), true);
      };
      xhr.onerror = function () { finish(null, false); };
      xhr.send();
    } catch (e) { cb(null); }
  }
  // 自建 Reader：继承 zip.Reader（拿 readable 占位，满足 zip.js 内部属性赋值）
  //   size 从调用方传入（文件列表里的 Size），zip.js 因此不会再做任何网络探测
  function makeZipRangeReader(link, size) {
    var Base = zip.Reader;
    function R() { Base.call(this); }
    // 注：zip.Reader 若为 ES6 class，不能用 call 构造 → 则回退到原型对象方案
    var inst;
    try {
      R.prototype = Object.create(Base.prototype);
      R.prototype.constructor = R;
      inst = new R();
    } catch (e) { inst = null; }
    if (!inst) {
      inst = Object.create(Base.prototype || {});
    }
    inst.link = link;
    inst.size = (Number(size) || 0);
    inst.readable = {};       // zip.js 会向它 assign 条目偏移/长度
    inst.readUint8Array = function (offset, length) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var len = Number(length);
        // 关键防线：长度非法（undefined / NaN / <=0）时，绝不能“读到文件尾”。
        // zip.js 的 readable 流在 offset/size 未被赋值时会传出 NaN，
        // 若直接拼进 Range 头（bytes=0-NaN），服务器会一路读到 EOF → 整包被拉走。
        if (!isFinite(len) || len <= 0) len = 65536;
        var start = Number(offset) || 0;
        if (start >= self.size) { reject(new Error('out of range')); return; }
        var end = start + len - 1;
        if (end >= self.size) end = self.size - 1;
        if (end < start) { reject(new Error('bad range')); return; }
        rangeGet(self.link, start, end, function (u8, ok) {
          if (!ok || !u8) {
            self.rangeUnsupported = true;   // 供上层判断：该服务器无法分段读取
            reject(new Error('range read failed'));
            return;
          }
          resolve(u8.subarray(0, end - start + 1));
        });
      });
    };
    return inst;
  }

  // 探测服务器是否支持分段读取（HTTP Range）  // 探测服务器是否支持分段读取（HTTP Range）
  // 关键：一旦发现服务器返回 200（忽略 Range），**立即中止**，绝不把整包拉下来
  function probeRangeOk(link, cb) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', previewSrc(link), true);
      try { xhr.setRequestHeader('Range', 'bytes=0-1023'); } catch (e) {}
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        try { xhr.abort(); } catch (e) {}
        cb(ok);
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2) {
          if (xhr.status === 206) { finish(true); return; }
          if (xhr.status === 200) { finish(false); return; }   // 服务器忽略了 Range → 立即断开
        } else if (xhr.readyState === 4) {
          finish(xhr.status === 206);
        }
      };
      xhr.onerror = function () { finish(false); };
      xhr.send();
    } catch (e) { cb(false); }
  }
  // 大文件阈值：超过它就绝不自动整包下载（避免“点一下 1GB 就没了”）
  var ARCH_AUTO_FULL_LIMIT = 15728640;   // 15MB
  // 打开 zip：直接用原生 Range Reader 只取中央目录（不再发探测请求，避免跨域预检被拦）
  // 若服务器不支持分段读取：大文件【不自动下载】，交用户决定；小文件才整包下载
  function zipOpenSmart(link, sizeHint, cb) {
    var sz = Number(sizeHint) || 0;
    // 大小未知也按大文件对待：宁可让用户确认，也不冒险拉整包
    var big = (sz <= 0) || (sz > ARCH_AUTO_FULL_LIMIT);
    loadPvLib('zip', 'lib/zip-no-worker-inflate.min.js', function () {
      if (!window.zip || !zip.Reader) { cb({ needFull: true, size: sz }); return; }
      var rd = makeZipRangeReader(link, sz);
      var zr = null;
      try { zr = new zip.ZipReader(rd); } catch (e) { zr = null; }
      if (!zr) { cb({ needFull: true, size: sz }); return; }
      zr.getEntries().then(function (entries) {
        cb({ reader: zr, entries: entries || [], range: true });
      }, function () {
        try { zr.close(); } catch (e) {}
        if (big) { cb({ needFull: true, size: sz }); return; }
        zipOpenFull(link, cb);
      });
    });
  }
  function zipOpenFull(link, cb) {
    fetchAsArrayBuffer(link, function (bytes) {
      if (!bytes || !bytes.length) { cb(null); return; }
      try {
        var r2 = new zip.ZipReader(new zip.Uint8ArrayReader(bytes));
        r2.getEntries().then(function (e2) { cb({ reader: r2, entries: e2 || [], range: false }); }, function () { cb(null); });
      } catch (e) { cb(null); }
    });
  }
  // ---------- 文本文件预览（只读，带缓存） ----------
  function previewTextFile(item) {
    var title = item.FileName || '文件';
    // 刚在预览里编辑保存过的文件：用本会话内存里的新内容（不落盘缓存）
    state.txtSaved = state.txtSaved || {};
    if (state.txtSaved[title] != null) { showTextViewer(state.txtSaved[title], title); return; }
    // 不用缓存：每次打开都重新从网络获取，避免再打开时看到旧内容
    toast('正在加载内容...');
    getFileLink(item, function (link) {
      if (!link) { toast('获取文件链接失败'); return; }
      fetchAsDataUrl(link, function (dataUrl) {
        if (dataUrl) {
          var text = '';
          try { text = decodeURIComponent(escape(atob(dataUrl.split(',')[1] || ''))); } catch (e) { text = ''; }
          if (text) { showTextViewer(text, title); return; }
        }
        showTextPreview(link, title);   // 取不到内容 → 退回直接 fetch
      });
    }, '获取文件链接失败');
  }

  function showTextPreview(url, title) {
    // 用 fetch 获取文本内容
    fetch(previewSrc(url))
      .then(function(response) {
        if (!response.ok) throw new Error('加载失败');
        return response.text();
      })
      .then(function(content) {
        showTextViewer(content, title);
      })
      .catch(function() {
        // 如果 fetch 失败，尝试用 iframe 方式加载
        showTextPreviewFallback(url, title);
      });
  }

  function showTextViewer(content, title) {
    var existing = document.getElementById('text-viewer-overlay');
    if (existing) {
      document.body.removeChild(existing);
    }
    
    var overlay = document.createElement('div');
    overlay.id = 'text-viewer-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.95);z-index:9999;display:flex;flex-direction:column;';
    
    // 标题栏（右侧原来是 ✕，现在放缩放 + 操作按钮；关闭用系统返回键）
    var header = document.createElement('div');
    header.className = 'tv-head';
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e5e7eb;flex-shrink:0;background:#fff;flex-wrap:wrap;';
    
    var titleEl = document.createElement('span');
    titleEl.textContent = title || '文件内容';
    titleEl.style.cssText = 'flex:1;min-width:0;font-size:16px;font-weight:500;color:#1a1a1a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    header.appendChild(titleEl);
    
    overlay.appendChild(header);
    
    // 内容区域
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'flex:1;padding:16px;overflow:auto;';
    
    var ext = (title || '').split('.').pop().toLowerCase();
    var isHtml = ext === 'html' || ext === 'htm';
    
    if (isHtml) {
      var iframe = document.createElement('iframe');
      iframe.className = 'tv-frame';
      iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;border-radius:8px;';
      // 夜间：没有 <body> 的简易 HTML / 文本补一层深色底 + 浅色字（自带样式的页面不干预）
      iframe.srcdoc = (isSystemDark() && !/<body[\s>]/i.test(content))
        ? (content + '<style>html,body{background:#1A1F26;color:#E8ECF3;}</style>')
        : content;
      wrapper.appendChild(iframe);
    }
    var textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.className = 'tv-text';
      // 字号只作用于「当前这个文档」：每次打开都是默认 14px，关闭预览即丢弃（不跨文档）
      // textarea 不能用 transform 缩放（光标/选区会错位），改字号才正确
      var _fs = 14;          // 默认 14px
      textarea.style.cssText = 'width:100%;height:100%;padding:12px;border:1px solid #e5e7eb;border-radius:8px;font-family:monospace;font-size:' + _fs + 'px;line-height:1.6;resize:none;background:#f5f5f5;color:#1a1a1a;outline:none;';
      textarea.readOnly = true;
      if (isHtml) textarea.style.display = 'none';   // HTML：默认显示预览，切「源码」时才显示
      wrapper.appendChild(textarea);

      // 双指捉合缩放字号
      var _fsPinch = 0, _fsStart = _fs;
      function _setFs(v) {
        if (v < 2) v = 2;                      // 最小 2px
        if (v > 32) v = 32;
        _fs = Math.round(v);
        textarea.style.fontSize = _fs + 'px';  // 仅当前文档有效
        if (_fsTag) _fsTag.textContent = _fs + 'px';
      }

      // ============ 控制区：缩放 + 操作按钮（已从底部悬浮条搬到顶栏右侧，替代原来的 ✕） ============
      var _dark = document.documentElement.classList.contains('dark');
      function _mkBtn(txt, danger) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = txt;
        b.style.cssText = 'min-width:46px;height:30px;padding:0 10px;border-radius:8px;border:1px solid '
          + (danger ? 'rgba(231,76,94,0.55)' : (_dark ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.20)'))
          + ';background:transparent;font-size:13px;font-weight:600;color:'
          + (danger ? '#E5484D' : (_dark ? '#E8ECF3' : '#1a1a1a')) + ';';
        return b;
      }
      var _ctrl = document.createElement('div');
      _ctrl.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;justify-content:flex-end;flex-wrap:wrap;';
      var _zoomRow = document.createElement('div');
      _zoomRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';
      var _btnRow = document.createElement('div');
      _btnRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';
      var _btnMinus = _mkBtn('A-', false);
      var _fsTag = document.createElement('span');
      _fsTag.textContent = _fs + 'px';
      _fsTag.style.cssText = 'font-size:11px;min-width:34px;text-align:center;color:' + (_dark ? '#9BA8B8' : '#666') + ';';
      var _btnPlus = _mkBtn('A+', false);
      var _btnEdit = _mkBtn('编辑', false);
      var _btnSave = _mkBtn('保存', false);
      var _btnCancel = _mkBtn('取消', true);
      // HTML：源码 / 预览 切换（仅非编辑态显示）
      var _btnSrc = _mkBtn('预览', false);
      var _srcMode = false;
      var _preEditSrc = false;
      // <body 标签探测：等价于旧正则「<body 后跟空白或 >」，用字符码判断（源码保持无反斜杠）
      function _hasBody(h) {
        var s = String(h).toLowerCase(), i = s.indexOf('<body');
        while (i > -1) {
          var c = s.charCodeAt(i + 5) || 0;
          if (c === 62 || c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 ||
              (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
              c === 0x205f || c === 0x3000 || c === 0xfeff) return true;
          i = s.indexOf('<body', i + 1);
        }
        return false;
      }
      function _setSrcMode(on) {
        if (!isHtml || !iframe) return;
        _srcMode = !!on;
        if (_srcMode) {
          textarea.style.display = '';
          iframe.style.display = 'none';
        } else {
          // 切回预览：把 textarea 当前内容（含未保存的编辑）塞回 iframe.srcdoc
          var v = textarea.value;
          iframe.srcdoc = (isSystemDark() && !_hasBody(v))
            ? (v + '<style>html,body{background:#1A1F26;color:#E8ECF3;}</style>')
            : v;
          textarea.style.display = 'none';
          iframe.style.display = '';
        }
      }
      // 按钮显隐统一在这里决定
      //  非编辑态：TXT → 「编辑」；HTML → 「编辑 + 预览/源码」
      //  编辑态：  TXT / HTML → 「取消 + 保存」
      function _applyBarState() {
        _btnEdit.style.display = _editing ? 'none' : '';
        _btnCancel.style.display = _editing ? '' : 'none';
        _btnSave.style.display = _editing ? '' : 'none';
        if (isHtml) {
          _btnSrc.style.display = _editing ? 'none' : '';
          _btnSrc.textContent = _srcMode ? '源码' : '预览';
        } else {
          _btnSrc.style.display = 'none';
        }
        // 缩放组件：TXT 一直显示；HTML 仅编辑态显示（非编辑态是渲染预览，缩放无意义）
        _zoomRow.style.display = (!isHtml || _editing) ? '' : 'none';
      }
      _btnSrc.addEventListener('click', function () {
        if (!isHtml || _editing) return;
        _setSrcMode(!_srcMode);
        _applyBarState();
      });
      _btnMinus.addEventListener('click', function () { _setFs(_fs - 1); });
      _btnPlus.addEventListener('click', function () { _setFs(_fs + 1); });
      _zoomRow.appendChild(_btnMinus); _zoomRow.appendChild(_fsTag); _zoomRow.appendChild(_btnPlus);
      _btnRow.appendChild(_btnCancel); _btnRow.appendChild(_btnSave);
      _btnRow.appendChild(_btnEdit); _btnRow.appendChild(_btnSrc);
      _ctrl.appendChild(_zoomRow); _ctrl.appendChild(_btnRow);
      header.appendChild(_ctrl);   // 顶栏右侧（原 ✕ 的位置）

      // ================= 编辑 & 保存（直接覆盖原文件） =================
      var _origText = content;
      var _editing = false;
      function _enterEdit() {
        if (isHtml) { _preEditSrc = _srcMode; if (!_srcMode) _setSrcMode(true); }   // HTML：先切到源码视图再编辑
        _editing = true;
        textarea.readOnly = false;
        _applyBarState();
        try { textarea.focus(); } catch (e) {}
      }
      function _exitEdit() {
        _editing = false;
        textarea.value = _origText;
        textarea.readOnly = true;
        if (isHtml && _srcMode && !_preEditSrc) _setSrcMode(false);   // 取消编辑时回到进入前的视图
        _applyBarState();
        try { if (bridge && bridge.hideKeyboard) bridge.hideKeyboard(); } catch (e) {}
      }
      _btnCancel.addEventListener('click', function () { _exitEdit(); });
      _btnSave.addEventListener('click', function () { _saveText(); });
      _btnEdit.addEventListener('click', function () { _enterEdit(); });
      _applyBarState();   // 初始：TXT=「编辑」；HTML=「编辑 + 预览」

      // ---------- MD5（upload_request 的 etag 必填，服务端会校验）----------
      function _md5Hex(str) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function au(x, y) {
          var l = (x & 0xFFFF) + (y & 0xFFFF);
          return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF);
        }
        function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

        var bytes = _u8(str);
        var n = bytes.length;
        var words = [];
        var i;
        for (i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
        words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
        var total = (((n + 8) >> 6) + 1) * 16;
        for (i = 0; i < total; i++) if (words[i] === undefined) words[i] = 0;
        words[total - 2] = n * 8;

        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (i = 0; i < total; i += 16) {
          var oa = a, ob = b, oc = c, od = d;
          a = ff(a, b, c, d, words[i], 7, -680876936);
          d = ff(d, a, b, c, words[i + 1], 12, -389564586);
          c = ff(c, d, a, b, words[i + 2], 17, 606105819);
          b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
          a = ff(a, b, c, d, words[i + 4], 7, -176418897);
          d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
          c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
          b = ff(b, c, d, a, words[i + 7], 22, -45705983);
          a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
          d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
          c = ff(c, d, a, b, words[i + 10], 17, -42063);
          b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
          a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
          d = ff(d, a, b, c, words[i + 13], 12, -40341101);
          c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
          b = ff(b, c, d, a, words[i + 15], 22, 1236535329);
          a = gg(a, b, c, d, words[i + 1], 5, -165796510);
          d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
          c = gg(c, d, a, b, words[i + 11], 14, 643717713);
          b = gg(b, c, d, a, words[i], 20, -373897302);
          a = gg(a, b, c, d, words[i + 5], 5, -701558691);
          d = gg(d, a, b, c, words[i + 10], 9, 38016083);
          c = gg(c, d, a, b, words[i + 15], 14, -660478335);
          b = gg(b, c, d, a, words[i + 4], 20, -405537848);
          a = gg(a, b, c, d, words[i + 9], 5, 568446438);
          d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
          c = gg(c, d, a, b, words[i + 3], 14, -187363961);
          b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
          a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
          d = gg(d, a, b, c, words[i + 2], 9, -51403784);
          c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
          b = gg(b, c, d, a, words[i + 12], 20, -1926607734);
          a = hh(a, b, c, d, words[i + 5], 4, -378558);
          d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
          c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
          b = hh(b, c, d, a, words[i + 14], 23, -35309556);
          a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
          d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
          c = hh(c, d, a, b, words[i + 7], 16, -155497632);
          b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
          a = hh(a, b, c, d, words[i + 13], 4, 681279174);
          d = hh(d, a, b, c, words[i], 11, -358537222);
          c = hh(c, d, a, b, words[i + 3], 16, -722521979);
          b = hh(b, c, d, a, words[i + 6], 23, 76029189);
          a = hh(a, b, c, d, words[i + 9], 4, -640364487);
          d = hh(d, a, b, c, words[i + 12], 11, -421815835);
          c = hh(c, d, a, b, words[i + 15], 16, 530742520);
          b = hh(b, c, d, a, words[i + 2], 23, -995338651);
          a = ii(a, b, c, d, words[i], 6, -198630844);
          d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
          c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
          b = ii(b, c, d, a, words[i + 5], 21, -57434055);
          a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
          d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
          c = ii(c, d, a, b, words[i + 10], 15, -1051523);
          b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
          a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
          d = ii(d, a, b, c, words[i + 15], 10, -30611744);
          c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
          b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
          a = ii(a, b, c, d, words[i + 4], 6, -145523070);
          d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
          c = ii(c, d, a, b, words[i + 2], 15, 718787259);
          b = ii(b, c, d, a, words[i + 9], 21, -343485551);
          a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
        }
        var out = '';
        [a, b, c, d].forEach(function (x) {
          for (var j = 0; j < 4; j++) out += ('0' + ((x >> (j * 8)) & 0xFF).toString(16)).slice(-2);
        });
        return out;
      }

      function _u8(s) {
        if (window.TextEncoder) { try { return new TextEncoder().encode(s); } catch (e) {} }
        var utf8 = unescape(encodeURIComponent(s));
        var a = [];
        for (var i = 0; i < utf8.length; i++) a.push(utf8.charCodeAt(i));
        return a;
      }
      function _okSave() {
        toast('已保存并覆盖原文件');
        _origText = textarea.value;
        // 记住新内容：再次打开这个文件时直接用内存里的，不再读旧的 IndexedDB 预览缓存
        // （否则会出现“云端已改、预览还是原文”）
        state.txtSaved = state.txtSaved || {};
        state.txtSaved[title || 'file.txt'] = textarea.value;
        _exitEdit();
        try { closeTextViewer(); } catch (e) {}
        if (state.view === 'files') setTimeout(function () { loadList(); }, 300);
      }
      function _failSave(m) {
        _btnSave.disabled = false;
        toast(String(m || '保存失败').slice(0, 90));
      }
      // 直传：先试 fetch（快），跨域被拦则退回原生通道
      function _putBody(url, text, cb) {
        var triedBridge = false;
        function viaBridge() {
          if (triedBridge) return;
          triedBridge = true;
          api('PUT', url, text, false, function (d) { cb(!!d); });
        }
        try {
          if (window.fetch) {
            fetch(url, { method: 'PUT', body: text, mode: 'cors' })
              .then(function (res) { cb(!!(res && res.status >= 200 && res.status < 300)); }, function () { viaBridge(); });
            return;
          }
        } catch (e) {}
        viaBridge();
      }
      // 纯 JS 上传（协议来自原生 MainActivity.uploadFile）：
      //  1) upload_request  2) s3_upload_object/auth  3) PUT 直传  4) upload_complete/v2
      //  duplicate:2 = 同名直接覆盖
      function _saveText() {
        var text = textarea.value;
        var fname = title || 'file.txt';
        var parentId = Number(state.currentDir) || 0;
        var size = _u8(text).length;
        _btnSave.disabled = true;
        toast('正在保存...');
        var b1 = JSON.stringify({
          driveId: 0, fileName: fname, etag: _md5Hex(text), size: size,
          parentFileId: parentId, type: 0, duplicate: 2
        });
        api('POST', 'https://api.123pan.cn/b/api/file/upload_request', b1, true, function (r1) {
          if (!r1 || r1.code !== 0 || !r1.data) {
            _failSave('创建上传失败：' + ((r1 && (r1.message || r1.error)) || ('code=' + (r1 && r1.code))));
            return;
          }
          var d = r1.data || {};
          var bucket = d.Bucket || '', node = d.StorageNode || '', key = d.Key || '', upid = d.UploadId || '';
          // 注意：服务端字段是 FileId（首字母大写）！用 d.fileId 会拿到 undefined → fid=0 → “非法请求(fid=0)”
          var fid = Number(d.FileId || d.fileId || 0);
          if (d.Reuse) { _okSave(); return; }   // 云端已有相同内容 → 秒传复用
          var b2 = JSON.stringify({
            bucket: bucket, key: key, partNumberStart: 1, partNumberEnd: 2,
            uploadId: upid, StorageNode: node
          });
          api('POST', 'https://api.123pan.cn/b/api/file/s3_upload_object/auth', b2, true, function (r2) {
            if (!r2 || r2.code !== 0 || !r2.data) {
              _failSave('上传鉴权失败：' + ((r2 && (r2.message || r2.error)) || ('code=' + (r2 && r2.code))));
              return;
            }
            var urls = r2.data.presignedUrls || {};
            var putUrl = urls['1'] || '';
            if (!putUrl) { for (var k in urls) { if (urls[k]) { putUrl = urls[k]; break; } } }
            if (!putUrl) { _failSave('未取到上传地址'); return; }
            _putBody(putUrl, text, function (ok) {
              if (!ok) { _failSave('上传数据失败（网络或跨域限制）'); return; }
              var b3 = JSON.stringify({
                fileId: fid, bucket: bucket, fileSize: size, key: key,
                isMultipart: false, uploadId: upid, StorageNode: node
              });
              api('POST', 'https://api.123pan.cn/b/api/file/upload_complete/v2', b3, true, function (r3) {
                if (r3 && r3.code === 0) _okSave();
                else _failSave('收尾失败：' + ((r3 && (r3.message || r3.error)) || ('code=' + (r3 && r3.code))));
              });
            });
          });
        });
      }
      wrapper.addEventListener('touchstart', function (e) {
        if (e.touches.length === 2) {
          var dx = e.touches[0].clientX - e.touches[1].clientX;
          var dy = e.touches[0].clientY - e.touches[1].clientY;
          _fsPinch = Math.sqrt(dx * dx + dy * dy);
          _fsStart = _fs;
        }
      }, { passive: true });
      wrapper.addEventListener('touchmove', function (e) {
        if (e.touches.length === 2 && _fsPinch > 0) {
          var dx2 = e.touches[0].clientX - e.touches[1].clientX;
          var dy2 = e.touches[0].clientY - e.touches[1].clientY;
          var d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          _setFs(_fsStart * (d2 / _fsPinch));
          e.preventDefault();
        }
      }, { passive: false });
    
    overlay.appendChild(wrapper);
    
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
  }

  function showTextPreviewFallback(url, title) {
    url = previewSrc(url);
    var existing = document.getElementById('text-viewer-overlay');
    if (existing) {
      document.body.removeChild(existing);
    }
    
    var overlay = document.createElement('div');
    overlay.id = 'text-viewer-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.95);z-index:9999;display:flex;flex-direction:column;';
    
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #e5e7eb;flex-shrink:0;background:#fff;';
    
    var titleEl = document.createElement('span');
    header.className = 'tv-head';
    titleEl.textContent = title || '文件预览';
    titleEl.style.cssText = 'font-size:16px;font-weight:500;color:#1a1a1a;';
    header.appendChild(titleEl);
    
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'padding:4px 10px;border-radius:8px;border:none;background:#f3f4f6;color:#6b7280;font-size:18px;cursor:pointer;';
    closeBtn.addEventListener('click', closeTextViewer);
    header.appendChild(closeBtn);
    
    overlay.appendChild(header);
    
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'flex:1;padding:16px;overflow:auto;display:flex;align-items:center;justify-content:center;';
    
    var iframe = document.createElement('iframe');
    iframe.className = 'tv-frame';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;border-radius:8px;';
    iframe.src = url;
    wrapper.appendChild(iframe);
    
    overlay.appendChild(wrapper);
    
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
  }

  function closeTextViewer() {
    var overlay = document.getElementById('text-viewer-overlay');
    if (overlay) {
      document.body.removeChild(overlay);
    }
    document.body.style.overflow = '';
  }

  // ---------- 图片预览（带缓存） ----------
  function previewImage(item) {
    var title = item.FileName || '图片';
    var id = item.FileId || item.fileId;
    cacheGet(id, function (c) {
      if (c && c.kind === 'image' && c.data) { showImagePreview(c.data, title); return; }
      getFileLinkCached(item, function (link) {
        if (!link) { toast('获取图片链接失败'); return; }
        // 一次拉取：显示与落盘缓存复用同一份数据（首次预览省一半流量）
        fetchAsDataUrl(link, function (dataUrl) {
          if (dataUrl) {
            showImagePreview(dataUrl, title);
            cachePut(id, 'image', dataUrl, title);
          } else {
            // 拉取失败（如超大图）→ 代理直显，不缓存
            showImagePreview(link, title);
          }
        });
      }, '获取图片链接失败');
    });
  }

function showImagePreview(url, title) {
  url = previewSrc(url);
  var existing = document.getElementById('image-preview-overlay');
  if (existing) {
    document.body.removeChild(existing);
  }
  
  var overlay = document.createElement('div');
  overlay.id = 'image-preview-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.3);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:9999;display:flex;align-items:center;justify-content:center;touch-action:none;';
  
  var imgContainer = document.createElement('div');
  imgContainer.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;width:100%;height:100%;touch-action:none;padding:20px;';
  
  var img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;touch-action:none;user-select:none;-webkit-user-select:none;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.2);';
  img.alt = title || '图片';
  
  imgContainer.appendChild(img);
  overlay.appendChild(imgContainer);
  
  // ---- 手势：双指捉合缩放 / 单指拖动平移 / 双击放大·还原 ----
  var _sc = 1, _tx = 0, _ty = 0, _gesture = false;
  var _startDist = 0, _startScale = 1, _sx = 0, _sy = 0, _lx = 0, _ly = 0;
  function _applyTf() {
    img.style.transform = 'translate(' + _tx + 'px,' + _ty + 'px) scale(' + _sc + ')';
  }
  function _clampSc() {
    if (_sc < 1) { _sc = 1; _tx = 0; _ty = 0; }
    else if (_sc > 6) { _sc = 6; }
    // 平移边界：只能拖到图片边缘，不会“飞出去”
    try {
      var _r = imgContainer.getBoundingClientRect();
      var _iw = img.clientWidth * _sc;
      var _ih = img.clientHeight * _sc;
      var _mx = Math.max(0, (_iw - _r.width) / 2 + 20);
      var _my = Math.max(0, (_ih - _r.height) / 2 + 20);
      if (_tx > _mx) _tx = _mx;
      if (_tx < -_mx) _tx = -_mx;
      if (_ty > _my) _ty = _my;
      if (_ty < -_my) _ty = -_my;
    } catch (e) {}
  }
  function _dist2(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function _endGesture() {
    _startDist = 0;
    _clampSc(); _applyTf();
    setTimeout(function () { _gesture = false; }, 80);
  }
  overlay.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      _gesture = true;
      _startDist = _dist2(e.touches);
      _startScale = _sc;
    } else if (e.touches.length === 1 && _sc > 1) {
      _gesture = true;
      _lx = e.touches[0].clientX; _ly = e.touches[0].clientY;
      _sx = _tx; _sy = _ty;
    }
  }, { passive: true });
  overlay.addEventListener('touchmove', function (e) {
    if (e.touches.length === 2 && _startDist > 0) {
      _sc = _startScale * (_dist2(e.touches) / _startDist);
      _clampSc(); _applyTf();
      e.preventDefault();
    } else if (e.touches.length === 1 && _sc > 1) {
      _tx = _sx + (e.touches[0].clientX - _lx);
      _ty = _sy + (e.touches[0].clientY - _ly);
      _clampSc();          // 边拖边夹，跟手且不出界
      _applyTf();
      e.preventDefault();
    }
  }, { passive: false });
  overlay.addEventListener('touchend', _endGesture);
  overlay.addEventListener('touchcancel', _endGesture);
  // 注意：不给 img 挂常驻 transition！否则拖动会被动画拖住（不跟手）且松手后继续滑。
  // 只有双击切换时才临时加 0.18s 缓动，随后立刻移除。

  // 点击：双击缩放/还原；单击时若已放大先复位，否则才关闭
  var _lastTap = 0;
  overlay.addEventListener('click', function(e) {
    var now = Date.now();
    if (now - _lastTap < 320) {
      _lastTap = 0;
      img.style.transition = 'transform 0.18s ease-out';   // 双击才用缓动
      _sc = (_sc > 1.05) ? 1 : 2.5;
      _tx = 0; _ty = 0;
      _clampSc();
      _applyTf();
      setTimeout(function () { img.style.transition = ''; }, 220);
      _gesture = true; setTimeout(function () { _gesture = false; }, 80);
      return;
    }
    _lastTap = now;
    if (_gesture) return;                      // 手势刚结束，别误关
    if (_sc > 1.05) { _sc = 1; _tx = 0; _ty = 0; _applyTf(); return; }
    closeImagePreview();
  });
  
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
}
  function closeImagePreview() {
    var overlay = document.getElementById('image-preview-overlay');
    if (overlay) {
      document.body.removeChild(overlay);
    }
    document.body.style.overflow = '';
  }
function previewVideo(item) {
  getFileLinkCached(item, function (link) {
    if (!link) { toast('获取视频链接失败'); return; }
    showVideoPlayer(link, item.FileName || '视频', item);
  }, '获取视频链接失败');
}
function showVideoPlayer(url, title, item) {
  url = previewSrc(url);
  var existing = document.getElementById('video-player-overlay');
  if (existing) {
    document.body.removeChild(existing);
  }
  
  var overlay = document.createElement('div');
  overlay.id = 'video-player-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#000;z-index:9999;display:flex;flex-direction:column;touch-action:none;';
  
  var container = document.createElement('div');
  container.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;width:100%;height:100%;position:relative;';
  
  var video = document.createElement('video');
  video.id = 'video-player';
  video.style.cssText = 'max-width:100%;max-height:100%;background:#000;';
  video.controls = false;
  video.autoplay = true;
  video.preload = 'metadata';
  video.playsInline = true;
  video.webkitPlaysInline = true;
  
  var ext = url.split('.').pop().toLowerCase().split('?')[0];
  var mimeTypes = {
    'mp4': 'video/mp4',
    'm4v': 'video/mp4',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    '3gp': 'video/3gpp',
    'm3u8': 'application/vnd.apple.mpegurl'
  };
  
  var source = document.createElement('source');
  source.src = url;
  source.type = mimeTypes[ext] || 'video/mp4';
  video.appendChild(source);
  video.src = url;
  
  container.appendChild(video);
  overlay.appendChild(container);
  
  // 进度条（顶部）
  var progressBar = document.createElement('div');
  progressBar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.2);z-index:10;';
  
  var progressFill = document.createElement('div');
  progressFill.id = 'video-progress-fill';
  progressFill.style.cssText = 'height:100%;width:0%;background:#fff;transition:width 0.1s;';
  progressBar.appendChild(progressFill);
  
  var bufferFill = document.createElement('div');
  bufferFill.id = 'video-buffer-fill';
  bufferFill.style.cssText = 'height:100%;width:0%;background:rgba(255,255,255,0.15);position:absolute;top:0;left:0;pointer-events:none;';
  progressBar.appendChild(bufferFill);
  
  container.appendChild(progressBar);
  
  // 快进/快退提示
  var seekIndicator = document.createElement('div');
  seekIndicator.id = 'video-seek-indicator';
  seekIndicator.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:48px;font-weight:600;text-shadow:0 2px 30px rgba(0,0,0,0.9);z-index:20;opacity:0;transition:opacity 0.15s;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:2px;background:rgba(0,0,0,0.3);padding:16px 32px;border-radius:12px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);white-space:nowrap;';
  container.appendChild(seekIndicator);
  
  // 播放/暂停状态图标
  var playStateIcon = document.createElement('div');
  playStateIcon.id = 'video-play-state';
  playStateIcon.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,0.5);font-size:72px;z-index:15;opacity:0;transition:opacity 0.3s;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
  container.appendChild(playStateIcon);
  
  // 交互逻辑
  var touchStartX = 0;
  var touchStartY = 0;
  var touchCurrentX = 0;
  var isSeeking = false;
  var seekAccumulated = 0;
  var isDragging = false;
  var longPressTimer = null;
  var isLongPress = false;
  
  function showPlayStateIcon(playing) {
    playStateIcon.textContent = playing ? 'ᐅ' : '‖';
    playStateIcon.style.opacity = '0.6';
    clearTimeout(playStateIcon._hideTimer);
    playStateIcon._hideTimer = setTimeout(function() {
      playStateIcon.style.opacity = '0';
    }, 400);
  }
  
  video.addEventListener('click', function(e) {
    e.stopPropagation();
    if (isSeeking || isMouseSeeking) return;
    
    if (video.paused) {
      video.play().catch(function() {});
      showPlayStateIcon(true);
    } else {
      video.pause();
      showPlayStateIcon(false);
    }
  });
  
  video.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      var touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchCurrentX = touch.clientX;
      isSeeking = false;
      seekAccumulated = 0;
      isDragging = false;
      isLongPress = false;
      
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function() {
        isLongPress = true;
        if (bridge && bridge.vibrate) bridge.vibrate(30);
        if (item) {
          doDownload(item);
        }
      }, 800);
    }
  }, { passive: true });
  
  video.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1) {
      var touch = e.touches[0];
      var deltaX = touch.clientX - touchStartX;
      var deltaY = Math.abs(touch.clientY - touchStartY);
      
      if (deltaY > 30 && Math.abs(deltaX) < 20) {
        isDragging = true;
        return;
      }
      
      if (Math.abs(deltaX) > 15) {
        isSeeking = true;
        isDragging = true;
        clearTimeout(longPressTimer);
        
        var deltaSeek = Math.floor((touch.clientX - touchCurrentX) / 8);
        if (deltaSeek !== 0) {
          seekAccumulated += deltaSeek;
          if (seekAccumulated > 10) seekAccumulated = 10;
          if (seekAccumulated < -10) seekAccumulated = -10;
          
          var seekText = '';
          if (seekAccumulated > 0) {
            seekText = seekAccumulated + 's  ᐅ';
          } else if (seekAccumulated < 0) {
            seekText = 'ᐊ ' + Math.abs(seekAccumulated) + 's';
          }
          seekIndicator.textContent = seekText;
          seekIndicator.style.opacity = '1';
          
          touchCurrentX = touch.clientX;
        }
      }
    }
  }, { passive: true });
  
  video.addEventListener('touchend', function(e) {
    clearTimeout(longPressTimer);
    
    if (isLongPress) {
      isLongPress = false;
      return;
    }
    
    if (isSeeking && seekAccumulated !== 0) {
      var newTime = video.currentTime + seekAccumulated;
      if (newTime < 0) newTime = 0;
      if (newTime > video.duration) newTime = video.duration;
      video.currentTime = newTime;
      
      var seekText = '';
      if (seekAccumulated > 0) {
        seekText = seekAccumulated + 's  ᐅ';
      } else if (seekAccumulated < 0) {
        seekText = 'ᐊ ' + Math.abs(seekAccumulated) + 's';
      }
      seekIndicator.textContent = seekText;
      setTimeout(function() {
        seekIndicator.style.opacity = '0';
      }, 500);
    } else if (!isDragging && !isLongPress) {
      if (video.paused) {
        video.play().catch(function() {});
        showPlayStateIcon(true);
      } else {
        video.pause();
        showPlayStateIcon(false);
      }
    }
    
    isSeeking = false;
    isDragging = false;
    seekAccumulated = 0;
    
    setTimeout(function() {
      if (!isSeeking) {
        seekIndicator.style.opacity = '0';
      }
    }, 800);
  }, { passive: true });
  
  // 鼠标事件
  var mouseDownX = 0;
  var mouseDownY = 0;
  var isMouseSeeking = false;
  var mouseSeekAccumulated = 0;
  
  video.addEventListener('mousedown', function(e) {
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    isMouseSeeking = false;
    mouseSeekAccumulated = 0;
    isLongPress = false;
    
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function() {
      isLongPress = true;
      if (bridge && bridge.vibrate) bridge.vibrate(30);
      if (item) {
        doDownload(item);
      }
    }, 800);
  });
  
  video.addEventListener('mousemove', function(e) {
    if (e.buttons === 1) {
      var deltaX = e.clientX - mouseDownX;
      var deltaY = Math.abs(e.clientY - mouseDownY);
      
      if (deltaY > 30 && Math.abs(deltaX) < 20) {
        return;
      }
      
      if (Math.abs(deltaX) > 15) {
        isMouseSeeking = true;
        clearTimeout(longPressTimer);
        
        var deltaSeek = Math.floor((e.clientX - mouseDownX) / 8);
        if (deltaSeek !== 0) {
          mouseSeekAccumulated = deltaSeek;
          if (mouseSeekAccumulated > 10) mouseSeekAccumulated = 10;
          if (mouseSeekAccumulated < -10) mouseSeekAccumulated = -10;
          
          var seekText = '';
          if (mouseSeekAccumulated > 0) {
            seekText = mouseSeekAccumulated + 's  ᐅ';
          } else if (mouseSeekAccumulated < 0) {
            seekText = 'ᐊ ' + Math.abs(mouseSeekAccumulated) + 's';
          }
          seekIndicator.textContent = seekText;
          seekIndicator.style.opacity = '1';
        }
      }
    }
  });
  
  video.addEventListener('mouseup', function(e) {
    clearTimeout(longPressTimer);
    
    if (isLongPress) {
      isLongPress = false;
      return;
    }
    
    if (isMouseSeeking && mouseSeekAccumulated !== 0) {
      var newTime = video.currentTime + mouseSeekAccumulated;
      if (newTime < 0) newTime = 0;
      if (newTime > video.duration) newTime = video.duration;
      video.currentTime = newTime;
      
      var seekText = '';
      if (mouseSeekAccumulated > 0) {
        seekText = mouseSeekAccumulated + 's  ᐅ';
      } else if (mouseSeekAccumulated < 0) {
        seekText = 'ᐊ ' + Math.abs(mouseSeekAccumulated) + 's';
      }
      seekIndicator.textContent = seekText;
      setTimeout(function() {
        seekIndicator.style.opacity = '0';
      }, 500);
    } else if (!isMouseSeeking && !isLongPress) {
      if (video.paused) {
        video.play().catch(function() {});
        showPlayStateIcon(true);
      } else {
        video.pause();
        showPlayStateIcon(false);
      }
    }
    
    isMouseSeeking = false;
    mouseSeekAccumulated = 0;
    setTimeout(function() {
      if (!isMouseSeeking) {
        seekIndicator.style.opacity = '0';
      }
    }, 800);
  });
  
  video.addEventListener('mouseleave', function() {
    clearTimeout(longPressTimer);
    isMouseSeeking = false;
    mouseSeekAccumulated = 0;
    setTimeout(function() {
      seekIndicator.style.opacity = '0';
    }, 300);
  });
  
  video.addEventListener('loadedmetadata', function() {});
  
  video.addEventListener('timeupdate', function() {
    if (!video.duration) return;
    var percent = (video.currentTime / video.duration) * 100;
    progressFill.style.width = percent + '%';
  });
  
  video.addEventListener('progress', function() {
    if (!video.duration) return;
    var buffered = video.buffered;
    if (buffered.length > 0) {
      var bufferedEnd = buffered.end(buffered.length - 1);
      var percent = (bufferedEnd / video.duration) * 100;
      bufferFill.style.width = percent + '%';
    }
  });
  
  video.addEventListener('ended', function() {
    progressFill.style.width = '0%';
    video.currentTime = 0;
  });
  
  video.addEventListener('error', function() {});
  
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  
  video.volume = 0.8;
}

function closeVideoPlayer() {
  var overlay = document.getElementById('video-player-overlay');
  if (overlay) {
    var video = document.getElementById('video-player');
    if (video) {
      video.pause();
      video.src = '';
      video.load();
    }
    document.body.removeChild(overlay);
  }
  document.body.style.overflow = '';
}
  // ---------- 音频播放 ----------
  function previewAudio(item) {
    var title = item.FileName || '音频';
    getFileLinkCached(item, function (link) {
      if (!link) { toast('获取音频链接失败'); return; }
      showAudioPlayer(link, title);
    }, '获取音频链接失败');
  }


function showAudioPlayer(url, title) {
  url = previewSrc(url);
  var existing = document.getElementById('audio-player-overlay');
  if (existing) {
    document.body.removeChild(existing);
  }
  
  var overlay = document.createElement('div');
  overlay.id = 'audio-player-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:transparent;z-index:9999;display:flex;align-items:center;justify-content:center;';
  
  var dialog = document.createElement('div');
  dialog.style.cssText = 'background:rgba(255,255,255,0.25);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:22px;padding:32px 40px;min-width:200px;display:flex;flex-direction:column;align-items:center;gap:16px;box-shadow:0 8px 32px rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.2);';
  
  var nameEl = document.createElement('div');
  nameEl.textContent = title || '音频';
  nameEl.style.cssText = 'color:#000;font-size:16px;font-weight:500;text-align:center;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  dialog.appendChild(nameEl);
  
  var playBtn = document.createElement('button');
  playBtn.id = 'audio-dialog-play-btn';
  playBtn.style.cssText = 'width:64px;height:64px;border-radius:50%;border:none;background:rgba(0,0,0,0.08);color:#000;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;transition:background 0.2s;';
  
  var playIcon = document.createElement('img');
  playIcon.className = 'aud-ctl-ic';
  playIcon.alt = '';
  playIcon.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTYuOTUyNzcgMTguMTMxNkM2Ljk1Mjc3IDE5LjMyOTYgOC4wMDkwNSAxOS44OTQ5IDguMDA5MDUgMTkuODk0OUM5LjA2NTM0IDIwLjQ2MDIgMTAuMDYyMiAxOS43OTU3IDEwLjA2MjIgMTkuNzk1N0wxOS4yNTk0IDEzLjY2NDJDMjAuMTUgMTMuMDcwNSAyMC4xNSAxMi4wMDAxIDIwLjE1IDEyLjAwMDFDMjAuMTUgMTAuOTI5NyAxOS4yNTk0IDEwLjMzNiAxOS4yNTk0IDEwLjMzNkwxMC4wNjIyIDQuMjA0NTNDOS4wNjUzNCAzLjUzOTk3IDguMDA5MDUgNC4xMDUyOCA4LjAwOTA1IDQuMTA1MjhDNi45NTI3NyA0LjY3MDU4IDYuOTUyNzcgNS44Njg2MyA2Ljk1Mjc3IDUuODY4NjNWMTguMTMxNloiIGZpbGw9IiMxODFDMzIiLz4KPC9zdmc+Cg==';
  playBtn.appendChild(playIcon);
  
  playBtn.addEventListener('mouseenter', function() {
    this.style.background = 'rgba(0,0,0,0.15)';
  });
  playBtn.addEventListener('mouseleave', function() {
    this.style.background = 'rgba(0,0,0,0.08)';
  });
  
  playBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    toggleAudioDialogPlay();
  });
  dialog.appendChild(playBtn);
  
  var progressContainer = document.createElement('div');
  progressContainer.style.cssText = 'width:100%;display:flex;align-items:center;gap:10px;margin-top:4px;';
  
  var currentTimeEl = document.createElement('span');
  currentTimeEl.id = 'audio-dialog-current';
  currentTimeEl.textContent = '0:00';
  currentTimeEl.style.cssText = 'color:rgba(0,0,0,0.6);font-size:12px;min-width:32px;text-align:center;';
  progressContainer.appendChild(currentTimeEl);
  
  var progressBar = document.createElement('div');
  progressBar.style.cssText = 'flex:1;height:4px;background:rgba(0,0,0,0.15);border-radius:2px;cursor:pointer;position:relative;';
  
  var progressFill = document.createElement('div');
  progressFill.id = 'audio-dialog-progress';
  progressFill.style.cssText = 'height:100%;width:0%;background:#000;border-radius:2px;transition:width 0.1s;';
  progressBar.appendChild(progressFill);
  
  progressBar.addEventListener('click', function(e) {
    var rect = progressBar.getBoundingClientRect();
    var percent = (e.clientX - rect.left) / rect.width;
    var player = document.getElementById('audio-dialog-player');
    if (player && player.duration) {
      player.currentTime = percent * player.duration;
    }
  });
  
  progressContainer.appendChild(progressBar);
  
  var totalTimeEl = document.createElement('span');
  totalTimeEl.id = 'audio-dialog-total';
  totalTimeEl.textContent = '0:00';
  totalTimeEl.style.cssText = 'color:rgba(0,0,0,0.6);font-size:12px;min-width:32px;text-align:center;';
  progressContainer.appendChild(totalTimeEl);
  
  dialog.appendChild(progressContainer);
  
  overlay.appendChild(dialog);
  
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) {
      closeAudioDialog();
    }
  });
  
  document.body.appendChild(overlay);
  
  var audio = document.createElement('audio');
  audio.id = 'audio-dialog-player';
  audio.style.cssText = 'display:none;';
  audio.preload = 'metadata';
  audio.crossOrigin = 'anonymous';
  
  var ext = url.split('.').pop().toLowerCase().split('?')[0];
  var mimeTypes = {
    'mp3': 'audio/mpeg',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'ogg': 'audio/ogg',
    'oga': 'audio/ogg',
    'opus': 'audio/ogg',
    'wav': 'audio/wav',
    'wma': 'audio/x-ms-wma',
    'ape': 'audio/ape',
    'amr': 'audio/amr',
    'mid': 'audio/midi',
    'midi': 'audio/midi',
    'weba': 'audio/webm'
  };
  
  var source = document.createElement('source');
  source.src = url;
  source.type = mimeTypes[ext] || 'audio/mpeg';
  audio.appendChild(source);
  audio.src = url;
  
  audio.addEventListener('loadedmetadata', function() {
    totalTimeEl.textContent = formatTime(audio.duration);
  });
  
  audio.addEventListener('timeupdate', function() {
    if (!audio.duration) return;
    var percent = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = percent + '%';
    currentTimeEl.textContent = formatTime(audio.currentTime);
  });
  
  audio.addEventListener('play', function() {
    updateAudioDialogButton(true);
  });
  
  audio.addEventListener('pause', function() {
    updateAudioDialogButton(false);
  });
  
  audio.addEventListener('ended', function() {
    updateAudioDialogButton(false);
    progressFill.style.width = '0%';
    currentTimeEl.textContent = '0:00';
    audio.currentTime = 0;
  });
  
  audio.addEventListener('error', function(e) {
    console.log('音频加载失败，尝试备用格式');
    var fallbackTypes = [
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/wav',
      'audio/flac',
      'audio/aac'
    ];
    var currentType = source.type;
    var index = fallbackTypes.indexOf(currentType);
    if (index < fallbackTypes.length - 1) {
      source.type = fallbackTypes[index + 1];
      audio.load();
      audio.play().catch(function() {});
    }
  });
  
  overlay.appendChild(audio);
  
  audio.play().catch(function() {});
}

  function toggleAudioDialogPlay() {
    var audio = document.getElementById('audio-dialog-player');
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(function() {});
    } else {
      audio.pause();
    }
  }

  function updateAudioDialogButton(playing) {
    var btn = document.getElementById('audio-dialog-play-btn');
    if (!btn) return;
    var icon = btn.querySelector('img');
    if (!icon) return;
    icon.src = playing ? 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3QgeD0iNS41IiB5PSI0IiB3aWR0aD0iNCIgaGVpZ2h0PSIxNiIgcng9IjIiIGZpbGw9IiMxODFDMzIiLz4KPHJlY3QgeD0iMTQuNSIgeT0iNCIgd2lkdGg9IjQiIGhlaWdodD0iMTYiIHJ4PSIyIiBmaWxsPSIjMTgxQzMyIi8+Cjwvc3ZnPgo=' : 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTYuOTUyNzcgMTguMTMxNkM2Ljk1Mjc3IDE5LjMyOTYgOC4wMDkwNSAxOS44OTQ5IDguMDA5MDUgMTkuODk0OUM5LjA2NTM0IDIwLjQ2MDIgMTAuMDYyMiAxOS43OTU3IDEwLjA2MjIgMTkuNzk1N0wxOS4yNTk0IDEzLjY2NDJDMjAuMTUgMTMuMDcwNSAyMC4xNSAxMi4wMDAxIDIwLjE1IDEyLjAwMDFDMjAuMTUgMTAuOTI5NyAxOS4yNTk0IDEwLjMzNiAxOS4yNTk0IDEwLjMzNkwxMC4wNjIyIDQuMjA0NTNDOS4wNjUzNCAzLjUzOTk3IDguMDA5MDUgNC4xMDUyOCA4LjAwOTA1IDQuMTA1MjhDNi45NTI3NyA0LjY3MDU4IDYuOTUyNzcgNS44Njg2MyA2Ljk1Mjc3IDUuODY4NjNWMTguMTMxNloiIGZpbGw9IiMxODFDMzIiLz4KPC9zdmc+Cg==';
  }

  function closeAudioDialog() {
    var overlay = document.getElementById('audio-player-overlay');
    if (overlay) {
      var audio = document.getElementById('audio-dialog-player');
      if (audio) {
        audio.pause();
        audio.src = '';
        audio.load();
      }
      document.body.removeChild(overlay);
    }
  }

  function formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
    var min = Math.floor(seconds / 60);
    var sec = Math.floor(seconds % 60);
    return min + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // ---------- 分享 ----------
  function doShare(item) {
    if (!item || !item.FileId) { toast('无法分享该对象'); return; }
    state.shareItem = item;
    var expireRadios = document.getElementsByName('sc-expire');
    for (var e = 0; e < expireRadios.length; e++) expireRadios[e].checked = (expireRadios[e].value === '4');
    var pwdRadios = document.getElementsByName('sc-pwd');
    for (var p = 0; p < pwdRadios.length; p++) pwdRadios[p].checked = (pwdRadios[p].value === '1');
    var inp = $('sc-pwd-input'); if (inp) inp.value = '';
    hide($('sc-custom'));
    show($('share-config-modal'));
  }

  function shareExpiration(expireValue) {
    if (expireValue == null || Number(expireValue) === 4) return '2099-12-12T08:00:00+08:00';
    var hours = Number(expireValue) === 1 ? 24 : Number(expireValue) === 2 ? 168 : 720;
    var now = Date.now();
    var d = new Date(now + hours * 3600 * 1000);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '+08:00';
  }

  function doShareDirect(item) {
    if (!item || !item.FileId) { toast('无法分享该对象'); return; }
    if (item.Type === 1) { toast('文件夹暂不支持直连分享，请改用官方方式'); return; }
    toast('正在获取直连链接...');
    api('POST', API.download, JSON.stringify(buildDownloadBody(item)), true, function (d) {
      if (!d || !d.data) {
        var msg = (d && (d.message || d.error)) || '获取直链失败';
        if (/size/i.test(msg)) msg = '获取直链失败：文件缺少大小信息，请刷新列表后重试';
        toast(msg);
        return;
      }
      var link = pickDownloadUrl(d);
      if (!link) { toast('暂无法获取直链，请刷新后重试'); return; }
      showShareModal(item.FileName || '直链', link, '');
    });
  }

  function doCreateShare() {
    var item = state.shareItem;
    if (!item) { hide($('share-config-modal')); return; }
    
    var expireVal = '4';
    var expireRadios = document.getElementsByName('sc-expire');
    for (var e = 0; e < expireRadios.length; e++) {
      if (expireRadios[e].checked) { expireVal = expireRadios[e].value; break; }
    }
    
    var pwdType = '1';
    var pwdRadios = document.getElementsByName('sc-pwd');
    for (var p = 0; p < pwdRadios.length; p++) {
      if (pwdRadios[p].checked) { pwdType = pwdRadios[p].value; break; }
    }
    
    if (pwdType === '4') {
      hide($('share-config-modal'));
      doShareDirect(item);
      return;
    }
    
    var sharePwd = '';
    if (pwdType === '3') {
      sharePwd = ($('sc-pwd-input') && $('sc-pwd-input').value || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(sharePwd)) {
        toast('请输入4位提取码（字母/数字）');
        return;
      }
    }
    
    hide($('share-config-modal'));
    
    var shareBody = {
      driveId: 0,
      expiration: shareExpiration(expireVal),
      fileIdList: String(item.FileId),
      shareName: item.FileName || item.fileName || '分享',
      sharePwd: sharePwd,
      event: 'shareCreate',
      fileNum: 1,
      renameVisible: false,
      shareTypeValue: Number(pwdType),
      shareModality: Number(expireVal),
      operatePlace: 1,
      trafficSwitch: true
    };
    
    toast('正在创建分享...');
    
    api('POST', API.shareCreate, JSON.stringify(shareBody), true, function (d) {
      if (!d || d.code !== 0 || !d.data) {
        toast((d && (d.message || d.error)) || '创建分享失败');
        return;
      }
      
      var dt = d.data;
      var shareKey = dt.ShareKey || '';
      var key = shareKey, pwd = '';
      var dash = shareKey.indexOf('-');
      if (dash >= 0) {
        key = shareKey.slice(0, dash);
        pwd = shareKey.slice(dash + 1);
      }
      
      var link = '';
      var userId = dt.UserId || dt.userId || '';
      
      if (!/^\d+$/.test(String(userId))) {
        var accounts = loadAccounts();
        for (var i = 0; i < accounts.length; i++) {
          if (accounts[i].user === state.user && /^\d+$/.test(String(accounts[i].userId || ''))) {
            userId = accounts[i].userId;
            break;
          }
        }
      }
      
      var sl = dt.shareLinkList;
      if (sl && sl.list && sl.list.length) {
        link = sl.list[0];
      } else if (sl && sl.standBy) {
        link = sl.standBy;
      }
      
      if (link) {
        link = link.replace(/share\.canary\.123pan\.cn/g, 'share.123pan.cn');
      } else if (/^\d+$/.test(String(userId))) {
        link = 'https://' + userId + '.share.123pan.cn/123pan/' + shareKey;
      } else {
        link = 'https://www.123pan.com/s/' + key;
      }
      
      var finalPwd = '';
      if (pwdType === '1') {
        finalPwd = pwd;
      } else if (pwdType === '3') {
        finalPwd = sharePwd;
      }
      
      if (finalPwd) {
        if (link.indexOf('?') > -1) {
          link = link + '&pwd=' + finalPwd;
        } else {
          link = link + '?pwd=' + finalPwd;
        }
      }
      
      showShareModal(item.FileName || '分享', link, finalPwd);
    });
  }

  function showShareModal(title, link, pwd) {
    $('share-title').textContent = '分享 · ' + title;
    $('share-link').textContent = link;
    $('share-link').value = link;
    var pwdEl = $('share-pwd');
    var row = $('share-pwd-row');
    if (pwd) {
      pwdEl.textContent = pwd;
      if (row) row.style.display = '';
    } else {
      pwdEl.textContent = '';
      if (row) row.style.display = 'none';
    }
    show($('share-modal'));
  }

  function doCopyLink() {
    var link = $('share-link') && $('share-link').value;
    if (!link) { toast('无可复制链接'); return; }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = link; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('链接已复制'); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () { toast('链接已复制'); },
        function () { fallback(); });
    } else { fallback(); }
  }

  function doCopy(item) { doShare(item); }
  function doInfo(item) {
    var msg = (item.FileName || '') + '\n大小：' + fmtSize(item.Size) + '\n修改时间：' + (item.ModifyTime || '-');
    toast(msg);
  }

  // ---------- 新建文件夹 ----------
  function doNewFolder() {
    var name = $('newfolder-input').value.trim();
    if (!name) { toast('请输入文件夹名称'); return; }
    
    api('POST', API.mkdir,
      JSON.stringify({
        driveId: 0,
        etag: '',
        fileName: name,
        parentFileId: state.currentDir,
        size: 0,
        type: 1,
        duplicate: 1,
        NotReuse: true,
        event: 'newCreateFolder',
        operateType: '2'
      }),
      true,
      function (d) {
        if (d && d.code === 0) {
          hide($('newfolder-modal'));
          $('newfolder-input').value = '';
          toast('文件夹已创建');
          loadList();
          hideToolbar();
        } else {
          toast((d && d.message) || '创建失败 (code: ' + (d && d.code) + ')');
        }
      });
  }

  // ---------- 上传 ----------
  // 点「上传」→ 先弹方式选择：上传到当前文件夹 / 选择文件 / 选择文件夹（保留目录结构）/ 取消
  function doUpload() {
    openUploadSheet();
  }
  function openUploadSheet() {
    closeAllOverlays();
    var t = $('upload-sheet-title');
    if (t) {
      var where = (state.breadcrumb && state.breadcrumb.length)
        ? state.breadcrumb[state.breadcrumb.length - 1].name : '全部文件';
      t.textContent = '上传到 ' + where;
    }
    show($('upload-sheet'));
  }
  function pickUploadFiles() {
    hide($('upload-sheet'));
    var inp = $('upload-input');
    if (!inp) { toast('当前版本不支持选择文件'); return; }
    inp.value = '';
    inp.click();
  }
  // 选择文件夹：原生目录选择器（ACTION_OPEN_DOCUMENT_TREE），递归读完后建目录再传文件
  var folderUploadState = null;
  function pickUploadFolder() {
    hide($('upload-sheet'));
    if (!(bridge && (bridge.pickUploadFolder || bridge.pickFolder))) {
      toast('当前版本不支持文件夹上传');
      return;
    }
    folderUploadState = { parentId: Number(state.currentDir || 0), nodes: [], idMap: {} };
    try {
      if (bridge.pickFolder) bridge.pickFolder();   // 1.7.3 通道（原生遍历+拷贝后回调 __onFolderPicked）
      else bridge.pickUploadFolder(String(state.currentDir || 0), '_cb_folder_' + Date.now());
    }
    catch (e) { toast('打开目录选择器失败'); }
  }
  // 原生回调：treeUri, parentId, cb
  window.__onFolderPicked = function (a, b, c) {
    // ---- 1.7.3 原生通道：参数为数组（或 JSON 字符串）[{rel,name,path,size}]（原生已完成遍历+拷贝）----
    var _arrArg = null;
    if (Array.isArray(a)) {
      _arrArg = a;
    } else if (typeof a === 'string' && a.length > 0 && a.charAt(0) === '[') {
      try { _arrArg = JSON.parse(a) || []; } catch (e) { _arrArg = []; }
    }
    if (_arrArg) {
      var arr = _arrArg;
      var pid = folderUploadState ? (Number(folderUploadState.parentId) || 0) : (Number(state.currentDir) || 0);
      if (!(bridge && (bridge.uploadFileTask || bridge.uploadFiles))) {
        toast('当前版本不支持文件夹上传');
        folderUploadState = null;
        return;
      }
      var nodes = [];
      for (var i = 0; i < arr.length; i++) {
        var n = arr[i] || {};
        var rel = String(n.rel || n.name || '');
        if (!rel) continue;
        // 保留完整 rel（含所选根目录名）：所选文件夹 + 内部子目录结构都会在云端重建（与原生 rel 设计一致）
        nodes.push({ uri: n.path || n.filePath || '', rel: rel, name: String(n.name || ''), size: Number(n.size) || 0 });
      }
      folderUploadState = { treeUri: '', parentId: pid, nodes: nodes, idMap: {} };
      if (nodes.length) toast('正在读取文件夹（共 ' + nodes.length + ' 个文件）...');
      startFolderUpload();
      return;
    }
    // ---- 旧原生通道：treeUri, parentId, cb（JS 侧自行递归遍历）----
    var treeUri = a;
    if (!treeUri) { toast('未选择文件夹'); return; }
    if (!(bridge && bridge.listTreeChildren && bridge.stageUri)) {
      toast('当前版本不支持文件夹上传');
      return;
    }
    folderUploadState = { treeUri: treeUri, parentId: Number(b) || 0, nodes: [], idMap: {} };
    toast('正在读取文件夹...');
    collectTree(treeUri, '', '', function () { startFolderUpload(); });
  };
  // 逐层枚举（每层一次原生调用，避免在原生里写递归）
  function collectTree(treeUri, docId, prefix, done) {
    if (!folderUploadState) return;
    var arr = [];
    try { arr = JSON.parse(bridge.listTreeChildren(treeUri, docId || '') || '[]'); } catch (e) { arr = []; }
    var dirs = [];
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i] || {};
      var rel = prefix ? (prefix + '/' + (n.name || '')) : (n.name || '');
      if (!rel) continue;
      if (n.dir) dirs.push({ docId: n.id, rel: rel });
      else folderUploadState.nodes.push({ uri: n.uri, rel: rel, name: n.name, size: n.size || 0 });
    }
    var idx = 0;
    (function next() {
      if (idx >= dirs.length) { done(); return; }
      var d = dirs[idx++];
      setTimeout(function () { collectTree(treeUri, d.docId, d.rel, next); }, 0);
    })();
  }
  function startFolderUpload() {
    var st = folderUploadState;
    if (!st) return;
    var files = st.nodes || [];
    if (!files.length) { toast('该文件夹里没有文件'); folderUploadState = null; return; }
    // 需要创建的目录（按层级从浅到深）
    var need = {};
    files.forEach(function (f) {
      var parts = f.rel.split('/');
      parts.pop();
      var acc = '';
      parts.forEach(function (p) { acc = acc ? (acc + '/' + p) : p; need[acc] = 1; });
    });
    var dirs = Object.keys(need).sort(function (a, b) {
      return a.split('/').length - b.split('/').length;
    });
    var di = 0;
    (function mkNext() {
      if (!folderUploadState) return;
      if (di >= dirs.length) { uploadFolderFiles(); return; }
      var rel = dirs[di++];
      var parts = rel.split('/');
      var name = parts.pop();
      var parentRel = parts.join('/');
      var pid = parentRel ? (folderUploadState.idMap[parentRel] || folderUploadState.parentId) : folderUploadState.parentId;
      mkdirCloud(name, pid, function (newId) {
        if (newId) folderUploadState.idMap[rel] = newId;
        else { folderUploadState.mkdirFail = (folderUploadState.mkdirFail || 0) + 1; }
        mkNext();
      });
    })();
  }
  // 在云端建目录并返回新目录 fileId；创建失败（如同名已存在）则列父目录找同名文件夹复用
  function mkdirCloud(name, parentId, cb) {
    api('POST', API.mkdir, JSON.stringify({
      driveId: 0, etag: '', fileName: name, parentFileId: parentId,
      size: 0, type: 1, duplicate: 1, NotReuse: false,
      event: 'newCreateFolder', operateType: '2'
    }), true, function (d) {
      var data = (d && (d.data || d.Data)) || {};
      var nid = Number(data.fileId || data.FileId || 0);
      if (nid > 0) { cb(nid); return; }
      // 兜底：同名文件夹可能已存在 → 查询父目录列表复用（避免结构丢失/落平级）
      api('GET', API.list + '?driveId=0&limit=200&next=0&orderBy=file_name'
        + '&orderDirection=asc&parentFileId=' + parentId
        + '&trashed=false&Page=1&OnlyLookAbnormalFile=0', '', true, function (r) {
        try {
          var arr = (r && r.data && r.data.InfoList) || [];
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i] || {};
            var nm = it.FileName || it.fileName || '';
            var ty = Number(it.Type != null ? it.Type : it.type);
            if (nm === name && ty === 1) {
              cb(Number(it.FileId || it.fileId) || 0);
              return;
            }
          }
        } catch (e) {}
        cb(0);
      });
    });
  }
  function uploadFolderFiles() {
    var st = folderUploadState;
    if (!st) return;
    var files = st.nodes || [];
    var idMap = st.idMap || {};
    var ok = 0, skip = 0;
    var _gid = 'uf_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    var _gname = '';
    try {
      _gname = (st.nodes && st.nodes[0] && String(st.nodes[0].rel || '').split('/')[0]) || '文件夹';
    } catch (e) { _gname = '文件夹'; }
    var _gTotal = 0;
    for (var _gI = 0; _gI < files.length; _gI++) _gTotal += Number(files[_gI].size) || 0;
    files.forEach(function (f, i) {
      var parts = f.rel.split('/');
      parts.pop();
      var parentRel = parts.join('/');
      var dirId = parentRel ? (idMap[parentRel] || st.parentId) : st.parentId;
      var localPath = '';
      var u = String(f.uri || '');
      if (u.charAt(0) === '/') { localPath = u; }   // 1.7.3 原生已拷贝为本地文件
      else { try { localPath = (bridge && bridge.stageUri) ? (bridge.stageUri(u) || '') : ''; } catch (e) { localPath = ''; } }
      if (!localPath) { skip++; return; }
      var taskId = 'upload_' + Date.now() + '_' + i;
      addUploadTask({ id: taskId, name: f.name, size: f.size, status: 'uploading', done: 0, total: f.size,
        groupId: _gid, groupName: _gname, groupTotal: _gTotal });
      try { uploadEnqueue(taskId, localPath, dirId); ok++; } catch (e) { skip++; }
    });
    toast('已加入 ' + ok + ' 个上传任务（保留目录结构）' + (skip ? ('，跳过 ' + skip) : '')
      + (st.mkdirFail ? ('，' + st.mkdirFail + ' 个目录创建失败已放至上层') : ''));
    folderUploadState = null;
    setTimeout(function () { hideToolbar(); }, 500);
  }

  // ===== 上传并发队列：同时最多 2 个，其余排队 =====
  var UPLOAD_MAX_CONCURRENT = 2;
  var _upQ = [], _upActive = 0, _upOwned = {};
  function uploadEnqueue(taskId, localPath, dirId) {
    _upQ.push({ id: taskId, path: localPath, dir: dirId });
    uploadPump();
  }
  function uploadPump() {
    while (_upActive < UPLOAD_MAX_CONCURRENT && _upQ.length) {
      var it = _upQ.shift();
      var started = false;
      try { started = nativeUploadStart(it.id, it.path, it.dir); } catch (e) { started = false; }
      if (started) { _upActive++; _upOwned[it.id] = true; }
      else { uploadMarkFailed(it.id, '上传通道未就绪'); }
    }
  }
  function uploadMarkFailed(taskId, msg) {
    try {
      var list = loadUploadTransfers();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === taskId) { list[i].status = 'failed'; list[i].error = msg || '上传失败'; break; }
      }
      markUploadRowDirty(taskId);
      saveUploadTransfers(list);
      renderTransfersThrottled();
    } catch (e) {}
  }
  function uploadQueueDone(localTaskId) {
    if (!_upOwned[localTaskId]) return;      // 非队列发起的任务（单文件直传）不占用并发位
    delete _upOwned[localTaskId];
    _upActive = Math.max(0, _upActive - 1);
    uploadPump();
  }
  function hasUploadTask(name) {
    var list = loadUploadTransfers();
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name && (list[i].status === 'uploading' || list[i].status === 'waiting')) {
        return true;
      }
    }
    return false;
  }

  function doUploadOne(path) {
    if (!path) return;
    var fname = '';
    var fsize = 0;
    
    if (typeof path === 'object') {
      fname = path.name || path.fileName || String(path.path || '').split('/').pop() || ('file_' + Date.now());
      fsize = path.size || path.fileSize || path.length || 0;
    } else {
      fname = String(path).split('/').pop() || ('file_' + Date.now());
    }
    
    if (hasUploadTask(fname)) {
      console.log('跳过重复上传任务:', fname);
      return;
    }
    
    var taskId = 'upload_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    
    addUploadTask({
      id: taskId,
      name: fname,
      size: fsize,
      status: 'uploading',
      done: 0,
      total: fsize
    });
    
    var pathStr = typeof path === 'object' ? (path.path || path.filePath || fname) : String(path);
    if (nativeUploadStart(taskId, pathStr, state.currentDir)) return;
    toast('上传通道未就绪：' + fname);
  }

  window.__onFilesPicked = function (paths) {
    if (!paths || !paths.length) return;
    var list = (typeof paths === 'string') ? JSON.parse(paths) : paths;
    var _fdir = state.forceUploadDir; state.forceUploadDir = null;
    var addedCount = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var fname = '';
      var fsize = 0;
      
      if (typeof p === 'object') {
        fname = p.name || p.fileName || String(p.path || p).split('/').pop() || ('file_' + Date.now());
        fsize = p.size || p.fileSize || p.length || 0;
      } else {
        fname = String(p).split('/').pop() || ('file_' + Date.now());
      }
      
      if (hasUploadTask(fname)) {
        console.log('跳过重复上传任务:', fname);
        continue;
      }
      
      var taskId = 'upload_' + Date.now() + '_' + i;
      addUploadTask({
        id: taskId,
        name: fname,
        size: fsize,
        status: 'uploading',
        done: 0,
        total: fsize
      });
      
      var pathStr = typeof p === 'object' ? (p.path || p.filePath || fname) : String(p);
      uploadEnqueue(taskId, pathStr, (_fdir != null ? _fdir : state.currentDir));
      addedCount++;
    }
    if (addedCount > 0) {
      toast('已添加 ' + addedCount + ' 个上传任务');
    } else {
      toast('文件已在上传队列中');
    }
    setTimeout(function() { hideToolbar(); }, 500);
  };

  // 上传方式选择：弹窗提供「选择文件 / 选择文件夹」，均走原生 SAF 选择器
  var _upChoiceBound = false;
  function resetUploadChoice() {
    try {
      var cf = $('cf-title'); if (cf) cf.textContent = '提示';
      var okBtn = $('cf-ok');
      if (okBtn) { okBtn.textContent = '确定'; okBtn.classList.add('danger'); }
    } catch (e) {}
  }
  function showUploadChoice(dir) {
    try {
      // 记住本次上传的目标目录：全部完成后只刷新这个目录（其它目录不动）
      try { state.uploadTargetDir = Number(dir) || 0; } catch (e) {}
      var okBtn = $('cf-ok');
      // 挂「选择文件夹」入口（只挂一次）
      var btns = okBtn && okBtn.parentNode;
      if (btns && !btns.querySelector('[data-up-tree]')) {
        var b2 = document.createElement('button');
        b2.className = 'btn-plain';
        b2.setAttribute('data-up-tree', '1');
        b2.textContent = '选择文件夹';
        b2.addEventListener('click', function (e) {
          e.stopPropagation();
          hide($('confirm-modal'));
          state.confirmOk = null;
          resetUploadChoice();
          try { bridge.pickFolderForUpload(dir); } catch (er) {}
        });
        btns.insertBefore(b2, okBtn);
      }
      showConfirm('上传到「' + getCurrentPath() + '」\n\n选择上传内容：', function () {
        resetUploadChoice();
        try { bridge.pickFilesForUpload(dir); } catch (e) {}
      });
      var cf = $('cf-title'); if (cf) cf.textContent = '上传';
      if (okBtn) { okBtn.textContent = '选择文件'; okBtn.classList.remove('danger'); }
      if (!_upChoiceBound) {
        _upChoiceBound = true;
        var ok0 = $('cf-ok');
        if (ok0) ok0.addEventListener('click', function () { resetUploadChoice(); });
      }
    } catch (e) {
      try { bridge.pickFilesForUpload(dir); } catch (e2) {}
    }
  }

  // 传输列表渲染节流（大量上传任务时，避免每秒/每次回调整表重绘导致卡死）
  var _trRenderAt = 0;
  var _trPerfLast = 0;
  function renderTransfersThrottled() {
    try {
      if (state.view !== 'transfers') return;
      var now = Date.now();
      if (now - _trRenderAt < 300) return;
      _trRenderAt = now;
      var _p0 = Date.now();
      var _dn = 0;
      try { var _uc = $('upload-list'); if (_uc && _uc._dirty) { for (var _dk in _uc._dirty) _dn++; } } catch (e2) {}
      renderTransfers();
      var _cost = Date.now() - _p0;
      window.__trPerfTick = _cost;
      // 慢帧或每 5s 心跳记一条，便于实测对比（pan_dl.log 里 grep TRF）
      if (_cost >= 25 || (now - _trPerfLast) >= 5000) {
        _trPerfLast = now;
        try {
          if (bridge && bridge.trPerf) bridge.trPerf(_cost, (loadUploadTransfers() || []).length, _dn);
        } catch (e3) {}
      }
    } catch (e) {}
  }

  // 原生上传：一批任务入队 → 一次建多行 + 只重绘一次
  window.__onUploadQueuedBatch = function (jsonText) {
    try {
      var arr = JSON.parse(jsonText || '[]');
      if (!arr.length) return;
      var list = loadUploadTransfers();
      var have = {};
      for (var i = 0; i < list.length; i++) have[list[i].id] = 1;
      var added = 0;
      for (var j = 0; j < arr.length; j++) {
        var it = arr[j] || {};
        var lid = 'up' + Number(it.id);
        var _uo = findUploadOwnerById(lid);
        if (_uo && _uo.user !== state.user) continue;
        if (have[lid]) continue;
        have[lid] = 1;
        list.unshift({
          id: lid, name: it.name || ('上传 ' + it.id), size: Number(it.size) || 0,
          status: 'waiting', done: 0, total: Number(it.size) || 0,
          acct: acctKeySuffix(),
          groupId: it.groupId || '', groupName: it.groupName || ''
        });
        added++;
      }
      if (!added) return;
      saveUploadTransfers(list);
      _trRenderAt = 0;                 // 强制刷新一次
      renderTransfersThrottled();
    } catch (e) {}
  };

  // 原生上传：任务入队 → 列表立刻显示「排队中」
  // 原生上传：已在暂停点停下
  window.__onUploadPaused = function (nativeId) {
    try {
      var lid = _uploadNativeMap[Number(nativeId)];
      if (!lid) return;
      var list = loadUploadTransfers();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === lid) { list[i].status = 'paused'; list[i].speed = 0; break; }
      }
      markUploadRowDirty(lid);
      saveUploadTransfers(list);
      renderTransfersThrottled();
    } catch (e) {}
  };

  window.__onUploadQueued = function (localId, name, size) {
    try {
      var lid = 'up' + Number(localId);
      var list = loadUploadTransfers();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === lid) { renderTransfersThrottled(); return; }
      }
      list.unshift({
        id: lid, name: name || ('上传 ' + localId), size: Number(size) || 0,
        status: 'waiting', done: 0, total: Number(size) || 0,
        acct: acctKeySuffix()
      });
      saveUploadTransfers(list);
      renderTransfersThrottled();
    } catch (e) {}
  };

  // 原生上传：任务开始 → 绑定原生任务 id（进度/结果靠它映射）
  window.__onUploadStarted = function (nativeId, localId, name, size, groupId, groupName) {
    try {
      var nid = Number(nativeId), lid = 'up' + Number(localId);
      if (!nid) return;
      var _gidS = groupId || '', _gnmS = groupName || '';
      var _uoS = findUploadOwnerById(lid);
      if (_uoS && _uoS.user !== state.user) {
        _uploadNativeMap[nid] = lid;
        _uploadNativeRev[lid] = nid;
        return;
      }
      _uploadNativeMap[nid] = lid;
      _uploadNativeRev[lid] = nid;
      var list = loadUploadTransfers();
      var hit = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === lid) {
          list[i].status = 'uploading';
          // 分组信息以原生为准补全（否则会从文件夹卡里“跑出来”成散卡）
          if (_gidS) { list[i].groupId = _gidS; list[i].groupName = _gnmS || list[i].groupName || ''; }
          hit = true;
          break;
        }
      }
      if (!hit) {
        // 兜底新建：必须带上分组信息，否则会变成独立散卡
        list.unshift({
          id: lid, name: name || ('上传 ' + localId), size: Number(size) || 0,
          status: 'uploading', done: 0, total: Number(size) || 0,
          acct: acctKeySuffix(),
          groupId: _gidS, groupName: _gnmS
        });
      }
      markUploadRowDirty(lid);
      saveUploadTransfers(list);
      renderTransfersThrottled();
    } catch (e) {}
  };

  window.__onUploadProgress = function (nativeId, done, total) {
    var lid = _uploadNativeMap[Number(nativeId)];
    if (lid) updateUploadProgress(lid, done, total, 'uploading');
  };

  window.__onUploadResume = function (nativeId, done, total) {
    var lid = _uploadNativeMap[Number(nativeId)];
    if (lid) updateUploadProgress(lid, done, total, 'uploading');
  };

  window.__onUploadResult = function (nativeId, ok, msg) {
    var key = Number(nativeId);
    var lid = _uploadNativeMap[key];
    if (!lid) {
      // 无映射（页面刷新 / 早前任务）：退回通用处理
      try { if (typeof window.__onUploadDone === 'function') window.__onUploadDone(!!ok, msg || '', null); } catch (e) {}
      return;
    }
    delete _uploadNativeMap[key];
    delete _uploadNativeRev[lid];
    try { uploadQueueDone(lid); } catch (e) {}
    var list = loadUploadTransfers();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === lid) {
        if (ok) {
          list[i].status = 'completed';
          list[i].done = list[i].total || list[i].size || list[i].done || 0;
          list[i].speed = 0;
        } else {
          var em = String(msg || '上传失败');
          if (em.indexOf('session_expired') !== -1) em = '上传失败非法请求';
          list[i].status = 'failed';
          list[i].speed = 0;
          list[i].error = em;
        }
        break;
      }
    }
    markUploadRowDirty(lid);
    saveUploadTransfers(list);
    if (ok) {
      toast(msg || '上传成功');
      setTimeout(function () {
        scheduleFileListRefresh();
        renderTransfersThrottled();
      }, 600);
    } else {
      toast('上传失败：' + String(msg || ''));
      renderTransfersThrottled();
    }
  };

  window.__onUploadDone = function (ok, msg, fileInfo) {
    console.log('上传回调:', { ok, msg, fileInfo });
    
    var isDuplicate = false;
    if (msg) {
      var msgLower = String(msg).toLowerCase();
      if (msgLower.indexOf('已存在') !== -1 || 
          msgLower.indexOf('同名') !== -1 ||
          msgLower.indexOf('duplicate') !== -1 ||
          msgLower.indexOf('重复') !== -1 ||
          msgLower.indexOf('skip') !== -1 ||
          msgLower.indexOf('already exists') !== -1) {
        isDuplicate = true;
      }
    }
    
    if (isDuplicate) {
      console.log('文件已存在，已跳过:', msg);
      var uploads = loadUploadTransfers();
      for (var i = 0; i < uploads.length; i++) {
        if (uploads[i].status === 'uploading' || uploads[i].status === 'waiting') {
          uploads[i].status = 'skipped';
          uploads[i].speed = 0;
          uploads[i].error = '文件已存在，已跳过';
          markUploadRowDirty(uploads[i].id);
          break;
        }
      }
      saveUploadTransfers(uploads);
      renderTransfersThrottled();
      return;
    }
    
    if (ok) {
      toast(msg || '上传成功');
      
      var uploads = loadUploadTransfers();
      for (var i = 0; i < uploads.length; i++) {
        if (uploads[i].status === 'uploading') {
          uploads[i].status = 'completed';
          uploads[i].done = uploads[i].total || uploads[i].size;
          uploads[i].speed = 0;
          markUploadRowDirty(uploads[i].id);
          break;
        }
      }
      saveUploadTransfers(uploads);
      
      setTimeout(function() {
        scheduleFileListRefresh();
        renderTransfersThrottled();
      }, 800);
      
    } else {
      var errorMsg = msg || '上传失败';
      
      if (errorMsg.indexOf('session_expired') !== -1) {
        errorMsg = '上传失败非法请求';
      } else if (errorMsg.indexOf('分片') !== -1 && errorMsg.indexOf('预签名') !== -1) {
        errorMsg = '上传失败';
      }
      
      toast('上传失败：' + errorMsg);
      
      var uploads = loadUploadTransfers();
      for (var j = 0; j < uploads.length; j++) {
        if (uploads[j].status === 'uploading') {
          uploads[j].status = 'failed';
          uploads[j].speed = 0;
          uploads[j].error = errorMsg;
          markUploadRowDirty(uploads[j].id);
          break;
        }
      }
      saveUploadTransfers(uploads);
      renderTransfersThrottled();
    }
    
    setTimeout(function() { hideToolbar(); }, 300);
  };

  // ---------- 多选（整理）模式 ----------
  function selectedItemsArr() {
    var a = [];
    for (var k in state.selectedMap) a.push(state.selectedMap[k]);
    return a;
  }
  // 多选栏「删除」
  function doDeleteSelected() {
    var items = selectedItemsArr();
    if (!items.length) { toast('请先选择要删除的文件'); return; }
    showConfirm('确认删除选中的 ' + items.length + ' 项？（移入回收站）', function () {
      var ids = items.map(function (x) { return Number(x.FileId || x.fileId) || 0; });
      toast('正在删除 ' + ids.length + ' 项...');
      api('POST', API.trash, JSON.stringify({
        RequestSource: null, driveId: 0, event: 'intoRecycle',
        fileTrashInfoList: ids.map(function (fid) { return { FileId: fid }; }),
        operatePlace: 1, operation: true
      }), true, function (d) {
        if (d && d.code === 0) {
          state.keepScroll = true;
          exitSelectMode();
          toast('已删除 ' + ids.length + ' 项（可在回收站还原）');
          loadList();
        } else { toast((d && d.message) || '删除失败'); }
      });
    });
  }
  // ---------- 多选（整理）模式 ----------
  function enterSelectMode(seedItem) {
    state.selectMode = true;
    state.selectedMap = {};
    if (seedItem) state.selectedMap[seedItem.FileId] = seedItem;   // 长按进来的那一项自动选中
    var toolbar = $('select-toolbar');
    if (toolbar) {
      toolbar.style.display = 'flex';
      requestAnimationFrame(function() {
        toolbar.classList.add('visible');
      });
    }
    hide($('file-toolbar'));
    renderList(state.lastList || []);   // 用已有数据重绘（带勾选框），不重新请求
  }

  function exitSelectMode() {
    state.selectMode = false;
    state.selectedMap = {};
    var toolbar = $('select-toolbar');
    if (toolbar) {
      toolbar.classList.remove('visible');
      setTimeout(function() {
        if (!state.selectMode) {
          toolbar.style.display = 'none';
        }
      }, 300);
    }
    var ft = $('file-toolbar');
    if (ft) {
      ft.classList.remove('toolbar-hidden');
      show(ft);
    }
    renderList(state.lastList || []);
  }

  // 多选后下载：文件夹跳过，文件逐个加入下载任务
  function doDownloadSelectedFiles() {
    if (!state.selectMode) return;
    var keys = Object.keys(state.selectedMap);
    if (!keys.length) { toast('请先选择要下载的文件'); return; }
    if (!bridge || !bridge.downloadStream) { toast('当前版本不支持直接下载'); return; }
    var all = keys.map(function (k) { return state.selectedMap[k]; });
    var files = all.filter(function (it) { return Number(it.Type) !== 1; });
    var skipped = all.length - files.length;
    if (!files.length) { toast('所选都是文件夹，请先转存后再下载'); return; }
    toast('已加入下载任务 ' + files.length + ' 项' + (skipped ? '（跳过 ' + skipped + ' 个文件夹）' : ''));
    files.forEach(function (it) { doDownload(it); });
    exitSelectMode();
  }

  function toggleSelect(item) {
    var id = item.FileId;
    if (state.selectedMap[id]) {
      delete state.selectedMap[id];
    } else {
      state.selectedMap[id] = item;
    }
    // 取消选中到 0 个 → 退出多选状态（6 个按钮的弹窗一起收起）
    if (Object.keys(state.selectedMap).length === 0) {
      exitSelectMode();
      renderList(state.lastList || []);
      return;
    }
    refreshSelectBar();
    
    var box = $('file-list');
    var cards = box.querySelectorAll('.file-card');
    for (var i = 0; i < cards.length; i++) {
      if (Number(cards[i].getAttribute('data-fid')) !== Number(id)) continue;
      var sel = !!state.selectedMap[id];
      cards[i].classList.toggle('selected', sel);
      var ck = cards[i].querySelector('.file-check');
      if (ck) {
        ck.classList.toggle('checked', sel);
        ck.innerHTML = sel ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
      }
    }
  }

  function refreshSelectBar() {
    var n = Object.keys(state.selectedMap).length;
    ['select-move', 'select-download', 'select-copy', 'select-delete'].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle('disabled', n === 0);
    });
    
    var toolbar = $('select-toolbar');
    if (toolbar && state.selectMode) {
      toolbar.style.display = 'flex';
      toolbar.classList.add('visible');
    }
  }

  // ---------- 文件夹选择器（移动目标） ----------
  function openMovePicker() {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    if (Object.keys(state.selectedMap).length === 0) {
      toast('请先选择要移动的文件');
      return;
    }
    state.pickerMode = 'move';
    state.pickerItems = null;   // 多选流程：清掉单条模式残留
    hideSelectBarForPicker();
    var t = $('picker-title'); if (t) t.textContent = '移动文件';
    var tip = $('picker-tip');
    if (tip) tip.textContent = '选择要把文件移动到的文件夹（点击「确定移动」移入当前目录）';
    var c = $('picker-confirm'); if (c) c.textContent = '确定移动';
    state.pickerState = { dir: 0, path: [] };
    show($('move-picker'));
    loadPickerDir(0, []);
  }

  function closeMovePicker() {
    hide($('move-picker'));
    state.pickerState = null;
    state.pickerMode = 'move';
    state.pickerItems = null;
    // 从多选栏进来的：回到列表后把多选栏重新显示出来
    if (state.selectMode) refreshSelectBar();
  }
  // 打开目录选择器前，先把多选栏收起来（两弹窗不重叠）
  function hideSelectBarForPicker() {
    var stb = $('select-toolbar');
    if (stb) { stb.classList.remove('visible'); stb.style.display = 'none'; }
  }

  // ---- 复制实现：临时分享 + 转存 ----
  function doCopyViaShare(targetId, items, ids) {
    function failCopy(msg) {
      var mt = $('cf-title'); if (mt) mt.textContent = '复制失败';
      showConfirm(msg, null);
    }
    var first = items[0] || {};
    var shareBody = {
      driveId: 0,
      expiration: shareExpiration(1),
      fileIdList: ids.join(','),         // 该接口要的是逗号拼接的 fileId 字符串
      shareName: (first.FileName || first.fileName || '复制') + (items.length > 1 ? (' 等' + items.length + '项') : ''),
      sharePwd: '',
      event: 'shareCreate',
      fileNum: items.length,
      renameVisible: false,
      shareTypeValue: 1,                  // 1 = 随机提取码（这样 ShareKey 才会是「码-提取码」整串）
      shareModality: 1,                   // 1 = 1 天（临时分享）
      operatePlace: 1,
      trafficSwitch: true
    };
    api('POST', API.shareCreate, JSON.stringify(shareBody), true, function (d) {
      if (!d || d.code !== 0 || !d.data) {
        failCopy('创建临时分享失败：' + ((d && (d.message || d.error)) || ('code=' + (d && d.code))));
        return;
      }
      var dt = d.data || {};
      var shareKey = dt.ShareKey || dt.shareKey || '';
      var shareId = dt.ShareId || dt.shareId || dt.ShareID || dt.shareID || dt.Id || dt.id || 0;
      if (!shareKey) { failCopy('临时分享未返回 ShareKey'); return; }
      // 123pan：「整串（含 -）」才是 ShareKey（和接收分享/转存的约定一致），短横线后是提取码
      var dash = shareKey.indexOf('-');
      var pwd = dash >= 0 ? shareKey.slice(dash + 1) : '';
      var shortKey = dash >= 0 ? shareKey.slice(0, dash) : shareKey;

      var fileList = items.map(function (x) {
        return {
          file_id: Number(x.FileId || x.fileId) || 0,
          file_name: x.FileName || x.fileName || '',
          etag: x.Etag || x.etag || '',
          size: Number(x.Size || x.size || 0),
          parent_file_id: Number(targetId) || 0,
          drive_id: 0,
          type: Number(x.Type || 0)
        };
      });
      function deleteShareById(sid) {
        if (!sid) return false;
        try {
          // 与「取消分享」同一套请求体
          shareApi('POST', '/b/api/share/delete', JSON.stringify({
            driveId: 0,
            shareInfoList: [{ shareId: Number(sid) || 0 }],
            isPayShare: 0,
            event: 'shareCancel',
            operatePlace: 2
          }), false, function () {});
          return true;
        } catch (e) { return false; }
      }
      // 复制完自动移除临时分享（拿到 shareId 就直接删；没拿到就去分享列表里按 ShareKey 找到再删）
      function dropTempShare() {
        if (deleteShareById(shareId)) { shareId = 0; return; }
        if (!shareKey) return;
        shareApi('GET', '/b/api/share/list?driveId=0&limit=500&next=0&orderBy=fileId&orderDirection=desc&event=shareListFile&operateType=1', '', false, function (d) {
          var list = (d && d.data && d.data.InfoList) || [];
          for (var i = 0; i < list.length; i++) {
            var sk = list[i].ShareKey || list[i].shareKey || '';
            if (sk === shareKey) { deleteShareById(list[i].shareId || list[i].ShareId); break; }
          }
        });
      }
      function transferWith(k, p, onFail) {
        var tb = JSON.stringify({
          share_key: k,
          share_pwd: p,
          current_level: 1,
          event: 'transfer',
          file_list: fileList
        });
        shareApi('POST', '/b/api/file/copy/async', tb, true, function (d2) {
          if (d2 && d2.code === 0) {
            dropTempShare();
            closeMovePicker();
            exitSelectMode();
            state.keepScroll = true;      // 复制后保持当前滚动位置，不回到顶部
            toast('已复制 ' + ids.length + ' 项到目标目录');
            if (state.searching) {
              // 搜索中复制：不跳进目录，重置搜索框并原地刷新搜索结果
              var _kw = state.searchKeyword;
              resetSearchBox();
              doSearch(_kw);
            } else {
              loadList();
            }
          } else {
            onFail((d2 && (d2.message || d2.error)) || ('code=' + (d2 && d2.code)));
          }
        });
      }
      // 关键：ShareKey 整串里已经内嵌了提取码，这时**不能再单独传 SharePwd**
      // （服务端按 4 位校验 SharePwd，而随机提取码是 5 位 → 报「SharePwd最大为4位」）
      transferWith(shareKey, '', function (err1) {
        // 兜底 1：整串 + 分开传提取码
        transferWith(shareKey, pwd, function (err2) {
          // 兜底 2：短码 + 不传提取码
          transferWith(shortKey, '', function (err3) {
            dropTempShare();
            failCopy('复制失败：' + err1 + ' / ' + err2 + ' / ' + err3);
          });
        });
      });
    });
  }

  // 单条/多条通用：打开「移动 / 复制」目标选择器
  function openPickerFor(kind, items) {
    closeAllOverlays();
    hideSelectBarForPicker();
    items = items || [];
    if (!items.length) { toast(kind === 'copy' ? '请先选择要复制的文件' : '请先选择要移动的文件'); return; }
    var isCopy = (kind === 'copy');
    state.pickerItems = items;
    state.pickerMode = isCopy ? 'copy' : 'move';
    state.pickerState = { dir: 0, path: [] };
    var t = $('picker-title'); if (t) t.textContent = (isCopy ? '复制' : '移动') + (items.length > 1 ? ('（' + items.length + ' 项）') : '');
    var tip = $('picker-tip');
    if (tip) tip.textContent = isCopy
      ? '选择要复制到的文件夹（点「确定复制」复制到当前目录）'
      : '选择要移动到的文件夹（点「确定移动」移入当前目录）';
    var c = $('picker-confirm'); if (c) c.textContent = isCopy ? '确定复制' : '确定移动';
    show($('move-picker'));
    loadPickerDir(0, []);
  }

  function loadPickerDir(pid, path) {
    state.pickerState = state.pickerState || { dir: 0, path: [] };
    state.pickerState.dir = pid;
    state.pickerState.path = path || [];
    
    var bc = $('picker-crumb');
    bc.innerHTML = '';
    var root = document.createElement('span');
    root.className = 'pcrumb' + (pid === 0 ? ' active' : '');
    root.textContent = '全部文件';
    root.addEventListener('click', function () {
      if (state.pickerState.dir !== 0) loadPickerDir(0, []);
    });
    bc.appendChild(root);
    (path || []).forEach(function (c, i) {
      var sep = document.createElement('span');
      sep.className = 'psep';
      sep.textContent = '›';
      var cr = document.createElement('span');
      cr.className = 'pcrumb' + (i === path.length - 1 ? ' active' : '');
      cr.textContent = c.name;
      cr.addEventListener('click', function () {
        if (i < (path || []).length - 1) loadPickerDir(c.id, (path || []).slice(0, i + 1));
      });
      bc.appendChild(sep);
      bc.appendChild(cr);
    });
    
    var listEl = $('picker-list');
    listEl.innerHTML = '<div class="loading-dot">加载中...</div>';
    
    var params = 'driveId=0&limit=200&next=0&orderBy=file_id&orderDirection=desc'
      + '&parentFileId=' + pid + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      var list = (d && d.data && d.data.InfoList) ? d.data.InfoList : [];
      var dirs = list.filter(function (x) { return x.Type === 1; });
      listEl.innerHTML = '';
      if (!dirs.length) {
        listEl.innerHTML = '<div class="p-empty">此目录下没有可选择的子文件夹</div>';
        return;
      }
      dirs.forEach(function (dir) {
        var row = document.createElement('div');
        row.className = 'pdir-row';
        var ic = document.createElement('div');
        ic.className = 'pdir-icon';
        ic.appendChild(makeIcon('foler', ''));
        row.appendChild(ic);
        var nm = document.createElement('div');
        nm.className = 'pdir-name';
        nm.textContent = dir.FileName || '未命名';
        row.appendChild(nm);
        var badge = document.createElement('div');
        badge.className = 'pdir-badge';
        badge.textContent = '进入';
        row.appendChild(badge);
        row.addEventListener('click', function () {
          loadPickerDir(dir.FileId, (state.pickerState.path || []).concat([{ id: pid, name: dir.FileName }]));
        });
        listEl.appendChild(row);
      });
    });
  }

  function confirmMove() {
    var p = state.pickerState;
    if (!p) return;
    var targetId = Number(p.dir) || 0;
    if (state.pickerMode === 'transfer') { doTransferTo(targetId); return; }
    if (state.pickerMode === 'dedupe-move') { dedupeMove(targetId); return; }
    if (state.pickerMode === 'unzip') { archUncompressTo(targetId); return; }
    
    // 操作对象：单条模式的 pickerItems，否则当前多选
    var items = state.pickerItems && state.pickerItems.length
      ? state.pickerItems
      : (function () { var a = []; for (var k in state.selectedMap) a.push(state.selectedMap[k]); return a; })();
    if (!items.length) { toast('请先选择要操作的文件'); return; }
    var paths = p.path || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var itIsDir = (it.Type === 1 || it.Type === '1');
      var itId = Number(it.FileId || it.fileId);
      if (itIsDir && itId === targetId) {
        toast('不能移动到自身所在文件夹');
        return;
      }
      var inSel = paths.some(function (c) { return Number(c.id) === itId; });
      if (itIsDir && inSel) {
        toast('不能移动到所选文件夹的子目录');
        return;
      }
    }

    var isCopy = (state.pickerMode === 'copy');
    var ids = items.map(function (x) { return Number(x.FileId || x.fileId) || 0; });

    if (!isCopy) {
      api('POST', API.move, JSON.stringify({
        parentFileId: targetId,
        fileIdList: ids.map(function (fid) { return { FileId: fid }; })
      }), true, function (d) {
        if (d && d.code === 0) {
          closeMovePicker();
          exitSelectMode();
          state.keepScroll = true;
          toast('已移动 ' + ids.length + ' 项');
          loadList();
        } else {
          var mt = $('cf-title'); if (mt) mt.textContent = '移动失败';
          showConfirm((d && (d.message || d.error)) || ('移动失败 code=' + (d && d.code)), null);
        }
      });
      return;
    }

    // 复制：123pan 没有「盘内直接复制」接口（/b/api/file/copy/async 是「转存」路由，必须带 share_key）。
    // 做法：先给选中项建一个临时分享（1 天、无提取码）→ 用转存接口复制到目标目录 → 删掉临时分享。
    // （参考 123.apk：其「复制」就是走分享体系，而不是盘内拷贝）
    doCopyViaShare(targetId, items, ids);
  }

  // ---------- 我的页 ----------
  function loadMine() {
    renderAccountList();
    updateCacheSize();
    renderDownloadDir();
    var vEl = $('mine-version');
    if (vEl) vEl.textContent = bridge && bridge.getVersion ? bridge.getVersion() : '1.6.0';

    api('GET', API.userInfo, '', true, function (d) {
      var quotaEl = $('mine-quota-val');
      if (!quotaEl) return;

      if (d && (d.data || d.Data)) {
        var u = d.data || d.Data;
        if (u.user && typeof u.user === 'object') u = u.user;

        // 账号名兜底：老数据里没有当前账号时，用接口返回的账号名补齐账号列表
        var _name = u.passport || u.Passport || u.mail || u.Mail || u.nickname || u.Nickname || '';
        // 真实头像 / 昵称：缓存到 state.profile，账号列表用它渲染头像
        var _nick = u.nickname || u.Nickname || u.nickName || '';
        var _head = u.headImage || u.headImg || u.HeadImage || u.avatar || '';
        // 会员 / 普通用户标识（账号行那个小图标）也在这里更新
        var _vip = profileVipInfo(u);
        if (_nick || _head || _vip.known) {
          var _prev = state.profile || {};
          state.profile = {
            nickname: String(_nick || _prev.nickname || ''),
            headImage: String(_head || _prev.headImage || ''),
            isVip: _vip.isVip,
            vipKind: _vip.isVip ? (/svip|超级|年费/i.test(String(_vip.name || '')) ? 'svip' : 'vip') : ''
          };
          state.profileAt = Date.now();
          renderAccountList();
        }
        if (!currentAccountUser() && state.user) {
          var _have = false;
          try {
            var _accts = loadAccounts();
            for (var _j = 0; _j < _accts.length; _j++) {
              if (_accts[_j].user === state.user) { _have = true; break; }
            }
          } catch (e) {}
          if (!_have) addAccount(state.user, state.token, '');
          else setCurrentAccountUser(state.user);
          try { renderAccountList(); } catch (e) {}
        }

        var used = numOf(u, 'SpaceUsed', 'UsedSize', 'usedSize', 'space_used', 'used', 'usedSize');
        var permanent = numOf(u, 'SpacePermanent', 'TotalSize', 'totalSize', 'space_total', 'total', 'capacity');
        var temp = numOf(u, 'SpaceTemp', 'freeSize', 'FreeSize', 'space_temp', 'free');

        var total = (permanent > 0 || temp > 0) ? (permanent + temp) : 0;
        if (!(total > 0)) total = used + (temp > 0 ? temp : 0);

        if (total > 0) {
          var usedV = used > 0 ? used : Math.max(0, total - temp);
          quotaEl.textContent = '已用' + fmtSize(usedV) + '/共' + fmtSize(total);
        } else {
          var altUsed = Number(u.usedSize || u.used || 0);
          var altTotal = Number(u.totalSize || u.capacity || u.spaceSize || 0);
          if (altTotal > 0) {
            quotaEl.textContent = '已用' + fmtSize(altUsed) + '/共' + fmtSize(altTotal);
          } else if (altUsed > 0) {
            quotaEl.textContent = '已用' + fmtSize(altUsed);
          } else {
            quotaEl.textContent = '容量获取失败';
          }
        }
      } else {
        quotaEl.textContent = '容量获取失败';
      }
    });
    hideToolbar();
  }

  // =========================================================================
  // 移植自 123.apk：分享管理（我的分享 / 接收分享 / 转存）
  // =========================================================================
  // 分享接口域候选：优先项目主域，异常时自动切换官方域
  var SHARE_DOMAINS = ['https://api.123pan.cn', 'https://yun.123pan.com'];
  var shareState = null; // 接收分享浏览状态 {key,pwd,level,parentId,stack,list,sel}

  // ---- crc32 + 签名（123 web 端接口签名：参数名=timeSign，值=timestamp-random-dataSign）----
  var _crcTable = (function () {
    var t = [], n, c, k;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) { c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1); }
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32Str(str) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < str.length; i++) {
      c = ((c >>> 8) ^ _crcTable[(c ^ str.charCodeAt(i)) & 0xFF]) >>> 0;
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function signPath(path) {
    var table = 'adefghlmyijnopkqrstubcvwsz';
    var random = String(Math.round(1e7 * Math.random()));
    var nowMs = Date.now();
    var timestamp = String(Math.floor(nowMs / 1000));
    var cst = new Date(nowMs + 8 * 3600 * 1000);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var nowStr = '' + cst.getUTCFullYear() + p2(cst.getUTCMonth() + 1) + p2(cst.getUTCDate())
      + p2(cst.getUTCHours()) + p2(cst.getUTCMinutes());
    var mapped = '';
    for (var i = 0; i < nowStr.length; i++) { mapped += table.charAt(nowStr.charCodeAt(i) - 48); }
    var timeSign = String(crc32Str(mapped));
    var data = [timestamp, random, path, 'web', '3', timeSign].join('|');
    var dataSign = String(crc32Str(data));
    return { k: timeSign, v: [timestamp, random, dataSign].join('-') };
  }
  function withSign(pathWithQuery) {
    var idx = pathWithQuery.indexOf('?');
    var path = idx >= 0 ? pathWithQuery.slice(0, idx) : pathWithQuery;
    var s = signPath(path);
    return pathWithQuery + (idx >= 0 ? '&' : '?') + s.k + '=' + s.v;
  }
  // 多域名容错请求：拿到含 code 字段的 JSON 即视为到达服务端；否则尝试下一个域名
  function shareApi(method, path, body, needSign, cb) {
    var i = 0;
    function attempt() {
      if (i >= SHARE_DOMAINS.length) { cb({ code: -1, message: '网络请求失败，请检查网络后重试' }); return; }
      var base = SHARE_DOMAINS[i++];
      var p = needSign ? withSign(path) : path;
      api(method, base + p, body || '', true, function (d) {
        if (d && typeof d.code !== 'undefined') { cb(d); } else { attempt(); }
      });
    }
    attempt();
  }
  // 通用复制文本（含旧内核兜底）
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg || '已复制'); } catch (e) { toast('复制失败，请手动复制'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || '已复制'); }, function () { fallback(); });
    } else { fallback(); }
  }

  // ---- 我的分享 ----
  function openMyShares() {
    closeAllOverlays();   // 进二级页前先关掉所有弹窗，避免重叠
    var box = $('shares-list');
    if (box) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    show($('page-shares'));
    shareApi('GET', '/b/api/share/list?driveId=0&limit=500&next=0&orderBy=fileId&orderDirection=desc&event=shareListFile&operateType=1', '', false, function (d) {
      if (d && d.code === 0 && d.data) {
        renderSharesList(d.data.InfoList || []);
      } else {
        if (box) box.innerHTML = '<div class="p-empty">加载失败：' + esc((d && d.message) || '未知错误') + '</div>';
      }
    });
  }
  function renderSharesList(list) {
    var box = $('shares-list');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="p-empty">暂无分享记录</div>'; return; }
    var html = '';
    list.forEach(function (it, i) {
      var name = it.shareName || it.ShareName || '未命名分享';
      var exp = it.expiration || it.Expiration || '';
      var status = (it.shareStatus === undefined || it.shareStatus === 0 || it.shareStatus === '0') ? '' : '已失效';
      var sub = (exp ? ('有效期至 ' + exp) : '永久有效') + (status ? (' · ' + status) : '');
      html += '<div class="share-item">'
        + '<div class="share-item-info">'
        + '<div class="share-item-name">' + esc(name) + '</div>'
        + '<div class="share-item-sub">' + esc(sub) + '</div>'
        + '</div>'
        + '<div class="share-item-btns">'
        + '<button class="mini-btn" data-act="copy" data-i="' + i + '">复制链接</button>'
        + '<button class="mini-btn danger" data-act="cancel" data-i="' + i + '">取消分享</button>'
        + '</div>'
        + '</div>';
    });
    box.innerHTML = html;
    box.onclick = function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t) return;
      var i = Number(t.getAttribute('data-i'));
      var it = list[i]; if (!it) return;
      var act = t.getAttribute('data-act');
      if (act === 'copy') {
        var url = it.shareUrl || it.ShareUrl || '';
        var key = it.shareKey || it.ShareKey || '';
        var pwd = it.sharePwd || it.SharePwd || '';
        if (!url && key) {
          var dash = key.indexOf('-');
          var k = dash >= 0 ? key.slice(0, dash) : key;
          if (!pwd && dash >= 0) pwd = key.slice(dash + 1);
          url = 'https://www.123pan.com/s/' + k;
        }
        if (pwd) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'pwd=' + pwd;
        if (!url) { toast('该分享无可用链接'); return; }
        copyText(url, '分享链接已复制');
      } else if (act === 'cancel') {
        doCancelShare(it);
      }
    };
  }
  function doCancelShare(it) {
    var name = it.shareName || it.ShareName || '该分享';
    showConfirm('确认取消分享「' + name + '」？取消后链接将立即失效。', function () {
      var sid = it.shareId || it.ShareId;
      var body = JSON.stringify({
        driveId: 0,
        shareInfoList: [{ shareId: sid }],
        isPayShare: 0,
        event: 'shareCancel',
        operatePlace: 2
      });
      shareApi('POST', '/b/api/share/delete', body, false, function (d) {
        if (d && d.code === 0) {
          toast('已取消分享');
          openMyShares();
        } else {
          toast('取消失败：' + ((d && d.message) || '未知错误'));
        }
      });
    });
  }

  // ---- 接收分享 ----
  // 解析分享链接/分享码，支持多种格式：
  //   1) https://1816139528.share.123pan.cn/123pan/diJ5Vv-SJKWH   （新版分享域名 + /123pan/）
  //   2) https://www.123pan.com/s/diJ5Vv-SJKWH                    （旧版 /s/）
  //   3) https://www.123pan.cn/s/diJ5Vv-SJKWH                     （.cn 域名）
  //   4) diJ5Vv-SJKWH / diJ5Vv                                    （纯分享码）
  //   5) 任意带 ?pwd=xxxx / 提取码：xxxx 的文本
  // 注意：123云盘的分享码「整串（含 -）」才是 ShareKey，不做横杠拆分（与百度网盘不同）。
  function parseShareKey(input) {
    input = String(input || '').trim();
    if (!input) return null;
    var key = '', pwd = '', m;

    m = input.match(/[?&#](?:pwd|Pwd|p|password)=([A-Za-z0-9]{1,16})/);
    if (m) pwd = m[1];
    if (!pwd) {
      m = input.match(/(?:提取码|密码|提取密码)\s*[:：]?\s*([A-Za-z0-9]{1,16})/);
      if (m) pwd = m[1];
    }

    var pathMatch = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
    if (pathMatch) {
      var noQuery = input.split('#')[0].split('?')[0];
      var urlEnd = noQuery.search(/[\s\u4e00-\u9fa5]/);
      var urlOnly = urlEnd >= 0 ? noQuery.slice(0, urlEnd) : noQuery;
      var pathPart = urlOnly.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
      var segs = pathPart.split('/').filter(function (s) { return s.length > 0; });
      for (var i = segs.length - 1; i >= 0; i--) {
        var seg = String(segs[i]).replace(/\.(html?|htm|php|aspx?|jsp)$/i, '');
        var head = seg.match(/^[A-Za-z0-9_-]+/);
        if (!head) continue;
        seg = head[0].replace(/[-_]+$/, '');
        if (/^(s|123pan|share|pan|file|f)$/i.test(seg)) continue;
        if (/^[A-Za-z0-9_-]{4,64}$/.test(seg)) { key = seg; break; }
      }
    } else {
      m = input.match(/([A-Za-z0-9]{4,64}-[A-Za-z0-9]{1,32})/);
      if (m) { key = m[1]; }
      else {
        m = input.match(/([A-Za-z0-9]{4,64})/);
        if (m) { key = m[1]; }
      }
    }

    if (!key) return null;
    key = key.replace(/^[-_\s]+|[-_\s]+$/g, '');
    if (!key) return null;
    // 关键：123云盘的 ShareKey 是「码-提取码」整串，不是单独一段。
    //   /s/UzfMvd?pwd=jSAuh   → ShareKey = UzfMvd-jSAuh
    //   /123pan/diJ5Vv-SJKWH  → ShareKey = diJ5Vv-SJKWH（已含横杠，不动）
    // 之前直接拿路径段当 ShareKey，服务端会报「格式异常」。
    if (pwd && key.indexOf('-') < 0) key = key + '-' + pwd;
    return { key: key, pwd: pwd };
  }
  function ensureShareState() {
    if (!shareState) shareState = { key: '', pwd: '', level: 1, parentId: '0', stack: [], list: [], sel: {} };
    return shareState;
  }
  function openReceiveShare() {
    closeAllOverlays();   // 进二级页前先关掉所有弹窗，避免重叠
    ensureShareState();
    shareState.key = ''; shareState.stack = []; shareState.list = []; shareState.sel = {};
    var box = $('receive-list');
    if (box) box.innerHTML = '<div class="p-empty">输入分享链接并打开后，可浏览与转存</div>';
    var crumbs = $('receive-crumbs');
    if (crumbs) { crumbs.classList.add('hidden'); crumbs.innerHTML = ''; }
    var tip = $('receive-tip');
    if (tip) {
      tip.textContent = '转存目标：' + (state.breadcrumb && state.breadcrumb.length ? state.breadcrumb[state.breadcrumb.length - 1].name : '我的网盘根目录')
        + '（如需更换目标目录，请先在文件页进入对应文件夹）';
    }
    updateReceiveBar();
    show($('page-receive'));
  }
  function doOpenReceiveShare() {
    var parsed = parseDeepLink($('receive-link') ? $('receive-link').value : '');
    if (!parsed || !parsed.key) { toast('请输入有效的分享链接或分享码'); return; }
    ensureShareState();
    shareState.key = parsed.key;
    var manualPwd = $('receive-pwd') ? String($('receive-pwd').value || '').trim() : '';
    shareState.pwd = manualPwd || parsed.pwd || '';
    shareState.stack = [];
    shareState.sel = {};
    loadShareDir('0', 1);
  }
  function loadShareDir(parentId, level) {
    var box = $('receive-list');
    if (box) box.innerHTML = '<div class="loading-dot">加载中...</div>';
    // 提取码已内嵌在 ShareKey（形如 UzfMvd-Xknuh）时不要再单独传 SharePwd：
    // 服务端会按 4 位校验 SharePwd，5 位提取码会被拒（报“sharepwd 最大为4位”）。
    function attempt(withPwd) {
      var q = '/b/api/share/get?ShareKey=' + encodeURIComponent(shareState.key)
        + '&parentFileId=' + encodeURIComponent(parentId)
        + '&Page=1&limit=200&next=0&orderBy=file_name&orderDirection=asc&event=homeListFile';
      if (withPwd && shareState.pwd) q += '&SharePwd=' + encodeURIComponent(shareState.pwd);
      shareApi('GET', q, '', true, function (d) {
        if (d && d.code === 0 && d.data) {
          shareState.parentId = parentId;
          shareState.level = level;
          shareState.list = d.data.InfoList || [];
          renderReceiveList();
        } else if (!withPwd && shareState.pwd) {
          attempt(true);   // 提取码没内嵌在 ShareKey 里 → 补一次带 SharePwd
        } else {
          if (box) box.innerHTML = '<div class="p-empty">打开失败：' + esc((d && d.message) || '分享不存在、已失效或提取码错误') + '</div>';
        }
      });
    }
    attempt(shareState.key.indexOf('-') < 0 && !!shareState.pwd);
  }
  function enterShareDir(it) {
    var fid = it.FileId || it.fileId;
    shareState.stack.push({ id: fid, name: it.FileName || '' });
    loadShareDir(fid, shareState.level + 1);
  }
  function backShareDir() {
    if (!shareState || !shareState.stack.length) return;
    shareState.stack.pop();
    var parent = shareState.stack.length ? shareState.stack[shareState.stack.length - 1].id : '0';
    loadShareDir(parent, shareState.stack.length + 1);
  }
  function toggleShareSel(it) {
    if (!shareState) return;
    if (!shareState.sel) shareState.sel = {};
    var fid = it.FileId || it.fileId;
    if (fid == null) return;
    if (shareState.sel[fid]) { delete shareState.sel[fid]; }
    else { shareState.sel[fid] = it; }
    renderReceiveList();
  }
  function updateReceiveBar() {
    var bar = $('receive-bar');
    if (!bar) return;
    // 只要有已打开的分享就显示底部栏（子目录同样可以下载/转存）
    if (!shareState || !shareState.key) { hide(bar); return; }
    var cnt = shareState.sel ? Object.keys(shareState.sel).length : 0;
    var info = $('receive-selinfo');
    if (info) info.textContent = '已选 ' + cnt + ' 项';
    var btn = $('receive-save');
    if (btn) btn.classList.toggle('disabled', cnt === 0);
    var dlBtn = $('receive-download');
    if (dlBtn) dlBtn.classList.toggle('disabled', cnt === 0);
    show(bar);
  }
  function renderReceiveList() {
    if (!shareState) return;
    var box = $('receive-list');
    if (!box) return;
    var list = shareState.list || [];
    var isRoot = shareState.stack.length === 0;
    var crumbs = $('receive-crumbs');
    if (crumbs) {
      if (!isRoot) {
        var parentName = shareState.stack.length > 1 ? shareState.stack[shareState.stack.length - 2].name : '分享根目录';
        crumbs.innerHTML = '<span class="rc-back" id="rc-up">‹ 返回 ' + esc(parentName) + '</span>';
        crumbs.classList.remove('hidden');
        var up = $('rc-up');
        if (up) up.addEventListener('click', backShareDir);
      } else {
        crumbs.classList.add('hidden');
        crumbs.innerHTML = '';
      }
    }
    if (!list.length) {
      box.innerHTML = '<div class="p-empty">此目录为空</div>';
      updateReceiveBar();
      return;
    }
    var html = '';
    list.forEach(function (it, i) {
      var isFolder = Number(it.Type) === 1;
      var fid = it.FileId || it.fileId;
      // 所有层级都可勾选（之前只在根目录渲染复选框，导致进文件夹后无法选择）
      var sel = shareState.sel && shareState.sel[fid];
      html += '<div class="rc-row" data-i="' + i + '">'
        + '<span class="rc-ck' + (sel ? ' checked' : '') + '"></span>'
        + '<span class="rc-ic" data-icon="' + (isFolder ? 'foler' : iconForName(it.FileName)) + '"></span>'
        + '<div class="rc-info"><div class="rc-name">' + esc(it.FileName || '') + '</div>'
        + '<div class="rc-meta">' + (isFolder ? '文件夹' : fmtSize(it.Size)) + '</div></div>'
        + (isFolder ? '<span class="rc-enter" data-enter="1">›</span>' : '')
        + '</div>';
    });
    box.innerHTML = html;
    injectIcons(box);
    box.querySelectorAll('.rc-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var i = Number(row.getAttribute('data-i'));
        var it = list[i]; if (!it) return;
        var isFolder = Number(it.Type) === 1;
        // 点右侧箭头 → 进入文件夹；点其它位置 → 勾选/取消（文件夹也能被选中）
        var onEnter = e.target && e.target.getAttribute && e.target.getAttribute('data-enter');
        if (onEnter) { enterShareDir(it); return; }
        toggleShareSel(it);
      });
    });
    updateReceiveBar();
  }
  // ---------- 关闭接收分享页：清空已填充内容，下次进来是全新状态 ----------
  function resetReceiveState() {
    shareState = null;
    var l = $('receive-link'); if (l) l.value = '';
    var p = $('receive-pwd'); if (p) p.value = '';
    var box = $('receive-list'); if (box) box.innerHTML = '';
    var crumbs = $('receive-crumbs');
    if (crumbs) { crumbs.classList.add('hidden'); crumbs.innerHTML = ''; }
    var tip = $('receive-tip'); if (tip) tip.textContent = '';
    var bar = $('receive-bar'); if (bar) hide(bar);
  }
  function closeReceivePage() {
    hide($('page-receive'));
    clearCoverInputs('page-receive');
    resetReceiveState();
  }

  // ---------- 分享文件直链：优先用列表自带直链，其次调分享下载接口 ----------
  function fetchShareDownloadUrl(it, cb) {
    var direct = it.DownloadUrl || it.downloadUrl || it.Url || it.url;
    if (direct) { cb(direct, ''); return; }
    // 真实接口（从官方分享页抓包得到）：
    //   POST /api/v2/share/download/info（带 timeSign 签名）
    //   body: {ShareKey, FileID, S3keyFlag, Size, Etag}
    //   resp: data.dispatchList[0].prefix + data.downloadPath 拼成下载直链
    var fid = Number(it.FileId || it.fileId) || 0;
    var s3 = it.S3KeyFlag || it.S3keyFlag || it.S3keyflag || it.s3keyFlag || it.s3KeyFlag || '';
    var etag = it.Etag || it.etag || '';
    var size = Number(it.Size || it.size || it.FileSize || 0);
    if (!s3 || !etag) {
      cb('', '缺少下载参数（S3keyFlag / Etag），请刷新分享列表后重试');
      return;
    }
    var body = JSON.stringify({
      ShareKey: shareState.key,
      FileID: fid,
      S3keyFlag: s3,
      Size: size,
      Etag: etag
    });
    shareApi('POST', '/api/v2/share/download/info', body, true, function (d) {
      if (!d || d.code !== 0) {
        cb('', (d && (d.message || d.error)) || ('下载接口返回 code=' + (d && d.code)));
        return;
      }
      var data = d.data || {};
      var prefix = (data.dispatchList && data.dispatchList[0] && data.dispatchList[0].prefix) || '';
      var dpath = data.downloadPath || data.DownloadPath || '';
      var url = data.DownloadUrl || data.downloadUrl || data.url
        || (prefix && dpath ? (prefix + dpath) : dpath);
      if (!url) { cb('', '接口未返回下载地址：' + JSON.stringify(data).slice(0, 200)); return; }
      cb(url, '');
    });
  }

  // ---------- 勾选后直接下载（不转存） ----------
  function doDownloadSelectedShare() {
    if (!shareState || !shareState.sel) { toast('请先勾选要下载的内容'); return; }
    var keys = Object.keys(shareState.sel);
    if (!keys.length) { toast('请先勾选要下载的内容'); return; }
    if (!bridge || !bridge.downloadStream) { toast('当前版本不支持直接下载'); return; }
    var all = keys.map(function (k) { return shareState.sel[k]; });
    var files = all.filter(function (it) { return Number(it.Type) !== 1; });
    var skipped = all.length - files.length;
    if (!files.length) { toast('已选的都是文件夹，请先转存后再下载'); return; }
    if (skipped > 0) toast('已跳过 ' + skipped + ' 个文件夹');
    toast('正在获取下载链接...');
    var left = files.length, ok = 0, fail = 0, firstErr = '';
    files.forEach(function (it) {
      fetchShareDownloadUrl(it, function (url, err) {
        if (url) {
          var fname = it.FileName || it.fileName || (Date.now() + '');
          var fsize = Number(it.Size || it.size || 0);
          try {
            var genId = Number(bridge.downloadStream(url, fname, fsize));
            if (genId >= 0) {
              addTransfer({ id: genId, name: fname, size: fsize, total: fsize, status: 'downloading', stream: true });
              ok++;
            } else { fail++; }
          } catch (e) { fail++; }
        } else { fail++; if (!firstErr) firstErr = err || ''; }
        if (--left === 0) {
          if (ok > 0) {
            startProgressPolling();
            toast('已加入下载任务 ' + ok + ' 项' + (fail ? ('，失败 ' + fail) : ''));
          } else {
            // 失败时用弹窗把服务端原话显示出来，方便定位（toast 太容易错过）
            var tt = $('cf-title'); if (tt) tt.textContent = '下载失败';
            showConfirm(firstErr || '未知错误', null);
          }
        }
      });
    });
  }

  // ---------- 转存：先选保存位置（复用整理弹窗的文件夹选择器），再提交 ----------
  function openTransferPicker() {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    if (!shareState || !shareState.sel || !Object.keys(shareState.sel).length) {
      toast('请先勾选要转存的内容'); return;
    }
    state.pickerMode = 'transfer';
    state.pickerItems = null;
    state.pickerState = { dir: 0, path: [] };
    var t = $('picker-title'); if (t) t.textContent = '转存到';
    var tip = $('picker-tip');
    if (tip) tip.textContent = '选择要保存到的文件夹（点「确定转存」保存到当前目录）';
    var c = $('picker-confirm'); if (c) c.textContent = '确定转存';
    show($('move-picker'));
    loadPickerDir(0, []);
  }
  function doTransferTo(parentId) {
    if (!shareState || !shareState.sel) return;
    var keys = Object.keys(shareState.sel);
    if (!keys.length) { toast('请先勾选要转存的内容'); return; }
    var target = Number(parentId) || 0;
    var body = JSON.stringify({
      share_key: shareState.key,
      // 同复制：ShareKey 已含提取码时不再单传 SharePwd（5 位提取码会被 4 位校验拒掉）
      share_pwd: (shareState.key && shareState.key.indexOf('-') >= 0) ? '' : (shareState.pwd || ''),
      current_level: 1,
      event: 'transfer',
      file_list: keys.map(function (k) {
        var it = shareState.sel[k];
        return {
          file_id: it.FileId || it.fileId,
          file_name: it.FileName || it.fileName || '',
          etag: it.Etag || it.etag || '',
          size: Number(it.Size || it.size || 0),
          parent_file_id: target,
          drive_id: 0,
          type: Number(it.Type || 0)
        };
      })
    });
    toast('正在提交转存...');
    shareApi('POST', '/b/api/file/copy/async', body, true, function (d) {
      if (d && d.code === 0) {
        closeMovePicker();
        closeReceivePage();
        toast('已转存到所选目录');
        if (state.view === 'files') loadList();
      } else {
        toast('转存失败：' + ((d && d.message) || '未知错误'));
      }
    });
  }

  // =========================================================================
  // 移植自 123.apk：下载目录 显示 / 清除缓存
  // =========================================================================
  // 展示用：优先取原生 display（会把内部根标记 "." 翻译成 "Download"）
  function getDirDisplay() {
    var d = '123云盘';
    if (bridge) {
      if (bridge.getDownloadSubDirDisplay) { try { d = bridge.getDownloadSubDirDisplay() || d; } catch (e) {} }
      else if (bridge.getDownloadSubDir) { try { d = bridge.getDownloadSubDir() || d; } catch (e) {} }
    }
    return d;
  }
  function renderDownloadDir() {
    var el = $('mine-dir-val');
    if (!el) return;
    var d = getDirDisplay();
    // 显示名已是 "Download"（根）时不再重复前缀
    el.textContent = (d === 'Download') ? 'Download' : ('Download/' + d);
  }
  function onChangeDownloadDir() {
    if (bridge && bridge.pickDownloadDir) {
      try { bridge.pickDownloadDir(); } catch (e) {}
    } else {
      toast('当前版本不支持选择目录，固定为 ' + (function () {
        var d = getDirDisplay();
        return (d === 'Download') ? 'Download' : ('Download/' + d);
      })());
    }
  }
  // NativeBridge 选定目录后回调（原生已持久化，这里只刷新 UI）
  // 通知栏「暂停/取消」按钮操作后，前端刷新传输列表
  window.__onDownloadsChanged = function () {
    try { pollDownloadProgress(); } catch (e) {}
    try { renderTransfers(); } catch (e) {}
  };
  window.__onDownloadDirPicked = function (dir) {
    renderDownloadDir();
    toast('下载目录已更新：' + (dir === 'Download' ? 'Download' : ('Download/' + dir)));
  };
  // 读取并显示应用缓存大小
  function updateCacheSize() {
    var el = $('mine-cache-size');
    if (!el) return;
    try {
      var sz = (bridge && bridge.getCacheSize) ? Number(bridge.getCacheSize() || 0) : 0;
      el.textContent = fmtSize(sz);
    } catch (e) { el.textContent = '0 B'; }
  }
  // 清除缓存：清本地传输记录 + 调用原生清除 WebView/应用缓存
  function clearCache() {
    try {
      var _ce = curAccountEntry();
      _ce.entry.downloads = [];
      _ce.entry.uploads = [];
      saveAccounts(_ce.list);
    } catch (e) {}
    state.transfers = state.transfers || [];
    state.transfers.length = 0;
    try { saveTransfers(); } catch (e) {}
    try { localStorage.removeItem('pan_uploads'); } catch (e) {}
    saveUploadTransfers([]);
    // 预览缓存（直链 + 文本 + 图片）也一并清空
    cacheClear();
    if (bridge && bridge.clearCache) {
      try { bridge.clearCache(); } catch (e) {}
    }
    toast('缓存已清除');
    setTimeout(updateCacheSize, 300);
  }

  // =========================================================================
  // 移植自 123.apk：传输页「离线下载」（磁力 / HTTP(S) 直链 → 云端离线下载）
  // =========================================================================
  function doOfflineDownload() {
    var inputEl = $('offline-url');
    var out = $('offline-result');
    var btn = $('offline-go');
    if (!inputEl) return;
    var url = String(inputEl.value || '').trim();
    if (!url) { toast('请输入链接'); return; }
    if (out) out.textContent = '';
    if (btn) btn.disabled = true;
    function done() { if (btn) btn.disabled = false; }
    function clearLater() { setTimeout(function () { try { if (inputEl) inputEl.value = ''; } catch (e) {} }, 2000); }
    api('POST', 'https://api.123278.com/b/api/v2/offline_download/task/resolve',
      JSON.stringify({ urls: url }), true, function (d) {
        if (!d || (d.code !== 0 && d.Code !== 0)) { done(); clearLater(); toast('解析失败'); return; }
        var data = d.data || d.Data || {};
        var list = data.list || data.List || [];
        var first = list[0] || {};
        if (first.err_code && String(first.err_code) !== '0' && Number(first.err_code) !== 0) { done(); clearLater(); toast('解析失败'); return; }
        var rid = first.id || first.ID || first.resource_id || 0;
        if (!rid) { done(); clearLater(); toast('解析失败'); return; }
        var selFiles = (first.files && first.files.map ? first.files.map(function (f) { return f.id || f.ID; }) : []) || [];
        api('POST', 'https://api.123278.com/b/api/v2/offline_download/task/submit',
          JSON.stringify({ resource_list: [{ resource_id: rid, select_file_id: selFiles }] }), true, function (d2) {
            done(); clearLater();
            if (d2 && (d2.code === 0 || d2.Code === 0)) {
              toast('离线任务已提交');
              setTimeout(function () { try { OFFLINE_DONE_STATE.loaded = false; loadOfflineDone(true); } catch (e) {} }, 1200);
            } else {
              toast('提交失败');
            }
          });
      });
  }


  // ==================== 离线下载：完成任务列表 ====================
  var OFFLINE_DONE_STATE = { list: [], loaded: false };
  function offlineDonePick(it, keyList) {
    for (var i = 0; i < keyList.length; i++) {
      var v = valOf(it, keyList[i]);
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  }
  function offlineDoneIsComplete(st) {
    if (st === null || st === undefined || st === '') return null;
    if (/(完成|已完成|成功|done|complete|success|finish)/i.test(String(st))) return true;
    if (/(失败|failed|error|出错|取消|cancel|abort|暂停|pause|等待|wait|进行|下载中|提交|queued|init)/i.test(String(st))) return false;
    var n = Number(st);
    if (!isNaN(n) && (n === 2 || n === 3)) return true;
    return null;
  }
  function loadOfflineDone(force) {
    var box = $('offline-done-list');
    if (!box) return;
    if (OFFLINE_DONE_STATE.loaded && !force) return;
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    hide($('offline-done-empty'));
    var urls = [
      'https://api.123278.com/api/offline_download/task/list',
      'https://api.123pan.cn/b/api/offline_download/task/list'
    ];
    var sarrs = [null, 1, 2, 3, 4, 5, 6, 7, 8];
    var shots = [];
    for (var hi = 0; hi < urls.length; hi++) {
      for (var si = 0; si < sarrs.length; si++) {
        var body = { page_size: 2000, current_page: 1 };
        if (sarrs[si] !== null) body.status_arr = [sarrs[si]];
        else body.current_page = 2;
        shots.push({ url: urls[hi], body: body });
      }
    }
    var qi = 0;
    (function next() {
      if (qi >= shots.length) {
        OFFLINE_DONE_STATE.list = [];
        OFFLINE_DONE_STATE.loaded = true;
        renderOfflineDone();
        return;
      }
      var s = shots[qi++];
      api('POST', s.url, JSON.stringify(s.body), true, function (d) {
        try { extDbgPush({ u: 'OFFLINE ' + String(s.url).slice(0, 100) + ' ' + JSON.stringify(s.body), ok: !!(d && d.code === 0), raw: d ? JSON.stringify(d).slice(0, 600) : '', req: JSON.stringify(s.body) }); } catch (e) {}
        var data = (d && d.data !== undefined) ? d.data : ((d && d.Data !== undefined) ? d.Data : d);
        var list = (data && Array.isArray(data.list)) ? data.list : null;
        if (list && list.length) {
          OFFLINE_DONE_STATE.list = list;
          OFFLINE_DONE_STATE.loaded = true;
          renderOfflineDone();
          return;
        }
        next();
      });
    })();
  }
  // 离线任务「跳转到位置」：直接按文件名搜索 → 原位渲染命中项（不显示搜索框/摘要）
  function jumpToOfflineFile(t) {
    var name = String((t && t.name) || '');
    if (!name) { toast('任务缺少文件名'); return; }
    try { closeAllOverlays(); } catch (e) {}
    try { switchView('files'); } catch (e) {}
    // 搜索态关闭：只把结果“原位”渲染进文件列表
    state.searching = false;
    state.highlightFid = '';
    state.highlightName = name;
    var params = 'driveId=0&limit=200&next=0&orderBy=' + curOrderBy + '&orderDirection=' + curOrderDir
      + '&parentFileId=0&trashed=false&Page=1&OnlyLookAbnormalFile=0'
      + '&SearchData=' + encodeURIComponent(name);
    api('GET', API.list + '?' + params, '', true, function (d) {
      var list = (d && d.data && d.data.InfoList) || [];
      var box = $('file-list');
      if (!list.length) { toast('未找到文件：' + name); return; }

      // 显示「上一级路径」：面包屑 = 全部文件 › 文件所在目录（点它可回到该目录列表）
      var hit0 = list[0] || {};
      var pid = hit0.ParentFileId || hit0.parentFileId || hit0.ParentId || 0;
      var pname = hit0.ParentName || hit0.parentName || (t && (t.upload_name || t.uploadName)) || '上一级';
      if (pid && Number(pid) !== 0) {
        state.breadcrumb = [{ id: pid, name: pname }];
        state.currentDir = pid;
        state.jumpReturn = true;      // 列表是搜索结果：点末级面包屑回到该目录
      } else {
        state.breadcrumb = [];
        state.currentDir = 0;
        state.jumpReturn = false;
      }
      try {
        var bc = $('breadcrumb-container'); if (bc) bc.style.display = '';
        var pd = $('path-display'); if (pd) pd.style.display = 'none';
        renderBreadcrumb();
      } catch (e) {}

      if (box) box.dataset.loaded = '1';
      state.dirSnap = state.dirSnap || {};
      renderList(list, (d && d.data && d.data.Total) || list.length);
      applyJumpHighlight();
      setTimeout(applyJumpHighlight, 300);
    });
  }
  // 清除跳转高亮（返回 / 切换页面 / 重载列表时调用）
  function clearJumpHighlight() {
    state.highlightFid = '';
    state.highlightName = '';
    state.jumpReturn = false;
    try {
      var box = $('file-list');
      if (!box) return;
      var rows = box.querySelectorAll('.file-card.hl-jump');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('hl-jump');
    } catch (e) {}
  }
  function renderOfflineDone() {
    var box = $('offline-done-list');
    if (!box) return;
    box.innerHTML = '';
    var list = OFFLINE_DONE_STATE.list || [];
    var _op = $('offline-panel');
    if (_op) _op.classList.toggle('is-empty', !list.length);
    if (!list.length) { show($('offline-done-empty')); return; }
    hide($('offline-done-empty'));
    list.forEach(function (t) {
      var name = offlineDonePick(t, ['name', 'Name', 'file_name', 'FileName', 'title', 'Title']) || '离线任务';
      var ttype = String(offlineDonePick(t, ['type', 'Type', 'task_type', 'TaskType', 'link_type', 'LinkType']) || '链接');
      var tagText = /magnet|bt|torrent|磁力/i.test(ttype) ? '磁力任务' : '链接任务';
      var sz = offlineDonePick(t, ['size', 'Size', 'file_size', 'FileSize']);
      var tm = offlineDonePick(t, ['finish_time', 'FinishTime', 'finished_at', 'FinishedAt', 'complete_time', 'CompleteTime', 'create_time', 'CreateTime', 'createAt', 'CreateAt', 'create_at', 'CreateAt']);
      var st = offlineDonePick(t, ['status', 'Status', 'task_status', 'TaskStatus', 'state', 'State', 'status_text', 'StatusText']);
      var stTxt = offlineDoneIsComplete(st) === false ? '进行中' : '已完成';
      var metas = [];
      if (sz !== null && sz !== '') metas.push(fmtSize(sz));
      metas.push(stTxt);
      if (tm !== null && tm !== '') metas.push(fmtDateTime(tm));
      var id = offlineDonePick(t, ['id', 'Id', 'ID', 'task_id', 'TaskId', 'taskId']);
      var card = document.createElement('div');
      card.className = 'offline-done-card';
      var ic = document.createElement('div');
      ic.className = 'file-icon-wrap';
      var fi = makeIcon(iconFor({ FileName: String(name) }), 'file-icon');
      if (fi) ic.appendChild(fi);
      var body = document.createElement('div');
      body.className = 'od-body';
      var nm = document.createElement('div');
      nm.className = 'od-name';
      nm.textContent = name;
      var mt = document.createElement('div');
      mt.className = 'od-meta';
      mt.innerHTML = '<span class="od-type-tag">' + esc(tagText) + '</span>' + esc(metas.join(' · '));
      body.appendChild(nm);
      body.appendChild(mt);
      card.appendChild(ic);
      card.appendChild(body);
      if (id !== null) {
        var del = document.createElement('button');
        del.className = 'od-del';
        del.title = '删除记录';
        del.innerHTML = '<img class="t-del-ic" alt="" src="data:image/svg+xml;base64,' + 'PHN2ZyB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHZpZXdCb3g9IjAgMCAxNCAxNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgaWQ9IiYjMjI5OyYjMTU1OyYjMTU4OyYjMjMwOyYjMTQ4OyYjMTgyOyYjMjMxOyYjMTcxOyYjMTUzOy0mIzIzMzsmIzE4NzsmIzE1MjsmIzIzMjsmIzE3NDsmIzE2NDsiPgo8cGF0aCBpZD0iJiMyMzE7JiMxNTk7JiMxNjk7JiMyMjk7JiMxODk7JiMxNjI7IiBkPSJNMTEuMDgzNCAxMC4yMDg1QzExLjA4MzQgMTEuMTc1IDEwLjI5OTkgMTEuOTU4NSA5LjMzMzQxIDExLjk1ODVINC42NjY3NUMzLjcwMDI1IDExLjk1ODUgMi45MTY3NSAxMS4xNzUgMi45MTY3NSAxMC4yMDg1VjQuOTU4NUMyLjkxNjc1IDQuNDc1MjUgMy4zMDg1IDQuMDgzNSAzLjc5MTc1IDQuMDgzNUgxMC4yMDg0QzEwLjY5MTcgNC4wODM1IDExLjA4MzQgNC40NzUyNSAxMS4wODM0IDQuOTU4NVYxMC4yMDg1WiIgc3Ryb2tlPSIjM0MzRjUyIiBzdHJva2Utd2lkdGg9IjEuMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CjxwYXRoIGlkPSImIzIzMjsmIzE4MzsmIzE3NTsmIzIyOTsmIzE5MDsmIzEzMjsgNCIgZD0iTTEuNzUgNC4wODM1SDEyLjI1IiBzdHJva2U9IiMzQzNGNTIiIHN0cm9rZS13aWR0aD0iMS4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPHBhdGggaWQ9IiYjMjMxOyYjMTU5OyYjMTY5OyYjMjI5OyYjMTg5OyYjMTYyO18yIiBkPSJNNC42NjY3NSAzLjQ5OTg0TDQuOTU2NzMgMi43NzQ4OEM1LjEzMzkgMi4zMzE5NSA1LjU2MjkgMi4wNDE1IDYuMDM5OTUgMi4wNDE1SDcuOTYwMjFDOC40MzcyNiAyLjA0MTUgOC44NjYyNiAyLjMzMTk1IDkuMDQzNDMgMi43NzQ4OEw5LjMzMzQxIDMuNDk5ODQiIHN0cm9rZT0iIzNDM0Y1MiIgc3Ryb2tlLXdpZHRoPSIxLjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgo8L2c+Cjwvc3ZnPgo=' + '">';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          offlineDoneDelete(id);
        });
        card.appendChild(del);
      }
      card.addEventListener('click', function () { jumpToOfflineFile(t); });
      box.appendChild(card);
    });
  }
  function clearAllOfflineDone() {
    var list = OFFLINE_DONE_STATE.list || [];
    if (!list.length) {
      OFFLINE_DONE_STATE.loaded = false;
      loadOfflineDone(true);
      toast('列表加载中，请稍后再点一次');
      return;
    }
    var ids = [], i, id;
    for (i = 0; i < list.length; i++) {
      id = offlineDonePick(list[i], ['id', 'Id', 'ID', 'task_id', 'TaskId', 'taskId']);
      if (id !== null && id !== undefined && id !== '') ids.push(id);
    }
    if (!ids.length) { toast('没有可清除的离线任务'); return; }
    // 官方 deleteOfflineDownloadTask：task_ids（数组）与 status_arr 只能传其一
    extApiTry([
      { method: 'POST', url: 'https://api.123278.com/api/offline_download/task/delete', body: JSON.stringify({ task_ids: ids }) },
      { method: 'POST', url: 'https://api.123pan.cn/b/api/offline_download/task/delete', body: JSON.stringify({ task_ids: ids }) }
    ], function (d, err) {
      if (!d) { toast(err ? ('清除失败：' + String(err).slice(0, 60)) : '清除失败'); return; }
      toast('已清除 ' + ids.length + ' 条离线记录');
      OFFLINE_DONE_STATE.loaded = false;
      loadOfflineDone(true);
    });
  }
  function offlineDoneDelete(id) {
    // 官方实现：deleteOfflineDownloadTask 只接受 task_ids（数组）或 status_arr，二者只能传其一
    extApiTry([
      { method: 'POST', url: 'https://api.123278.com/api/offline_download/task/delete', body: JSON.stringify({ task_ids: [id] }) },
      { method: 'POST', url: 'https://api.123pan.cn/b/api/offline_download/task/delete', body: JSON.stringify({ task_ids: [id] }) }
    ], function (d, err) {
      if (!d) { toast(err ? ('删除失败：' + String(err).slice(0, 50)) : '删除失败'); return; }
      toast('已删除');
      OFFLINE_DONE_STATE.loaded = false;
      loadOfflineDone(true);
    });
  }
  // =========================================================================
  // 文件操作增强：详细信息 / 去重
  // =========================================================================
  function pad2n(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDateTime(v) {
    if (v === null || v === undefined || v === '' || v === 0 || v === '0') return '-';
    var n = Number(v);
    if (!isNaN(n) && n > 0) {
      if (n < 1e11) n = n * 1000;    // 秒 → 毫秒
      var d = new Date(n);
      if (!isNaN(d.getTime())) {
        return d.getFullYear() + '-' + pad2n(d.getMonth() + 1) + '-' + pad2n(d.getDate())
          + ' ' + pad2n(d.getHours()) + ':' + pad2n(d.getMinutes()) + ':' + pad2n(d.getSeconds());
      }
    }
    return String(v);
  }

  // ---- 详细信息弹窗：名称 / 类型 / 大小 / 修改时间 / 文件id ----
  function openDetail(item) {
    closeAllOverlays();
    item = item || {};
    var isDir = (item.Type === 1 || item.Type === '1');
    var ext = getFileExtension(item.FileName || '');
    var typeText = isDir ? '文件夹' : (ext ? (ext.toUpperCase() + ' 文件') : '文件');
    var ts = item.UpdateAt || item.updatedAt || item.updateAt || item.UpdatedAt || item.UpdateTime
      || item.ModifyTime || item.modifyTime || item.CreateAt || item.createAt || item.CreateTime;
    var rows = [
      ['名称', item.FileName || item.fileName || '-'],
      ['类型', typeText],
      ['大小', isDir ? '-' : fmtSize(item.Size)],
      ['修改时间', fmtDateTime(ts)],
      ['文件id', String(item.FileId || item.fileId || '-')]
    ];
    var box = $('detail-list');
    if (box) {
      var html = '';
      rows.forEach(function (r) {
        html += '<div class="pf-row"><span class="pf-k">' + esc(r[0]) + '</span>'
          + '<span class="pf-v">' + esc(r[1]) + '</span></div>';
      });
      box.innerHTML = html;
    }
    show($('detail-modal'));
  }

  // =========================================================================
  // 去重（新）：递归扫描 → 同组列在一个组件内、标记 1/2/3… → 可选删除 / 整理
  // =========================================================================
  var dedupeGroups = [];   // [{items:[file,...], size}]
  var dedupeSel = {};      // fileId -> file（勾选项）
  var dedupeScanning = false;
  var dedupeCancel = false;   // 退出（取消/返回）：终止扫描且不再回弹窗
  var dedupePaused = false;   // 暂停（点空白）：可继续

  // 递归（BFS）列出目录（含所有下层文件夹）里的全部文件
  // onProgress(文件数, 已扫描文件夹数) 实时回调；dedupeCancel 为 true 则提前结束
  function scanAllFiles(rootId, onProgress, done) {
    var files = [], queue = [Number(rootId) || 0], visited = {}, dirs = 0;
    (function step() {
      if (dedupeCancel) { done(files, true); return; }        // 已退出
      if (dedupePaused) { setTimeout(step, 200); return; }     // 暂停中：轮询等待继续
      if (!queue.length) { done(files, false); return; }
      var pid = queue.shift();
      var key = String(pid);
      if (visited[key]) { step(); return; }
      visited[key] = 1;
      var params = 'driveId=0&limit=200&next=0&orderBy=file_id&orderDirection=desc'
        + '&parentFileId=' + pid + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
      api('GET', API.list + '?' + params, '', true, function (d) {
        var list = (d && d.data && d.data.InfoList) ? d.data.InfoList : [];
        list.forEach(function (x) {
          if (x.Type === 1 || x.Type === '1') queue.push(Number(x.FileId || x.fileId) || 0);
          else files.push(x);
        });
        dirs++;
        if (onProgress) onProgress(files.length, dirs, files);
        step();
      });
    })();
  }

  // 入口：传文件夹则递归扫它，否则递归扫当前路径
  function dedupeStart(item) {
    if (dedupeScanning) { toast('正在扫描中，请稍候...'); return; }
    item = item || null;
    var isDir = !!(item && (item.Type === 1 || item.Type === '1'));
    var rootId = isDir ? (Number(item.FileId || item.fileId) || 0) : (Number(state.currentDir) || 0);
    dedupeScanning = true;
    dedupeCancel = false;
    dedupeGroups = [];
    dedupeSel = {};
    closeAllOverlays();
    var sum = $('dedupe-sum');
    var listEl = $('dedupe-list');
    if (sum) sum.innerHTML = '';
    if (listEl) listEl.innerHTML = '';

    // 1) 立即弹「小窗」（不占满）
    // 2) 一有重复列表 → 自动扩大显示
    // 3) 超过 1 秒仍未扫完 → 直接变成完整尺寸
    var startedAt = Date.now();
    var lastFiles = [], lastCount = 0, lastDirs = 0;
    var _lastDedupeDraw = 0;   // 扫描进度重绘节流：最多每 300ms 重建一次列表 DOM
    dedupeRender([], 0, false, { live: true, dirs: 0, compact: true });
    var liveTimer = setTimeout(function () {
      if (!dedupeScanning || dedupeCancel) return;
      dedupeRender(dedupeGroup(lastFiles), lastCount, false, { live: true, dirs: lastDirs, compact: false });
    }, 1000);

    scanAllFiles(rootId, function (count, dirs, files) {
      // 关键：已点取消/返回退出后，这次在途请求回来时绝不能再把弹窗重新渲染出来
      if (dedupeCancel) return;
      lastFiles = files || []; lastCount = count; lastDirs = dirs;
      var _nowR = Date.now();
      if (_nowR - _lastDedupeDraw < 300) return;   // 节流：进度太密时跳过本帧重绘（最终结果不受影响）
      _lastDedupeDraw = _nowR;
      var g = dedupeGroup(lastFiles);
      dedupeRender(g, count, false, {
        live: true, dirs: dirs,
        compact: (g.length === 0 && (Date.now() - startedAt) < 1000)
      });
    }, function (files, stopped) {
      clearTimeout(liveTimer);
      dedupeScanning = false;
      var wasExit = dedupeCancel;      // 用户已取消/返回 → 不再把弹窗弹回来
      dedupeCancel = false;
      dedupePaused = false;
      dedupeSetPausedUI(false);
      if (wasExit) return;
      var g = dedupeGroup(files);
      dedupeRender(g, files.length, stopped, { compact: g.length === 0 });
    });
  }

  // 把文件列表按「Etag(MD5)+大小」（无 Etag 则 同名+大小）分组，只留重复组
  function dedupeGroup(files) {
    var groups = {};
    (files || []).forEach(function (f) {
      var etag = String(f.Etag || f.etag || '').toLowerCase();
      var size = Number(f.Size || 0);
      var k = etag ? ('e|' + etag + '|' + size) : ('n|' + String(f.FileName || '').toLowerCase() + '|' + size);
      if (!groups[k]) groups[k] = [];
      groups[k].push(f);
    });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length > 1) out.push({ items: g, size: Number(g[0].Size || 0) });
    });
    out.sort(function (a, b) { return b.size - a.size; });
    return out;
  }

  // 列表 HTML（同组在一组件内、上下列表、标号 1/2/3…）
  function dedupeBuildHtml(groups) {
    var html = '';
    (groups || []).forEach(function (grp, gi) {
      html += '<div class="dd-group"><div class="dd-group-head">组 ' + (gi + 1) + ' · '
        + grp.items.length + ' 个相同文件 · ' + fmtSize(grp.size) + '</div>';
      grp.items.forEach(function (f, fi) {
        var fid = Number(f.FileId || f.fileId) || 0;
        var on = fi > 0;
        html += '<div class="dd-item' + (on ? ' on' : '') + '" data-fid="' + fid + '">'
          + '<span class="dd-ck">' + (on ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '') + '</span>'
          + '<span class="dd-no">' + (fi + 1) + '</span>'
          + '<span class="dd-name">' + esc(f.FileName || '') + '</span>'
          + '<span class="dd-size">' + fmtSize(f.Size) + '</span></div>';
      });
      html += '</div>';
    });
    if (!html) html = '<div class="p-empty">暂未发现重复文件</div>';
    return html;
  }

  function dedupeRender(groups, total, stopped, opts) {
    opts = opts || {};
    if (!opts.live) closeAllOverlays();
    // 小窗 / 完整尺寸（有列表或超过 1 秒 → 完整尺寸）
    var panel = document.querySelector('#dedupe-modal .dedupe-panel');
    if (panel) panel.classList.toggle('compact', !!opts.compact);
    dedupeGroups = groups || [];
    var sum = $('dedupe-sum');
    var listEl = $('dedupe-list');
    var stopTip = stopped ? '（扫描已提前停止）' : '';

    // 默认勾选：每组保留第 1 个，其余选中
    dedupeSel = {};
    var dupCount = 0, wasted = 0;
    dedupeGroups.forEach(function (grp) {
      grp.items.forEach(function (f, fi) {
        if (fi > 0) {
          var fid = Number(f.FileId || f.fileId) || 0;
          dedupeSel[fid] = f; dupCount++; wasted += Number(f.Size || 0);
        }
      });
    });

    if (sum) {
      if (opts.live) {
        sum.innerHTML = '<b>正在扫描…</b> 已扫描 ' + (opts.dirs || 0) + ' 个文件夹，发现 <b>' + total + '</b> 个文件，'
          + '已找到 <b>' + dedupeGroups.length + '</b> 组重复（列表实时刷新）';
      } else if (!dedupeGroups.length) {
        sum.innerHTML = '已递归扫描 <b>' + total + '</b> 个文件' + stopTip + '，<b>没有发现重复文件</b>。';
      } else {
        sum.innerHTML = '已递归扫描 <b>' + total + '</b> 个文件' + stopTip + '，' + dedupeGroups.length + ' 组重复，待处理 <b>'
          + dupCount + '</b> 项，可释放 <b>' + fmtSize(wasted) + '</b>。默认每组保留第 1 个，点条目可切换勾选。';
      }
    }
    if (listEl) listEl.innerHTML = dedupeBuildHtml(dedupeGroups);

    if (opts.live) {
      // 扫描中：禁用操作按钮
      var ok = $('dedupe-ok'), org = $('dedupe-organize');
      if (ok) { ok.disabled = true; ok.textContent = '删除'; }
      if (org) { org.disabled = true; org.textContent = '整理'; }
    } else {
      dedupeUpdateBtns();
    }
    show($('dedupe-modal'));
  }

  function dedupeUpdateBtns() {
    var n = Object.keys(dedupeSel).length;
    var del = $('dedupe-ok'), org = $('dedupe-organize');
    if (del) { del.disabled = (n === 0); del.textContent = n ? ('删除(' + n + ')') : '删除'; }
    if (org) { org.disabled = (n === 0); org.textContent = n ? ('整理(' + n + ')') : '整理'; }
  }

  // 暂停/继续：切换标志、显示「继续扫描」、并把摘要里的「正在扫描」改成「已暂停」
  function dedupeSetPausedUI(p) {
    dedupePaused = !!p;
    var bar = $('dedupe-pause-bar');
    if (bar) bar.style.display = (dedupeScanning && dedupePaused) ? 'flex' : 'none';
    var sum = $('dedupe-sum');
    if (sum && dedupeScanning && dedupePaused) {
      sum.innerHTML = sum.innerHTML.replace('正在扫描…', '已暂停');
    }
    if (sum && dedupeScanning && !dedupePaused) {
      sum.innerHTML = sum.innerHTML.replace('已暂停', '正在扫描…');
    }
  }

  function bindDedupeList() {
    // 点空白处：扫描中就停止扫描（不关闭弹窗）
    // 点空白 = 暂停 / 继续
    var dmask = $('dedupe-mask');
    if (dmask) dmask.addEventListener('click', function () {
      if (!dedupeScanning) return;
      dedupeSetPausedUI(!dedupePaused);
    });
    // 取消 = 直接退出（同时终止扫描）
    var dcancel = $('dedupe-cancel');
    if (dcancel) dcancel.addEventListener('click', function () {
      dedupeCancel = true; dedupePaused = false;
      hide($('dedupe-modal'));
    });
    // 继续扫描按钮
    var dresume = $('dedupe-resume');
    if (dresume) dresume.addEventListener('click', function () {
      if (!dedupeScanning) return;
      dedupeSetPausedUI(false);
    });
    var box = $('dedupe-list');
    if (!box) return;
    box.onclick = function (e) {
      var it = e.target && e.target.closest ? e.target.closest('.dd-item') : null;
      if (!it) return;
      var fid = Number(it.getAttribute('data-fid')) || 0;
      var file = null;
      dedupeGroups.forEach(function (g) {
        g.items.forEach(function (f) { if ((Number(f.FileId || f.fileId) || 0) === fid) file = f; });
      });
      if (!file) return;
      var ck = it.querySelector('.dd-ck');
      if (dedupeSel[fid]) {
        delete dedupeSel[fid];
        it.classList.remove('on');
        if (ck) ck.innerHTML = '';
      } else {
        dedupeSel[fid] = file;
        it.classList.add('on');
        if (ck) ck.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      dedupeUpdateBtns();
    };
  }

  function dedupeSelectedItems() {
    var a = [];
    Object.keys(dedupeSel).forEach(function (k) { a.push(dedupeSel[k]); });
    return a;
  }

  function dedupeDelete() {
    var items = dedupeSelectedItems();
    if (!items.length) { toast('请先勾选要删除的重复文件'); return; }
    var ids = items.map(function (x) { return Number(x.FileId || x.fileId) || 0; });
    toast('正在删除 ' + ids.length + ' 项...');
    api('POST', API.trash, JSON.stringify({
      RequestSource: null, driveId: 0, event: 'intoRecycle',
      fileTrashInfoList: ids.map(function (fid) { return { FileId: fid }; }),
      operatePlace: 1, operation: true
    }), true, function (d) {
      if (d && d.code === 0) {
        hide($('dedupe-modal'));
        dedupeSel = {}; dedupeGroups = [];
        toast('已删除 ' + ids.length + ' 个重复项（可在回收站还原）');
        loadList();
      } else { toast((d && d.message) || '删除失败'); }
    });
  }

  // 整理：把勾选项移动到一个选定的目录
  function dedupeOrganize() {
    var items = dedupeSelectedItems();
    if (!items.length) { toast('请先勾选要整理的文件'); return; }
    hide($('dedupe-modal'));
    closeAllOverlays();
    state.pickerItems = items;
    state.pickerMode = 'dedupe-move';
    state.pickerState = { dir: 0, path: [] };
    var t = $('picker-title'); if (t) t.textContent = '整理到（' + items.length + ' 项）';
    var tip = $('picker-tip');
    if (tip) tip.textContent = '选择要把勾选的重复文件移动到的文件夹（点「确定整理」移入当前目录）';
    var c = $('picker-confirm'); if (c) c.textContent = '确定整理';
    show($('move-picker'));
    loadPickerDir(0, []);
  }
  function dedupeMove(targetId) {
    var items = state.pickerItems || [];
    if (!items.length) { closeMovePicker(); return; }
    var ids = items.map(function (x) { return Number(x.FileId || x.fileId) || 0; });
    api('POST', API.move, JSON.stringify({
      parentFileId: Number(targetId) || 0,
      fileIdList: ids.map(function (fid) { return { FileId: fid }; })
    }), true, function (d) {
      closeMovePicker();
      if (d && d.code === 0) {
        dedupeSel = {}; dedupeGroups = [];
        toast('已整理 ' + ids.length + ' 项');
        loadList();
      } else { toast((d && d.message) || '整理失败'); }
    });
  }

  // ---- 去重（旧版实现，已被上面的 dedupeStart 取代，保留兼容） ----
  var dedupeDel = [];
  function doDedupe(item) {
    item = item || {};
    var isDir = (item.Type === 1 || item.Type === '1');
    var parentId = isDir ? (Number(item.FileId || item.fileId) || 0) : (Number(state.currentDir) || 0);
    toast(isDir ? '正在扫描该文件夹...' : '正在扫描当前目录...');
    var params = 'driveId=0&limit=200&next=0&orderBy=file_id&orderDirection=desc'
      + '&parentFileId=' + parentId + '&trashed=false&Page=1&OnlyLookAbnormalFile=0';
    api('GET', API.list + '?' + params, '', true, function (d) {
      var list = (d && d.data && d.data.InfoList) ? d.data.InfoList : [];
      var files = list.filter(function (x) { return !(x.Type === 1 || x.Type === '1'); });
      var groups = {};
      files.forEach(function (f) {
        var etag = String(f.Etag || f.etag || '').toLowerCase();
        var size = Number(f.Size || 0);
        var key = etag ? ('e|' + etag + '|' + size) : ('n|' + String(f.FileName || '').toLowerCase() + '|' + size);
        if (!groups[key]) groups[key] = [];
        groups[key].push(f);
      });
      var dups = [];
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        if (g.length > 1) { for (var i = 1; i < g.length; i++) dups.push({ keep: g[0], del: g[i] }); }
      });
      showDedupeResult(dups, files.length);
    });
  }
  function showDedupeResult(dups, total) {
    closeAllOverlays();
    var sum = $('dedupe-sum');
    var listEl = $('dedupe-list');
    var okBtn = $('dedupe-ok');
    if (!dups.length) {
      if (sum) sum.innerHTML = '本次扫描 <b>' + total + '</b> 个文件，<b>没有发现重复文件</b>。';
      if (listEl) listEl.innerHTML = '';
      if (okBtn) okBtn.classList.add('hidden');
      dedupeDel = [];
      show($('dedupe-modal'));
      return;
    }
    if (okBtn) okBtn.classList.remove('hidden');
    var wasted = 0, html = '';
    dups.forEach(function (p, i) {
      wasted += Number(p.del.Size || 0);
      html += '<div class="dedupe-item">' + (i + 1) + '. ' + esc(p.del.FileName || '')
        + '　<span class="dd-tag">重复</span> ' + fmtSize(p.del.Size)
        + '<br>保留：' + esc(p.keep.FileName || '') + '</div>';
    });
    if (sum) {
      sum.innerHTML = '共 <b>' + total + '</b> 个文件，发现 <b>' + dups.length + '</b> 个重复项，可释放 <b>'
        + fmtSize(wasted) + '</b>。删除时每组只保留第一个（其余移入回收站，可还原）。';
    }
    if (listEl) listEl.innerHTML = html;
    dedupeDel = dups.map(function (p) { return Number(p.del.FileId || p.del.fileId) || 0; });
    show($('dedupe-modal'));
  }
  function doDedupeDelete() {
    if (!dedupeDel.length) return;
    var ids = dedupeDel.slice();
    toast('正在删除 ' + ids.length + ' 个重复项...');
    api('POST', API.trash, JSON.stringify({
      RequestSource: null,
      driveId: 0,
      event: 'intoRecycle',
      fileTrashInfoList: ids.map(function (fid) { return { FileId: fid }; }),
      operatePlace: 1,
      operation: true
    }), true, function (d) {
      if (d && d.code === 0) {
        hide($('dedupe-modal'));
        dedupeDel = [];
        toast('已删除 ' + ids.length + ' 个重复项（可在回收站还原）');
        loadList();
      } else {
        toast((d && d.message) || '删除失败');
      }
    });
  }

  // =========================================================================
  // 「我的」页新增：个人资料 / 主题模式 / 会员标识 / 直链解析
  // =========================================================================

  // ---------- 通用取值：按候选键取第一个「有值」的字段（支持常见嵌套层） ----------
  function valOf(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var names = Array.prototype.slice.call(arguments, 1);
    var roots = [obj];
    ['user', 'User', 'vip', 'Vip', 'VIP', 'vipInfo', 'VipInfo', 'member', 'memberInfo',
     'data', 'Data', 'extra', 'Extra', 'profile', 'Profile', 'UserVipDetail', 'UserVipDetailInfos',
     'BackupFileInfo'].forEach(function (k) {
      if (obj[k] && typeof obj[k] === 'object') roots.push(obj[k]);
    });
    for (var r = 0; r < roots.length; r++) {
      for (var i = 0; i < names.length; i++) {
        var v = roots[r][names[i]];
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
    return null;
  }
  // 数值版：接受 0（numOf 会跳过 0，但「直链流量：0 B」这类真实值需要保留）
  function numVal(obj) {
    var v = valOf.apply(null, arguments);
    if (v === null) return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(ts) {
    // 兼容秒 / 毫秒时间戳与日期字符串；0 或空按 1970-01-01 显示
    if (ts === null || ts === undefined || ts === '' || ts === 0 || ts === '0') return '1970-01-01';
    var n = Number(ts);
    if (!isNaN(n) && n > 0) {
      if (n < 1e11) n = n * 1000;         // 秒 → 毫秒
      var d = new Date(n);
      if (!isNaN(d.getTime())) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    return String(ts);
  }
  function yesNo(v, yesText, noText) {
    if (v === null || v === undefined) return noText;
    if (v === true) return yesText;
    if (v === false) return noText;
    var n = Number(v);
    if (v !== '' && !isNaN(n)) return n > 0 ? yesText : noText;
    var s = String(v).toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'y' || s === '1') return yesText;
    if (s === 'false' || s === 'no' || s === 'n' || s === '0') return noText;
    if (s.indexOf('已') === 0) return yesText;
    if (s.indexOf('pass') >= 0 || s.indexOf('verif') >= 0) return yesText;
    if (s.indexOf('bind') >= 0 && s.indexOf('unbind') < 0) return yesText;
    return noText;
  }

  // ---------- 会员判定（账号行小图标 + 个人资料弹窗共用） ----------
  function profileVipInfo(u) {
    u = (u && typeof u === 'object') ? u : {};
    var vip = u.vip || u.Vip || u.VIP || u.vipInfo || u.VipInfo || u.member || u.memberInfo || {};
    var lv = numVal(u, 'vipLevel', 'VipLevel', 'VIPLevel', 'vip_level', 'vipLevelNum', 'VipStatus');
    if (lv === null) lv = numVal(vip, 'level', 'Level', 'vipLevel', 'grade', 'Grade');
    var flag = valOf(u, 'isVip', 'IsVip', 'isVIP', 'Vip', 'vipFlag', 'VipFlag', 'vipStatus');
    if (flag === null) flag = valOf(vip, 'isVip', 'IsVip', 'vip', 'Vip');
    var isVip = false, known = false;
    if (flag !== null) {
      isVip = (flag === true || Number(flag) > 0 || String(flag).toLowerCase() === 'true');
      known = true;
    } else if (lv !== null) {
      isVip = lv > 0;
      known = true;
    }
    var name = valOf(vip, 'name', 'Name', 'levelName', 'LevelName', 'title', 'Title', 'vipName');
    if (!name) name = valOf(u, 'vipLevelName', 'VipLevelName', 'vipName', 'VipName');
    return { isVip: isVip, known: known, level: lv, name: name ? String(name) : null };
  }
  // 账号后空两格 + 会员 / 普通用户小图标（官方 VIP / SVIP 标志；普通用户置灰）
  function accountBadgeHtml() {
    var isVip = !!(state.profile && state.profile.isVip);
    var title = isVip ? '会员' : '普通用户';
    return '&nbsp;&nbsp;<span class="acct-badge ' + (isVip ? 'vip' : 'normal') + '" title="' + title + '">'
      + vipLogoImgHtml(!isVip) + '</span>';
  }
  // 轻量拉取会员资料（zip 预览等需要及时拿到 VIP 状态的场景调用）
  function fetchUserProfile(cb) {
    api('GET', API.userInfo, '', true, function (d) {
      try {
        var u = d && (d.data || d.Data);
        if (u && u.user && typeof u.user === 'object') u = u.user;
        if (u) {
          var _nick = u.nickname || u.Nickname || u.nickName || '';
          var _head = u.headImage || u.headImg || u.HeadImage || u.avatar || '';
          var _vip = profileVipInfo(u);
          var _prev = state.profile || {};
          state.profile = {
            nickname: String(_nick || _prev.nickname || ''),
            headImage: String(_head || _prev.headImage || ''),
            isVip: _vip.isVip,
            vipKind: _vip.isVip ? (/svip|超级|年费/i.test(String(_vip.name || '')) ? 'svip' : 'vip') : ''
          };
          state.profileAt = Date.now();
          try { renderAccountList(); } catch (e) {}
        }
      } catch (e) {}
      if (cb) cb();
    });
  }

  // ---------- 个人资料弹窗 ----------
  function openProfile() {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    // 先把 13 行占位直接画满，弹窗一出现就是完整尺寸，避免“从小变大”
    renderProfile(null);
    show($('profile-modal'));
    api('GET', API.userInfo, '', true, function (d) {
      var u = null;
      if (d) {
        u = d.data || d.Data || null;
        if (u && u.user && typeof u.user === 'object') u = u.user;
      }
      renderProfile(u || {});
      try { probeProfileExtras(u || {}); } catch (e) {}
    });
  }
  function renderProfile(u) {
    var box = $('profile-list');
    if (!box) return;
    u = u || {};
    var curAcct = currentAccountUser() || state.user || '';

    // UID：接口字段优先，其次用原生保存的登录 uuid
    var uid = valOf(u, 'uid', 'Uid', 'UID', 'userId', 'UserId', 'user_id', 'id', 'ID');
    if (uid === null) { try { uid = (bridge && bridge.getLoginuuid) ? bridge.getLoginuuid() : null; } catch (e) { uid = null; } }

    var nick = valOf(u, 'nickname', 'Nickname', 'nickName', 'NickName')
      || (state.profile && state.profile.nickname) || '';
    var mail = valOf(u, 'mail', 'Mail', 'email', 'Email', 'mailbox');
    var acct = valOf(u, 'passport', 'Passport', 'account', 'Account', 'userName', 'UserName', 'mobile', 'Mobile') || curAcct;

    var vinfo = profileVipInfo(u);
    var vipText = vinfo.isVip ? (vinfo.name || ('VIP' + (vinfo.level && vinfo.level > 0 ? vinfo.level : ''))) : '普通用户';
    var vipObj = u.vip || u.Vip || u.VIP || u.vipInfo || u.VipInfo || u.member || {};
    var vipExpireRaw = valOf(u, 'vipExpire', 'VipExpire', 'vipExpireTime', 'VipExpireTime', 'vipEndTime', 'VipEndTime', 'expireTime', 'ExpireTime');
    if (vipExpireRaw === null) vipExpireRaw = valOf(vipObj, 'expire', 'expireTime', 'endTime', 'EndTime', 'expiredAt', 'expireAt');
    if (vipExpireRaw === null) { try { var _uvs = (u.UserVipDetail && u.UserVipDetail.UserVipDetailInfos) || []; if (_uvs[0]) vipExpireRaw = _uvs[0].EndTime || _uvs[0].TimeDesc || null; } catch (e) {} }
    var vipDuration = numVal(u, 'vipDuration', 'VipDuration', 'vipDays', 'VipDays');
    if (vipDuration === null) vipDuration = numVal(vipObj, 'duration', 'durationDays', 'days', 'Duration');

    // 实名：真实字段 IsAuthentication（user/info 实测），保留其它候选
    var realRaw = valOf(u, 'IsAuthentication', 'isAuthentication', 'RealNameAuth', 'realNameAuth',
      'registerRealNameAuth', 'fileRealName', 'isRealName', 'IsRealName', 'realNameStatus', 'RealNameStatus',
      'authStatus', 'AuthStatus', 'isVerified', 'IsVerified', 'certification', 'Certification', 'isAuth', 'authType');
    var realName = valOf(u, 'realName', 'RealName', 'realname', 'trueName');
    var realText = (realRaw !== null)
      ? yesNo(realRaw, '已认证', '未认证')
      : ((realName !== null && String(realName).trim()) ? '已认证' : '未认证');

    // 微信：真实字段 BindWechat（user/info 实测），保留其它候选
    var wxRaw = valOf(u, 'BindWechat', 'bindWechat', 'isBindWechat', 'IsBindWechat', 'wxBind', 'WxBind',
      'wechatBind', 'WechatBind', 'isWxBind', 'wxBound', 'isBindWx', 'isWechatBind', 'wechatStatus', 'wxStatus',
      'wechat_open_id', 'wechat_union_id', 'wechatOpenId', 'wechatUnionId', 'wechatNickname');
    var wxText;
    if (wxRaw === null || wxRaw === undefined || wxRaw === '') {
      wxText = '未绑定';
    } else {
      var _ws = String(wxRaw);
      if (/^(0|false|no|unbind|none|null)$/i.test(_ws)) { wxText = '未绑定'; }
      else if (_ws.length > 6 && !/已|bind/i.test(_ws)) { wxText = '已绑定'; }   // open_id / union_id 长串
      else if (/已|bind|true|yes/i.test(_ws) || Number(wxRaw) > 0) { wxText = '已绑定'; }
      else { wxText = yesNo(wxRaw, '已绑定', '未绑定'); }
    }

    var fileCount = numVal(u, 'fileCount', 'FileCount', 'fileTotal', 'FileTotal', 'totalFileCount',
      'fileNum', 'FileNum', 'file_count', 'totalFile', 'TotalFile', 'fileQty');

    // 容量：与首页「存储空间」一致的取法
    var used = numVal(u, 'SpaceUsed', 'UsedSize', 'usedSize', 'space_used', 'used', 'spaceUsed');
    var permanent = numVal(u, 'SpacePermanent', 'TotalSize', 'totalSize', 'space_total', 'total', 'capacity', 'spacePermanent');
    var temp = numVal(u, 'SpaceTemp', 'freeSize', 'FreeSize', 'space_temp', 'free', 'spaceTemp');
    var usedText = '-';
    if (used !== null) usedText = fmtSize(used);
    else if (permanent !== null && permanent > 0) usedText = fmtSize(Math.max(0, permanent - (temp || 0)));

    var dTraffic = numVal(u, 'directLinkTraffic', 'DirectLinkTraffic', 'directTraffic', 'DirectTraffic',
      'directLinkFlow', 'straightChainTraffic', 'direct_link_traffic', 'linkTraffic', 'LinkTraffic');
    var sTraffic = numVal(u, 'shareTraffic', 'ShareTraffic', 'shareFlow', 'ShareFlow', 'shareTrafficUsed',
      'share_flow', 'shareLinkTraffic', 'share_link_traffic', 'ShareLinkTraffic');

    var rows = [
      ['UID', uid === null || uid === '' ? '-' : String(uid), false],
      ['昵称', nick ? String(nick) : '-', false],
      ['邮箱', mail ? String(mail) : '-', false],
      ['账号', acct ? String(acct) : '-', false],
      ['VIP等级', vipText, vinfo.isVip],
      ['VIP到期', fmtDate(vipExpireRaw), vinfo.isVip],
      ['VIP时长', vipDuration === null ? '-' : (vipDuration + '天'), vinfo.isVip],
      ['实名认证', realText, false],
      ['微信绑定', wxText, false],
      ['文件总数', fileCount === null ? '-' : (fileCount + ' 个'), false],
      ['已用空间', usedText, false],
      ['直链流量', dTraffic === null ? '-' : fmtSize(dTraffic), false],
      ['分享流量', sTraffic === null ? '-' : fmtSize(sTraffic), false]
    ];
    var html = '';
    rows.forEach(function (r) {
      html += '<div class="pf-row"><span class="pf-k">' + esc(r[0]) + '</span>'
        + '<span class="pf-v' + (r[2] ? ' pf-vip' : '') + '">' + esc(r[1]) + '</span></div>';
    });
    box.innerHTML = html;
  }

  // ---------- 主题模式：行显示 + 选择弹窗 ----------
  function renderThemeRow() {
    var el = $('mine-theme-val');
    if (el) el.textContent = themePrefLabel();
  }
  function renderThemeOpts() {
    var box = $('theme-opts');
    if (!box) return;
    var cur = themePref();
    box.querySelectorAll('.theme-opt').forEach(function (o) {
      o.classList.toggle('active', o.getAttribute('data-theme-mode') === cur);
      var ck = o.querySelector('.theme-ck');
      if (ck) applySvg(ck, 'check');
    });
  }
  function openThemeModal() {
    closeAllOverlays();   // 打开前先关掉其它弹窗，避免重叠
    renderThemeOpts();
    show($('theme-modal'));
  }
  function setThemePref(v) {
    if (v !== 'light' && v !== 'dark') v = 'system';
    try { localStorage.setItem(THEME_KEY, v); } catch (e) {}
    applyTheme();        // 立即换主题
    renderThemeRow();
    renderThemeOpts();
  }

  // ---------- 直链解析：分享链接 / 分享码 → 下载直链 ----------
  var dlinkState = { key: '', pwd: '', stack: [], list: [] };
  function openDlinkPage() {
    closeAllOverlays();
    dlinkState = { key: '', pwd: '', stack: [], list: [] };
    var l = $('dlink-link'); if (l) l.value = '';
    var p = $('dlink-pwd'); if (p) p.value = '';
    var box = $('dlink-list');
    if (box) box.innerHTML = '<div class="p-empty">粘贴分享链接后点「解析直链」</div>';
    var tip = $('dlink-tip');
    if (tip) tip.textContent = '解析后可复制或直接下载。支持文件夹逐层进入，也可一次复制本目录全部直链。';
    show($('page-dlink'));
  }
  function closeDlinkPage() { hide($('page-dlink')); clearCoverInputs('page-dlink'); }
  function doDlinkParse() {
    var parsed = parseDeepLink($('dlink-link') ? $('dlink-link').value : '');
    if (!parsed || !parsed.key) { toast('请输入有效的分享链接或分享码'); return; }
    dlinkState.key = parsed.key;
    var manual = $('dlink-pwd') ? String($('dlink-pwd').value || '').trim() : '';
    dlinkState.pwd = manual || parsed.pwd || '';
    dlinkState.stack = [];
    loadDlinkDir('0');
  }
  function loadDlinkDir(parentId) {
    var box = $('dlink-list');
    if (box) box.innerHTML = '<div class="loading-dot">解析中...</div>';
    // 同 loadShareDir：ShareKey 已含提取码时不再单传 SharePwd（避免 5 位提取码被 4 位校验拒掉）
    function attempt(withPwd) {
      var q = '/b/api/share/get?ShareKey=' + encodeURIComponent(dlinkState.key)
        + '&parentFileId=' + encodeURIComponent(parentId)
        + '&Page=1&limit=200&next=0&orderBy=file_name&orderDirection=asc&event=homeListFile';
      if (withPwd && dlinkState.pwd) q += '&SharePwd=' + encodeURIComponent(dlinkState.pwd);
      shareApi('GET', q, '', true, function (d) {
        if (d && d.code === 0 && d.data) {
          dlinkState.list = d.data.InfoList || [];
          renderDlinkList();
        } else if (!withPwd && dlinkState.pwd) {
          attempt(true);
        } else {
          if (box) box.innerHTML = '<div class="p-empty">解析失败：' + esc((d && d.message) || '分享不存在、已失效或提取码错误') + '</div>';
        }
      });
    }
    attempt(dlinkState.key.indexOf('-') < 0 && !!dlinkState.pwd);
  }
  function dlinkBack() {
    if (!dlinkState.stack.length) return;
    dlinkState.stack.pop();
    loadDlinkDir(dlinkState.stack.length ? dlinkState.stack[dlinkState.stack.length - 1].id : '0');
  }
  // 单个文件的下载直链（官方分享页同款接口）
  function dlinkDownloadUrl(it, cb) {
    var direct = it.DownloadUrl || it.downloadUrl || it.Url || it.url;
    if (direct) { cb(direct, ''); return; }
    var s3 = it.S3KeyFlag || it.S3keyFlag || it.S3keyflag || it.s3keyFlag || it.s3KeyFlag || '';
    var etag = it.Etag || it.etag || '';
    if (!s3 || !etag) { cb('', '缺少下载参数（S3keyFlag / Etag），请重新解析'); return; }
    var body = JSON.stringify({
      ShareKey: dlinkState.key,
      FileID: Number(it.FileId || it.fileId) || 0,
      S3keyFlag: s3,
      Size: Number(it.Size || it.size || 0),
      Etag: etag
    });
    shareApi('POST', '/api/v2/share/download/info', body, true, function (d) {
      if (!d || d.code !== 0) {
        cb('', (d && (d.message || d.error)) || ('下载接口返回 code=' + (d && d.code)));
        return;
      }
      var data = d.data || {};
      var prefix = (data.dispatchList && data.dispatchList[0] && data.dispatchList[0].prefix) || '';
      var dpath = data.downloadPath || data.DownloadPath || '';
      var url = data.DownloadUrl || data.downloadUrl || data.url || (prefix && dpath ? (prefix + dpath) : dpath);
      if (!url) { cb('', '接口未返回下载地址'); return; }
      cb(url, '');
    });
  }
  function renderDlinkList() {
    var box = $('dlink-list');
    if (!box) return;
    var list = dlinkState.list || [];
    var top = '';
    if (dlinkState.stack.length) {
      var parentName = dlinkState.stack.length > 1 ? dlinkState.stack[dlinkState.stack.length - 2].name : '分享根目录';
      top = '<div class="dl-bulk"><button class="dl-btn" data-dlback="1">‹ 返回 ' + esc(parentName)
        + '</button><button class="dl-btn" data-dlall="1">复制本目录全部直链</button></div>';
    } else if (list.length) {
      top = '<div class="dl-bulk"><button class="dl-btn" data-dlall="1">复制本目录全部直链</button></div>';
    }
    if (!list.length) {
      box.innerHTML = top + '<div class="p-empty">此目录为空</div>';
      return;
    }
    var html = top;
    list.forEach(function (it, i) {
      var isFolder = Number(it.Type) === 1;
      html += '<div class="dl-row">'
        + '<span class="dl-ic" data-icon="' + (isFolder ? 'foler' : iconForName(it.FileName)) + '"></span>'
        + '<div class="dl-info"><div class="dl-name">' + esc(it.FileName || '') + '</div>'
        + '<div class="dl-meta">' + (isFolder ? '文件夹' : fmtSize(it.Size)) + '</div></div>'
        + (isFolder
            ? '<span class="dl-enter" data-enter="' + i + '">›</span>'
            : '<div class="dl-btns"><button class="dl-btn" data-copy="' + i + '">复制直链</button>'
              + '<button class="dl-btn dl-open" data-dl="' + i + '">下载</button></div>')
        + '</div>';
    });
    box.innerHTML = html;
    injectIcons(box);
  }
  function copyAllDlink(btn) {
    var files = (dlinkState.list || []).filter(function (it) { return Number(it.Type) !== 1; });
    if (!files.length) { toast('本目录没有可解析的文件'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '解析中 0/' + files.length; }
    var out = [], left = files.length, done = 0;
    files.forEach(function (it) {
      dlinkDownloadUrl(it, function (url) {
        done++;
        if (btn) btn.textContent = '解析中 ' + done + '/' + files.length;
        if (url) out.push(url);
        if (--left === 0) {
          if (btn) { btn.disabled = false; btn.textContent = '复制本目录全部直链'; }
          if (!out.length) { toast('全部解析失败，可能是分享已失效'); return; }
          copyText(out.join('\n'), '已复制 ' + out.length + ' 条直链');
        }
      });
    });
  }
  function bindDlinkList() {
    var box = $('dlink-list');
    if (!box) return;
    box.onclick = function (e) {
      var t = e.target && e.target.closest
        ? e.target.closest('[data-dlback],[data-dlall],[data-enter],[data-copy],[data-dl]') : null;
      if (!t) return;
      if (t.hasAttribute('data-dlback')) { dlinkBack(); return; }
      if (t.hasAttribute('data-dlall')) { copyAllDlink(t); return; }
      if (t.hasAttribute('data-enter')) {
        var dir = dlinkState.list[Number(t.getAttribute('data-enter'))];
        if (!dir) return;
        dlinkState.stack.push({ id: dir.FileId || dir.fileId, name: dir.FileName || '' });
        loadDlinkDir(dir.FileId || dir.fileId);
        return;
      }
      if (t.hasAttribute('data-copy')) {
        var f1 = dlinkState.list[Number(t.getAttribute('data-copy'))];
        if (!f1) return;
        t.disabled = true; t.textContent = '解析中';
        dlinkDownloadUrl(f1, function (url, err) {
          t.disabled = false; t.textContent = '复制直链';
          if (url) copyText(url, '直链已复制');
          else toast(err || '解析直链失败');
        });
        return;
      }
      if (t.hasAttribute('data-dl')) {
        var f2 = dlinkState.list[Number(t.getAttribute('data-dl'))];
        if (!f2) return;
        if (!bridge || !bridge.downloadStream) { toast('当前版本不支持直接下载'); return; }
        t.disabled = true; t.textContent = '解析中';
        dlinkDownloadUrl(f2, function (url, err) {
          t.disabled = false; t.textContent = '下载';
          if (!url) { toast(err || '解析直链失败'); return; }
          var fname = f2.FileName || (Date.now() + '');
          var fsize = Number(f2.Size || 0);
          try {
            var genId = Number(bridge.downloadStream(url, fname, fsize));
            if (genId >= 0) {
              addTransfer({ id: genId, name: fname, size: fsize, total: fsize, status: 'downloading', stream: true });
              startProgressPolling();
              toast('已加入下载任务');
            } else { toast('下载失败'); }
          } catch (ex) { toast('下载失败'); }
        });
      }
    };
  }

  // ---------- 切换账号：跳转到登录页 ----------
  function switchToLogin() {
    $('login-pass').value = '';
    $('login-msg').textContent = '';
    var sp = $('sms-phone'); if (sp) sp.value = '';
    var sc = $('sms-code'); if (sc) sc.value = '';
    var sm = $('login-msg-sms'); if (sm) sm.textContent = '';
    if (_smsCountdown) { clearInterval(_smsCountdown); _smsCountdown = null; }
    var sb = $('sms-send-btn'); if (sb) { sb.disabled = false; sb.textContent = '获取验证码'; }
    switchLoginTab('pwd');
    show($('page-login'));
    hide($('page-main'));
  }

  // ---------- 底部工具栏控制 ----------
  var toolbar = document.getElementById('file-toolbar');

  function showToolbar() {
    if (!toolbar || toolbar.style.display === 'none') return;
    toolbar.classList.add('visible');
  }

  function hideToolbar() {
    if (!toolbar) return;
    toolbar.classList.remove('visible');
  }

  function updateToolbarVisibility(view) {
    if (!toolbar) return;
    if (view === 'files' && !state.searching && !state.selectMode) {
      toolbar.style.display = 'flex';
      hideToolbar();
    } else {
      toolbar.style.display = 'none';
      hideToolbar();
    }
  }

  // ---------- 底栏「主页」点击：显示/隐藏底部工具栏（整理·上传·新建·去重）----------
  // 规则：点主页=显示工具栏；显示后上滑隐藏、下滑显示；再点主页=完全关闭（此后滑动不再唤出）；
  //       再点主页=重新显示。已移除长按。
  var toolState = 'off';
  var _filesTabWasActive = false;

  function toolSet(show) {
    if (show) { toolState = 'on'; showToolbar(); }
    else { toolState = 'off'; hideToolbar(); }
  }
  function toolSwipe(show) {
    if (toolState !== 'on') return;
    if (state.view !== 'files') return;
    if (state.searching || state.selectMode) return;
    if (show) showToolbar(); else hideToolbar();
  }
  function toggleHomeToolbar() {
    if (toolState === 'on') { toolSet(false); return; }
    if (state.searching) exitSearch();
    if (state.selectMode) exitSelectMode();
    toolSet(true);
  }
  function initHomeTabToolbar() {
    var fileTab = document.querySelector('#tabbar .tab[data-view="files"]');
    if (!fileTab) return;
    fileTab.addEventListener('touchstart', function () { _filesTabWasActive = (state.view === 'files'); }, { passive: true });
    fileTab.addEventListener('mousedown', function () { _filesTabWasActive = (state.view === 'files'); });
  }
  function bindToolbarSwipe() {
    var sa = $('scroll-area');
    if (!sa || sa._tbBound) return;
    sa._tbBound = true;
    var sy = 0, dy = 0, tracking = false;
    sa.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) return;
      tracking = true; sy = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    sa.addEventListener('touchmove', function (e) {
      if (!tracking || !e.touches || !e.touches[0]) return;
      dy = e.touches[0].clientY - sy;
    }, { passive: true });
    sa.addEventListener('touchend', function () {
      if (!tracking) return;
      tracking = false;
      if (dy < -40) toolSwipe(false);       // 上滑隐藏
      else if (dy > 40) toolSwipe(true);    // 下滑显示
    }, { passive: true });
  }

  // ---------- 返回键 ----------
  window.__handleBack = function () {
    // 「添加账号」进入的登录页：返回 = 回到上一级（不退出 App）
    var _loginEl = $('page-login');
    if (_loginEl && !_loginEl.classList.contains('hidden') && pendingAddAccount) {
      pendingAddAccount = false;
      hide(_loginEl);
      show($('page-main'));
      switchView('mine');
      return true;
    }
    // ===== 第一步：任何弹窗/浮层都先关掉，再考虑页面返回 =====
    var overlayClosers = [
      ['clip-modal', function () { hideClipConfirm(); }],
      ['account-action', function () { hide($('account-action')); }],
      ['account-sheet', function () { hide($('account-sheet')); }],
      ['account-modal', function () { hide($('account-modal')); }],
      ['upload-modal', function () { hide($('upload-modal')); }],
      ['sort-pop', function () { hideSortPop(); }],
      ['sort-sheet', function () { hide($('sort-sheet')); }],
      ['share-config-modal', function () { hide($('share-config-modal')); }],
      ['share-modal', function () { hide($('share-modal')); }],
      ['move-picker', function () { closeMovePicker(); }],
      ['newfolder-modal', function () { hide($('newfolder-modal')); }],
      ['rename-modal', function () { hide($('rename-modal')); }],
      ['profile-modal', function () { hide($('profile-modal')); }],
      ['theme-modal', function () { hide($('theme-modal')); }],
      ['upload-sheet', function () { hide($('upload-sheet')); }],
      ['detail-modal', function () { hide($('detail-modal')); }],
      // 扫描中先停止扫描；已停止再按返回才关闭
      // 返回键：直接退出（同时终止扫描）
      ['dedupe-modal', function () {
        dedupeCancel = true; dedupePaused = false;
        hide($('dedupe-modal'));
      }],
      ['confirm-modal', function () { hide($('confirm-modal')); state.confirmOk = null; }],
      ['action-sheet', function () { hide($('action-sheet')); }]
    ];
    for (var _oi = 0; _oi < overlayClosers.length; _oi++) {
      var _el = $(overlayClosers[_oi][0]);
      if (_el && !_el.classList.contains('hidden')) { overlayClosers[_oi][1](); return true; }
    }
    // 底部悬浮工具栏（整理 / 上传 / 新建）也要先收起
    var _ft = $('file-toolbar');
    if (_ft && _ft.classList.contains('visible')) { toolSet(false); return true; }

    // ===== 第二步：覆盖式二级页 =====
    var pageDlinkEl = $('page-dlink');
    if (pageDlinkEl && !pageDlinkEl.classList.contains('hidden')) { closeDlinkPage(); return true; }
    var pageReceiveEl = $('page-receive');
    if (pageReceiveEl && !pageReceiveEl.classList.contains('hidden')) { closeReceivePage(); return true; }
    var pageRecycleEl = $('page-recycle');
    if (pageRecycleEl && !pageRecycleEl.classList.contains('hidden')) { hide(pageRecycleEl); return true; }
    var pageSharesEl = $('page-shares');
    if (pageSharesEl && !pageSharesEl.classList.contains('hidden')) { hide(pageSharesEl); return true; }

    // 检查文档预览（PDF / Word / Excel）
    var docOverlay = document.getElementById('doc-viewer-overlay');
    if (docOverlay) {
      // 云解压预览：在子文件夹里时返回=逐级回退；到顶层后返回才退出
      if (_docCtx && _docCtx.archStack && _docCtx.archStack.length > 0) {
        _docCtx.archStack.pop();
        try { renderArchCloud(_docCtx); } catch (e) {}
        return true;
      }
      closeDocViewer();
      return true;
    }

    // 检查文本查看器
    var textOverlay = document.getElementById('text-viewer-overlay');
    if (textOverlay) {
      closeTextViewer();
      return true;
    }
    
    // 检查视频播放
    var videoOverlay = document.getElementById('video-player-overlay');
    if (videoOverlay) {
      closeVideoPlayer();
      return true;
    }
    
    // 检查音频弹窗
    var audioOverlay = document.getElementById('audio-player-overlay');
    if (audioOverlay) {
      closeAudioDialog();
      return true;
    }
    
    // 检查图片预览
    var imageOverlay = document.getElementById('image-preview-overlay');
    if (imageOverlay) {
      closeImagePreview();
      return true;
    }
    
    // 如果处于搜索状态，退出搜索
    if (state.searching) {
      exitSearch();
      return true;
    }
    
    if (!$('confirm-modal').classList.contains('hidden')) { 
      hide($('confirm-modal')); 
      state.confirmOk = null; 
      return true; 
    }
    if (!$('move-picker').classList.contains('hidden')) { 
      hide($('move-picker')); 
      state.pickerState = null; 
      return true; 
    }
    if (!$('share-config-modal').classList.contains('hidden')) { 
      hide($('share-config-modal')); 
      return true; 
    }
    if (!$('newfolder-modal').classList.contains('hidden')) { 
      hide($('newfolder-modal')); 
      return true; 
    }
    if (!$('share-modal').classList.contains('hidden')) { 
      hide($('share-modal')); 
      return true; 
    }
    if (!$('rename-modal').classList.contains('hidden')) { 
      hide($('rename-modal')); 
      return true; 
    }
    if (!$('action-sheet').classList.contains('hidden')) { 
      hide($('action-sheet')); 
      return true; 
    }
    
    if (state.selectMode) {
      exitSelectMode();
      return true;
    }
    
    if (state.view === 'files') {
      if (state.currentDir === 0 && state.breadcrumb.length === 0) {
        if (bridge && bridge.exitApp) {
          bridge.exitApp();
        } else if (window.history && window.history.back) {
          window.history.back();
        }
        return true;
      }
      
      if (state.breadcrumb.length > 0) {
        var last = state.breadcrumb.pop();
        if (state.breadcrumb.length > 0) {
          var prev = state.breadcrumb[state.breadcrumb.length - 1];
          state.currentDir = prev.id;
        } else {
          state.currentDir = 0;
        }
        loadList();
        var scrollArea = $('scroll-area');
        if (scrollArea) scrollArea.scrollTop = 0;
        return true;
      } else {
        state.currentDir = 0;
        loadList();
        var scrollArea2 = $('scroll-area');
        if (scrollArea2) scrollArea2.scrollTop = 0;
        return true;
      }
    }
    
    if (bridge && bridge.exitApp) {
      bridge.exitApp();
    } else if (window.history && window.history.back) {
      window.history.back();
    }
    return true;
  };

  // ---------- 初始化 ----------
  function init() {
    try { extInit(); } catch (e) {}
    injectIcons();
    
    initFileTabDoubleClick();
    initToolbarLongPress();
    
    document.querySelectorAll('#tabbar .tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        // 底栏切换（主页 / 传输 / 我的）：处于搜索状态时先重置搜索框并关闭搜索，再切页（同时进行）
        if (state.searching) exitSearch();
        switchView(tab.getAttribute('data-view'));
      });
    });
    // ---------- 底栏滑动指示气泡：点击滑动 + 拖动跟手切换页面（对齐「9、15日123网盘完美ai改包」液态底栏实现） ----------
    (function bindTabIndicator() {
      var bar = $('tabbar');
      if (!bar) return;
      var tabs = [];
      document.querySelectorAll('#tabbar .tab').forEach(function (t) { tabs.push(t); });
      if (!tabs.length) return;
      var ind = document.createElement('div');
      ind.className = 'tab-indicator';
      bar.appendChild(ind);
      var cur = 0, dragging = false;

      function viewOf(i) { return tabs[i].getAttribute('data-view'); }
      // 气泡宽度 = 页签宽度的 4/5，并在页签内居中
      var TAB_PCT = 100 / tabs.length;
      var IND_PCT = TAB_PCT * 0.8;
      function place(i, animate) {
        i = Math.max(0, Math.min(tabs.length - 1, i));
        ind.style.transition = (animate === false) ? 'none' : '';
        ind.style.width = IND_PCT + '%';
        ind.style.left = (i * TAB_PCT + (TAB_PCT - IND_PCT) / 2) + '%';
        cur = i;
      }
      function nearest(clientX) {
        var r = bar.getBoundingClientRect();
        var i = Math.floor((clientX - r.left) / (r.width / tabs.length));
        return Math.max(0, Math.min(tabs.length - 1, i));
      }
      function highlight(i) {
        for (var k = 0; k < tabs.length; k++) tabs[k].style.transform = (k === i) ? 'scale(1.08)' : '';
      }
      function syncView(i) {
        var v = viewOf(i);
        if (v !== state.view) switchView(v);
      }
      var start = 0;
      tabs.forEach(function (t, k) { if (t.classList.contains('active')) start = k; });
      place(start, false);
      window.addEventListener('resize', function () { place(cur, false); });
      // 按下即切换：气泡位置与页面永远一致（不再依赖 click，避免点击被吞）
      bar.addEventListener('touchstart', function (e) {
        var t = e.touches && e.touches[0]; if (!t) return;
        dragging = true;
        var i = nearest(t.clientX);
        place(i, false); highlight(i);
        syncView(i);
      }, { passive: true });
      bar.addEventListener('touchmove', function (e) {
        if (!dragging) return;
        var t = e.touches && e.touches[0]; if (!t) return;
        var i = nearest(t.clientX);
        if (i !== cur) {
          place(i, false);            // 跟手无延迟
          highlight(i);
          syncView(i);                // 经过即切换
        }
      }, { passive: true });
      function endDrag() {
        if (!dragging) return;
        dragging = false;
        highlight(-1);
        place(cur, true);             // 恢复过渡动画
        syncView(cur);
      }
      bar.addEventListener('touchend', endDrag, { passive: true });
      bar.addEventListener('touchcancel', endDrag, { passive: true });
      // 点击标签：再次对齐气泡与页面（幂等，不会重复切）
      tabs.forEach(function (tab, i) {
        tab.addEventListener('click', function () {
          place(i);
          syncView(i);
        });
      });
    })();
    $('login-btn').addEventListener('click', doLogin);
    $('login-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    // 登录方式 Tab 切换 + 验证码登录
    document.querySelectorAll('#login-tabs .login-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { switchLoginTab(tab.getAttribute('data-login-tab')); });
    });
    var smsSendBtn = $('sms-send-btn');
    if (smsSendBtn) smsSendBtn.addEventListener('click', doGetSmsCode);
    var smsLoginBtn = $('sms-login-btn');
    if (smsLoginBtn) smsLoginBtn.addEventListener('click', doSmsLogin);
    var smsCodeInput = $('sms-code');
    if (smsCodeInput) smsCodeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSmsLogin(); });
    var smsGoOfficial = $('sms-go-official');
    if (smsGoOfficial) smsGoOfficial.style.display = 'none';   // 官方登录页兜底已移除，隐藏入口
    // 「添加账号」登录页：用系统返回键 / 手势返回（不要返回按钮）
    $('rename-ok').addEventListener('click', doRename);
    $('cf-ok').addEventListener('click', onCfOk);
    
    $('tool-newfolder').addEventListener('click', function () {
      $('newfolder-input').value = '';
      show($('newfolder-modal'));
      toolSet(false);
    });
    $('newfolder-ok').addEventListener('click', doNewFolder);
    $('newfolder-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') doNewFolder(); });
    
    $('tool-upload').addEventListener('click', function() {
      toolSet(false);
      var dir = Number(state.currentDir) || 0;
      // 原生 SAF 选择器：文件 / 文件夹 → 选完即退出 → 任务进入「传输页 → 上传」
      if (bridge && bridge.pickFilesForUpload && bridge.pickFolderForUpload) {
        showUploadChoice(dir);
        return;
      }
      doUpload();
    });
    
    var toolOrganize = $('tool-organize');
    if (toolOrganize) {
      toolOrganize.addEventListener('click', enterSelectMode);
    }
    
    $('select-cancel').addEventListener('click', exitSelectMode);
    $('select-move').addEventListener('click', openMovePicker);
    var selCopyBtn = $('select-copy');
    if (selCopyBtn) selCopyBtn.addEventListener('click', function () {
      openPickerFor('copy', selectedItemsArr());
    });
    var selDelBtn = $('select-delete');
    if (selDelBtn) selDelBtn.addEventListener('click', doDeleteSelected);
    
    $('picker-cancel').addEventListener('click', closeMovePicker);
    $('picker-confirm').addEventListener('click', confirmMove);
    // 点空白也要走 closeMovePicker（否则多选栏不会被恢复，和返回键行为不一致）
    var pickerMaskEl = $('picker-mask');
    if (pickerMaskEl) pickerMaskEl.addEventListener('click', closeMovePicker);
    
    $('upload-input').addEventListener('change', function () {
      var files = this.files;
      if (!files || !files.length) return;
      
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var fname = file.name;
        var fsize = file.size;
        
        if (bridge && (bridge.uploadFileTask || bridge.uploadFiles)) {
          // 1.7.3 适配：选择结果由原生 __onFilesPicked 通道统一入队（含真实本地路径），此处跳过避免重复/空路径任务
          continue;
        }
        
        if (hasUploadTask(fname)) {
          console.log('跳过重复上传任务:', fname);
          continue;
        }
        
        var taskId = 'upload_' + Date.now() + '_' + i;
        
        addUploadTask({
          id: taskId,
          name: fname,
          size: fsize,
          status: 'uploading',
          done: 0,
          total: fsize
        });
      }
      
      this.value = '';
      toolSet(false);
    });
    
    var searchInput = $('search-input');
    var searchClear = $('search-clear');
    if (searchInput) {
      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { 
          if (bridge && bridge.hideKeyboard) {
            bridge.hideKeyboard();
          }
          searchInput.blur();
          doSearch(searchInput.value); 
        }
      });
      searchInput.addEventListener('input', function () {
        if (searchClear) {
          if (searchInput.value.trim()) show(searchClear);
          else hide(searchClear);
        }
      });
    }
    if (searchClear) {
      searchClear.addEventListener('click', function () {
        exitSearch();
        if (searchInput) searchInput.focus();
      });
    }
    // 无输入时滑动：退出搜索焦点并收起键盘
    var _saSearch = $('scroll-area');
    if (_saSearch) {
      _saSearch.addEventListener('scroll', function () {
        var si = $('search-input');
        if (si && document.activeElement === si && !si.value.trim()) {
          si.blur();
          try { if (bridge && bridge.hideKeyboard) bridge.hideKeyboard(); } catch (e) {}
        }
      }, { passive: true });
    }
    
    $('share-copy').addEventListener('click', doCopyLink);
    $('sc-create').addEventListener('click', doCreateShare);
    document.querySelectorAll('input[name="sc-pwd"]').forEach(function (rd) {
      rd.addEventListener('change', function () {
        var showCustom = rd.value === '3';
        if (showCustom) show($('sc-custom'));
        else hide($('sc-custom'));
      });
    });
    
    var clearRecycleBtn = $('recycle-clear');
    if (clearRecycleBtn) clearRecycleBtn.addEventListener('click', recycleClearAll);
    
    // 退出当前账号按钮已从「我的」页移除

    // ---- 我的页（移植自 123.apk）：账号管理 / 我的分享 / 接收分享 / 下载目录 / 清除缓存 ----
    var accountAddBtn = $('account-add');
    if (accountAddBtn) accountAddBtn.addEventListener('click', openAddAccount);
    // 点击账号管理区域以外的任意位置 → 收回展开面板
    document.addEventListener('click', function (e) {
      var el = document.getElementById('acct-expand');
      if (!el || el.classList.contains('hidden')) return;
      var box = $('account-list');
      if (box && box.contains(e.target)) return;   // 面板本身在 #account-list 内
      toggleAcctExpand(false);
    });
    var mineSharesBtn = $('mine-shares');
    if (mineSharesBtn) mineSharesBtn.addEventListener('click', openMyShares);
    var mineReceiveBtn = $('mine-receive');
    if (mineReceiveBtn) mineReceiveBtn.addEventListener('click', openReceiveShare);
    // 直链解析（接收分享下方）
    var mineDlinkBtn = $('mine-dlink');
    if (mineDlinkBtn) mineDlinkBtn.addEventListener('click', openDlinkPage);
    // 主题模式：点行弹出选择
    var mineThemeBtn = $('mine-theme');
    if (mineThemeBtn) mineThemeBtn.addEventListener('click', openThemeModal);
    var themeOptsBox = $('theme-opts');
    if (themeOptsBox) themeOptsBox.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-theme-mode]') : null;
      if (!t) return;
      setThemePref(t.getAttribute('data-theme-mode'));
      hide($('theme-modal'));
    });
    // 直链解析页绑定
    var dlinkGoBtn = $('dlink-go');
    if (dlinkGoBtn) dlinkGoBtn.addEventListener('click', doDlinkParse);
    var dlinkBackBtn = $('dlink-back');
    if (dlinkBackBtn) dlinkBackBtn.addEventListener('click', closeDlinkPage);
    var dlinkLinkInput = $('dlink-link');
    if (dlinkLinkInput) dlinkLinkInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doDlinkParse(); }
    });
    bindDlinkList();
    renderThemeRow();
    // 上传方式选择
    var upOpts = $('upload-opts');
    if (upOpts) upOpts.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-up]') : null;
      if (!t) return;
      if (t.getAttribute('data-up') === 'folder') pickUploadFolder();
      else pickUploadFiles();
    });
    // 去重弹窗：可选删除 / 整理
    var dedupeOkBtn = $('dedupe-ok');
    if (dedupeOkBtn) dedupeOkBtn.addEventListener('click', dedupeDelete);
    var dedupeOrgBtn = $('dedupe-organize');
    if (dedupeOrgBtn) dedupeOrgBtn.addEventListener('click', dedupeOrganize);
    bindDedupeList();
    // 底部工具栏「去重」：递归扫描当前路径
    var toolDedupe = $('tool-dedupe');
    if (toolDedupe) toolDedupe.addEventListener('click', function () {
      toolSet(false);
      dedupeStart(null);
    });
    var mineDirBtn = $('mine-download-dir');
    if (mineDirBtn) mineDirBtn.addEventListener('click', onChangeDownloadDir);
    var mineCacheBtn = $('mine-clear-cache');
    if (mineCacheBtn) mineCacheBtn.addEventListener('click', function () {
      showConfirm('确认清除缓存？（不会删除网盘文件）', clearCache);
    });
    var sharesBackBtn = $('shares-back');
    if (sharesBackBtn) sharesBackBtn.addEventListener('click', function () { hide($('page-shares')); });
    var receiveBackBtn = $('receive-back');
    if (receiveBackBtn) receiveBackBtn.addEventListener('click', closeReceivePage);
    var receiveOpenBtn = $('receive-open');
    if (receiveOpenBtn) receiveOpenBtn.addEventListener('click', doOpenReceiveShare);
    // 转存：先弹「选择保存位置」（复用整理页的文件夹选择器）
    var receiveSaveBtn = $('receive-save');
    if (receiveSaveBtn) receiveSaveBtn.addEventListener('click', openTransferPicker);
    // 下载：勾选后直接下载
    var receiveDlBtn = $('receive-download');
    if (receiveDlBtn) receiveDlBtn.addEventListener('click', doDownloadSelectedShare);
    // 回收站（从底栏移入「我的」）：覆盖式二级页
    var mineRecycleBtn = $('mine-recycle');
    if (mineRecycleBtn) mineRecycleBtn.addEventListener('click', function () {
      closeAllOverlays();   // 进二级页前先关掉所有弹窗，避免重叠
      show($('page-recycle'));
      loadRecycle();
    });
    var recycleBackBtn = $('recycle-back');
    if (recycleBackBtn) recycleBackBtn.addEventListener('click', function () { hide($('page-recycle')); });

    // ---- 剪贴板分享链接确认条：取消 / 确认 ----
    var clipOkBtn = $('clip-ok');
    if (clipOkBtn) clipOkBtn.addEventListener('click', confirmClipText);
    var clipCancelBtn = $('clip-cancel');
    if (clipCancelBtn) clipCancelBtn.addEventListener('click', hideClipConfirm);
    var clipMaskEl = $('clip-mask');
    if (clipMaskEl) clipMaskEl.addEventListener('click', hideClipConfirm);

    // ---- 传输页：左右滑动切换子页签 ----
    bindTransferSwipe();

    // ---- 顶栏搜索框尾部的搜索图标 ----
    var searchGoBtn = $('search-go');
    if (searchGoBtn) searchGoBtn.addEventListener('click', function () {
      var si = $('search-input');
      doSearch(si ? si.value : '');
    });

    // ---- 排序：路径栏右侧按钮 + 锚定卡片 ----
    var sortBtn = $('sort-btn');
    if (sortBtn) sortBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSortPop(sortBtn, false);   // 主页上下文
    });
    var sortMask = $('sort-mask');
    if (sortMask) sortMask.addEventListener('click', hideSortPop);
    var sortFields = $('sort-fields');
    if (sortFields) sortFields.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-by]') : null;
      if (t) applySort(t.getAttribute('data-by'), '');
    });
    var sortDirBox = $('sort-dir');
    if (sortDirBox) sortDirBox.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-dir]') : null;
      if (t) applySort('', t.getAttribute('data-dir'));
    });
    var sortViewBox = $('sort-view');
    if (sortViewBox) sortViewBox.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
      if (t) applySort('', '', t.getAttribute('data-view'));
    });
    // 全选
    var selectAllBtn = $('select-all');
    if (selectAllBtn) selectAllBtn.addEventListener('click', selectAllItems);
    var selectDlBtn = $('select-download');
    if (selectDlBtn) selectDlBtn.addEventListener('click', doDownloadSelectedFiles);

    // ---- 传输页（移植自 123.apk）：离线下载 ----
    var offlineGoBtn = $('offline-go');
    if (offlineGoBtn) offlineGoBtn.addEventListener('click', doOfflineDownload);
    var _offIn = $('offline-url');
    if (_offIn) _offIn.addEventListener('click', function () { if (String(_offIn.value || '')) _offIn.value = ''; });
    ['receive-link', 'receive-pwd', 'dl-link', 'dl-pwd'].forEach(function (_id) {
      var _el = $(_id);
      if (!_el) return;
      var _lp = null;
      var _lpClear = function () { if (String(_el.value || '')) _el.value = ''; };
      _el.addEventListener('touchstart', function () { _lp = setTimeout(_lpClear, 420); }, { passive: true });
      _el.addEventListener('touchend', function () { if (_lp) { clearTimeout(_lp); _lp = null; } });
      _el.addEventListener('touchmove', function () { if (_lp) { clearTimeout(_lp); _lp = null; } });
    });
    
    document.querySelectorAll('.transfer-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var tabName = this.getAttribute('data-tab');
        switchTransferTab(tabName);
      });
    });
    
    document.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () {
        el.closest && el.closest('.sheet') && hide(el.closest('.sheet'));
        el.closest && el.closest('.modal') && hide(el.closest('.modal'));
      });
    });
    document.querySelectorAll('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () {
        try {
          var host = el.closest ? el.closest('.modal, .sheet, .page-cover') : null;
          if (host) clearCoverInputs(host);
        } catch (e) {}
      });
    });
    
    var pathDisplay = $('path-display');
    if (pathDisplay) {
      pathDisplay.textContent = '全部文件';
    }
    
    state.transfers = loadTransfers();
    
    var t = loadToken();
    if (t) {
      state.token = t;
      enterMain();
    } else {
      show($('page-login'));
      hide($('page-main'));
    }
  }


  // ==================== 扩展功能：消息中心 / 保险箱 / 会员中心 / 设备管理 ====================
  var EXT_API = 'https://api.123pan.cn';
  state.noticeUnread = state.noticeUnread || 0;

  // ---- 扩展功能诊断：记录原始响应，写入 Download/123云盘/pan_ext_debug.json（便于排查）----
  var extDebug = [];
  var _dbgTimer = null;
  function extDbgFlushNow() {
    try {
      _dbgTimer = null;
      if (!(bridge && bridge.saveBytesToDownload)) return;
      var payload = {
        at: new Date().toISOString(),
        ver: (bridge && bridge.getVersion) ? bridge.getVersion() : '',
        items: extDebug
      };
      var json = JSON.stringify(payload);
      var bin = unescape(encodeURIComponent(json));
      bridge.saveBytesToDownload(btoa(bin), 'pan_ext_ui.json');
    } catch (e) {}
  }
  function extDbgPush(obj) {
    try {
      extDebug.push(obj);
      if (extDebug.length > 80) extDebug.shift();
      if (!_dbgTimer) {
        _dbgTimer = setTimeout(extDbgFlushNow, 400);
      }
      try { if (bridge && bridge.appendDebugLog) bridge.appendDebugLog(String(obj && obj.u || ''), String(obj && obj.req || ''), String(obj && obj.raw || '')); } catch (e2) {}
    } catch (e) {}
  }
  try { window.addEventListener('pagehide', extDbgFlushNow); } catch (e) {}

  // 依次尝试多个候选请求，直到服务端返回成功（code===0 / ok===true）；每次尝试记录原始响应供诊断
  function extApiTry(cands, cb) {
    var i = 0, lastMsg = '';
    (function next() {
      if (i >= cands.length) { cb(null, lastMsg); return; }
      var c = cands[i++];
      api(c.method || 'GET', c.url, c.body || '', true, function (d) {
        var ok = d && (d.code === 0 || d.Code === 0 || d.ok === true);
        try { extDbgPush({ u: (c.method || 'GET') + ' ' + String(c.url).slice(0, 170), ok: !!ok, raw: d ? JSON.stringify(d).slice(0, 900) : '(null)', req: (c.body || '') }); } catch (e) {}
        if (ok) { cb(d, ''); return; }
        var m = d && (d.message || d.Message || d.error || d.Error);
        if (m) lastMsg = String(m);
        next();
      });
    })();
  }
  // 多候选请求：收集所有失败原因（用于精准定位缺失字段）
  function extTryMulti(cands, cb) {
    var i = 0, msgs = [];
    (function next() {
      if (i >= cands.length) { cb(null, msgs); return; }
      var c = cands[i++];
      api(c.method || 'POST', c.url, c.body || '', true, function (d) {
        var ok = d && (d.code === 0 || d.Code === 0 || d.ok === true);
        try { extDbgPush({ u: (c.method || 'POST') + ' ' + String(c.url).slice(0, 170), ok: !!ok, raw: d ? JSON.stringify(d).slice(0, 900) : '(null)', req: (c.body || '') }); } catch (e) {}
        if (ok) { cb(d, msgs); return; }
        var m = d && (d.message || d.Message || d.error || d.Error);
        if (m) msgs.push(String(m));
        next();
      });
    })();
  }
  // 从任意响应结构中提取数组
  function extPickList(d) {
    if (!d) return null;
    var data = (d.data !== undefined) ? d.data : (d.Data !== undefined ? d.Data : d);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      var keys = ['list', 'List', 'notice_list', 'noticeList', 'NoticeList', 'announcementList', 'AnnouncementList',
        'rows', 'Rows', 'items', 'Items', 'records', 'Records', 'InfoList', 'infoList', 'dataList', 'DataList',
        'DeviceS', 'deviceList', 'DeviceList', 'MList', 'history', 'HistoryList', 'useHistoryList'];
      for (var i = 0; i < keys.length; i++) if (Array.isArray(data[keys[i]])) return data[keys[i]];
      for (var j = 0; j < keys.length; j++) {
        var v = data[keys[j]];
        if (v && typeof v === 'object') {
          for (var k = 0; k < keys.length; k++) if (Array.isArray(v[keys[k]])) return v[keys[k]];
        }
      }
      // 深度兜底：4 层内找第一个「对象数组」（兼容未预料到的响应结构）
      var found = null;
      (function walk(o, depth) {
        if (found || !o || depth > 4 || typeof o !== 'object') return;
        if (Array.isArray(o)) {
          if (o.length > 0 && o[0] !== null && typeof o[0] === 'object') found = o;
          return;
        }
        var ks = Object.keys(o);
        for (var i2 = 0; i2 < ks.length && !found; i2++) walk(o[ks[i2]], depth + 1);
      })(data, 0);
      if (found) return found;
    }
    return null;
  }
  function openExtUrl(u) {
    if (!u) return;
    try { if (bridge && bridge.openBrowser) { bridge.openBrowser(String(u)); return; } } catch (e) {}
    toast('无法打开链接（缺少浏览器桥）');
  }
  // 动态详情浮层
  function showExtOverlay(id, title, bodyHtml) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    var ov = document.createElement('div');
    ov.id = id;
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:transparent;z-index:10050;display:flex;align-items:center;justify-content:center;padding:18px;';
    var panel = document.createElement('div');
    panel.style.cssText = 'background:var(--surface);border-radius:14px;width:86%;max-width:340px;max-height:80%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
    var head = document.createElement('div');
    head.style.cssText = 'padding:12px 14px;border-bottom:1px solid rgba(127,127,127,0.15);font-weight:600;font-size:15px;color:var(--text);display:flex;justify-content:space-between;align-items:center;gap:10px;';
    var t = document.createElement('span'); t.textContent = title || '消息'; t.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var x = document.createElement('span'); x.textContent = '✕'; x.style.cssText = 'cursor:pointer;color:#888;font-size:16px;padding:2px 6px;flex-shrink:0;';
    x.addEventListener('click', function () { try { document.body.removeChild(ov); } catch (e) {} });
    head.appendChild(t); head.appendChild(x);
    var body = document.createElement('div');
    body.style.cssText = 'padding:14px;overflow:auto;font-size:14px;line-height:1.7;color:var(--text);word-break:break-word;';
    body.innerHTML = bodyHtml || '';
    panel.appendChild(head); panel.appendChild(body); ov.appendChild(panel);
    ov.addEventListener('click', function (e) { if (e.target === ov) { try { document.body.removeChild(ov); } catch (err) {} } });
    document.body.appendChild(ov);
  }

  // ==================== 消息中心 ====================
  function noticeTitle(it) { return String(valOf(it, 'title', 'Title', 'noticeTitle', 'NoticeTitle', 'announcementTitle', 'AnnouncementTitle', 'name', 'Name') || '通知'); }
  function noticeTime(it) { var t = valOf(it, 'createAt', 'CreateAt', 'createTime', 'CreateTime', 'createdAt', 'CreatedAt', 'publishTime', 'PublishTime', 'time', 'Time', 'updateTime', 'UpdateTime'); return t == null ? '' : fmtDate(t); }
  function noticeReadSet() {
    try { var raw = localStorage.getItem('pan_notice_read'); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
  }
  function noticeMarkLocal(id) {
    try { var m = noticeReadSet(); m[String(id)] = 1; localStorage.setItem('pan_notice_read', JSON.stringify(m)); } catch (e) {}
  }
  function noticeIsRead(it) {
    var id = valOf(it, 'id', 'Id', 'ID', 'noticeId', 'NoticeId');
    if (id != null && noticeReadSet()[String(id)]) return true;
    var r = valOf(it, 'isRead', 'IsRead', 'read', 'Read');
    if (r !== null && r !== undefined) { if (r === true) return true; if (r === false) return false; if (/^(1|true|yes|已读)$/i.test(String(r))) return true; if (/^(0|false|no|未读)$/i.test(String(r))) return false; }
    var s = valOf(it, 'status', 'Status');
    if (s !== null && s !== undefined) return Number(s) !== 1;   // 服务端 status:1 = 未读（最新一条为 1，历史为 0）
    return true;
  }
  function refreshNoticeBadge() {
    api('GET', EXT_API + '/api/notice?page=1&limit=50', '', true, function (d) {
      var ok = d && d.code === 0;
      try { extDbgPush({ u: 'GET /api/notice (badge)', ok: !!ok, raw: d ? JSON.stringify(d).slice(0, 300) : '' }); } catch (e) {}
      if (!ok) return;
      var arr = extPickList(d) || [];
      var n = 0, ids = [];
      arr.forEach(function (x) {
        var id = valOf(x, 'id', 'Id', 'ID', 'noticeId', 'NoticeId');
        if (id != null) ids.push(id);
        if (!noticeIsRead(x)) n++;
      });
      state.noticeIds = ids;
      state.noticeUnread = n;
      updateNoticeBadge();
    });
  }
  function updateNoticeBadge() {
    var n = Number(state.noticeUnread || 0);
    ['mine-notice-badge', 'top-msg-badge'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (n > 0) { el.textContent = n > 99 ? '99+' : String(n); el.style.display = ''; }
      else el.style.display = 'none';
    });
  }
  function updateMineVipRow() {
    var el = $('mine-vip-val'); if (!el) return;
    var p = state.profile || {};
    el.textContent = state.token ? (p.isVip ? '会员' : '普通用户') : '-';
  }
  function loadNotices() {
    var box = $('notice-list'); if (!box) return;
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    hide($('notice-empty'));
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/notice?page=1&limit=30' },
      { method: 'GET', url: EXT_API + '/api/notice?page=1&limit=30&type=0&status=0' },
      { method: 'GET', url: EXT_API + '/api/announcement/list?page=1&limit=30' }
    ], function (d, err) {
      var arr = extPickList(d);
      if (!arr) {
        box.innerHTML = '';
        show($('notice-empty'));
        var em = $('notice-empty');
        if (em) { var p = em.querySelector('p'); if (p) p.textContent = err ? ('消息中心暂不可用：' + String(err).slice(0, 60)) : '暂无消息'; }
        return;
      }
      state.noticeCache = arr;
      renderNotices(arr);
      var un = 0;
      arr.forEach(function (x) { if (!noticeIsRead(x)) un++; });
      state.noticeUnread = un;
      updateNoticeBadge();
    });
  }
  function renderNotices(arr) {
    var box = $('notice-list'); if (!box) return;
    box.innerHTML = '';
    if (!arr.length) { show($('notice-empty')); return; }
    hide($('notice-empty'));
    var AV = '<img src="data:image/svg+xml;utf8,%3Csvg%20width%3D%2240%22%20height%3D%2240%22%20viewBox%3D%220%200%2040%2040%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%3Cdefs%3E%0A%3Cfilter%20id%3D%22filter0_i_795_12806%22%20x%3D%220%22%20y%3D%220%22%20width%3D%2240%22%20height%3D%2240%22%20filterUnits%3D%22userSpaceOnUse%22%20color-interpolation-filters%3D%22sRGB%22%3E%0A%3CfeFlood%20flood-opacity%3D%220%22%20result%3D%22BackgroundImageFix%22%2F%3E%0A%3CfeBlend%20mode%3D%22normal%22%20in%3D%22SourceGraphic%22%20in2%3D%22BackgroundImageFix%22%20result%3D%22shape%22%2F%3E%0A%3CfeColorMatrix%20in%3D%22SourceAlpha%22%20type%3D%22matrix%22%20values%3D%220%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%20127%200%22%20result%3D%22hardAlpha%22%2F%3E%0A%3CfeOffset%2F%3E%0A%3CfeGaussianBlur%20stdDeviation%3D%221.81818%22%2F%3E%0A%3CfeComposite%20in2%3D%22hardAlpha%22%20operator%3D%22arithmetic%22%20k2%3D%22-1%22%20k3%3D%221%22%2F%3E%0A%3CfeColorMatrix%20type%3D%22matrix%22%20values%3D%220%200%200%200%201%200%200%200%200%201%200%200%200%200%201%200%200%200%200.32%200%22%2F%3E%0A%3CfeBlend%20mode%3D%22normal%22%20in2%3D%22shape%22%20result%3D%22effect1_innerShadow_795_12806%22%2F%3E%0A%3C%2Ffilter%3E%0A%3ClinearGradient%20id%3D%22paint0_linear_795_12806%22%20x1%3D%2220%22%20y1%3D%2220%22%20x2%3D%2240%22%20y2%3D%2240%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20stop-color%3D%22white%22%20stop-opacity%3D%220%22%2F%3E%0A%3Cstop%20offset%3D%221%22%20stop-color%3D%22white%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22paint1_linear_795_12806%22%20x1%3D%2219.0908%22%20y1%3D%2210.9089%22%20x2%3D%2219.0908%22%20y2%3D%2227.2726%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20stop-color%3D%22white%22%2F%3E%0A%3Cstop%20offset%3D%221%22%20stop-color%3D%22white%22%20stop-opacity%3D%220%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22paint2_linear_795_12806%22%20x1%3D%2222.7272%22%20y1%3D%2215.4543%22%20x2%3D%2222.7272%22%20y2%3D%2229.0907%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20stop-color%3D%22white%22%20stop-opacity%3D%220%22%2F%3E%0A%3Cstop%20offset%3D%221%22%20stop-color%3D%22white%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22paint3_linear_795_12806%22%20x1%3D%2222.7272%22%20y1%3D%2215.4543%22%20x2%3D%2222.7272%22%20y2%3D%2229.0907%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20stop-color%3D%22white%22%20stop-opacity%3D%220%22%2F%3E%0A%3Cstop%20offset%3D%221%22%20stop-color%3D%22white%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22paint4_linear_795_12806%22%20x1%3D%2222.7272%22%20y1%3D%2215.4543%22%20x2%3D%2222.7272%22%20y2%3D%2229.0907%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20stop-color%3D%22white%22%20stop-opacity%3D%220%22%2F%3E%0A%3Cstop%20offset%3D%221%22%20stop-color%3D%22white%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22paint5_linear_795_12806%22%20x1%3D%2222.7272%22%20y1%3D%2215.4543%22%20x2%3D%2222.7272%22%20y2%3D%2229.0907%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%0A%3Cstop%20stop-color%3D%22white%22%20stop-opacity%3D%220%22%2F%3E%0A%3Cstop%20offset%3D%221%22%20stop-color%3D%22white%22%2F%3E%0A%3C%2FlinearGradient%3E%0A%3C%2Fdefs%3E%0A%3Cg%20filter%3D%22url%28%23filter0_i_795_12806%29%22%3E%0A%3Ccircle%20cx%3D%2220%22%20cy%3D%2220%22%20r%3D%2220%22%20fill%3D%22%23A7A9B8%22%2F%3E%0A%3Ccircle%20cx%3D%2220%22%20cy%3D%2220%22%20r%3D%2220%22%20fill%3D%22url%28%23paint0_linear_795_12806%29%22%20fill-opacity%3D%220.4%22%2F%3E%0A%3C%2Fg%3E%0A%3Cpath%20d%3D%22M11.8181%2012.7271C11.8181%2011.723%2012.6321%2010.9089%2013.6363%2010.9089H24.5454C25.5495%2010.9089%2026.3636%2011.723%2026.3636%2012.7271V25.4544C26.3636%2026.4585%2025.5495%2027.2726%2024.5454%2027.2726H13.6363C12.6321%2027.2726%2011.8181%2026.4585%2011.8181%2025.4544V12.7271Z%22%20fill%3D%22url%28%23paint1_linear_795_12806%29%22%20fill-opacity%3D%220.48%22%2F%3E%0A%3Cpath%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20d%3D%22M13.6362%2013.6364C13.6362%2013.1343%2014.0432%2012.7273%2014.5453%2012.7273H17.2726C17.7747%2012.7273%2018.1817%2013.1343%2018.1817%2013.6364C18.1817%2014.1385%2017.7747%2014.5455%2017.2726%2014.5455H14.5453C14.0432%2014.5455%2013.6362%2014.1385%2013.6362%2013.6364Z%22%20fill%3D%22white%22%2F%3E%0A%3Cpath%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20d%3D%22M13.6362%2016.818C13.6362%2016.3159%2014.0432%2015.9089%2014.5453%2015.9089H15.4544C15.9565%2015.9089%2016.3635%2016.3159%2016.3635%2016.818C16.3635%2017.3201%2015.9565%2017.7271%2015.4544%2017.7271H14.5453C14.0432%2017.7271%2013.6362%2017.3201%2013.6362%2016.818Z%22%20fill%3D%22white%22%2F%3E%0A%3Cpath%20d%3D%22M27.2726%2019.9998C27.2726%2022.5102%2025.2375%2024.5453%2022.7272%2024.5453C20.2168%2024.5453%2018.1817%2022.5102%2018.1817%2019.9998C18.1817%2017.4894%2020.2168%2015.4543%2022.7272%2015.4543C25.2375%2015.4543%2027.2726%2017.4894%2027.2726%2019.9998Z%22%20fill%3D%22white%22%2F%3E%0A%3Cpath%20d%3D%22M27.2726%2019.9998C27.2726%2022.5102%2025.2375%2024.5453%2022.7272%2024.5453C20.2168%2024.5453%2018.1817%2022.5102%2018.1817%2019.9998C18.1817%2017.4894%2020.2168%2015.4543%2022.7272%2015.4543C25.2375%2015.4543%2027.2726%2017.4894%2027.2726%2019.9998Z%22%20fill%3D%22url%28%23paint2_linear_795_12806%29%22%2F%3E%0A%3Cpath%20d%3D%22M16.3635%2025.9089C16.3635%2025.1558%2016.974%2024.5453%2017.7272%2024.5453H27.7272C28.4803%2024.5453%2029.0908%2025.1558%2029.0908%2025.9089C29.0908%2026.662%2028.4803%2027.2725%2027.7272%2027.2725H17.7272C16.974%2027.2725%2016.3635%2026.662%2016.3635%2025.9089Z%22%20fill%3D%22white%22%2F%3E%0A%3Cpath%20d%3D%22M16.3635%2025.9089C16.3635%2025.1558%2016.974%2024.5453%2017.7272%2024.5453H27.7272C28.4803%2024.5453%2029.0908%2025.1558%2029.0908%2025.9089C29.0908%2026.662%2028.4803%2027.2725%2027.7272%2027.2725H17.7272C16.974%2027.2725%2016.3635%2026.662%2016.3635%2025.9089Z%22%20fill%3D%22url%28%23paint3_linear_795_12806%29%22%2F%3E%0A%3Cpath%20d%3D%22M20.909%2022.7271H24.5453V26.3634H20.909V22.7271Z%22%20fill%3D%22white%22%2F%3E%0A%3Cpath%20d%3D%22M20.909%2022.7271H24.5453V26.3634H20.909V22.7271Z%22%20fill%3D%22url%28%23paint4_linear_795_12806%29%22%2F%3E%0A%3Cpath%20d%3D%22M17.2726%2028.6362C17.2726%2028.3851%2017.4761%2028.1816%2017.7272%2028.1816H27.7272C27.9782%2028.1816%2028.1817%2028.3851%2028.1817%2028.6362C28.1817%2028.8872%2027.9782%2029.0907%2027.7272%2029.0907H17.7272C17.4761%2029.0907%2017.2726%2028.8872%2017.2726%2028.6362Z%22%20fill%3D%22white%22%2F%3E%0A%3Cpath%20d%3D%22M17.2726%2028.6362C17.2726%2028.3851%2017.4761%2028.1816%2017.7272%2028.1816H27.7272C27.9782%2028.1816%2028.1817%2028.3851%2028.1817%2028.6362C28.1817%2028.8872%2027.9782%2029.0907%2027.7272%2029.0907H17.7272C17.4761%2029.0907%2017.2726%2028.8872%2017.2726%2028.6362Z%22%20fill%3D%22url%28%23paint5_linear_795_12806%29%22%2F%3E%0A%3C%2Fsvg%3E%0A" alt="" style="width:34px;height:34px;display:block;">';
    arr.forEach(function (it) {
      var read = noticeIsRead(it);
      var sub = valOf(it, 'note', 'Note', 'summary', 'Summary', 'description', 'Description', 'subTitle', 'SubTitle', 'content', 'Content');
      var card = document.createElement('div');
      card.style.cssText = 'display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(127,127,127,0.12);cursor:pointer;';
      var av = document.createElement('div');
      av.style.cssText = 'width:40px;height:40px;border-radius:10px;background:rgba(127,127,127,0.10);display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative;';
      av.innerHTML = AV;
      if (!read) {
        var ddot = document.createElement('span');
        ddot.style.cssText = 'position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:#E5484D;';
        av.appendChild(ddot);
      }
      var body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0;';
      var row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
      var t1 = document.createElement('span');
      t1.style.cssText = 'font-size:15px;font-weight:600;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      t1.textContent = noticeTitle(it);
      var t2 = document.createElement('span');
      t2.style.cssText = 'font-size:12px;color:var(--text-muted);flex-shrink:0;';
      t2.textContent = noticeTime(it) || '';
      row1.appendChild(t1); row1.appendChild(t2);
      body.appendChild(row1);
      if (sub) {
        var s1 = document.createElement('div');
        s1.style.cssText = 'font-size:13px;color:var(--text-muted);margin-top:6px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;';
        s1.textContent = String(sub);
        body.appendChild(s1);
      }
      card.appendChild(av); card.appendChild(body);
      card.addEventListener('click', function () {
        openNoticeDetail(it);
        setTimeout(function () { try { renderNotices(state.noticeCache || []); } catch (e) {} }, 1200);
      });
      box.appendChild(card);
    });
  }
  function markNoticeRead(it) {
    var wasUnread = !noticeIsRead(it);
    var id = valOf(it, 'id', 'Id', 'ID', 'noticeId', 'NoticeId', 'announcementId', 'AnnouncementId');
    if (id != null) {
      noticeMarkLocal(id);
      extApiTry([
        { method: 'PUT', url: 'https://api.123278.com/b/api/notice', body: JSON.stringify({ idList: [id], status: 1 }) },
        { method: 'PUT', url: 'https://api.123278.com/api/notice', body: JSON.stringify({ idList: [id], status: 1 }) },
        { method: 'POST', url: 'https://api.123278.com/b/api/notice', body: JSON.stringify({ id: id, status: 1 }) }
      ], function () { });
    }
    if (wasUnread && state.noticeUnread > 0) { state.noticeUnread--; updateNoticeBadge(); }
  }
  function openNoticeDetail(it) {
    var title = noticeTitle(it);
    var inline = valOf(it, 'note', 'Note', 'content', 'Content', 'noticeContent', 'NoticeContent', 'body', 'Body', 'text', 'Text', 'description', 'Description');
    markNoticeRead(it);
    function cleanBody(t) {
      return String(t || '').replace(/点击查看违规文件详情/g, '').replace(/点击查看详情/g, '').trim();
    }
    function showIt(content) {
      var c = cleanBody(content);
      if (!c) { toast('已读'); return; }
      var html = '<div style="white-space:pre-wrap;">' + esc(c) + '</div>';
      showExtOverlay('ext-notice-overlay', title, html);
    }
    if (inline) { showIt(inline); return; }
    var id = valOf(it, 'id', 'Id', 'ID', 'noticeId', 'NoticeId', 'announcementId', 'AnnouncementId');
    if (id == null) { showIt(''); return; }
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/notice/' + id },
      { method: 'GET', url: EXT_API + '/api/announcement/detail/' + id },
      { method: 'GET', url: EXT_API + '/api/notice/detail?noticeId=' + id }
    ], function (d) {
      if (!d) { showIt(''); return; }
      var data = (d.data !== undefined) ? d.data : d;
      var content = valOf(data, 'content', 'Content', 'noticeContent', 'NoticeContent', 'body', 'Body', 'text', 'Text', 'description', 'Description') || '';
      showIt(content);
    });
  }

  function extPreview(item) {
    var name = String((item && (item.FileName || item.fileName || item.name)) || '');
    var ext = extOf(name);
    if (EXT_IMAGE[ext]) { previewImage(item); return; }
    if (EXT_VIDEO[ext]) { previewVideo(item); return; }
    if (EXT_AUDIO[ext]) { previewAudio(item); return; }
    if (EXT_TEXT[ext]) { previewTextFile(item); return; }
    if (EXT_PDF[ext]) { previewPdf(item); return; }
    if (EXT_DOC[ext]) { previewDocx(item); return; }
    if (EXT_XLS[ext]) { previewXlsx(item); return; }
    if (ext === 'zip' || ext === 'apk' || ext === 'ipa' || ext === 'jar' || ext === 'rar' || ext === '7z') { previewArchive(item); return; }
    previewArchiveOther(item);
  }

  // ==================== 会员中心 ====================
  function renderVipPage() {
    var card = $('vip-card'); if (!card) return;
    card.innerHTML = '<div class="loading-dot">加载中...</div>';
    api('GET', API.userInfo, '', true, function (d) {
      var u = (d && (d.data || d.Data)) || {};
      if (u && u.user && typeof u.user === 'object') u = u.user;
      var vinfo = profileVipInfo(u);
      var nick = valOf(u, 'nickname', 'Nickname', 'nickName', 'NickName') || (state.profile && state.profile.nickname) || '-';
      var expRaw = valOf(u, 'vipExpire', 'VipExpire', 'vipExpireTime', 'VipExpireTime', 'vipEndTime', 'VipEndTime', 'expireTime', 'ExpireTime');
      if (expRaw === null) { var vo = u.vip || u.Vip || u.vipInfo || u.VipInfo || {}; expRaw = valOf(vo, 'expire', 'expireTime', 'endTime', 'EndTime', 'expiredAt'); }
      if (expRaw === null) { try { var _uvs2 = (u.UserVipDetail && u.UserVipDetail.UserVipDetailInfos) || []; if (_uvs2[0]) expRaw = _uvs2[0].EndTime || _uvs2[0].TimeDesc || null; } catch (e) {} }
      var used = numVal(u, 'SpaceUsed', 'UsedSize', 'usedSize', 'spaceUsed');
      var total = numVal(u, 'SpacePermanent', 'TotalSize', 'totalSize', 'spacePermanent');
      var expTxt = (expRaw == null) ? '-' : fmtDate(expRaw);
      var capTxt = (used != null && total != null && total > 0) ? (fmtSize(used) + ' / ' + fmtSize(total)) : (total != null ? fmtSize(total) : '-');
      var vipName = vinfo.isVip ? (vinfo.name || '会员') : '普通用户';
      card.innerHTML = '<div class="mine-card-box" style="margin:0;">'
        + '<div class="mine-row"><span class="mine-row-left">账号</span><span class="mine-row-right"><span class="mine-val">' + esc(nick) + '</span></span></div>'
        + '<div class="mine-row"><span class="mine-row-left">会员状态</span><span class="mine-row-right"><span class="mine-val">' + esc(vipName) + '</span></span></div>'
        + '<div class="mine-row"><span class="mine-row-left">到期时间</span><span class="mine-row-right"><span class="mine-val">' + esc(expTxt) + '</span></span></div>'
        + '<div class="mine-row"><span class="mine-row-left">已用容量</span><span class="mine-row-right"><span class="mine-val">' + esc(capTxt) + '</span></span></div>'
        + '</div>';
      updateMineVipRow();
    });
    loadVipBenefits();
  }
  function loadVipBenefits() {
    var box = $('vip-benefits'); if (!box) return;
    box.innerHTML = '';
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/vip/vip_list' },
      { method: 'GET', url: EXT_API + '/api/restful/goapi/v1/goods/vipList' },
      { method: 'GET', url: EXT_API + '/api/v2/goods/vipList' }
    ], function (d) {
      var arr = extPickList(d);
      if (!arr || !arr.length) return;
      box.innerHTML = '<div class="rc-tip" style="margin:10px 0 6px;">会员方案</div>';
      arr.slice(0, 8).forEach(function (it) {
        var name = valOf(it, 'ShowName', 'showName', 'name', 'Name', 'title', 'Title', 'goodsName', 'vipName') || '会员';
        var price = valOf(it, 'Price', 'price', 'amount', 'Amount', 'salePrice');
        var first = valOf(it, 'FirstPrice', 'cheapPrice', 'CheapPrice');
        var days = valOf(it, 'DurationDays', 'durationDays');
        var pTxt = '';
        if (price != null) {
          var pv = Number(price);
          if (!isNaN(pv)) { if (pv >= 1000 && pv % 100 === 0) pv = pv / 100; pTxt = '¥' + pv; }
        }
        if (first != null && Number(first) > 0 && Number(first) < Number(price)) pTxt += ' 首月¥' + Number(first);
        if (days != null && Number(days) > 0) pTxt += ' / ' + Number(days) + '天';
        var row = document.createElement('div');
        row.className = 'mine-row';
        row.innerHTML = '<span class="mine-row-left">' + esc(String(name)) + '</span><span class="mine-row-right"><span class="mine-val">' + esc(pTxt) + '</span></span>';
        box.appendChild(row);
      });
    });
  }
  function doCheckin() {
    extApiTry([
      { method: 'POST', url: EXT_API + '/api/user/sign', body: '{}' },
      { method: 'POST', url: EXT_API + '/api/restful/goapi/v1/user/sign', body: '{}' },
      { method: 'GET', url: EXT_API + '/api/user/sign/list' }
    ], function (d, err) {
      if (!d) { toast('签到：' + (err ? String(err).slice(0, 50) : '接口暂不可用，可在官方渠道签到')); return; }
      var gain = valOf(d.data || d.Data || {}, 'space', 'Space', 'gain', 'Gain', 'size', 'Size');
      toast('签到成功' + (gain ? ('：+' + fmtSize(Number(gain) || 0)) : ''));
      renderVipPage();
    });
  }

  // ==================== 设备管理 ====================
  function loadDevices() {
    var box = $('device-list'); if (!box) return;
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/user/device_list' },
      { method: 'GET', url: EXT_API + '/api/user/device_list?type=1' },
      { method: 'GET', url: EXT_API + '/api/user/web_device_list' },
      { method: 'GET', url: EXT_API + '/api/restful/goapi/v1/user/device/list' }
    ], function (d, err) {
      var arr = extPickList(d);
      if (!arr) { box.innerHTML = '<div class="panel-empty"><p>' + esc(err ? ('设备列表获取失败：' + String(err).slice(0, 50)) : '设备列表暂不可用') + '</p></div>'; return; }
      try { extDbgPush({ u: 'DEVICES render n=' + arr.length, ok: true, raw: '' }); } catch (e) {}
      box.innerHTML = '';
      if (!arr.length) { box.innerHTML = '<div class="panel-empty"><p>暂无设备</p></div>'; return; }
      try {
      arr.forEach(function (it) {
        var name = String(valOf(it, 'device_name', 'deviceName', 'devicename', 'name') || '未知设备');
        var dtype = valOf(it, 'device_type', 'deviceType', 'plat_form') || '';
        var ltype = valOf(it, 'login_type', 'loginType') || '';
        var t = valOf(it, 'last_login_time', 'lastLoginTime', 'loginTime') || '';
        var ip = valOf(it, 'ip', 'IP') || '-';
        var addr = valOf(it, 'login_address', 'loginAddress') || '-';
        var cur = valOf(it, 'cur_device', 'CurDevice', 'isCurrent');
        var isCur = (cur === true || Number(cur) === 1 || String(cur).toLowerCase() === 'true');
        var keyv = valOf(it, 'key', 'Key', 'deviceKey', 'id');
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--surface);border-radius:16px;padding:12px 14px;margin:0 0 12px;box-shadow:0 2px 8px rgba(0,0,0,0.04);';
        var tags = '';
        if (dtype) tags += '<span style="background:rgba(127,127,127,0.12);color:var(--text-muted);font-size:11px;padding:2px 8px;border-radius:6px;">' + esc(String(dtype)) + '</span>';
        if (ltype) tags += '<span style="background:rgba(127,127,127,0.12);color:var(--text-muted);font-size:11px;padding:2px 8px;border-radius:6px;margin-left:6px;">' + esc(String(ltype)) + '</span>';
        var act = isCur
          ? '<span style="background:rgba(127,127,127,0.12);color:var(--text-muted);font-size:12px;padding:5px 12px;border-radius:8px;flex-shrink:0;">当前设备</span>'
          : '<span class="vdev-kick" style="background:#eaf1ff;color:#2B6DE8;font-size:12px;padding:5px 12px;border-radius:8px;flex-shrink:0;cursor:pointer;">退出登录</span>';
        card.innerHTML = '<div style="display:flex;align-items:center;gap:10px;">'
          + '<span style="font-size:26px;">📱</span>'
          + '<span style="flex:1;min-width:0;"><span style="font-size:15px;font-weight:600;color:var(--text);">' + esc(name) + '</span>'
          + '<div style="margin-top:5px;">' + tags + '</div></span>'
          + act + '</div>'
          + '<div style="border-top:1px solid rgba(127,127,127,0.15);margin:10px 0 8px;"></div>'
          + '<div style="display:flex;font-size:13px;color:var(--text-muted);margin:4px 0;"><span style="width:90px;">最后登录时间</span><span style="color:var(--text);flex:1;min-width:0;word-break:break-all;">' + esc(String(t)) + '</span></div>'
          + '<div style="display:flex;font-size:13px;color:var(--text-muted);margin:4px 0;"><span style="width:90px;">登录IP</span><span style="color:var(--text);flex:1;min-width:0;word-break:break-all;">' + esc(String(ip)) + '</span></div>'
          + '<div style="display:flex;font-size:13px;color:var(--text-muted);margin:4px 0;"><span style="width:90px;">登录地址</span><span style="color:var(--text);flex:1;min-width:0;word-break:break-all;">' + esc(String(addr)) + '</span></div>';
        if (!isCur && keyv != null) {
          var kb = card.querySelector('.vdev-kick');
          if (kb) kb.addEventListener('click', function (e) { e.stopPropagation(); kickDevice(keyv); });
        }
        box.appendChild(card);
      });
      } catch (re) { try { extDbgPush({ u: 'DEVICES render ERR: ' + re, ok: false, raw: '' }); } catch (e2) {} box.innerHTML = '<div class="panel-empty"><p>渲染失败：' + esc(String(re)) + '</p></div>'; }
    });
  }
  function kickDevice(id) {
    showConfirm('是否确认退出登录该设备？', function () {
      var k = String(id == null ? '' : id);
      state.kickKey = k;
      extTryMulti([
        { method: 'POST', url: 'https://api.123278.com/b/api/user/kick_device', body: JSON.stringify({ del_derive: k }) },
        { method: 'POST', url: 'https://api.123pan.cn/b/api/user/kick_device', body: JSON.stringify({ del_derive: k }) }
      ], function (d, msgs) {
        if (d) { toast('该设备已退出登录'); loadDevices(); return; }
        var all = msgs.join(' | ');
        if (/验证码|验证|vcode/i.test(all)) { openVerifyModal('kick', k); return; }
        toast('下线失败：' + (msgs[0] ? msgs[0].slice(0, 70) : '接口暂不可用'));
      });
    });
  }
  function openVerifyModal(mode, key) {
    state.dvMode = mode || 'kick';
    state.kickKey = key || state.kickKey || '';
    show($('dv-modal'));
    try { fillPhoneFromServer($('dv-phone')); } catch (e) {}
    var tip = $('dv-tip');
    if (tip) tip.textContent = (state.dvMode === 'master')
      ? '绑定主设备需验证身份，请获取短信验证码后确认'
      : '为保证为本人操作，请验证身份信息后再试';
    var okb = $('dv-ok');
    if (okb) okb.textContent = (state.dvMode === 'master') ? '确认绑定' : '确认退出';
    var ph = (state.pfinfo && state.pfinfo.phone) || '';
    var el = $('dv-phone'); if (el && !el.value) el.value = (ph && ph !== '-') ? ph : '';
    var c = $('dv-code'); if (c) c.value = '';
    var m = $('dv-msg'); if (m) m.textContent = '';
  }
  function openDeviceVerify() { openVerifyModal('kick', state.kickKey); }
  function doDvGetCode() {
    var ph = ($('dv-phone') && $('dv-phone').value || '').trim();
    var m = $('dv-msg');
    var op = (state.dvMode === 'master') ? 12 : 6;   // 12=SetMasterDevice 6=DelDevice
    extRequestSmsCode(ph, $('dv-getcode'), function (t) { if (m) m.textContent = t; }, op);
  }
  function doDvConfirm() {
    var k = String(state.kickKey || '');
    var ph = ($('dv-phone') && $('dv-phone').value || '').trim();
    var code = ($('dv-code') && $('dv-code').value || '').trim();
    var m = $('dv-msg');
    if (!/^1\d{10}$/.test(ph)) { if (m) m.textContent = '请输入正确的手机号'; return; }
    if (!/^\d{4,6}$/.test(code)) { if (m) m.textContent = '请输入验证码'; return; }
    var btn = $('dv-ok'); if (btn) btn.disabled = true;
    function done() { if (btn) btn.disabled = false; }
    if (state.dvMode === 'master') {
      extTryMulti([
        { method: 'PUT', url: 'https://api.123278.com/b/api/device/set', body: JSON.stringify({ vCode: code }) },
        { method: 'PUT', url: 'https://api.123pan.cn/b/api/device/set', body: JSON.stringify({ vCode: code }) },
        { method: 'PUT', url: 'https://api.123278.com/api/device/set', body: JSON.stringify({ vCode: code }) }
      ], function (d, msgs) {
        done();
        if (!d) { if (m) m.textContent = '绑定失败：' + (msgs[0] ? msgs[0].slice(0, 70) : '接口不可用'); return; }
        toast('绑定成功：本机已设为主设备');
        var st = $('maindev-state'); if (st) st.textContent = '已绑定主设备：本机';
        try { localStorage.setItem('pan_maindev_bind', '1'); } catch (e) {}
        hide($('dv-modal'));
      });
    } else {
      if (!k) { done(); if (m) m.textContent = '设备信息缺失，请重新进入设备管理'; return; }
      extTryMulti([
        { method: 'POST', url: 'https://api.123278.com/b/api/user/kick_device', body: JSON.stringify({ del_derive: k, v_code: code, passport: ph }) },
        { method: 'POST', url: 'https://api.123pan.cn/b/api/user/kick_device', body: JSON.stringify({ del_derive: k, v_code: code, passport: ph }) },
        { method: 'POST', url: 'https://api.123278.com/b/api/user/kick_device', body: JSON.stringify({ del_derive: k, vCode: code, passport: ph }) }
      ], function (d, msgs) {
        done();
        if (!d) { if (m) m.textContent = '下线失败：' + (msgs[0] ? msgs[0].slice(0, 70) : '接口不可用'); return; }
        toast('该设备已退出登录');
        hide($('dv-modal'));
        loadDevices();
      });
    }
  }

  var LI_ICON_PHONE = '<span data-mask="1" style="display:inline-block;width:20px;height:20px;background-color:#68707D;-webkit-mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20x%3D%227%22%20y%3D%222.5%22%20width%3D%2210%22%20height%3D%2219%22%20rx%3D%222.5%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M10.5%2018.5h3%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E);-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20x%3D%227%22%20y%3D%222.5%22%20width%3D%2210%22%20height%3D%2219%22%20rx%3D%222.5%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M10.5%2018.5h3%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E);mask-repeat:no-repeat;mask-position:center;mask-size:contain;"></span>';
  var LI_ICON_WEB = '<span data-mask="1" style="display:inline-block;width:20px;height:20px;background-color:#68707D;-webkit-mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20x%3D%223%22%20y%3D%224%22%20width%3D%2218%22%20height%3D%2216%22%20rx%3D%223%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M3%209h18%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Ccircle%20cx%3D%226.2%22%20cy%3D%226.6%22%20r%3D%220.9%22%20fill%3D%22%23000%22%2F%3E%3Ccircle%20cx%3D%229.1%22%20cy%3D%226.6%22%20r%3D%220.9%22%20fill%3D%22%23000%22%2F%3E%3C%2Fsvg%3E);-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20x%3D%223%22%20y%3D%224%22%20width%3D%2218%22%20height%3D%2216%22%20rx%3D%223%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M3%209h18%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Ccircle%20cx%3D%226.2%22%20cy%3D%226.6%22%20r%3D%220.9%22%20fill%3D%22%23000%22%2F%3E%3Ccircle%20cx%3D%229.1%22%20cy%3D%226.6%22%20r%3D%220.9%22%20fill%3D%22%23000%22%2F%3E%3C%2Fsvg%3E);mask-repeat:no-repeat;mask-position:center;mask-size:contain;"></span>';
  var LI_ICON_PC = '<span data-mask="1" style="display:inline-block;width:20px;height:20px;background-color:#68707D;-webkit-mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20x%3D%223%22%20y%3D%224%22%20width%3D%2218%22%20height%3D%2213%22%20rx%3D%222%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M9%2021h6M12%2017v4%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E);-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20x%3D%223%22%20y%3D%224%22%20width%3D%2218%22%20height%3D%2213%22%20rx%3D%222%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M9%2021h6M12%2017v4%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E);mask-repeat:no-repeat;mask-position:center;mask-size:contain;"></span>';
  var LI_ICON_UNK = '<span data-mask="1" style="display:inline-block;width:20px;height:20px;background-color:#68707D;-webkit-mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%229%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M9.5%209.1a2.6%202.6%200%201%201%203.8%202.3c-.9.5-1.3%201-1.3%201.9%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2217%22%20r%3D%221.05%22%20fill%3D%22%23000%22%2F%3E%3C%2Fsvg%3E);-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;-webkit-mask-size:contain;mask-image:url(data:image/svg+xml;utf8,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%229%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%2F%3E%3Cpath%20d%3D%22M9.5%209.1a2.6%202.6%200%201%201%203.8%202.3c-.9.5-1.3%201-1.3%201.9%22%20stroke%3D%22%23000%22%20stroke-width%3D%221.8%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2217%22%20r%3D%221.05%22%20fill%3D%22%23000%22%2F%3E%3C%2Fsvg%3E);mask-repeat:no-repeat;mask-position:center;mask-size:contain;"></span>';
  // 设备类型识别：手机 / 网页 / 电脑 / 未知网页 / 未知设备
  function loginKind(s) {
    s = String(s || '').toLowerCase();
    if (/(web|browser|chrome|safari|edge|firefox|h5|html|网页|浏览器|小程序|mini)/.test(s)) {
      return { icon: LI_ICON_WEB, label: '网页', fallback: '未知网页' };
    }
    if (/(pc|windows|macos|mac os|win|linux|desktop|computer|电脑|桌面)/.test(s)) {
      return { icon: LI_ICON_PC, label: '电脑', fallback: '未知设备' };
    }
    if (/(phone|iphone|android|ios|ipad|mobile|app|手机|平板)/.test(s)) {
      return { icon: LI_ICON_PHONE, label: '手机', fallback: '未知设备' };
    }
    return { icon: LI_ICON_UNK, label: '未知设备', fallback: '未知设备' };
  }
  function loadLoginHistory() {
    var box = $('history-list'); if (!box) return;
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/user/use_history?page=1&limit=20' },
      { method: 'GET', url: EXT_API + '/api/user/use_history' }
    ], function (d, err) {
      var days = extPickList(d);
      if (!days) { box.innerHTML = '<div class="panel-empty"><p>' + esc(err ? ('登录记录获取失败：' + String(err).slice(0, 50)) : '登录记录暂不可用') + '</p></div>'; return; }
      box.innerHTML = '';
      var total = 0;
      days.forEach(function (dy) {
        var infos = (dy && Array.isArray(dy.info)) ? dy.info : [];
        if (!infos.length) return;
        var h = document.createElement('div');
        h.style.cssText = 'margin:12px 2px 8px;color:var(--text-muted);font-size:13px;';
        h.textContent = String(dy.date || '');
        box.appendChild(h);
        infos.forEach(function (it) {
          total++;
          var rawName = String(valOf(it, 'device_name', 'deviceName', 'name', 'Name') || '');
          var dtype = valOf(it, 'device_type', 'deviceType');
          var ltype = valOf(it, 'login_type', 'loginType', 'client_type', 'ClientType');
          var kind = loginKind(String(dtype || '') + ' ' + String(ltype || ''));
          var name = rawName || kind.fallback;
          var t = String(valOf(it, 'login_time', 'loginTime') || '');
          var hm = t.length >= 8 ? t.slice(-8) : t;
          var ip = valOf(it, 'ip', 'IP') || '-';
          var addr = valOf(it, 'login_address', 'loginAddress', 'address', 'Address') || '-';
          var card = document.createElement('div');
          card.style.cssText = 'background:var(--surface);border-radius:16px;padding:12px 14px;margin:0 0 12px;box-shadow:0 2px 8px rgba(0,0,0,0.04);';
          var tags = '<span style="background:#eaf1ff;color:#2B6DE8;font-size:11px;padding:2px 8px;border-radius:6px;">' + esc(kind.label) + '</span>';
          if (dtype && String(dtype).toLowerCase() !== kind.label.toLowerCase()) tags += '<span style="background:rgba(127,127,127,0.12);color:var(--text-muted);font-size:11px;padding:2px 8px;border-radius:6px;margin-left:6px;">' + esc(String(dtype)) + '</span>';
          if (ltype) tags += '<span style="background:rgba(127,127,127,0.12);color:var(--text-muted);font-size:11px;padding:2px 8px;border-radius:6px;margin-left:6px;">' + esc(String(ltype)) + '</span>';
          card.innerHTML = '<div style="display:flex;align-items:center;gap:10px;">'
            + '<span style="width:36px;height:36px;border-radius:10px;background:rgba(127,127,127,0.10);display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + kind.icon + '</span>'
            + '<span style="flex:1;min-width:0;"><span style="font-size:15px;font-weight:600;color:var(--text);">' + esc(name) + '</span>'
            + '<div style="margin-top:5px;">' + tags + '</div></span></div>'
            + '<div style="border-top:1px solid rgba(127,127,127,0.15);margin:10px 0 8px;"></div>'
            + '<div style="display:flex;font-size:13px;color:var(--text-muted);margin:4px 0;"><span style="width:76px;">登录时间</span><span style="color:var(--text);">' + esc(hm) + '</span></div>'
            + '<div style="display:flex;font-size:13px;color:var(--text-muted);margin:4px 0;"><span style="width:76px;">登录IP</span><span style="color:var(--text);">' + esc(String(ip)) + '</span></div>'
            + '<div style="display:flex;font-size:13px;color:var(--text-muted);margin:4px 0;"><span style="width:76px;">登录地址</span><span style="color:var(--text);">' + esc(String(addr)) + '</span></div>';
          box.appendChild(card);
        });
      });
      if (!total) { box.innerHTML = '<div class="panel-empty"><p>暂无登录记录</p></div>'; }
    });
  }


  // ==================== 个人资料：实名/微信 兜底探测 ====================
  var _extrasCache = { at: 0, realText: null, wxText: null };
  function profileNeedProbe(u) {
    var realRaw = valOf(u, 'RealNameAuth', 'realNameAuth', 'registerRealNameAuth', 'fileRealName',
      'isRealName', 'IsRealName', 'realNameStatus', 'RealNameStatus', 'authStatus', 'AuthStatus',
      'isVerified', 'IsVerified', 'certification', 'Certification', 'isAuth', 'authType');
    var wxRaw = valOf(u, 'isBindWechat', 'IsBindWechat', 'wxBind', 'WxBind', 'wechatBind', 'WechatBind',
      'bindWechat', 'isWxBind', 'wxBound', 'isBindWx', 'isWechatBind', 'wechatStatus', 'wxStatus',
      'wechat_open_id', 'wechat_union_id', 'wechatOpenId', 'wechatUnionId', 'wechatNickname');
    return (realRaw === null) || (wxRaw === null);
  }
  function updateProfileRow(label, value) {
    if (!value) return;
    var box = $('profile-list'); if (!box) return;
    var rows = box.querySelectorAll('.pf-row');
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i].querySelector('.pf-k');
      if (k && k.textContent === label) {
        var v = rows[i].querySelector('.pf-v');
        if (v) v.textContent = value;
        break;
      }
    }
  }
  function applyProfileExtras() {
    updateProfileRow('实名认证', _extrasCache.realText);
    updateProfileRow('微信绑定', _extrasCache.wxText);
  }
  function probeProfileExtras(u) {
    var fresh = (Date.now() - _extrasCache.at) < 10 * 60 * 1000;
    if (fresh && (_extrasCache.realText || _extrasCache.wxText)) { applyProfileExtras(); return; }
    if (!profileNeedProbe(u)) return;   // user/info 已含字段则无需探测
    // 直接再拉一份 user/info：原始响应写入诊断（找出实名/微信的真实字段名），并深度搜索可用字段
    api('GET', API.userInfo, '', true, function (d) {
      var ok = d && d.code === 0;
      try { extDbgPush({ u: 'RAW user/info (profile probe)', ok: !!ok, raw: d ? JSON.stringify(d).slice(0, 1500) : '' }); } catch (e) {}
      var foundR = null, foundW = null;
      var walk = function (o, depth) {
        if (!o || depth > 4) return;
        if (Array.isArray(o)) { o.forEach(function (x) { walk(x, depth + 1); }); return; }
        if (typeof o !== 'object') return;
        var kk = Object.keys(o);
        for (var i = 0; i < kk.length; i++) {
          var k = kk[i], v = o[k];
          if (v && typeof v === 'object') { walk(v, depth + 1); continue; }
          if (v === null || v === undefined || v === '') continue;
          var ks = String(k);
          if (!foundR && /realname|real_name|realnameauth|idcard|authstatus|isverified|certification|id_card|authenticat|isauth|实名/i.test(ks)) foundR = (typeof v === 'boolean') ? (v ? '已认证' : '未认证') : String(v);
          else if (!foundW && /wechat|wx_|wechatopenid|bindstatus|微信/i.test(ks)) foundW = (typeof v === 'boolean') ? (v ? '已绑定' : '未绑定') : String(v);
        }
      };
      walk(d, 0);
      _extrasCache = { at: Date.now(), realText: foundR, wxText: foundW };
      applyProfileExtras();
    });
  }

  // ==================== 顶栏按钮 / 逐级返回 / 页面栈 ====================
  var EXT_COVER_STACK = [];
  function extOpenCover(id) {
    try { if (!$(id)) return; } catch (e) { return; }
    if (EXT_COVER_STACK.indexOf(id) < 0) EXT_COVER_STACK.push(id);
    show($(id));
  }
  function clearCoverInputs(id) {
    try {
      var el = typeof id === 'string' ? $(id) : id;
      if (!el || !el.querySelectorAll) return;
      var inputs = el.querySelectorAll('input, textarea');
      for (var i = 0; i < inputs.length; i++) {
        var t = inputs[i];
        if (t.type === 'checkbox' || t.type === 'radio' || t.type === 'hidden' || t.type === 'file') continue;
        t.value = '';
      }
    } catch (e) {}
  }
  function extCloseCover(id) {
    hide($(id));
    clearCoverInputs(id);
    var i = EXT_COVER_STACK.indexOf(id);
    if (i >= 0) EXT_COVER_STACK.splice(i, 1);
  }
  function extCloseTopCover() {
    for (var i = EXT_COVER_STACK.length - 1; i >= 0; i--) {
      var el = $(EXT_COVER_STACK[i]);
      if (el && !el.classList.contains('hidden')) { hide(el); clearCoverInputs(EXT_COVER_STACK[i]); EXT_COVER_STACK.splice(i, 1); return true; }
    }
    // 兜底 1：未入栈的浮层（弹窗/抽屉）
    var overlays = ['action-sheet', 'share-modal', 'share-config-modal', 'clip-modal',
      'account-sheet', 'account-action', 'upload-sheet', 'detail-modal', 'theme-modal',
      'sort-sheet', 'confirm-modal', 'ext-prompt'];
    for (var j = overlays.length - 1; j >= 0; j--) {
      var ov = $(overlays[j]);
      if (ov && !ov.classList.contains('hidden')) { hide(ov); clearCoverInputs(overlays[j]); if (overlays[j] === 'confirm-modal') { state.confirmOk = null; } return true; }
    }
    // 兜底 2：最后一个可见的覆盖页（含未入栈的：我的分享/回收站等）
    var covers = document.querySelectorAll('.page-cover');
    for (var k = covers.length - 1; k >= 0; k--) {
      if (!covers[k].classList.contains('hidden')) { hide(covers[k]); clearCoverInputs(covers[k].id); return true; }
    }
    return false;
  }
  function updateTopActions(v) {
    var box = $('top-actions');
    if (!box) return;
    if (v === 'mine') box.classList.add('show');
    else box.classList.remove('show');
    var tb = $('topbar');
    if (tb) tb.classList.toggle('tv-rounded', v !== 'files');
    if (v === 'mine') { try { refreshNoticeBadge(); } catch (e) {} }
  }
  function markAllNoticesRead() {
    var arr = state.noticeCache || [];
    var ids = [];
    function markOne(it) {
      var id = valOf(it, 'id', 'Id', 'ID', 'noticeId', 'NoticeId', 'announcementId', 'AnnouncementId');
      if (id != null && ids.indexOf(id) < 0) { ids.push(id); try { noticeMarkLocal(id); } catch (e) {} }
    }
    arr.forEach(markOne);
    (state.noticeIds || []).forEach(function (id) {
      if (id != null && ids.indexOf(id) < 0) { ids.push(id); try { noticeMarkLocal(id); } catch (e) {} }
    });
    if (ids.length) {
      extApiTry([
        { method: 'PUT', url: 'https://api.123278.com/b/api/notice', body: JSON.stringify({ idList: ids, status: 1 }) },
        { method: 'PUT', url: 'https://api.123278.com/api/notice', body: JSON.stringify({ idList: ids, status: 1 }) },
        { method: 'POST', url: 'https://api.123278.com/b/api/notice', body: JSON.stringify({ idList: ids, status: 1 }) }
      ], function () {});
    }
    state.noticeUnread = 0;
    try { updateNoticeBadge(); } catch (e) {}
    try { renderNotices(state.noticeCache || []); } catch (e) {}
    toast('已全部标记为已读');
  }
  function openNoticeModal() { try { closeAllOverlays(); extOpenCover('page-notice'); loadNotices(); } catch (e) { toast('消息中心打开失败：' + e); } }
  function closeNoticeModal() { extCloseCover('page-notice'); }
  function openSettingsPage() { try { closeAllOverlays(); extOpenCover('page-settings'); } catch (e) { toast('打开失败：' + e); } }
  function openProfileInfoPage() {
    try { closeAllOverlays(); extOpenCover('page-profile-info'); } catch (e) {}
    api('GET', API.userInfo, '', true, function (d) {
      try {
        var u = (d && (d.data || d.Data)) || {};
        if (u && u.user && typeof u.user === 'object') u = u.user;
        var nick = valOf(u, 'Nickname', 'nickname', 'nickName') || '-';
        var uid = valOf(u, 'UID', 'Uid', 'uid', 'userId', 'id') || '-';
        var phone = valOf(u, 'Passport', 'passport', 'mobile', 'account') || '-';
        var mail = valOf(u, 'Mail', 'mail', 'email', 'Email') || '-';
        var head = valOf(u, 'HeadImage', 'headImage', 'headImg', 'avatar') || '';
        var isReal = valOf(u, 'IsAuthentication', 'isAuthentication', 'RealNameAuth', 'isRealName');
        var setTxt = function (id, txt) { var el = $(id); if (el) el.textContent = txt; };
        setTxt('pfinfo-nick', String(nick));
        setTxt('pfinfo-uid', String(uid));
        setTxt('pfinfo-phone', String(phone));
        setTxt('pfinfo-mail', String(mail));
        setTxt('pfinfo-real', (isReal === true || Number(isReal) === 1 || String(isReal).toLowerCase() === 'true') ? '已认证' : '未认证');
        state.pfinfo = { nick: String(nick), uid: String(uid), phone: String(phone), mail: String(mail) };
        var av = $('pfinfo-avatar');
        if (av && head) { try { av.src = previewSrc(String(head)); } catch (e) { av.src = String(head); } }
      } catch (e) {}
    });
  }
  function openHistoryPage() { try { closeAllOverlays(); extOpenCover('page-history'); loadLoginHistory(); } catch (e) {} }
  function openAppealPage() {
    try { if ($('page-appeal') && $('page-appeal').classList.contains('hidden')) extOpenCover('page-appeal'); } catch (e) {}
    var box = $('appeal-list'); if (!box) return;
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    extApiTry([
      { method: 'POST', url: 'https://api.123278.com/api/appeal/list', body: JSON.stringify({ page: 1, pageSize: 200 }) },
      { method: 'POST', url: 'https://api.123278.com/b/api/appeal/list', body: JSON.stringify({ page: 1, pageSize: 200 }) },
      { method: 'POST', url: 'https://api.123pan.cn/api/appeal/list', body: JSON.stringify({ page: 1, pageSize: 200 }) },
      { method: 'POST', url: 'https://api.123pan.cn/b/api/appeal/list', body: JSON.stringify({ page: 1, pageSize: 200 }) },
      { method: 'POST', url: 'https://api.123278.com/api/restful/goapi/v1/appeal/list', body: JSON.stringify({ page: 1, pageSize: 200 }) },
      { method: 'GET', url: EXT_API + '/api/appeal/list?page=1&limit=20' }
    ], function (d, err) {
      var arr = extPickList(d);
      if (!arr) { box.innerHTML = '<div class="panel-empty"><p>暂无申诉记录</p></div>'; return; }
      box.innerHTML = '';
      if (!arr.length) { box.innerHTML = '<div class="panel-empty"><p>暂无申诉记录</p></div>'; return; }
      arr.forEach(function (it) {
        var card = document.createElement('div');
        card.className = 'file-card';
        var ic = document.createElement('div'); ic.className = 'file-icon-wrap';
        ic.style.cssText = 'font-size:18px;display:flex;align-items:center;justify-content:center;';
        ic.textContent = '📄';
        var body = document.createElement('div'); body.className = 'file-body';
        var nm = document.createElement('div'); nm.className = 'file-name';
        nm.textContent = String(valOf(it, 'title', 'Title', 'shareTitle', 'fileName', 'FileName') || ('申诉 #' + (valOf(it, 'id', 'Id') || '')));
        var m = document.createElement('div'); m.className = 'file-meta';
        var st = valOf(it, 'statusText', 'StatusText', 'status', 'Status');
        var tm = valOf(it, 'createAt', 'CreateAt', 'createTime', 'CreateTime', 'time', 'Time');
        m.textContent = [st != null ? String(st) : '', tm != null ? fmtDate(tm) : ''].filter(function (x) { return x; }).join(' · ');
        body.appendChild(nm); body.appendChild(m);
        card.appendChild(ic); card.appendChild(body);
        box.appendChild(card);
      });
    });
  }

  function openExtPrompt(title, value, cb) {
    $('ext-prompt-title').textContent = title || '设置';
    $('ext-prompt-input').value = value || '';
    state.extPromptCb = cb || null;
    show($('ext-prompt'));
  }
  function extPromptClose() { hide($('ext-prompt')); state.extPromptCb = null; }
  function extPromptOk() {
    var v = ($('ext-prompt-input') && $('ext-prompt-input').value || '').trim();
    var cb = state.extPromptCb;
    hide($('ext-prompt'));
    state.extPromptCb = null;
    if (cb) cb(v);
  }
  function doChangeNick(v) {
    if (!v) { toast('昵称不能为空'); return; }
    extApiTry([
      { method: 'POST', url: 'https://api.123278.com/api/user/modify_info', body: JSON.stringify({ nickname: v }) },
      { method: 'POST', url: 'https://api.123278.com/b/api/user/modify_info', body: JSON.stringify({ nickname: v }) },
      { method: 'POST', url: 'https://api.123pan.cn/api/user/modify_info', body: JSON.stringify({ nickname: v }) },
      { method: 'POST', url: EXT_API + '/api/user/modify_info', body: JSON.stringify({ Nickname: v }) },
      { method: 'POST', url: EXT_API + '/api/user/modify_info', body: JSON.stringify({ nickName: v }) }
    ], function (d, err) {
      if (!d) { toast(err ? String(String(err).slice(0, 60)) : '修改失败'); return; }
      toast('昵称已更新');
      var el = $('pfinfo-nick'); if (el) el.textContent = v;
      if (state.profile) state.profile.nickname = v;
      try { fetchUserProfile(); } catch (e) {}
    });
  }
  // 获取短信验证码：多主机 × 多参数名 × 多 operation 组合（提高兼容性）
  function buildVcodeCands(ph, ops) {
    var hosts = ['https://user.123pan.cn', 'https://api.123278.com', 'https://api.123pan.cn'];
    var names = ['passport', 'phoneNo', 'mobile'];
    var cands = [];
    for (var h = 0; h < hosts.length; h++) {
      for (var oi = 0; oi < ops.length; oi++) {
        for (var n = 0; n < names.length; n++) {
          var b = {}; b[names[n]] = String(ph);
          if (ops[oi] !== null && ops[oi] !== undefined) b.operation = ops[oi];
          cands.push({ method: 'POST', url: hosts[h] + '/api/user/get_vcode', body: JSON.stringify(b) });
        }
      }
    }
    return cands;
  }
  function fillPhoneFromServer(el) {
    if (!el) return;
    api('GET', API.userInfo, '', true, function (d) {
      try {
        var u = (d && (d.data || d.Data)) || {};
        var pp = String(valOf(u, 'Passport', 'passport', 'mobile') || '');
        if (pp && el && !el.value) el.value = pp;
        if (pp && state.pfinfo) state.pfinfo.phone = pp;
      } catch (e) {}
    });
  }
  function openEmailPage(mail) {
    extOpenCover('page-email');
    var inp = $('email-mail');
    if (inp) inp.value = (mail && mail !== '-') ? mail : '';
    var m = $('email-msg'); if (m) m.textContent = '';
  }
  function doEmailGetCode() {
    var mail = ($('email-mail') && $('email-mail').value || '').trim();
    if (!mail) { toast('请输入邮箱'); return; }
    var m = $('email-msg');
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/get/mail_code?mail=' + encodeURIComponent(mail) },
      { method: 'POST', url: EXT_API + '/api/get/mail_code', body: JSON.stringify({ mail: mail }) },
      { method: 'POST', url: EXT_API + '/api/get/mail_code', body: JSON.stringify({ email: mail }) }
    ], function (d, err) {
      if (!d) { if (m) m.textContent = '验证码发送失败：' + (err ? String(err).slice(0, 50) : '接口不可用'); return; }
      toast('验证码已发送');
      if (m) m.textContent = '验证码已发送至邮箱';
    });
  }
  function doEmailSave() {
    var mail = ($('email-mail') && $('email-mail').value || '').trim();
    var code = ($('email-code') && $('email-code').value || '').trim();
    var m = $('email-msg');
    if (!mail || !code) { toast('请填写邮箱和验证码'); return; }
    extApiTry([
      { method: 'POST', url: EXT_API + '/api/option/mail', body: JSON.stringify({ mail: mail, code: code }) },
      { method: 'POST', url: EXT_API + '/api/option/mail', body: JSON.stringify({ Mail: mail, Code: code }) }
    ], function (d, err) {
      if (!d) { if (m) m.textContent = '操作失败：' + (err ? String(err).slice(0, 60) : '接口不可用'); toast('操作失败'); return; }
      toast('邮箱操作成功');
      extCloseCover('page-email');
      try { var el = $('pfinfo-mail'); if (el) el.textContent = mail; } catch (e) {}
    });
  }
  function openMainDevicePage() {
    extOpenCover('page-main-device');
    var st = $('maindev-state'); if (st) st.textContent = '暂未绑定主设备';
    try { if (localStorage.getItem('pan_maindev_bind') === '1' && st) st.textContent = '已绑定主设备：本机'; } catch (e) {}
    extApiTry([
      { method: 'GET', url: 'https://api.123278.com/b/api/user/device_list?operateType=2&event=deviceManagement' },
      { method: 'GET', url: EXT_API + '/api/user/device_list' }
    ], function (d) {
      if (!d) return;
      var data = (d.data !== undefined) ? d.data : d;
      var md = data && (data.masterDevice || data.MasterDevice);
      if (md && (md.device_name || md.deviceName)) {
        var nm = String(md.device_name || md.deviceName);
        var isCur = md.cur_device === true || Number(md.cur_device) === 1 || String(md.cur_device).toLowerCase() === 'true';
        if (st) st.textContent = '已绑定主设备：' + nm + (isCur ? '（本机）' : '（非本机）');
      }
    });
  }
  function doBindMainDevice() {
    openVerifyModal('master', '');
  }
  function loadAnnounce() {
    var box = $('announce-list'); if (!box) return;
    box.innerHTML = '<div class="loading-dot">加载中...</div>';
    extApiTry([
      { method: 'GET', url: EXT_API + '/api/announcement/list?page=1&limit=30' },
      { method: 'GET', url: EXT_API + '/api/notice/announcement?page=1&limit=30' },
      { method: 'GET', url: EXT_API + '/api/notice?page=1&limit=30&type=1' }
    ], function (d, err) {
      var arr = extPickList(d);
      if (!arr) { box.innerHTML = '<div class="panel-empty"><p>' + esc(err ? ('公告获取失败：' + String(err).slice(0, 40)) : '暂无公告') + '</p></div>'; return; }
      box.innerHTML = '';
      if (!arr.length) { box.innerHTML = '<div class="panel-empty"><p>暂无公告</p></div>'; return; }
      arr.forEach(function (it) {
        var card = document.createElement('div');
        card.className = 'file-card';
        var ic = document.createElement('div'); ic.className = 'file-icon-wrap';
        ic.style.cssText = 'font-size:18px;display:flex;align-items:center;justify-content:center;';
        ic.textContent = '📢';
        var body = document.createElement('div'); body.className = 'file-body';
        var nm = document.createElement('div'); nm.className = 'file-name'; nm.textContent = noticeTitle(it);
        var meta = document.createElement('div'); meta.className = 'file-meta';
        meta.textContent = noticeTime(it) || '';
        body.appendChild(nm); body.appendChild(meta);
        card.appendChild(ic); card.appendChild(body);
        card.addEventListener('click', function () { openNoticeDetail(it); });
        box.appendChild(card);
      });
    });
  }

  // ==================== 实名认证（当前页完成） ====================

  // ==================== 更换手机号 ====================
  function openPhonePage() {
    extOpenCover('page-phone');
    var cur = (state.pfinfo && state.pfinfo.phone) || '';
    var c = $('phone-cur'); if (c) c.textContent = (cur && cur !== '-') ? cur : '未绑定';
    ['phone-new', 'phone-code-new'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
    var m = $('phone-msg'); if (m) m.textContent = '';
  }
  function doPhoneGetCode() {
    var ph = ($('phone-new') && $('phone-new').value || '').trim();
    var m = $('phone-msg');
    if (!/^1\d{10}$/.test(ph)) { if (m) m.textContent = '请输入正确的11位手机号'; toast('请输入正确的新手机号'); return; }
    extRequestSmsCode(ph, $('phone-getcode-new'), function (t) { if (m) m.textContent = t; }, 4);
  }
  function doPhoneSave() {
    var news = ($('phone-new') && $('phone-new').value || '').trim();
    var codeNew = ($('phone-code-new') && $('phone-code-new').value || '').trim();
    var m = $('phone-msg');
    if (!/^1\d{10}$/.test(news)) { toast('请输入正确的新手机号'); return; }
    if (!codeNew) { toast('请输入新手机验证码'); return; }
    var ts = Math.floor(Date.now() / 1000);
    var body = JSON.stringify({ new_passport: news, new_vcode: codeNew, new_timestamp: ts });
    var btn = $('phone-save'); if (btn) btn.disabled = true;
    function done() { if (btn) btn.disabled = false; }
    extApiTry([
      { method: 'POST', url: 'https://api.123278.com/api/user/modify_passport', body: body },
      { method: 'POST', url: 'https://api.123278.com/b/api/user/modify_passport', body: body },
      { method: 'POST', url: 'https://api.123pan.cn/api/user/modify_passport', body: body },
      { method: 'POST', url: EXT_API + '/api/user/modify_passport', body: body },
      { method: 'POST', url: 'https://api.123278.com/api/user/modify_passport', body: JSON.stringify({ passport: news, vcode: codeNew }) }
    ], function (d, err) {
      done();
      if (!d) { if (m) m.textContent = '更换失败：' + (err ? String(err).slice(0, 60) : '接口不可用'); toast('更换失败'); return; }
      toast('手机号码更改成功');
      if (state.pfinfo) state.pfinfo.phone = news;
      var ph = $('pfinfo-phone'); if (ph) ph.textContent = news;
      extCloseCover('page-phone');
    });
  }

  // ==================== 注销账号（完整流程） ====================
  function openLogoffPage() {
    extOpenCover('page-logoff');
    var ph = (state.pfinfo && state.pfinfo.phone) || '';
    var el = $('logoff-phone'); if (el && !el.value) el.value = (ph && ph !== '-') ? ph : '';
    fillPhoneFromServer(el);
    var c = $('logoff-code'); if (c) c.value = '';
    var m = $('logoff-msg'); if (m) m.textContent = '';
  }
  function doLogoffGetCode() {
    var ph = ($('logoff-phone') && $('logoff-phone').value || '').trim();
    var m = $('logoff-msg');
    if (!/^1\d{10}$/.test(ph)) { if (m) m.textContent = '请输入正确的11位手机号'; toast('请输入正确的手机号'); return; }
    extRequestSmsCode(ph, $('logoff-getcode'), function (t) { if (m) m.textContent = t; }, 13);
  }
  function doLogoffConfirm() {
    var ph = ($('logoff-phone') && $('logoff-phone').value || '').trim();
    var code = ($('logoff-code') && $('logoff-code').value || '').trim();
    var m = $('logoff-msg');
    if (!/^1\d{10}$/.test(ph)) { toast('请输入绑定的手机号'); return; }
    if (!code) { toast('请输入验证码'); return; }
    showConfirm('注销后账号将永久删除且无法恢复，确认注销？', function () {
      extApiTry([
        { method: 'POST', url: 'https://api.123278.com/api/user/log_off', body: JSON.stringify({ Vcode: code, Passport: ph, Timestamp: Math.floor(Date.now() / 1000), validate: 1 }) },
        { method: 'POST', url: 'https://api.123278.com/api/user/log_off', body: JSON.stringify({ Vcode: code, Passport: ph, Timestamp: Math.floor(Date.now() / 1000) }) },
        { method: 'POST', url: 'https://api.123278.com/b/api/user/log_off', body: JSON.stringify({ Vcode: code, Passport: ph, Timestamp: Math.floor(Date.now() / 1000) }) },
        { method: 'POST', url: 'https://api.123pan.cn/api/user/log_off', body: JSON.stringify({ Vcode: code, passport: ph }) }
      ], function (d, err) {
        if (!d) { if (m) m.textContent = '注销失败：' + (err ? String(err).slice(0, 60) : '接口不可用'); toast('注销失败'); return; }
        toast('注销成功');
        try { if (bridge && bridge.clearSession) bridge.clearSession(); } catch (e) {}
        try { cacheClear(); } catch (e) {}
        try { if (bridge && bridge.logout) bridge.logout(); } catch (e) {}
      });
    });
  }
  function doLogoutExt() {
    showConfirm('确定退出当前账号登录？', function () {
      try { if (bridge && bridge.clearSession) bridge.clearSession(); } catch (e) {}
      try { cacheClear(); } catch (e) {}
      try { if (bridge && bridge.logout) bridge.logout(); } catch (e) {}
      toast('已退出登录');
    });
  }

  // ==================== 绑定与初始化 ====================
  function extInit() {
    var bind = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
    bind('btn-top-msg', openNoticeModal);
    bind('offline-done-refresh', function () { try { OFFLINE_DONE_STATE.loaded = false; loadOfflineDone(true); } catch (e) {} });
    bind('offline-done-clear', function () { try { clearAllOfflineDone(); } catch (e) {} });
    bind('notice-back', function () { extCloseCover('page-notice'); });
    bind('notice-refresh', function () { loadNotices(); });
    bind('notice-readall', function () { markAllNoticesRead(); });
    // 会员中心入口已按要求移除
    bind('vip-back', function () { hide($('page-vip')); });
    bind('vip-refresh', function () { renderVipPage(); });
    bind('vip-checkin', doCheckin);
    bind('vip-buy', function () { openExtUrl('https://www.123pan.com/'); });
    bind('device-back', function () { extCloseCover('page-device'); });
    bind('device-refresh', function () { loadDevices(); });
    bind('dv-getcode', doDvGetCode);
    bind('dv-ok', doDvConfirm);
    var mineTab = document.querySelector('#tabbar .tab[data-view="mine"]');
    if (mineTab) mineTab.addEventListener('click', function () { refreshNoticeBadge(); updateMineVipRow(); });
    updateNoticeBadge();
    updateMineVipRow();
    // 新页面绑定
    bind('btn-top-set', openSettingsPage);
    bind('settings-back', function () { extCloseCover('page-settings'); });
    bind('set-profile', openProfileInfoPage);
    bind('set-appeal', openAppealPage);
    bind('set-device', function () { try { closeAllOverlays(); extOpenCover('page-device'); loadDevices(); } catch (e) { toast('设备管理打开失败：' + e); } });
    bind('set-history', openHistoryPage);
    bind('pfinfo-back', function () { extCloseCover('page-profile-info'); });
    bind('pfinfo-copy', function () { try { var el = $('pfinfo-uid'); if (bridge && bridge.setClipboardText) bridge.setClipboardText(el ? el.textContent : ''); } catch (e) { toast('复制失败'); } });
    bind('history-back', function () { extCloseCover('page-history'); });
    bind('appeal-back', function () { extCloseCover('page-appeal'); });
    bind('appeal-refresh', function () { openAppealPage(); });
    bind('device-main-bind', function () { openMainDevicePage(); });
    // v17 新绑定
    bind('mine-announce', function () { try { closeAllOverlays(); extOpenCover('page-announce'); loadAnnounce(); } catch (e) { toast('公告中心打开失败：' + e); } });
    bind('announce-back', function () { extCloseCover('page-announce'); });
    bind('announce-refresh', function () { loadAnnounce(); });
    bind('pfinfo-avatar-row', function () { toast('头像设置暂未开放'); });
    bind('pfinfo-nick-row', function () { var cur = $('pfinfo-nick'); openExtPrompt('设置昵称', cur ? cur.textContent : '', function (v) { doChangeNick(v); }); });
    bind('pfinfo-mail-row', function () { var cur = $('pfinfo-mail'); var mail = cur ? cur.textContent : ''; showConfirm('更换绑定的邮箱 · 当前绑定：' + mail, function () { openEmailPage(mail); }); });
    bind('pfinfo-phone-row', openPhonePage);
    bind('pfinfo-real-row', function () {
      var el = $('pfinfo-real');
      var t = el ? String(el.textContent || '') : '';
      if (t === '已认证') { toast('已完成实名认证'); return; }
      showConfirm('实名认证需在官方123云盘App内完成，请前往官方App操作。', function () {});
    });
    bind('phone-back', function () { extCloseCover('page-phone'); });
    bind('phone-getcode-new', doPhoneGetCode);
    bind('phone-save', doPhoneSave);
    bind('email-back', function () { extCloseCover('page-email'); });
    bind('email-getcode', doEmailGetCode);
    bind('email-save', doEmailSave);
    bind('maindev-back', function () { extCloseCover('page-main-device'); });
    bind('maindev-bind', doBindMainDevice);
    bind('ext-prompt-ok', extPromptOk);
    bind('ext-prompt-cancel', extPromptClose);
    bind('ext-prompt-close', extPromptClose);
    bind('set-logoff', openLogoffPage);
    bind('logoff-back', function () { extCloseCover('page-logoff'); });
    bind('logoff-getcode', doLogoffGetCode);
    bind('logoff-confirm', doLogoffConfirm);
    bind('set-logout', doLogoutExt);
    // 顶栏按钮显隐：跟随视图切换
    try {
      var _origSwitchView = switchView;
      switchView = function (v) {
        _origSwitchView(v);
        try { updateTopActions(v); updateNoticeBadge(); } catch (e) {}
      };
      updateTopActions(state.view || 'files');
    } catch (e) {}
    // 逐级返回：详情弹窗 → 消息弹窗 → 扩展封面页 → 原有处理
    try {
      var _origBack = window.__handleBack;
      window.__handleBack = function () {
        try {
          var ov = document.getElementById('ext-notice-overlay');
          if (ov && ov.parentNode) { ov.parentNode.removeChild(ov); return; }
        } catch (e) {}
        try {
          if ($('ext-prompt') && !$('ext-prompt').classList.contains('hidden')) { hide($('ext-prompt')); return; }
        } catch (e) {}
        try { if (extCloseTopCover()) return; } catch (e) {}
        try { if (typeof _origBack === 'function') _origBack(); } catch (e) {}
      };
    } catch (e) {}
    try { crossInit(); } catch (e) {}
    try { checkDeepLinkFromNative(); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();