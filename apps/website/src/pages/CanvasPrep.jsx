// 老师端「画布备课」——**就是学生那套画布课堂**（2026-09-30 用户口径）。
//
// 用户原话（两次）：
//   「老师端可以自由无限制进入对应的课时课堂，画布/VibeCoding，他们可以走流程，但是无法生成。
//     VibeCoding的发送按钮隐藏，画布课堂生成按钮隐藏。」
//   「为什么是在这里显示啊，**我是说可以直接进入到画布课堂啊**。」
//
// 所以这一页**不自己画界面**：它只做两件事 ——
//   ① 用机构端会话去取这节课的备课数据（`GET /api/org/lessons/<id>/prep?mode=CANVAS`）；
//   ② 把那节课塞进 `CanvasWorkspace` 的 **prep 模式**：老师看到的就是学生画布课堂（同一个组件、
//      同一套「课堂素材」面板与底部提示词面板），只是**不生成**（生成按钮不渲染）、
//      **不落库**（草稿只写本机 localStorage）。
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CanvasWorkspace, createApiClient, ErrorState, Loading, readAppSession } from '@platform/shared';

const EMPTY_SNAPSHOT = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

/** 备课草稿的存档键：按课时存，互不干扰（画布那边也按它读写）。 */
export const prepDraftKey = (lessonId) => `lesson-prep-canvas:${lessonId}`;

/**
 * 2026-10-30 用户报：老师端「画布备课」点「素材1」图片失效，学生端正常。
 *
 * 根因：课时素材上传时存的是**学生域地址**
 * `/api/student/file-assets/<id>/download`（见 admin 的 CourseManagement.uploadMaterial），
 * 而备课页用的是**机构端 token**。学生域路由 `requireRole(['STUDENT'])` 会直接 403，
 * 画布里的 `<img>` 于是裂图；学生端自己带 STUDENT 身份取同一地址就正常。
 *
 * 文件本身是 `PUBLIC_PLATFORM`，机构端 `/api/org/file-assets/<id>/download` 是可读的
 * （authorizeFileAccess 对 PUBLIC_PLATFORM 放行）。平台后台的 MaterialPreview 早就用
 * 「student/org → admin」的读取时改写解决同一件事，这里按同一口径改成 student → org。
 *
 * ⚠️ 必须**递归**改写：素材地址既在 `materialGroups[].materials[].assetUrl`，
 * 也可能在画布草稿节点的 `data.assetUrl` / `previewUrl` 里（老师上次保存的草稿）。
 */
function rewriteStudentAssetUrls(value) {
  if (typeof value === 'string') {
    return value.replace(
      /^\/api\/student\/file-assets\/([\w-]+)\/download(\?.*)?$/,
      (_, fileId, query = '') => `/api/org/file-assets/${fileId}/download${query}`,
    );
  }
  if (Array.isArray(value)) return value.map(rewriteStudentAssetUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStudentAssetUrls(item)]));
  }
  return value;
}

export function CanvasPrepPage() {
  const { lessonId } = useParams();
  const [state, setState] = useState({ loading: true, error: '', data: null });
  // ⚠️ 这一页挂在**网站域**（学生的画布课堂那一套），但登录的人是**老师** ——
  //    会话按应用分桶（见 auth.js），这里必须读**机构端**那份，否则永远 401。
  const api = useMemo(() => createApiClient({ getToken: () => readAppSession('org')?.token, onUnauthorized: () => {} }), []);

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: '', data: null });
    api.get(`org/lessons/${encodeURIComponent(lessonId)}/prep?mode=CANVAS`)
      .then((data) => { if (!cancelled) setState({ loading: false, error: '', data }); })
      .catch((error) => {
        const unauthorized = Number(error?.status) === 401 || /登录|无权/.test(String(error?.message || ''));
        if (!cancelled) {
          setState({
            loading: false, data: null,
            error: unauthorized
              ? '备课画布要用机构端账号打开：请先在机构后台登录，再点课时详情里的「画布备课」。'
              : (error?.message || '打不开这节课的备课画布'),
          });
        }
      });
    return () => { cancelled = true; };
  }, [api, lessonId]);

  // 注入给画布的"项目"：形状与 `student/projects/:id` 一致，但**不落库** ——
  // 起点优先用本机草稿（老师上次摆的还在），否则课时的初始画布模板。
  const prep = useMemo(() => {
    if (!state.data) return null;
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(prepDraftKey(lessonId)) || 'null'); } catch { saved = null; }
    const template = state.data.canvasSnapshot;
    const chosen = saved && Array.isArray(saved.nodes) && saved.nodes.length
      ? saved
      : (template && Array.isArray(template.nodes) && template.nodes.length ? template : EMPTY_SNAPSHOT);
    return {
      draftKey: prepDraftKey(lessonId),
      project: {
        id: `prep:${lessonId}`,
        title: state.data.lesson?.title || '备课画布',
        status: 'DRAFT',                    // 让画布"可编辑"（isCanvasEditableProjectStatus 只认 DRAFT/SUBMITTED）
        canvasSnapshot: rewriteStudentAssetUrls(chosen),
        materialGroups: rewriteStudentAssetUrls(state.data.materialGroups || []),
        generationBoxes: rewriteStudentAssetUrls(state.data.generationBoxes || []),
        capabilities: state.data.lesson?.capabilities || ['text'],
        lessonTitle: state.data.lesson?.title || '',
        seriesTitle: state.data.lesson?.seriesTitle || '',
      },
    };
  }, [state.data, lessonId]);

  if (state.loading) return <main className="cv-shell"><div className="cv-state"><Loading label="正在打开备课画布…" /></div></main>;
  if (state.error) return <main className="cv-shell"><div className="cv-state"><ErrorState error={state.error} /></div></main>;
  return <CanvasWorkspace api={api} prep={prep} />;
}
