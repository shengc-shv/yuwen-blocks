// 仅包含可公开的前端配置（来自云服务 publicConfig）。
// publishableKey 只标识应用、本身不携带权限；真正的凭据始终留在服务端。
// 严禁在本文件放置任何 PAT、长期密钥或管理端凭据。
window.YW_PUBLIC_CONFIG = Object.freeze({
  endpoint: 'https://yuwen-blocks.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_fQChIuOVGWoHgn7P86s7qK_dEVsTtoIVDptNvteL1miO7Wav4z5f2cA',
});

// 全局唯一时区常量：任何日期键、存档文件名、复习到期日都必须走这里。
// 禁止用 new Date() 直接取日历日，禁止 process.env.TZ / 系统时区回落。
window.YW_TZ = 'Asia/Shanghai';
