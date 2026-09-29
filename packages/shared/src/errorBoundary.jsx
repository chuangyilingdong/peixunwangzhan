import { Component } from 'react';

/**
 * 全站渲染兜底（2026-09-29）：三端遇到**渲染期异常**时不再整页白。
 *
 * 为什么加它：09-29 这一天两次白屏（后台 §六十一「选新加的模型就白屏」、学生画布 §五十五
 * 少一个 `?.`）表现一模一样 —— **整页空白、一个字都没有**：用户能说的只有"白的"，
 * 我们也只能靠控制台或猜。错误边界多一层保障：子树渲染抛错时换成一张**兜底页**，
 * 把"哪一行报的"留在屏幕上（同一台机器上打开就有，不用复现、不用远程）。
 *
 * ⚠️ 三条边界，写清楚免得以后误以为它什么都能兜：
 *   ① 只抓**渲染期**异常（render / 构造函数 / 生命周期 / 子树）；
 *   ② 抓不到**事件处理器**里抛的、**异步回调**（Promise / setTimeout / rollup 的 catch）里的异常
 *      —— 那些仍要各页面自己 try/catch + `errorText()` 显示；
 *   ③ 兜底页**不许依赖任何数据与样式表**（它自己就在异常路径上）：不取接口、不读 session、
 *      全用内联样式 —— 否则会出现"兜底页自己也白"。
 */
export class AppErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  // 只记日志、不吞：出事时控制台里要有能定位的那一行（用户截图或远程看都靠它）。
  componentDidCatch(error, info) { console.error('[AppErrorBoundary] 渲染失败：', error, info?.componentStack || ''); }
  // 「重试这一页」只清 error 状态：瞬时错误（比如某一帧坏数据）会自己过去；
  // 确定性错误会立刻再抛一次、回到兜底页，不会把页面留成半坏的样子。
  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    const message = String(error?.message || error || '未知错误');
    const button = { border: '1px solid #7c5cff', background: '#7c5cff', color: '#fff', borderRadius: 10, padding: '9px 18px', font: 'inherit', cursor: 'pointer' };
    return <div role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f6f5fb', color: '#2b2440' }}>
      <div style={{ maxWidth: 620, width: '100%', background: '#fff', border: '1px solid #e6e2f5', borderRadius: 16, padding: '28px 30px', boxShadow: '0 12px 32px rgba(58, 40, 120, 0.08)' }}>
        <p style={{ margin: 0, color: '#7c5cff', fontSize: 13, letterSpacing: '0.08em' }}>灵动ai学院</p>
        <h1 style={{ margin: '6px 0 10px', fontSize: 22, lineHeight: 1.4 }}>这一页没能画出来</h1>
        <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.7, color: '#5a5470' }}>
          不是你的操作问题，是页面自己出的错。可以先点「重新加载」；如果每次都这样，把下面这行报错信息发给平台，我们能直接定位。
        </p>
        <pre style={{ margin: '0 0 18px', padding: '10px 12px', background: '#f6f5fb', border: '1px solid #e6e2f5', borderRadius: 10, fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#8a3b5c' }}>{message}</pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" style={button} onClick={() => window.location.reload()}>重新加载</button>
          <button type="button" style={{ ...button, background: '#fff', color: '#7c5cff' }} onClick={() => this.setState({ error: null })}>重试这一页</button>
        </div>
      </div>
    </div>;
  }
}
