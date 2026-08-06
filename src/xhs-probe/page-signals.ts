export type PageSignalType = "auth_required" | "captcha_required" | "access_blocked" | null;

export interface PageTextClassification {
  type: PageSignalType;
}

export function classifyPageText(text: string): PageTextClassification {
  if (/登录后|登录\/注册|手机号登录|输入手机号|短信登录|验证码登录/.test(text)) {
    return { type: "auth_required" };
  }
  if (/安全验证|完成验证|拖动滑块|滑块验证|行为验证|人机验证/.test(text)) {
    return { type: "captcha_required" };
  }
  if (/访问频繁|操作频繁|异常访问|暂时无法访问|网络环境存在风险/.test(text)) {
    return { type: "access_blocked" };
  }
  return { type: null };
}
