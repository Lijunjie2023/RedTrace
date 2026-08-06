import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { errorMessage } from "../utils/format";

export function LoginPage(): ReactNode {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.checking && auth.authenticated) return <Navigate to="/overview" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await auth.login(username, password);
      const from = (location.state as { from?: string } | null)?.from ?? "/overview";
      navigate(from, { replace: true });
    } catch (reason) {
      setError(errorMessage(reason) || "账号或密码不正确，或当前账号暂时无法登录");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-editorial">
        <span className="login-editorial__index">READ / TRACE / 01</span>
        <div><p>内部舆情调查台</p><h1>发现负面变化，<br />回看原始证据。</h1><div className="evidence-rule" /><small>第一版聚焦小红书大家电内容。所有结论都需要对应原帖或原评论。</small></div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={(event) => void submit(event)} noValidate>
          <div><span className="section-index">管理员入口</span><h2>登录ReadTrace</h2><p>使用内部管理员账号继续。</p></div>
          {error ? <div className="notice notice--error" role="alert"><span className="notice__icon" aria-hidden="true">!</span><p>账号或密码不正确，或当前账号暂时无法登录。</p></div> : null}
          <label><span>账号<span aria-label="必填">＊</span></span><input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label><span>密码<span aria-label="必填">＊</span></span><div className="password-input"><input type={visible ? "text" : "password"} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? "隐藏密码" : "显示密码"}>{visible ? "隐藏" : "显示"}</button></div></label>
          <button className="button button--primary button--wide" disabled={submitting || !username || !password} type="submit">{submitting ? "正在登录" : "登录"}</button>
        </form>
      </section>
    </main>
  );
}
