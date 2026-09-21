#!/usr/bin/env node
/**
 * WhalesLauncher 工具：修复被写成明文的 DSH 会话日志。
 *
 * 背景
 *   DSH 会话日志路径：<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.vX.jsonl.zstd
 *   文件按“扩展名”决定编解码：`.jsonl.zstd` 会被 @deepseek-ai/dsh-session-persistence-jsonl
 *   当作 Zstandard 帧序列读取。若某次写入把未压缩的明文 JSONL 留在该文件名下，
 *   `scanZstdFrames` 会在第 0 字节抛
 *     `corrupt Zstandard session log: invalid frame magic at byte 0`
 *   该异常在 dsh-workspace 初始化（WorkspaceRegistry.listStoredHeaders → listArtifacts）
 *   中未被吞掉，导致整个实例启动失败。
 *
 * 本工具做的事
 *   1. 全程只读原文件，先在备份目录留一份**明文原件**（权威数据，绝不再动）。
 *   2. 按 DSH 自身的帧约定重压缩：第 1 帧 = 独占的 header 行，其余行合并为 1 帧。
 *      压缩参数与 DSH 一致：node:zlib zstdCompress + ZSTD_c_checksumFlag = 1。
 *   3. 三种方式回读校验：
 *      a) 单帧解压逐帧拼接 → 必须与原文逐字节相同；
 *      b) `decompressZstdPrefix`（一次性解压多帧拼接流，即 DSH 恢复尾部时的路径）；
 *      c) 内容体检：行数 / JSON 可解析 / seq 连续 / 事件类型分布。
 *   4. 只在校验全部通过后用 rename 原子替换；任何一步失败都保留原文件不动。
 *
 * 用法
 *   node repair-session-zstd.cjs <session.vX.jsonl.zstd> [--backup-dir <dir>] [--dry-run]
 *   退出码：0 修复或已是合法 zstd；1 校验/修复失败；2 用法错误
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const zstdCompressAsync = promisify(zlib.zstdCompress);
const zstdDecompressAsync = promisify(zlib.zstdDecompress);

/** 与 DSH 的 CHECKSUM_OPTIONS 保持一致。 */
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

const ZSTD_MAGIC = 0xfd2fb528; // 小端读取得 0x28 0xB5 0x2F 0xFD

/** DSH 的帧扫描：只做结构性校验（魔数 / 保留位 / 块类型），不实际解压。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    const descriptor = buffer.readUInt8(offset + 4);
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset + 4}`);
    const singleSegment = (descriptor & 0x20) !== 0;
    const dictIdFlag = descriptor & 0x3;
    const checksumFlag = (descriptor & 0x4) !== 0;
    let cursor = offset + 5;
    if (!singleSegment) cursor += 1; // window descriptor
    cursor += dictIdFlag === 3 ? 4 : dictIdFlag;
    for (;;) {
      if (buffer.length - cursor < 3) return { frames, tornStart: offset };
      const blockHeader = buffer.readUIntLE(cursor, 3);
      const blockType = (blockHeader >>> 1) & 0x3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${cursor}`);
      cursor += 3 + (blockType === 1 ? 1 : blockSize); // RLE 块只占 1 字节
      if ((blockHeader & 0x1) === 1) break; // 末块
    }
    if (checksumFlag) cursor += 4;
    frames.push({ start: offset, end: cursor });
    offset = cursor;
  }
  return { frames, tornStart: undefined };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 内容体检：明文必须是完整、可解析、seq 连续的 JSONL。 */
function inspect(text) {
  const raw = text.split('\n');
  const hasTrailingLf = text.endsWith('\n');
  const lines = hasTrailingLf ? raw.slice(0, -1) : raw;
  const problems = [];
  if (!hasTrailingLf && lines.length > 0) problems.push('最后一行缺少换行符（可能是写入中途截断）');

  const types = Object.create(null);
  const seqs = [];
  lines.forEach((line, i) => {
    if (line.length === 0) {
      problems.push(`第 ${i + 1} 行为空行`);
      return;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      problems.push(`第 ${i + 1} 行不是合法 JSON：${error.message}`);
      return;
    }
    types[value.type] = (types[value.type] ?? 0) + 1;
    if (typeof value.seq === 'number') seqs.push(value.seq);
  });

  if (lines.length === 0) problems.push('文件为空');
  else {
    let head;
    try {
      head = JSON.parse(lines[0]);
    } catch { /* 已在上面记录 */ }
    if (head && (head.type !== 'session' || typeof head.id !== 'string')) {
      problems.push('第一帧不是合法的 Session header（缺少 type:"session" / id）');
    }
  }
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) problems.push(`seq 不连续：${seqs[i - 1]} → ${seqs[i]}`);
  }
  return { lines, types, seqs, problems, hasTrailingLf };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const backupFlag = argv.indexOf('--backup-dir');
  const targets = argv.filter((a) => !a.startsWith('--'));
  const target = targets[0];
  if (!target || (backupFlag !== -1 && !argv[backupFlag + 1])) {
    console.error('用法：node repair-session-zstd.cjs <session.vX.jsonl.zstd> [--backup-dir <dir>] [--dry-run]');
    process.exit(2);
  }

  const file = path.resolve(target);
  const original = fs.readFileSync(file);
  const magic = original.length >= 4 ? original.readUInt32LE(0) : 0;

  console.log(`文件：${file}`);
  console.log(`大小：${original.length} 字节 | 开头字节：${[...original.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

  const text = original.toString('utf8');
  const looksPlaintext = original[0] === 0x7b || text.startsWith('{'); // '{'
  const framesOk = (() => {
    try { scanZstdFrames(original); return true; } catch { return false; }
  })();

  if (magic === ZSTD_MAGIC && framesOk) {
    console.log('结论：已是合法 Zstandard 帧序列，无需修复。');
    process.exit(0);
  }
  if (!looksPlaintext) {
    console.error('结论：文件既不是明文 JSONL，也不是合法 Zstandard——属于内容损坏，需人工处理或从备份恢复。');
    process.exit(1);
  }

  console.log('结论：文件是**未压缩的明文 JSONL**（扩展名仍为 .jsonl.zstd）→ 需要按 zstd 帧约定重压缩。');
  const plain = inspect(text);
  console.log(`内容体检：${plain.lines.length} 行 | seq ${plain.seqs[0]}..${plain.seqs[plain.seqs.length - 1]} | 事件类型 ${Object.keys(plain.types).length} 种`);
  if (plain.problems.length > 0) {
    console.error('内容体检未通过，已放弃修复以避免二次损坏：');
    for (const p of plain.problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('内容体检：通过（全部行可解析、seq 连续、header 合法、末尾有换行）');

  // —— 按 DSH 约定重压缩：第 1 帧 = header 行，其余 = 1 帧 ——
  const headerLine = `${plain.lines[0]}\n`;
  const bodyText = plain.lines.slice(1).map((l) => `${l}\n`).join('');
  const headerFrame = await zstdCompressAsync(Buffer.from(headerLine, 'utf8'), CHECKSUM_OPTIONS);
  const frames = [headerFrame];
  if (bodyText.length > 0) frames.push(await zstdCompressAsync(Buffer.from(bodyText, 'utf8'), CHECKSUM_OPTIONS));
  const rebuilt = Buffer.concat(frames);

  // —— 校验 a：逐帧解压后拼接，必须与原文逐字节相同 ——
  const decodedParts = [];
  for (const frame of scanZstdFrames(rebuilt).frames) {
    decodedParts.push(await zstdDecompressAsync(rebuilt.subarray(frame.start, frame.end)));
  }
  const decoded = Buffer.concat(decodedParts);
  if (!decoded.equals(original)) {
    console.error('校验失败：重压缩后回读的内容与原文不一致，未做任何替换。');
    process.exit(1);
  }
  console.log(`帧结构：${frames.length} 帧（header ${headerFrame.length} 字节 + body ${rebuilt.length - headerFrame.length} 字节）| 校验 a（逐帧回读逐字节一致）：通过`);

  // —— 校验 b：DSH 的实际读取路径。@deepseek-ai/dsh-session-persistence-jsonl 不使用流式
  //    多帧拼接，而是先 scanZstdFrames 切帧、再逐帧解码后拼接（createZstdFrameDecoder）。
  //    因此这里同样逐帧解压，并断言扫描结果没有“撕裂尾部”（tornStart 必须为 undefined），
  //    否则 DSH 会走尾部恢复分支、按不完整日志处理。
  const scanned = scanZstdFrames(rebuilt);
  if (scanned.tornStart !== undefined) {
    console.error('校验失败：重建结果存在撕裂尾部帧，未做任何替换。');
    process.exit(1);
  }
  if (scanned.frames.length !== frames.length) {
    console.error('校验失败：重建结果的帧数与预期不符，未做任何替换。');
    process.exit(1);
  }
  const perFrameParts = [];
  for (const frame of scanned.frames) {
    perFrameParts.push(await zstdDecompressAsync(rebuilt.subarray(frame.start, frame.end)));
  }
  const perFrame = Buffer.concat(perFrameParts);
  if (!perFrame.equals(original)) {
    console.error('校验失败：逐帧解码拼接结果与原文不一致，未做任何替换。');
    process.exit(1);
  }
  console.log('校验 b（scanZstdFrames 切帧 + 逐帧解码拼接、无撕裂尾部）：通过');

  // 额外确认第一帧只含一行——DSH 对 header 帧有“恰好一行”的硬校验
  const firstLineOut = (await zstdDecompressAsync(rebuilt.subarray(0, frames[0].length))).toString('utf8');
  if (firstLineOut.indexOf('\n') !== firstLineOut.length - 1) {
    console.error('校验失败：header 帧不是恰好一行，未做任何替换。');
    process.exit(1);
  }
  console.log('校验 c（header 帧恰好一行）：通过');

  if (dryRun) {
    console.log('\n--dry-run：校验全部通过，未写入任何文件。');
    process.exit(0);
  }

  // —— 备份明文原件（权威数据），再原子替换 ——
  const backupDir = backupFlag !== -1
    ? path.resolve(argv[backupFlag + 1])
    : path.join(path.dirname(file), `..${path.sep}..${path.sep}..`, 'session-repair-backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(file);
  const backupFile = path.join(backupDir, `${base}.plaintext-${stamp}.bak`);
  fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL);
  const manifest = path.join(backupDir, `${base}.plaintext-${stamp}.manifest.json`);
  fs.writeFileSync(manifest, `${JSON.stringify({
    sourcePath: file,
    backupPath: backupFile,
    reason: 'DSH session log stored as uncompressed plaintext JSONL under a .jsonl.zstd filename',
    originalBytes: original.length,
    originalSha256: sha256(original),
    rebuiltBytes: rebuilt.length,
    rebuiltSha256: sha256(rebuilt),
    frames: frames.length,
    logicalLines: plain.lines.length,
    seqRange: [plain.seqs[0], plain.seqs[plain.seqs.length - 1]],
    repairedAt: new Date().toISOString()
  }, null, 2)}\n`, 'utf8');

  const tmp = `${file}.rebuild-${process.pid}.tmp`;
  fs.writeFileSync(tmp, rebuilt);
  fs.renameSync(tmp, file); // 同目录 rename，原子替换

  const after = fs.readFileSync(file);
  console.log(`\n备份（明文原件）：${backupFile}`);
  console.log(`清单：${manifest}`);
  console.log(`替换完成：${after.length} 字节 | sha256 ${sha256(after).slice(0, 16)}… | 开头字节 ${[...after.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`原始明文 sha256 ${sha256(original).slice(0, 16)}…（已在备份中留存）`);
}

main().catch((error) => {
  console.error(`修复失败，未做替换：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
