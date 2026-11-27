#!/usr/bin/env node
/**
 * scripts/check-window-chrome.mjs — 桌面窗口顶栏的契约守卫（静态、无浏览器依赖、进 preflight）。
 *
 *   node scripts/check-window-chrome.mjs
 *
 * 背景（2026-11-27）：面板在 DSH 桌面窗口里打开时，macOS 的 hiddenInset 红黄绿按钮
 * 浮在页面左上角（x 16..68 / y 18..30），而顶栏只留了 16–20px 内边距，按钮直接压在
 * 品牌 mark 和标题第一个字上。宿主的契约是：桌面 preload 给每个窗口写
 * <html data-platform>，并把窗口 chrome 占的带宽发布成 --dsh-frame-leading-clearance；
 * 内容抵达左上角的面板要自己让开，顶栏同时要能拖窗（控件回 no-drag）。
 *
 * 这里只断言「规则还在、数值还够、选择器和 DOM 还对得上」——真正的像素结果由
 * scripts/ui-evidence.mjs 那一侧的浏览器取证负责，不把 Chrome 依赖塞进 preflight。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');

/** 宿主那边的红绿灯右沿（DSH 文档：traffic lights 占 x 16..~68）。让位必须比它大。 */
const TRAFFIC_LIGHT_RIGHT_EDGE = 68;
const MIN_INSET = 76;

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`${pass ? '✓' : '✗'} ${label}${detail && !pass ? ' — ' + detail : ''}`);
}

/* 1. darwin 让位：padding-left 取宿主变量与 76px 的较大值 */
const insetRule = html.match(/html\[data-platform="darwin"\]\s+\.topbar\{([^}]*)\}/);
check('桌面窗口让位规则存在（html[data-platform="darwin"] .topbar）', !!insetRule, '缺 darwin 顶栏规则');
const insetBody = insetRule ? insetRule[1] : '';
const insetValue = insetBody.match(/padding-left:\s*max\(\s*var\(\s*--dsh-frame-leading-clearance\s*,\s*0px\s*\)\s*,\s*(\d+)px\s*\)/);
check('让位优先取宿主 --dsh-frame-leading-clearance，取不到用固定兜底', !!insetValue, insetBody || '(无规则)');
const fallback = insetValue ? Number(insetValue[1]) : 0;
check(`兜底宽度 ≥ ${MIN_INSET}px（红绿灯右沿 ${TRAFFIC_LIGHT_RIGHT_EDGE} + 8 间隙）`,
  fallback >= MIN_INSET && fallback > TRAFFIC_LIGHT_RIGHT_EDGE, `兜底=${fallback}px`);

/* 2. 顶栏兼作拖拽区，条内控件必须回 no-drag */
check('顶栏声明为窗口拖拽区（-webkit-app-region:drag）', /-webkit-app-region:\s*drag/.test(insetBody), insetBody || '(无规则)');
const noDrag = html.match(/html\[data-platform="darwin"\]\s+\.topbar\s+:is\(([^)]*)\)\s*\{\s*-webkit-app-region:\s*no-drag/);
check('条内控件回 no-drag（按钮/输入框仍可点）', !!noDrag, '缺 no-drag 白名单');
check('no-drag 白名单覆盖 button 与 input',
  !!noDrag && /button/.test(noDrag[1]) && /input/.test(noDrag[1]), noDrag ? noDrag[1] : '');

/* 3. 全屏时红绿灯收起，让位带必须跟着撤 */
const fsRule = html.match(/html\[data-platform="darwin"\]\[data-fullscreen\]\s+\.topbar\{([^}]*)\}/);
check('全屏回落规则存在（[data-fullscreen]）', !!fsRule, '缺 fullscreen 回落');
check('全屏回落回 20px', !!fsRule && /padding-left:\s*20px/.test(fsRule[1]), fsRule ? fsRule[1] : '');

/* 4. 顶栏不折行：折行会把固定 56px 的条撑破、h1 被窗口上沿切掉 */
const nowrap = html.match(/\.topbar\s+:is\(([^)]*)\)\s*\{\s*white-space:\s*nowrap/);
check('顶栏关键文本禁止折行', !!nowrap, '缺 white-space:nowrap 规则');
check('nowrap 覆盖品牌标题与副标题',
  !!nowrap && /\bh1\b/.test(nowrap[1]) && /\.brand p/.test(nowrap[1]), nowrap ? nowrap[1] : '');
const narrow = html.match(/@media\s*\(max-width:1200px\)\s*\{\s*\.brand p\{display:none\}\s*\}/);
check('900–1200px 收起副标题（原来这段没有断点）', !!narrow, '缺 1200px 断点');

/* 5. 嵌入模式收起副标题：选择器必须对上真实 DOM（2026-11-27 前这里是 .brand-sub 死选择器） */
check('嵌入模式用 #brand-sub（不是 .brand-sub）',
  /html\[data-embed="1"\]\s+#brand-sub\{display:none\}/.test(html), '嵌入模式收副标题的规则没对上 id');
check('整个页面不再出现 .brand-sub 选择器', !/\.brand-sub\s*\{/.test(html), '还有残留的 .brand-sub 选择器');
check('DOM 里确实有 id="brand-sub"', /<p id="brand-sub"/.test(html), '副标题元素被改名或删了');

/* 6. preload 没挂上时的兜底：只在外壳协议 + 独立窗口 + macOS 三条件同时成立时补标记，
   否则 web 直开会被凭空加出 76px 左边距 */
const fallbackJs = html.match(/location\.protocol === 'dsh-app:' && !document\.documentElement\.dataset\.platform/);
check('JS 兜底补 data-platform（插件窗口未挂 preload 时）', !!fallbackJs, '缺 data-platform 兜底');
check('兜底限定 macOS 且非嵌入窗口',
  /!EMBEDDED && location\.protocol === 'dsh-app:'/.test(html) && /\/mac\/i\.test\(plat\)/.test(html), '兜底条件不完整');

/* 7. 主区 iframe 那条路（用户 2026-11-27 截图命中的就是这条）：
   侧栏收起时面板贴窗口左上角，红绿灯与 shell.leading 座上的控件由宿主画在面板之上，
   让位带宽在宿主 :root 上 —— 同源才读得到，必须镜像到本文档，否则 CSS 拿不到值。 */
check('嵌入主区时镜像宿主窗口 chrome（adoptHostWindowChrome）',
  /function adoptHostWindowChrome\(/.test(html), '缺 iframe 路径的让位逻辑');
check('镜像只在宿主 darwin 下生效',
  /host\.dataset\.platform !== 'darwin'/.test(html), '没校验宿主平台');
check('镜像要求面板贴窗口左上角（不贴就不让位）',
  /box\.left > 2 \|\| box\.top > 2/.test(html), '没校验 iframe 位置');
check('镜像把宿主的 --dsh-frame-leading-clearance 写进本文档',
  /getPropertyValue\('--dsh-frame-leading-clearance'\)/.test(html)
  && /setProperty\('--dsh-frame-leading-clearance', clearance\)/.test(html), '没回写让位带');
check('侧栏开合（resize）后重新让位',
  /addEventListener\('resize', adoptHostWindowChrome/.test(html), '缺 resize 重算');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
