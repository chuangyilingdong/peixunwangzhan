// 课堂四个页面的共用展示件（2026-09-17，按线框图改造）。
//
// 这一层只负责「长什么样」，不碰数据：线框图里的信息条、校验清单、规则条、业务链、
// 父级行、字段栅格都是纯排版，四个页面（列表 / 创建 / 详情 / 添加学生）反复要用。
// 样式尽量复用 packages/shared/src/styles.css 里已有的原语
// （.publish-check / .wizard-steps / .status / .notice），本项目自己有的一套就够用。
import { useEffect, useId, useRef, useState } from 'react';
import { Notice } from '@platform/shared';

/**
 * 课堂页统一的对话弹窗（原生 <dialog>，自动获得焦点陷阱与 Esc 关闭）。
 * 线框图的确认弹窗都长这样：标题 + 父级行 + 信息带 + 若干带色块 → 底部两个按钮。
 */
export function Modal({ title, parent, description, children, onClose, footer, busy, error, wide = false, headerAction = null }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus?.(); };
  }, []);
  // ⭐ 2026-10-03（§一百）：wide 变体的**尺寸/一屏/整窗不滚**口径挪进了 shared 的
  //    `.c-work-preview-dialog`（平台端那份预览弹窗此前漂成了 480px 的小框，就是各写一份的下场）。
  //    内容格用 shared 的 `__body`：flex:1 + 自己滚，页眉页脚常驻；预览舞台吃满剩下高度。
  return <dialog ref={ref} className={`classroom-dialog${wide ? ' classroom-dialog-wide c-work-preview-dialog' : ''}`} aria-labelledby={titleId} aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    {/* `headerAction`：页眉右上角那格（2026-10-01 用户口径 —— 作品分享按钮要跟其它入口一致，
        放**右上角**而不是底部按钮行；见 ClassroomWork 里的用法）。 */}
    <div className="classroom-dialog-head"><h3 id={titleId}>{title}</h3>{headerAction}</div>
    {parent?.length ? <ParentLine items={parent} /> : null}
    {description ? <p className="muted">{description}</p> : null}
    {error ? <div role="alert"><Notice tone="danger">{error}</Notice></div> : null}
    <fieldset disabled={busy} className={`classroom-dialog-fields${wide ? ' c-work-preview-dialog__body' : ''}`}>{children}</fieldset>
    <fieldset disabled={busy} className="classroom-dialog-fields row-actions top-gap">{footer}</fieldset>
  </dialog>;
}

/** 子页标题下面那行灰字：父级：005-01 | 我的课堂（线框图每个子页都有）。 */
export function ParentLine({ items }) {
  return <p className="classroom-parent-line">父级：{items.filter(Boolean).join(' | ')}</p>;
}

/** 弹窗/页面顶部那条三格信息带：当前课堂 / 课包·课程 / 学生数。 */
export function InfoStrip({ items }) {
  return <dl className="classroom-info-strip">{items.map((item) => (
    <div key={item.label}>
      <dt>{item.label}</dt>
      <dd>{item.value}{item.badge ? <span className="classroom-info-strip-badge">{item.badge}</span> : null}</dd>
      {item.note ? <small className="muted">{item.note}</small> : null}
    </div>
  ))}</dl>;
}

/**
 * 逐条校验清单（开始上课 / 解散课堂的二次确认）。
 * checks 由服务端预检接口给出 —— 界面不自己推断通过与否，推不出来的条目宁可不显示，
 * 也不能凭空打勾（这条是本项目最容易犯的「静默失败」）。
 */
export function Checklist({ title, checks = [], passedLabel = '全部通过', failedLabel = '有未通过项' }) {
  const list = checks || [];
  const allPassed = list.length > 0 && list.every((check) => check.passed);
  return <section className="classroom-block">
    <div className="classroom-block-head">
      <h4>{title}</h4>
      {list.length ? <span className={'status ' + (allPassed ? 'success' : 'warning')}>{allPassed ? passedLabel : failedLabel}</span> : null}
    </div>
    {list.length ? <div className="publish-checklist">{list.map((check) => (
      <div key={check.key} className={'publish-check ' + (check.passed ? 'is-ok' : 'is-warn')}>
        <strong>{check.passed ? '✓' : '!'}</strong>
        <span>{check.label}</span>
        {check.detail ? <small className={'muted' + (check.passed ? '' : ' danger-text')}>{check.detail}</small> : null}
      </div>
    ))}</div> : <p className="muted">正在读取校验结果…</p>}
  </section>;
}

/** 带小标题的段落块（弹窗里「保存后的影响 / 确认开始后的状态变化」这些段）。 */
export function Block({ title, children }) {
  return <section className="classroom-block">
    {title ? <div className="classroom-block-head"><h4>{title}</h4></div> : null}
    {children}
  </section>;
}

/** 带编号的规则/边界说明（蓝色=说明，橙色=边界与影响，绿色=结果）。 */
export function RuleList({ title, items = [], tone = 'info', footer }) {
  return <Notice tone={tone}>
    {title ? <strong>{title}</strong> : null}
    <ol className="classroom-rule-list">{items.map((item, index) => <li key={typeof item === 'string' ? item : index}>{item}</li>)}</ol>
    {footer ? <p className="muted">{footer}</p> : null}
  </Notice>;
}

/** 保存后的业务链（创建课堂页底部那四个带编号的步骤）。 */
export function FlowSteps({ steps }) {
  return <ol className="wizard-steps">{steps.map((step, index) => (
    <li key={step.title} className={index === 0 ? 'is-active' : ''}><span>{index + 1}</span>{step.title}</li>
  ))}</ol>;
}

/** 字段栅格：课堂信息那类「标签 + 值」的成对信息。 */
export function DefinitionGrid({ items, columns }) {
  return <dl className="classroom-facts" data-columns={columns || undefined}>{items.map((item) => (
    <div key={item.label}>
      <dt>{item.label}</dt>
      <dd>
        {item.value}
        {item.badge ? <span className={'status' + (item.badgeTone && item.badgeTone !== 'muted' ? ' ' + item.badgeTone : '')}>{item.badge}</span> : null}
        {item.note ? <small className="muted">{item.note}</small> : null}
      </dd>
    </div>
  ))}</dl>;
}

/** 「本页不包含 / 页面边界」这类灰底说明条。 */
export function BoundaryNote({ title, lines = [], tone = 'warning' }) {
  return <Notice tone={tone}>{title ? <strong>{title}</strong> : null}{lines.map((line) => <p key={line} className="classroom-boundary-line">{line}</p>)}</Notice>;
}

/**
 * 修改作品名称（2026-10-05 用户口径：「学生提交上来的作品，老师/机构/平台都可以改作品名称；
 * 改名后分享页、官网作品都要同步」）。
 *
 * 三处入口共用这一个弹窗（课堂详情表、作品预览弹窗页眉、作品管理列表），别再各写一份。
 * 改的就是作品行的 `title` 一列 —— 三端列表、作品广场、分享卡读的都是它，所以改一次全同步；
 * 作用域由服务端按**与读面同一套 WHERE** 判定（老师只改得了自己课堂的，越权是 404）。
 */
export function RenameWorkDialog({ api, workBase, work, onClose, onRenamed }) {
  const [title, setTitle] = useState(String(work?.title || ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = title.trim();
  async function save() {
    if (!next || busy) return;
    setBusy(true); setError('');
    try {
      await api.put(`${workBase}/${encodeURIComponent(work?.source || 'CANVAS')}/${encodeURIComponent(work?.id)}`, { title: next });
      onRenamed?.(next);
      onClose();
    } catch (reason) {
      setError(reason?.message || '改名没有成功，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return <Modal title="修改作品名称" busy={busy} error={error} onClose={onClose}
    footer={<>
      <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      <button className="primary-button" disabled={busy || !next} onClick={save}>{busy ? '保存中…' : '保存名称'}</button>
    </>}>
    <label>作品名称 *<input value={title} maxLength={200} autoFocus placeholder="例如：布布的小窝"
      onChange={(event) => setTitle(event.target.value)} /></label>
  </Modal>;
}
