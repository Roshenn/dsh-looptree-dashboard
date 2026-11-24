#!/usr/bin/env node
/**
 * ui-evidence.mjs — 六席用户评审团的取证器（本仓库适配）
 *
 *   npm run evidence:ui -- --slug panel
 *   node scripts/ui-evidence.mjs --slug panel --theme light
 *   node scripts/ui-evidence.mjs --url http://127.0.0.1:4173/ --slug panel   # 用已有服务
 *
 * 做什么：
 *   1) 起 serve.mjs（随机端口，127.0.0.1），或用 --url 指定已有目标
 *   2) agent-browser 采集：三视口 / 详情 / 备选主题 / 菜单 / 空态 / 动效录制
 *   3) ffmpeg 抽帧 + contact sheet + 硬切计数
 *   4) 写 MANIFEST.json（含 git HEAD、web/ 最后提交时间、工具版本、失败项）
 *
 * 输出：~/.dsh/outbox/gate/<YYYY-MM-DD>-<slug>/
 * 原则：任何一步失败都记进 failures[]，不静默跳过、不拿别的状态冒充；脚本自身退 0，
 *       证据完整度以 MANIFEST 为准（这样它永远可以安全地手动跑，不阻塞别的流程）。
 *
 * 不进入 npm run preflight：取证依赖本机 Chrome + agent-browser，属交付前的按需动作。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const flag = (name) => argv.includes('--' + name)

const slug = String(opt('slug', 'panel')).replace(/[^a-zA-Z0-9._-]/g, '-')
const theme = String(opt('theme', 'light'))
const fixedUrl = opt('url', null)
const keepServer = flag('keep')
const port = Number(opt('port', 0)) || 4300 + Math.floor(Math.random() * 600)

const failures = []
const notes = []
const HARNESS_NOTES = [
  'serve.mjs 开发替身：/api/workspaces 未实现，＋项目 弹窗报 HTTP 404 属替身限制，不是产品缺陷',
  'serve.mjs 开发替身：顶栏「未连接保存服务」在错误态截图里出现，属替身无宿主写入能力，不是产品缺陷',
  '默认主题是 dark；alt-theme.png 是点击 #btn-theme 后的 light',
  '动效证据在 motion/：contact-*.png（整段 3fps）、contact-*-onset.png（起始 1.2s 10fps）、anims.json（真实 duration/easing）、frames/',
  'anims.json 只记录触发瞬间仍在跑的过渡；延迟启动的过渡可能漏记，以 contact-*-onset.png / frames 和代码摘录里的 transition 声明为准'
]
const fail = (step, reason) => failures.push({ step, reason: String(reason || '').slice(0, 400) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowLocalDate = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const rel = (p) => p.replace(/\\/g, '/').split('/' + slug + '/').pop()

/** agent-browser eval 会把返回值再 JSON 编一次；剥掉一层并校验，保证 metrics.json 可被直接读。 */
function normalizeEval(raw) {
  const s = String(raw).trim()
  try {
    const once = JSON.parse(s)
    const value = typeof once === 'string' ? JSON.parse(once) : once
    return JSON.stringify(value, null, 2)
  } catch {
    return s
  }
}

function sh(cmd, args, { input, timeout = 90000 } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    input,
    shell: IS_WIN,
    maxBuffer: 32 * 1024 * 1024
  })
  return { ok: r.status === 0, code: r.status, out: r.stdout || '', err: r.stderr || '', signal: r.signal }
}

// ── 工具探测 ──────────────────────────────────────────────────────────────
const abVersion = sh('agent-browser', ['--version'], { timeout: 15000 })
const abOk = abVersion.ok
if (!abOk) fail('probe', 'agent-browser 不可用：' + (abVersion.err || abVersion.signal || 'not found'))
const ffVersion = sh('ffmpeg', ['-version'], { timeout: 15000 })
const ffOk = ffVersion.ok
if (!ffOk) fail('probe', 'ffmpeg 不可用，动效 contact sheet 跳过：' + (ffVersion.err || 'not found'))

function ab(args, opts) {
  if (!abOk) return null
  const r = sh('agent-browser', args, opts)
  if (!r.ok) fail('agent-browser ' + args.join(' ').slice(0, 120), r.err || r.signal || 'exit ' + r.code)
  return r.ok ? r.out : null
}

// ── 证据包目录 ────────────────────────────────────────────────────────────
const bundle = join(homedir(), '.dsh', 'outbox', 'gate', `${nowLocalDate()}-${slug}`)
const dirs = {
  root: bundle,
  shots: join(bundle, 'shots'),
  state: join(bundle, 'state'),
  motion: join(bundle, 'motion'),
  frames: join(bundle, 'motion', 'frames'),
  snapshot: join(bundle, 'snapshot')
}

// ── 服务 ──────────────────────────────────────────────────────────────────
async function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'serve.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  const url = `http://127.0.0.1:${port}/`
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('serve.mjs 提前退出：' + logs.join('').slice(0, 400))
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return { child, url, logs }
    } catch {}
    await sleep(250)
  }
  throw new Error('serve.mjs 15s 内未就绪：' + logs.join('').slice(0, 400))
}

// ── 测量器（与体验门禁同口径，追加 inventory） ───────────────────────────
const METRICS_JS = `(() => {
const q = s => [...document.querySelectorAll(s)];
const vis = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
const parseColor = c => { const s = String(c).trim();
  if (s.startsWith('rgb')) { const body = s.slice(s.indexOf('(') + 1, s.indexOf(')'));
    const p = body.split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  if (s.startsWith('color(srgb')) { const body = s.slice(s.indexOf('srgb') + 4, s.indexOf(')')).trim();
    const seg = body.split('/'); const v = seg[0].trim().split(' ').filter(Boolean).map(Number);
    return { r: v[0] * 255, g: v[1] * 255, b: v[2] * 255, a: seg[1] ? Number(seg[1]) : 1 }; }
  if (s.startsWith('#')) { const h = s.slice(1); const f = h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6);
    return { r: parseInt(f.slice(0, 2), 16), g: parseInt(f.slice(2, 4), 16), b: parseInt(f.slice(4, 6), 16), a: 1 }; }
  return null; };
const REL = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const lum = p => 0.2126 * REL(p.r) + 0.7152 * REL(p.g) + 0.0722 * REL(p.b);
const bgOf = el => { for (let n = el; n; n = n.parentElement) {
  const p = parseColor(getComputedStyle(n).backgroundColor); if (p && p.a === 1) return p; }
  return { r: 255, g: 255, b: 255, a: 1 }; };
const contrast = (fgRaw, bg) => { const f = parseColor(fgRaw); if (!f) return null;
  const mix = { r: f.r * f.a + bg.r * (1 - f.a), g: f.g * f.a + bg.g * (1 - f.a), b: f.b * f.a + bg.b * (1 - f.a) };
  const [x, y] = [lum(mix), lum(bg)].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
const path = el => { const parts = []; let n = el;
  while (n && n.nodeType === 1 && parts.length < 6) {
    if (n.id) { parts.unshift('#' + n.id); break; }
    let s = n.tagName.toLowerCase();
    const p = n.parentElement;
    if (p) { const sibs = [...p.children].filter(c => c.tagName === n.tagName);
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')'; }
    parts.unshift(s); n = p; }
  return parts.join(' > '); };

const out = { url: location.href, viewport: [innerWidth, innerHeight],
  theme: document.documentElement.dataset.theme || document.body.dataset.theme || '' };
out.horizontalOverflow = document.documentElement.scrollWidth > innerWidth + 1;
out.smallTargets = q('a,button,[role="button"],input,select,summary').filter(vis).map(el => {
  const r = el.getBoundingClientRect();
  return r.width < 24 || r.height < 24
    ? { el: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 24),
        w: Math.round(r.width), h: Math.round(r.height), path: path(el) } : null; }).filter(Boolean).slice(0, 40);
out.lowContrast = q('body *').filter(el => !el.childElementCount && (el.textContent || '').trim() && vis(el)).map(el => {
  const cs = getComputedStyle(el), size = parseFloat(cs.fontSize), weight = +cs.fontWeight || 400;
  const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
  const r = contrast(cs.color, bgOf(el));
  return (r !== null && r < need) ? { text: el.textContent.trim().slice(0, 24), ratio: r, need, path: path(el) } : null;
}).filter(Boolean).slice(0, 40);
out.animations = document.getAnimations().map(a => { const t = (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming() : {};
  return { name: a.animationName || a.transitionProperty || a.constructor.name,
           duration: Math.round(t.duration || 0), easing: t.easing, iterations: t.iterations };
}).filter(a => a.duration > 0).slice(0, 60);
out.inventory = q('body *').filter(vis).map(el => {
  const r = el.getBoundingClientRect();
  const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const interactive = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName) || el.getAttribute('role');
  if (!text && !interactive) return null;
  return { path: path(el), tag: el.tagName.toLowerCase(), text,
           w: Math.round(r.width), h: Math.round(r.height) };
}).filter(Boolean).slice(0, 260);
window.__gate = { frames: [] };
const t0 = performance.now();
const tick = now => { window.__gate.frames.push(now);
  if (now - t0 < 2000) return requestAnimationFrame(tick);
  const s = window.__gate.frames, gaps = s.slice(1).map((v, i) => v - s[i]).sort((a, b) => a - b);
  window.__gate.frameGaps = { n: gaps.length, p50: +gaps[gaps.length >> 1].toFixed(1),
    p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1) }; };
requestAnimationFrame(tick);
return JSON.stringify(out);
})()`


// 动效台账：逐个触发后立刻读 getAnimations。返回真实 duration / delay / easing / target。
const MOTION_ANIMS_JS = `(async () => {
const out = {};
const nameOf = el => {
  if (!el) return null;
  const id = el.id ? '#' + el.id : '';
  const cls = (typeof el.className === 'string' && el.className.trim())
    ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
  return (id + cls) || el.tagName.toLowerCase();
};
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
const grab = async (label, fn) => {
  fn();
  await new Promise(r => setTimeout(r, 120));   // 详情/弹窗的 data-show 走 60ms 定时器，晚一点再读
  await frame();                       // 等 rAF 之后的样式提交：detail/弹窗的过渡是下一帧才起
  out[label] = document.getAnimations().map(a => {
    const t = (a.effect && a.effect.getComputedTiming) ? a.effect.getComputedTiming() : {};
    return { name: a.animationName || a.transitionProperty || a.constructor.name,
      duration: Math.round(t.duration || 0), delay: Math.round(t.delay || 0),
      easing: t.easing, target: nameOf(a.effect && a.effect.target) };
  }).filter(a => a.duration > 0);
  await frame();
};
await grab('open-detail', () => document.querySelector('.tnode').click());
document.querySelectorAll('#detail-x, .detail-close').forEach(b => b.click());
await frame();
await grab('add-project-modal', () => document.querySelector('#add-project').click());
document.querySelectorAll('.modal:not([hidden]) .modal-x, #ask-x').forEach(b => b.click());
await frame();
await grab('theme-toggle', () => document.querySelector('#btn-theme').click());
await frame();
document.querySelector('#btn-theme').click();
return JSON.stringify(out);
})()`

async function main() {
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true })

  let server = null
  let url = fixedUrl
  if (!url) {
    try {
      server = await startServer()
      url = server.url
      notes.push('serve.mjs on ' + url)
      notes.push(...HARNESS_NOTES)
    } catch (e) {
      fail('server', e.message)
      await writeManifest(null)
      console.log('⚠ 无法取证：' + e.message)
      console.log('  已写失败清单：' + join(bundle, 'MANIFEST.json'))
      process.exit(0)
    }
  }

  if (abOk) {
    // 清掉上一次运行残留的拦截规则：route 会粘在 browser session 上，导致本次全是 about:blank/空页
    ab(['network', 'unroute'])
    ab(['open', url])
    ab(['wait', '--load', 'networkidle'], { timeout: 30000 })

    // 1) 三视口
    for (const [w, h, name] of [[1440, 900, 'desktop-list'], [390, 844, 'mobile-list'], [320, 800, 'narrow-list']]) {
      ab(['set', 'viewport', String(w), String(h)])
      ab(['wait', '300'])
      ab(['screenshot', join(dirs.shots, name + '.png')])
    }

    // 2) 详情（桌面）
    ab(['set', 'viewport', '1440', '900'])
    ab(['wait', '300'])
    ab(['click', '.tnode'])
    ab(['wait', '600'])
    ab(['screenshot', join(dirs.shots, 'desktop-detail.png')])
    ab(['click', '#detail-x'])
    ab(['wait', '400'])

    // 3) 备选主题
    ab(['click', '#btn-theme'])
    ab(['wait', '500'])
    ab(['screenshot', join(dirs.shots, 'alt-theme.png')])
    ab(['click', '#btn-theme'])
    ab(['wait', '400'])

    // 4) 菜单 / 弹窗（modal-menu 区域）
    // serve.mjs 是开发替身：/api/workspaces 未实现，＋项目 弹窗会显示 HTTP 404。
    // 这是替身限制，不是产品缺陷（已写进 MANIFEST.notes）。
    ab(['click', '#add-project'])
    ab(['wait', '600'])
    ab(['screenshot', join(dirs.shots, 'modal-add-project.png')])
    ab(['press', 'Escape'])
    ab(['wait', '300'])

    // 5) 空态：筛选无结果
    ab(['fill', '#search', 'zzqqxx'])
    ab(['wait', '500'])
    ab(['screenshot', join(dirs.state, 'filter-empty.png')])
    ab(['fill', '#search', ''])
    ab(['wait', '400'])

    // 6) 测量器 + 元素清单 + a11y 树（干净状态）
    ab(['reload'])
    ab(['wait', '--load', 'networkidle'], { timeout: 30000 })
    ab(['set', 'viewport', '1440', '900'])
    ab(['wait', '400'])
    const metrics = ab(['eval', '--stdin'], { input: METRICS_JS, timeout: 60000 })
    if (metrics) {
      const raw = normalizeEval(metrics)
      await writeFile(join(bundle, 'metrics.json'), raw, 'utf8')
      // 派生两份小文件：席位不该整份啃 metrics.json
      try {
        const m = JSON.parse(raw)
        if (Array.isArray(m.inventory)) await writeFile(join(bundle, 'inventory.json'), JSON.stringify(m.inventory, null, 1) + '\n', 'utf8')
        const summary = {
          url: m.url, viewport: m.viewport, theme: m.theme,
          horizontalOverflow: m.horizontalOverflow, frameGaps: m.frameGaps,
          counts: {
            smallTargets: (m.smallTargets || []).length,
            lowContrast: (m.lowContrast || []).length,
            animationsAtRest: (m.animations || []).length,
            inventory: (m.inventory || []).length
          },
          lowContrast: (m.lowContrast || []).slice(0, 10),
          smallTargets: (m.smallTargets || []).slice(0, 20)
        }
        await writeFile(join(bundle, 'metrics-summary.json'), JSON.stringify(summary, null, 1) + '\n', 'utf8')
      } catch (e) { fail('derive metrics', e.message) }
    }
    ab(['wait', '2600'])
    const gaps = ab(['eval', '--stdin'], { input: 'JSON.stringify({ frameGaps: (window.__gate && window.__gate.frameGaps) || null })', timeout: 30000 })
    if (gaps && metrics) {
      try {
        const parsed = JSON.parse(gaps)
        const g = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
        const mPath = join(bundle, 'metrics.json')
        const m = JSON.parse(await readFile(mPath, 'utf8'))
        m.frameGaps = g.frameGaps
        await writeFile(mPath, JSON.stringify(m, null, 2), 'utf8')
      } catch (e) { fail('frameGaps', e.message) }
    }
    const a11y = ab(['snapshot', '--json'], { timeout: 60000 })
    if (a11y) await writeFile(join(dirs.snapshot, 'a11y.json'), a11y, 'utf8')
    // 动效台账：JS 触发 + 立刻读 getAnimations，拿到真实 duration / easing / delay / target
    const anims = ab(['eval', '--stdin'], { input: MOTION_ANIMS_JS, timeout: 60000 })
    if (anims) await writeFile(join(dirs.motion, 'anims.json'), normalizeEval(anims), 'utf8')
    ab(['reload'])
    ab(['wait', '--load', 'networkidle'], { timeout: 30000 })

    // 6.5) 窄屏横向溢出（WCAG 1.4.10）
    ab(['set', 'viewport', '320', '800'])
    ab(['wait', '500'])
    const narrow = ab(['eval', '--stdin'], {
      input: 'JSON.stringify({ innerWidth, scrollWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 })',
      timeout: 30000
    })
    if (narrow) await writeFile(join(bundle, 'narrow.json'), normalizeEval(narrow), 'utf8')
    ab(['set', 'viewport', '1440', '900'])
    ab(['wait', '300'])

    // 7) 动效录制（每段 ≥3.5s，保证 fps=3 能拼 3x3）
    const motion = [
      ['open-detail', [['click', '.tnode'], ['wait', '1200'], ['click', '#detail-x'], ['wait', '1500']]],
      ['add-menu', [['click', '#add-project'], ['wait', '1500'], ['press', 'Escape'], ['wait', '1500']]],
      ['theme-toggle', [['click', '#btn-theme'], ['wait', '1800'], ['click', '#btn-theme'], ['wait', '1800']]]
    ]
    for (const [name, actions] of motion) {
      const started = ab(['record', 'start', join(dirs.motion, name + '.webm')])
      if (started === null) { fail('record ' + name, 'record start 失败'); continue }
      for (const a of actions) ab(a)
      ab(['record', 'stop'])
      await sleep(200)
    }

    // 8) 错误态（最后做：route 会一直生效）
    ab(['network', 'route', '**/api/**', '--abort'])
    ab(['reload'])
    ab(['wait', '1500'])
    ab(['screenshot', join(dirs.state, 'error.png')])
    // 面板在接口全挂时回退静态 cards.js，错误态可能与默认首屏逐像素相同。
    // 相同就如实记失败，不把「没拍到错误态」当成「界面没有错误态」。
    try {
      const a = await readFile(join(dirs.shots, 'desktop-list.png'))
      const b = await readFile(join(dirs.state, 'error.png'))
      if (a.equals(b)) {
        fail('state/error.png', '错误态未产出：接口中断后面板回退静态 cards.js，与默认首屏逐像素相同')
        notes.push('错误态证据缺失：state/error.png 与 shots/desktop-list.png 相同，仅 modal-add-project.png 可作错误弹窗证据')
      }
    } catch (e) { fail('state/error 对比', e.message) }
    ab(['network', 'unroute'])
  }

  // 9) ffmpeg：contact sheet + 帧 + 硬切
  if (ffOk) {
    let names = []
    try {
      names = (await readdir(dirs.motion)).filter((n) => n.endsWith('.webm')).map((n) => n.replace(/\.webm$/, ''))
    } catch {}
    for (const name of names) {
      const wm = join(dirs.motion, name + '.webm')
      const contact = sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', wm, '-vf', 'fps=3,scale=360:-1,tile=3x3', '-frames:v', '1', join(dirs.motion, 'contact-' + name + '.png')])
      if (!contact.ok) fail('contact ' + name, contact.err)
      // 转场起始 1.2s 高帧率条带（10fps × 12 帧）：判缓动/位移/透明度用，3fps 的整段拼图看不到过渡本身
      const onset = sh('ffmpeg', ['-y', '-loglevel', 'error', '-t', '1.2', '-i', wm, '-vf', 'fps=10,scale=300:-1,tile=4x3', '-frames:v', '1', join(dirs.motion, 'contact-' + name + '-onset.png')])
      if (!onset.ok) fail('onset ' + name, onset.err)
      const frames = sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', wm, '-vf', 'fps=4,scale=360:-1', join(dirs.frames, name + '-%02d.png')])
      if (!frames.ok) fail('frames ' + name, frames.err)
      const cut = sh('ffmpeg', ['-i', wm, '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'])
      const cuts = ((cut.err || '') + (cut.out || '')).split('\n').filter((l) => l.includes('pts_time')).length
      notes.push(`motion ${name}: hardcuts=${cuts}`)
    }
  }

  await writeManifest(url)
  if (server && !keepServer) server.child.kill('SIGTERM')
  if (server && keepServer) notes.push('服务保留：' + url + '（pid ' + server.child.pid + '）')

  const okCount = Object.values(dirs)
  console.log('证据包：' + bundle)
  if (failures.length) {
    console.log('⚠ 失败 ' + failures.length + ' 项（见 MANIFEST.json→failures）：')
    for (const f of failures.slice(0, 8)) console.log('  - ' + f.step + ' :: ' + f.reason)
  } else {
    console.log('✓ 采集完成，无失败项')
  }
  for (const n of notes) console.log('  · ' + n)

  async function writeManifest(targetUrl) {
    const gitHead = sh('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { timeout: 15000 })
    const webCommit = sh('git', ['-C', ROOT, 'log', '-1', '--format=%ct', '--', 'web/'], { timeout: 15000 })
    const dirty = sh('git', ['-C', ROOT, 'status', '--porcelain'], { timeout: 15000 })
    let files = []
    try {
      files = (await readdir(bundle, { recursive: true })).filter((f) => /\.(png|json|webm)$/.test(f)).sort()
    } catch {}
    const manifest = {
      slug,
      url: targetUrl || null,
      capturedAt: new Date().toISOString(),
      theme: { requested: theme, captured: 'default (dark)', alternate: 'light via #btn-theme' },
      viewports: [['1440x900', 'desktop-list'], ['390x844', 'mobile-list'], ['320x800', 'narrow-list']],
      gitHead: gitHead.ok ? gitHead.out.trim() : null,
      gitDirty: dirty.ok ? dirty.out.trim().split('\n').filter(Boolean).length > 0 : null,
      webLastCommitAt: webCommit.ok ? Number(webCommit.out.trim()) : null,
      tools: {
        node: process.version,
        agentBrowser: abOk ? (abVersion.out || abVersion.err).trim().split('\n')[0] : null,
        ffmpeg: ffOk ? (ffVersion.out || '').trim().split('\n')[0] : null
      },
      files,
      failures,
      notes
    }
    await writeFile(join(bundle, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8')
    const fresh = manifest.webLastCommitAt
      ? Math.floor(Date.parse(manifest.capturedAt) / 1000) > manifest.webLastCommitAt
      : null
    if (fresh === false) fail('freshness', '证据时间早于 web/ 最后一次提交，必须重拍')
    return manifest
  }
}

main().catch(async (e) => {
  fail('fatal', e && e.stack ? e.stack.slice(0, 600) : e)
  try {
    await writeFile(join(bundle, 'MANIFEST.json'), JSON.stringify({ slug, failures, notes }, null, 2), 'utf8')
  } catch {}
  console.error('取证失败：' + (e && e.message))
  console.error('已写：' + join(bundle, 'MANIFEST.json'))
  process.exit(0)
})
