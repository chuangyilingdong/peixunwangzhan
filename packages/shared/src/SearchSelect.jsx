import { useEffect, useId, useRef, useState } from 'react';
import './search-select.css';

export function getSearchSelectKeyAction(key, open) {
  if (key === 'ArrowDown') return { type: open ? 'MOVE' : 'OPEN', direction: 1 };
  if (key === 'ArrowUp') return { type: open ? 'MOVE' : 'OPEN', direction: -1 };
  if (key === 'Enter' && open) return { type: 'SELECT' };
  if (key === 'Escape' && open) return { type: 'CLOSE' };
  return null;
}

export function SearchSelect({
  value,
  onChange,
  options = [],
  placeholder = '请选择',
  searchPlaceholder = '搜索…',
  emptyText = '没有匹配项',
  ariaLabel = '搜索选择',
  disabled = false,
  getLabel = (item) => item.label ?? item.title ?? item.name ?? '',
  getDisabled = (item) => Boolean(item.disabled),
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);
  const listboxId = useId();
  const selected = options.find((item) => item.id === value);
  const filtered = options.filter((item) => String(getLabel(item)).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeOption = activeIndex >= 0 ? filtered[activeIndex] : null;

  function firstEnabledIndex(items, start, direction) {
    if (!items.length) return -1;
    for (let step = 0; step < items.length; step += 1) {
      const index = (start + direction * step + items.length) % items.length;
      if (!getDisabled(items[index])) return index;
    }
    return -1;
  }

  function openMenu(direction = 1) {
    if (disabled) return;
    setOpen(true);
    setActiveIndex(firstEnabledIndex(filtered, direction > 0 ? 0 : filtered.length - 1, direction));
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function selectOption(item) {
    if (!item || getDisabled(item)) return;
    onChange(item.id, item);
    closeMenu({ restoreFocus: true });
  }

  function moveActive(direction) {
    if (!filtered.length) return;
    const start = activeIndex < 0
      ? (direction > 0 ? 0 : filtered.length - 1)
      : (activeIndex + direction + filtered.length) % filtered.length;
    setActiveIndex(firstEnabledIndex(filtered, start, direction));
  }

  function handleKeyDown(event) {
    const action = getSearchSelectKeyAction(event.key, open);
    if (!action) return;
    event.preventDefault();
    if (action.type === 'OPEN') openMenu(action.direction);
    else if (action.type === 'MOVE') moveActive(action.direction);
    else if (action.type === 'SELECT') selectOption(activeOption);
    else closeMenu({ restoreFocus: true });
  }

  useEffect(() => {
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(firstEnabledIndex(filtered, 0, 1));
  }, [query]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  return <div ref={rootRef} className="search-select">
    <button
      ref={triggerRef}
      type="button"
      className="secondary-button wide search-select-trigger"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={handleKeyDown}
    >
      <span>{selected ? getLabel(selected) : placeholder}</span>
      <span aria-hidden="true">⌄</span>
    </button>
    {open ? <div className="search-select-menu">
      <input
        ref={inputRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={activeOption ? `${listboxId}-${activeIndex}` : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={searchPlaceholder}
      />
      <div id={listboxId} className="search-select-options" role="listbox" aria-label={ariaLabel}>
        {filtered.map((item, index) => {
          const optionDisabled = getDisabled(item);
          return <button
            id={`${listboxId}-${index}`}
            type="button"
            role="option"
            className="search-select-option"
            key={item.id}
            tabIndex={-1}
            disabled={optionDisabled}
            aria-disabled={optionDisabled}
            aria-selected={item.id === value}
            data-active={index === activeIndex ? 'true' : undefined}
            onMouseMove={() => { if (!optionDisabled) setActiveIndex(index); }}
            onClick={() => selectOption(item)}
          >{getLabel(item)}</button>;
        })}
        {!filtered.length ? <p className="search-select-empty" role="status">{emptyText}</p> : null}
      </div>
    </div> : null}
  </div>;
}
