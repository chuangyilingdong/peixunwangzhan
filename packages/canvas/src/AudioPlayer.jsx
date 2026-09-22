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

export function AudioPlayer({ src, label = '', className = '' }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);

  // 换素材要复位：否则上一首的进度会留在新素材的进度条上（看着像"新歌播到一半"）。
  useEffect(() => { setPlaying(false); setCurrent(0); setDuration(0); }, [src]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return undefined;
    const onTime = () => setCurrent(element.currentTime || 0);
    const onMeta = () => setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    const onEnd = () => { setPlaying(false); setCurrent(0); };
    element.addEventListener('timeupdate', onTime);
    element.addEventListener('loadedmetadata', onMeta);
    element.addEventListener('durationchange', onMeta);
    element.addEventListener('ended', onEnd);
    return () => {
      element.removeEventListener('timeupdate', onTime);
      element.removeEventListener('loadedmetadata', onMeta);
      element.removeEventListener('durationchange', onMeta);
      element.removeEventListener('ended', onEnd);
    };
  }, [src]);

  const toggle = () => {
    const element = audioRef.current;
    if (!element) return;
    if (element.paused) { element.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
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
    {/* 第一行：进度条（原生 input[range]，所以键盘左右键也能调） */}
    <input
      className="cv-audio__progress"
      type="range"
      min="0"
      max={duration || 0}
      step="0.05"
      value={Math.min(current, duration || 0)}
      onChange={seek}
      aria-label={label ? `${label} 播放进度` : '播放进度'}
      style={{ '--cv-audio-progress': `${duration ? Math.min(100, (current / duration) * 100) : 0}%` }}
    />
    {/* 第二行：操作按钮 + 时间（进度条单独占一行，窄框体里也不会被挤没） */}
    <div className="cv-audio__row">
      <button type="button" className="cv-audio__btn nodrag" onClick={toggle} aria-label={playing ? '暂停' : '播放'}>{<PlayIcon playing={playing} />}</button>
      <span className="cv-audio__time">{formatTime(current)} / {formatTime(duration)}</span>
      <button type="button" className="cv-audio__btn nodrag" onClick={toggleMute} aria-label={muted ? '取消静音' : '静音'}><VolumeIcon muted={muted} /></button>
    </div>
    <audio ref={audioRef} src={src} preload="metadata" hidden />
  </div>;
}
