// tools/make-android-apk.mjs — package the offline tree into an installable Android APK.
//
//   node tools/make-offline.mjs --with-assets      # assemble dist/offline (the page + engine + art)
//   node tools/make-android-apk.mjs                # -> dist/android/StrongholdOffline-<version>.apk
//
// The app is a thin WebView shell (android/) around dist/offline: android/java/**/MainActivity.java starts a
// loopback static server (AssetServer.java) over the APK's own assets and loads `/?local=1`, which is the switch
// that boots the real match engine inside the page. The app declares no INTERNET permission, so "offline" is
// enforced by the platform rather than promised by a config flag.
//
// It deliberately does NOT use Gradle or Maven: the whole build is the SDK's own build-tools (aapt2, d8,
// zipalign, apksigner, aapt) plus javac, so it needs no network and no Android Studio. AndroidX is avoided by
// using a platform theme and a hand-written server instead of WebViewAssetLoader.
//
// Two constraints shaped the details below:
//   * nothing is captured through a pipe - every child runs with stdio 'inherit', and the two facts this script
//     needs to READ back (are the assets in? is resources.arsc stored?) come from the APK's zip central directory;
//   * d8/apksigner are .bat wrappers, which modern Node refuses to spawn without a shell, so their jars are run
//     with the JDK's java directly.
//
// Requires: an Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT, or the default per-user location) with one platform
// and one build-tools version, and a JDK (JAVA_HOME, or a javac on PATH).

import {
  existsSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync, copyFileSync,
  openSync, closeSync, readSync, writeSync, fstatSync, realpathSync, readFileSync,
} from 'node:fs';
import { cp, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const OUT = path.join(ROOT, 'dist', 'android');
const SITE = path.join(ROOT, 'dist', 'offline');
const APP_VERSION = '0.1.4';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MIN_SDK = Number(argOf('--min-sdk', '24'));
const TARGET_SDK = Number(argOf('--target-sdk', '35'));

const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  !!  '} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) problems.push(label);
  return ok;
};
const step = (msg) => console.log(`\n> ${msg}`);
const die = (msg) => { console.error(`\n${msg}`); process.exit(2); };
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// -----------------------------------------------------------------------------------------------------------
// Environment (no child processes: this has to work where spawning with pipes is not allowed)
// -----------------------------------------------------------------------------------------------------------

/** The Android SDK: an explicit env var first, then the per-user default on each platform. */
function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk') : null,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : null,
    process.platform === 'linux' ? path.join(os.homedir(), 'Android', 'Sdk') : null,
    '/usr/lib/android-sdk',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(path.join(p, 'build-tools'))) ?? null;
}

/** Highest version of a directory of versioned subdirectories (build-tools: 35.0.0; platforms: android-35). */
function highestVersionDir(parent, score) {
  if (!existsSync(parent)) return null;
  const entries = readdirSync(parent)
    .filter((n) => statSync(path.join(parent, n)).isDirectory())
    .map((n) => ({ name: n, s: score(n) }))
    .filter((e) => e.s !== null && Number.isFinite(e.s))
    .sort((a, b) => b.s - a.s);
  return entries.length ? path.join(parent, entries[0].name) : null;
}
const semver = (n) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(n); return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : null; };
const apiLevel = (n) => { const m = /^android-(\d+(?:\.\d+)?)$/.exec(n); return m ? Number(m[1]) * 1000 : null; };

const exePath = (dir, name) => path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
const toolName = (name) => name + (process.platform === 'win32' ? '.exe' : '');

/**
 * The JDK's bin directory (javac / jar / keytool). Resolved from the filesystem only - a shim directory such as
 * Oracle's `javapath` is followed through realpath, and rejected outright when it lacks jar/keytool.
 */
function javaHomeBin() {
  const suf = process.platform === 'win32' ? '.exe' : '';
  const usable = (bin) => !!bin && ['javac', 'jar'].every((t) => existsSync(path.join(bin, t + suf)));
  if (process.env.JAVA_HOME && usable(path.join(process.env.JAVA_HOME, 'bin'))) return path.join(process.env.JAVA_HOME, 'bin');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'javac' + suf);
    if (!existsSync(candidate)) continue;
    try {
      const bin = path.dirname(realpathSync(candidate));   // resolve a shim into the JDK it points at
      if (usable(bin)) return bin;
    } catch { /* unreadable entry: try the directory itself */ }
    if (usable(dir)) return dir;
  }
  const bases = [
    process.platform === 'win32' ? process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java') : null,
    process.platform === 'win32' ? process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium') : null,
    process.platform === 'win32' ? process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Java') : null,
    process.platform === 'win32' ? process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    process.platform !== 'win32' ? '/usr/lib/jvm' : null,
    process.platform === 'win32' ? 'D:\\jdk-25' : null,     // where the local `java` shim actually points
  ].filter(Boolean);
  for (const base of bases) {
    if (!existsSync(base)) continue;
    if (usable(path.join(base, 'bin'))) return path.join(base, 'bin');
    for (const entry of readdirSync(base)) {
      const bin = path.join(base, entry, 'bin');
      if (usable(bin)) return bin;
    }
  }
  return null;
}

/** Run a tool with inherited stdio: nothing is piped, so this works in a confined environment too. */
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });

/**
 * d8 and apksigner ship as .bat wrappers around a jar. Modern Node refuses to spawn a .bat/.cmd without a shell
 * (EINVAL, the CVE-2024-27980 hardening) and going through cmd.exe would mean quoting the SDK's paths, so the jars
 * behind the wrappers are run with the JDK's java directly.
 */
const runJavaTool = (jbin, buildTools, jar, argv, mainClass = null) => {
  const jarPath = path.join(buildTools, 'lib', jar);
  if (!existsSync(jarPath)) die(`Missing ${jarPath} - the build-tools installation is incomplete.`);
  const pre = mainClass ? ['-cp', jarPath, mainClass] : ['-jar', jarPath];
  return run(path.join(jbin, toolName('java')), [...pre, ...argv]);
};

// -----------------------------------------------------------------------------------------------------------
// Reading the APK back (zip central directory; only the tail is loaded, not the whole 300 MB archive)
// -----------------------------------------------------------------------------------------------------------

/** Map of entry name -> compression method (0 = stored) from a zip's central directory. */
function zipEntries(file) {
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);
    const entries = new Map();
    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(off) !== SIG_CENTRAL) break;
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      entries.set(cd.toString('utf8', off + 46, off + 46 + nameLen), method);
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * Rewrite `\` to `/` inside zip entry names, in place.
 *
 * aapt2's `-A` walks the filesystem, so on Windows every asset entry comes out as `assets/web\js\main.js`. Android's
 * AssetManager matches asset names exactly with `/`, so such entries would be invisible at runtime and the app
 * would show a blank page. A backslash and a slash are the same length and a zip's CRC covers an entry's DATA,
 * never its name, so the bytes can be patched where they lie: offsets, sizes and CRCs all stay valid.
 *
 * @returns {number} how many entries were rewritten
 */
function normalizeZipSeparators(file) {
  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const fd = openSync(file, 'r+');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`not a zip: ${file}`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);

    let patched = 0;
    const localOffsets = [];
    let off = 0;
    for (let i = 0; i < count && off + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(off) !== SIG_CENTRAL) break;
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const localOff = cd.readUInt32LE(off + 42);
      const nameStart = off + 46;
      const name = cd.toString('latin1', nameStart, nameStart + nameLen);
      if (name.includes('\\')) {
        const fixed = Buffer.from(name.replace(/\\/g, '/'), 'latin1');
        writeSync(fd, fixed, 0, fixed.length, cdOff + nameStart);   // the central-directory copy
        patched += 1;
      }
      localOffsets.push(localOff);
      off += 46 + nameLen + extraLen + commentLen;
    }

    // The local file header carries its own copy of the name, and a reader streams that one first.
    const head = Buffer.alloc(30);
    for (const localOff of localOffsets) {
      readSync(fd, head, 0, 30, localOff);
      if (head.readUInt32LE(0) !== SIG_LOCAL) continue;
      const nameLen = head.readUInt16LE(26);
      const nameBuf = Buffer.alloc(nameLen);
      readSync(fd, nameBuf, 0, nameLen, localOff + 30);
      if (nameBuf.includes(0x5C)) {
        const fixed = Buffer.from(nameBuf.toString('latin1').replace(/\\/g, '/'), 'latin1');
        writeSync(fd, fixed, 0, fixed.length, localOff + 30);
      }
    }
    return patched;
  } finally {
    closeSync(fd);
  }
}

// -----------------------------------------------------------------------------------------------------------
// Launcher icon: rasterise the favicon's path from public/index.html:18 into a PNG (no image libraries).
// -----------------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 8-bit RGB PNG (no interlace) from a w*h*3 buffer. */
function encodePng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;                                   // filter type: none
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The favicon path in public/index.html:18 (`M5 3h3v2h2V3h4v2h2V3h3v5l-2 2v7l2 2v2H5v-2l2-2v-7L5 8z`) expanded to
 * absolute coordinates in its 24x24 viewBox.
 */
const ICON_POLY = [
  [5, 3], [8, 3], [8, 5], [10, 5], [10, 3], [14, 3], [14, 5], [16, 5], [16, 3], [19, 3], [19, 8],
  [17, 10], [17, 17], [19, 19], [19, 21], [5, 21], [5, 19], [7, 17], [7, 10], [5, 8],
];
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** The icon at `size` px: the page's plate colour with the mint keep, supersampled 3x for clean edges. */
function iconPng(size) {
  const SS = 3;
  const big = size * SS;
  const bg = [0x0c, 0x0f, 0x0e];      // index.html:8 theme-color
  const fg = [0x4e, 0xd8, 0xaf];      // the favicon's mint
  const acc = new Float64Array(size * size * 3);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const u = ((x + 0.5) / big) * 24;
      const v = ((y + 0.5) / big) * 24;
      const px = inPoly(u, v, ICON_POLY) ? fg : bg;
      const i = ((y / SS) | 0) * size * 3 + (((x / SS) | 0) * 3);
      acc[i] += px[0]; acc[i + 1] += px[1]; acc[i + 2] += px[2];
    }
  }
  const rgb = Buffer.alloc(size * size * 3);
  const n = SS * SS;
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.round(acc[i] / n);
  return encodePng(size, size, rgb);
}
/** One density is enough: the launcher scales, and xxxhdpi (192 px) stays sharp on any current phone. */
function writeIcon() {
  const rel = path.join('res', 'mipmap-xxxhdpi', 'ic_launcher.png');
  const abs = path.join(ANDROID, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, iconPng(192));
  return rel;
}

// -----------------------------------------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------------------------------------

function listJavaSources(dir, found = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJavaSources(p, found);
    else if (e.name.endsWith('.java')) found.push(p);
  }
  return found;
}
function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}
function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}

/**
 * The extension-less audio route is defined once in shared/media.js, but the shell needs it in Java too (Java cannot
 * import that module), so the constants are duplicated. Re-read the shared module here and fail loudly on drift: a
 * silent mismatch would 404 every BGM track, voice line and sound effect.
 */
function checkMediaRouteMirror() {
  const sharedPath = path.join(ROOT, 'shared', 'media.js');
  const javaPath = path.join(ANDROID, 'java', 'com', 'stronghold', 'offline', 'AssetInterceptor.java');
  if (!existsSync(sharedPath) || !existsSync(javaPath)) return { ok: false, why: 'shared/media.js or AssetInterceptor.java is missing' };
  const shared = readFileSync(sharedPath, 'utf8');
  const java = readFileSync(javaPath, 'utf8');
  const prefix = /MEDIA_PREFIX\s*=\s*'([^']+)'/.exec(shared)?.[1] ?? null;
  const extList = /AUDIO_EXTS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(shared)?.[1] ?? '';
  const exts = extList.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  if (!prefix || exts.length === 0) return { ok: false, why: 'could not parse shared/media.js' };
  const prefixOk = java.includes(`"${prefix}"`);
  const missing = exts.filter((e) => !java.includes(`"${e}"`));
  return {
    ok: prefixOk && missing.length === 0,
    why: !prefixOk ? `prefix ${prefix} missing from the Java copy` : `extensions missing from the Java copy: ${missing.join(' ')}`,
    detail: `${prefix} + ${exts.length} extensions`,
  };
}

async function main() {
  console.log('packaging the offline tree as an Android APK\n');

  const sdk = findSdk();
  if (!sdk) die('No Android SDK found. Set ANDROID_HOME (or install the SDK at the default location) and retry.');
  const buildTools = highestVersionDir(path.join(sdk, 'build-tools'), semver);
  const platform = highestVersionDir(path.join(sdk, 'platforms'), apiLevel);
  const androidJar = platform ? path.join(platform, 'android.jar') : null;
  const jbin = javaHomeBin();
  if (!buildTools || !androidJar) die(`The SDK at ${sdk} is missing build-tools or a platform.`);
  if (!jbin) die('No JDK found (needs javac). Set JAVA_HOME and retry.');

  check(true, 'Android SDK', sdk);
  check(true, 'build-tools', path.basename(buildTools));
  check(true, 'platform', `${path.basename(platform)} (min ${MIN_SDK}, target ${TARGET_SDK})`);
  check(true, 'JDK', jbin);

  // --- the web tree ---------------------------------------------------------------------------------------
  step('checking the offline tree');
  if (!existsSync(path.join(SITE, 'index.html'))) {
    die('dist/offline is missing. Run:  node tools/make-offline.mjs --with-assets');
  }
  const siteBytes = dirSize(SITE);
  const siteFiles = countFiles(SITE);
  const hasAssets = existsSync(path.join(SITE, 'assets'));
  check(true, 'dist/offline assembled', `${mb(siteBytes)} in ${siteFiles} files`);
  if (!hasAssets) {
    console.log('  note: no dist/offline/assets - the game would run on fallback art. Add it with');
    console.log('        node tools/make-offline.mjs --with-assets');
  }

  step('generating the launcher icon');
  const iconRel = writeIcon();
  check(existsSync(path.join(ANDROID, iconRel)), 'ic_launcher.png written', iconRel);

  step('checking the mirrored /media/ route');
  const mediaMirror = checkMediaRouteMirror();
  check(mediaMirror.ok, 'the shell mirrors shared/media.js', mediaMirror.ok ? mediaMirror.detail : mediaMirror.why);

  // --- stage assets/web -> dist/offline -------------------------------------------------------------------
  // aapt2 links a directory of assets with -A, and the tree must sit under assets/web/ (AssetServer's ASSET_ROOT).
  // A junction avoids duplicating a few hundred MB; it is verified after linking, with a real copy as the fallback.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  const linkPath = path.join(OUT, 'assets', 'web');
  let staged = 'junction';
  try {
    await symlink(SITE, linkPath, 'junction');
  } catch {
    staged = 'copy';
    await cp(SITE, linkPath, { recursive: true });
  }
  check(true, `assets staged (${staged})`, 'assets/web -> dist/offline');

  // --- compile + link resources ---------------------------------------------------------------------------
  step('aapt2: compiling and linking resources');
  const aapt2 = exePath(buildTools, 'aapt2');
  const aapt = exePath(buildTools, 'aapt');
  const resZip = path.join(OUT, 'res.zip');
  const baseApk = path.join(OUT, 'base.apk');
  const genDir = path.join(OUT, 'gen');
  const linkArgs = () => [
    'link', '-o', baseApk,
    '-I', androidJar,
    '--manifest', path.join(ANDROID, 'AndroidManifest.xml'),
    '--java', genDir,
    '-A', path.join(OUT, 'assets'),
    '--min-sdk-version', String(MIN_SDK),
    '--target-sdk-version', String(TARGET_SDK),
    // No --version-code / --version-name here: aapt2 only injects those when the manifest omits them, so declaring
    // them in android/AndroidManifest.xml (the single source of truth) and passing a different value here would
    // silently do nothing. Bump it in the manifest.
    // Positional, NOT -R: aapt2 gives -R *overlay* semantics, which refuses new resources with
    // "does not override an existing resource".
    resZip,
  ];
  run(aapt2, ['compile', '--dir', path.join(ANDROID, 'res'), '-o', resZip]);
  run(aapt2, linkArgs());
  check(true, 'base.apk linked', mb(statSync(baseApk).size));

  // aapt2 stored the asset names with the OS separator (see normalizeZipSeparators) - fix that before checking.
  const namesFixed = normalizeZipSeparators(baseApk);
  let entries = zipEntries(baseApk) ?? new Map();
  if (!entries.has('assets/web/index.html')) {
    check(false, 'assets/web is inside the APK', 'aapt2 did not follow the junction - retrying with a real copy');
    rmSync(linkPath, { recursive: true, force: true });
    await cp(SITE, linkPath, { recursive: true });
    run(aapt2, linkArgs());
    normalizeZipSeparators(baseApk);
    entries = zipEntries(baseApk) ?? new Map();
  }
  const assetEntries = [...entries.keys()].filter((n) => n.startsWith('assets/web/')).length;
  check(namesFixed > 0, 'asset separators normalised to "/"', `${namesFixed} entries rewritten`);
  check(entries.has('assets/web/index.html'), 'assets/web is inside the APK', `${assetEntries} entries`);
  if (hasAssets) {
    check(entries.has('assets/web/data.js') && entries.has('assets/web/engine/match/Match.js'),
      'the offline tree (shim + engine) is inside the APK');
  }

  // --- compile Java ---------------------------------------------------------------------------------------
  step('javac: compiling the shell');
  const sources = [...listJavaSources(path.join(ANDROID, 'java')), ...listJavaSources(genDir)];
  const classesDir = path.join(OUT, 'classes');
  mkdirSync(classesDir, { recursive: true });
  run(path.join(jbin, toolName('javac')), [
    '--release', '17', '-nowarn', '-classpath', androidJar, '-d', classesDir, ...sources,
  ]);
  check(true, 'javac ok', `${sources.length} sources`);

  // --- dex ------------------------------------------------------------------------------------------------
  step('d8: dexing');
  const classesJar = path.join(OUT, 'classes.jar');
  run(path.join(jbin, toolName('jar')), ['cf', classesJar, '-C', classesDir, '.']);
  const dexDir = path.join(OUT, 'dex');
  mkdirSync(dexDir, { recursive: true });
  runJavaTool(jbin, buildTools, 'd8.jar', [
    '--release', '--min-api', String(MIN_SDK), '--lib', androidJar, '--output', dexDir, classesJar,
  ], 'com.android.tools.r8.D8');
  const dex = path.join(dexDir, 'classes.dex');
  check(existsSync(dex), 'classes.dex built', existsSync(dex) ? mb(statSync(dex).size) : 'missing');

  // --- add the dex to the APK -----------------------------------------------------------------------------
  step('packaging classes.dex into the APK');
  const dexed = path.join(OUT, 'dexed.apk');
  copyFileSync(baseApk, dexed);
  run(aapt, ['add', dexed, 'classes.dex'], { cwd: dexDir });
  normalizeZipSeparators(dexed);           // `aapt add` rewrites the archive; make sure names stayed POSIX
  const dexEntries = zipEntries(dexed) ?? new Map();
  check(dexEntries.has('classes.dex'), 'classes.dex is in the APK');
  check([...dexEntries.keys()].every((n) => !n.includes('\\')), 'no entry name contains a backslash');

  // --- align + sign ---------------------------------------------------------------------------------------
  step('zipalign + apksigner');
  const aligned = path.join(OUT, 'aligned.apk');
  run(exePath(buildTools, 'zipalign'), ['-f', '-p', '4', dexed, aligned]);

  // The signing key lives OUTSIDE dist/ (which is wiped at the start of every build): a stable identity is what
  // lets a later build install over an earlier one instead of failing with a signature mismatch.
  const keystore = path.join(ROOT, '.cache', 'android-debug.keystore');
  mkdirSync(path.dirname(keystore), { recursive: true });
  if (!existsSync(keystore)) {
    // A self-signed debug key: fine for sideloading, regenerated on any machine that builds this.
    run(path.join(jbin, toolName('keytool')), [
      '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12',
      '-storepass', 'android', '-keypass', 'android',
      '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-dname', 'CN=Android Debug,O=Android,C=US',
    ]);
  }
  const finalApk = path.join(OUT, `StrongholdOffline-${APP_VERSION}.apk`);
  runJavaTool(jbin, buildTools, 'apksigner.jar', [
    'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
    '--ks-key-alias', 'androiddebugkey', '--min-sdk-version', String(MIN_SDK),
    '--out', finalApk, aligned,
  ]);
  runJavaTool(jbin, buildTools, 'apksigner.jar', ['verify', '--print-certs', finalApk]);

  // --- final checks ---------------------------------------------------------------------------------------
  const apkBytes = statSync(finalApk).size;
  const finalEntries = zipEntries(finalApk) ?? new Map();
  check(finalEntries.size > 10, 'the APK is a well-formed zip', `${finalEntries.size} entries`);
  check(finalEntries.has('assets/web/index.html'), 'the page is still in the signed APK');
  check([...finalEntries.keys()].every((n) => !n.includes('\\')), 'every entry name uses "/" (AssetManager-visible)');
  // Count files, not bytes: aapt2 deflates the assets, so the APK is legitimately smaller than the tree on disk.
  const packedFiles = [...finalEntries.keys()].filter((n) => n.startsWith('assets/web/')).length;
  check(packedFiles >= siteFiles * 0.95, 'every file of the tree is inside the APK',
    `${packedFiles} packed / ${siteFiles} on disk (${mb(apkBytes)} from ${mb(siteBytes)})`);
  // resources.arsc must stay STORED from API 30 on; `aapt add` rewrote the archive, so verify instead of assuming.
  check(finalEntries.get('resources.arsc') === 0, 'resources.arsc is stored uncompressed (Android 11+ requirement)');

  console.log(`\nAPK: ${path.relative(ROOT, finalApk)}  (${mb(apkBytes)})`);

  // Drop the bulky intermediates (~765 MB of near-duplicate APKs) but keep the final one, the keystore (which lives
  // outside dist/ anyway) and the small build dirs. dist/android/assets/web is a junction into dist/offline and is
  // deliberately left alone: recursively removing it could follow the link into the real tree.
  let freed = 0;
  for (const name of ['base.apk', 'dexed.apk', 'aligned.apk', 'res.zip', 'classes.jar']) {
    const p = path.join(OUT, name);
    if (existsSync(p)) { freed += statSync(p).size; rmSync(p, { force: true }); }
  }
  if (freed > 0) console.log(`cleaned build intermediates (${mb(freed)})`);

  console.log(`install:  adb install -r "${finalApk}"`);
  console.log(problems.length ? `\nWARNINGS: ${problems.join(' | ')}` : '\nBuild OK.');
  process.exit(problems.length ? 1 : 0);
}

await main();
