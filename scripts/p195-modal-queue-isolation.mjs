/**
 * P195 生成队列「模态隔离」守卫（2026-11-01）。
 *
 * 钉的是什么事故：8 路并发解决的是"视频串行"，没解决"模态不分家"。
 * 生产实测 2026-10-30 —— 三条图片任务 08:47 / 09:04 / 09:05 建好，
 * 09:48 / 09:49 才开始，**等了 43-61 分钟**，而它们自己只跑 50 秒。
 * 机制是：8 条 H3 视频各占一个槽 8-9 分钟，把 8 个槽全占满，图片只能等。
 *
 * 这条守卫钉四件事：
 *   ① **轻模态优先**：队列前面排着视频时，后进来的图片也要立刻能开；
 *   ② **视频有独立上限** `并发 − 预留`：视频再多也占不满全部槽；
 *   ③ **视频之间仍先进先出**：不许长任务被后来者反复挤压（饿死）；
 *   ④ **源码真的接上了**：aiGeneration.js 必须走这个调度器 —— 光有模块没用，
 *      历史上就发生过"规则写了但调用方还是老写法的 while 循环"。
 *
 * 纯函数 + 静态检查，不连 DB、不发请求，跑法：
 *   node scripts/p195-modal-queue-isolation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  heavySlotLimit,
  isHeavyAsyncModality,
  pickNextStartableIndex,
  resolveReservedLight,
} from '../apps/server/src/services/asyncGenerationScheduler.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`); }
};

const VIDEO = { modality: 'VIDEO' };
const IMAGE = { modality: 'IMAGE' };
const TEXT = { modality: 'TEXT' };
const MUSIC = { modality: 'MUSIC' };
// 生产默认：8 路并发、给轻模态留 2 路 → 视频最多 6 路
const base = { concurrency: 8, reservedLight: 2 };

try {
  /* ───────── ① 轻模态优先 ───────── */
  {
    console.log('① 轻模态优先');
    const idx = pickNextStartableIndex([VIDEO, IMAGE], { ...base, active: 0, activeHeavy: 0 });
    check('队列是 [视频, 图片] 时先开图片（下标 1，不是 0）', idx === 1, `idx=${idx}`);

    // 这条是本次事故的正面复现：前面排 10 条视频，第 11 位的一张图仍要立刻能开
    const queue = [...Array(10).fill(VIDEO), IMAGE];
    const idx2 = pickNextStartableIndex(queue, { ...base, active: 0, activeHeavy: 0 });
    check('前面排 10 条视频时，队尾的图片仍立刻能开', idx2 === 10, `idx=${idx2}`);

    check('TEXT 也算轻模态', pickNextStartableIndex([VIDEO, TEXT], { ...base, active: 0, activeHeavy: 0 }) === 1);
    check('MUSIC 也算轻模态', pickNextStartableIndex([VIDEO, MUSIC], { ...base, active: 0, activeHeavy: 0 }) === 1);
  }

  /* ───────── ② 视频独立上限 = 并发 − 预留 ───────── */
  {
    console.log('② 视频独立上限');
    check('8 路并发 + 预留 2 → 视频上限 6', heavySlotLimit(8, 2) === 6);
    check('预留 0 时视频可以占满 8 路', heavySlotLimit(8, 0) === 8);

    // 6 条视频在跑：视频槽已满，新视频不许开，但轻模态可以
    const sixRunning = { ...base, active: 6, activeHeavy: 6 };
    check('6 条视频在跑时，新视频不许开', pickNextStartableIndex([VIDEO], sixRunning) === -1);
    check('6 条视频在跑时，图片照样能开', pickNextStartableIndex([VIDEO, IMAGE], sixRunning) === 1);

    // 5 条视频在跑：还有 1 个视频槽
    const fiveRunning = { ...base, active: 5, activeHeavy: 5 };
    check('5 条视频在跑时，还能再开 1 条视频', pickNextStartableIndex([VIDEO], fiveRunning) === 0);

    // 8 条视频把总槽占满（极端：预留被配置成 0）
    check('总槽占满时一条都不开', pickNextStartableIndex([IMAGE], { ...base, active: 8, activeHeavy: 8 }) === -1);
  }

  /* ───────── ③ 视频之间先进先出 ───────── */
  {
    console.log('③ 视频先进先出');
    const queue = [{ modality: 'VIDEO', id: 'v1' }, { modality: 'VIDEO', id: 'v2' }, { modality: 'VIDEO', id: 'v3' }];
    const state = { ...base, active: 0, activeHeavy: 0 };
    const first = pickNextStartableIndex(queue, state);
    check('三条视频排队时先开第一条', first === 0, `idx=${first}`);
    // 模拟出队后再挑：仍然是新的第一条（不能跳到第三条）
    queue.splice(first, 1);
    const second = pickNextStartableIndex(queue, { ...state, active: 1, activeHeavy: 1 });
    check('出队后仍按顺序开下一条', second === 0, `idx=${second}`);
  }

  /* ───────── ④ 轻模态不设上限 ───────── */
  {
    console.log('④ 轻模态不设上限');
    check('只剩 1 个总槽时，图片能进', pickNextStartableIndex([IMAGE], { ...base, active: 7, activeHeavy: 6 }) === 0);
    check('总槽占满时，图片也进不来（上限是总并发）', pickNextStartableIndex([IMAGE], { ...base, active: 8, activeHeavy: 6 }) === -1);
    check('空队列返回 -1', pickNextStartableIndex([], { ...base, active: 0, activeHeavy: 0 }) === -1);
  }

  /* ───────── ④b 生产目标：100 路（2026-11-01 起 AI_GENERATION_CONCURRENCY=100）───────── */
  {
    console.log('④b 100 路并发下的调度');
    const wide = { concurrency: 100, reservedLight: 2 };
    check('100 路时视频上限是 98', heavySlotLimit(100, 2) === 98);
    check('98 条视频在跑时，第 99 条视频不许开', pickNextStartableIndex([VIDEO], { ...wide, active: 98, activeHeavy: 98 }) === -1);
    check('98 条视频在跑时，图片照样能开（预留的 2 路没被占）',
      pickNextStartableIndex([VIDEO, IMAGE], { ...wide, active: 98, activeHeavy: 98 }) === 1);
    // 队尾一张图：前面排 500 条视频也必须能立刻开（这是"图片被饿死"的极端形态）
    const heavyQueue = [...Array(500).fill(VIDEO), IMAGE];
    check('前面排 500 条视频，队尾的图片仍立刻能开',
      pickNextStartableIndex(heavyQueue, { ...wide, active: 0, activeHeavy: 0 }) === 500);
    check('100 路跑满时一条都不开', pickNextStartableIndex([IMAGE], { ...wide, active: 100, activeHeavy: 98 }) === -1);
  }

  /* ───────── ⑤ 环境变量解析（空串是坑） ───────── */
  {
    console.log('⑤ 预留值解析');
    check('未设置 → 默认 2', resolveReservedLight(undefined, 8) === 2);
    check("空字符串 → 默认 2（Number('') 是 0，不特判修复就静默失效）", resolveReservedLight('', 8) === 2);
    check('非法值 → 默认 2', resolveReservedLight('abc', 8) === 2);
    check('负数 → 默认 2', resolveReservedLight('-1', 8) === 2);
    check('显式 0 → 0（允许关掉预留）', resolveReservedLight('0', 8) === 0);
    check('显式 5 → 5', resolveReservedLight('5', 8) === 5);
    check('超过 并发−1 → 夹到 7（否则视频永远排不上）', resolveReservedLight('99', 8) === 7);
    check('并发 1 时预留夹到 0', resolveReservedLight('2', 1) === 0);
    check("' VIDEO ' 带空格也算重模态", isHeavyAsyncModality(' VIDEO ') === true);
    check("'video' 小写也算重模态", isHeavyAsyncModality('video') === true);
    check('IMAGE 不是重模态', isHeavyAsyncModality('IMAGE') === false);
    check('未知模态按轻模态处理（安全兜底，不会被当视频堵住）', isHeavyAsyncModality('PODCAST') === false);
  }

  /* ───────── ⑥ 源码真的接上了调度器 ───────── */
  {
    console.log('⑥ 源码接线');
    const source = fs.readFileSync('apps/server/src/routes/aiGeneration.js', 'utf8');
    check('aiGeneration.js 引入了调度器', /from '\.\.\/services\/asyncGenerationScheduler\.js'/.test(source));
    check('aiGeneration.js 调用 pickNextStartableIndex', /pickNextStartableIndex\(/.test(source));
    check('视频在跑数单独计数（asyncGenerationActiveHeavy）', /asyncGenerationActiveHeavy/.test(source));
    // 老写法：只按总数派发、不分模态 —— 必须已经不存在
    check('老的「只比总并发数」派发循环已删除',
      !/while \(asyncGenerationActive < ASYNC_GENERATION_CONCURRENCY && asyncGenerationQueue\.length\)/.test(source));
    check('启动日志会打印预留路数（线上能确认这个修复生效了）',
      /为图片\/文本\/音乐预留/.test(source));

    const envExample = fs.readFileSync('deploy/production/.env.example', 'utf8');
    check('.env.example 记录了 AI_GENERATION_RESERVED_LIGHT', /^AI_GENERATION_RESERVED_LIGHT=2$/m.test(envExample));
  }
} finally {
  // 纯函数，没有需要还原的全局状态
}

assert.equal(failures, 0, `P195 有 ${failures} 条断言没过`);
console.log('PASS: 生成队列按模态隔离（轻模态优先、视频限流、视频 FIFO）');
