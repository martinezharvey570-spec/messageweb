// 同域部署时保持 /api；若 API Worker 使用独立域名，改为完整地址，例如 https://campus-api.example.workers.dev/api
window.XZ_CONFIG = { API_BASE: "/api" };
