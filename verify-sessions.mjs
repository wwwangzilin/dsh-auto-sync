#!/usr/bin/env node
/**
 * verify-sessions.mjs — 检查 DSH 会话文件是否真的含有对话内容。
 *
 * DSH 的 session.*.jsonl.zstd 是**多帧 zstd**：每次追加都追加一个独立 frame。
 * Node 的 zstdDecompressSync() 默认只解第一个 frame，于是任何会话看起来都
 * 只有一行 {"type":"session",...} 头 —— 这正是"备份是空的"这种误判的来源。
 *
 * 本脚本逐帧解压后再统计记录，给出可信的结论。
 *
 * 用法:
 *   node verify-sessions.mjs <目录或文件>...
 *   node verify-sessions.mjs C:/Users/JJ/.dsh-backup/sessions
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解压一个多帧 zstd 缓冲区。逐个 frame 独立解压，坏帧跳过并计数。 */
export function decompressFrames(buf) {
  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      starts.push(i);
    }
  }
  if (starts.length === 0) return { text: '', frames: 0, badFrames: 0 };

  let text = '';
  let badFrames = 0;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
    } catch {
      badFrames++;
    }
  }
  return { text, frames: starts.length, badFrames };
}

/** 统计一份会话文本里的记录构成。 */
export function summarise(text) {
  const lines = text.split('\n').filter(Boolean);
  const types = {};
  let parsed = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const kind = record.type ?? '?';
      types[kind] = (types[kind] ?? 0) + 1;
      parsed++;
    } catch {
      /* 残缺的尾行在追加写入中很常见，忽略即可 */
    }
  }
  const dialogue = (types['user/message'] ?? 0) + (types['assistant/message'] ?? 0);
  return { lines: lines.length, parsed, types, dialogue };
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      yield* walk(path.join(target, entry.name));
    }
  } else if (target.endsWith('.zstd')) {
    yield target;
  }
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error('用法: node verify-sessions.mjs <目录或文件>...');
    process.exit(2);
  }

  let files = 0;
  let withDialogue = 0;
  let empty = 0;

  for (const target of targets) {
    for (const file of walk(target)) {
      files++;
      const buf = fs.readFileSync(file);
      const { text, frames, badFrames } = decompressFrames(buf);
      const { dialogue, types } = summarise(text);

      const status = dialogue > 0 ? 'OK  ' : 'EMPTY';
      if (dialogue > 0) withDialogue++;
      else empty++;

      const short = path.basename(path.dirname(file)) + '/' + path.basename(file);
      console.log(
        `${status} ${String(frames).padStart(5)} 帧  ${(buf.length / 1024).toFixed(0).padStart(6)} KB  ` +
          `对话 ${String(dialogue).padStart(5)} 条  ${short}` +
          (badFrames ? `  (坏帧 ${badFrames})` : ''),
      );

      // 只对含对话的文件打印构成，避免刷屏
      if (dialogue > 0 && process.env.VERBOSE) {
        console.log('        ' + JSON.stringify(types));
      }
    }
  }

  console.log(`\n共 ${files} 个会话文件：${withDialogue} 个有对话，${empty} 个无对话。`);
  // 无对话的文件可能只是空会话；只要存在有内容的文件就算备份有效。
  process.exit(files > 0 && withDialogue > 0 ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  main();
}
