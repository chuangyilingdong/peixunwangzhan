// 输入面板。
//
// 几个刻意照抄参考的细节：
// · 面板是 24px 大圆角的面板而不是「胶囊」，最小高度 128px；
// · textarea 内边距上 16px、下 6px（上大下小），视觉重心落在顶部；
// · 发送键是 34px 圆形：不可用时中性底，可用时才点亮成橙色；
// · 流式中发送键不消失，而是同槽位换成红色停止键；
// · Enter 发送 / Shift+Enter 换行，且必须挡掉输入法组合态（中文输入时
//   按 Enter 是在选词，不能当发送）。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ConsoleIcon } from './icons.jsx';
import { Kbd } from './primitives.jsx';

const MAX_TEXTAREA_HEIGHT = 160;
const MIN_TEXTAREA_HEIGHT = 68;

export const Composer = forwardRef(function Composer({
  value, onChange, onSubmit, onStop, streaming = false, disabled = false,
  blockedReason = '', placeholder = '说说你想做什么…', history = [], maxLength = 4000,
  attachments = [], onAttach, onRemoveAttachment, uploading = false,
}, ref) {
  const textareaRef = useRef(null);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const next = Math.max(MIN_TEXTAREA_HEIGHT, Math.min(MAX_TEXTAREA_HEIGHT, node.scrollHeight));
    node.style.height = `${next}px`;
  }, []);

  useImperativeHandle(ref, () => ({ resize, focus: () => textareaRef.current?.focus() }), [resize]);

  useEffect(() => { resize(); }, [value, resize]);

  const submit = useCallback(() => {
    const text = String(value || '').trim();
    if (!text || streaming || disabled) return;
    setHistoryIndex(-1);
    onSubmit?.(text);
  }, [value, streaming, disabled, onSubmit]);

  const onKeyDown = useCallback((event) => {
    // 输入法组合中的 Enter 是在选词，直接放行
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape' && !streaming && value) {
      onChange?.('');
      return;
    }
    // 无修饰的上下键翻历史输入；只在光标处于边界时认领，避免抢走段落移动
    if (!history.length || streaming) return;
    const node = textareaRef.current;
    if (event.key === 'ArrowUp' && node && node.selectionStart === 0 && !value) {
      event.preventDefault();
      const next = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(next);
      onChange?.(history[next]);
    } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      onChange?.(next < 0 ? '' : history[next]);
    }
  }, [submit, streaming, value, onChange, history, historyIndex]);

  const canSend = Boolean(String(value || '').trim()) && !disabled && !blockedReason;
  const sendDisabled = streaming ? false : !canSend;

  return (
    <div className="c-composer">
      {blockedReason ? <div className="c-send-block">{blockedReason}</div> : null}
      <div className="c-composer__panel">
        {/* 已选附件：缩略图 + 文件名 + 可单独删 */}
        {attachments.length ? (
          <div className="c-attachments">
            {attachments.map((item) => (
              <span className="c-attachment" key={item.id}>
                {item.url ? <img className="c-attachment__thumb" src={item.url} alt="" /> : <ConsoleIcon name="file" size={14} />}
                <span className="c-attachment__name">{item.name}</span>
                {onRemoveAttachment ? (
                  <button type="button" className="c-attachment__remove" aria-label={`移除 ${item.name}`} onClick={() => onRemoveAttachment(item)}>
                    <ConsoleIcon name="x" size={12} />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          className="c-composer__input"
          value={value}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="输入消息"
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="c-composer__foot">
          <div className="c-composer__left">
            {onAttach ? (
              <button
                type="button"
                className="c-icon-btn c-icon-btn--sm"
                aria-label="上传图片"
                title="上传图片（也可以把图片直接拖进聊天区）"
                disabled={disabled || uploading}
                onClick={onAttach}
              >
                <ConsoleIcon name={uploading ? 'loader' : 'image'} size={15} />
              </button>
            ) : null}
            <span className="c-dim" style={{ fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums' }}>
              {value ? `${String(value).length} / ${maxLength}` : ''}
            </span>
          </div>
          <div className="c-composer__right">
            {streaming ? (
              <button type="button" className="c-send is-stop" onClick={onStop} aria-label="停止生成" title="停止生成（Esc）">
                <ConsoleIcon name="stop" size={15} />
              </button>
            ) : (
              <button
                type="button"
                className={`c-send${canSend ? ' is-ready' : ''}`}
                disabled={sendDisabled}
                onClick={submit}
                aria-label="发送"
                title="发送（Enter）"
              >
                <ConsoleIcon name="arrowUp" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="c-composer__hint">
        <Kbd>Enter</Kbd><span>发送</span>
        <Kbd>Shift</Kbd><span>+</span><Kbd>Enter</Kbd><span>换行</span>
      </div>
    </div>
  );
});
