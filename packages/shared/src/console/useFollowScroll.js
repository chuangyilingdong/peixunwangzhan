// 对话滚动跟随。
//
// 这是自动跟随能不能用的分水岭：必须区分「应用自己滚的」和「读者滚的」。
// 应用自己发起的滚动会先记下目标位置，滚动事件里位移对得上就忽略——
// 因为内容增长、scroll-anchoring 修正、原生滚动条拖拽都会产生没有用户输入的
// 位移，不标记的话它们会被当成「读者上滑了」，跟随立刻失灵、列表开始和
// 自己写的高度修正互相打架。
//
// 阈值：离开 2px（真的到底才算跟随中），恢复 60px（往下滚一点就重新跟随，
// 这是刻意的宽恕区）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const LIVE_EDGE_EPSILON = 2;
const RESUME_FOLLOW_GAP = 60;

export function useFollowScroll(deps = []) {
  const ref = useRef(null);
  const [following, setFollowing] = useState(true);
  const programmaticTopRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const target = node.scrollHeight - node.clientHeight;
    programmaticTopRef.current = target;
    node.scrollTop = target;
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const onScroll = () => {
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (programmaticTopRef.current != null && Math.abs(node.scrollTop - programmaticTopRef.current) <= 1) return;
      programmaticTopRef.current = null;
      setFollowing(gap < RESUME_FOLLOW_GAP && gap >= -LIVE_EDGE_EPSILON);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  // 跟随中时，每次依赖变化（新消息、流式增量、产物落地）都贴回底部
  useLayoutEffect(() => {
    if (following) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, ...deps]);

  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    scrollToBottom();
  }, [scrollToBottom]);

  return { ref, following, jumpToLatest, scrollToBottom };
}

/**
 * 量出输入面板的实际高度，写进 CSS 变量给滚动区预留底部空间。
 * 刻意不加过渡：要让它逐帧跟随面板高度变化，加了过渡反而会滞后。
 */
export function useDockHeight() {
  const ref = useRef(null);
  const [height, setHeight] = useState(200);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}
