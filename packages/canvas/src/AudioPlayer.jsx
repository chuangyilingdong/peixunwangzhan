/**
 * 两行式音频播放器（用户 2026-09-22 报的图2）。
 *
 * 用户原话：「画布课堂音乐生成出来，这个播放器进度条被压缩很小了，有没有可能是两行，
 * 第一行是进度条，第二行才是操作按钮这些。」
 *
 * 为什么浏览器自带的 `<audio controls>` 做不到：那是**原生控件**，内部布局改不了 ——
 * 它在窄框体里会把进度条压成一小段（截图里就是那样），而节点宽度由画布上的框体决定、
 * 不能为了播放器去改框体尺寸。所以自己画一个：**第一行进度条、第二行按钮 + 时间**。
 *
 * 用它的地方（两处，改一处要连着看）：
 *   · 画布上的音乐框体（`index.jsx` 的 AudioNode）；
 *   · 作品读面的媒体卡片 / 大图浮层（`packages/shared/src/workMedia.jsx`）。
 */
import { useEffect, useRef, useState } from 'react';

function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function PlayIcon({ playing }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {playing
      ? <><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /></>
      : <path d="M8 5.4c0-.8.9-1.3 1.6-.9l9 5.6c.6.4.6 1.4 0 1.8l-9 5.6c-.7.4-1.6-.1-1.6-.9V5.4Z" fill="currentColor" />}
  </svg>;
}

function VolumeIcon({ muted }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 9.5h3L11 6.2v11.6L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" fill="currentColor" />
    {muted
      ? <path d="M15 9.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      : <path d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.6 7.6 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />}
  </svg>;
}

function DownloadIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 4.5v10m0 0 3.8-3.8M12 14.5 8.2 10.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M5.5 18.5h13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
  </svg>;
}

/** 下载到本地时用的文件名：框体标题 + 从地址里看出来的扩展名（看不出来就按 mp3）。 */
function downloadFileName(label, url) {
  const clean = String(label || '音乐').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || '音乐';
  const matched = String(url || '').match(/\.(mp3|wav|m4a|aac|ogg|opus|flac|mp4)(?:\?|#|$)/i);
  return `${clean.slice(0, 60)}.${matched ? matched[1].toLowerCase() : 'mp3'}`;
}

// ⚠️ 用户 2026-09-28：「音乐框体不能下载音乐到本地，右键也没有，可否像视频框体那样可以有个下载按钮」。
//    真因是**播放器被我们换掉了**：视频框体用的是原生 `<video controls>`，浏览器右键自带「视频另存为」；
//    而音乐框体在 2026-09-22 按口径换成了自绘的两行式（`<audio>` 是 hidden 的）——
//    原生右键菜单跟着一起没了。所以这里把「下载到本地」显式补成一个按钮。
// ⚠️ 传 `downloadHref` 才显示这个按钮：画布的音乐框体传了；作品读面没传（要的话同样传一个即可）。
export function AudioPlayer({ src, fallbackSrc = '', label = '', className = '', downloadHref = '' }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const activeSrc = usingFallback ? fallbackSrc : src;
  const href = String(downloadHref || '');

  useEffect(() => { setPlaying(false); setCurrent(0); setDuration(0); setFailed(false); setUsingFallback(false); }, [src, fallbackSrc]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return undefined;
    const onTime = () => setCurrent(element.currentTime || 0);
    const onMeta = () => setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    const onError = () => {
      setPlaying(false);
      if (!usingFallback && fallbackSrc && fallbackSrc !== src) setUsingFallback(true);
      else setFailed(true);
    };
    const onEnd = () => { setPlaying(false); setCurrent(0); };
    element.addEventListener('timeupdate', onTime);
    element.addEventListener('loadedmetadata', onMeta);
    element.addEventListener('durationchange', onMeta);
    element.addEventListener('error', onError);
    element.addEventListener('ended', onEnd);
    return () => {
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('loadedmetadata', onMeta);
      element.removeEventListener('durationchange', onMeta);
      element.removeEventListener('error', onError);
      element.removeEventListener('ended', onEnd);
    };
  }, [src, fallbackSrc, usingFallback]);

  const toggle = () => {
    const element = audioRef.current;
    if (!element || failed || !activeSrc) return;
    if (element.paused) {
      element.play().then(() => setPlaying(true)).catch(() => {
        setPlaying(false);
        if (!usingFallback && fallbackSrc && fallbackSrc !== src) setUsingFallback(true);
        else setFailed(true);
      });
    }
    else { element.pause(); setPlaying(false); }
  };
  const seek = (event) => {
    const element = audioRef.current;
    const value = Number(event.target.value);
    setCurrent(value);
    if (element && Number.isFinite(value)) element.currentTime = value;
  };
  const toggleMute = () => {
    const element = audioRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setMuted(element.muted);
  };

  return <div className={`cv-audio ${className}`.trim()}>
    {failed ? <p className="cv-audio__error">音频已失效，暂时无法播放</p> : null}
    {/* 第一行：进度条（原生 input[range]，所以键盘左右键也能调） */}
    <input
      className="cv-audio__progress"
      type="range"
      min="0"
      max={duration || 0}
      step="0.05"
      value={Math.min(current, duration || 0)}
      disabled={failed || !activeSrc}
      onChange={seek}
      aria-label={label ? `${label} 播放进度` : '播放进度'}
      style={{ '--cv-audio-progress': `${duration ? Math.min(100, (current / duration) * 100) : 0}%` }}
    />
    {/* 第二行：操作按钮 + 时间（进度条单独占一行，窄框体里也不会被挤没） */}
    <div className="cv-audio__row">
      <button type="button" className="cv-audio__btn nodrag" onClick={toggle} disabled={failed || !activeSrc} aria-label={playing ? '暂停' : '播放'}>{<PlayIcon playing={playing} />}</button>
      <span className="cv-audio__time">{formatTime(current)} / {formatTime(duration)}</span>
      <button type="button" className="cv-audio__btn nodrag" onClick={toggleMute} disabled={failed || !activeSrc} aria-label={muted ? '取消静音' : '静音'}><VolumeIcon muted={muted} /></button>
      {href ? <a
        className="cv-audio__btn cv-audio__btn--download nodrag"
        href={href}
        download={downloadFileName(label, href)}
        title="下载到本地"
        aria-label={label ? `下载「${label}」到本地` : '下载到本地'}
        onClick={(event) => event.stopPropagation()}
      ><DownloadIcon /></a> : null}
    </div>
    <audio ref={audioRef} src={activeSrc} preload="metadata" hidden />
  </div>;
}
