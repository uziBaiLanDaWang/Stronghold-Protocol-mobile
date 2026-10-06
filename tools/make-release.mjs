// tools/make-release.mjs — turn the built APK into a distributable release bundle.
//
//   node tools/make-offline.mjs --with-assets     # the static tree (page + engine + art)
//   node tools/make-android-apk.mjs               # the APK
//   node tools/make-release.mjs                   # -> dist/release/<name>.zip
//
// The bundle mirrors what the project's own GitHub Releases ship for the desktop build: one zip a player can hand
// to someone else. It carries the APK, a short install note and a checksum, so the recipient needs nothing else -
// no Node, no server, no assets.
//
// The zip is written with the JDK's `jar` (streaming, no dependency, handles the 255 MB APK); the JDK is located
// the same way tools/make-android-apk.mjs locates it.

import {
  existsSync, mkdirSync, readdirSync, statSync, copyFileSync, writeFileSync, rmSync, realpathSync, createReadStream,
  openSync, closeSync, readSync, fstatSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APK_DIR = path.join(ROOT, 'dist', 'android');
const OUT = path.join(ROOT, 'dist', 'release');

const args = process.argv.slice(2);
const NAME = (() => {
  const i = args.indexOf('--name');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const die = (msg) => { console.error(`\n${msg}`); process.exit(2); };

/**
 * The JDK's bin directory, resolved from the filesystem only (see tools/make-android-apk.mjs).
 *
 * It must hold BOTH javac and jar: a bare `jar.exe` on PATH is not enough - MinGW ships one that is not a JDK tool,
 * and Oracle's `javapath` shim directory holds javac but no jar.
 */
function javaHomeBin() {
  const suf = process.platform === 'win32' ? '.exe' : '';
  const usable = (bin) => !!bin && ['javac', 'jar'].every((t) => existsSync(path.join(bin, t + suf)));
  if (process.env.JAVA_HOME && usable(path.join(process.env.JAVA_HOME, 'bin'))) return path.join(process.env.JAVA_HOME, 'bin');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const shim = path.join(dir, 'javac' + suf);
    if (existsSync(shim)) {
      try {
        const bin = path.dirname(realpathSync(shim));   // resolve a shim into the JDK it points at
        if (usable(bin)) return bin;
      } catch { /* unreadable shim */ }
    }
    if (usable(dir)) return dir;
  }
  for (const guess of [
    process.platform === 'win32' ? process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java') : null,
    process.platform === 'win32' ? process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium') : null,
    process.platform !== 'win32' ? '/usr/lib/jvm' : null,
    process.platform === 'win32' ? 'D:\\jdk-25' : null,     // where the local `java` shim points
  ].filter(Boolean)) {
    if (!existsSync(guess)) continue;
    if (usable(guess)) return guess;
    if (usable(path.join(guess, 'bin'))) return path.join(guess, 'bin');
    for (const entry of readdirSync(guess)) {
      const bin = path.join(guess, entry, 'bin');
      if (usable(bin)) return bin;
    }
  }
  return null;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * The zip's entry names, read from its central directory - no child process and no pipe, so this works in a
 * confined environment too (and it is how the Chinese readme's name can be verified end to end).
 * @returns {string[]}
 */
function zipEntryNames(file) {
  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 1024 * 1024);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) die(`${file} is not a zip`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);
    const names = [];
    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(off) !== SIG_CENTRAL) break;
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      names.push(cd.toString('utf8', off + 46, off + 46 + nameLen).replace(/^\.\//, ''));
      off += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

const README = (apkName, appVersion) => `卫戍协议：盟约 · 安卓离线版 ${appVersion}
=====================================================

这是什么
--------
「卫戍协议：盟约」的非官方同人复刻版，打包成安卓 App。整局游戏（回合、经济、商店、敌人波次、
战斗模拟）都在手机本地运行，**不需要电脑、不需要开服务器、不需要联网**。

- 零权限：这个 App 没有申请任何安卓权限（没有 INTERNET），素材和引擎都在安装包里。
- 单人「独立模拟」完整体验；同盟联机需要用仓库里的服务端（本包不含）。
- 素材版权归鹰角网络 / Yostar 所有，仅供个人学习交流，严禁任何形式的盈利。

安装
----
1. 把 ${apkName} 传到手机（数据线、微信文件传输、网盘都行）。
2. 在手机上点它安装。首次会提示「允许安装未知应用」，同意即可。
   （HyperOS / MIUI 可能还会提示风险扫描，选择「继续安装」。）
3. 如果之前装过旧版本且提示签名不一致，先卸载旧的再安装。

怎么玩
------
打开后是横屏全屏。输入代号 → 开始 → 独立模拟 → 开始独立模拟 → 开始模拟。

说明与已知情况
--------------
- 只支持横屏（竖屏会显示「请将设备横屏」，和网页版一致）。
- 首次进入对局要读取几百 MB 素材，第一下可能稍慢；之后正常。
- 这个包把游戏界面的安全区边距压成了 0（UI 与棋盘一样满屏出血）。
- 因为无法访问真机调试，App 内置了一个诊断面板：只有在页面启动失败时才会出现，
  点一下即可关闭。正常游玩看不到它。
- 想从电脑看运行中的页面：手机开 USB 调试后，电脑 Chrome 打开 chrome://inspect。

构建信息
--------
本项目为实验性打包：APK 由 tools/make-android-apk.mjs 用 Android SDK 的 build-tools 直接构建
（不需要 Gradle / Android Studio），签名使用调试密钥（自签名，仅用于侧载）。
本包含：${apkName}
`;

async function main() {
  console.log('packaging the release bundle\n');

  if (!existsSync(APK_DIR)) die('dist/android is missing. Run:  node tools/make-android-apk.mjs');
  const apks = readdirSync(APK_DIR).filter((n) => n.endsWith('.apk') && !/^(base|dexed|aligned)/.test(n));
  if (!apks.length) die('no APK found in dist/android. Run:  node tools/make-android-apk.mjs');
  const apkName = apks.sort((a, b) => statSync(path.join(APK_DIR, b)).mtimeMs - statSync(path.join(APK_DIR, a)).mtimeMs)[0];
  const apkPath = path.join(APK_DIR, apkName);
  const apkBytes = statSync(apkPath).size;

  const jar = javaHomeBin();
  if (!jar) die('No JDK found (needs jar to write the zip). Set JAVA_HOME and retry.');

  // The bundle name follows the project's own release convention.
  const appVersion = /(\d+\.\d+\.\d+)/.exec(apkName)?.[1] ?? '0.0.0';
  const bundle = NAME || `Stronghold-Protocol-Offline-Android-${appVersion}`;

  rmSync(OUT, { recursive: true, force: true });
  const stage = path.join(OUT, bundle);
  mkdirSync(stage, { recursive: true });

  const digest = await sha256(apkPath);
  copyFileSync(apkPath, path.join(stage, apkName));
  writeFileSync(path.join(stage, '安装说明.txt'), README(apkName, appVersion), 'utf8');
  writeFileSync(path.join(stage, 'SHA256.txt'), `${digest}  ${apkName}\n`, 'utf8');

  console.log(`  ok   APK        ${apkName}  (${mb(apkBytes)})`);
  console.log(`  ok   sha256     ${digest.slice(0, 32)}...`);
  console.log(`  ok   readme     安装说明.txt`);

  // jar c0fM: c = create, 0 = STORE (no deflate), f = file, M = no manifest. Storing is the right choice here: the
  // APK inside is already a deflate archive, so compressing again costs time and saves ~3%.
  const zipPath = path.join(OUT, `${bundle}.zip`);
  execFileSync(path.join(jar, process.platform === 'win32' ? 'jar.exe' : 'jar'),
    ['c0fM', zipPath, '-C', stage, '.'], { stdio: ['ignore', 'inherit', 'inherit'] });

  const zipBytes = statSync(zipPath).size;
  // With STORE the bundle is the APK plus the two small text files, so it must be a little LARGER than the APK.
  if (zipBytes < apkBytes) die(`the zip (${mb(zipBytes)}) is smaller than the APK (${mb(apkBytes)}) - packaging failed`);

  const entries = zipEntryNames(zipPath);
  const missing = [apkName, '安装说明.txt', 'SHA256.txt'].filter((n) => !entries.includes(n));
  if (missing.length) die(`the zip is missing: ${missing.join(', ')}`);
  console.log(`  ok   verified   ${entries.length} entries: ${entries.join('  ')}`);

  rmSync(stage, { recursive: true, force: true });      // the zip is the deliverable

  console.log(`  ok   zip        ${path.relative(ROOT, zipPath)}  (${mb(zipBytes)})`);
  console.log(`\nrelease bundle: ${path.relative(ROOT, zipPath)}`);
  console.log('contents: the APK, 安装说明.txt, SHA256.txt');
}

await main();
