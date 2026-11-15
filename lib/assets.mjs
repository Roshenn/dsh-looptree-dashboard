/**
 * lib/assets.mjs — 附件（图片）存取：内容寻址、零依赖。
 *
 * 存哪：`<workspace>/.dsh/rotation-assets/<sha256>.<png|jpg|webp>`
 * 卡片里只存元数据（`sha` / `path` / `name` / `mime` / `bytes` / `w` / `h` / `at` / `alt?`）。
 *
 * 为什么按内容哈希：同一张截图被多个节点引用时只落一份；上传重试天然幂等；
 * 文件名不带用户输入，GET 只需要 sha，不存在路径穿越面。
 *
 * 与 DSH 自己的 `~/.dsh/attachments/v1/objects/<前两位>/<sha>` 同一思路（内容寻址），
 * 这里用扁平目录 + 扩展名，方便人工浏览与静态 MIME。
 *
 * 只在 host 半使用（lib/index.js / serve.mjs / scripts/gc-assets.mjs）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export const ASSET_REL_DIR = '.dsh/rotation-assets';
export const ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const ASSET_MAX_PER_NODE = 12;
export const ASSET_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const ASSET_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const SHA_RE = /^[a-f0-9]{64}$/;

export function isSafeSha(sha) {
  return SHA_RE.test(String(sha || ''));
}

/** sha + mime → 卡片里的相对路径（统一 `/`，换机器 / 换分支不失效） */
export function assetRelPath(sha, mime) {
  const ext = ASSET_EXT[mime];
  return ext ? `${ASSET_REL_DIR}/${sha}.${ext}` : '';
}

/** 相对路径 → 绝对路径；只允许落在 workspace 的 .dsh/rotation-assets/ 里 */
export function assetAbsPath(workspace, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel.startsWith(`${ASSET_REL_DIR}/`) || rel.includes('..')) {
    throw new Error('附件路径不在 .dsh/rotation-assets 下');
  }
  const base = resolve(workspace, ASSET_REL_DIR);
  const abs = resolve(workspace, rel);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error('附件路径越界');
  return abs;
}

/** magic bytes 复核：只认 png / jpeg / webp，不认扩展名与客户端声明 */
function sniffMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

/**
 * dataUrl → 二进制。只接受 png / jpeg / webp 的 base64 dataUrl。
 * 错误带 status：400（格式不对）/ 413（太大）/ 415（类型不支持）。
 */
export function decodeImageDataUrl(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const m = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(raw);
  if (!m) {
    const e = new Error('只支持 png / jpeg / webp 的 dataUrl');
    e.status = 415;
    throw e;
  }
  const mime = `image/${m[1]}`;
  const b64 = m[2].replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    const e = new Error('dataUrl 不是合法的 base64');
    e.status = 400;
    throw e;
  }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) {
    const e = new Error('图片内容为空');
    e.status = 400;
    throw e;
  }
  if (buf.length > ASSET_MAX_BYTES) {
    const e = new Error(`图片超过 ${Math.round(ASSET_MAX_BYTES / 1024 / 1024)}MB`);
    e.status = 413;
    throw e;
  }
  if (sniffMime(buf) !== mime) {
    const e = new Error('图片内容与类型不符（只支持 png / jpeg / webp）');
    e.status = 415;
    throw e;
  }
  return { buf, mime };
}

/** 展示用文件名：去掉路径与扩展名，按实际 mime 统一扩展名；≤120 字 */
export function safeImageName(name, mime) {
  const ext = ASSET_EXT[mime] || 'png';
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120)
    .replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return `${base || 'screenshot'}.${ext}`;
}

/** 原子落盘（tmp + rename）；同 sha 已存在直接复用 */
export async function saveAsset(workspace, buf, mime) {
  const sha = createHash('sha256').update(buf).digest('hex');
  const rel = assetRelPath(sha, mime);
  if (!rel) throw new Error('不支持的图片类型');
  const dir = join(workspace, ASSET_REL_DIR);
  const abs = assetAbsPath(workspace, rel);
  await mkdir(dir, { recursive: true });
  const exists = await stat(abs).then((s) => s.isFile()).catch(() => false);
  if (!exists) {
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, abs);
  }
  return { sha, path: rel, mime, bytes: buf.length, at: new Date().toISOString() };
}

/**
 * 按 sha 找已存的附件文件（不信任卡片里的 path，只用 sha + 扩展名白名单）。
 * 找不到返回 null。
 */
export async function findAssetFile(workspace, sha) {
  if (!isSafeSha(sha)) return null;
  for (const [ext, mime] of Object.entries(ASSET_MIME)) {
    const rel = `${ASSET_REL_DIR}/${sha}.${ext}`;
    const abs = assetAbsPath(workspace, rel);
    const st = await stat(abs).catch(() => null);
    if (st && st.isFile()) return { abs, ext, mime, bytes: st.size };
  }
  return null;
}

/** 扫描一个 workspace 的附件目录；只回合法命名（sha + 白名单扩展名）的文件 */
export async function listAssetFiles(workspace) {
  const dir = join(workspace, ASSET_REL_DIR);
  const names = await readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    const m = /^([a-f0-9]{64})\.(png|jpg|webp)$/.exec(name);
    if (!m) continue;
    const abs = join(dir, name);
    const st = await stat(abs).catch(() => null);
    if (st && st.isFile()) out.push({ name, sha: m[1], abs, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** 一张卡引用的全部 sha（含已达成里程碑快照）——GC 的保留集 */
export function collectAttachmentShas(card) {
  const out = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n.attachments)) {
      for (const a of n.attachments) if (a && isSafeSha(a.sha)) out.add(a.sha);
    }
    for (const kid of n.children || []) walk(kid);
  };
  walk(card && card.milestone);
  if (Array.isArray(card && card.closed_milestones)) {
    for (const entry of card.closed_milestones) walk(entry && entry.snapshot);
  }
  return out;
}
