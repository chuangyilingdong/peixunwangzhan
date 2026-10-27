/** 抖音主页响应解析与本地采集的纯函数。 */

export const DOUYIN_PROFILE_ENDPOINT = '/aweme/v1/web/aweme/post';
export const DOUYIN_DETAIL_ENDPOINT = '/aweme/v1/web/aweme/detail';

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function firstUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const list = asArray(value.url_list || value.urlList || value.uri);
  for (const item of list) {
    if (typeof item === 'string' && /^https?:\/\//i.test(item)) return item;
  }
  return '';
}

function playUrlOf(video) {
  const candidates = [
    video?.play_addr,
    video?.playAddr,
    video?.play_addr_h264,
    ...(asArray(video?.bit_rate).map((item) => item?.play_addr)),
  ];
  for (const candidate of candidates) {
    const value = firstUrl(candidate);
    if (value) return value;
  }
  return '';
}

/** 从主页 URL、分享文本或裸 sec_uid 中提取抖音主页 ID。 */
export function normalizeSecUserId(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  const direct = value.match(/(MS4wLj[A-Za-z0-9_-]{8,})/);
  if (direct) return direct[1];
  const userPath = value.match(/douyin\.com\/user\/([A-Za-z0-9_-]{6,})/i);
  return userPath ? userPath[1] : '';
}

export function douyinProfileUrl(secUserId) {
  const id = normalizeSecUserId(secUserId);
  return id ? `https://www.douyin.com/user/${encodeURIComponent(id)}` : 'https://www.douyin.com/';
}

export function isDouyinProfileResponse(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://www.douyin.com');
    return parsed.pathname.replace(/\/+$/, '') === DOUYIN_PROFILE_ENDPOINT;
  } catch {
    return false;
  }
}

export function isDouyinDetailResponse(url) {
  try {
    const parsed = new URL(String(url || ''), 'https://www.douyin.com');
    return parsed.pathname.replace(/\/+$/, '') === DOUYIN_DETAIL_ENDPOINT;
  } catch {
    return false;
  }
}

export function secUserIdFromResponseUrl(url) {
  try {
    return new URL(String(url || '')).searchParams.get('sec_user_id') || '';
  } catch {
    return '';
  }
}

function workFromItem(item) {
  if (!item || !item.aweme_id) return null;
  const video = item.video || {};
  const playUrl = playUrlOf(video);
  if (!playUrl) return null;
  const stats = item.statistics || {};
  return {
    awemeId: String(item.aweme_id).replace(/[^0-9]/g, '').slice(0, 25),
    desc: String(item.desc || '').slice(0, 300),
    playUrl: playUrl.slice(0, 2000),
    durationMs: Number(video.duration) || null,
    createTime: Number(item.create_time) || null,
    stats: {
      plays: Number(stats.play_count) || 0,
      digg: Number(stats.digg_count) || 0,
      comment: Number(stats.comment_count) || 0,
      share: Number(stats.share_count) || 0,
      collect: Number(stats.collect_count) || 0,
    },
  };
}

/** 把一页 /aweme/post JSON 转成平台 ingest 可接收的精简作品。 */
export function extractDouyinWorks(payload, options = {}) {
  const list = Array.isArray(payload?.aweme_list) ? payload.aweme_list : [];
  const expectedSecUserId = String(options.expectedSecUserId || '');
  const works = [];
  let secUserId = expectedSecUserId;
  let nickname = '';

  for (const item of list) {
    if (!item || !item.aweme_id) continue;
    const author = item.author || {};
    const authorId = String(author.sec_uid || '');
    if (expectedSecUserId && authorId && authorId !== expectedSecUserId) continue;
    if (!secUserId && authorId) secUserId = authorId;
    if (!nickname && author.nickname) nickname = String(author.nickname).slice(0, 120);
    const work = workFromItem(item);
    if (work) works.push(work);
  }

  return { secUserId, nickname, works };
}

/** 从单条作品详情响应中提取一个可直接 ingest 的作品。 */
export function extractDouyinWorkDetail(payload, expectedAwemeId = '') {
  const item = payload?.aweme_detail || payload;
  if (!item || !item.aweme_id) return null;
  const awemeId = String(item.aweme_id).replace(/[^0-9]/g, '').slice(0, 25);
  if (expectedAwemeId && awemeId !== String(expectedAwemeId)) return null;
  const work = workFromItem(item);
  if (!work) return null;
  const author = item.author || {};
  return {
    secUserId: String(author.sec_uid || ''),
    nickname: String(author.nickname || author.unique_id || '').slice(0, 120),
    work,
  };
}

/** 合并分页结果；同一作品只保留一份，并按发布时间从新到旧排序。 */
export function mergeDouyinSnapshots(target, snapshot) {
  if (!target || !snapshot) return target;
  if (snapshot.secUserId && !target.secUserId) target.secUserId = snapshot.secUserId;
  if (snapshot.nickname) target.nickname = snapshot.nickname;
  for (const work of snapshot.works || []) {
    if (!work?.awemeId) continue;
    if (target.secUserId && snapshot.secUserId && snapshot.secUserId !== target.secUserId) continue;
    target.works.set(work.awemeId, work);
  }
  target.updatedAt = Date.now();
  return target;
}

export function snapshotWorks(capture, limit = 60) {
  const works = Array.from(capture?.works?.values?.() || [])
    .sort((left, right) => Number(right.createTime || 0) - Number(left.createTime || 0))
    .slice(0, Math.max(1, Math.min(60, Number(limit) || 60)));
  return {
    secUserId: String(capture?.secUserId || ''),
    nickname: String(capture?.nickname || ''),
    works,
  };
}
