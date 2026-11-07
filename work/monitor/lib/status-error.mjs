// 带 HTTP 状态码的错误。路由层统一按 err.status 回写响应码，业务模块只管抛。
// 各领域错误类（ControlProtocolError / UpgradeRequestError 等）继承它，
// 保留自己的类名供 instanceof 判定。
export class StatusError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    if (extra && typeof extra === "object") Object.assign(this, extra);
  }
}

// 不需要专属类名时的简写：statusError("服务器不存在", 404, { code: "not-found" })。
export function statusError(message, status = 400, extra = undefined) {
  return new StatusError(status, message, extra);
}
