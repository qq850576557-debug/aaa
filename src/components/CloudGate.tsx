import { useEffect, useRef, useState, type FormEvent } from 'react';
import App from '../App';
import { cloudApi, cloudSession, CloudError, type CloudUser } from '../lib/cloud';
import { passwordSchema, PASSWORD_MIN, PASSWORD_MAX } from '../lib/password';
import { BRAND_LOGO_SRC, BRAND_NAME, BRAND_INITIALS, BRAND_SLOGAN } from '../lib/brand';
import './login.css';

// A storage/URL flag can never enable local mode in the production build.
const localDevelopment = import.meta.env.DEV && import.meta.env.VITE_ALLOW_LOCAL === 'true';
export function CloudGate() {
  const [checking, setChecking] = useState(!localDevelopment);
  const [user, setUser] = useState<CloudUser | null>(null);
  const [login, setLogin] = useState(''),
    [password, setPassword] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const prior = useRef<CloudUser | null>(null);
  useEffect(() => {
    if (localDevelopment) return;
    let active = true;
    void cloudSession()
      .then((account) => {
        if (!active) return;
        if (sessionStorage.getItem('chunmo-space') !== 'local')
          sessionStorage.setItem('chunmo-space', 'cloud');
        prior.current = account;
        setUser(account);
        setMounted(true);
      })
      .catch((e) => {
        if (active && (!(e instanceof CloudError) || e.status !== 401)) setError(String(e));
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    const expired = () => {
      setUser(null);
      setPassword('');
      setError('登录已失效，请重新登录。');
    };
    window.addEventListener('chunmo-auth-expired', expired);
    const verify = () => {
      if (!prior.current || document.visibilityState !== 'visible') return;
      void cloudSession()
        .then((account) => {
          if (active && account.id !== prior.current?.id) {
            expired();
            window.location.reload();
          }
        })
        .catch((e) => {
          if (active && e instanceof CloudError && e.status === 401) expired();
        });
    };
    const timer = setInterval(verify, 60000);
    window.addEventListener('focus', verify);
    return () => {
      active = false;
      window.removeEventListener('chunmo-auth-expired', expired);
      window.removeEventListener('focus', verify);
      clearInterval(timer);
    };
  }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError('');
    const result = passwordSchema.safeParse(password);
    if (!result.success) {
      setError(result.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      await cloudApi('/auth/login', 'POST', { login, password });
      const account = await cloudSession();
      sessionStorage.setItem('chunmo-space', 'cloud');
      setPassword('');
      if (mounted) {
        // Same-user draft memory remains recoverable if beforeunload is cancelled.
        // A different account never sees the previous account's mounted workspace.
        if (prior.current?.id === account.id) setUser(account);
        window.location.reload();
        return;
      }
      prior.current = account;
      setUser(account);
      setMounted(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (localDevelopment) return <App />;
  return (
    <>
      {mounted && (
        <div hidden={!user} inert={!user}>
          <App />
        </div>
      )}
      {!user && (
        <main className="brand-login">
          <section className="login-art" aria-hidden="true">
            <span>
              空间有序
              <br />
              生活从容
            </span>
            <p>{BRAND_SLOGAN}</p>
          </section>
          <section className="login-card" aria-label="春茉账号登录">
            <div className="login-brand">
              {BRAND_LOGO_SRC && <img src={BRAND_LOGO_SRC} alt="春茉空间设计 Logo" />}
              <div>
                <h1 className="brand-name">{BRAND_NAME}</h1>
                <span>{BRAND_INITIALS} · SPACE DESIGN</span>
              </div>
            </div>
            <p className="login-kicker">工作室协作空间</p>
            <h2>欢迎回来</h2>
            <p className="login-description">登录后，开启今天的设计与施工协作。</p>
            <form onSubmit={signIn} aria-label="登录">
              <label>
                账号
                <input
                  aria-label="登录账号"
                  name="username"
                  autoComplete="username"
                  required
                  maxLength={80}
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  disabled={checking || busy}
                />
              </label>
              <label>
                密码
                <input
                  aria-label="登录密码"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={PASSWORD_MIN}
                  maxLength={PASSWORD_MAX}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={checking || busy}
                />
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button className="primary" disabled={checking || busy}>
                {checking ? '正在验证登录状态…' : busy ? '正在登录…' : '登录'}
              </button>
            </form>
            <p className="login-help">忘记密码请联系工作室负责人。</p>
            <footer>
              {BRAND_NAME} · {BRAND_SLOGAN}
            </footer>
          </section>
        </main>
      )}
    </>
  );
}
