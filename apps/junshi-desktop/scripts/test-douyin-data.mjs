import assert from 'node:assert/strict';
import {
  extractDouyinWorks,
  mergeDouyinSnapshots,
  normalizeSecUserId,
  snapshotWorks,
} from '../src/douyin-data.mjs';

assert.equal(normalizeSecUserId('https://www.douyin.com/user/MS4wLjABAAAA_test-id'), 'MS4wLjABAAAA_test-id');
assert.equal(normalizeSecUserId('复制打开抖音 https://www.douyin.com/user/MS4wLjABAAAA_abc123'), 'MS4wLjABAAAA_abc123');
assert.equal(normalizeSecUserId('MS4wLjABAAAA_direct123'), 'MS4wLjABAAAA_direct123');

const firstPayload = {
  aweme_list: [
    {
      aweme_id: '7412345678901234567',
      desc: '第一条',
      create_time: 1730000000,
      author: { sec_uid: 'MS4wLjABAAAA_peer', nickname: '同行账号' },
      video: { duration: 31000, play_addr: { url_list: ['https://cdn.example/video-1.mp4'] } },
      statistics: { digg_count: 100, comment_count: 20, share_count: 5, collect_count: 30 },
    },
    {
      aweme_id: '7400000000000000000',
      desc: '别的账号',
      author: { sec_uid: 'MS4wLjABAAAA_other', nickname: '其他账号' },
      video: { play_addr: { url_list: ['https://cdn.example/other.mp4'] } },
    },
  ],
};

const first = extractDouyinWorks(firstPayload, { expectedSecUserId: 'MS4wLjABAAAA_peer' });
assert.equal(first.secUserId, 'MS4wLjABAAAA_peer');
assert.equal(first.nickname, '同行账号');
assert.equal(first.works.length, 1);
assert.equal(first.works[0].awemeId, '7412345678901234567');
assert.equal(first.works[0].stats.digg, 100);

const capture = { secUserId: '', nickname: '', works: new Map(), updatedAt: 0 };
mergeDouyinSnapshots(capture, first);
mergeDouyinSnapshots(capture, first);
assert.equal(capture.works.size, 1);

const second = extractDouyinWorks({
  aweme_list: [{
    aweme_id: '7412345678901234568',
    desc: '第二条',
    create_time: 1730000100,
    author: { sec_uid: 'MS4wLjABAAAA_peer', nickname: '同行账号' },
    video: { play_addr: { url_list: ['https://cdn.example/video-2.mp4'] } },
  }],
}, { expectedSecUserId: 'MS4wLjABAAAA_peer' });
mergeDouyinSnapshots(capture, second);
assert.equal(snapshotWorks(capture).works.length, 2);
assert.equal(snapshotWorks(capture).works[0].awemeId, '7412345678901234568');

console.log(JSON.stringify({ name: 'junshi-desktop-douyin-data', pass: true }));
