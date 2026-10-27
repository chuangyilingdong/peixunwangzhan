import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAudioChunks, transcribeMediaReliable } from '../apps/server/src/services/junshiDouyin.js';

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timeout`)); }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

const workbenchSource = await fs.readFile(new URL('../apps/server/src/routes/junshiWorkbench.js', import.meta.url), 'utf8');
assert.match(workbenchSource, /transcribeMediaReliable\s*,?[\s\S]*from '\.\.\/services\/junshiDouyin\.js'/, 'workbench route must import transcribeMediaReliable');
assert.match(workbenchSource, /await transcribeMediaReliable\(/, 'transcript pipeline must call transcribeMediaReliable');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'junshi-asr-test-'));
try {
  const source = path.join(root, 'sample.mp3');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '660', '-ac', '1', '-ar', '16000', '-b:a', '24k', source]);
  const buffer = await fs.readFile(source);
  const prepared = await prepareAudioChunks({ buffer, fileName: 'sample.mp3', chunkSeconds: 300 });
  try {
    assert.equal(prepared.chunks.length, 3);
    assert.ok(prepared.duration > 650 && prepared.duration < 670, `unexpected duration ${prepared.duration}`);
    for (const chunk of prepared.chunks) {
      const stat = await fs.stat(chunk);
      assert.ok(stat.size > 1000, `chunk too small: ${chunk}`);
      assert.ok(stat.size < 2 * 1024 * 1024, `chunk too large: ${stat.size}`);
    }
  } finally {
    await fs.rm(prepared.dir, { recursive: true, force: true });
  }

  const seen = [];
  const merged = await transcribeMediaReliable({
    endpoint: 'https://example.invalid', apiKey: 'test', buffer, fileName: 'sample.mp3', mimeType: 'audio/mpeg', chunkSeconds: 300,
    transcribeImpl: async ({ buffer: chunkBuffer, fileName }) => {
      seen.push({ fileName, bytes: chunkBuffer.length });
      return { text: `片段${seen.length}`, segments: [{ start: 0, end: 2, text: `片段${seen.length}` }], duration: 2, language: 'zh' };
    },
  });
  assert.equal(merged.chunkCount, 3);
  assert.equal(seen.length, 3);
  assert.equal(merged.segments[0].start, 0);
  assert.equal(merged.segments[1].start, 300);
  assert.equal(merged.segments[2].start, 600);
  assert.equal(merged.text, '片段1\n片段2\n片段3');
  console.log(JSON.stringify({ name: 'junshi-asr-audio-chunking', pass: true, chunks: prepared.chunks.length, duration: prepared.duration, chunkBytes: seen.map((item) => item.bytes) }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

