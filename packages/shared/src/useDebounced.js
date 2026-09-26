import { useEffect, useState } from 'react';

/**
 * 把"输入框里的值"延迟成"查询用的值"（2026-09-26，搜索手感）。
 *
 * 为什么要有它：几处列表页原来把关键词**直接**拼进查询，而数据钩子（`useData`）的依赖一变就重取 ——
 * 于是**每敲一个字**都发一次请求。用户报的原话：「搜索交互有问题，每输入一个字符页面就要自动刷新一次，
 * 会有明显卡顿感」（机构端「作品管理」那条请求还带 `includeSnapshot=true`，响应本身也不小）。
 * 更糟的是那些页面在 `loading` 时会**整页换成 Loading** → 观感就是"每打一个字页面闪一下"。
 * 防抖之后：连着敲字只在**停下来**那一刻发一次请求。
 *
 * 用法（输入框绑原值、查询用这个值）：
 *   const [filters, setFilters] = useState({ search: '' });
 *   const debouncedSearch = useDebouncedValue(filters.search, 350);
 *   const query = useMemo(() => `?search=${encodeURIComponent(debouncedSearch.trim())}`, [debouncedSearch]);
 *
 * ⚠️ 只防"自由输入"（关键词、型号名这类）。下拉/日期/复选是**点一下就变**的离散控件，
 *    它们不该走这里 —— 防抖会让"点了没反应"变成新的手感问题（各页面的做法：只把 search 这类
 *    文本字段过这个钩子，select 保持原样）。
 */
export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), Math.max(0, Number(delay) || 0));
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
