# Genesis/Why
我们需要一个新的前端登录页面，以支持用户安全的身份验证、多因素认证 (MFA) 及无缝的单点登录 (SSO) 体验。

# Topology
- **Frontend Framework**: React / Vue (基于项目当前的技术栈)
- **State Management**: Context API / Redux (存储登录态与会话令牌)
- **Routing**: React Router / Vue Router (包含未登录拦截守护路由)
- **API 通信**: Axios / Fetch (支持统一的请求拦截器注入 Token，响应拦截器处理 401/403)

# Implementation Path
1. **UI Components**:
   - `LoginForm`: 包含用户名/密码输入、验证码/MFA输入。
   - `SocialLogin`: 第三方 OAuth (Google/GitHub) 快捷登录入口。
   - `ForgotPassword`: 密码找回流程。
2. **Auth Service**:
   - `login(credentials)`: 调用后端 `/api/auth/login`。
   - `refreshToken()`: 轮询或拦截器中静默刷新 Token。
3. **Security Measures**:
   - 密码前端哈希或通过 HTTPS 传输加密。
   - 防御 XSS: 避免将敏感 Token 仅存储在 `localStorage`，推荐使用 `httpOnly Secure Cookie`，或在内存中保持短期 Token。
   - 防御 CSRF: 同步发送 CSRF Token。

# Risks/Constraints
1. **Token 存储安全**: 防止 XSS 盗取 Token。
2. **并发请求刷新 Token**: 当 Token 过期时，页面多个并发请求可能导致多次触发 `refreshToken`，需要实现请求队列与锁机制。
3. **重定向死循环**: 登录成后回跳原页面时的路径验证。