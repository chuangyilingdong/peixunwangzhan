// 通知/物料/官网内容/线索/站内信入口：实现按域拆在 routes/communication/*.js。
export * from './communication/helpers.js';
export { handlePublicCommunication } from './communication/public.js';
export { handleAdminCommunication } from './communication/admin.js';
export { handleOrgCommunication } from './communication/org.js';
export { handleStudentCommunication } from './communication/student.js';
