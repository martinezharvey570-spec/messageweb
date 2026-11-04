// 接口地址。前端和 Worker 不在同一个域，所以这里写死线上域名；
// 如果哪天前端也丢到 Cloudflare Pages 上，改成 "/api" 就能同源走。
window.XZ_CONFIG = {
  API_BASE: "https://api.messageweb.xyz/api"
};
