# P0-B: 账号与权限安全验证测试脚本

## 📋 测试目标

验证系统的角色权限隔离和越权防护机制，确保：
1. 四角色（平台管理员、机构管理员、教师、学生）权限正确隔离
2. 跨机构数据访问被正确阻止
3. 学生只能访问自己的数据
4. 教师只能访问自己班级的数据

---

## 1. 权限验证机制分析

### 1.1 核心权限函数（lib.js）

```javascript
// 基础认证验证
export function requireAuth(ctx)
// 返回: ctx.auth（包含 user 信息）
// 失败: 抛出 401 错误

// 角色验证
export function requireRole(ctx, roles)
// 检查: auth.user.role 是否在 roles 列表中
// 失败: 抛出 403 错误

// 机构管理员/教师验证
export function requireOrgStaff(ctx)
// 允许: SUPER_ADMIN, ORG_ADMIN, TEACHER
// 自动验证: orgId 匹配

// 平台管理员权限验证
export function requirePlatformPermission(ctx, permission)
// 检查: SUPER_ADMIN 的细分权限
```

### 1.2 数据隔离机制

**学生端（student.js）所有查询都包含**:
```sql
WHERE student_id = ? AND org_id = ?
参数: [ctx.auth.user.id, ctx.auth.user.orgId]
```

**关键发现**:
- ✅ 所有学生端查询都包含 `student_id` 和 `org_id` 双重验证
- ✅ 项目、作品、进度查询都强制机构隔离
- ✅ 查询中使用参数化，防止 SQL 注入

---

## 2. 权限矩阵

| 角色 | 平台管理 | 机构管理 | 课堂管理 | 自己数据 | 其他学生 | 其他机构 |
|------|---------|---------|---------|---------|---------|---------|
| **SUPER_ADMIN** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ORG_ADMIN** | ❌ | ✅ (自己机构) | ✅ (自己机构) | ✅ | ✅ (同机构) | ❌ |
| **TEACHER** | ❌ | ❌ | ✅ (自己班级) | ✅ | ✅ (自己班级) | ❌ |
| **STUDENT** | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |

---

## 3. 越权测试用例

### 3.1 学生跨机构越权测试

**测试场景**: 机构 A 的学生尝试访问机构 B 的学生作品

```bash
# 测试用例 1: 学生访问其他机构的项目
curl -X GET "http://localhost:3001/api/student/projects/{other_org_project_id}" \
  -H "Cookie: session={org_a_student_session}"

# 预期结果: 404 或 403 错误
# 原因: 查询包含 org_id 过滤
# SQL: SELECT * FROM student_projects WHERE id=? AND student_id=? AND org_id=?
```

**验证点**:
- [ ] 返回 404 或 403 错误
- [ ] 不返回其他机构的数据
- [ ] 日志中没有数据泄露

---

### 3.2 学生访问同机构其他学生数据

**测试场景**: 机构 A 的学生 1 尝试访问学生 2 的项目

```bash
# 测试用例 2: 学生访问同机构其他学生的项目
curl -X GET "http://localhost:3001/api/student/projects/{student2_project_id}" \
  -H "Cookie: session={student1_session}"

# 预期结果: 404 或 403 错误
# 原因: 查询包含 student_id 过滤
# SQL: WHERE id=? AND student_id=? AND org_id=?
```

**验证点**:
- [ ] 返回 404 错误
- [ ] 不返回其他学生的数据
- [ ] 查询日志显示 student_id 不匹配

---

### 3.3 教师跨班级越权测试

**测试场景**: 教师 A 尝试访问教师 B 班级的学生作品

```bash
# 测试用例 3: 教师访问其他班级的作品
curl -X GET "http://localhost:3001/api/org/works?classId={other_teacher_class_id}" \
  -H "Cookie: session={teacher_a_session}"

# 预期结果: 空列表或 403 错误
# 原因: 教师只能访问自己班级的数据
```

**验证点**:
- [ ] 不返回其他班级的数据
- [ ] 或返回 403 错误
- [ ] 班级成员验证生效

---

### 3.4 机构管理员跨机构越权测试

**测试场景**: 机构 A 管理员尝试访问机构 B 的课程包

```bash
# 测试用例 4: 机构管理员访问其他机构的课程包
curl -X GET "http://localhost:3001/api/org/course-series" \
  -H "Cookie: session={org_a_admin_session}"

# 预期结果: 只返回授权给机构 A 的课程包
# SQL: 包含机构授权检查
```

**验证点**:
- [ ] 只返回授权给该机构的课程包
- [ ] 不返回其他机构独有的课程包
- [ ] 授权表正确关联

---

### 3.5 学生尝试访问管理端 API

**测试场景**: 学生尝试调用管理员 API

```bash
# 测试用例 5: 学生访问管理端课程包创建接口
curl -X POST "http://localhost:3001/api/admin/course-series" \
  -H "Cookie: session={student_session}" \
  -H "Content-Type: application/json" \
  -d '{"title":"黑客课程","description":"越权测试"}'

# 预期结果: 403 错误
# 原因: requireRole(['SUPER_ADMIN']) 验证失败
```

**验证点**:
- [ ] 返回 403 错误
- [ ] 不创建任何数据
- [ ] 角色验证生效

---

## 4. 数据查询安全验证

### 4.1 学生端查询安全检查

**关键查询位置**: `apps/server/src/routes/student.js`

```javascript
// ✅ 安全查询示例（第 85 行）
row('SELECT * FROM student_projects WHERE id=? AND student_id=? AND org_id=?',
    [projectId, ctx.auth.user.id, ctx.auth.user.orgId])

// ✅ 安全查询示例（第 121 行）
row('SELECT * FROM works WHERE id=? AND student_id=? AND org_id=?',
    [workId, ctx.auth.user.id, ctx.auth.user.orgId])

// ✅ 安全查询示例（第 264 行）
rows('SELECT * FROM student_projects WHERE student_id=? AND org_id=?',
     [ctx.auth.user.id, ctx.auth.user.orgId])
```

**验证点**:
- [x] 所有查询包含 `student_id` 过滤
- [x] 所有查询包含 `org_id` 过滤
- [x] 使用参数化查询（防止 SQL 注入）
- [x] 没有使用字符串拼接

---

### 4.2 机构端查询安全检查

**关键查询位置**: `apps/server/src/routes/org.js`

**需要验证的点**:
- [ ] 课程包查询是否包含机构授权检查
- [ ] 班级查询是否包含 org_id 过滤
- [ ] 学生列表查询是否包含 org_id 过滤
- [ ] 作品查询是否包含机构/班级过滤

---

## 5. 会话安全验证

### 5.1 会话劫持防护

**测试场景**: 尝试使用其他用户的 session cookie

```bash
# 测试用例 6: 会话 cookie 跨用户使用
# 1. 获取学生 A 的 session cookie
# 2. 学生 B 尝试使用学生 A 的 cookie

curl -X GET "http://localhost:3001/api/student/dashboard" \
  -H "Cookie: session={student_a_session_from_student_b_browser}"

# 预期结果: 401 未授权或返回学生 A 的数据（会话有效）
# 风险评估: 如果返回数据，说明会话可被劫持
```

**防护措施建议**:
- [ ] 检查会话是否绑定 IP 地址
- [ ] 检查会话是否绑定 User-Agent
- [ ] 实现会话超时机制
- [ ] 实现并发登录检测

---

### 5.2 会话过期验证

```bash
# 测试用例 7: 使用已过期的 session
# 等待会话超时后（根据 expires_at 字段）

curl -X GET "http://localhost:3001/api/student/dashboard" \
  -H "Cookie: session={expired_session}"

# 预期结果: 401 未授权
```

**验证点**:
- [ ] 过期会话返回 401
- [ ] 用户被重定向到登录页
- [ ] 过期会话无法续期

---

## 6. 文件访问权限验证

### 6.1 私有文件访问控制

**测试场景**: 学生 A 尝试访问学生 B 的私有文件

```bash
# 测试用例 8: 访问其他学生的私有文件
curl -X GET "http://localhost:3001/api/file-assets/{student_b_private_file_id}/download" \
  -H "Cookie: session={student_a_session}"

# 预期结果: 403 或 404 错误
# 原因: 文件 visibility 为 PRIVATE，owner_id 不匹配
```

**验证点**:
- [ ] 私有文件只有所有者可访问
- [ ] PRIVATE 文件访问验证生效
- [ ] 返回正确的错误码

---

### 6.2 公开文件访问验证

**测试场景**: 未登录用户访问 PUBLIC_PLATFORM 文件

```bash
# 测试用例 9: 未登录访问公开封面（新功能）
curl -X GET "http://localhost:3001/api/public/file-assets/{cover_asset_id}/download"

# 预期结果: 200 成功，返回图片
# 原因: visibility 为 PUBLIC_PLATFORM
```

**验证点**:
- [ ] PUBLIC_PLATFORM 文件无需登录可访问 ✨
- [ ] 返回正确的 Content-Type
- [ ] 文件内容正确

---

### 6.3 机构文件访问控制

**测试场景**: 机构 A 的用户访问机构 B 的 PUBLIC_ORG 文件

```bash
# 测试用例 10: 跨机构访问机构公开文件
curl -X GET "http://localhost:3001/api/file-assets/{org_b_public_file_id}/download" \
  -H "Cookie: session={org_a_user_session}"

# 预期结果: 403 错误
# 原因: PUBLIC_ORG 文件只有同机构用户可访问
```

**验证点**:
- [ ] PUBLIC_ORG 文件只有同机构可访问
- [ ] 跨机构访问被阻止
- [ ] org_id 验证生效

---

## 7. API 端点权限审计

### 7.1 管理端 API (/api/admin/*)

**应该受保护的端点**:
```
POST /api/admin/course-series           - 创建课程包
PUT /api/admin/course-series/:id        - 编辑课程包
POST /api/admin/file-assets/upload      - 上传文件
POST /api/admin/organizations           - 创建机构
DELETE /api/admin/users/:id             - 删除用户
```

**验证**:
- [ ] 所有端点都调用 `requireRole(['SUPER_ADMIN'])`
- [ ] 非管理员访问返回 403
- [ ] 没有权限绕过漏洞

---

### 7.2 机构端 API (/api/org/*)

**应该受保护的端点**:
```
GET /api/org/course-series              - 查看机构课程包
POST /api/org/classes                   - 创建班级
POST /api/org/members                   - 添加成员
GET /api/org/works                      - 查看作品
```

**验证**:
- [ ] 所有端点都调用 `requireOrgStaff(ctx)`
- [ ] 学生访问返回 403
- [ ] orgId 过滤生效

---

### 7.3 学生端 API (/api/student/*)

**应该受保护的端点**:
```
GET /api/student/dashboard              - 学生仪表盘
GET /api/student/projects/:id           - 查看项目
POST /api/student/projects              - 创建项目
GET /api/student/works                  - 查看作品
```

**验证**:
- [ ] 所有端点都调用 `requireRole(ctx, ['STUDENT'])`
- [ ] 非学生访问返回 403
- [ ] student_id 和 org_id 双重过滤

---

### 7.4 公开 API (/api/public/*)

**应该公开访问的端点**:
```
GET /api/public/marketplace             - 课程广场
GET /api/public/marketplace/:id         - 课程详情
GET /api/public/file-assets/:id         - 公开文件（新增）✨
```

**验证**:
- [ ] 无需登录即可访问
- [ ] 不返回私有数据
- [ ] 只返回 PUBLIC_PLATFORM 可见的资源

---

## 8. 执行测试脚本

### 8.1 自动化测试脚本（伪代码）

```javascript
// test-permissions.mjs
import { test, expect } from './test-framework.js';

// 测试 1: 学生跨机构越权
test('学生无法访问其他机构的项目', async () => {
  const orgAStudent = await loginAs('student', 'org_a');
  const orgBProject = await createProject('org_b', 'student2');
  
  const response = await orgAStudent.get(`/api/student/projects/${orgBProject.id}`);
  
  expect(response.status).toBe(404);
  expect(response.body).not.toContain(orgBProject.title);
});

// 测试 2: 学生访问同机构其他学生
test('学生无法访问同机构其他学生的项目', async () => {
  const student1 = await loginAs('student1', 'org_a');
  const student2Project = await createProject('org_a', 'student2');
  
  const response = await student1.get(`/api/student/projects/${student2Project.id}`);
  
  expect(response.status).toBe(404);
});

// 测试 3: 教师跨班级越权
test('教师无法访问其他班级的作品', async () => {
  const teacherA = await loginAs('teacher_a', 'org_a');
  const classBWork = await createWork('org_a', 'class_b', 'student');
  
  const response = await teacherA.get(`/api/org/works?classId=${classBWork.classId}`);
  
  expect(response.body.items).not.toContainEqual(
    expect.objectContaining({ id: classBWork.id })
  );
});

// 测试 4: 学生访问管理端 API
test('学生无法访问管理端 API', async () => {
  const student = await loginAs('student', 'org_a');
  
  const response = await student.post('/api/admin/course-series', {
    title: '黑客课程',
    description: '越权测试'
  });
  
  expect(response.status).toBe(403);
});

// 测试 5: 公开文件访问（新功能）
test('未登录用户可以访问 PUBLIC_PLATFORM 文件', async () => {
  const coverAsset = await createPublicCover();
  
  const response = await fetch(`/api/public/file-assets/${coverAsset.id}/download`);
  
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/image/);
});

// 运行所有测试
runTests();
```

---

## 9. 手动验证清单

### 9.1 基础权限验证
- [ ] 学生无法访问 `/api/admin/*`
- [ ] 学生无法访问 `/api/org/*`
- [ ] 教师无法访问 `/api/admin/*`
- [ ] 机构管理员无法访问 `/api/admin/*`（除非同时是平台管理员）

### 9.2 数据隔离验证
- [ ] 学生 A 无法查看学生 B 的项目（同机构）
- [ ] 学生 A 无法查看学生 C 的项目（不同机构）
- [ ] 教师 A 无法查看教师 B 班级的作品
- [ ] 机构 A 管理员无法查看机构 B 的数据

### 9.3 文件访问验证
- [ ] PRIVATE 文件只有所有者可访问
- [ ] PUBLIC_ORG 文件只有同机构用户可访问
- [ ] PUBLIC_PLATFORM 文件未登录可访问 ✨
- [ ] 学生无法访问其他学生的私有文件

### 9.4 会话安全验证
- [ ] 会话过期后无法访问
- [ ] 退出登录后 session 失效
- [ ] 并发登录检测（如果实现）
- [ ] 会话劫持防护（如果实现）

---

## 10. 发现的问题与建议

### 10.1 已验证的安全措施 ✅
- ✅ 所有学生端查询包含 `student_id` 和 `org_id` 双重验证
- ✅ 使用参数化查询，防止 SQL 注入
- ✅ 角色验证中间件 `requireRole` 正确实现
- ✅ 机构隔离验证 `requireOrgStaff` 正确实现

### 10.2 需要验证的项 ⚠️
- ⚠️ 会话是否绑定 IP/User-Agent（防劫持）
- ⚠️ 并发登录限制（防止账号共享）
- ⚠️ 教师跨班级访问控制（需要查看 org.js 实现）
- ⚠️ 文件上传大小和类型限制
- ⚠️ API 请求频率限制（防 DoS）

### 10.3 建议改进 💡
1. **添加审计日志**: 记录所有越权尝试
2. **实现 IP 白名单**: 管理端可以限制访问 IP
3. **添加验证码**: 登录失败 3 次后要求验证码
4. **实现 CSRF 防护**: 对修改类操作添加 CSRF token
5. **定期权限审计**: 自动化脚本定期检查权限配置

---

## 11. 执行报告模板

### 测试执行记录

| 测试用例 | 状态 | 结果 | 备注 |
|---------|------|------|------|
| 学生跨机构越权 | ⏸️ | - | 待测试环境执行 |
| 学生同机构越权 | ⏸️ | - | 待测试环境执行 |
| 教师跨班级越权 | ⏸️ | - | 待测试环境执行 |
| 机构跨机构越权 | ⏸️ | - | 待测试环境执行 |
| 学生访问管理API | ⏸️ | - | 待测试环境执行 |
| 会话劫持测试 | ⏸️ | - | 待测试环境执行 |
| 会话过期测试 | ⏸️ | - | 待测试环境执行 |
| 私有文件访问 | ⏸️ | - | 待测试环境执行 |
| 公开文件访问 | ⏸️ | - | 待测试环境执行 |
| 机构文件访问 | ⏸️ | - | 待测试环境执行 |

### 安全评分

**代码层面**: 8/10 ⭐⭐⭐⭐⭐⭐⭐⭐  
- 权限验证机制完善
- 数据查询包含双重过滤
- 参数化查询防注入

**需要运行时验证**: 需要在测试环境执行完整测试套件

---

**文档生成时间**: 2026-09-07 18:00:00 +0800  
**文档版本**: v1.0  
**下一步**: 在具备 Node.js v22+ 的测试环境中执行测试脚本
